import { hashValue } from "../../domain/hashing.js";
import type { ScriptDraft } from "../../domain/schemas.js";
import type { V8DetailedProposal } from "./v8-detailed-screenplay-service.js";
import {
  planV8ShotFirstShadow, type V8PlannedShot,
  type V8ShotFirstPreview
} from "./v8-shot-first-shadow.js";
import { DomainValidationError } from "../../domain/validation.js";

export type V8DirectorShotDecision = {
  shotId: string;
  sourceBeatId: string;
  startMs: number;
  endMs: number;
  shotFunction: V8PlannedShot["function"];
  visibleAction: string;
  ambience?: string[];
  sfx?: string[];
  postProductionText?: string[];
  visualGuidance?: string;
  actorObjective?: { speaker: string; wants: string; obstacle: string };
  spoken?: {
    speaker: string;
    mode: "ONSCREEN" | "OFFSCREEN" | "OS";
    exactText: string;
    tone: string;
    delivery: string;
    voiceAssetStatus: "NEEDS_BINDING";
    speechEstimatedMs: number;
    /** Original utterance is retained even when exactText is one semantic part. */
    sourceLineText?: string;
    sourcePartIndex?: number;
    sourcePartCount?: number;
  };
  audienceKnowledgeChange?: string;
  /** Director can propose shot sizes/camera positions later, not rewrite source. */
  cameraDecisionsPending: true;
  blockingDecisionsPending: true;
};
export type V8DirectorClipDecision = {
  clipId: string;
  order: number;
  location: string;
  durationMs: number;
  sourceBeatIds: string[];
  shots: V8DirectorShotDecision[];
  openingState: string;
  closingState: string;
  sourceAfterReveal: string[];
};
export type V8DirectorDecision = {
  version: "v8-director-decision-1";
  sourceScriptHash: string;
  screenplayHash: string;
  modelDurationCapability: { minSeconds:number; maxSeconds:number };
  targetDurationMs: number;
  clips: V8DirectorClipDecision[];
  traceability: { totalLines:number; coveredLines:number; sourceBeats:number; coveredBeats:number };
  status: "DRAFT_NEEDS_VISUAL_DIRECTING";
  contentHash: string;
};

/**
 * Constrained V8 narrative/voice shot decisions. Never calls video providers
 * or changes a canonical ProductionPlan. ProductDirector may refine visual
 * composition based on this plan but may not alter locked text/action.
 */
