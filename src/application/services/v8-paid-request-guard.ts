import type { GenerationRequest } from "../../domain/schemas.js";
import type { SmartRunRepository } from "../ports/smart-run-repository.js";
import { DomainValidationError } from "../../domain/validation.js";
import { hashValue } from "../../domain/hashing.js";
import { assertV8PromptBinding } from "./v8-production-binding.js";
import { appendReviewedContinuityInstruction } from "./continuity-request-compiler.js";

export type V8PaidRequestGuard = (request: GenerationRequest) => Promise<void>;
/** Also used by the ordinary approval/batch UI: a direct POST is no bypass. */
export function createV8PaidRequestGuard(repo: SmartRunRepository): V8PaidRequestGuard {
  return async request => {
    if (!request.v8Binding) return;
    const run = await repo.get(request.projectId, request.v8Binding.runId);
    if (!run || run.options.directorPipeline !== "V8" ||
        !["APPROVING", "GENERATING"].includes(run.status) ||
        !run.consent || run.consent.scopeHash !== run.paidScope?.hash) {
      throw new DomainValidationError("V8 付费请求必须由本任务精确授权后执行，普通生成页不能代替本轮确认");
    }
    assertV8PromptBinding(run);
    const p = run.v8Prompts!.packages.find(p => p.clipId === request.clipId);
    const expected = { runId: run.id, screenplayHash: run.v8Screenplay!.screenplayHash,
      directorRecordHash: run.v8Director!.contentHash, promptRecordHash: run.v8Prompts!.contentHash,
      promptPackageHash: p?.contentHash };
    const source=request.continuitySource;
    const expectedPrompt=p ? source
      ? appendReviewedContinuityInstruction(p.promptText,source) : p.promptText : undefined;
    const incoming=p?.incomingContinuity;
    if (!p || request.promptText !== expectedPrompt || !request.generateAudio ||
        hashValue(expected) !== hashValue(request.v8Binding) ||
        !run.paidScope!.requests.some(r => r.requestId === request.id && r.requestHash === request.requestHash)) {
      throw new DomainValidationError("V8 请求、提示词或付费范围已失效，请返回任务重新审核；禁止复用旧授权");
    }
    if (run.v8Prompts?.imageBindingMode==="V1") {
      const batch=run.paidScope?.continuityBatch;
      if (!batch?.clipIds.includes(request.clipId)) {
        throw new DomainValidationError("本镜头不属于当前独立授权批次");
      }
      if (source) {
        if (!incoming || incoming.sourceClipId!==source.sourceClipId ||
            incoming.contractHash!==source.contractHash ||
            incoming.relationship!==source.relationship ||
            !run.attemptIds.includes(source.sourceAttemptId) ||
            (incoming.requiresHardFirstFrame &&
              (request.dreaminaOperation!=="image2video" ||
               request.assetManifest[0]?.assetId!==source.tailFrameArtifactId ||
               request.assetManifest[0]?.artifactHash!==source.tailFrameSha256 ||
               request.imageBindings?.[0]?.providerSlot!=="FIRST_FRAME"))) {
          throw new DomainValidationError("尾帧来源、生成槽位或当前批次费用确认不匹配");
        }
      } else if (incoming && incoming.relationship!=="SCENE_OR_TIME_JUMP") {
        throw new DomainValidationError("依赖视频未经尾帧审核，禁止使用旧授权付费");
      }
    }
  };
}
