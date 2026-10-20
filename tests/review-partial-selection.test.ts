import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { ReviewService } from "../src/application/services/review-service.js";
import type { ProductionPlan } from "../src/domain/schemas.js";
import {
  H,
  ISO,
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

function makePlan(projectId: string, clipIds: string[]): ProductionPlan {
  const clips = clipIds.map((clipId) => {
    const clip = makeValidClip();
    clip.id = clipId;
    clip.sceneId = "scene-partial";
    return clip;
  });
  return {
    id: `plan-${randomUUID()}`,
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-partial",
      version: 1,
      hash: H.a
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-partial",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-partial",
    visualDirection: "studio",
    soundDirection: "clean",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: { stableAttributes: ["logo"], forbiddenChanges: [] },
      characters: [],
      environments: [
        { sceneId: "scene-partial", stableElements: ["studio"] }
      ]
    },
    scenes: [
      {
        id: "scene-partial",
        order: 1,
        purpose: "product",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

test("accepted clips plus explicit SKIP decisions can complete without generating every Clip", async () => {
  const db = new PrismaClient();
  const projectId = `partial-${randomUUID()}`;
  const [acceptedClipId, skippedClipId, unusedClipId] = [
    `clip-a-${randomUUID()}`,
    `clip-b-${randomUUID()}`,
    `clip-c-${randomUUID()}`
  ];
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const reviews = new PrismaReviewRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const service = new ReviewService(
    productFlow,
    generation,
    workflow,
    artifacts,
    reviews
  );

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Partial Selection",
      status: "GENERATION_REVIEW",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });
    const plan = makePlan(projectId, [
      acceptedClipId,
      skippedClipId,
      unusedClipId
    ]);
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

    const requestHash = hash("request-partial");
    const preflightHash = hash("preflight-partial");
    const approvalHash = hash("approval-partial");
    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId: acceptedClipId,
      compiledPromptId: `prompt-${randomUUID()}`,
      compiledPromptHash: hash("prompt-partial"),
      requestHash
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash,
      reportHash: preflightHash
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash,
      preflightReportId: preflight.id,
      preflightHash,
      approvalHash
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);

    const artifactId = `video-${randomUUID()}`;
    const artifactHash = hash("video-partial");
    await artifacts.createPending({
      id: artifactId,
      projectId,
      kind: "GENERATED_VIDEO",
      relativePath: `outputs/${acceptedClipId}/accepted.mp4`,
      immutable: true,
      mimeType: "video/mp4"
    });
    await artifacts.markReady(artifactId, {
      sha256: artifactHash,
      sizeBytes: 123,
      mimeType: "video/mp4"
    });

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId: acceptedClipId,
      attemptNumber: 1,
      generationRequestId: request.id,
      requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash,
      submissionFingerprint: hash("fingerprint-partial"),
      status: "SUCCEEDED" as const,
      providerHandle: { externalTaskId: "task-partial" },
      outputArtifactId: artifactId,
      completedAt: now
    };
    await workflow.createGenerationAttempt(attempt);

    const accepted = await service.decide({
      projectId,
      clipId: acceptedClipId,
      generationAttemptId: attempt.id,
      decision: "ACCEPT"
    });
    assert.equal(accepted.projectStatus, "GENERATION_REVIEW");

    const skipped = await service.decide({
      projectId,
      clipId: skippedClipId,
      decision: "SKIP"
    });
    assert.equal(skipped.decision.decision, "SKIP");
    assert.equal(skipped.decision.generationAttemptId, undefined);
    assert.equal(skipped.projectStatus, "GENERATION_REVIEW");

    const finalized = await service.finalizeUsingAcceptedClips({ projectId });
    assert.equal(finalized.projectStatus, "READY_TO_ASSEMBLE");
    assert.deepEqual(finalized.acceptedClipIds, [acceptedClipId]);
    assert.deepEqual(
      new Set(finalized.skippedClipIds),
      new Set([skippedClipId, unusedClipId])
    );
    assert.deepEqual(finalized.pendingClipIds, []);
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      1,
      "unneeded clips must not require GenerationAttempt records"
    );

    const restored = await service.decide({
      projectId,
      clipId: skippedClipId,
      decision: "USE"
    });
    assert.equal(restored.projectStatus, "GENERATION_REVIEW");
    assert.equal(
      (await productFlow.getProject(projectId))?.status,
      "GENERATION_REVIEW"
    );
  } finally {
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
    await db.$disconnect();
  }
});
