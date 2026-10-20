import { hashValue } from "../../domain/hashing.js";
import type { ProductionPlan } from "../../domain/schemas.js";
import type { V8DirectorDecision } from "./v8-director-decision.js";
import { DomainValidationError } from "../../domain/validation.js";

export type V8ConformanceIssue = {
  code: "SCRIPT_HASH_DRIFT" | "CLIP_COUNT_DRIFT" | "CLIP_DURATION_DRIFT" |
    "CLIP_BEAT_DRIFT" | "SHOT_COUNT_DRIFT" | "SHOT_TIME_DRIFT" |
    "SHOT_METADATA_MISSING" | "SHOT_SOURCE_DRIFT" | "SPEAKER_OR_VOICE_DRIFT" |
    "NEW_DIALOGUE_NOT_IN_SOURCE" | "REVEAL_TIMING_DRIFT" | "ACTION_DRIFT" | "SOUND_DRIFT" | "POST_CUE_DRIFT" | "LOCATION_DRIFT";
  clipOrder?: number;
  shotOrder?: number;
  message: string;
};
export type V8ConformanceReport = {
  version: "v8-director-conformance-1";
  passed: boolean;
  lockedClips: number;
  lockedShots: number;
  issues: V8ConformanceIssue[];
  contentHash: string;
};
/**
 * Strict consistency Gate for the opt-in V8 director pipeline. ProductDirector
 * is free to select shot size, camera and lighting, but CANNOT rewrite the
 * director's timing, scene order, speaker, voice mode or audience reveals.
 */
