import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentMaterial,
  AgentTask,
  AgentTaskPlan,
  AgentTaskRepository
} from "../ports/agent-task-repository.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { FinalOutputRepository } from "../ports/final-output-repository.js";
import type { DomesticJimengCliProvider } from "../../adapters/video/domestic-jimeng-cli-provider.js";
import {
  generationRequestSchema,
  preflightReportSchema,
  type DreaminaVideoOperation,
  type GenerationAttempt,
  type GenerationRequest
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { computeGenerationRequestHash } from "./hash-contracts.js";
import { DomainValidationError } from "../../domain/validation.js";
import { ApprovalService } from "./approval-service.js";
import { GenerationExecutionService } from "./generation-execution.js";
import type { ProductFlowService } from "./product-flow.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import {
  DreaminaAgentCapabilityService,
  resolveGenerationProfile,
  toDreaminaCliModel
} from "./dreamina-agent-capability.js";
import {
  adaptAgentReferenceMaterials,
  type AgentReferenceLimits
} from "./agent-reference-adaptation.js";

import { buildAssetImageBindings, assertNamedImageAspectRatio } from "./asset-image-bindings.js";

const operationLabel: Record<DreaminaVideoOperation, string> = {
  text2video: "文生视频",
  image2video: "图生视频",
  frames2video: "首尾帧视频",
  multiframe2video: "多图故事视频",
  multimodal2video: "全能参考视频"
};

function summary(materials: AgentMaterial[]) {
  return {
    images: materials.filter((item) => item.type === "image").length,
    videos: materials.filter((item) => item.type === "video").length,
    audios: materials.filter((item) => item.type === "audio").length,
    logos: materials.filter((item) => item.type === "logo").length
  };
}

export function selectAgentOperation(
  task: Pick<
    AgentTask,
    "requestedMethod" | "requestText" | "materials"
  > & {
    model?: string;
    nativeAudioOutputRequested?: boolean;
  }
): {
  operation: DreaminaVideoOperation;
  reason: string;
} {
  if (task.requestedMethod !== "AUTO") {
    return {
      operation: task.requestedMethod,
      reason: "你已手动指定生成方式。"
    };
  }
  const counts = summary(task.materials);
  const imageLike = counts.images + counts.logos;
  const nativeAudioRequired =
    task.nativeAudioOutputRequested === true;
  if (counts.videos > 0 || counts.audios > 0) {
    return {
      operation: "multimodal2video",
      reason: "检测到视频或音频参考，自动选择“全能参考视频”。"
    };
  }
  if (imageLike === 0) {
    return {
      operation: "text2video",
      reason: "没有图片/视频/音频素材，自动选择“文生视频”。"
    };
  }
  if (nativeAudioRequired) {
    return {
      operation: "multimodal2video",
      reason:
        "已要求模型原生声音；多图/单图素材统一走已验证会返回音轨的“全能参考视频”，避免静音的多图固定模型链。"
    };
  }
  if (imageLike === 1) {
    return {
      operation: "image2video",
      reason: "检测到 1 张图片，自动选择“图生视频”。"
    };
  }
  if (
    imageLike === 2 &&
    /(首尾|首帧|尾帧|first\s*frame|last\s*frame)/i.test(task.requestText)
  ) {
    return {
      operation: "frames2video",
      reason: "检测到 2 张图片且要求中包含首尾帧语义，自动选择“首尾帧视频”。"
    };
  }
  if ((task.model ?? "AUTO").trim().toUpperCase() !== "AUTO") {
    return {
      operation: "multimodal2video",
      reason:
        "检测到多张图片且你已明确选择模型，为保证模型不被固定命令替换，自动选择“全能参考视频”。"
    };
  }
  return {
    operation: "multiframe2video",
    reason: "检测到多张图片且模型选择为自动，使用“多图故事视频（固定模型）”。"
  };
}

function mediaInputType(type: AgentMaterial["type"]): "image" | "video" | "audio" {
  return type === "video" ? "video" : type === "audio" ? "audio" : "image";
}

export class AgentModeService {
  constructor(
    private readonly tasks: AgentTaskRepository,
    private readonly generation: GenerationRepository,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly provider: DomesticJimengCliProvider,
    private readonly approval: ApprovalService,
    private readonly execution: GenerationExecutionService,
    private readonly capability: DreaminaAgentCapabilityService,
    private readonly finalOutput: FinalOutputRepository,
    private readonly productFlow: ProductFlowService,
    private readonly projectsRoot: string
  ) {}

