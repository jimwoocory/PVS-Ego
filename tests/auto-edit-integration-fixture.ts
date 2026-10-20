import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaTimelineRepository } from "../src/adapters/db/prisma-timeline-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { TimelineService } from "../src/application/services/timeline-service.js";
import { RenderEngine } from "../src/application/services/render-engine.js";
import { AutoEditService } from "../src/application/services/auto-edit-service.js";
import { ApprovalService } from "../src/application/services/approval-service.js";
import { ReviewService } from "../src/application/services/review-service.js";
import { HermesProductDirectorGenerator } from "../src/adapters/ai/hermes-product-director-generator.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { confirmProductionPlanDraft } from "../src/application/services/review-actions.js";
import type { SpeechSynthesisProvider } from "../src/application/ports/speech-synthesis.js";
import { directorCase } from "./model-aware-fixtures.js";
import { makeRequest, makePreflight } from "./fixtures.js";
import { hashValue } from "../src/domain/hashing.js";
import type { ArtifactRecord } from "../src/domain/schemas.js";
const execute = promisify(execFile);
export const runMedia = (args: string[]) => execute(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true, timeout: 90_000 });

/** Real DB and media; fixture-only approvals/footage, never the production database or real Dreamina. */
export async function createAutoEditFixture(speech?: SpeechSynthesisProvider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-auto-edit-"));
  const database = "file:" + path.join(root, "fixture.db").replaceAll("\\", "/");
  await execute(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: database }, windowsHide: true, timeout: 90_000
  });
  const db = new PrismaClient({ datasources: { db: { url: database } } });
  const projectId = "auto-fixture-" + randomUUID(), now = new Date().toISOString(), projectsRoot = path.join(root, "projects");
  const productFlow = new ProductFlowService(new PrismaProductFlowRepository(db));
  const artifacts = new PrismaArtifactRepository(db), generation = new PrismaGenerationRepository(db), workflow = new PrismaWorkflowRepository(db);
  const review = new PrismaReviewRepository(db), timelines = new PrismaTimelineRepository(db), finalOutput = new PrismaFinalOutputRepository(db);
  const timeline = new TimelineService(productFlow, workflow, artifacts, review, timelines, projectsRoot);
  const render = new RenderEngine(productFlow, artifacts, timelines, finalOutput, projectsRoot);
  const autoEdit = new AutoEditService({ productFlow, workflow, review, artifacts, timelines, projectsRoot, speech });
  const c = directorCase(12000, 6);
  await productFlow.createProject({ id: projectId, name: "隔离自动剪辑测试", status: "DRAFT", targetPlatform: "douyin", targetDurationMs: 12000, aspectRatio: "16:9", createdAt: now, updatedAt: now });
  const truth = { ...c.input.productTruth, projectId }; await productFlow.confirmProductTruth(truth);
  const batch = { ...c.input.creativeBatch, projectId }; await productFlow.activateCreativeBatch(batch); await productFlow.selectCreative(projectId, "creative-1");
  const script = { ...c.input.script, projectId }; await productFlow.confirmScript(script);
  const original = c.proposal.scenes[0]!.clips[0]!;
  c.proposal.scenes[0]!.clips = [0,1].map(i => ({ ...original, durationMs: 6000,
    segments: [{ ...original.segments[0]!, endMs: 6000, dialogueOrNarration: { kind: "NARRATION" as const,
      text: i === 0 ? "这是第一段产品展示。" : "这是第二段产品展示。", estimatedDurationMs: 2000, estimatorVersion: "isolated-fixture" } }] }));
  const draft = await new HermesProductDirectorGenerator({ id: "fixture", version: "test", generateJson: async () => structuredClone(c.proposal) }).generate({ ...c.input, productTruth: truth, creativeBatch: batch, script });
  const plan = confirmProductionPlanDraft(draft); await productFlow.confirmProductionPlan(plan);
  const clips = plan.scenes.flatMap(s => s.clips);
  const store = new LocalArtifactStore(path.join(projectsRoot, projectId), artifacts);
  const mediaFile = path.join(root, "source.mp4");
  await runMedia(["-f", "lavfi", "-i", "color=c=slategray:s=320x180:r=5:d=6", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", mediaFile]);
  const inputs: ArtifactRecord[] = [];
  const approval = new ApprovalService(generation, workflow);
  const reviewService = new ReviewService(productFlow, generation, workflow, artifacts, review);
  const attemptIds: string[] = [];
  for (const [i,clip] of clips.entries()) {
    const video = await store.writeImmutable({ id: "video-" + randomUUID(), projectId, kind: "GENERATED_VIDEO", immutable: true, relativePath: "test-only/video-" + i + ".mp4", bytes: await fs.readFile(mediaFile), mimeType: "video/mp4" });
    inputs.push(video);
    const base = { ...makeRequest(), id: "request-" + randomUUID(), projectId, clipId: clip.id, inputVersionRefs: [plan.productTruthRef, plan.scriptRef, { entityType: "ProductionPlan", entityId: plan.id, version: plan.version, hash: plan.contentHash }] };
    const request = { ...base, requestHash: hashValue(base) }; await generation.createGenerationRequest(request);
    const report = { ...makePreflight(), id: "report-" + randomUUID(), projectId, generationRequestId: request.id, requestHash: request.requestHash };
    await generation.createPreflightReport(report);
    const approved = await approval.approveCurrentRequests({ projectId, generationRequestIds: [request.id], acceptedUnknownCostRisk: true, acceptedDuplicateSubmissionRisk: false });
    const a = approved.attempts[0]!; attemptIds.push(a.id);
    await workflow.updateGenerationAttemptStatus(a.id, { status: "SUCCEEDED", outputArtifactId: video.id, completedAt: now });
    await reviewService.decide({ projectId, clipId: clip.id, generationAttemptId: a.id, decision: "ACCEPT", note: "Isolated fixture acceptance; not a real product or paid generation" });
  }
  const toneArtifacts: ArtifactRecord[] = [];
  for (const [index,frequency] of [550,880,220].entries()) {
    const file = path.join(root, "tone-" + index + ".wav");
    await runMedia(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${index === 2 ? 6 : 2}`, "-c:a", "pcm_s16le", "-y", file]);
    toneArtifacts.push(await store.writeImmutable({ id: "audio-" + randomUUID(), projectId, kind: "OTHER", immutable: true, relativePath: "test-only/tone-" + index + ".wav", mimeType: "audio/wav", bytes: await fs.readFile(file) }));
  }
  const settings = { narrationMode: "PROVIDED", bgmArtifactId: toneArtifacts[2]!.id,
    audioBindings: clips.flatMap(clip => [
      { kind: "NARRATION", segmentId: clip.segments[0]!.id, artifactId: toneArtifacts[0]!.id },
      { kind: "AMBIENT", segmentId: clip.segments[0]!.id, artifactId: toneArtifacts[1]!.id }
    ]) };
  return { root, db, database, projectId, projectsRoot, productFlow, artifacts, generation, workflow, review, timelines, finalOutput, timeline, render, autoEdit, plan, truth, script, clips, inputs, toneArtifacts, settings, attemptIds,
    cleanup: async () => { await db.$disconnect(); await fs.rm(root, { recursive: true, force: true }); } };
}
