import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaTimelineRepository } from "../src/adapters/db/prisma-timeline-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import {
  TimelineService,
  timelineDecisionHash,
  timelineDurationMs
} from "../src/application/services/timeline-service.js";
import { RenderEngine } from "../src/application/services/render-engine.js";
import {
  timelineSchema,
  type ProductionPlan
} from "../src/domain/schemas.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import {
  H,
  makeApproval,
  makeAttempt,
  makePreflight,
  makeRequest,
  makeValidClip
} from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function runFile(
  executable: string,
  args: string[],
  timeout = 60_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr)
        })
    );
  });
}

async function mediaAvailable(): Promise<boolean> {
  const [ffmpeg, ffprobe] = await Promise.all([
    runFile("ffmpeg", ["-version"]),
    runFile("ffprobe", ["-version"])
  ]);
  return ffmpeg.ok && ffprobe.ok;
}

async function makeVideo(
  target: string,
  color: string,
  frequency: number
): Promise<void> {
  const made = await runFile(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:r=24:d=2`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=2`,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      target
    ],
    90_000
  );
  assert.equal(made.ok, true, made.stderr);
}

async function makeBgm(target: string): Promise<void> {
  const made = await runFile(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=5",
      "-c:a",
      "aac",
      target
    ],
    60_000
  );
  assert.equal(made.ok, true, made.stderr);
}

function makePlan(projectId: string, clipIds: [string, string]): ProductionPlan {
  const clipA = structuredClone(makeValidClip());
  clipA.id = clipIds[0];
  clipA.sceneId = "scene-timeline";
  clipA.order = 1;
  clipA.contentHash = hash("clip-a-" + projectId);
  clipA.segments = clipA.segments.map((segment, index) => ({
    ...segment,
    id: `seg-a-${index + 1}-${projectId}`
  }));

  const clipB = structuredClone(makeValidClip());
  clipB.id = clipIds[1];
  clipB.sceneId = "scene-timeline";
  clipB.order = 2;
  clipB.contentHash = hash("clip-b-" + projectId);
  clipB.segments = clipB.segments.map((segment, index) => ({
    ...segment,
    id: `seg-b-${index + 1}-${projectId}`
  }));

  return {
    id: `plan-${randomUUID()}`,
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-timeline",
      version: 1,
      hash: H.a
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-timeline",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-timeline",
    visualDirection: "clean product studio",
    soundDirection: "clean",
    productShowcaseRules: ["keep product visible"],
    continuityLock: {
      product: {
        stableAttributes: ["shape", "logo"],
        forbiddenChanges: []
      },
      characters: [],
      environments: [
        {
          sceneId: "scene-timeline",
          stableElements: ["studio"]
        }
      ]
    },
    scenes: [
      {
        id: "scene-timeline",
        order: 1,
        purpose: "product",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [clipA, clipB]
      }
    ],
    contentHash: hash("plan-" + projectId),
    confirmedAt: new Date().toISOString()
  };
}

