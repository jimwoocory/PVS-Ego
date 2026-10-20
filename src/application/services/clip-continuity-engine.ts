import { z } from "zod";
import type { ProductionPlan } from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

export const transitionRelationshipSchema = z.enum([
  "HARD_CONTINUITY", "SAME_SCENE_CUT", "SCENE_OR_TIME_JUMP", "REVIEW_REQUIRED"
]);
export type TransitionRelationship = z.infer<typeof transitionRelationshipSchema>;

export const continuityActorAnchorSchema = z.object({
  actorKey: z.string().min(1),
  position: z.string().min(1).optional(),
  facing: z.string().min(1).optional(),
  wardrobe: z.string().min(1).optional(),
  heldPropKeys: z.array(z.string().min(1)).optional()
}).strict();

export const continuityPropAnchorSchema = z.object({
  propKey: z.string().min(1),
  ownerActorKey: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  state: z.string().min(1).optional()
}).strict();

export const continuityDecisionSchema = z.object({
  sourceClipId: z.string().min(1),
  targetClipId: z.string().min(1),
  relationship: transitionRelationshipSchema.exclude(["REVIEW_REQUIRED"]),
  reason: z.string().min(1),
  actorAnchors: z.array(continuityActorAnchorSchema).default([]),
  propAnchors: z.array(continuityPropAnchorSchema).default([]),
  approvedPlanHash: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();
export type ContinuityDecision = z.infer<typeof continuityDecisionSchema>;

export type ClipTransitionContract = {
  version: "clip-continuity-contract-1";
  sourceClipId: string;
  targetClipId: string;
  sourceSceneId: string;
  targetSceneId: string;
  relationship: TransitionRelationship;
  plannedSourceEndStateHash: string;
  plannedTargetStartStateHash: string;
  approvedProductionPlanHash: string;
  reason: string;
  actorAnchors: ContinuityDecision["actorAnchors"];
  propAnchors: ContinuityDecision["propAnchors"];
  requiresSourceGeneration: boolean;
  requiresHardFirstFrame: boolean;
  contentHash: string;
};

export type ClipContinuityGraph = {
  version: "clip-continuity-graph-1";
  productionPlanHash: string;
  transitions: ClipTransitionContract[];
  unresolved: string[];
  contentHash: string;
};

/**
 * A plan with differing states in the same scene is *not* assumed to be a
 * harmless camera cut. The Director/user must explicitly decide the relation.
 */
export function buildClipContinuityGraph(
  plan: Pick<ProductionPlan, "contentHash" | "scenes">,
  decisions: readonly ContinuityDecision[] = []
): ClipContinuityGraph {
  const clips = plan.scenes.flatMap(scene => scene.clips
    .map(clip => ({ clip, scene })));
  const keyed = new Map<string, ContinuityDecision>();
  for (const raw of decisions) {
    const decision = continuityDecisionSchema.parse(raw);
    if (decision.approvedPlanHash !== plan.contentHash) {
      throw new DomainValidationError("连续性人工决策来自旧分镜版本，必须重新审核。");
    }
    const key = decision.sourceClipId + "→" + decision.targetClipId;
    if (keyed.has(key)) {
      throw new DomainValidationError("连续性关系重复：" + key);
    }
    keyed.set(key, decision);
  }
  const transitions: ClipTransitionContract[] = [];
  for (let i = 1; i < clips.length; i++) {
    const prior = clips[i - 1]!;
    const next = clips[i]!;
    const key = prior.clip.id + "→" + next.clip.id;
    const decision = keyed.get(key);
    keyed.delete(key);
    const sameScene = prior.scene.id === next.scene.id;
    if (decision && ((decision.relationship === "SCENE_OR_TIME_JUMP" && sameScene) ||
      (decision.relationship !== "SCENE_OR_TIME_JUMP" && !sameScene))) {
      throw new DomainValidationError("连续性转场类别与导演场景划分不一致：" + key);
    }
    const hashesMatch = prior.clip.closingState.stateHash === next.clip.openingState.stateHash;
    const relationship: TransitionRelationship = decision?.relationship ?? (!sameScene ? "SCENE_OR_TIME_JUMP"
      : hashesMatch ? "HARD_CONTINUITY" : "REVIEW_REQUIRED");
    if (relationship === "HARD_CONTINUITY" && !hashesMatch) {
      throw new DomainValidationError("强连续要求上一段结束和下一段开始的计划状态一致：" + key);
    }
    if (relationship === "SAME_SCENE_CUT" &&
      !decision?.actorAnchors.length && !decision?.propAnchors.length) {
      throw new DomainValidationError("同场景切机位需要至少一条人物或道具连续性锚点：" + key);
    }
    const base = {
      version: "clip-continuity-contract-1" as const,
      sourceClipId: prior.clip.id,
      targetClipId: next.clip.id,
      sourceSceneId: prior.scene.id,
      targetSceneId: next.scene.id,
      relationship,
      plannedSourceEndStateHash: prior.clip.closingState.stateHash,
      plannedTargetStartStateHash: next.clip.openingState.stateHash,
      approvedProductionPlanHash: plan.contentHash,
      reason: decision?.reason ?? (!sameScene ? "导演已划分新场景" :
        hashesMatch ? "前后计划状态哈希一致" : "同场景计划状态不一致，需导演确认是否正常切镜或返修"),
      actorAnchors: decision?.actorAnchors ?? [],
      propAnchors: decision?.propAnchors ?? [],
      requiresSourceGeneration: relationship !== "SCENE_OR_TIME_JUMP",
      requiresHardFirstFrame: relationship === "HARD_CONTINUITY"
    };
    transitions.push({ ...base, contentHash: hashValue(base) });
  }
  if (keyed.size) {
    throw new DomainValidationError("连续性人工决策引用不存在或非相邻的Clip：" +
      [...keyed.keys()].join("、"));
  }
  const unresolved = transitions.filter(t => t.relationship === "REVIEW_REQUIRED")
    .map(t => t.sourceClipId + "→" + t.targetClipId);
  const base = { version: "clip-continuity-graph-1" as const,
    productionPlanHash: plan.contentHash, transitions, unresolved };
  return { ...base, contentHash: hashValue(base) };
}


/** First paid wave can only include shots with no actual-source dependency. */
export function firstSourceIndependentClipIds(
  packages:readonly {clipId:string;incomingContinuity?:{relationship:TransitionRelationship}}[]
):string[]{
  const ids=new Set<string>();
  const ready:string[]=[];
  for(const item of packages){
    if(ids.has(item.clipId)){
      throw new DomainValidationError("同一批导演提示词不能包含重复视频编号："+item.clipId);
    }
    ids.add(item.clipId);
    if(!item.incomingContinuity ||
      item.incomingContinuity.relationship==="SCENE_OR_TIME_JUMP"){
      ready.push(item.clipId);
    }
  }
  return ready;
}


/**
 * Local redo invalidates only genuinely dependent successor clips.
 * Scene/time jumps form independent branches; never delete existing media.
 */
export function affectedContinuationClipIds(graph: ClipContinuityGraph, changedClipId:string):string[]{
  const stale=new Set<string>();
  const pending=[changedClipId];
  while(pending.length){
    const source=pending.shift()!;
    for(const transition of graph.transitions){
      if(transition.sourceClipId!==source || !transition.requiresSourceGeneration ||
          stale.has(transition.targetClipId) || transition.targetClipId===changedClipId) continue;
      stale.add(transition.targetClipId);
      pending.push(transition.targetClipId);
    }
  }
  return [...stale];
}

export const actualClipObservationSchema = z.object({
  version: z.literal("actual-clip-observation-1"),
  clipId: z.string().min(1),
  generationAttemptId: z.string().min(1),
  mediaSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  tailFrameArtifactId: z.string().min(1),
  tailFrameSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  tailFrameTimestampMs: z.number().int().nonnegative(),
  analysisStatus: z.enum(["PENDING", "REVIEWED", "REJECTED"]),
  actorObservations: z.array(continuityActorAnchorSchema).default([]),
  propObservations: z.array(continuityPropAnchorSchema).default([])
}).strict();
export type ActualClipObservation = z.infer<typeof actualClipObservationSchema>;


/**
 * Converts extracted PENDING evidence to REVIEWED only when the caller has
 * checked the exact current successful source video and an explicit current
 * user ACCEPT decision. This projection does not mutate immutable evidence.
 */
export function reviewAcceptedActualClipObservation(input:{
  observation:ActualClipObservation;
  sourceAttempt:{
    id:string;clipId:string;outputArtifactId?:string;
    status:string;
  };
  sourceArtifact:{id:string;sha256?:string;integrityStatus:string};
  currentLatestSuccessfulAttemptId:string;
  expectedClipHash:string;
  decisions:readonly {
    clipId:string;clipHash:string;generationAttemptId?:string;
    outputArtifactId?:string;outputArtifactHash?:string;decision:string;decidedAt:string;
  }[];
}):ActualClipObservation{
  const {observation,sourceAttempt,sourceArtifact,decisions}=input;
  if(sourceAttempt.id!==input.currentLatestSuccessfulAttemptId ||
      sourceAttempt.clipId!==observation.clipId ||
      !["SUCCEEDED","RECONCILED_SUCCEEDED"].includes(sourceAttempt.status) ||
      sourceAttempt.outputArtifactId!==sourceArtifact.id ||
      sourceArtifact.integrityStatus!=="READY" ||
      sourceArtifact.sha256!==observation.mediaSha256 ||
      observation.generationAttemptId!==sourceAttempt.id){
    throw new DomainValidationError("上一段实际尾帧未绑定当前最新成功视频与可用产物，不能继承。");
  }
  const decision=[...decisions].filter(d=>
    d.clipId===observation.clipId&&d.clipHash===input.expectedClipHash)
    .sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt))[0];
  if(!decision || decision.decision!=="ACCEPT" ||
      decision.generationAttemptId!==sourceAttempt.id ||
      decision.outputArtifactId!==sourceArtifact.id ||
      decision.outputArtifactHash!==sourceArtifact.sha256){
    throw new DomainValidationError("上一段的当前视频尚未经用户准确采用，或之后已经决定重做，不能自动沿用尾帧。");
  }
  return actualClipObservationSchema.parse({...observation,analysisStatus:"REVIEWED"});
}