export function reviewV8DirectorConformance(decision: V8DirectorDecision, plan: ProductionPlan): V8ConformanceReport {
  const issues: V8ConformanceIssue[] = [];
  const block = (code:V8ConformanceIssue["code"],message:string,clipOrder?:number,shotOrder?:number) =>
    issues.push({code,message,...(clipOrder?{clipOrder}:{}),...(shotOrder?{shotOrder}:{})});
  if (plan.scriptRef.hash !== decision.sourceScriptHash) {
    block("SCRIPT_HASH_DRIFT","ProductDirector 生成的正式分镜不再引用 V8 的源剧本版本");
  }
  const actualClips=plan.scenes.flatMap(scene=>scene.clips);
  const locations=plan.scenes.flatMap(scene=>scene.clips.map(()=>scene.location));
  if (actualClips.reduce((n,c)=>n+c.durationMs,0) !== decision.targetDurationMs) {
    block("CLIP_DURATION_DRIFT","正式视频总时长必须精确等于已确认剧本目标时长");
  }
  if (actualClips.length!==decision.clips.length) {
    block("CLIP_COUNT_DRIFT","ProductDirector 修改了已锁定的视频编号数量");
  }
  for(const [i,required] of decision.clips.entries()) {
    const actual=actualClips[i], clipNo=i+1;
    if(!actual)continue;
    if (required.shots.some(s=>s.ambience !== undefined) && locations[i] !== required.location) {
      block("LOCATION_DRIFT","视频编号"+clipNo+"的实际场景不属于来源剧本",clipNo);
    }
    if(actual.durationMs!==required.durationMs) {
      block("CLIP_DURATION_DRIFT","视频编号"+clipNo+"的时长被独立导演修改",clipNo);
    }
    if(actual.sourceBeatIds.join("|")!==required.sourceBeatIds.join("|")) {
      block("CLIP_BEAT_DRIFT","视频编号"+clipNo+"未沿用原导演 Beat 顺序",clipNo);
    }
    if(actual.segments.length!==required.shots.length) {
      block("SHOT_COUNT_DRIFT","视频编号"+clipNo+"的实际 Shot 数与冻结导演表不一致",clipNo);
    }
    for(const [j,expected] of required.shots.entries()) {
      const segment=actual.segments[j], shotNo=j+1;
      if(!segment)continue;
      if(segment.startMs!==expected.startMs || segment.endMs!==expected.endMs) {
        block("SHOT_TIME_DRIFT","第"+clipNo+"段镜头"+shotNo+"的起止时长已改变",clipNo,shotNo);
      }
      if(!segment.v8){
        block("SHOT_METADATA_MISSING","第"+clipNo+"段镜头"+shotNo+"缺少来源与演员声音锁定信息",clipNo,shotNo);
        continue;
      }
      const v8=segment.v8;
      // Formal V8 decisions carry these source obligations. Older shadow
      // fixtures remain readable, but cannot be formally adopted by SmartRun.
      if (expected.ambience !== undefined) {
        if (segment.subjectAction !== expected.visibleAction) block("ACTION_DRIFT","第"+clipNo+"段镜头"+shotNo+"的实际演员动作被改写；请将视觉细化放入构图字段",clipNo,shotNo);
        const sounds=[...expected.ambience,...(expected.sfx??[])];
        if (sounds.length ? segment.ambientSound.kind !== "AMBIENT" ||
            segment.ambientSound.description !== sounds.join("；") : segment.ambientSound.kind !== "NONE") {
          block("SOUND_DRIFT","第"+clipNo+"段镜头"+shotNo+"的环境声或物理音效缺失/新增，禁止自动替换为背景音乐",clipNo,shotNo);
        }
        const cues=segment.postProductionText;
        if (hashValue(cues.map(c=>c.text)) !== hashValue(expected.postProductionText??[]) ||
            cues.some(c=>!c.sourceBeatIds.includes(expected.sourceBeatId) || c.startMs < segment.startMs || c.endMs > segment.endMs)) {
          block("POST_CUE_DRIFT","第"+clipNo+"段镜头"+shotNo+"的后期文字或来源/时间窗丢失，请保留完整原文",clipNo,shotNo);
        }
      }
      if(v8.sourceShotId!==expected.shotId || v8.sourceBeatId!==expected.sourceBeatId ||
          v8.sourceActionHash!==hashValue(expected.visibleAction) ||
          v8.shotFunction!==expected.shotFunction ||
          !segment.sourceBeatIds.includes(expected.sourceBeatId)) {
        block("SHOT_SOURCE_DRIFT","第"+clipNo+"段镜头"+shotNo+"的来源动作或镜头 ID 不一致",clipNo,shotNo);
      }
      if(expected.spoken){
        const original=expected.spoken;
        if(!v8.spoken || v8.spoken.speaker!==original.speaker ||
          v8.spoken.mode!==original.mode ||
          v8.spoken.exactText!==original.exactText ||
          v8.spoken.tone!==original.tone ||
          v8.spoken.delivery!==original.delivery ||
          (original.sourceLineText !== undefined &&
            v8.spoken.sourceLineText !== original.sourceLineText) ||
          (original.sourcePartIndex !== undefined &&
            v8.spoken.sourcePartIndex !== original.sourcePartIndex) ||
          (original.sourcePartCount !== undefined &&
            v8.spoken.sourcePartCount !== original.sourcePartCount)) {
          block("SPEAKER_OR_VOICE_DRIFT","第"+clipNo+"段镜头"+shotNo+"台词、人物或原始配音指令被改变",clipNo,shotNo);
        }
        const dialogue=segment.dialogueOrNarration;
        if(dialogue.kind==="NONE" ||
          (original.mode==="OS" && dialogue.kind!=="NARRATION") ||
          (original.mode!=="OS" && dialogue.kind!=="DIALOGUE") ||
          !("text" in dialogue && (original.mode === "OS"
            ? dialogue.text === original.exactText
            : dialogue.text === original.speaker + '：“' + original.exactText + '”' ||
              dialogue.text === original.speaker + ':"' + original.exactText + '"'))) {
          block("SPEAKER_OR_VOICE_DRIFT","镜头声音内容或画外/OS 模式与原台词不符",clipNo,shotNo);
        }
        if (expected.ambience !== undefined && dialogue.kind !== "NONE" &&
            (dialogue.estimatedDurationMs < original.speechEstimatedMs ||
             dialogue.estimatedDurationMs > segment.endMs-segment.startMs)) {
          block("SPEAKER_OR_VOICE_DRIFT","第"+clipNo+"段镜头"+shotNo+"的朗读预算不足或超出镜头时长，不得靠吞字加速通过",clipNo,shotNo);
        }
      } else if(v8.spoken || segment.dialogueOrNarration.kind!=="NONE"){
        block("NEW_DIALOGUE_NOT_IN_SOURCE","非对白镜头擅自新增了台词或旁白",clipNo,shotNo);
      }
      if((expected.audienceKnowledgeChange??"")!==(v8.audienceKnowledgeChange??"")){
        block("REVEAL_TIMING_DRIFT","第"+clipNo+"段镜头"+shotNo+"的观众知情时机被改变",clipNo,shotNo);
      }
    }
  }
  const base={
    version:"v8-director-conformance-1" as const,
    passed:issues.length===0,
    lockedClips:decision.clips.length,
    lockedShots:decision.clips.reduce((n,clip)=>n+clip.shots.length,0),
    issues
  };
  return {...base,contentHash:hashValue(base)};
}
export function assertV8DirectorConformance(decision:V8DirectorDecision,plan:ProductionPlan):void{
  const result=reviewV8DirectorConformance(decision,plan);
  if(!result.passed){
    throw new DomainValidationError(
      "V8 Director 与 ProductDirector 结果不一致，拒绝进入生成：" +
        result.issues.slice(0,5).map(issue=>issue.message).join("；")
    );
  }
}
