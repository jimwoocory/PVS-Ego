import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { ApprovalService } from "../src/application/services/approval-service.js";
import { DomainValidationError } from "../src/domain/validation.js";
import {
  H,
  makeApproval,
  makeAttempt,
  makePreflight,
  makeRequest
} from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

test("ApprovalService requires explicit unknown-cost consent and each retry creates new approval/attempt", async () => {
  const db = new PrismaClient();
  const projectId = `approval-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const service = new ApprovalService(generation, workflow);

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Approval Service",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const request1 = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      requestHash: H.d
    };
    const preflight1 = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request1.id,
      requestHash: request1.requestHash,
      reportHash: H.e,
      costEstimate: {
        status: "UNKNOWN" as const,
        observedAt: now
      }
    };
    await generation.createGenerationRequest(request1);
    await generation.createPreflightReport(preflight1);

    await assert.rejects(
      service.approveCurrentRequests({
        projectId,
        acceptedUnknownCostRisk: false,
        acceptedDuplicateSubmissionRisk: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /Unknown cost requires explicit user acceptance/.test(error.message)
    );
    assert.equal(
      (await generation.listUserApprovals(projectId)).length,
      0
    );
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      0
    );

    const first = await service.approveCurrentRequests({
      projectId,
      acceptedUnknownCostRisk: true,
      acceptedDuplicateSubmissionRisk: false
    });
    assert.equal(first.approvals.length, 1);
    assert.equal(first.attempts.length, 1);
    assert.equal(first.approvals[0]?.status, "ACTIVE");
    assert.equal(first.attempts[0]?.attemptNumber, 1);
    assert.equal(
      first.attempts[0]?.userApprovalId,
      first.approvals[0]?.id
    );

    await assert.rejects(
      service.approveCurrentRequests({
        projectId,
        acceptedUnknownCostRisk: true,
        acceptedDuplicateSubmissionRisk: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /already has ACTIVE UserApproval/.test(error.message)
    );

    await generation.markSubmissionChainStale(
      projectId,
      new Date().toISOString()
    );

    const request2 = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      compiledPromptId: `prompt-${randomUUID()}`,
      compiledPromptHash: H.two,
      requestHash: H.three,
      providerIdentityHash: H.b,
      capabilityFingerprint: H.c
    };
    const preflight2 = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request2.id,
      requestHash: request2.requestHash,
      providerIdentityHash: request2.providerIdentityHash,
      capabilityFingerprint: request2.capabilityFingerprint,
      reportHash: H.f,
      costEstimate: {
        status: "KNOWN" as const,
        estimatedCredits: 2,
        observedAt: new Date().toISOString()
      }
    };
    await generation.createGenerationRequest(request2);
    await generation.createPreflightReport(preflight2);

    const second = await service.approveCurrentRequests({
      projectId,
      acceptedUnknownCostRisk: false,
      acceptedDuplicateSubmissionRisk: false
    });
    assert.equal(second.approvals.length, 1);
    assert.equal(second.attempts.length, 1);
    assert.equal(second.attempts[0]?.attemptNumber, 2);
    assert.notEqual(
      second.approvals[0]?.id,
      first.approvals[0]?.id
    );
    assert.notEqual(
      second.attempts[0]?.id,
      first.attempts[0]?.id
    );
    assert.notEqual(
      second.attempts[0]?.preflightReportId,
      first.attempts[0]?.preflightReportId
    );

    const approvals = await generation.listUserApprovals(projectId);
    assert.equal(approvals.length, 2);
    assert.equal(
      approvals.find((item) => item.id === first.approvals[0]!.id)
        ?.status,
      "STALE"
    );
    assert.equal(
      approvals.find((item) => item.id === second.approvals[0]!.id)
        ?.status,
      "ACTIVE"
    );
  } finally {
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
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

test("ApprovalService blocks unresolved submission outcome unless duplicate-cost risk is explicitly accepted", async () => {
  const db = new PrismaClient();
  const projectId = `approval-duplicate-risk-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const service = new ApprovalService(generation, workflow);

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Approval Duplicate Risk",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const oldRequest = {
      ...makeRequest(),
      id: `request-old-${randomUUID()}`,
      projectId,
      clipId,
      requestHash: H.d
    };
    const oldPreflight = {
      ...makePreflight(),
      id: `preflight-old-${randomUUID()}`,
      projectId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      reportHash: H.e
    };
    const oldApproval = {
      ...makeApproval(),
      id: `approval-old-${randomUUID()}`,
      projectId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      preflightReportId: oldPreflight.id,
      preflightHash: oldPreflight.reportHash,
      approvalHash: H.f
    };
    await generation.createGenerationRequest(oldRequest);
    await generation.createPreflightReport(oldPreflight);
    await generation.createUserApproval(oldApproval);
    await workflow.createGenerationAttempt({
      ...makeAttempt(),
      id: `attempt-old-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      preflightReportId: oldPreflight.id,
      userApprovalId: oldApproval.id,
      approvalHash: oldApproval.approvalHash,
      status: "SUBMISSION_OUTCOME_UNKNOWN"
    });

    await generation.markSubmissionChainStale(
      projectId,
      new Date().toISOString()
    );

    const newRequest = {
      ...makeRequest(),
      id: `request-new-${randomUUID()}`,
      projectId,
      clipId,
      compiledPromptId: `prompt-new-${randomUUID()}`,
      compiledPromptHash: H.two,
      requestHash: H.three
    };
    const newPreflight = {
      ...makePreflight(),
      id: `preflight-new-${randomUUID()}`,
      projectId,
      generationRequestId: newRequest.id,
      requestHash: newRequest.requestHash,
      reportHash: H.f,
      costEstimate: {
        status: "KNOWN" as const,
        estimatedCredits: 2,
        observedAt: new Date().toISOString()
      }
    };
    await generation.createGenerationRequest(newRequest);
    await generation.createPreflightReport(newPreflight);

    await assert.rejects(
      service.approveCurrentRequests({
        projectId,
        acceptedUnknownCostRisk: false,
        acceptedDuplicateSubmissionRisk: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /explicit duplicate-submission cost-risk acceptance/.test(
          error.message
        )
    );
    assert.equal(
      (await generation.listUserApprovals(projectId)).filter(
        (item) => item.status === "ACTIVE"
      ).length,
      0
    );

    const accepted = await service.approveCurrentRequests({
      projectId,
      acceptedUnknownCostRisk: false,
      acceptedDuplicateSubmissionRisk: true
    });
    assert.equal(accepted.approvals.length, 1);
    assert.equal(accepted.attempts.length, 1);
    assert.equal(
      accepted.approvals[0]?.acceptedDuplicateSubmissionRisk,
      true
    );
    assert.equal(accepted.attempts[0]?.attemptNumber, 2);
  } finally {
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
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

test("ApprovalService treats RECONCILING as unresolved and preserves old reconciliation blocker", async () => {
  const db = new PrismaClient();
  const projectId = `approval-reconciling-risk-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const service = new ApprovalService(generation, workflow);

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Approval Reconciling Risk",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const oldRequest = {
      ...makeRequest(),
      id: `request-old-${randomUUID()}`,
      projectId,
      clipId,
      requestHash: H.d
    };
    const oldPreflight = {
      ...makePreflight(),
      id: `preflight-old-${randomUUID()}`,
      projectId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      reportHash: H.e
    };
    const oldApproval = {
      ...makeApproval(),
      id: `approval-old-${randomUUID()}`,
      projectId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      preflightReportId: oldPreflight.id,
      preflightHash: oldPreflight.reportHash,
      approvalHash: H.f
    };
    await generation.createGenerationRequest(oldRequest);
    await generation.createPreflightReport(oldPreflight);
    await generation.createUserApproval(oldApproval);
    const oldAttempt = {
      ...makeAttempt(),
      id: `attempt-old-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: oldRequest.id,
      requestHash: oldRequest.requestHash,
      preflightReportId: oldPreflight.id,
      userApprovalId: oldApproval.id,
      approvalHash: oldApproval.approvalHash,
      status: "RECONCILING" as const
    };
    await workflow.createGenerationAttempt(oldAttempt);
    await workflow.createBlocker({
      id: `blocker-${randomUUID()}`,
      projectId,
      scope: "GENERATION_ATTEMPT",
      relatedEntityId: oldAttempt.id,
      reasonCode: "SUBMISSION_RECONCILIATION_REQUIRED",
      message: "still reconciling",
      requiredUserAction: "finish reconcile or accept duplicate cost risk",
      resumeCheckpoint: "generation.reconcile",
      createdAt: now
    });

    await generation.markSubmissionChainStale(
      projectId,
      new Date().toISOString()
    );

    const newRequest = {
      ...makeRequest(),
      id: `request-new-${randomUUID()}`,
      projectId,
      clipId,
      compiledPromptId: `prompt-new-${randomUUID()}`,
      compiledPromptHash: H.two,
      requestHash: H.three
    };
    const newPreflight = {
      ...makePreflight(),
      id: `preflight-new-${randomUUID()}`,
      projectId,
      generationRequestId: newRequest.id,
      requestHash: newRequest.requestHash,
      reportHash: H.f,
      costEstimate: {
        status: "KNOWN" as const,
        estimatedCredits: 3,
        observedAt: new Date().toISOString()
      }
    };
    await generation.createGenerationRequest(newRequest);
    await generation.createPreflightReport(newPreflight);

    await assert.rejects(
      service.approveCurrentRequests({
        projectId,
        acceptedUnknownCostRisk: false,
        acceptedDuplicateSubmissionRisk: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /explicit duplicate-submission cost-risk acceptance/.test(
          error.message
        )
    );

    const accepted = await service.approveCurrentRequests({
      projectId,
      acceptedUnknownCostRisk: false,
      acceptedDuplicateSubmissionRisk: true
    });
    assert.equal(accepted.approvals.length, 1);
    assert.equal(accepted.attempts.length, 1);
    assert.equal(accepted.attempts[0]?.attemptNumber, 2);
    assert.equal(
      accepted.approvals[0]?.acceptedDuplicateSubmissionRisk,
      true
    );

    const attempts = await workflow.listGenerationAttempts(projectId);
    assert.equal(
      attempts.find((item) => item.id === oldAttempt.id)?.status,
      "RECONCILING"
    );
    assert.equal(attempts.length, 2);

    const blockers = await workflow.listOpenBlockers(projectId);
    assert.equal(
      blockers.filter(
        (item) =>
          item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED" &&
          item.relatedEntityId === oldAttempt.id
      ).length,
      1
    );
  } finally {
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
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
