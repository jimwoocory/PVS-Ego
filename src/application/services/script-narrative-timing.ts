import type { ScriptDraft } from "../../domain/schemas.js";
import type { ScriptFeasibilityIssue } from "../../domain/director-v3.js";

type Beat = ScriptDraft["beats"][number];

export const SCRIPT_TOTAL_DURATION_TOLERANCE = 0.10;

export function isScriptDurationWithinTolerance(targetMs: number, actualMs: number): boolean {
  return Number.isFinite(targetMs) && Number.isFinite(actualMs) &&
    targetMs > 0 && Math.abs(actualMs - targetMs) <= Math.round(targetMs * SCRIPT_TOTAL_DURATION_TOLERANCE);
}

export type NarrativeBeatTiming = {
  beatId: string;
  order: number;
  assignedMs: number;
  estimatedSpeechMs: number;
  estimatedActionMs: number;
  minimumPlausibleMs: number;
  sceneChanged: boolean;
};

export type NarrativeTimingAudit = {
  totalMs: number;
  allowedMinMs: number;
  allowedMaxMs: number;
  beats: NarrativeBeatTiming[];
  issues: ScriptFeasibilityIssue[];
};

const transitionCue = /(?:来[到至]|走[进到出]|进[入了]|回[到家]|抵达|赶[到往]|转[到入]|离[开去]|移[到入]|进入|已在|来到|随后|片刻后|次日|翌日|同日|当晚|入夜|从.+到|切换到|与此同时|转眼)/;
const deliberateHold = /(?:沉默|停顿|停住|久久|迟疑|注视|凝视|犹豫|等待|安静|望着|回忆|沉思|特意停留|长时间|无言|屏息|缓缓)/;
const normalized = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

function speechUnits(text: string): number {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latinWords = text.match(/[A-Za-z]+/g) ?? [];
  const otherNumbers = (text.match(/\d+/g) ?? []).length;
  return han + latinWords.reduce((sum, word) => sum + Math.max(1, Math.ceil(word.length / 5)), 0)
    + otherNumbers * 1.5;
}

function countActions(beat: Beat): number {
  const action = beat.videoIntent?.storyAction?.trim() || beat.text;
  const clauses = action.split(/(?:，|,|；|;|、|然后|随后|接着|并且|同时|再)/)
    .map(part => part.trim()).filter(Boolean);
  return Math.max(1, Math.min(6, clauses.length));
}

/**
 * Deterministic preflight, not an AI assessment of writing quality.
 * Treat the speech estimate as a conservative lower bound, not a duration
 * to blindly add on top of action time: characters may act while talking.
 * Narrative intent, motive, exact dialogue and state continuity are also
 * explicitly requested from the authoring/repair models and reviewed by users.
 */
