import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaTimelineRepository } from "../src/adapters/db/prisma-timeline-repository.js";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { RenderEngine, type RenderRecoveryOptions } from "../src/application/services/render-engine.js";
import { RecoveryService } from "../src/application/services/recovery-service.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { ProjectSnapshotService } from "../src/application/services/project-snapshot.js";
import { renderConfigSchema, renderJobSchema, timelineSchema } from "../src/domain/schemas.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import type { RenderExecution } from "../src/domain/render-execution.js";

async function fixture(options: RenderRecoveryOptions = {}) {
  const db = new PrismaClient();
  const projectId = "render-recovery-" + randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-render-recovery-"));
  const projectRoot = path.join(root, projectId);
  const now = new Date().toISOString();
  const planHash = "a".repeat(64);
  await db.project.create({ data: { id: projectId, name: "恢复测试", status: "READY_TO_ASSEMBLE", targetDurationMs: 1000, currentProductionPlanHash: planHash } });
  const artifacts = new PrismaArtifactRepository(db);
  const store = new LocalArtifactStore(projectRoot, artifacts);
  const source = await store.writeImmutable({ id: randomUUID(), projectId, kind: "GENERATED_VIDEO", relativePath: "source/input.mp4", immutable: true, bytes: Buffer.from("unchanged-source"), mimeType: "video/mp4" });
  const timelines = new PrismaTimelineRepository(db);
  const finalOutput = new PrismaFinalOutputRepository(db);
  const timeline = timelineSchema.parse({ id: randomUUID(), projectId, version: 1, status: "CONFIRMED", productionPlanHash: planHash,
    tracks: [{ id: "v1", kind: "VIDEO", label: "V1", order: 0 }],
    clips: [{ id: "edit1", sourceClipId: "clip1", sourceArtifactId: source.id, sourceArtifactHash: source.sha256,
      sourceDurationMs: 1000, inMs: 0, outMs: 1000, trackId: "v1", order: 0, transition: { type: "CUT", durationMs: 0 } }],
    contentHash: "b".repeat(64), createdAt: now, updatedAt: now, confirmedAt: now });
  await timelines.saveTimeline(timeline);
  const job = renderJobSchema.parse({ id: randomUUID(), projectId, timelineId: timeline.id, timelineHash: timeline.contentHash,
    status: "QUEUED", inputArtifactIds: [source.id], inputArtifactHashes: [source.sha256], renderConfig: renderConfigSchema.parse({}), createdAt: now });
  await timelines.createRenderJob(job);
  const token = randomUUID();
  const execution: RenderExecution = { renderJobId: job.id, projectId, ownerToken: token, ownerPid: 12345, childPid: 12346,
    phase: "RUNNING", startedAt: now, updatedAt: now, data: { version: 1, timelineId: timeline.id, timelineHash: timeline.contentHash,
      productionPlanHash: planHash, stagingRelativePath: ".recovery/render-executions/" + job.id + "/" + token + "/final.mp4",
      outputRelativePath: "final/timeline-" + job.id + "-" + token + ".mp4", outputArtifactId: randomUUID(), assemblyId: randomUUID() } };
  assert.equal(await timelines.claimRenderExecution(execution), true);
  // The initial claim is PREPARING before spawning; simulate the persisted child registration.
  assert.equal(await timelines.updateRenderExecution(execution), true);
  const productFlow = {
    getWorkspace: async () => ({ productionPlan: { status: "CONFIRMED", contentHash: planHash }, project: { currentProductionPlanRef: { hash: planHash } } }),
    listProjects: async () => [{ id: projectId }],
    setProjectStatus: async (_id: string, status: string) => db.project.update({ where: { id: projectId }, data: { status } })
  } as unknown as ProductFlowService;
  let decoded = 0;
  const engine = new RenderEngine(productFlow, artifacts, timelines, finalOutput, root, "ffmpeg", "ffprobe", {
    processState: () => "DEAD",
    inspectMedia: async () => ({ hasVideo: true, hasAudio: true, durationMs: 1000, width: 720, height: 1280 }),
    validateDecodedMedia: async () => { decoded++; }, ...options
  });
  const staging = store.resolveArtifactPath(execution.data.stagingRelativePath);
  const writeStaging = async () => { await fs.mkdir(path.dirname(staging), { recursive: true }); await fs.writeFile(staging, "complete-result"); };
  const cleanup = async () => {
    await db.$executeRaw`DELETE FROM "RenderExecutionRecord" WHERE "projectId"=${projectId}`;
    await db.finalAssemblyRecord.deleteMany({ where: { projectId } });
    await db.renderJobRecord.deleteMany({ where: { projectId } });
    await db.timelineRecord.deleteMany({ where: { projectId } });
    await db.artifactRecord.deleteMany({ where: { projectId } });
    await db.project.delete({ where: { id: projectId } });
    await db.$disconnect();
    await fs.rm(root, { recursive: true, force: true });
  };
  return { db, root, projectId, artifacts, store, source, timelines, finalOutput, timeline, job, execution, productFlow, engine, staging, writeStaging, cleanup, decoded: () => decoded };
}

