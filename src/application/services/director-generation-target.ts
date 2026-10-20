import {
  directorGenerationTargetSchema,
  type DirectorGenerationTarget,
  type DreaminaVideoOperation,
  type GenerationProfile,
  type ProductionPlan
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {
  resolveGenerationProfile,
  toDreaminaCliModel,
  type DreaminaCapabilityRegistry
} from "./dreamina-agent-capability.js";

export type DirectorGenerationSettings = {
  requestedModelVersion: string;
  aspectRatio: string;
  videoResolution: string;
  nativeAudioOutputRequested: boolean;
};

export const directorGenerationSettingsSchema = directorGenerationTargetSchema.pick({
  requestedModelVersion: true,
  aspectRatio: true,
  videoResolution: true,
  nativeAudioOutputRequested: true
}).strict();

/** Standard generation already routes product references through multimodal2video. */
export function standardClipOperation(referenceCount: number): DreaminaVideoOperation {
  return referenceCount > 0 ? "multimodal2video" : "text2video";
}

/** Capture verified capabilities before asking the director to plan any shots. */
export function resolveDirectorGenerationTarget(
  registry: DreaminaCapabilityRegistry,
  settings: DirectorGenerationSettings,
  operations: DreaminaVideoOperation[] = ["text2video", "multimodal2video"]
): DirectorGenerationTarget {
  const requested = toDreaminaCliModel(settings.requestedModelVersion.trim());
  if (!requested || requested === "auto" || requested === "fixed") {
    throw new DomainValidationError("导演分镜前请明确选择目标模型，不能在分镜后再由命令静默决定模型");
  }
  const operationConstraints = [...new Set(operations)].map((name) => {
    const operation = registry.operations.find((item) => item.operation === name);
    const model = operation?.models.find((item) => item.modelVersion === requested);
    if (!operation || !model || model.durationMinSeconds === undefined || model.durationMaxSeconds === undefined) {
      throw new DomainValidationError(`当前能力表无法验证 ${name} / ${requested} 的模型和时长，请刷新能力后重试`);
    }
    const minimum = Math.max(4, Math.ceil(model.durationMinSeconds));
    const maximum = Math.min(15, Math.floor(model.durationMaxSeconds));
    if (minimum > maximum) {
      throw new DomainValidationError(`${name} 当前模型时长与项目 4–15 秒长镜头约束不兼容`);
    }
    // Reuse the same validator as Agent/Manual Generate; no second model matrix.
    const profile = resolveGenerationProfile(registry, {
      ...settings,
      requestedModelVersion: requested,
      operation: name,
      durationMs: minimum * 1000,
      referenceAudioInputCount: 0
    });
    return {
      operation: name,
      operationLabel: operation.operationLabel,
      modelMode: profile.modelMode,
      modelVersion: profile.modelVersion,
      durationMinSeconds: model.durationMinSeconds,
      durationMaxSeconds: model.durationMaxSeconds,
      maxImages: model.maxImages ?? operation.maxImages,
      maxVideos: model.maxVideos ?? operation.maxVideos,
      maxAudio: model.maxAudio ?? operation.maxAudio,
      maxTotalInputs: model.maxTotalInputs ?? operation.maxTotalInputs,
      supportsReferenceAudio: operation.supportsReferenceAudio,
      supportsNativeAudioOutput: operation.supportsNativeAudioOutput,
      explicitRatioAllowed: model.explicitRatioAllowed,
      supportedResolutions: model.supportedResolutions
    };
  });
  const target = directorGenerationTargetSchema.parse({
    source: "DREAMINA_CAPABILITY_REGISTRY",
    ...settings,
    requestedModelVersion: requested,
    videoResolution: settings.videoResolution.toLowerCase(),
    registryFingerprint: registry.registryFingerprint,
    capabilityCheckedAt: registry.checkedAt,
    operationConstraints
  });
  directorClipBounds(target);
  return target;
}

/** Keep the existing project Clip contract (4–15s) while honoring stricter live limits. */
export function directorClipBounds(target?: DirectorGenerationTarget): { minSeconds: number; maxSeconds: number } {
  if (!target) return { minSeconds: 4, maxSeconds: 15 };
  const limits = directorGenerationTargetSchema.parse(target).operationConstraints;
  if (limits.some((item) => item.durationMinSeconds === undefined || item.durationMaxSeconds === undefined)) {
    throw new DomainValidationError("导演目标缺少已验证的镜头时长范围，不能猜测模型能力");
  }
  const minSeconds = Math.max(4, ...limits.map((item) => Math.ceil(item.durationMinSeconds!)));
  const maxSeconds = Math.min(15, ...limits.map((item) => Math.floor(item.durationMaxSeconds!)));
  if (minSeconds > maxSeconds) throw new DomainValidationError("所选命令没有共同可用的长镜头时长范围");
  return { minSeconds, maxSeconds };
}

/** Deterministic, balanced whole-second slots with an exact total; no paid side effects. */
export function planModelAwareClipDurations(targetDurationMs: number, target?: DirectorGenerationTarget): number[] {
  if (!Number.isInteger(targetDurationMs) || targetDurationMs < 4000 || targetDurationMs > 120000 || targetDurationMs % 1000 !== 0) {
    throw new DomainValidationError("自动拆镜需要 4–120 秒的整秒目标时长");
  }
  const { minSeconds, maxSeconds } = directorClipBounds(target);
  const seconds = targetDurationMs / 1000;
  const count = Math.ceil(seconds / maxSeconds);
  if (count * minSeconds > seconds) {
    throw new DomainValidationError("目标时长无法在当前模型最小/最大时长内无损拆镜，请调整目标时长");
  }
  const base = Math.floor(seconds / count);
  const remainder = seconds % count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) * 1000);
}

