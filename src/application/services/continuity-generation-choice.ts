import type { ClipTransitionContract, ActualClipObservation } from "./clip-continuity-engine.js";
import { checkTransitionReady } from "./clip-continuity-engine.js";

export type ContinuityGenerationChoice = {
  status: "WAIT_SOURCE" | "NEEDS_REVIEW" | "UNSUPPORTED" | "READY";
  reason: string;
  operation?: "image2video" | "frames2video" | "multimodal2video";
  firstFrame?: { artifactId: string; sha256: string; providerSlot: "FIRST_FRAME" };
  mustConfirmNewPaidScope: boolean;
};

/**
 * Non-billing planning stage, not an automatic submission.
 * For strong continuity, the actual accepted source tail frame replaces
 * generic identity-reference images ONLY if the selected operation can take
 * it as its dedicated start input.
 */
export function chooseContinuityGenerationInput(input: {
  contract: ClipTransitionContract;
  observation?: ActualClipObservation;
  aspectRatio: string;
  nativeAudioRequested: boolean;
  additionalReferenceImages: number;
  capability: {
    image2video?: { available: boolean; allowsExplicitRatio: boolean; nativeAudio: boolean };
    frames2video?: { available: boolean; allowsExplicitRatio: boolean; nativeAudio: boolean };
    multimodal2video?: { available: boolean; allowsExplicitRatio: boolean; nativeAudio: boolean };
  };
  specifiedEndFrame?: { artifactId: string; sha256: string };
}): ContinuityGenerationChoice {
  const gate = checkTransitionReady(input.contract, input.observation);
  if (gate.status !== "READY") {
    return {status:gate.status,reason:gate.reason,mustConfirmNewPaidScope:false};
  }
  if (input.aspectRatio === "AUTO") {
    return {status:"UNSUPPORTED",reason:"连续视频必须使用明确画幅，不能默认为AUTO。",
      mustConfirmNewPaidScope:false};
  }
  if (input.contract.requiresHardFirstFrame) {
    if (!gate.firstFrameArtifactId || !gate.firstFrameSha256) {
      return {status:"WAIT_SOURCE",reason:"当前缺少真实尾帧素材或哈希。",
        mustConfirmNewPaidScope:false};
    }
    if (input.additionalReferenceImages) {
      return {status:"UNSUPPORTED",
        reason:"模型专用首帧输入与多张独立角色/场景图片不可假定能同时绑定；请先提供审核过的完整尾帧，或重新安排镜头，不将其当作普通多图参考。",
        mustConfirmNewPaidScope:false};
    }
    const cap = input.specifiedEndFrame ? input.capability.frames2video : input.capability.image2video;
    const operation = input.specifiedEndFrame ? "frames2video" : "image2video";
    if (!cap?.available || !cap.allowsExplicitRatio) {
      return {status:"UNSUPPORTED",reason:"即梦当前模型不支持所需专用首帧模式与明确比例，请选择其他模型或拆分镜头。",
        mustConfirmNewPaidScope:false};
    }
    if (input.nativeAudioRequested && !cap.nativeAudio) {
      return {status:"UNSUPPORTED",reason:"当前专用首帧模式不支持所要求的原生对白/环境声；不能静默生成无声音的视频。",
        mustConfirmNewPaidScope:false};
    }
    return {
      status:"READY",
      reason:operation==="frames2video"
        ? "准备使用已审核真实尾帧作为首帧并提供明确的尾帧；生成效果仍须视频质检。"
        : "准备使用已审核真实尾帧作为图生视频起始参考；模型实际首帧是否精确一致仍须对照验收。",
      operation,
      firstFrame:{artifactId:gate.firstFrameArtifactId,
        sha256:gate.firstFrameSha256,providerSlot:"FIRST_FRAME"},
      mustConfirmNewPaidScope:true
    };
  }
  const cap=input.capability.multimodal2video;
  if (!cap?.available || !cap.allowsExplicitRatio || (input.nativeAudioRequested && !cap.nativeAudio)) {
    return {status:"UNSUPPORTED",reason:"当前全能参考模式无法同时满足明确画幅、参考图与声音条件。",
      mustConfirmNewPaidScope:false};
  }
  return {
    status:"READY",reason:"独立切镜允许改变机位；仍需逐镜验证人物、道具与场景连续。",
    operation:"multimodal2video",mustConfirmNewPaidScope:true
  };
}
