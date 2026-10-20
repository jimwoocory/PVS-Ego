import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
import {
  H,
  makeApproval,
  makeAttempt,
  makePreflight,
  makeRequest
} from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

class FaultMatrixProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  private readonly evidence: ProviderCommandEvidence[] = [];
  readonly reconcileByRequest = new Map<string, ReconcileResult>();
  pollCalls = 0;
  downloadCalls = 0;

  private push(
    operation: ProviderCommandOperation,
    exitCode = 0,
    stderrRedacted = ""
  ): void {
    const now = new Date().toISOString();
    this.evidence.push({
      operation,
      argvRedacted: ["dreamina", `<${operation.toLowerCase()}>`],
      stdoutRedacted: exitCode === 0 ? `${operation} ok` : "",
      stderrRedacted,
      startedAt: now,
      completedAt: now,
      exitCode,
      timedOut: false
    });
  }

  drainCommandEvidence(operation?: ProviderCommandOperation): ProviderCommandEvidence[] {
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
    throw new Error("not used");
  }
  async accountStatus(): Promise<AccountStatus> {
    throw new Error("not used");
  }
  async estimate(_requests: GenerationRequest[]): Promise<CostEstimateResult> {
    throw new Error("not used");
  }
  async submit(_request: GenerationRequest): Promise<SubmitResult> {
    throw new Error("not used");
  }

  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> {
    this.pollCalls += 1;
    if (this.pollCalls === 1) {
      this.push("STATUS", 1, "temporary status failure");
      throw new Error("temporary status failure");
    }
    this.push("STATUS");
    return { status: "SUCCEEDED" };
  }

  async download(
    _handle: GenerationHandle,
    outputPath: string
  ): Promise<DownloadedAsset> {
    this.downloadCalls += 1;
    if (this.downloadCalls === 1) {
      this.push("DOWNLOAD", 1, "temporary download failure");
      throw new Error("temporary download failure");
    }
    const bytes = Buffer.from("retried-download-output", "utf8");
    await fs.writeFile(outputPath, bytes);
    this.push("DOWNLOAD");
    return {
      path: outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length
    };
  }

  async reconcileSubmission(input: {
    requestHash: string;
    submissionFingerprint: string;
    knownHandle?: GenerationHandle;
  }): Promise<ReconcileResult> {
    this.push("RECONCILE");
    return (
      this.reconcileByRequest.get(input.requestHash) ?? {
        outcome: "INCONCLUSIVE",
        reason: "missing test mapping"
      }
    );
  }
}

