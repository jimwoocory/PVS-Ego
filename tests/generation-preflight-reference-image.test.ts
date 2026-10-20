import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type {
  AccountStatus,
  CostEstimateResult,
  DownloadedAsset,
  GenerationHandle,
  GenerationStatusResult,
  ProviderProbeResult,
  ReconcileResult,
  SubmitResult,
  VideoProvider
} from "../src/application/ports/video-provider.js";
import { GenerationPreflightService } from "../src/application/services/generation-preflight.js";
import type {
  CompiledPrompt,
  CreativeBatch,
  GenerationAttempt,
  GenerationRequest,
  PreflightReport,
  ProductionPlan,
  ScriptDraft,
  UserApproval,
  WorkflowBlocker
} from "../src/domain/schemas.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

class MemoryGenerationRepository implements GenerationRepository {
  compiled: CompiledPrompt[] = [];
  requests: GenerationRequest[] = [];
  reports: PreflightReport[] = [];
  approvals: UserApproval[] = [];
  async markRequestChainStale(): Promise<void> {}
  async markSubmissionChainStale(): Promise<void> {}
  async saveCompiledPrompt(prompt: CompiledPrompt): Promise<CompiledPrompt> {
    this.compiled.push(prompt);
    return prompt;
  }
  async listCompiledPrompts(): Promise<CompiledPrompt[]> {
    return this.compiled;
  }
  async createGenerationRequest(request: GenerationRequest): Promise<GenerationRequest> {
    this.requests.push(request);
    return request;
  }
  async listGenerationRequests(): Promise<GenerationRequest[]> {
    return this.requests;
  }
  async listCurrentGenerationRequests(): Promise<GenerationRequest[]> {
    return this.requests;
  }
  async getGenerationRequest(id: string): Promise<GenerationRequest | null> {
    return this.requests.find((item) => item.id === id) ?? null;
  }
  async createPreflightReport(report: PreflightReport): Promise<PreflightReport> {
    this.reports.push(report);
    return report;
  }
  async listPreflightReports(): Promise<PreflightReport[]> {
    return this.reports;
  }
  async getPreflightReport(id: string): Promise<PreflightReport | null> {
    return this.reports.find((item) => item.id === id) ?? null;
  }
  async createUserApproval(approval: UserApproval): Promise<UserApproval> {
    this.approvals.push(approval);
    return approval;
  }
  async listUserApprovals(): Promise<UserApproval[]> {
    return this.approvals;
  }
  async getUserApproval(id: string): Promise<UserApproval | null> {
    return this.approvals.find((item) => item.id === id) ?? null;
  }
}

class MemoryWorkflowRepository implements WorkflowRepository {
  blockers: WorkflowBlocker[] = [];
  attempts: GenerationAttempt[] = [];
  async createBlocker(blocker: WorkflowBlocker): Promise<WorkflowBlocker> {
    this.blockers.push(blocker);
    return blocker;
  }
  async listOpenBlockers(projectId: string): Promise<WorkflowBlocker[]> {
    return this.blockers.filter(
      (item) => item.projectId === projectId && !item.resolvedAt
    );
  }
  async resolveBlocker(id: string, resolvedAt: string): Promise<WorkflowBlocker> {
    const blocker = this.blockers.find((item) => item.id === id);
    if (!blocker) throw new Error("missing blocker");
    blocker.resolvedAt = resolvedAt;
    return blocker;
  }
  async nextAttemptNumber(clipId: string): Promise<number> {
    const attempts = this.attempts.filter(
      (item) => item.clipId === clipId
    );
    return attempts.length
      ? Math.max(...attempts.map((item) => item.attemptNumber)) + 1
      : 1;
  }
  async createGenerationAttempt(attempt: GenerationAttempt): Promise<GenerationAttempt> {
    this.attempts.push(attempt);
    return attempt;
  }
  async listGenerationAttempts(projectId: string): Promise<GenerationAttempt[]> {
    return this.attempts.filter((item) => item.projectId === projectId);
  }
  async getGenerationAttempt(id: string): Promise<GenerationAttempt | null> {
    return this.attempts.find((item) => item.id === id) ?? null;
  }
  async updateGenerationAttemptStatus(): Promise<GenerationAttempt> {
    throw new Error("not used");
  }
}

class ReadyProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  async probe(): Promise<ProviderProbeResult> {
    return {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath: "C:/verified/dreamina.exe",
      executableSha256: H.a,
      cliVersion: "1.4.18",
      providerIdentityHash: H.b,
      supportedOperations: [
        "submit",
        "status",
        "download",
        "accountStatus",
        "estimate",
        "reconcileSubmission"
      ],
      supportedModels: ["seedance-2.0-mini"],
      supportedDurationsMs: [8000],
      capabilityFingerprint: H.c,
      rawStdout: "",
      rawStderr: ""
    };
  }
  async accountStatus(): Promise<AccountStatus> {
    return { status: "AUTHENTICATED" };
  }
  async estimate(): Promise<CostEstimateResult> {
    return { status: "UNKNOWN" };
  }
  async submit(): Promise<SubmitResult> {
    throw new Error("must not submit during Preflight");
  }
  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> {
    throw new Error("not used");
  }
  async download(): Promise<DownloadedAsset> {
    throw new Error("not used");
  }
  async reconcileSubmission(): Promise<ReconcileResult> {
    return { outcome: "INCONCLUSIVE", reason: "not used" };
  }
}

function makeBatch(): CreativeBatch {
  const truth = makeProductTruth();
  return {
    id: "batch-reference-image",
    projectId: truth.projectId,
    version: 1,
    status: "ACTIVE",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: truth.id,
      version: truth.version,
      hash: truth.contentHash
    },
    generatorVersion: "test",
    concepts: Array.from({ length: 4 }, (_, index) => ({
      id: `creative-${index + 1}`,
      title: `Concept ${index + 1}`,
      targetAudience: "buyers",
      painPoint: "need",
      hook: "hook",
      coreSellingPoint: "Feature one",
      narrativePattern: "problem-solution",
      expectedDurationMs: 60000,
      productShowcaseStrategy: "hero",
      generationRisk: "LOW" as const,
      requiredFactIds: ["fact-1"]
    })),
    selectedCreativeId: "creative-1",
    contentHash: H.b,
    createdAt: ISO
  };
}

function makeScript(batch: CreativeBatch): ScriptDraft {
  return {
    id: "script-reference-image",
    projectId: batch.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: batch.productTruthRef,
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: batch.id,
      version: batch.version,
      hash: batch.contentHash
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 60000,
    beats: [
      {
        id: "beat-1",
        order: 1,
        purpose: "PRODUCT",
        text: "Feature one",
        estimatedDurationMs: 60000,
        requiredFactIds: ["fact-1"]
      }
    ],
    contentHash: H.c,
    confirmedAt: ISO
  };
}

function makePlan(script: ScriptDraft): ProductionPlan {
  const truth = makeProductTruth();
  const clip = makeValidClip();
  clip.referenceAssets = [];
  return {
    id: "plan-reference-image",
    projectId: truth.projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: script.productTruthRef,
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    selectedCreativeId: script.selectedCreativeId,
    visualDirection: "studio",
    soundDirection: "clean",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: structuredClone(truth.forbiddenChanges)
      },
      characters: [],
      environments: [
        { sceneId: "scene-1", stableElements: ["studio"] }
      ]
    },
    scenes: [
      {
        id: "scene-1",
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

test("REFERENCE_IMAGE_TOO_SMALL turns otherwise READY Preflight into BLOCKED with WorkflowBlocker", async () => {
  const generation = new MemoryGenerationRepository();
  const workflow = new MemoryWorkflowRepository();
  const service = new GenerationPreflightService(
    generation,
    workflow,
    new ReadyProvider(),
    async () => 1,
    "seedance-2.0-mini"
  );
  const truth = makeProductTruth();
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);

  const result = await service.run({
    projectId: truth.projectId,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    assets: [],
    inputBlockers: [
      "REFERENCE_IMAGE_TOO_SMALL:asset-placeholder:1x1"
    ]
  });

  assert.equal(result.overallStatus, "BLOCKED");
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0]?.status, "BLOCKED");
  assert.deepEqual(result.reports[0]?.blockers, [
    "REFERENCE_IMAGE_TOO_SMALL:asset-placeholder:1x1"
  ]);
  assert.equal(result.blocker?.scope, "PREFLIGHT");
  assert.equal(result.blocker?.reasonCode, "OTHER");
  assert.equal(
    result.blocker?.resumeCheckpoint,
    "preflight.reference-assets"
  );
  assert.equal(generation.approvals.length, 0);
  assert.equal(workflow.attempts.length, 0);
});