test("live parent or live FFmpeg child cannot be displaced by a restart", async () => {
  for (const livePid of [12345, 12346]) {
    const f = await fixture({ processState: pid => pid === livePid ? "ALIVE" : "DEAD" });
    try {
      await f.writeStaging();
      assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "LIVE_OWNER");
      assert.equal((await f.timelines.latestRenderJob(f.projectId))?.status, "RENDERING");
      assert.equal((await f.timelines.getRenderExecution(f.job.id))?.ownerToken, f.execution.ownerToken);
      assert.equal(await fs.readFile(f.staging, "utf8"), "complete-result");
    } finally { await f.cleanup(); }
  }
});

test("unknown process state and unregistered spawn PID fail closed", async () => {
  for (const scenario of ["permission", "spawn-gap"] as const) {
    const f = await fixture({ processState: () => scenario === "permission" ? "UNKNOWN" : "DEAD" });
    try {
      if (scenario === "spawn-gap") await f.timelines.updateRenderExecution({ ...f.execution, phase: "STARTING", childPid: undefined });
      assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "OWNER_UNKNOWN");
      assert.equal((await f.timelines.latestRenderJob(f.projectId))?.status, "RENDERING");
    } finally { await f.cleanup(); }
  }
});

test("legacy RENDERING without durable ownership is never cleared automatically", async () => {
  const f = await fixture();
  try {
    await f.db.$executeRaw`DELETE FROM "RenderExecutionRecord" WHERE "renderJobId"=${f.job.id}`;
    assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "OWNER_UNKNOWN");
    assert.equal((await f.timelines.latestRenderJob(f.projectId))?.status, "RENDERING");
  } finally { await f.cleanup(); }
});

test("dead renderer with no complete output becomes retryable without touching historical artifacts", async () => {
  const f = await fixture();
  try {
    const history = await f.store.writeImmutable({ id: randomUUID(), projectId: f.projectId, kind: "FINAL_VIDEO", relativePath: "final/previous.mp4", immutable: true, bytes: Buffer.from("historical-final") });
    assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "RETRYABLE");
    const job = await f.timelines.latestRenderJob(f.projectId);
    assert.equal(job?.status, "FAILED");
    assert.equal(job?.errorCode, "RENDER_INTERRUPTED_RETRYABLE");
    assert.equal(await fs.readFile(f.store.resolveArtifactPath(history.relativePath), "utf8"), "historical-final");
    assert.equal((await f.timelines.getRenderExecution(f.job.id))?.phase, "FAILED");
    const next = { ...f.execution, ownerToken: randomUUID(), phase: "PREPARING" as const, childPid: undefined };
    assert.equal(await f.timelines.claimRenderExecution(next), true);
    assert.equal(await f.timelines.claimRenderExecution({ ...next, ownerToken: randomUUID() }), false);
  } finally { await f.cleanup(); }
});

test("validated complete staging output is adopted once and preserves source bytes", async () => {
  const f = await fixture();
  try {
    await f.writeStaging();
    assert.equal((await f.engine.recoverAbandoned())[0]?.outcome, "RECOVERED");
    assert.equal(f.decoded(), 1);
    const job = await f.timelines.latestRenderJob(f.projectId);
    const assembly = await f.finalOutput.latestAssembly(f.projectId);
    assert.equal(job?.status, "SUCCEEDED");
    assert.equal(assembly?.renderJobId, job?.id);
    assert.equal(assembly?.outputArtifactId, job?.outputArtifactId);
    assert.equal((await f.artifacts.findById(f.source.id))?.sha256, f.source.sha256);
    assert.deepEqual(await f.engine.recoverAbandoned(f.projectId), []);
    assert.equal(await f.db.finalAssemblyRecord.count({ where: { projectId: f.projectId } }), 1);
  } finally { await f.cleanup(); }
});