test("reconcile matrix plus poll/download failures preserve durable Attempt semantics", async () => {
  const db = new PrismaClient();
  const projectId = `faults-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-generation-faults-")
  );
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  const provider = new FaultMatrixProvider();
  const execution = new GenerationExecutionService(
    generation,
    workflow,
    artifacts,
    providerAudit,
    provider,
    projectsRoot
  );

  async function createAttempt(
    label: string,
    status:
      | "SUBMISSION_OUTCOME_UNKNOWN"
      | "SUBMITTED"
      | "SUCCEEDED",
    handle?: GenerationHandle
  ) {
    const clipId = `clip-${projectId}-${label}`;
    const requestHash = hash(`request-${label}`);
    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      generateAudio: false,
      compiledPromptId: `prompt-${randomUUID()}`,
      compiledPromptHash: hash(`prompt-${label}`),
      requestHash
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash,
      reportHash: hash(`preflight-${label}`)
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash,
      preflightReportId: preflight.id,
      preflightHash: preflight.reportHash,
      approvalHash: hash(`approval-${label}`)
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId,
      attemptNumber: 1,
      generationRequestId: request.id,
      requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash: approval.approvalHash,
      submissionFingerprint: hash(`fingerprint-${label}`),
      status,
      ...(handle ? { providerHandle: handle } : {})
    };
    await workflow.createGenerationAttempt(attempt);

    if (status === "SUBMISSION_OUTCOME_UNKNOWN") {
      await workflow.createBlocker({
        id: `blocker-${randomUUID()}`,
        projectId,
        scope: "GENERATION_ATTEMPT",
        relatedEntityId: attempt.id,
        reasonCode: "SUBMISSION_RECONCILIATION_REQUIRED",
        message: "unknown submit",
        requiredUserAction: "reconcile",
        resumeCheckpoint: "generation.reconcile",
        createdAt: new Date().toISOString()
      });
    }
    return attempt;
  }

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Generation Fault Matrix",
      status: "GENERATING",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const active = await createAttempt("active", "SUBMISSION_OUTCOME_UNKNOWN");
    const failed = await createAttempt("failed", "SUBMISSION_OUTCOME_UNKNOWN");
    const notFound = await createAttempt(
      "not-found",
      "SUBMISSION_OUTCOME_UNKNOWN"
    );
    const inconclusive = await createAttempt(
      "inconclusive",
      "SUBMISSION_OUTCOME_UNKNOWN"
    );

    provider.reconcileByRequest.set(active.requestHash, {
      outcome: "FOUND_ACTIVE",
      handle: { externalTaskId: "task-active" }
    });
    provider.reconcileByRequest.set(failed.requestHash, {
      outcome: "FOUND_FAILED",
      handle: { externalTaskId: "task-failed" },
      reason: "provider failed"
    });
    provider.reconcileByRequest.set(notFound.requestHash, {
      outcome: "NOT_FOUND"
    });
    provider.reconcileByRequest.set(inconclusive.requestHash, {
      outcome: "INCONCLUSIVE",
      reason: "provider cannot determine outcome"
    });

    const activeResult = await execution.reconcileAttempt(active.id);
    assert.equal(activeResult.status, "PROCESSING");
    assert.equal(activeResult.providerHandle?.externalTaskId, "task-active");

    const failedResult = await execution.reconcileAttempt(failed.id);
    assert.equal(failedResult.status, "RECONCILED_FAILED");
    assert.equal(failedResult.errorCode, "RECONCILED_FAILED");

    const notFoundResult = await execution.reconcileAttempt(notFound.id);
    assert.equal(notFoundResult.status, "RECONCILED_FAILED");
    assert.equal(notFoundResult.errorCode, "RECONCILED_NOT_FOUND");

    const inconclusiveResult = await execution.reconcileAttempt(
      inconclusive.id
    );
    assert.equal(inconclusiveResult.status, "SUBMISSION_OUTCOME_UNKNOWN");
    assert.equal(
      inconclusiveResult.errorCode,
      "RECONCILIATION_INCONCLUSIVE"
    );

    const openBlockers = await workflow.listOpenBlockers(projectId);
    assert.equal(
      openBlockers.filter(
        (item) =>
          item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED"
      ).length,
      1
    );
    assert.equal(
      openBlockers[0]?.relatedEntityId,
      inconclusive.id
    );

    const poll = await createAttempt("poll", "SUBMITTED", {
      externalTaskId: "task-poll"
    });
    const attemptCountBeforePoll = (
      await workflow.listGenerationAttempts(projectId)
    ).length;
    const firstPoll = await execution.pollAttempt(poll.id);
    assert.equal(firstPoll.status, "SUBMITTED");
    assert.equal(firstPoll.providerHandle?.externalTaskId, "task-poll");
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      attemptCountBeforePoll
    );

    const secondPoll = await execution.pollAttempt(poll.id);
    assert.equal(secondPoll.status, "SUCCEEDED");
    assert.equal(secondPoll.providerHandle?.externalTaskId, "task-poll");
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      attemptCountBeforePoll
    );

    const download = await createAttempt("download", "SUCCEEDED", {
      externalTaskId: "task-download"
    });
    const attemptCountBeforeDownload = (
      await workflow.listGenerationAttempts(projectId)
    ).length;
    const failedDownload = await execution.downloadAttempt(download.id);
    assert.equal(failedDownload.status, "SUCCEEDED");
    assert.equal(failedDownload.outputArtifactId, undefined);
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      attemptCountBeforeDownload
    );

    const successfulDownload = await execution.downloadAttempt(download.id);
    assert.equal(successfulDownload.status, "SUCCEEDED");
    assert.ok(successfulDownload.outputArtifactId);
    assert.equal(
      (await workflow.listGenerationAttempts(projectId)).length,
      attemptCountBeforeDownload
    );
    const output = await artifacts.findById(
      successfulDownload.outputArtifactId!
    );
    assert.equal(output?.integrityStatus, "READY");
    assert.equal(output?.kind, "GENERATED_VIDEO");

    const commands = await providerAudit.listCommandAttempts(projectId);
    const reconcileCommands = commands.filter(
      (item) => item.operation === "RECONCILE"
    );
    assert.equal(reconcileCommands.length, 4);
    assert.ok(
      commands.some(
        (item) =>
          item.operation === "STATUS" &&
          item.errorCode === "STATUS_FAILED"
      )
    );
    assert.ok(
      commands.some(
        (item) =>
          item.operation === "DOWNLOAD" &&
          item.errorCode === "DOWNLOAD_FAILED"
      )
    );
    for (const command of commands) {
      assert.ok(command.stdoutArtifactId);
      assert.ok(command.stderrArtifactId);
    }
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
