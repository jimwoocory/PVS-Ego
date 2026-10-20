import { compiledPromptSchema, type CompiledPrompt, type GenerationRequest } from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { orderedImageAssets, buildAssetImageBindings } from "./asset-image-bindings.js";
import type { ReviewedContinuitySource } from "./reviewed-continuity-source.js";
import type { V8PromptRecord } from "../../domain/v8-production.js";

export type SourceBinding = NonNullable<GenerationRequest["continuitySource"]>;
export type IncomingV8Continuity = NonNullable<V8PromptRecord["packages"][number]["incomingContinuity"]>;

export function bindReviewedContinuitySource(input: {
  source: ReviewedContinuitySource;
  incoming: IncomingV8Continuity;
}): SourceBinding {
  const {source, incoming}=input;
  if (incoming.sourceClipId !== source.sourceClipId ||
      !["HARD_CONTINUITY","SAME_SCENE_CUT"].includes(incoming.relationship) ||
      source.observation.analysisStatus !== "REVIEWED" ||
      source.observation.generationAttemptId !== source.sourceAttemptId ||
      !source.observation.tailFrameSha256 ||
      source.observation.mediaSha256 !== source.sourceVideoSha256) {
    throw new DomainValidationError("当前审核尾帧与导演转场契约来源不一致。");
  }
  return {
    version:"continuity-source-binding-1",
    sourceClipId:source.sourceClipId,
    sourceAttemptId:source.sourceAttemptId,
    sourceVideoArtifactId:source.sourceVideoArtifactId,
    sourceVideoSha256:source.sourceVideoSha256,
    tailFrameArtifactId:source.observation.tailFrameArtifactId,
    tailFrameSha256:source.observation.tailFrameSha256,
    reviewDecisionId:source.reviewDecisionId,
    reviewDecisionHash:source.reviewDecisionHash,
    reviewedEvidenceArtifactId:source.reviewedEvidenceArtifactId,
    reviewedEvidenceHash:source.reviewedEvidenceHash,
    contractHash:incoming.contractHash,
    relationship:incoming.relationship as SourceBinding["relationship"]
  };
}

/** Append only a provider-input instruction. The approved screenplay / voice lines
 * remain byte-for-byte at the beginning of the prompt; old V8 PromptRecord stays sealed. */
export function appendReviewedContinuityInstruction(originalPrompt: string, source: SourceBinding): string {
  if (source.relationship !== "HARD_CONTINUITY") return originalPrompt;
  return originalPrompt +
    "\n[连续性硬首帧输入]\n上一视频尾帧@图片1：此图是上一段已采用视频的真实尾帧，必须传入图生视频专用首帧槽；保持人物身份、站位、道具状态与衔接动作。不得将它替换为普通参考图。";
}

/** Generates a new compiled hash and image manifest for a later, separately consented
 * batch. Never puts ordinary identity/scene references into ignored image2video slots. */
export function compileReviewedContinuityInput(input: {
  compiled: CompiledPrompt;
  source: SourceBinding;
}): CompiledPrompt {
  const {compiled, source}=input;
  const hard=source.relationship==="HARD_CONTINUITY";
  if (hard && orderedImageAssets(compiled.inputAssetManifest).length) {
    throw new DomainValidationError(
      "本镜头已有多张角色/场景参考图，但所选专用首帧命令无法同时输入；不得静默丢弃素材或将真实尾帧当普通参考图。"
    );
  }
  const manifest = hard
    ? [{assetId:source.tailFrameArtifactId,artifactHash:source.tailFrameSha256,
        role:"SCENE_REFERENCE" as const,priority:0,required:true,inputType:"image" as const},
       ...compiled.inputAssetManifest]
    : compiled.inputAssetManifest;
  const promptText=appendReviewedContinuityInstruction(compiled.promptText,source);
  const imageBindings=hard ? buildAssetImageBindings({
    promptText, assetManifest:manifest, dreaminaOperation:"image2video"
  }) : compiled.imageBindings;
  return compiledPromptSchema.parse({
    ...compiled,
    compilerTemplateVersion:compiled.compilerTemplateVersion+"+reviewed-continuity-v1",
    continuitySource:source,
    promptText,
    inputAssetManifest:manifest,
    ...(imageBindings ? {imageBindings} : {}),
    compiledPromptHash:hashValue({
      baseCompiledPromptHash:compiled.compiledPromptHash, source, promptText,
      assetManifest:manifest, imageBindings:imageBindings ?? [],
      operation:hard ? "image2video":"unchanged"
    })
  });
}
