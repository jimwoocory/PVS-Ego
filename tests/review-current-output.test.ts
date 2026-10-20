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
import { DomainValidationError } from "../src/domain/validation.js";
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

function makePlan(projectId: string, clipId: string): ProductionPlan {
  const clip = makeValidClip();
  clip.id = clipId;
  clip.sceneId = "scene-review-current";
  return {
    id: `plan-${randomUUID()}`,
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-review-current",
      version: 1,
      hash: H.a
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-review-current",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-review-current",
    visualDirection: "studio",
    soundDirection: "clean",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: []
      },
      characters: [],
      environments: [
        {
          sceneId: "scene-review-current",
          stableElements: ["studio"]
        }
      ]
    },
    scenes: [
      {
        id: "scene-review-current",
        order: 1,
        purpose: "product",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [clip]
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

test("READY_TO_ASSEMBLE requires ACCEPT bound to latest successful Attempt and READY output", async () => {
  const db = new PrismaClient();
  const projectId = `review-current-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
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

  async function createSuccessfulAttempt(label: string, attemptNumber: number) {
    const requestHash = hash(`request-${label}`);
    const preflightHash = hash(`preflight-${label}`);
    const approvalHash = hash(`approval-${label}`);
    const request = {
      ...makeRequest(),
      id: `request-${label}-${randomUUID()}`,
      projectId,
      clipId,
      compiledPromptId: `prompt-${label}-${randomUUID()}`,
      compiledPromptHash: hash(`prompt-${label}`),
      requestHash
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${label}-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash,
      reportHash: preflightHash
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${label}-${randomUUID()}`,
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

    const artifactId = `video-${label}-${randomUUID()}`;
    const artifactHash = hash(`video-${label}`);
    await artifacts.createPending({
      id: artifactId,
      projectId,
      kind: "GENERATED_VIDEO",
      relativePath: `outputs/${clipId}/${label}.mp4`,
      immutable: true,
      mimeType: "video/mp4"
    });
    await artifacts.markReady(artifactId, {
      sha256: artifactHash,
      sizeBytes: 100 + attemptNumber,
      mimeType: "video/mp4"
    });

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${label}-${randomUUID()}`,
      projectId,
      clipId,
      attemptNumber,
      generationRequestId: request.id,
      requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash,
      submissionFingerprint: hash(`fingerprint-${label}`),
      status: "SUCCEEDED" as const,
      providerHandle: { externalTaskId: `task-${label}` },
      outputArtifactId: artifactId,
      completedAt: new Date().toISOString()
    };
    await workflow.createGenerationAttempt(attempt);
    return { attempt, artifactHash };
  }

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Review Current Output",
      status: "GENERATION_REVIEW",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });
    const plan = makePlan(projectId, clipId);
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

    const oldOutput = await createSuccessfulAttempt("old", 1);
    await reviews.createDecision({
      id: `review-old-${randomUUID()}`,
      projectId,
      clipId,
      clipHash: plan.scenes[0]!.clips[0]!.contentHash,
      generationAttemptId: oldOutput.attempt.id,
      outputArtifactId: oldOutput.attempt.outputArtifactId!,
      outputArtifactHash: oldOutput.artifactHash,
      decision: "ACCEPT",
      decidedAt: new Date(Date.now() - 10_000).toISOString()
    });

    const newOutput = await createSuccessfulAttempt("new", 2);

    await assert.rejects(
      service.decide({
        projectId,
        clipId,
        generationAttemptId: oldOutput.attempt.id,
        decision: "ACCEPT"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /current latest successful output/.test(error.message)
    );

    assert.equal(
      (await productFlow.getProject(projectId))?.status,
      "GENERATION_REVIEW"
    );

    const accepted = await service.decide({
      projectId,
      clipId,
      generationAttemptId: newOutput.attempt.id,
      decision: "ACCEPT"
    });
    assert.equal(accepted.projectStatus, "READY_TO_ASSEMBLE");
    assert.equal(
      (await productFlow.getProject(projectId))?.status,
      "READY_TO_ASSEMBLE"
    );

    const decisions = await reviews.listDecisions(projectId);
    const currentAccept = decisions.find(
      (item) =>
        item.generationAttemptId === newOutput.attempt.id &&
        item.decision === "ACCEPT"
    );
    assert.equal(currentAccept?.outputArtifactId, newOutput.attempt.outputArtifactId);
    assert.equal(currentAccept?.outputArtifactHash, newOutput.artifactHash);
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