export function buildV8DirectorDecision(input: {
  script: ScriptDraft;
  screenplay: V8DetailedProposal;
  modelMinSeconds: number;
  modelMaxSeconds: number;
}): V8DirectorDecision {
  const screenplayBeats = input.screenplay.scenes.flatMap(scene =>
    scene.beats.map(beat => ({ scene, beat })));
  const sorted = [...input.script.beats].sort((a,b)=>a.order-b.order);
  if (screenplayBeats.length !== sorted.length) {
    throw new DomainValidationError("V8 详细剧本节拍数与兼容 ScriptDraft 不一致，不能导演分镜");
  }
  const primaryMap = new Map(sorted.map((beat,i) => {
    const source = screenplayBeats[i]!;
    if (beat.estimatedDurationMs !== source.beat.estimatedDurationMs ||
        beat.videoIntent?.storyAction !== source.beat.actorAction ||
        beat.videoIntent?.location !== source.scene.location) {
      throw new DomainValidationError("V8 剧本与兼容 Beat 的动作、场景或时长不一致");
    }
    return [beat.id,source] as const;
  }));
  const plan: V8ShotFirstPreview = planV8ShotFirstShadow({
    script:input.script,
    modelMinSeconds:input.modelMinSeconds,
    modelMaxSeconds:input.modelMaxSeconds
  });
  if (plan.status !== "PASS") {
    throw new DomainValidationError(
      "V8 分镜时间预算未通过：" + plan.issues.map(issue=>issue.message).join("；")
    );
  }
  const seenLineCounts = new Map<string, number>();
  // A whole utterance is counted only after its final semantic part; duplicate
  // source lines remain distinct, and missing/reordered segments fail closed.
  const pendingParts = new Map<string, { nextIndex: number; partCount: number; text: string }>();
  const clips: V8DirectorClipDecision[] = plan.clips.map(clip => {
    const shots = clip.shots.map((shot, shotIndex) => {
      const source = primaryMap.get(shot.beatId);
      if (!source) throw new DomainValidationError("分镜缺少来源 Beat：" + shot.beatId);
      const {scene,beat} = source;
      const matchingActor = scene.actorObjectives.find(actor => actor.speaker === shot.speaker);
      const base: V8DirectorShotDecision = {
        shotId:shot.id,sourceBeatId:shot.beatId,startMs:shot.startMs,endMs:shot.endMs,
        shotFunction:shot.function,
        visibleAction:shot.function === "SPEECH" ? beat.actorAction : shot.description,
        ambience: beat.ambience,
        sfx: beat.sfx,
        postProductionText: !clip.shots.slice(shotIndex + 1).some(next => next.beatId === shot.beatId)
          ? beat.postProductionText : [],
        ...(matchingActor ? { actorObjective:matchingActor } : {}),
        ...(beat.audienceKnowledgeChange &&
          !clip.shots.slice(shotIndex + 1).some(next => next.beatId === shot.beatId) ? {
          audienceKnowledgeChange:beat.audienceKnowledgeChange
        } : {}),
        cameraDecisionsPending:true,
        blockingDecisionsPending:true
      };
      if (shot.function !== "SPEECH" || !shot.dialogueText) return base;
      const sourceText = shot.sourceDialogueText ?? shot.dialogueText;
      const key = JSON.stringify([shot.beatId, shot.speaker, sourceText]);
      const eligible = beat.dialogue.filter(line =>
        line.text === sourceText &&
        (shot.speaker === "OS" ? line.mode === "OS" :
          line.speaker === shot.speaker && line.mode !== "OS"));
      const used = seenLineCounts.get(key) ?? 0;
      const line = eligible[used];
      if (!line) {
        throw new DomainValidationError("V8 原台词、发声角色与 Shot 对不上，不得自创台词：" + key);
      }
      const partIndex = shot.speechPartIndex ?? 1;
      const partCount = shot.speechPartCount ?? 1;
      const pending = pendingParts.get(key);
      if (partIndex < 1 || partIndex > partCount ||
          (pending && (pending.nextIndex !== partIndex || pending.partCount !== partCount)) ||
          (!pending && partIndex !== 1)) {
        throw new DomainValidationError("V8 同一句对白的跨镜次序不连续，必须人工审核：" + key);
      }
      const assembled = (pending?.text ?? "") + shot.dialogueText;
      if (partIndex === partCount) {
        if (assembled !== sourceText) {
          throw new DomainValidationError("V8 分镜没有逐字覆盖原句，禁止进入 ProductDirector：" + key);
        }
        seenLineCounts.set(key, used + 1);
        pendingParts.delete(key);
      } else {
        pendingParts.set(key, { nextIndex: partIndex + 1, partCount, text: assembled });
      }
      return {
        ...base,
        spoken: {
          speaker:line.speaker,mode:line.mode,exactText:shot.dialogueText,
          sourceLineText:sourceText,sourcePartIndex:partIndex,sourcePartCount:partCount,
          tone:line.tone,delivery:line.delivery,
          voiceAssetStatus:"NEEDS_BINDING" as const,
          speechEstimatedMs:shot.speechTimeEstimateMs ?? 0
        }
      };
    });
    const first = primaryMap.get(clip.beatIds[0]!)?.beat;
    const final = primaryMap.get(clip.beatIds.at(-1)!)?.beat;
    return {
      clipId:clip.id,order:clip.order,
      location:clip.location,durationMs:clip.durationMs,
      sourceBeatIds:clip.beatIds,
      shots,
      openingState:first?.stateIn ?? "状态需确认",
      closingState:final?.stateOut ?? "状态需确认",
      sourceAfterReveal:clip.beatIds.flatMap(id => {
        const note=primaryMap.get(id)?.beat.audienceKnowledgeChange;
        return note ? [note] : [];
      })
    };
  });
  if (pendingParts.size) {
    throw new DomainValidationError("V8 详细剧本存在跨镜台词未说完，禁止进入 ProductDirector");
  }
  const totalLines = screenplayBeats.reduce((s,{beat})=>s+beat.dialogue.length,0);
  const coveredLines = [...seenLineCounts.values()].reduce((a,b)=>a+b,0);
  if (coveredLines !== totalLines) {
    throw new DomainValidationError(
      "V8 分镜丢失了详细剧本的原台词；原文共" + totalLines + "句，镜头覆盖" + coveredLines + "句"
    );
  }
  const base = {
    version:"v8-director-decision-1" as const,
    sourceScriptHash:input.script.contentHash,
    screenplayHash:hashValue(input.screenplay),
    modelDurationCapability:{minSeconds:input.modelMinSeconds,maxSeconds:input.modelMaxSeconds},
    targetDurationMs:input.script.targetDurationMs,
    clips,
    traceability:{
      totalLines,coveredLines,sourceBeats:sorted.length,
      coveredBeats:primaryMap.size
    },
    status:"DRAFT_NEEDS_VISUAL_DIRECTING" as const
  };
  return {...base,contentHash:hashValue(base)};
}
