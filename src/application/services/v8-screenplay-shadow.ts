import { hashValue } from "../../domain/hashing.js";
import type { ScriptDraft } from "../../domain/schemas.js";
import { extractV8DialogueLines } from "./v8-shot-prompt-shadow.js";

/**
 * Source-faithful screenplay transcription of legacy ScriptDraft Beat data.
 * This stage must NOT invent motivations, unseen scenes, dialogue or reveals.
 * Actual creative Screenplay V8 generation will be a separate opt-in pipeline.
 */
export type V8SceneDialogue = {
  lineId: string;
  sourceBeatId: string;
  speakerName: string;
  mode: "ONSCREEN" | "OS";
  exactText: string;
  deliveryStatus: "NOT_SPECIFIED";
  voiceBindingStatus: "NOT_SPECIFIED";
};
export type V8SceneBeat = {
  beatId: string;
  order: number;
  purpose: string;
  action: string;
  sourceText: string;
  estimatedDurationMs: number;
  sourceFactIds: string[];
  lines: V8SceneDialogue[];
  audienceReveal?: { event: string; timing: string };
  actorMotivation?: string;
};
export type V8ScreenplayScene = {
  sceneId: string;
  sceneNo: number;
  interiorExterior: "UNSPECIFIED";
  location: string;
  timeOfDay: "UNSPECIFIED";
  plannedDurationMs: number;
  beats: V8SceneBeat[];
  sourceBeatIds: string[];
};
export type V8ScreenplayIssue = {
  code: "BEAT_ACTION_MISSING" | "DIALOGUE_UNPARSEABLE" | "MOTIVATION_NOT_EXPLICIT" |
    "REVEAL_TIMING_NOT_EXPLICIT" | "LOCATION_NOT_EXPLICIT";
  level: "BLOCKER" | "REVIEW";
  beatId?: string;
  message: string;
};
export type V8ScreenplayShadow = {
  version: "v8-screenplay-shadow-1";
  scriptRef: { id: string; version: number; contentHash: string };
  scriptTargetMs: number;
  scenes: V8ScreenplayScene[];
  dialogueLineCount: number;
  originalBeatCount: number;
  transcribedBeatCount: number;
  issues: V8ScreenplayIssue[];
  status: "BLOCKED" | "REVIEW_REQUIRED" | "TRANSCRIBED";
  contentHash: string;
};
function appendIssue(issues: V8ScreenplayIssue[], code: V8ScreenplayIssue["code"],
    level: V8ScreenplayIssue["level"], message: string, beatId?: string) {
  issues.push({ code, level, message, ...(beatId ? { beatId } : {}) });
}

/** A deterministic legacy-to-V8 shadow view, NOT a replacement ScriptDraft. */
export function buildV8ScreenplayShadow(script: ScriptDraft): V8ScreenplayShadow {
  const ordered = [...script.beats].sort((a,b) => a.order - b.order);
  const scenes: V8ScreenplayScene[] = [];
  const issues: V8ScreenplayIssue[] = [];
  let dialogueLineCount = 0;
  for (const beat of ordered) {
    const intent = beat.videoIntent;
    const location = intent?.location?.trim() ?? "";
    if (!location) appendIssue(issues, "LOCATION_NOT_EXPLICIT", "REVIEW",
      "原剧本未标明准确场景位置，不能由分镜自行发明", beat.id);
    const storyAction = intent?.storyAction?.trim();
    if (!storyAction) appendIssue(issues, "BEAT_ACTION_MISSING", "BLOCKER",
      "Beat 缺少独立可表演动作，当前只有概括性段落文本", beat.id);
    const spoken = extractV8DialogueLines(intent?.dialogue ?? "");
    if (intent?.dialogue?.trim() && !spoken.length) {
      appendIssue(issues, "DIALOGUE_UNPARSEABLE", "BLOCKER",
        "未能从剧本台词中识别说话人；必须人工确认，不可猜测声音归属", beat.id);
    }
    const lines: V8SceneDialogue[] = spoken.map((line,i) => ({
      lineId: beat.id + ":dialogue:" + (i + 1),
      sourceBeatId: beat.id,
      speakerName: line.speaker,
      mode: "ONSCREEN",
      exactText: line.text,
      deliveryStatus: "NOT_SPECIFIED",
      voiceBindingStatus: "NOT_SPECIFIED"
    }));
    if (intent?.os) lines.push({
      lineId: beat.id + ":os:1", sourceBeatId: beat.id, speakerName: "OS",
      mode: "OS", exactText: intent.os,
      deliveryStatus: "NOT_SPECIFIED",
      voiceBindingStatus: "NOT_SPECIFIED"
    });
    dialogueLineCount += lines.length;
    // A single implicit scene can contain several Beats. A change in explicit
    // location starts another scene; lack of an explicit place is not "卧室".
    const last = scenes.at(-1);
    const reuse = last && last.location === (location || "位置待确认");
    const scene: V8ScreenplayScene = reuse ? last : {
      sceneId: "v8:scene:" + (scenes.length + 1),
      sceneNo: scenes.length + 1,
      interiorExterior: "UNSPECIFIED",
      location: location || "位置待确认",
      timeOfDay: "UNSPECIFIED",
      plannedDurationMs: 0,
      beats: [],
      sourceBeatIds: []
    };
    if (!reuse) scenes.push(scene);
    scene.beats.push({
      beatId: beat.id,
      order: beat.order,
      purpose: beat.purpose,
      action: storyAction || beat.text,
      sourceText: beat.text,
      estimatedDurationMs: beat.estimatedDurationMs,
      sourceFactIds: [...beat.requiredFactIds],
      lines
    });
    scene.plannedDurationMs += beat.estimatedDurationMs;
    scene.sourceBeatIds.push(beat.id);
    // Intentionally no fabricated character goal / reveal timing: if a beat
    // appears to reveal or hide something, we flag absent stage direction.
    if (/(?:揭晓|答案|谜底|真相|秘密|破案|误会|发现)/.test(
      (intent?.storyAction ?? "") + " " + beat.text
    )) appendIssue(issues, "REVEAL_TIMING_NOT_EXPLICIT", "REVIEW",
      "可能涉及观众知情节点；原 Beat 未明确揭晓的镜头边界，需导演标注", beat.id);
    if (/(?:问|答|拒绝|猜|怀疑|误会|纠结|决定)/.test(
      (intent?.storyAction ?? "") + " " + beat.text
    )) appendIssue(issues, "MOTIVATION_NOT_EXPLICIT", "REVIEW",
      "人物行动与台词已有记录，但目标和阻碍尚未作为可审核的独立剧本字段", beat.id);
  }
  const total = scenes.reduce((sum,scene)=>sum+scene.plannedDurationMs,0);
  if (total !== script.targetDurationMs) {
    appendIssue(issues, "BEAT_ACTION_MISSING", "BLOCKER", "场次累计时长与源剧本不一致");
  }
  const base = {
    version: "v8-screenplay-shadow-1" as const,
    scriptRef: { id: script.id, version: script.version, contentHash: script.contentHash },
    scriptTargetMs: script.targetDurationMs,
    scenes, dialogueLineCount, originalBeatCount: ordered.length,
    transcribedBeatCount: scenes.reduce((sum,scene)=>sum+scene.beats.length,0),
    issues,
    status: (issues.some(issue=>issue.level==="BLOCKER") ? "BLOCKED" :
      issues.length ? "REVIEW_REQUIRED" : "TRANSCRIBED") as V8ScreenplayShadow["status"]
  };
  return { ...base, contentHash: hashValue(base) };
}
