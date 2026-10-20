import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import { ReviewService } from "../src/application/services/review-service.js";
import {
  SubmissionOutcomeUnknownError,
  type AccountStatus,
  type CostEstimateResult,
  type DownloadedAsset,
  type GenerationHandle,
  type GenerationStatusResult,
  type ProviderCommandEvidence,
  type ProviderCommandOperation,
  type ProviderProbeResult,
  type ReconcileResult,
  type SubmitResult,
  type VideoProvider
} from "../src/application/ports/video-provider.js";
import type {
  GenerationRequest,
  ProductionPlan
} from "../src/domain/schemas.js";
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

class UnknownThenRecoveredProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  submitCalls = 0;
  private readonly evidence: ProviderCommandEvidence[] = [];

  private pushEvidence(operation: ProviderCommandOperation): void {
    this.evidence.push({
      operation,
      argvRedacted: ["dreamina", `<verified-${operation.toLowerCase()}-command>`],
      stdoutRedacted: `${operation} safe stdout`,
      stderrRedacted: "",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: operation === "SUBMIT" ? 1 : 0,
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

  constructor(
    private readonly beforeUnknown: () => Promise<void>
  ) {}

  async probe(): Promise<ProviderProbeResult> {
    this.pushEvidence("PROBE");
    return {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath: "C:/verified/dreamina.exe",
      executableSha256: H.a,
      cliVersion: "1.0.0",
      providerIdentityHash: H.b,
      supportedOperations: [
        "probe",
        "accountStatus",
        "estimate",
        "submit",
        "status",
        "download",
        "reconcileSubmission"
      ],
      supportedModels: ["seedance-2.0"],
      supportedDurationsMs: [8000],
      capabilityFingerprint: H.c,
      rawStdout: "verified",
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
    this.pushEvidence("SUBMIT");
    await this.beforeUnknown();
    throw new SubmissionOutcomeUnknownError(
      "simulated crash window after external submit"
    );
  }

  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> {
    return { status: "SUCCEEDED" };
  }

  async download(
    _handle: GenerationHandle,
    outputPath: string
  ): Promise<DownloadedAsset> {
    this.pushEvidence("DOWNLOAD");
    const bytes = Buffer.from("fake-video-output", "utf8");
    const providerPath = path.join(
      path.dirname(outputPath),
      "provider-generated-video.mp4"
    );
    await fs.writeFile(providerPath, bytes);
    await fs.writeFile(
      path.join(path.dirname(outputPath), "provider-sidecar.json"),
      JSON.stringify({ temporary: true }),
      "utf8"
    );
    return {
      path: providerPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length
    };
  }

  async reconcileSubmission(): Promise<ReconcileResult> {
    this.pushEvidence("RECONCILE");
    return {
      outcome: "FOUND_SUCCEEDED",
      handle: { externalTaskId: "task-recovered-1" }
    };
  }
}

function makeSingleClipPlan(projectId: string, clipId: string): ProductionPlan {
  const clip = makeValidClip();
  clip.id = clipId;
  clip.sceneId = "scene-exec";
  return {
    id: `plan-${randomUUID()}`,
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-exec",
      version: 1,
      hash: H.a
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-exec",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-exec",
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
        { sceneId: "scene-exec", stableElements: ["studio"] }
      ]
    },
    scenes: [
      {
        id: "scene-exec",
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

test("submit unknown -> reconcile -> download -> ACCEPT persists full recovery/review chain", async () => {
  const db = new PrismaClient();
  const projectId = `exec-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-execution-review-")
  );
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  const reviewRepo = new PrismaReviewRepository(db);

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Execution Review",
      status: "GENERATING",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const plan = makeSingleClipPlan(projectId, clipId);
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

    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      generateAudio: false,
      compiledPromptId: `prompt-${randomUUID()}`,
      requestHash: H.d
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
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
      approvalHash: H.f
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);
    // Simulate a separately approved scene; REDO must not revoke this chain.
    const otherRequest = {
      ...request,
      id: `request-other-${randomUUID()}`,
      clipId: `clip-other-${randomUUID()}`,
      compiledPromptId: `prompt-other-${randomUUID()}`,
      requestHash: H.two
    };
    const otherPreflight = {
      ...preflight,
      id: `preflight-other-${randomUUID()}`,
      generationRequestId: otherRequest.id,
      requestHash: otherRequest.requestHash,
      reportHash: H.three
    };
    const otherApproval = {
      ...approval,
      id: `approval-other-${randomUUID()}`,
      generationRequestId: otherRequest.id,
      requestHash: otherRequest.requestHash,
      preflightReportId: otherPreflight.id,
      preflightHash: otherPreflight.reportHash,
      approvalHash: H.four
    };
    await generation.createGenerationRequest(otherRequest);
    await generation.createPreflightReport(otherPreflight);
    await generation.createUserApproval(otherApproval);

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash: approval.approvalHash,
      submissionFingerprint: H.one
    };
    await workflow.createGenerationAttempt(attempt);

    const provider = new UnknownThenRecoveredProvider(async () => {
      const durable = await workflow.getGenerationAttempt(attempt.id);
      assert.equal(durable?.status, "SUBMITTING");
    });
    const execution = new GenerationExecutionService(
      generation,
      workflow,
      artifacts,
      providerAudit,
      provider,
      projectsRoot
    );

    const unknown = await execution.submitAttempt(attempt.id);
    assert.equal(unknown.status, "SUBMISSION_OUTCOME_UNKNOWN");
    assert.equal(provider.submitCalls, 1);
    assert.equal(
      (await workflow.listOpenBlockers(projectId))[0]?.reasonCode,
      "SUBMISSION_RECONCILIATION_REQUIRED"
    );

    const auditAfterSubmit =
      await providerAudit.listCommandAttempts(projectId);
    assert.equal(auditAfterSubmit.length, 2);
    assert.deepEqual(
      auditAfterSubmit.map((item) => item.operation),
      ["PROBE", "SUBMIT"]
    );
    const submitAudit = auditAfterSubmit.find(
      (item) => item.operation === "SUBMIT"
    )!;
    assert.equal(submitAudit.errorCode, "SUBMISSION_OUTCOME_UNKNOWN");
    assert.ok(submitAudit.stdoutArtifactId);
    assert.ok(submitAudit.stderrArtifactId);
    const submitStdout = await artifacts.findById(
      submitAudit.stdoutArtifactId!
    );
    const submitStderr = await artifacts.findById(
      submitAudit.stderrArtifactId!
    );
    assert.equal(submitStdout?.integrityStatus, "READY");
    assert.equal(submitStderr?.integrityStatus, "READY");
    assert.equal(submitStdout?.kind, "STDOUT");
    assert.equal(submitStderr?.kind, "STDERR");

    const reconciled = await execution.reconcileAttempt(attempt.id);
    assert.equal(reconciled.status, "RECONCILED_SUCCEEDED");
    assert.equal(reconciled.providerHandle?.externalTaskId, "task-recovered-1");
    assert.equal((await workflow.listOpenBlockers(projectId)).length, 0);

    const downloaded = await execution.downloadAttempt(attempt.id);
    assert.ok(downloaded.outputArtifactId);
    const video = await artifacts.findById(downloaded.outputArtifactId!);
    assert.equal(video?.kind, "GENERATED_VIDEO");
    assert.equal(video?.integrityStatus, "READY");
    assert.ok(video?.sha256);
    const tempEntries = await fs
      .readdir(path.join(projectsRoot, projectId, ".tmp"), { recursive: true })
      .catch(() => []);
    assert.deepEqual(tempEntries, []);

    const review = new ReviewService(
      productFlow,
      generation,
      workflow,
      artifacts,
      reviewRepo
    );
    const accepted = await review.decide({
      projectId,
      clipId,
      generationAttemptId: attempt.id,
      decision: "ACCEPT"
    });
    assert.equal(accepted.decision.decision, "ACCEPT");
    assert.equal(accepted.projectStatus, "READY_TO_ASSEMBLE");
    assert.equal(
      (await reviewRepo.listDecisions(projectId))[0]?.outputArtifactId,
      downloaded.outputArtifactId
    );

    const attemptsBeforeRedo = await workflow.listGenerationAttempts(projectId);
    const redo = await review.decide({
      projectId,
      clipId,
      generationAttemptId: attempt.id,
      decision: "REDO",
      note: "test redo without automatic submit"
    });
    assert.equal(redo.decision.decision, "REDO");
    assert.equal(redo.projectStatus, "GENERATION_REVIEW");
    assert.equal(redo.redoClipId, clipId);
    const attemptsAfterRedo = await workflow.listGenerationAttempts(projectId);
    assert.equal(attemptsAfterRedo.length, attemptsBeforeRedo.length);
    const staleRequest = await db.generationRequestRecord.findUnique({
      where: { id: request.id }
    });
    const stalePreflight = await db.preflightReportRecord.findUnique({
      where: { id: preflight.id }
    });
    const staleApproval = await db.userApprovalRecord.findUnique({
      where: { id: approval.id }
    });
    assert.equal(staleRequest?.status, "STALE");
    assert.equal(stalePreflight?.status, "STALE");
    assert.equal(staleApproval?.status, "STALE");
    assert.equal(
      (await db.generationRequestRecord.findUnique({ where: {id:otherRequest.id} }))?.status,
      "CURRENT"
    );
    assert.equal(
      (await db.preflightReportRecord.findUnique({ where: {id:otherPreflight.id} }))?.status,
      "PASS"
    );
    assert.equal(
      (await db.userApprovalRecord.findUnique({ where: {id:otherApproval.id} }))?.status,
      "ACTIVE"
    );

    const commands = await providerAudit.listCommandAttempts(projectId);
    assert.deepEqual(
      commands.map((item) => item.operation),
      ["PROBE", "SUBMIT", "RECONCILE", "DOWNLOAD"]
    );
    for (const command of commands) {
      assert.ok(command.stdoutArtifactId);
      assert.ok(command.stderrArtifactId);
      assert.ok(command.argvRedacted.length >= 2);
      const stdoutArtifact = await artifacts.findById(command.stdoutArtifactId!);
      const stderrArtifact = await artifacts.findById(command.stderrArtifactId!);
      assert.equal(stdoutArtifact?.integrityStatus, "READY");
      assert.equal(stderrArtifact?.integrityStatus, "READY");
    }
  } finally {
    await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.generationAttemptRecord.deleteMany({ where: { projectId } });
    await db.userApprovalRecord.deleteMany({ where: { projectId } });
    await db.preflightReportRecord.deleteMany({ where: { projectId } });
    await db.generationRequestRecord.deleteMany({ where: { projectId } });
    await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
    await db.artifactRecord.deleteMany({ where: { projectId } });
    await db.versionedEntity.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