  async createTask(input: {
    projectId: string;
    skillId?: string;
    requestText: string;
    requestedMethod: AgentTask["requestedMethod"];
    model: string;
    durationMs: number;
    materials: AgentMaterial[];
    aspectRatio?: string;
    videoResolution?: string;
    nativeAudioOutputRequested?: boolean;
  }): Promise<AgentTask> {
    if ((input.skillId ?? "dreamina-cli") !== "dreamina-cli") {
      throw new DomainValidationError("当前 P1-03 只开放 Dreamina 官方 Skill");
    }
    if (!input.requestText.trim()) {
      throw new DomainValidationError("请先说明“我要做什么”");
    }
    if (!input.model.trim()) {
      throw new DomainValidationError("请选择视频模型或“自动模型”");
    }
    if (
      !Number.isInteger(input.durationMs) ||
      input.durationMs < 2000 ||
      input.durationMs > 120000
    ) {
      throw new DomainValidationError(
        "Agent 目标时长必须为 2–120 秒；实际可用范围会再按当前 Dreamina CLI help 校验"
      );
    }
    const now = new Date().toISOString();
    return this.tasks.create({
      id: randomUUID(),
      projectId: input.projectId,
      skillId: "dreamina-cli",
      status: "DRAFT",
      requestText: input.requestText.trim(),
      requestedMethod: input.requestedMethod,
      model: input.model.trim(),
      durationMs: input.durationMs,
      aspectRatio: input.aspectRatio?.trim() || "9:16",
      videoResolution: input.videoResolution ?? "720p",
      nativeAudioOutputRequested:
        input.nativeAudioOutputRequested === true,
      materials: input.materials,
      createdAt: now,
      updatedAt: now
    });
  }

  async replaceTaskMaterials(input: {
    taskId: string;
    materials: AgentMaterial[];
  }): Promise<AgentTask> {
    const task = await this.requireTask(input.taskId);
    if (
      task.status !== "DRAFT" &&
      task.status !== "NEEDS_MATERIAL" &&
      task.status !== "READY_TO_CONFIRM"
    ) {
      throw new DomainValidationError(
        "当前任务已经进入生成确认或提交阶段，不能再修改素材；请新建任务或使用“重新生成”"
      );
    }
    if (input.materials.filter((item) => item.type === "logo").length > 1) {
      throw new DomainValidationError("每个智能生成任务只能保留 1 个 Logo");
    }
    const artifactById = new Map(
      (await this.artifacts.listByProject(task.projectId)).map((item) => [
        item.id,
        item
      ])
    );
    const seenHashes = new Set<string>();
    const materials = input.materials.map((material, index) => {
      const artifact = artifactById.get(material.artifactId);
      if (
        !artifact ||
        artifact.projectId !== task.projectId ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256 ||
        artifact.sha256 !== material.sha256
      ) {
        throw new DomainValidationError(
          "任务素材不可用或完整性校验失败：" + material.originalFilename
        );
      }
      const duplicateKey = material.type + ":" + material.sha256;
      if (seenHashes.has(duplicateKey)) {
        throw new DomainValidationError(
          "任务素材重复：" + material.originalFilename
        );
      }
      seenHashes.add(duplicateKey);
      return {
        ...material,
        priority: index
      };
    });
    const staleAt = new Date().toISOString();
    if (task.generationRequestId) {
      await this.generation.markRequestChainStale(
        task.generationRequestId,
        staleAt
      );
    }
    const reset = await this.tasks.update(task.id, {
      status: "DRAFT",
      materials,
      selectedOperation: null,
      plan: null,
      generationRequestId: null,
      generationAttemptId: null,
      outputArtifactId: null,
      acceptedAt: null
    });
    return this.planTask(reset.id);
  }