export function auditNarrativeTiming(
  input: Pick<ScriptDraft, "targetDurationMs" | "beats">
): NarrativeTimingAudit {
  const beats = input.beats;
  const totalMs = beats.reduce((sum, beat) => sum + beat.estimatedDurationMs, 0);
  const toleranceMs = Math.round(input.targetDurationMs * SCRIPT_TOTAL_DURATION_TOLERANCE);
  const issues: ScriptFeasibilityIssue[] = [];
  const add = (code: ScriptFeasibilityIssue["code"], beatIds: string[], message: string, suggestion: string) =>
    issues.push({ code, severity: "REVISE", beatIds, message, suggestion });

  if (beats.length >= 4 && beats.every(beat =>
    Math.abs(beat.estimatedDurationMs - beats[0]!.estimatedDurationMs) <= 100)) {
    add("BEAT_DURATION_UNIFORM", beats.map(beat => beat.id),
      "整部剧本的剧情段落被机械均分，尚不能证明每段对白、动作和反应都需要相同时间。",
      "根据每段准确台词的自然朗读、人物实际动作、观众理解节点及转场分别估时，不得平均分配总时长。");
  }

  const audits: NarrativeBeatTiming[] = [];
  for (const [index, beat] of beats.entries()) {
    const intent = beat.videoIntent;
    const previous = beats[index - 1]?.videoIntent;
    const sceneChanged = Boolean(index > 0 && intent?.location && previous?.location &&
      intent.location.trim() !== previous.location.trim());
    const spokenText = [intent?.dialogue, intent?.os].filter(Boolean).join(" ");
    const units = speechUnits(spokenText);
    const punctuationPauses = Math.min(4, (spokenText.match(/[，,。！？!?；;：:]/g) ?? []).length);
    const speechMs = units > 0 ? Math.ceil((units / 4.5) * 1000 + punctuationPauses * 130 + 260) : 0;
    const actionCount = countActions(beat);
    const actionMs = 1500 + Math.max(0, actionCount - 1) * 1050;
    const minimumMs = Math.max(speechMs, actionMs) + (speechMs ? 650 : 400) +
      (sceneChanged ? 650 : 0);
    audits.push({
      beatId: beat.id, order: beat.order, assignedMs: beat.estimatedDurationMs,
      estimatedSpeechMs: speechMs, estimatedActionMs: actionMs,
      minimumPlausibleMs: minimumMs, sceneChanged
    });

    const minGap = Math.max(900, Math.round(minimumMs * 0.12));
    if (beat.estimatedDurationMs < minimumMs - minGap) {
      add(speechMs >= actionMs ? "BEAT_SPEECH_OVERLOAD" : "BEAT_ACTION_OVERLOAD", [beat.id],
        speechMs >= actionMs
          ? "这一段的对白或旁白预计无法在安排的时间内自然说完，同时完成必要反应。"
          : "这一段的主要动作、场景变化和反应所需时间超过了当前分配。",
        "核实实际台词、语气和动作是否可并行，增加时间或精简非必要动作，保留故事原意。");
    }

    // A long Beat written as a short vague caption is not production-ready.
    // Short intentional reaction Beats and legacy 21-second fixture scripts are not penalized.
    if (input.targetDurationMs >= 30000 && beat.estimatedDurationMs >= 6000 &&
        speechUnits(beat.text) < 25 &&
        !deliberateHold.test(beat.text)) {
      add("NARRATIVE_DESCRIPTION_THIN", [beat.id],
        "这一段占用较长时间，却没有写清楚足够的具体可见剧情。",
        "明确人物与地点、当前目标和情绪、实际动作及对方反应、如何承接上一段和推动下一段；不要只写一句概述。");
    }
    if (sceneChanged && !transitionCue.test([beat.text, intent?.storyAction].join(" "))) {
      add("NARRATIVE_TRANSITION_UNCLEAR", [beat.id],
        "前后段切换了地点，但剧情没有说明人物如何进入新场景或时间如何衔接。",
        "写明必要的转场或时间连接信息、人物到位与前后状态；不必增加无意义的空镜。");
    }
    if (index > 0 && normalized(beat.text).length > 3 &&
        normalized(beat.text) === normalized(beats[index - 1]!.text)) {
      add("NARRATIVE_DUPLICATE_BEAT", [beats[index - 1]!.id, beat.id],
        "相邻两段剧情文字重复，没有新的动作、信息或人物选择。",
        "合并重复片段，或说明新的冲突、反应、结果以及观众获知的新信息。");
    }
    if (beat.estimatedDurationMs >= Math.max(8500, minimumMs * 3) &&
        speechUnits(beat.text) < 22 && !deliberateHold.test(beat.text)) {
      add("BEAT_DURATION_IDLE", [beat.id],
        "这一段时长远长于当前对白和具体动作可解释的时间。",
        "补足真实的动作/人物反应/有意义的停顿，或者减少时长；不要靠空镜凑满用户目标。");
    }
  }
  return {
    totalMs,
    allowedMinMs: input.targetDurationMs - toleranceMs,
    allowedMaxMs: input.targetDurationMs + toleranceMs,
    beats: audits,
    issues
  };
}