export function checkTransitionReady(
  contract: ClipTransitionContract,
  observation: ActualClipObservation | undefined
): { status: "READY" | "WAIT_SOURCE" | "NEEDS_REVIEW";
     reason: string; firstFrameArtifactId?: string; firstFrameSha256?: string } {
  if (contract.relationship === "REVIEW_REQUIRED") {
    return { status: "NEEDS_REVIEW", reason: "导演尚未确认本次转场的连续性关系。" };
  }
  if (!contract.requiresSourceGeneration) {
    return { status: "READY", reason: "新场景可独立生成，不要求上一段首尾画面相同。" };
  }
  if (!observation || observation.clipId !== contract.sourceClipId ||
      observation.analysisStatus === "PENDING") {
    return { status: "WAIT_SOURCE", reason: "需要上一段已完成的视频及真实尾帧状态。" };
  }
  if (observation.analysisStatus === "REJECTED") {
    return { status: "NEEDS_REVIEW", reason: "上一段实际画面未通过审核，不能继承错误状态。" };
  }
  if (contract.requiresHardFirstFrame) {
    return {
      status: "READY",
      reason: "已确认上一段真实尾帧，须使用提供商专用首帧槽位，不能当普通参考图。",
      firstFrameArtifactId: observation.tailFrameArtifactId,
      firstFrameSha256: observation.tailFrameSha256
    };
  }
  return { status: "READY", reason: "同场景切机位可变化构图，但必须保持人物与道具锚点。" };
}
