import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import type {
  AccountStatus,
  CostEstimateResult,
  DownloadedAsset,
  GenerationHandle,
  GenerationStatusResult,
  ProviderCommandEvidence,
  ProviderCommandOperation,
  ProviderProbeResult,
  ReconcileResult,
  SubmitResult,
  VideoProvider
} from "../src/application/ports/video-provider.js";
import type { GenerationRequest } from "../src/domain/schemas.js";
import { DomainValidationError } from "../src/domain/validation.js";
import {
  H,
  makeApproval,
  makeAttempt,
  makePreflight,
  makeRequest
} from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

class DriftedProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  submitCalls = 0;
  private readonly evidence: ProviderCommandEvidence[] = [];

  private push(operation: ProviderCommandOperation): void {
    const now = new Date().toISOString();
    this.evidence.push({
      operation,
      argvRedacted: ["dreamina", "<probe-after-approval>"],
      stdoutRedacted: "drifted provider probe",
      stderrRedacted: "",
      startedAt: now,
      completedAt: now,
      exitCode: 0,
      timedOut: false
    });
  }

  drainCommandEvidence(
    operation?: ProviderCommandOperation
  ): ProviderCommandEvidence[] {
    const selected: ProviderCommandEvidence[] = [];
    const retained: ProviderCommandEvidence[] = [];
    for (const item of this.evidence) {
      if (!operation || item.operation === operation) selected.push(item);
      else retained.push(item);
    }
    this.evidence.splice(0, this.evidence.length, ...retained);
    return selected;
  }

  async probe(): Promise<ProviderProbeResult> {
    this.push("PROBE");
    return {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath: "C:/verified/dreamina.exe",
      executableSha256: H.a,
      cliVersion: "2.0.0",
      providerIdentityHash: H.one,
      supportedOperations: ["submit", "status", "download"],
      supportedModels: ["seedance-2.0"],
      supportedDurationsMs: [8000],
      capabilityFingerprint: H.two,
      rawStdout: "drifted",
      rawStderr: ""
    };
  }

  async accountStatus(): Promise<AccountStatus> {
    return { status: "AUTHENTICATED" };
  }
  async estimate(_requests: GenerationRequest[]): Promise<CostEstimateResult> {
    return { status: "KNOWN", estimatedCredits: 1 };
  }
  async submit(_request: GenerationRequest): Promise<SubmitResult> {
    this.submitCalls += 1;
    return { externalTaskId: "must-not-exist" };
  }
  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> {
    throw new Error("not used");
  }
  async download(
    _handle: GenerationHandle,
    _outputPath: string
  ): Promise<DownloadedAsset> {
    throw new Error("not used");
  }
  async reconcileSubmission(): Promise<ReconcileResult> {
    return { outcome: "INCONCLUSIVE", reason: "not used" };
  }
}