  async planTask(taskId: string): Promise<AgentTask> {
    const task = await this.requireTask(taskId);
    if (
      task.status !== "DRAFT" &&
      task.status !== "NEEDS_MATERIAL"
    ) {
      return task;
    }
    const selected = selectAgentOperation(task);
    const registry = await this.capability.registry();
    const originalCounts = summary(task.materials);
    const operationCapability = registry.operations.find(
      (item) => item.operation === selected.operation
    );
    if (!operationCapability) {
      throw new DomainValidationError(
        "Dreamina Registry 缺少命令 " + selected.operation
      );
    }
    const missing: string[] = [];
    const warnings: string[] = [];
    let generationProfile;
    try {
      generationProfile = resolveGenerationProfile(registry, {
        operation: selected.operation,
        requestedModelVersion: task.model,
        aspectRatio: task.aspectRatio,
        videoResolution: task.videoResolution,
        durationMs: task.durationMs,
        referenceAudioInputCount: originalCounts.audios,
        nativeAudioOutputRequested: task.nativeAudioOutputRequested
      });
    } catch (error) {
      missing.push(error instanceof Error ? error.message : String(error));
    }
    if (generationProfile) {
      try {
        assertNamedImageAspectRatio({
          promptText: task.requestText,
          requestedRatio: task.aspectRatio,
          aspectRatioMode: generationProfile.aspectRatioMode
        });
      } catch (error) {
        missing.push(error instanceof Error ? error.message : String(error));
      }
    }
    const modelCapability = generationProfile?.modelVersion
      ? operationCapability.models.find(
          (item) => item.modelVersion === generationProfile!.modelVersion
        )
      : undefined;
    const maxImages = modelCapability?.maxImages ?? operationCapability.maxImages;
    const maxVideos = modelCapability?.maxVideos ?? operationCapability.maxVideos;
    const maxAudio = modelCapability?.maxAudio ?? operationCapability.maxAudio;
    const maxTotalInputs =
      modelCapability?.maxTotalInputs ?? operationCapability.maxTotalInputs;
    const inputMediaMinSeconds =
      modelCapability?.inputMediaMinSeconds ??
      operationCapability.inputMediaMinSeconds;
    const inputMediaMaxSeconds =
      modelCapability?.inputMediaMaxSeconds ??
      operationCapability.inputMediaMaxSeconds;

    const adaptationLimits: AgentReferenceLimits = {
      ...(inputMediaMaxSeconds !== undefined
        ? { inputMediaMaxSeconds }
        : {}),
      ...(maxImages !== undefined ? { maxImages } : {}),
      ...(maxVideos !== undefined ? { maxVideos } : {}),
      ...(maxAudio !== undefined ? { maxAudio } : {}),
      ...(maxTotalInputs !== undefined ? { maxTotalInputs } : {})
    };
    const adapted =
      selected.operation === "multimodal2video"
        ? await adaptAgentReferenceMaterials({
            projectId: task.projectId,
            materials: task.materials,
            artifacts: this.artifacts,
            projectsRoot: this.projectsRoot,
            limits: adaptationLimits
          })
        : {
            materials: task.materials,
            adaptations: [],
            warnings: [],
            missingRequirements: []
          };
    const effectiveMaterials = adapted.materials;
    const counts = summary(effectiveMaterials);
    const imageLike = counts.images + counts.logos;
    const totalInputs = imageLike + counts.videos + counts.audios;
    missing.push(...adapted.missingRequirements);
    warnings.push(...adapted.warnings);

    if (selected.operation === "image2video" && imageLike < 1) {
      missing.push("图生视频至少需要 1 张图片。");
    }
    if (selected.operation === "frames2video" && imageLike < 2) {
      missing.push("首尾帧视频需要至少 2 张图片（第一张作为首帧，第二张作为尾帧）。");
    }
    if (selected.operation === "multiframe2video" && imageLike < 2) {
      missing.push("多图故事视频至少需要 2 张图片。");
    }
    if (
      selected.operation === "multimodal2video" &&
      generationProfile?.modelVersion !== "seedance2.5" &&
      imageLike + counts.videos < 1
    ) {
      missing.push("当前 Seedance 2.0 family 全能参考至少需要 1 张图片或 1 个视频；不能只提供音频。");
    }
    if (maxImages !== undefined && imageLike > maxImages) {
      missing.push("图片数量超过当前模型/命令上限 " + maxImages + "。");
    }
    if (maxVideos !== undefined && counts.videos > maxVideos) {
      missing.push("视频数量超过当前模型/命令上限 " + maxVideos + "。");
    }
    if (maxAudio !== undefined && counts.audios > maxAudio) {
      missing.push("音频数量超过当前模型/命令上限 " + maxAudio + "。");
    }
    if (maxTotalInputs !== undefined && totalInputs > maxTotalInputs) {
      missing.push("总参考素材数量超过当前模型/命令上限 " + maxTotalInputs + "。");
    }
    if (
      selected.operation === "multimodal2video" &&
      (counts.videos > 0 || counts.audios > 0)
    ) {
      const media = effectiveMaterials.filter(
        (item) => item.type === "video" || item.type === "audio"
      );
      const unreadable = media.filter((item) => item.durationMs === undefined);
      if (unreadable.length) {
        missing.push(
          "无法读取以下视频/音频时长，不能在付费提交前完成 CLI 时长校验：" +
            unreadable.map((item) => item.originalFilename).join("、")
        );
      } else if (
        inputMediaMinSeconds !== undefined ||
        inputMediaMaxSeconds !== undefined
      ) {
        for (const item of media) {
          const seconds = item.durationMs! / 1000;
          if (
            inputMediaMinSeconds !== undefined &&
            seconds < inputMediaMinSeconds
          ) {
            missing.push(
              item.originalFilename +
                " 时长低于当前模型参考素材最低值 " +
                inputMediaMinSeconds +
                " 秒。"
            );
          }
          if (
            inputMediaMaxSeconds !== undefined &&
            seconds > inputMediaMaxSeconds
          ) {
            missing.push(
              item.originalFilename +
                " 时长超过当前模型参考素材最高值 " +
                inputMediaMaxSeconds +
                " 秒。"
            );
          }
        }
        const totalMediaSeconds =
          media.reduce((sum, item) => sum + item.durationMs!, 0) / 1000;
        if (
          inputMediaMaxSeconds !== undefined &&
          totalMediaSeconds > inputMediaMaxSeconds
        ) {
          missing.push(
            "视频/音频参考总时长 " +
              totalMediaSeconds.toFixed(1) +
              " 秒，超过当前模型总时长上限 " +
              inputMediaMaxSeconds +
              " 秒。"
          );
        }
      }
    }

    const seconds = task.durationMs / 1000;
    if (selected.operation === "multiframe2video" && imageLike >= 2) {
      const perTransition =
        imageLike === 2 ? seconds : seconds / (imageLike - 1);
      const minTransition = operationCapability.transitionMinSeconds ?? 1;
      const maxTransition = operationCapability.transitionMaxSeconds ?? 8;
      if (
        (imageLike === 2 && seconds < 2) ||
        perTransition < minTransition ||
        perTransition > maxTransition
      ) {
        missing.push(
          "当前多图数量与总时长组合会让单段转场超出 CLI 的 " +
            minTransition +
            "–" +
            maxTransition +
            " 秒限制。"
        );
      }
    }
    if (task.materials.some((item) => item.type === "logo")) {
      warnings.push("Logo 会作为图片参考传入；如要求 Logo 不变，请在提示要求中明确写出。");
    }
    if (counts.audios > 0) {
      warnings.push("这里的音频是 Dreamina 参考音频输入，不代表生成视频自带声音。");
    }
    if (!operationCapability.supportsNativeAudioOutput) {
      warnings.push("当前 CLI 未暴露原生声音输出开关；旁白/BGM/音效需在后期剪辑阶段处理。");
    }

    const planBase: AgentTaskPlan = {
      operation: selected.operation,
      operationLabel: operationCapability.operationLabel,
      reason: selected.reason,
      promptText: task.requestText,
      model: generationProfile
        ? generationProfile.modelMode === "FIXED"
          ? generationProfile.fixedModelLabel!
          : generationProfile.modelMode === "COMMAND_DEFAULT"
            ? "自动（命令默认 " + generationProfile.modelVersion + "）"
            : generationProfile.modelVersion!
        : task.model,
      durationMs: task.durationMs,
      aspectRatio: generationProfile?.aspectRatio ?? task.aspectRatio,
      videoResolution: generationProfile?.videoResolution ?? task.videoResolution,
      materialSummary: originalCounts,
      ...(adapted.adaptations.length
        ? {
            effectiveMaterialSummary: counts,
            referenceAdaptations: adapted.adaptations
          }
        : {}),
      missingRequirements: [...new Set(missing)],
      warnings,
      skillPath: registry.skillPath,
      skillSha256: registry.skillSha256,
      rootHelpSha256: registry.rootHelpSha256,
      commandHelpSha256: operationCapability.helpSha256,
      capabilityCheckedAt: registry.checkedAt,
      ...(generationProfile ? { generationProfile } : {})
    };

    if (planBase.missingRequirements.length) {
      return this.tasks.update(task.id, {
        status: "NEEDS_MATERIAL",
        selectedOperation: selected.operation,
        plan: planBase
      });
    }
    if (!generationProfile) {
      throw new DomainValidationError("生成能力 Profile 未建立");
    }
    const account = await this.provider.accountStatus();
    if (account.status !== "AUTHENTICATED") {
      return this.tasks.update(task.id, {
        status: "NEEDS_MATERIAL",
        selectedOperation: selected.operation,
        plan: {
          ...planBase,
          missingRequirements: [
            account.status === "NOT_AUTHENTICATED"
              ? "即梦尚未登录。请先完成 dreamina login，再重新检查。"
              : "无法确认即梦登录状态。请检查账号授权后重试。"
          ]
        }
      });
    }

    const artifactById = new Map(
      (await this.artifacts.listByProject(task.projectId)).map((item) => [
        item.id,
        item
      ])
    );
    const adaptationByArtifact = new Map(
      adapted.adaptations.flatMap((adaptation) =>
        adaptation.derived.map((derived) => [
          derived.artifactId,
          {
            sourceArtifactId: adaptation.sourceArtifactId,
            sourceArtifactHash: adaptation.sourceArtifactHash,
            strategy: "KEYFRAME" as const,
            adapterVersion: adaptation.adapterVersion,
            sourceDurationMs: adaptation.sourceDurationMs,
            timestampMs: derived.timestampMs,
            frameIndex: derived.frameIndex
          }
        ] as const)
      )
    );
    const assetManifest = effectiveMaterials.map((material, index) => {
      const artifact = artifactById.get(material.artifactId);
      if (
        !artifact ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256 ||
        artifact.sha256 !== material.sha256
      ) {
        throw new DomainValidationError(
          "Agent 素材完整性检查失败：" + material.originalFilename
        );
      }
      return {
        assetId: artifact.id,
        artifactHash: artifact.sha256,
        role:
          adaptationByArtifact.has(material.artifactId)
            ? ("OTHER" as const)
            : material.type === "logo"
            ? ("LOGO" as const)
            : material.type === "image"
              ? ("PRIMARY_PRODUCT" as const)
              : ("OTHER" as const),
        priority: index,
        required: true,
        inputType: mediaInputType(material.type),
        ...(adaptationByArtifact.get(material.artifactId)
          ? {
              agentReferenceAdaptation:
                adaptationByArtifact.get(material.artifactId)!
            }
          : {})
      };
    });

    const imageBindings = buildAssetImageBindings({
      promptText: task.requestText,
      assetManifest,
      dreaminaOperation: selected.operation
    });
    const compiledPromptHash = hashValue({
      agentTaskId: task.id,
      promptText: task.requestText,
      generationProfile,
      assetManifest,
      ...(imageBindings.length ? { imageBindings } : {})
    });
    const requestWithoutHash = {
      id: randomUUID(),
      projectId: task.projectId,
      clipId: "agent-" + task.id,
      compiledPromptId: "agent-prompt-" + task.id,
      compiledPromptHash,
      provider: "domestic-jimeng-cli" as const,
      providerIdentityHash: registry.providerIdentityHash,
      capabilityFingerprint: registry.providerCapabilityFingerprint,
      model:
        generationProfile.modelVersion ?? "dreamina-fixed-model",
      promptText: task.requestText,
      ...(imageBindings.length ? { imageBindings } : {}),
      assetManifest,
      durationMs: task.durationMs,
      aspectRatio: generationProfile.aspectRatio ?? "AUTO",
      videoResolution: generationProfile.videoResolution,
      generateAudio: generationProfile.nativeAudioOutputRequested,
      generationProfile,
      dreaminaOperation: selected.operation,
      agentTaskId: task.id,
      agentCapabilityHelpHash: operationCapability.helpSha256,
      inputVersionRefs: [],
      createdAt: new Date().toISOString()
    };
    const request = generationRequestSchema.parse({
      ...requestWithoutHash,
      requestHash: computeGenerationRequestHash(requestWithoutHash)
    });
    const savedRequest =
      await this.generation.createGenerationRequest(request);
    const estimate = await this.provider.estimate([savedRequest]);
    const costEstimate = {
      status: estimate.status,
      ...(estimate.estimatedCredits !== undefined
        ? { estimatedCredits: estimate.estimatedCredits }
        : {}),
      ...(estimate.estimatedCostText
        ? { estimatedCostText: estimate.estimatedCostText }
        : {}),
      observedAt: new Date().toISOString()
    };
    const reportBase = {
      id: randomUUID(),
      projectId: task.projectId,
      generationRequestId: savedRequest.id,
      requestHash: savedRequest.requestHash,
      status: "PASS" as const,
      providerIdentityHash: savedRequest.providerIdentityHash,
      capabilityFingerprint: savedRequest.capabilityFingerprint,
      clipCount: 1,
      totalGeneratedMs: savedRequest.durationMs,
      highRiskClipIds: [],
      costEstimate,
      blockers: [],
      warnings:
        estimate.status === "UNKNOWN"
          ? ["COST_ESTIMATE_UNKNOWN"]
          : [],
      createdAt: new Date().toISOString()
    };
    await this.generation.createPreflightReport(
      preflightReportSchema.parse({
        ...reportBase,
        reportHash: hashValue(reportBase)
      })
    );

    return this.tasks.update(task.id, {
      status: "READY_TO_CONFIRM",
      selectedOperation: selected.operation,
      generationRequestId: savedRequest.id,
      plan: {
        ...planBase,
        ...(account.availableCredits !== undefined
          ? { availableCredits: account.availableCredits }
          : {}),
        costEstimateStatus: estimate.status,
        ...(estimate.estimatedCredits !== undefined
          ? { estimatedCredits: estimate.estimatedCredits }
          : {}),
        ...(estimate.estimatedCostText
          ? { estimatedCostText: estimate.estimatedCostText }
          : {})
      }
    });
  }

