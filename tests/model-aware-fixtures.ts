import type { CreativeBatch, ScriptDraft } from "../src/domain/schemas.js";
import type { ProductDirectorInput } from "../src/application/ports/product-director-generator.js";
import type { DreaminaCapabilityRegistry } from "../src/application/services/dreamina-agent-capability.js";
import { resolveDirectorGenerationTarget } from "../src/application/services/director-generation-target.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

export function modelRegistry(maxSeconds = 15, nativeAudio = false): DreaminaCapabilityRegistry {
  const models = ["seedance2.0mini", "seedance2.0"];
  return {
    source: "DREAMINA_SKILL_AND_CLI_HELP", skillPath: "test/SKILL.md", skillSha256: H.a,
    rootHelpSha256: H.b, cliVersion: "test", providerIdentityHash: H.c,
    providerCapabilityFingerprint: H.d, registryFingerprint: H.e, checkedAt: ISO,
    models, ratios: ["9:16", "16:9", "1:1"], nativeAudioOutputSupported: nativeAudio,
    operations: (["text2video", "multimodal2video"] as const).map((operation) => ({
      operation, operationLabel: operation === "text2video" ? "文生视频" : "全能参考",
      helpSha256: H.f, modelConfigurable: true, fixedModel: false,
      defaultModelVersion: "seedance2.0", supportedModels: models,
      supportedRatios: ["9:16", "16:9", "1:1"],
      models: models.map((modelVersion) => ({
        modelVersion, supportedResolutions: ["720p", "1080p"], durationMinSeconds: 4,
        durationMaxSeconds: maxSeconds, explicitRatioAllowed: true, vipOnly: false,
        maxImages: 9, maxTotalInputs: 12
      })),
      fixedResolutions: [], supportsImages: operation !== "text2video",
      supportsVideos: operation !== "text2video", supportsReferenceAudio: operation !== "text2video",
      supportsNativeAudioOutput: nativeAudio, maxImages: 9, maxTotalInputs: 12
    }))
  };
}

export function directorCase(totalMs = 15000, maxSeconds = 15) {
  const truth = makeProductTruth();
  const truthRef = { entityType: "ProductTruth", entityId: truth.id, version: truth.version, hash: truth.contentHash };
  const batch: CreativeBatch = {
    id: "batch-model", projectId: truth.projectId, version: 1, status: "ACTIVE", productTruthRef: truthRef,
    generatorVersion: "test", createdAt: ISO, selectedCreativeId: "creative-1", contentHash: H.b,
    concepts: Array.from({ length: 4 }, (_, i) => ({
      id: `creative-${i + 1}`, title: "产品创意", targetAudience: "产品用户", painPoint: "使用需求",
      hook: "展示使用", coreSellingPoint: "Feature one", narrativePattern: "展示", expectedDurationMs: totalMs,
      productShowcaseStrategy: "真实外观", generationRisk: "LOW", requiredFactIds: ["fact-1"]
    }))
  };
  const script: ScriptDraft = {
    id: "script-model", projectId: truth.projectId, version: 1, status: "CONFIRMED", productTruthRef: truthRef,
    creativeBatchRef: { entityType: "CreativeBatch", entityId: batch.id, version: batch.version, hash: batch.contentHash },
    selectedCreativeId: "creative-1", targetDurationMs: totalMs, contentHash: H.c, confirmedAt: ISO,
    beats: [{ id: "beat-1", order: 1, purpose: "PRODUCT", text: "Feature one", estimatedDurationMs: totalMs, requiredFactIds: ["fact-1"] }]
  };
  const registry = modelRegistry(maxSeconds);
  const target = resolveDirectorGenerationTarget(registry, {
    requestedModelVersion: "seedance2.0mini", aspectRatio: "16:9", videoResolution: "720p", nativeAudioOutputRequested: false
  });
  const input: ProductDirectorInput = {
    productTruth: truth, creativeBatch: batch, selectedCreativeId: "creative-1", script,
    projectTargetDurationMs: totalMs, generationTarget: target
  };
  const clip = makeValidClip();
  clip.durationMs = totalMs;
  clip.closingState = structuredClone(clip.openingState);
  clip.segments = [{ ...clip.segments[0]!, startMs: 0, endMs: totalMs, continuityOut: structuredClone(clip.openingState) }];
  const proposal = {
    visualDirection: "真实产品展示", soundDirection: "后期旁白", productShowcaseRules: ["保留产品外观"], characters: [],
    scenes: [{ purpose: "产品展示", location: "摄影棚", visualState: "稳定", stableElements: ["桌面"],
      sourceBeatIds: ["beat-1"], requiredFactIds: ["fact-1"], clips: [clip] }]
  };
  return { input, registry, target, proposal };
}
