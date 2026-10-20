import type { V8PromptRecord } from "../../domain/v8-production.js";
import { DomainValidationError } from "../../domain/validation.js";

export type ContinuityWave = {
  status: "READY" | "WAITING_FOR_REVIEW" | "WAIT_SOURCE" | "COMPLETE";
  clipIds: string[];
  sourceClipIds: string[];
  message: string;
};

/** Picks only a source-independent batch or successors of videos the user has
 * accepted in this run. It never reuses a prior paid batch's authorization. */
export function planNextContinuityWave(input: {
  packages: Pick<V8PromptRecord["packages"][number], "clipId" | "incomingContinuity">[];
  attemptedClipIds: ReadonlySet<string>;
  acceptedClipIds: ReadonlySet<string>;
}): ContinuityWave {
  const { packages, attemptedClipIds, acceptedClipIds } = input;
  const index = new Map<string, number>();
  packages.forEach((p, i) => {
    if (index.has(p.clipId)) throw new DomainValidationError("镜头编号重复，不能分批提交。");
    index.set(p.clipId, i);
  });
  for (const clipId of attemptedClipIds) {
    if (!index.has(clipId)) throw new DomainValidationError("已有生成记录不属于本轮镜头，不能继承费用授权。");
    if (!acceptedClipIds.has(clipId)) return {
      status: "WAITING_FOR_REVIEW", clipIds: [], sourceClipIds: [],
      message: "上一批包含尚未人工采用的片段，先完成审片，不能生成依赖片段。"
    };
  }
  const missing = packages.filter(p => !attemptedClipIds.has(p.clipId));
  if (!missing.length) return {
    status: "COMPLETE", clipIds: [], sourceClipIds: [],
    message: "所有镜头均已尝试生成且经用户明确采用。"
  };
  const ready:string[]=[];
  const sourceIds:string[]=[];
  for(const p of missing) {
    const continuity=p.incomingContinuity;
    if (!continuity || continuity.relationship === "SCENE_OR_TIME_JUMP") {
      ready.push(p.clipId);
      continue;
    }
    if (continuity.relationship === "REVIEW_REQUIRED") {
      throw new DomainValidationError("镜头之间的转场关系未明确审核，禁止自动选择生成模式。");
    }
    const sourcePosition = index.get(continuity.sourceClipId);
    if (sourcePosition === undefined || sourcePosition >= index.get(p.clipId)!) {
      throw new DomainValidationError("连续性来源必须属于本轮更早的镜头，禁止循环依赖和外部视频冒充。");
    }
    if (acceptedClipIds.has(continuity.sourceClipId)) {
      ready.push(p.clipId);
      sourceIds.push(continuity.sourceClipId);
    }
  }
  if (!ready.length) return {
    status:"WAIT_SOURCE",clipIds:[],sourceClipIds:[],
    message:"下一批镜头的来源尚未生成并由用户审核。"
  };
  return {
    status:"READY",clipIds:ready,sourceClipIds:[...new Set(sourceIds)],
    message: attemptedClipIds.size ? "下一批继承已审核来源；需要独立预检和新的付费确认。" :
      "首批仅生成没有前序视频依赖的片段。"
  };
}