test("a clean Preflight rerun resolves stale reference blockers without clearing unrelated blockers", async () => {
  const generation = new MemoryGenerationRepository();
  const workflow = new MemoryWorkflowRepository();
  const service = new GenerationPreflightService(
    generation,
    workflow,
    new ReadyProvider(),
    async () => 1,
    "seedance-2.0-mini"
  );
  const truth = makeProductTruth();
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);

  const blocked = await service.run({
    projectId: truth.projectId,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    assets: [],
    inputBlockers: ["REFERENCE_IMAGE_TOO_SMALL:asset-placeholder:1x1"]
  });
  assert.equal(blocked.overallStatus, "BLOCKED");
  const staleReferenceBlocker = blocked.blocker!;

  workflow.blockers.push({
    id: "unrelated-blocker",
    projectId: truth.projectId,
    scope: "PROJECT",
    reasonCode: "ORPHAN_ARTIFACT_QUARANTINED",
    message: "Unrelated project-level recovery blocker",
    requiredUserAction: "Review quarantined artifact",
    resumeCheckpoint: "recovery.orphans",
    createdAt: ISO
  });

  const clean = await service.run({
    projectId: truth.projectId,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    assets: [],
    inputBlockers: []
  });

  assert.equal(clean.overallStatus, "PASS");
  assert.equal(clean.requests[0]?.dreaminaOperation, "text2video");
  assert.ok(staleReferenceBlocker.resolvedAt);
  const open = await workflow.listOpenBlockers(truth.projectId);
  assert.deepEqual(open.map((item) => item.id), ["unrelated-blocker"]);
});

test("a clean Preflight rerun resolves an obsolete capability blocker from an older clip duration", async () => {
  const generation = new MemoryGenerationRepository();
  const workflow = new MemoryWorkflowRepository();
  const service = new GenerationPreflightService(
    generation,
    workflow,
    new ReadyProvider(),
    async () => 1,
    "seedance-2.0-mini"
  );
  const truth = makeProductTruth();
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  workflow.blockers.push({
    id: "stale-capability-duration",
    projectId: truth.projectId,
    scope: "PREFLIGHT",
    reasonCode: "CAPABILITY_UNSUPPORTED",
    message:
      "国内官方 dreamina CLI 当前能力不满足生成要求：CAPABILITY_UNSUPPORTED:duration-5500",
    requiredUserAction: "旧版本测试阻塞",
    resumeCheckpoint: "preflight.provider-capability",
    createdAt: ISO
  });
  workflow.blockers.push({
    id: "unrelated-project-blocker",
    projectId: truth.projectId,
    scope: "PROJECT",
    reasonCode: "ORPHAN_ARTIFACT_QUARANTINED",
    message: "unrelated",
    requiredUserAction: "unrelated",
    resumeCheckpoint: "recovery.artifacts",
    createdAt: ISO
  });

  const clean = await service.run({
    projectId: truth.projectId,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    assets: [],
    inputBlockers: []
  });
  assert.equal(clean.overallStatus, "PASS");
  assert.ok(workflow.blockers.find(item => item.id === "stale-capability-duration")?.resolvedAt);
  const open = await workflow.listOpenBlockers(truth.projectId);
  assert.deepEqual(open.map(item => item.id), ["unrelated-project-blocker"]);
});

test("Preflight selects multimodal2video when the Clip has reference assets", async () => {
  const generation = new MemoryGenerationRepository();
  const workflow = new MemoryWorkflowRepository();
  const service = new GenerationPreflightService(
    generation,
    workflow,
    new ReadyProvider(),
    async () => 1,
    "seedance-2.0-mini"
  );
  const truth = makeProductTruth();
  const batch = makeBatch();
  const script = makeScript(batch);
  const plan = makePlan(script);
  plan.scenes[0]!.clips[0]!.referenceAssets = [
    {
      assetId: "asset-product",
      role: "PRIMARY_PRODUCT",
      priority: 0,
      required: true
    }
  ];

  const result = await service.run({
    projectId: truth.projectId,
    productTruth: truth,
    creativeBatch: batch,
    script,
    productionPlan: plan,
    assets: [
      {
        id: "asset-product",
        artifactId: "artifact-product",
        type: "image",
        source: "user_upload",
        originalFilename: "product.png",
        sha256: H.f,
        mimeType: "image/png",
        sizeBytes: 1024,
        createdAt: ISO
      }
    ]
  });

  assert.equal(result.overallStatus, "PASS");
  assert.equal(result.requests[0]?.assetManifest.length, 1);
  assert.equal(result.requests[0]?.dreaminaOperation, "multimodal2video");
});