async function createAcceptedOutput(input: {
  db: PrismaClient;
  projectId: string;
  clipId: string;
  clipHash: string;
  label: string;
  sourcePath: string;
  store: LocalArtifactStore;
}) {
  const generation = new PrismaGenerationRepository(input.db);
  const workflow = new PrismaWorkflowRepository(input.db);
  const reviews = new PrismaReviewRepository(input.db);
  const artifacts = new PrismaArtifactRepository(input.db);

  const requestHash = hash("request-" + input.label);
  const preflightHash = hash("preflight-" + input.label);
  const approvalHash = hash("approval-" + input.label);
  const request = {
    ...makeRequest(),
    id: `request-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    clipId: input.clipId,
    compiledPromptId: `prompt-${input.label}-${randomUUID()}`,
    compiledPromptHash: hash("prompt-" + input.label),
    requestHash,
    createdAt: new Date().toISOString()
  };
  const preflight = {
    ...makePreflight(),
    id: `preflight-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    generationRequestId: request.id,
    requestHash,
    reportHash: preflightHash,
    createdAt: new Date().toISOString()
  };
  const approval = {
    ...makeApproval(),
    id: `approval-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    generationRequestId: request.id,
    requestHash,
    preflightReportId: preflight.id,
    preflightHash,
    approvalHash,
    approvedAt: new Date().toISOString()
  };
  await generation.createGenerationRequest(request);
  await generation.createPreflightReport(preflight);
  await generation.createUserApproval(approval);

  const videoArtifact = await input.store.writeImmutable({
    id: `video-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    kind: "GENERATED_VIDEO",
    relativePath: `generated/${input.clipId}/${input.label}.mp4`,
    immutable: true,
    bytes: await fs.readFile(input.sourcePath),
    mimeType: "video/mp4"
  });
  assert.ok(videoArtifact.sha256);

  const attempt = {
    ...makeAttempt(),
    id: `attempt-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    clipId: input.clipId,
    attemptNumber: 1,
    generationRequestId: request.id,
    requestHash,
    preflightReportId: preflight.id,
    userApprovalId: approval.id,
    approvalHash,
    submissionFingerprint: hash("fingerprint-" + input.label),
    status: "SUCCEEDED" as const,
    providerHandle: { externalTaskId: "task-" + input.label },
    outputArtifactId: videoArtifact.id,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  await workflow.createGenerationAttempt(attempt);

  await reviews.createDecision({
    id: `accept-${input.label}-${randomUUID()}`,
    projectId: input.projectId,
    clipId: input.clipId,
    clipHash: input.clipHash,
    generationAttemptId: attempt.id,
    outputArtifactId: videoArtifact.id,
    outputArtifactHash: videoArtifact.sha256!,
    decision: "ACCEPT",
    decidedAt: new Date().toISOString()
  });

  const stored = await artifacts.findById(videoArtifact.id);
  assert.equal(stored?.sha256, videoArtifact.sha256);
  return videoArtifact;
}

async function cleanup(db: PrismaClient, projectId: string): Promise<void> {
  await db.publishAttemptRecord.deleteMany({ where: { projectId } });
  await db.finalAssemblyRecord.deleteMany({ where: { projectId } });
  await db.renderJobRecord.deleteMany({ where: { projectId } });
  await db.timelineRecord.deleteMany({ where: { projectId } });
  await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
  await db.commandAttemptRecord.deleteMany({ where: { projectId } });
  await db.generationAttemptRecord.deleteMany({ where: { projectId } });
  await db.userApprovalRecord.deleteMany({ where: { projectId } });
  await db.preflightReportRecord.deleteMany({ where: { projectId } });
  await db.generationRequestRecord.deleteMany({ where: { projectId } });
  await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
  await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
  await db.providerIdentityRecord.deleteMany({ where: { projectId } });
  await db.artifactRecord.deleteMany({ where: { projectId } });
  await db.versionedEntity.deleteMany({ where: { projectId } });
  await db.project.deleteMany({ where: { id: projectId } });
}

test("Timeline schema rejects destructive/out-of-range trims", () => {
  const now = new Date().toISOString();
  assert.throws(() =>
    timelineSchema.parse({
      id: "timeline-invalid",
      projectId: "project-invalid",
      version: 1,
      status: "DRAFT",
      productionPlanHash: H.a,
      tracks: [
        {
          id: "video-track",
          kind: "VIDEO",
          order: 0,
          label: "V1",
          locked: false,
          muted: false
        }
      ],
      clips: [
        {
          id: "clip-edit",
          sourceClipId: "clip-source",
          sourceArtifactId: "artifact-source",
          sourceArtifactHash: H.b,
          sourceDurationMs: 1000,
          inMs: 200,
          outMs: 1200,
          trackId: "video-track",
          order: 0,
          deleted: false,
          transition: { type: "CUT", durationMs: 0 },
          audio: { muted: false, volume: 1, keyframes: [] },
          captions: []
        }
      ],
      audioItems: [],
      textItems: [],
      contentHash: H.c,
      createdAt: now,
      updatedAt: now
    })
  );
});

test("P1-06 Timeline persists non-destructive edits and RenderEngine produces audited MP4", async (t) => {
  if (!(await mediaAvailable())) {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }

  const db = new PrismaClient();
  const projectId = `timeline-${randomUUID()}`;
  const clipIds: [string, string] = [
    `clip-a-${randomUUID()}`,
    `clip-b-${randomUUID()}`
  ];
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-timeline-render-")
  );
  const fixtureDir = path.join(projectsRoot, "_fixtures");
  const projectRoot = path.join(projectsRoot, projectId);
  await fs.mkdir(fixtureDir, { recursive: true });
  const sourceA = path.join(fixtureDir, "a.mp4");
  const sourceB = path.join(fixtureDir, "b.mp4");
  const bgmSource = path.join(fixtureDir, "bgm.m4a");

  try {
    await Promise.all([
      makeVideo(sourceA, "red", 440),
      makeVideo(sourceB, "blue", 660),
      makeBgm(bgmSource)
    ]);

    const productFlow = new ProductFlowService(
      new PrismaProductFlowRepository(db)
    );
    const workflow = new PrismaWorkflowRepository(db);
    const artifacts = new PrismaArtifactRepository(db);
    const reviews = new PrismaReviewRepository(db);
    const timelines = new PrismaTimelineRepository(db);
    const finalOutput = new PrismaFinalOutputRepository(db);
    const store = new LocalArtifactStore(projectRoot, artifacts);

    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Timeline Render Integration",
      status: "READY_TO_ASSEMBLE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });
    const plan = makePlan(projectId, clipIds);
    await db.versionedEntity.create({
      data: {
        id: plan.id,
        projectId,
        entityType: "ProductionPlan",
        entityKey: "production-plan",
        version: plan.version,
        status: plan.status,
        contentHash: plan.contentHash,
        dataJson: JSON.stringify(plan)
      }
    });
    await db.project.update({
      where: { id: projectId },
      data: {
        currentProductionPlanId: plan.id,
        currentProductionPlanVersion: plan.version,
        currentProductionPlanHash: plan.contentHash
      }
    });

    const artifactA = await createAcceptedOutput({
      db,
      projectId,
      clipId: clipIds[0],
      clipHash: plan.scenes[0]!.clips[0]!.contentHash,
      label: "a-" + projectId,
      sourcePath: sourceA,
      store
    });
    const artifactB = await createAcceptedOutput({
      db,
      projectId,
      clipId: clipIds[1],
      clipHash: plan.scenes[0]!.clips[1]!.contentHash,
      label: "b-" + projectId,
      sourcePath: sourceB,
      store
    });

    const originalA = await fs.readFile(
      store.resolveArtifactPath(artifactA.relativePath)
    );
    const originalB = await fs.readFile(
      store.resolveArtifactPath(artifactB.relativePath)
    );
    const originalHashA = sha256Bytes(originalA);
    const originalHashB = sha256Bytes(originalB);

    const service = new TimelineService(
      productFlow,
      workflow,
      artifacts,
      reviews,
      timelines,
      projectsRoot
    );
    let timeline = await service.getOrCreate(projectId);
    assert.equal(timeline.status, "DRAFT");
    assert.equal(timeline.clips.length, 2);
    assert.equal(timeline.clips[0]!.sourceArtifactId, artifactA.id);
    assert.equal(timeline.clips[1]!.sourceArtifactId, artifactB.id);
    assert.equal(timeline.clips[0]!.sourceDurationMs >= 1900, true);
    assert.equal(timeline.clips[1]!.sourceDurationMs >= 1900, true);

    const editA = timeline.clips[0]!;
    const editB = timeline.clips[1]!;
    timeline = await service.updateClip(projectId, editA.id, {
      inMs: 200,
      outMs: 1600,
      volume: 0.5
    });
    timeline = await service.reorder(projectId, [editB.id, editA.id]);
    timeline = await service.updateClip(projectId, editA.id, {
      deleted: true
    });
    assert.equal(timeline.clips.find((item) => item.id === editA.id)?.deleted, true);
    timeline = await service.updateClip(projectId, editA.id, {
      deleted: false
    });
    const activeAfterRestore = timeline.clips
      .filter((item) => !item.deleted)
      .sort((a, b) => a.order - b.order);
    assert.deepEqual(
      activeAfterRestore.map((item) => item.id),
      [editB.id, editA.id]
    );
    timeline = await service.updateClip(projectId, editB.id, {
      transitionType: "CROSSFADE",
      transitionDurationMs: 300
    });
    timeline = await service.addTextItem(projectId, {
      kind: "CAPTION",
      text: "Timeline render test",
      startMs: 200,
      endMs: 1300,
      position: "BOTTOM",
      fontScale: 1
    });
    timeline = await service.addTextItem(projectId, {
      kind: "CTA",
      text: "了解更多",
      startMs: 1400,
      endMs: 2600,
      position: "CENTER",
      fontScale: 1.1
    });

    const bgmArtifact = await store.writeImmutable({
      id: `bgm-${randomUUID()}`,
      projectId,
      kind: "USER_INPUT",
      relativePath: "timeline/bgm/test.m4a",
      immutable: true,
      bytes: await fs.readFile(bgmSource),
      mimeType: "audio/mp4"
    });
    timeline = await service.setBgm({
      projectId,
      artifactId: bgmArtifact.id,
      volume: 0.2
    });
    assert.equal(timeline.audioItems.filter((item) => !item.deleted).length, 1);
    assert.equal(timeline.textItems.filter((item) => !item.deleted).length, 2);
    const repairMask = {
      id: "repair-mask-" + randomUUID(),
      sourceArtifactId: artifactB.id,
      sourceArtifactHash: artifactB.sha256!,
      startMs: 0,
      endMs: 1000,
      xRatio: 0,
      yRatio: 0,
      widthRatio: 1,
      heightRatio: 0.2,
      color: "WHITE" as const,
      opacity: 1,
      reason: "render integration test mask",
      deleted: false
    };
    const timelineWithMask = {
      ...timeline,
      repairMasks: [repairMask],
      updatedAt: new Date().toISOString()
    };
    timeline = timelineSchema.parse({
      ...timelineWithMask,
      contentHash: timelineDecisionHash(timelineWithMask)
    });
    timeline = await timelines.saveTimeline(timeline);
    assert.equal(timeline.repairMasks.length, 1);
    assert.equal(timelineDurationMs(timeline) > 2800, true);
    assert.equal(timelineDurationMs(timeline) < 3400, true);

    const restartedRepo = new PrismaTimelineRepository(db);
    const restored = await restartedRepo.latestTimeline(projectId);
    assert.ok(restored);
    assert.equal(restored!.contentHash, timeline.contentHash);
    assert.deepEqual(
      restored!.clips
        .filter((item) => !item.deleted)
        .sort((a, b) => a.order - b.order)
        .map((item) => item.id),
      [editB.id, editA.id]
    );

    await productFlow.setProjectStatus(projectId, "GENERATION_REVIEW");
    timeline = await service.confirm(projectId);
    assert.equal(timeline.status, "CONFIRMED");
    assert.equal(
      (await productFlow.getWorkspace(projectId))!.project.status,
      "READY_TO_ASSEMBLE"
    );
    const queued = await timelines.latestRenderJob(projectId);
    assert.ok(queued);
    assert.equal(queued!.status, "QUEUED");
    assert.equal(queued!.timelineHash, timeline.contentHash);
    assert.deepEqual(
      new Set(queued!.inputArtifactHashes),
      new Set([
        artifactA.sha256!,
        artifactB.sha256!,
        bgmArtifact.sha256!
      ])
    );

    const engine = new RenderEngine(
      productFlow,
      artifacts,
      timelines,
      finalOutput,
      projectsRoot
    );
    const rendered = await engine.render(projectId);
    assert.equal(rendered.renderJob.status, "SUCCEEDED");
    assert.equal(rendered.assembly.timelineId, timeline.id);
    assert.equal(rendered.assembly.timelineHash, timeline.contentHash);
    assert.equal(rendered.assembly.renderJobId, rendered.renderJob.id);
    assert.equal(rendered.assembly.renderConfig?.format, "mp4");
    assert.equal(
      rendered.assembly.outputArtifactHash,
      rendered.renderJob.outputArtifactHash
    );

    const output = await artifacts.findById(rendered.assembly.outputArtifactId);
    assert.equal(output?.kind, "FINAL_VIDEO");
    assert.equal(output?.integrityStatus, "READY");
    assert.equal(output?.sha256, rendered.assembly.outputArtifactHash);
    const renderedPath = store.resolveArtifactPath(output!.relativePath);
    const outputBytes = await fs.readFile(renderedPath);
    assert.equal(sha256Bytes(outputBytes), output!.sha256);

    const maskProbe = await runFile("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      renderedPath,
      "-frames:v",
      "1",
      "-vf",
      "crop=16:16:0:0,signalstats,metadata=print:file=-",
      "-f",
      "null",
      "NUL"
    ]);
    assert.equal(maskProbe.ok, true, maskProbe.stderr);
    const yavg = Number(
      /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(maskProbe.stdout)?.[1]
    );
    assert.equal(Number.isFinite(yavg), true);
    assert.equal(yavg > 230, true, "repair mask must render as white pixels");

    const probed = await runFile("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      store.resolveArtifactPath(output!.relativePath)
    ]);
    assert.equal(probed.ok, true, probed.stderr);
    const finalDurationSec = Number(probed.stdout.trim());
    assert.equal(Number.isFinite(finalDurationSec), true);
    assert.equal(finalDurationSec > 2.8, true);
    assert.equal(finalDurationSec < 3.5, true);

    assert.equal(
      sha256Bytes(
        await fs.readFile(store.resolveArtifactPath(artifactA.relativePath))
      ),
      originalHashA
    );
    assert.equal(
      sha256Bytes(
        await fs.readFile(store.resolveArtifactPath(artifactB.relativePath))
      ),
      originalHashB
    );

    const secondRender = await engine.render(projectId);
    assert.equal(secondRender.renderJob.id, rendered.renderJob.id);
    assert.equal(secondRender.assembly.id, rendered.assembly.id);
  } finally {
    await cleanup(db, projectId).catch(() => undefined);
    await db.$disconnect();
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
