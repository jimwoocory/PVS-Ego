import { hashValue } from "../../domain/hashing.js";
import type { ScriptDraft } from "../../domain/schemas.js";
import { extractV8DialogueLines } from "./v8-shot-prompt-shadow.js";
import { estimateV8SpeechMs, segmentV8SemanticSpeech } from "./v8-semantic-dialogue.js";

/**
 * Read-only V8 shot-first planning proof, not a ProductionPlan or permission
 * to generate video. Beat duration and dialogue are never silently altered.
 */
export type V8ShotPlanIssue = {
  code: string;
  beatId?: string;
  message: string;
};
export type V8PlannedShot = {
  id: string;
  beatId: string;
  order: number;
  startMs: number;
  endMs: number;
  function: "ESTABLISH" | "SPEECH" | "REACTION" | "ACTION";
  description: string;
  speaker?: string;
  dialogueText?: string;
  speechTimeEstimateMs?: number;
  /** Original uncut utterance; each split Shot retains a trace to the source. */
  sourceDialogueText?: string;
  speechPartIndex?: number;
  speechPartCount?: number;
};
export type V8PlannedClip = {
  id: string;
  order: number;
  durationMs: number;
  location: string;
  beatIds: string[];
  shots: V8PlannedShot[];
};
export type V8ShotFirstPreview = {
  version: "v8-shot-first-shadow-1";
  scriptHash: string;
  targetDurationMs: number;
  status: "PASS" | "BLOCKED";
  clips: V8PlannedClip[];
  issues: V8ShotPlanIssue[];
  actualClipCount: number;
  estimatedSpeechMs: number;
  contentHash: string;
};

function add(issues: V8ShotPlanIssue[], code: string, message: string, beatId?: string) {
  issues.push({ code, message, ...(beatId ? { beatId } : {}) });
}
type Beat = ScriptDraft["beats"][number];