test("provider identity/capability drift stales approved chain and blocks external submit", async () => {
  const db = new PrismaClient();
  const projectId = `provider-drift-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-provider-drift-")
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Provider Drift",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      requestHash: H.d,
      providerIdentityHash: H.b,
      capabilityFingerprint: H.c
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      providerIdentityHash: request.providerIdentityHash,
      capabilityFingerprint: request.capabilityFingerprint,
      reportHash: H.e
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      preflightHash: preflight.reportHash,
      providerIdentityHash: request.providerIdentityHash,
      capabilityFingerprint: request.capabilityFingerprint,
      approvalHash: H.f
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash: approval.approvalHash
    };
    await workflow.createGenerationAttempt(attempt);

    const provider = new DriftedProvider();
    const execution = new GenerationExecutionService(
      generation,
      workflow,
      artifacts,
      providerAudit,
      provider,
      projectsRoot
    );

    await assert.rejects(
      execution.submitAttempt(attempt.id),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /Provider changed after approval/.test(error.message)
    );
    assert.equal(provider.submitCalls, 0);

    const requestRow = await db.generationRequestRecord.findUnique({
      where: { id: request.id }
    });
    assert.equal(requestRow?.status, "STALE");
    assert.equal(
      (await generation.getPreflightReport(preflight.id))?.status,
      "STALE"
    );
    assert.equal(
      (await generation.getUserApproval(approval.id))?.status,
      "STALE"
    );

    const durableAttempt = await workflow.getGenerationAttempt(attempt.id);
    assert.equal(durableAttempt?.status, "CREATED");
    assert.equal(
      durableAttempt?.errorCode,
      "PROVIDER_CHANGED_BEFORE_SUBMIT"
    );
    const blockers = await workflow.listOpenBlockers(projectId);
    assert.ok(
      blockers.some((item) => item.reasonCode === "PROVIDER_CHANGED")
    );

    const commands = await providerAudit.listCommandAttempts(projectId);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.operation, "PROBE");
    assert.equal(commands[0]?.errorCode, "PROVIDER_CHANGED");
    assert.ok(commands[0]?.stdoutArtifactId);
    assert.ok(commands[0]?.stderrArtifactId);
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
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});

class ThrowingProbeProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  submitCalls = 0;

  async probe(): Promise<ProviderProbeResult> {
    throw new Error("simulated provider probe crash");
  }
  async accountStatus(): Promise<AccountStatus> {
    return { status: "AUTHENTICATED" };
  }
  async estimate(_requests: GenerationRequest[]): Promise<CostEstimateResult> {
    return { status: "KNOWN", estimatedCredits: 1 };
  }
  async submit(_request: GenerationRequest): Promise<SubmitResult> {
    this.submitCalls += 1;
    return { externalTaskId: "must-not-exist" };
  }
  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> {
    throw new Error("not used");
  }
  async download(
    _handle: GenerationHandle,
    _outputPath: string
  ): Promise<DownloadedAsset> {
    throw new Error("not used");
  }
  async reconcileSubmission(): Promise<ReconcileResult> {
    return { outcome: "INCONCLUSIVE", reason: "not used" };
  }
}

test("provider re-probe exception stales approved chain, persists blocker, and never submits", async () => {
  const db = new PrismaClient();
  const projectId = `provider-reprobe-fail-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-provider-reprobe-fail-")
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Provider Reprobe Failure",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      requestHash: H.d,
      providerIdentityHash: H.b,
      capabilityFingerprint: H.c
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      providerIdentityHash: request.providerIdentityHash,
      capabilityFingerprint: request.capabilityFingerprint,
      reportHash: H.e
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      preflightHash: preflight.reportHash,
      providerIdentityHash: request.providerIdentityHash,
      capabilityFingerprint: request.capabilityFingerprint,
      approvalHash: H.f
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash: approval.approvalHash
    };
    await workflow.createGenerationAttempt(attempt);

    const provider = new ThrowingProbeProvider();
    const execution = new GenerationExecutionService(
      generation,
      workflow,
      artifacts,
      providerAudit,
      provider,
      projectsRoot
    );

    await assert.rejects(
      execution.submitAttempt(attempt.id),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /Provider re-probe failed before submit/.test(error.message)
    );
    assert.equal(provider.submitCalls, 0);

    assert.equal(
      (
        await db.generationRequestRecord.findUnique({
          where: { id: request.id }
        })
      )?.status,
      "STALE"
    );
    assert.equal(
      (await generation.getPreflightReport(preflight.id))?.status,
      "STALE"
    );
    assert.equal(
      (await generation.getUserApproval(approval.id))?.status,
      "STALE"
    );

    const durableAttempt = await workflow.getGenerationAttempt(attempt.id);
    assert.equal(durableAttempt?.status, "CREATED");
    assert.equal(durableAttempt?.errorCode, "PROVIDER_REPROBE_FAILED");
    assert.match(
      durableAttempt?.errorMessage ?? "",
      /simulated provider probe crash/
    );

    const blockers = await workflow.listOpenBlockers(projectId);
    assert.ok(
      blockers.some(
        (item) =>
          item.reasonCode === "PROVIDER_CHANGED" &&
          item.relatedEntityId === attempt.id
      )
    );

    const commands = await providerAudit.listCommandAttempts(projectId);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.operation, "PROBE");
    assert.equal(commands[0]?.errorCode, "PROVIDER_REPROBE_FAILED");
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
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