export function assertDirectorSettingsMatch(
  target: DirectorGenerationTarget,
  settings: DirectorGenerationSettings
): void {
  if (
    toDreaminaCliModel(settings.requestedModelVersion) !== toDreaminaCliModel(target.requestedModelVersion) ||
    settings.aspectRatio !== target.aspectRatio ||
    settings.videoResolution.toLowerCase() !== target.videoResolution.toLowerCase() ||
    settings.nativeAudioOutputRequested !== target.nativeAudioOutputRequested
  ) {
    throw new DomainValidationError("生成参数与导演目标不一致；请返回导演分镜重新适配并审核，不能复用旧 Prompt 或生成授权");
  }
}

export function assertProfileMatchesDirectorTarget(target: DirectorGenerationTarget, profile: GenerationProfile): void {
  if (
    toDreaminaCliModel(profile.modelVersion ?? "FIXED") !==
      toDreaminaCliModel(target.requestedModelVersion) ||
    (profile.aspectRatio ?? "AUTO") !== target.aspectRatio ||
    profile.videoResolution.toLowerCase() !==
      target.videoResolution.toLowerCase() ||
    (profile.nativeAudioOutputRequested &&
      !target.nativeAudioOutputRequested)
  ) {
    throw new DomainValidationError(
      "生成参数与导演目标不一致；请返回导演分镜重新适配并审核，不能复用旧 Prompt 或生成授权"
    );
  }
  const operation = target.operationConstraints.find((item) => item.operation === profile.operation);
  if (!operation || operation.modelVersion !== profile.modelVersion || profile.registryFingerprint !== target.registryFingerprint) {
    throw new DomainValidationError("模型命令或能力表已变化，请重新适配导演分镜；旧计划和付费授权不可复用");
  }
}

/**
 * A HARD_CONTINUITY successor uses a verified image2video operation instead of
 * the director's original text/multimodal route. This is an opt-in exception
 * only for the operation, never for model/ratio/resolution/audio/registry.
 */
export function assertReviewedFirstFrameProfileMatchesDirectorTarget(
  target: DirectorGenerationTarget, profile: GenerationProfile
): void {
  if (profile.operation !== "image2video" ||
      profile.aspectRatioMode !== "EXPLICIT" ||
      profile.registryFingerprint !== target.registryFingerprint ||
      toDreaminaCliModel(profile.modelVersion ?? "FIXED") !==
        toDreaminaCliModel(target.requestedModelVersion) ||
      profile.aspectRatio !== target.aspectRatio ||
      profile.videoResolution.toLowerCase() !== target.videoResolution.toLowerCase() ||
      profile.nativeAudioOutputRequested !== target.nativeAudioOutputRequested ||
      (target.nativeAudioOutputRequested && !profile.nativeAudioOutputSupported)) {
    throw new DomainValidationError(
      "已审核硬首帧模式的模型、比例、分辨率或原生声音能力不满足原导演要求；不得擅自降级生成。"
    );
  }
}

export function assertDirectorPlanTarget(plan: ProductionPlan, expected?: DirectorGenerationTarget): void {
  const target = plan.generationTarget;
  if (expected && (!target || hashValue(target) !== hashValue(expected))) {
    throw new DomainValidationError("导演返回的 GenerationTarget 与本次所选模型能力不一致");
  }
  if (!target) return; // Frozen/legacy plans remain readable, never rewritten.
  directorClipBounds(target);
  for (const clip of plan.scenes.flatMap((scene) => scene.clips)) {
    const operation = target.operationConstraints.find((item) => item.operation === standardClipOperation(clip.referenceAssets.length));
    if (!operation || operation.modelVersion !== target.requestedModelVersion) {
      throw new DomainValidationError(`镜头 ${clip.id} 的参考素材路由与导演目标模型不一致`);
    }
    if (clip.durationMs % 1000 !== 0 ||
        clip.durationMs < operation.durationMinSeconds! * 1000 ||
        clip.durationMs > operation.durationMaxSeconds! * 1000) {
      throw new DomainValidationError(`镜头 ${clip.id} 不符合所选模型的整秒时长限制`);
    }
    // Director input consists of confirmed product images/Logo. Media-aware
    // final limits are checked again against real AssetRefs at preflight.
    if ((operation.maxImages !== undefined && clip.referenceAssets.length > operation.maxImages) ||
        (operation.maxTotalInputs !== undefined && clip.referenceAssets.length > operation.maxTotalInputs)) {
      throw new DomainValidationError(`镜头 ${clip.id} 的参考素材超过所选模型限制，请重新分配参考图`);
    }
  }
}