function beatShots(beat: Beat, charsPerSecond: number, issues: V8ShotPlanIssue[]): V8PlannedShot[] {
  const intent = beat.videoIntent;
  const dialogue = intent?.dialogue ?? "";
  const spoken = extractV8DialogueLines(dialogue);
  const os = intent?.os;
  if (dialogue && spoken.length === 0) add(issues, "DIALOGUE_UNPARSEABLE", "台词没有明确的说话人或原文，无法精确分镜", beat.id);
  const voices = [...spoken, ...(os ? [{ speaker: "OS", text: os }] : [])];
  if (!voices.length) {
    return [{
      id: beat.id + ":action", beatId: beat.id, order: 1,
      startMs: 0, endMs: beat.estimatedDurationMs,
      function: "ACTION",
      description: intent?.storyAction ?? beat.text
    }];
  }
  const speechPlans = voices.map(line => segmentV8SemanticSpeech({
    text: line.text, charactersPerSecond: charsPerSecond, maxSpeechShotMs: 4200
  }));
  const durations = voices.map(line => estimateV8SpeechMs(line.text, charsPerSecond));
  const sumSpeech = durations.reduce((sum, time) => sum + time, 0);
  const slack = beat.estimatedDurationMs - sumSpeech;
  if (slack < 0) {
    add(issues, "SPEECH_TOO_LONG", "按正常语速估算，该段台词已超出原剧本时长，禁止通过加速吞字补齐", beat.id);
    return [];
  }
  // Never disguise non-speaking performance time as extra dialogue time.
  // Use the original story action and ending state to account for the slack.
  const intro = slack >= 1400 ? 800 : 0;
  let reaction = Math.min(900, slack - intro);
  let actingSpace = slack - intro - reaction;
  if (actingSpace > 0 && actingSpace < 400) {
    reaction += actingSpace; // Preserve the remainder without inventing a 0.1s cut.
    actingSpace = 0;
  }
  const shots: V8PlannedShot[] = [];
  let cursor = 0;
  const push = (
    fun: V8PlannedShot["function"], durationMs: number, description: string,
    speaker?: string, spokenText?: string, estimated?: number,
    source?: Pick<V8PlannedShot, "sourceDialogueText" | "speechPartIndex" | "speechPartCount">
  ) => {
    if (durationMs <= 0) return;
    shots.push({
      id: beat.id + ":" + (shots.length + 1),
      beatId: beat.id, order: shots.length + 1, startMs: cursor,
      endMs: cursor + durationMs, function: fun, description,
      ...(speaker ? { speaker } : {}),
      ...(spokenText ? { dialogueText: spokenText } : {}),
      ...(estimated ? { speechTimeEstimateMs: estimated } : {}),
      ...source
    });
    cursor += durationMs;
  };
  if (intro >= 400) push("ESTABLISH", intro,
    "依据原剧情建立人物和空间关系：" + (intent?.storyAction ?? beat.text));
  for (const [index, line] of voices.entries()) {
    const plan = speechPlans[index]!;
    if (plan.status !== "READY") {
      add(issues, "SEMANTIC_SPEECH_MANUAL_CUT",
        line.speaker + "的原句需要人工安排跨镜位置：" + (plan.reason ?? "暂无安全语义边界"), beat.id);
    }
    if (plan.parts.map(part => part.text).join("") !== line.text ||
        plan.parts.reduce((sum, part) => sum + part.durationMs, 0) !== durations[index]) {
      add(issues, "SEMANTIC_SPEECH_INTEGRITY",
        "语义拆镜必须逐字保留原句、准确保持总朗读时长", beat.id);
    }
    for (const part of plan.parts) {
      push("SPEECH", part.durationMs,
        (line.speaker === "OS" ? "原文画外/内心声音，角色不张口：" : "同一说话人连续对白，可切到听者反应：") +
        line.speaker + "：“" + part.text + "”" +
        (part.partCount > 1 ? "（原句语义段 " + part.partIndex + "/" + part.partCount + "）" : ""),
        line.speaker, part.text, part.durationMs,
        { sourceDialogueText: line.text, speechPartIndex: part.partIndex, speechPartCount: part.partCount });
    }
  }
  if (actingSpace > 0) push("ACTION", actingSpace,
    "只执行原剧本已明确的可见动作，不新增剧情：" + (intent?.storyAction ?? beat.text));
  if (reaction > 0) push("REACTION", reaction,
    "只执行原剧本的结束状态及听者反应：" + (intent?.stateOut ?? beat.text));
  if (shots.some(shot => shot.function === "SPEECH" && shot.endMs - shot.startMs > 4200)) {
    add(issues, "SPEECH_SHOT_REQUIRES_SPLIT",
      "自然语义边界不足，连续对白镜头仍超过4.2秒，需人工规划声音跨镜；不得截字或吞词", beat.id);
  }
  if (cursor !== beat.estimatedDurationMs) {
    add(issues, "SHOT_TIME_MISMATCH", "镜头时间分配未完全覆盖原 Beat 的时长", beat.id);
  }
  return shots;
}

/**
 * Refuses to merge across a location change, refuses >max and does not
 * automatically rewrite original dialogue or shave durations for fewer calls.
 */