  async confirmAndSubmit(input: {
    taskId: string;
    acceptedUnknownCostRisk: boolean;
  }): Promise<AgentTask> {
    let task = await this.requireTask(input.taskId);
    if (
      task.status !== "READY_TO_CONFIRM" ||
      !task.generationRequestId
    ) {
      throw new DomainValidationError("智能生成任务尚未通过材料或能力检查");
    }
    const approved = await this.approval.approveCurrentRequests({
      projectId: task.projectId,
      generationRequestIds: [task.generationRequestId],
      acceptedUnknownCostRisk: input.acceptedUnknownCostRisk,
      acceptedDuplicateSubmissionRisk: false
    });
    const attempt = approved.attempts[0];
    if (!attempt) {
      throw new DomainValidationError("智能生成尚未创建生成任务");
    }
    task = await this.tasks.update(task.id, {
      status: "APPROVED",
      generationAttemptId: attempt.id
    });
    const submitted = await this.execution.submitAttempt(attempt.id);
    return this.updateFromAttempt(task, submitted);
  }

  async advance(taskId: string): Promise<AgentTask> {
    let task = await this.requireTask(taskId);
    if (!task.generationAttemptId) return task;
    let attempt = await this.workflow.getGenerationAttempt(
      task.generationAttemptId
    );
    if (!attempt) {
      throw new DomainValidationError("智能生成任务记录不存在");
    }
    if (
      attempt.status === "SUBMITTED" ||
      attempt.status === "PROCESSING"
    ) {
      attempt = await this.execution.pollAttempt(attempt.id);
    }
    if (
      (attempt.status === "SUCCEEDED" ||
        attempt.status === "RECONCILED_SUCCEEDED") &&
      !attempt.outputArtifactId
    ) {
      attempt = await this.execution.downloadAttempt(attempt.id);
    }
    task = await this.updateFromAttempt(task, attempt);
    return task;
  }