test("already published immutable output and matching assembly are recovered without rewriting either", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("complete-result");
    f.execution.data.outputArtifactHash = sha256Bytes(bytes);
    await f.timelines.updateRenderExecution({ ...f.execution, phase: "OUTPUT_READY" });
    const output = await f.store.writeImmutable({ id: f.execution.data.outputArtifactId, projectId: f.projectId, kind: "FINAL_VIDEO",
      relativePath: f.execution.data.outputRelativePath, immutable: true, bytes, mimeType: "video/mp4" });
    await f.finalOutput.createAssembly({ id: f.execution.data.assemblyId, projectId: f.projectId, productionPlanHash: f.timeline.productionPlanHash,
      selectedClipIds: ["clip1"], inputArtifactIds: f.job.inputArtifactIds, inputArtifactHashes: f.job.inputArtifactHashes,
      outputArtifactId: output.id, outputArtifactHash: output.sha256!, timelineId: f.timeline.id, timelineHash: f.timeline.contentHash,
      renderJobId: f.job.id, renderConfig: f.job.renderConfig, status: "READY", createdAt: new Date().toISOString() });
    assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "RECOVERED");
    assert.equal((await f.finalOutput.latestAssembly(f.projectId))?.id, f.execution.data.assemblyId);
    assert.equal(await f.db.artifactRecord.count({ where: { projectId: f.projectId, kind: "FINAL_VIDEO" } }), 1);
    assert.equal(await fs.readFile(f.store.resolveArtifactPath(output.relativePath), "utf8"), "complete-result");
  } finally { await f.cleanup(); }
});

test("metadata success cannot recover truncated or undecodable output", async () => {
  const f = await fixture({ validateDecodedMedia: async () => { throw new Error("truncated stream"); } });
  try {
    await f.writeStaging();
    assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "RETRYABLE");
    assert.equal((await f.timelines.latestRenderJob(f.projectId))?.status, "FAILED");
    assert.equal(await f.db.finalAssemblyRecord.count({ where: { projectId: f.projectId } }), 0);
  } finally { await f.cleanup(); }
});

test("complete staging output finishes a pending immutable publication without duplicate records", async () => {
  const f = await fixture();
  try {
    await f.writeStaging();
    await f.artifacts.createPending({ id: f.execution.data.outputArtifactId, projectId: f.projectId, kind: "FINAL_VIDEO",
      relativePath: f.execution.data.outputRelativePath, immutable: true, mimeType: "video/mp4" });
    assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "RECOVERED");
    assert.equal((await f.artifacts.findById(f.execution.data.outputArtifactId))?.integrityStatus, "READY");
    assert.equal(await f.db.artifactRecord.count({ where: { projectId: f.projectId, kind: "FINAL_VIDEO" } }), 1);
    assert.equal(await fs.readFile(f.store.resolveArtifactPath(f.execution.data.outputRelativePath), "utf8"), "complete-result");
  } finally { await f.cleanup(); }
});

test("changed input or timeline never becomes a recovered current final", async () => {
  for (const changed of ["input", "timeline"] as const) {
    const f = await fixture();
    try {
      await f.writeStaging();
      if (changed === "input") await fs.writeFile(f.store.resolveArtifactPath(f.source.relativePath), "changed-source");
      else await f.timelines.saveTimeline({ ...f.timeline, status: "STALE" });
      assert.equal((await f.engine.recoverAbandoned(f.projectId))[0]?.outcome, "RETRYABLE");
      assert.equal(await f.db.finalAssemblyRecord.count({ where: { projectId: f.projectId } }), 0);
    } finally { await f.cleanup(); }
  }
});

test("stale recovery token cannot claim or finish another owner's job", async () => {
  const f = await fixture();
  try {
    const next = { ...f.execution, ownerToken: randomUUID(), ownerPid: process.pid, phase: "RECOVERING" as const };
    assert.equal(await f.timelines.claimRenderExecution(next, f.execution.ownerToken), true);
    assert.equal(await f.timelines.claimRenderExecution({ ...next, ownerToken: randomUUID() }, f.execution.ownerToken), false);
    assert.equal(await f.timelines.finishRenderExecution(f.job.id, f.execution.ownerToken, { status: "FAILED", completedAt: new Date().toISOString() }), null);
    assert.equal((await f.timelines.latestRenderJob(f.projectId))?.status, "RENDERING");
  } finally { await f.cleanup(); }
});

test("project reconciliation defers destructive temp cleanup while render ownership is unknown", async () => {
  const f = await fixture({ processState: () => "UNKNOWN" });
  try {
    const legacyTemp = f.store.resolveArtifactPath(".tmp/render-legacy/final.mp4");
    await fs.mkdir(path.dirname(legacyTemp), { recursive: true }); await fs.writeFile(legacyTemp, "preserve-unowned-output");
    const workflow = { listGenerationAttempts: async () => [], listOpenBlockers: async () => [] } as unknown as WorkflowRepository;
    const snapshots = { refresh: async () => "exports/project.json" } as unknown as ProjectSnapshotService;
    const recovery = new RecoveryService(f.root, f.productFlow, f.artifacts, workflow, snapshots, f.engine);
    const result = await recovery.recoverProject(f.projectId);
    assert.equal(result.artifactRecoveryDeferred, true);
    assert.equal(result.renderRecovery?.[0]?.outcome, "OWNER_UNKNOWN");
    assert.equal(await fs.readFile(legacyTemp, "utf8"), "preserve-unowned-output");
  } finally { await f.cleanup(); }
});