export function planV8ShotFirstShadow(input: {
  script: ScriptDraft;
  modelMinSeconds: number;
  modelMaxSeconds: number;
  charactersPerSecond?: number;
}): V8ShotFirstPreview {
  const { script, modelMinSeconds, modelMaxSeconds } = input;
  const issues: V8ShotPlanIssue[] = [];
  if (!Number.isInteger(modelMinSeconds) || !Number.isInteger(modelMaxSeconds) ||
      modelMinSeconds < 1 || modelMaxSeconds < modelMinSeconds) {
    throw new Error("Invalid model duration capability");
  }
  const minMs = modelMinSeconds * 1000;
  const maxMs = modelMaxSeconds * 1000;
  const beats = [...script.beats].sort((a, b) => a.order - b.order);
  const groups: Beat[][] = [];
  for (const beat of beats) {
    if (beat.estimatedDurationMs > maxMs) {
      add(issues, "BEAT_TOO_LONG_FOR_CLIP",
        "原 Beat 超出模型最长生成时长。应先在句子/动作边界人工审查后拆分，不能截断台词", beat.id);
      continue;
    }
    if (beat.estimatedDurationMs % 1000 !== 0) {
      add(issues, "CLIP_SECONDS_NOT_INTEGER",
        "当前模型按整数秒生成；须经人工确认后调整分组，不自动修改原 Beat 的时长", beat.id);
      continue;
    }
    const last = groups.at(-1);
    const previous = last?.at(-1);
    // Only coalesce when a beat cannot meet the minimum on its own;
    // do not collapse separately performable story beats to fill 15 seconds.
    if (last && previous && beat.estimatedDurationMs < minMs &&
        previous.videoIntent?.location === beat.videoIntent?.location &&
        last.reduce((sum, b) => sum + b.estimatedDurationMs, 0) + beat.estimatedDurationMs <= maxMs) {
      last.push(beat);
    } else {
      groups.push([beat]);
    }
  }
  // Short opening beats can only be merged with the next compatible beat.
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const sum = group.reduce((acc, beat) => acc + beat.estimatedDurationMs, 0);
    if (sum >= minMs) continue;
    const right = groups[i + 1];
    const rightMs = right?.reduce((acc, beat) => acc + beat.estimatedDurationMs, 0) ?? 0;
    const sameLocation = Boolean(right?.length && group[0]?.videoIntent?.location === right[0]?.videoIntent?.location);
    if (right && sameLocation && sum + rightMs <= maxMs) {
      right.unshift(...group);
      groups.splice(i, 1);
      i -= 1;
      continue;
    }
    add(issues, "CLIP_TOO_SHORT", "该 Beat 无法形成符合模型最短时长的视频编号，需要导演重新安排切镜", group[0]?.id);
  }
  const clips: V8PlannedClip[] = [];
  let speechTotal = 0;
  for (const [clipIndex, group] of groups.entries()) {
    const durationMs = group.reduce((sum, beat) => sum + beat.estimatedDurationMs, 0);
    if (durationMs < minMs || durationMs > maxMs || durationMs % 1000 !== 0) continue;
    const shots: V8PlannedShot[] = [];
    let clipCursor = 0;
    for (const beat of group) {
      const planned = beatShots(beat, input.charactersPerSecond ?? 5.2, issues);
      for (const shot of planned) {
        shots.push({
          ...shot,
          order: shots.length + 1,
          startMs: shot.startMs + clipCursor,
          endMs: shot.endMs + clipCursor
        });
        speechTotal += shot.speechTimeEstimateMs ?? 0;
      }
      clipCursor += beat.estimatedDurationMs;
    }
    if (shots.length && (shots[0]?.startMs !== 0 || shots.at(-1)?.endMs !== durationMs ||
        shots.some((shot, index) => index > 0 && shots[index - 1]!.endMs !== shot.startMs))) {
      add(issues, "CLIP_SHOT_GAP", "视频编号中的镜头时间有断裂或覆盖不完整", group[0]?.id);
    }
    clips.push({
      id: "v8-shadow:clip:" + (clipIndex + 1),
      order: clipIndex + 1,
      durationMs,
      location: group[0]?.videoIntent?.location ?? "原剧本场景",
      beatIds: group.map(beat => beat.id),
      shots
    });
  }
  const sum = clips.reduce((total, clip) => total + clip.durationMs, 0);
  if (sum !== script.targetDurationMs) {
    add(issues, "TOTAL_DURATION_MISMATCH",
      "按原时长生成的有效视频编号不能完整覆盖总时长，请人工调整，不自动补空镜或删台词");
  }
  const base = {
    version: "v8-shot-first-shadow-1" as const,
    scriptHash: script.contentHash, targetDurationMs: script.targetDurationMs,
    status: (issues.length ? "BLOCKED" : "PASS") as V8ShotFirstPreview["status"],
    clips, issues, actualClipCount: clips.length, estimatedSpeechMs: speechTotal
  };
  return { ...base, contentHash: hashValue(base) };
}