  async reconcile(taskId: string): Promise<AgentTask> {
    let task = await this.requireTask(taskId);
    if (!task.generationAttemptId) {
      throw new DomainValidationError("当前智能生成任务没有可恢复的生成记录");
    }
    let attempt = await this.workflow.getGenerationAttempt(
      task.generationAttemptId
    );
    if (!attempt) {
      throw new DomainValidationError("Agent GenerationAttempt 不存在");
    }
    if (
      attempt.status !== "SUBMISSION_OUTCOME_UNKNOWN" &&
      attempt.status !== "RECONCILING"
    ) {
      throw new DomainValidationError(
        "当前 Agent 任务不需要执行提交调和"
      );
    }
    attempt = await this.execution.reconcileAttempt(attempt.id);
    if (
      (attempt.status === "SUCCEEDED" ||
        attempt.status === "RECONCILED_SUCCEEDED") &&
      !attempt.outputArtifactId
    ) {
      attempt = await this.execution.downloadAttempt(attempt.id);
    }
    task = await this.updateFromAttempt(task, attempt);
    return task;
  }

  async accept(taskId: string): Promise<AgentTask> {
    const task = await this.requireTask(taskId);
    if (task.status !== "REVIEW_READY" || !task.outputArtifactId) {
      throw new DomainValidationError("只有已下载的视频才能确认采用");
    }
    const artifact = await this.artifacts.findById(task.outputArtifactId);
    if (
      !artifact ||
      artifact.integrityStatus !== "READY" ||
      artifact.kind !== "GENERATED_VIDEO" ||
      !artifact.sha256
    ) {
      throw new DomainValidationError("智能生成输出视频不可用");
    }
    const projectRoot = path.join(this.projectsRoot, task.projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const sourcePath = store.resolveArtifactPath(artifact.relativePath);
    const bytes = await fs.readFile(sourcePath);
    const finalArtifact = await store.writeImmutable({
      id: randomUUID(),
      projectId: task.projectId,
      kind: "FINAL_VIDEO",
      relativePath:
        "final/agent-" + task.id + "-" + randomUUID() + ".mp4",
      immutable: true,
      bytes,
      mimeType: artifact.mimeType ?? "video/mp4"
    });
    if (!finalArtifact.sha256) {
      throw new DomainValidationError("智能生成成片尚未进入可用状态");
    }
    await this.finalOutput.markAssembliesStale(task.projectId);
    await this.finalOutput.createAssembly({
      id: randomUUID(),
      projectId: task.projectId,
      productionPlanHash: hashValue({
        mode: "AGENT",
        taskId: task.id,
        operation: task.selectedOperation,
        generationAttemptId: task.generationAttemptId,
        sourceArtifactHash: artifact.sha256
      }),
      selectedClipIds: ["agent-" + task.id],
      inputArtifactIds: [artifact.id],
      inputArtifactHashes: [artifact.sha256],
      outputArtifactId: finalArtifact.id,
      outputArtifactHash: finalArtifact.sha256,
      status: "READY",
      createdAt: new Date().toISOString()
    });
    await this.productFlow.setProjectStatus(
      task.projectId,
      "FINAL_REVIEW"
    );
    return this.tasks.update(task.id, {
      status: "ACCEPTED",
      acceptedAt: new Date().toISOString()
    });
  }

  async cloneForRedo(taskId: string): Promise<AgentTask> {
    const old = await this.requireTask(taskId);
    return this.createTask({
      projectId: old.projectId,
      skillId: old.skillId,
      requestText: old.requestText,
      requestedMethod: old.requestedMethod,
      model: old.model,
      durationMs: old.durationMs,
      materials: old.materials,
      aspectRatio: old.aspectRatio,
      videoResolution: old.videoResolution,
      nativeAudioOutputRequested: old.nativeAudioOutputRequested
    });
  }

  async getTask(id: string): Promise<AgentTask | null> {
    return this.tasks.findById(id);
  }

  async listTasks(projectId: string): Promise<AgentTask[]> {
    return this.tasks.listByProject(projectId);
  }

  private async updateFromAttempt(
    task: AgentTask,
    attempt: GenerationAttempt
  ): Promise<AgentTask> {
    if (
      (attempt.status === "SUCCEEDED" ||
        attempt.status === "RECONCILED_SUCCEEDED") &&
      attempt.outputArtifactId
    ) {
      return this.tasks.update(task.id, {
        status: "REVIEW_READY",
        outputArtifactId: attempt.outputArtifactId
      });
    }
    if (
      attempt.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
      attempt.status === "RECONCILING"
    ) {
      return this.tasks.update(task.id, {
        status: "RECONCILE_REQUIRED"
      });
    }
    if (
      attempt.status === "FAILED" ||
      attempt.status === "RECONCILED_FAILED"
    ) {
      return this.tasks.update(task.id, { status: "FAILED" });
    }
    return this.tasks.update(task.id, {
      status:
        attempt.status === "PROCESSING"
          ? "PROCESSING"
          : attempt.status === "SUBMITTED" ||
              attempt.status === "SUBMITTING"
            ? "SUBMITTED"
            : task.status
    });
  }

  private async requireTask(id: string): Promise<AgentTask> {
    const task = await this.tasks.findById(id);
    if (!task) throw new DomainValidationError("智能生成任务不存在");
    return task;
  }
}
