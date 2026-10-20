import { randomUUID } from "node:crypto";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type {
  ProviderProbeResult,
  CostEstimateResult,
  VideoProvider
} from "../ports/video-provider.js";
import {
  generationRequestSchema,
  preflightReportSchema,
  type AssetRef,
  type CompiledPrompt,
  type CreativeBatch,
  type GenerationRequest,
  type PreflightReport,
  type ProductTruth,
  type ProductionPlan,
  type ScriptDraft,
  type VideoModel,
  type WorkflowBlocker
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { computeGenerationRequestHash } from "./hash-contracts.js";
import { compileSeedancePrompt } from "./prompt-compiler.js";
import { assertNamedImageAspectRatio } from "./asset-image-bindings.js";
import { firstSourceIndependentClipIds } from "./clip-continuity-engine.js";
import { compileReviewedContinuityInput, type SourceBinding } from "./continuity-request-compiler.js";
import { blockerFromProviderProbe } from "./provider-blocker.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { UsageComplianceService } from "./usage-compliance.js";
import {assertReferenceBinding,type CreativeReferenceGuard} from "./creative-reference-binding.js";
import {CreativeReferenceService} from "./creative-reference-service.js";
import {
  assertDirectorPlanTarget,
  assertDirectorSettingsMatch,
  assertProfileMatchesDirectorTarget,
  assertReviewedFirstFrameProfileMatchesDirectorTarget,
  standardClipOperation
} from "./director-generation-target.js";
import {
  resolveGenerationProfile,
  type DreaminaAgentCapabilityService
} from "./dreamina-agent-capability.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { SmartGenerationRun } from "../../domain/smart-generation.js";
import { assertV8PromptBinding } from "./v8-production-binding.js";
import type { DirectorV3Plan } from "../../domain/director-v3.js";

export type RunPreflightInput = {
  projectId: string;
  productTruth: ProductTruth;
  creativeBatch: CreativeBatch;
  script: ScriptDraft;
  productionPlan: ProductionPlan;
  productionAssetSet?: ProductionAssetSet;
  directorV3Plan?: DirectorV3Plan;
  promptV3Overrides?: Record<string, string>;
  v8Run?: SmartGenerationRun;
  /** Only the adapter may supply latest, explicitly accepted, immutable tail evidence. */
  continuitySources?: Record<string, SourceBinding>;
  assets: AssetRef[];
  clipIds?: string[];
  inputBlockers?: string[];
  acceptedDuplicateSubmissionRisk?: boolean;
  generationSettings?: {
    requestedModelVersion: string;
    aspectRatio: string;
    videoResolution: string;
    nativeAudioOutputRequested: boolean;
  };
};

export type RunPreflightResult = {
  probe: ProviderProbeResult;
  requests: GenerationRequest[];
  reports: PreflightReport[];
  blocker: WorkflowBlocker | null;
  authenticated: boolean | "UNKNOWN";
  costEstimate: PreflightReport["costEstimate"];
  overallStatus: "PASS" | "BLOCKED";
};

function clipRequestsNativeAudio(
  clip: ProductionPlan["scenes"][number]["clips"][number],
  globallyRequested: boolean,
  nativeByDefault = false
): boolean {
  if (!globallyRequested) return false;
  if (nativeByDefault) return true;
  return clip.segments.some(
    (segment) =>
      segment.dialogueOrNarration.kind !== "NONE" ||
      segment.ambientSound.kind !== "NONE"
  );
}

function reportHash(
  report: Omit<PreflightReport, "reportHash">
): string {
  return hashValue(report);
}

function providerBlockers(
  probe: ProviderProbeResult,
  model: VideoModel,
  durationMs: number,
  profileValidated = false
): string[] {
  if (probe.code === "DREAMINA_NOT_FOUND") {
    return ["DREAMINA_NOT_FOUND"];
  }
  if (probe.code === "PROVIDER_IDENTITY_UNVERIFIED") {
    return ["PROVIDER_IDENTITY_UNVERIFIED"];
  }

  const blockers: string[] = [];
  if (!probe.supportedOperations.includes("submit")) {
    blockers.push("CAPABILITY_UNSUPPORTED:submit");
  }
  if (!probe.supportedOperations.includes("status")) {
    blockers.push("CAPABILITY_UNSUPPORTED:status");
  }
  if (!probe.supportedOperations.includes("download")) {
    blockers.push("CAPABILITY_UNSUPPORTED:download");
  }
  if (!profileValidated) {
    if (!probe.supportedModels.includes(model)) {
      blockers.push(`CAPABILITY_UNSUPPORTED:${model}`);
    }
    if (!probe.supportedDurationsMs) {
      blockers.push("CAPABILITY_UNSUPPORTED:duration-unknown");
    } else if (!probe.supportedDurationsMs.includes(durationMs)) {
      blockers.push(`CAPABILITY_UNSUPPORTED:duration-${durationMs}`);
    }
  }
  return blockers;
}

function syntheticInputBlocker(
  projectId: string,
  blockerCode: string,
  now: Date
): WorkflowBlocker {
  return {
    id: randomUUID(),
    projectId,
    scope: "PREFLIGHT",
    reasonCode: "OTHER",
    message: `参考素材不满足生成前置条件：${blockerCode}`,
    requiredUserAction:
      "替换为正常尺寸、可解码且完整的真实产品参考图，然后重新运行 Preflight。",
    resumeCheckpoint: "preflight.reference-assets",
    createdAt: now.toISOString()
  };
}

function syntheticCapabilityBlocker(
  projectId: string,
  blockerCode: string,
  now: Date
): WorkflowBlocker {
  return {
    id: randomUUID(),
    projectId,
    scope: "PREFLIGHT",
    reasonCode: "CAPABILITY_UNSUPPORTED",
    message: `国内官方 dreamina CLI 当前能力不满足生成要求：${blockerCode}`,
    requiredUserAction:
      "核验官方 CLI help/capability，确认 Seedance 2.0、submit/status/download 和当前 Clip 时长均被支持。",
    resumeCheckpoint: "preflight.provider-capability",
    createdAt: now.toISOString()
  };
}

export class GenerationPreflightService {
  private readonly usageCompliance?: UsageComplianceService;

  constructor(
    private readonly generationRepo: GenerationRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly provider: VideoProvider,
    private readonly nextCompiledPromptVersion: (
      projectId: string,
      entityKey: string
    ) => Promise<number>,
    private readonly targetModel: VideoModel = "seedance-2.0",
    usageComplianceRuntime?: StructuredAiRuntime,
    private readonly dreaminaCapability?: DreaminaAgentCapabilityService,
    private readonly references?: CreativeReferenceGuard
  ) {
    this.usageCompliance = usageComplianceRuntime
      ? new UsageComplianceService(usageComplianceRuntime)
      : undefined;
  }

  private async persistBlockerOnce(
    projectId: string,
    blocker: WorkflowBlocker | null
  ): Promise<WorkflowBlocker | null> {
    if (!blocker) return null;
    const open = await this.workflowRepo.listOpenBlockers(projectId);
    const existing = open.find(
      (item) =>
        item.scope === blocker.scope &&
        item.reasonCode === blocker.reasonCode &&
        item.resumeCheckpoint === blocker.resumeCheckpoint
    );
    if (existing) return existing;
    return this.workflowRepo.createBlocker(blocker);
  }

  private async reconcileReferenceAssetBlockers(
    projectId: string,
    activeBlockerCodes: readonly string[],
    resolvedAt: string
  ): Promise<void> {
    const activeReferenceBlockers = activeBlockerCodes.filter((code) =>
      code.startsWith("REFERENCE_")
    );
    const open = await this.workflowRepo.listOpenBlockers(projectId);

    for (const item of open) {
      if (
        item.scope !== "PREFLIGHT" ||
        item.resumeCheckpoint !== "preflight.reference-assets"
      ) {
        continue;
      }

      const stillActive = activeReferenceBlockers.some((code) =>
        item.message.includes(code)
      );
      if (!stillActive) {
        await this.workflowRepo.resolveBlocker(item.id, resolvedAt);
      }
    }
  }

  private async reconcileCapabilityBlockers(
    projectId: string,
    activeBlockerCodes: readonly string[],
    resolvedAt: string
  ): Promise<void> {
    const activeCapabilityBlockers = activeBlockerCodes.filter(
      code => !code.startsWith("REFERENCE_")
    );
    const open = await this.workflowRepo.listOpenBlockers(projectId);
    for (const item of open) {
      if (
        item.scope !== "PREFLIGHT" ||
        item.resumeCheckpoint !== "preflight.provider-capability"
      ) {
        continue;
      }
      const stillActive = activeCapabilityBlockers.some(code =>
        item.message.includes(code)
      );
      if (!stillActive) {
        await this.workflowRepo.resolveBlocker(item.id, resolvedAt);
      }
    }
  }

  async run(input: RunPreflightInput): Promise<RunPreflightResult> {
    if (input.v8Run) assertV8PromptBinding(input.v8Run);
    if ((input.productionPlan.v8Source || input.productionPlan.scenes.some(s => s.clips.some(c => c.segments.some(s => s.v8)))) && !input.v8Run) {
      throw new DomainValidationError("V8 正式分镜需要当前任务中明确采用的 PromptPackage，不能绕过人工审核直接预检");
    }
    const references=await this.references?.assertExpected(input.projectId,input.productionPlan.creativeReferenceSetRef);
    for(const artifact of [input.creativeBatch,input.script,input.productionPlan])assertReferenceBinding(artifact.creativeReferenceSetRef,references,input.productTruth);
    if(references)input={...input,assets:[...input.assets.filter(a=>!a.id.startsWith("research-ref-")),...CreativeReferenceService.assets(references)]};
    const now = new Date();
    const directorTarget = input.productionPlan.generationTarget;
    if (directorTarget) {
      assertDirectorPlanTarget(input.productionPlan);
      if (input.generationSettings) assertDirectorSettingsMatch(directorTarget, input.generationSettings);
      else input = { ...input, generationSettings: {
        requestedModelVersion: directorTarget.requestedModelVersion,
        aspectRatio: directorTarget.aspectRatio,
        videoResolution: directorTarget.videoResolution,
        nativeAudioOutputRequested: directorTarget.nativeAudioOutputRequested
      } };
    }
    const allClips = input.productionPlan.scenes.flatMap(scene => scene.clips);
    const requestedClipIds = input.clipIds?.length ? new Set(input.clipIds) : null;
    const clips = requestedClipIds
      ? allClips.filter(clip => requestedClipIds.has(clip.id))
      : allClips;
    if (!clips.length) throw new DomainValidationError("请至少选择一个有效的当前镜头");
    if (requestedClipIds && clips.length !== requestedClipIds.size) {
      throw new DomainValidationError("所选镜头已失效，请刷新页面后重新选择");
    }

    if (input.v8Run?.v8Prompts?.imageBindingMode === "V1") {
      const firstWave = new Set(firstSourceIndependentClipIds(input.v8Run.v8Prompts.packages));
      for (const clip of clips) {
        const incoming = input.v8Run.v8Prompts.packages.find(p=>p.clipId===clip.id)?.incomingContinuity;
        const source = input.continuitySources?.[clip.id];
        if (!firstWave.has(clip.id)) {
          if (!incoming || !source || source.sourceClipId!==incoming.sourceClipId ||
              source.contractHash!==incoming.contractHash ||
              source.relationship!==incoming.relationship) {
            throw new DomainValidationError("后续视频缺少来自已审核真实尾帧的有效来源与转场契约，不能生成。");
          }
        } else if (source) {
          throw new DomainValidationError("独立镜头不能伪造上一视频的尾帧来源。");
        }
      }
      if (Object.keys(input.continuitySources??{}).some(id=>!clips.some(c=>c.id===id))) {
        throw new DomainValidationError("连续性凭据包含不属于本批次的镜头。");
      }
    }
    const existingAttempts = await this.workflowRepo.listGenerationAttempts(
      input.projectId
    );
    const hasUnknownSubmission = existingAttempts.some(
      (item) =>
        clips.some(clip => clip.id === item.clipId) &&
        (item.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
          item.status === "RECONCILING")
    );
    if (
      hasUnknownSubmission &&
      input.acceptedDuplicateSubmissionRisk !== true
    ) {
      throw new DomainValidationError(
        "Unresolved submission outcome requires explicit duplicate-submission cost-risk acceptance before creating a new Preflight chain"
      );
    }

    if (this.usageCompliance) {
      await this.usageCompliance.assertPlan(
        input.productTruth,
        input.productionPlan
      );
    }

    // Check the full replacement before mutating any previous approval or
    // submitted request. One invalid reference must not stale all clips.
    const probe = await this.provider.probe();

    const requests: GenerationRequest[] = [];
    const compiledPrompts: CompiledPrompt[] = [];
    let capabilityRegistry;
    if (input.generationSettings && probe.code === "READY") {
      if (!this.dreaminaCapability) {
        throw new DomainValidationError(
          "标准生成尚未接入 DreaminaCapabilityRegistry，不能验证用户选择的模型/画幅/分辨率"
        );
      }
      capabilityRegistry = await this.dreaminaCapability.registry();
      if (directorTarget && capabilityRegistry.registryFingerprint !== directorTarget.registryFingerprint) {
        throw new DomainValidationError("Dreamina 能力表已变化，旧生成请求和授权已失效；请返回导演分镜重新适配并审核");
      }
    }
    if (directorTarget && !capabilityRegistry) {
      throw new DomainValidationError("当前无法验证导演目标的实时模型能力，已阻止回退到旧生成参数；请恢复即梦连接后重试");
    }

    for (const clip of clips) {
      const continuitySource = input.continuitySources?.[clip.id];
      const dreaminaOperation = continuitySource?.relationship==="HARD_CONTINUITY"
        ? "image2video" as const : standardClipOperation(clip.referenceAssets.length);
      const nativeAudioOutputRequested = clipRequestsNativeAudio(
        clip,
        input.generationSettings?.nativeAudioOutputRequested ?? false,
        Boolean(input.directorV3Plan)
      );
      const referenceAudioInputCount = clip.referenceAssets.filter((usage) => {
        const asset = input.assets.find((item) => item.id === usage.assetId);
        return asset?.mimeType?.startsWith("audio/") === true;
      }).length;
      const generationProfile =
        input.generationSettings && capabilityRegistry
          ? resolveGenerationProfile(capabilityRegistry, {
              operation: dreaminaOperation,
              requestedModelVersion:
                input.generationSettings.requestedModelVersion,
              aspectRatio: input.generationSettings.aspectRatio,
              videoResolution: input.generationSettings.videoResolution,
              durationMs: clip.durationMs,
              referenceAudioInputCount,
              nativeAudioOutputRequested
            })
          : undefined;
      if (directorTarget && generationProfile) {
        if (continuitySource?.relationship === "HARD_CONTINUITY") {
          assertReviewedFirstFrameProfileMatchesDirectorTarget(directorTarget, generationProfile);
        } else assertProfileMatchesDirectorTarget(directorTarget, generationProfile);
      }
      const requestModel =
        generationProfile?.modelVersion ??
        (input.generationSettings &&
        input.generationSettings.requestedModelVersion !== "AUTO" &&
        input.generationSettings.requestedModelVersion !== "FIXED"
          ? input.generationSettings.requestedModelVersion
          : this.targetModel);
      const requestAspectRatio =
        generationProfile?.aspectRatio ??
        input.generationSettings?.aspectRatio ??
        "9:16";
      const requestVideoResolution =
        generationProfile?.videoResolution ??
        input.generationSettings?.videoResolution;
      const requestGenerateAudio = generationProfile
        ? generationProfile.nativeAudioOutputRequested
        : undefined;
      const version = await this.nextCompiledPromptVersion(
        input.projectId,
        `compiled-prompt:${clip.id}`
      );
      let compiled: CompiledPrompt;
      try {
        compiled = compileSeedancePrompt({
        ...(input.v8Run ? { v8Run: input.v8Run } : {}),
        creativeReferenceSet: references,
        ...(input.productionAssetSet
          ? { productionAssetSet: input.productionAssetSet }
          : {}),
        ...(input.directorV3Plan
          ? { directorV3Plan: input.directorV3Plan }
          : {}),
        ...(input.promptV3Overrides?.[clip.id]
          ? {
              promptV3Override:
                input.promptV3Overrides[clip.id]
            }
          : {}),
        id: randomUUID(),
        version,
        createdAt: now.toISOString(),
        productTruth: input.productTruth,
        creativeBatch: input.creativeBatch,
        script: input.script,
        productionPlan: input.productionPlan,
        clipId: clip.id,
        model: requestModel,
        dreaminaOperation,
        ...(generationProfile ? { generationProfile } : {}),
        aspectRatio: requestAspectRatio,
        ...(requestVideoResolution
          ? { videoResolution: requestVideoResolution }
          : {}),
        ...(requestGenerateAudio !== undefined
          ? { generateAudio: requestGenerateAudio }
          : {}),
        assets: input.assets
        });
      } catch (error) {
        if (error instanceof Error && /Required reference asset missing|production-asset:/i.test(error.message)) {
          throw new DomainValidationError("当前镜头缺少已确认的角色、场景或产品参考图。请检查制作资产绑定后重新预检；原视频和授权未发生变化。");
        }
        throw error;
      }
      if (compiled.imageBindings?.length) {
        assertNamedImageAspectRatio({
          promptText: compiled.promptText,
          requestedRatio: requestAspectRatio,
          aspectRatioMode: generationProfile?.aspectRatioMode
        });
      }
      if (continuitySource) {
        compiled=compileReviewedContinuityInput({compiled,source:continuitySource});
        if (compiled.imageBindings?.length) {
          assertNamedImageAspectRatio({promptText:compiled.promptText,requestedRatio:requestAspectRatio,
            aspectRatioMode:generationProfile?.aspectRatioMode});
        }
      }
      compiledPrompts.push(compiled);

      const requestWithoutHash = {
        id: randomUUID(),
        projectId: input.projectId,
        clipId: clip.id,
        compiledPromptId: compiled.id,
        compiledPromptHash: compiled.compiledPromptHash,
        provider: "domestic-jimeng-cli" as const,
        providerIdentityHash: probe.providerIdentityHash,
        capabilityFingerprint: probe.capabilityFingerprint,
        model: requestModel,
        promptText: compiled.promptText,
        ...(compiled.imageBindings ? { imageBindings: compiled.imageBindings } : {}),
        ...(compiled.continuitySource ? {continuitySource:compiled.continuitySource} : {}),
        ...(compiled.v8Binding ? { v8Binding: compiled.v8Binding } : {}),
        assetManifest: compiled.inputAssetManifest,
        dreaminaOperation,
        durationMs: compiled.generationParams.durationMs,
        aspectRatio: requestAspectRatio,
        ...(requestVideoResolution
          ? { videoResolution: requestVideoResolution }
          : {}),
        generateAudio: compiled.generationParams.generateAudio,
        ...(compiled.audioPolicy
          ? { audioPolicy: compiled.audioPolicy }
          : {}),
        ...(generationProfile ? { generationProfile } : {}),
        inputVersionRefs: [
          compiled.productTruthRef,
          compiled.creativeBatchRef,
          compiled.scriptRef,
          compiled.productionPlanRef,
          ...(compiled.creativeReferenceSetRef?[compiled.creativeReferenceSetRef]:[]),
          ...(compiled.productionAssetSetRef?[compiled.productionAssetSetRef]:[])
        ],
        createdAt: now.toISOString()
      };
      const request = generationRequestSchema.parse({
        ...requestWithoutHash,
        requestHash: computeGenerationRequestHash(requestWithoutHash)
      });
      requests.push(request);
    }

    let costEstimate: PreflightReport["costEstimate"] = {
      status: "UNKNOWN",
      observedAt: now.toISOString()
    };
    let authenticated: boolean | "UNKNOWN" = "UNKNOWN";
    const requestCosts = new Map<string, PreflightReport["costEstimate"]>();
    if (probe.code === "READY") {
      const [account, estimates] = await Promise.all([
        this.provider.accountStatus(),
        probe.supportedOperations.includes("estimate")
          ? Promise.all(requests.map(request => this.provider.estimate([request])))
          : Promise.resolve(requests.map((): CostEstimateResult => ({ status: "UNKNOWN" })))
      ]);
      authenticated =
        account.status === "AUTHENTICATED"
          ? true
          : account.status === "NOT_AUTHENTICATED"
            ? false
            : "UNKNOWN";
      estimates.forEach((estimate, n) => requestCosts.set(requests[n]!.id, { ...estimate, observedAt: now.toISOString() }));
      // A batch total must never be copied into each individual clip's report.
      if (estimates.length && estimates.every(e => e.status === "KNOWN" && e.estimatedCredits !== undefined))
        costEstimate = { status: "KNOWN", estimatedCredits: estimates.reduce((sum, e) => sum + e.estimatedCredits!, 0), observedAt: now.toISOString() };
    }

    const reports: PreflightReport[] = [];
    let firstBlocker: WorkflowBlocker | null = blockerFromProviderProbe(
      input.projectId,
      probe,
      now
    );

    for (const request of requests) {
      const requestCost = requestCosts.get(request.id) ?? { status: "UNKNOWN" as const, observedAt: now.toISOString() };
      const clip = clips.find((item) => item.id === request.clipId)!;
      const blockers = [
        ...(input.inputBlockers ?? []),
        ...providerBlockers(
          probe,
          request.model,
          request.durationMs,
          Boolean(request.generationProfile)
        )
      ];
      if (probe.code === "READY" && authenticated !== true) {
        blockers.push(
          authenticated === false
            ? "AUTHENTICATION_REQUIRED"
            : "AUTHENTICATION_REQUIRED:unknown"
        );
      }
      const status = blockers.length ? "BLOCKED" : "PASS";
      const warnings =
        requestCost.status === "UNKNOWN" ? ["COST_ESTIMATE_UNKNOWN"] : [];
      const base = {
        id: randomUUID(),
        projectId: input.projectId,
        generationRequestId: request.id,
        requestHash: request.requestHash,
        status: status as "PASS" | "BLOCKED",
        providerIdentityHash: request.providerIdentityHash,
        capabilityFingerprint: request.capabilityFingerprint,
        clipCount: 1,
        totalGeneratedMs: request.durationMs,
        highRiskClipIds:
          clip.riskAssessment.level === "HIGH" ? [clip.id] : [],
        costEstimate: requestCost,
        blockers,
        warnings,
        createdAt: now.toISOString()
      };
      const report = preflightReportSchema.parse({
        ...base,
        reportHash: reportHash(base)
      });
      reports.push(report);

      if (!firstBlocker && blockers.length) {
        firstBlocker = blockers[0]!.startsWith("REFERENCE_")
          ? syntheticInputBlocker(
              input.projectId,
              blockers[0]!,
              now
            )
          : syntheticCapabilityBlocker(
              input.projectId,
              blockers[0]!,
              now
            );
      }
    }

    // Blocked checks are returned to the user for diagnostics only. They do
    // not create a current request or invalidate a successful prior chain.
    if (reports.every(report => report.status === "PASS")) {
      if (this.generationRepo.replacePreflightChain) {
        await this.generationRepo.replacePreflightChain({
          projectId: input.projectId,
          clipIds: clips.map(clip => clip.id),
          staleAt: now.toISOString(),
          compiledPrompts,
          requests,
          reports
        });
      } else {
        // Legacy/in-memory test repositories. Production uses the atomic
        // implementation, which also protects against partial DB writes.
        const old = await this.generationRepo.listCurrentGenerationRequests(input.projectId);
        for (const request of old.filter(item => clips.some(clip => clip.id === item.clipId))) {
          await this.generationRepo.markRequestChainStale(request.id, now.toISOString());
        }
        for (const prompt of compiledPrompts) await this.generationRepo.saveCompiledPrompt(prompt);
        for (const request of requests) await this.generationRepo.createGenerationRequest(request);
        for (const report of reports) await this.generationRepo.createPreflightReport(report);
      }
    }
    if (probe.code === "READY") {
      const open = await this.workflowRepo.listOpenBlockers(input.projectId);
      for (const item of open) {
        if (
          item.scope === "PROVIDER" &&
          (item.reasonCode === "DREAMINA_NOT_FOUND" ||
            item.reasonCode === "PROVIDER_IDENTITY_UNVERIFIED" ||
            item.reasonCode === "PROVIDER_CHANGED")
        ) {
          await this.workflowRepo.resolveBlocker(item.id, now.toISOString());
        }
      }
    }
    await this.reconcileReferenceAssetBlockers(
      input.projectId,
      input.inputBlockers ?? [],
      now.toISOString()
    );
    await this.reconcileCapabilityBlockers(
      input.projectId,
      reports.flatMap(item => item.blockers),
      now.toISOString()
    );

    const blocker = await this.persistBlockerOnce(
      input.projectId,
      firstBlocker
    );

    return {
      probe,
      requests,
      reports,
      blocker,
      authenticated,
      costEstimate,
      overallStatus: reports.every((item) => item.status === "PASS")
        ? "PASS"
        : "BLOCKED"
    };
  }
}
