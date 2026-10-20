import type { ArtifactRecord, Clip, ProductTruth, ScriptDraft, ProductionPlan, Timeline, TimelineAudioItem, TimelineTextItem } from "../../domain/schemas.js";
import { timelineSchema } from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { AutoEditBlocked, autoEditPlanSchema, type AutoEditPlan, type PostProductionSettings } from "../../domain/auto-edit.js";
import type { MediaInfo } from "../../adapters/media/inspect-media.js";
import type { VisualClipAssessmentResult } from "./visual-edit-assessment.js";
import { resolveRenderTarget } from "./render-target.js";
import { timelineDecisionHash, timelineDurationMs } from "./timeline-service.js";
import { duckingEnvelope } from "./audio-envelope.js";

export const AUTO_EDIT_PLANNER_VERSION = "rule-based-auto-edit-v2-audio";

export type AutoEditSource = {
  clip: Clip;
  attemptId: string;
  artifact: ArtifactRecord & { sha256: string };
  media: MediaInfo;
  visualAssessment?: VisualClipAssessmentResult;
  visualWarning?: string;
};
export type PreparedAudio = { segmentId?: string; kind: "NARRATION" | "AMBIENT" | "BGM"; artifact: ArtifactRecord & { sha256: string };
  media: MediaInfo; inMs: number; outMs: number; volume: number; synthesized?: boolean; voiceName?: string };

/** Approximate display-width wrapping; never truncates the approved caption text. */
export function captionChunks(text: string): string[] {
  const chunks: string[] = []; let lines: string[] = [], line = "", units = 0;
  const flushLine = () => { if (line) lines.push(line); line = ""; units = 0; if (lines.length === 2) { chunks.push(lines.join("\n")); lines = []; } };
  for (const character of Array.from(text.replaceAll("\r", ""))) {
    if (character === "\n") { flushLine(); continue; }
    const weight = /[\u0020-\u007e]/.test(character) ? 0.6 : 1;
    if (units + weight > 18) flushLine();
    line += character; units += weight;
  }
  flushLine(); if (lines.length) chunks.push(lines.join("\n"));
  return chunks.filter(v => v.trim());
}
function reference(entityType: string, item: { id: string; version: number; contentHash: string }) {
  return { entityType, entityId: item.id, version: item.version, hash: item.contentHash };
}

export function planAutoEdit(input: {
  operationKey: string; truth: ProductTruth; script: ScriptDraft; plan: ProductionPlan;
  sources: AutoEditSource[]; audio: PreparedAudio[]; settings: PostProductionSettings;
  targetDurationMs: number; referenceVideoProfileHash?: string; fallbackAspectRatio?: string; now?: string
}): AutoEditPlan {
  const { sources, settings, plan, script, truth, audio } = input;
  if (!sources.length) throw new AutoEditBlocked("NO_ACCEPTED_VIDEO", "自动剪辑至少需要一个已采用的视频");
  if ([truth.status, script.status, plan.status].some(v => v !== "CONFIRMED")) throw new AutoEditBlocked("UNCONFIRMED_INPUT", "自动剪辑需要已确认的事实、脚本和导演方案");
  const id = "auto-edit-" + input.operationKey;
  const now = input.now ?? new Date().toISOString();
  const trackId = (name: string) => id + "-" + name;
  const config = resolveRenderTarget(plan.generationTarget?.aspectRatio ?? input.fallbackAspectRatio ?? "9:16", plan.generationTarget?.videoResolution ?? "720p", sources[0]!.media);
  const timeline: Timeline = timelineSchema.parse({ id: "timeline-" + input.operationKey, projectId: truth.projectId, version: 1,
    status: "DRAFT", productionPlanHash: plan.contentHash, renderConfig: config,
    tracks: [
      { id: trackId("video"), kind: "VIDEO", order: 0, label: "主视频" },
      { id: trackId("narration"), kind: "AUDIO", order: 1, label: "旁白 / 对话" },
      { id: trackId("sfx"), kind: "AUDIO", order: 2, label: "场景音效" },
      { id: trackId("bgm"), kind: "AUDIO", order: 3, label: "背景音乐" },
      { id: trackId("text"), kind: "TEXT", order: 4, label: "字幕 / 行动引导" }
    ], clips: [], audioItems: [], textItems: [], repairMasks: [], contentHash: "0".repeat(64), createdAt: now, updatedAt: now });
  const warnings: string[] = [], rationale: string[] = [];
  const speechRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0, audible = false, plannedCtaAdded = false;
  const addText = (
    text: string,
    startMs: number,
    endMs: number,
    kind: TimelineTextItem["kind"],
    options?: { position?: TimelineTextItem["position"]; fontScale?: number }
  ) => {
    const chunks = captionChunks(text); if (!chunks.length || endMs <= startMs) return;
    if ((endMs - startMs) / chunks.length < 180) throw new AutoEditBlocked("CAPTION_TOO_DENSE", "字幕内容过密，无法完整呈现；请调整脚本或字幕设置");
    chunks.forEach((chunk, index) => timeline.textItems.push({ id: id + "-text-" + timeline.textItems.length,
      kind, text: chunk, startMs: startMs + Math.round((endMs - startMs) * index / chunks.length),
      endMs: startMs + Math.round((endMs - startMs) * (index + 1) / chunks.length), trackId: trackId("text"), order: timeline.textItems.length,
      position: options?.position ?? (kind === "CTA" ? "TOP" : "BOTTOM"),
      fontScale: options?.fontScale ?? 1, deleted: false }));
  };
  const addAudio = (prepared: PreparedAudio, startMs: number, endMs: number) => {
    const duration = prepared.outMs - prepared.inMs;
    if (duration <= 0 || prepared.outMs > prepared.media.durationMs || !prepared.media.hasAudio) throw new AutoEditBlocked("INVALID_AUDIO", "音频素材不可用或裁剪范围无效", true);
    if (prepared.kind === "NARRATION" && duration > endMs - startMs) throw new AutoEditBlocked("NARRATION_TOO_LONG", "旁白实际时长超出分镜时段；不会截断台词，请调整语速或提供更短的配音", true);
    const role = prepared.kind === "AMBIENT" ? "SFX" : prepared.kind;
    const item: TimelineAudioItem = { id: id + "-audio-" + timeline.audioItems.length, role,
      sourceArtifactId: prepared.artifact.id, sourceArtifactHash: prepared.artifact.sha256, sourceDurationMs: prepared.media.durationMs,
      inMs: prepared.inMs, outMs: prepared.inMs + Math.min(duration, endMs - startMs), startMs,
      trackId: trackId(role.toLowerCase()), order: timeline.audioItems.length, deleted: false,
      audio: { muted: false, volume: prepared.volume, keyframes: [] } };
    timeline.audioItems.push(item); audible ||= prepared.volume > 0;
    return item;
  };
  for (const source of sources) {
    const { clip, media } = source;
    if (!media.hasVideo || media.durationMs <= 0) throw new AutoEditBlocked("INVALID_VIDEO", "已采用产物不是可播放的视频");
    if (plan.v8Source && clip.segments.some(s=>s.v8?.spoken || s.ambientSound.kind !== "NONE") && !media.hasAudio) {
      throw new AutoEditBlocked("V8_NATIVE_AUDIO_REQUIRED", "V8 原生对白/环境声音轨缺失，请人工核查原视频；不能静默转成本地配音或无声成片", true);
    }
    if (media.durationMs + 100 < clip.durationMs) throw new AutoEditBlocked("VIDEO_TOO_SHORT", "已采用视频短于导演镜头，不能静默裁掉动作和台词；请在手工时间线调整");
    let inMs = 0;
    let outMs = Math.min(clip.durationMs, media.durationMs);
    const visual = source.visualAssessment;
    if (visual?.assessment.autoAcceptEligible) {
      const window = visual.selectedWindow;
      if (
        window.inMs < 0 ||
        window.outMs > media.durationMs ||
        window.outMs - window.inMs !== clip.durationMs
      ) {
        throw new AutoEditBlocked("VISUAL_WINDOW_INVALID", "视觉 AI 推荐的剪辑窗口与导演时长或实际视频不一致，已阻止自动裁剪");
      }
      inMs = window.inMs;
      outMs = window.outMs;
      rationale.push(
        `镜头 ${timeline.clips.length + 1}：视觉 AI 高置信通过，按已审计候选窗口保留源视频 ${inMs}–${outMs}ms；不改变导演镜头时长。`
      );
    } else {
      if (visual) {
        warnings.push(
          `镜头 ${clip.id} 的视觉 AI 结果为 ${visual.assessment.status}/${visual.assessment.confidence}；用户已人工采用该结果，因此保留原始起点，不让 AI 覆盖人工决定。原因：${visual.assessment.reasons.join("；")}`
        );
      }
      if (source.visualWarning) {
        warnings.push(`镜头 ${clip.id} 视觉 AI 未完成：${source.visualWarning}；保留规则剪辑起点。`);
      }
      rationale.push(
        `镜头 ${timeline.clips.length + 1}：沿用当前人工审片结果及导演顺序，保留源视频 0–${outMs}ms；没有可用的高置信视觉裁剪结论。`
      );
    }
    const usedDurationMs = outMs - inMs;
    const replaceVoice = settings.narrationMode === "LOCAL_TTS" || settings.narrationMode === "PROVIDED";
    const replacedSegments = clip.segments.filter(s => s.dialogueOrNarration.kind !== "NONE" &&
      (replaceVoice || audio.some(a => a.kind === "NARRATION" && a.segmentId === s.id)));
    const replacedIds = new Set(replacedSegments.map(s => s.id));
    const replacedWindows = replacedSegments.map(s => ({ start: s.startMs, end: Math.min(usedDurationMs, s.endMs) }));
    // Keyframes are local to the trimmed clip after source inMs is applied.
    const sourceAvailable = media.hasAudio && settings.sourceVolume > 0;
    audible ||= sourceAvailable && clip.segments.some(s => !replacedIds.has(s.id));
    timeline.clips.push({ id: id + "-clip-" + timeline.clips.length, sourceClipId: clip.id,
      sourceArtifactId: source.artifact.id, sourceArtifactHash: source.artifact.sha256, sourceDurationMs: media.durationMs,
      inMs, outMs, trackId: trackId("video"), order: timeline.clips.length, deleted: false,
      transition: { type: "CUT", durationMs: 0 }, audio: { muted: false, volume: settings.sourceVolume,
        keyframes: replacedWindows.length ? duckingEnvelope({ durationMs: usedDurationMs, volume: settings.sourceVolume, windows: replacedWindows, gain: 0, attackMs: 10, releaseMs: 30 }) : [] }, captions: [] });
    for (const segment of clip.segments) {
      const start = cursor + segment.startMs, end = cursor + Math.min(segment.endMs, usedDurationMs);
      const sourceSound = sourceAvailable && !replacedIds.has(segment.id);
      const narration = audio.find(a => a.segmentId === segment.id && a.kind === "NARRATION");
      if (segment.dialogueOrNarration.kind !== "NONE") {
        if (end <= start) throw new AutoEditBlocked("SPEECH_OUTSIDE_VIDEO", "台词超出可用视频范围", true);
        if (narration) addAudio(narration, start, end);
        else if (!sourceSound && !settings.allowSilentOutput) throw new AutoEditBlocked("NARRATION_REQUIRED", "镜头缺少旁白音频，请启用本地配音、提供音频，或明确选择无声成片", true);
        else if (!sourceSound) warnings.push(`镜头 ${clip.id} 台词仅作为字幕，用户明确允许无声输出。`);
        const captionEnd = narration ? start + narration.outMs - narration.inMs : end;
        speechRanges.push({ start, end: captionEnd });
        if (settings.captions) addText(segment.dialogueOrNarration.text, start, captionEnd, "CAPTION");
      }
      const ambient = audio.find(a => a.segmentId === segment.id && a.kind === "AMBIENT");
      if (ambient) addAudio(ambient, start, end);
      else if (segment.ambientSound.kind !== "NONE" && !sourceSound) {
        if (!settings.omitMissingEffects && !settings.allowSilentOutput) throw new AutoEditBlocked("AMBIENT_REQUIRED", "分镜要求场景音效，但当前无对应音频；请提供音效或明确略过缺失音效", true);
        warnings.push(`分段 ${segment.id} 的场景音效未补齐；用户已明确允许略过。`);
      }
      // Backward compatibility: ProductionPlan versions persisted before RC2
      // do not contain postProductionText. Treat absence as an empty overlay
      // list without rewriting the immutable historical plan/hash.
      for (const cue of segment.postProductionText ?? []) {
        if (cue.kind === "CTA" && !settings.cta) continue;
        if (cue.kind === "CAPTION" && !settings.captions) continue;
        if (
          cue.kind === "CAPTION" &&
          segment.dialogueOrNarration.kind !== "NONE" &&
          cue.text.trim() === segment.dialogueOrNarration.text.trim()
        ) {
          continue;
        }
        const cueStart = cursor + cue.startMs;
        const cueEnd = cursor + Math.min(cue.endMs, usedDurationMs);
        if (cueEnd <= cueStart) continue;
        const timelineKind: TimelineTextItem["kind"] =
          cue.kind === "CTA" ? "CTA" : "CAPTION";
        const positionOverride = settings.textPositionOverrides.find(
          item => item.segmentId === segment.id && item.text === cue.text
        );
        addText(cue.text, cueStart, cueEnd, timelineKind, {
          position: positionOverride?.position ?? cue.position,
          fontScale: cue.fontScale
        });
        if (cue.kind === "CTA") plannedCtaAdded = true;
      }
    }
    cursor += usedDurationMs;
  }
  for (const [index, mask] of settings.repairMasks.entries()) {
    if (mask.endMs > cursor) {
      throw new AutoEditBlocked("REPAIR_MASK_OUTSIDE_TIMELINE", "后期修复遮罩超出当前时间线范围");
    }
    const source = sources.find(item => item.artifact.id === mask.sourceArtifactId);
    if (!source || source.artifact.sha256 !== mask.sourceArtifactHash) {
      throw new AutoEditBlocked("REPAIR_MASK_SOURCE_CHANGED", "后期修复遮罩绑定的视频源已变化，不能套用旧修复范围");
    }
    timeline.repairMasks.push({
      id: id + "-repair-mask-" + index,
      sourceArtifactId: mask.sourceArtifactId,
      sourceArtifactHash: mask.sourceArtifactHash,
      startMs: mask.startMs,
      endMs: mask.endMs,
      xRatio: mask.xRatio,
      yRatio: mask.yRatio,
      widthRatio: mask.widthRatio,
      heightRatio: mask.heightRatio,
      color: mask.color,
      opacity: mask.opacity,
      reason: mask.reason,
      deleted: false
    });
    rationale.push(`用户明确授权后期修复遮罩 ${index + 1}：${mask.reason}`);
  }
  const bgm = audio.find(a => a.kind === "BGM");
  if (bgm) {
    const length = bgm.outMs - bgm.inMs;
    if (length < 1000) throw new AutoEditBlocked("BGM_TOO_SHORT", "循环背景音乐至少需要1秒的有效音频", true);
    for (let start = 0; start < cursor; start += length) {
      const item = addAudio(bgm, start, Math.min(cursor, start + length))!;
      // Duck background music during all speech windows; keyframes stay local to each loop item.
      const duration = item.outMs - item.inMs;
      item.audio.keyframes = duckingEnvelope({ durationMs: duration, volume: bgm.volume, fadeOut: true,
        windows: speechRanges.map(s => ({ start: s.start - start, end: s.end - start })) });
    }
  }
  const includedBeats = new Set(sources.flatMap(s => s.clip.sourceBeatIds));
  const cta = script.beats.filter(b => b.purpose === "CTA" && includedBeats.has(b.id)).at(-1);
  if (settings.cta && cta && !plannedCtaAdded) addText(cta.text, Math.max(0, cursor - Math.min(4000, sources.at(-1)!.clip.durationMs)), cursor, "CTA");
  if (!audible && !settings.allowSilentOutput) throw new AutoEditBlocked("AUDIO_REQUIRED", "没有可用原声、旁白、音效或背景音乐；请补充音频或明确选择无声输出", true);
  if (cursor !== input.targetDurationMs) warnings.push(`目标 ${input.targetDurationMs}ms，当前已采用片段成片 ${cursor}ms；保留明确跳过的决定，不复制镜头或变速凑时长。`);
  if (sources.some(s => s.media.hasAudio)) warnings.push("保留已采用视频的原音轨；音轨存在不等于已经转写并校验了全部台词，最终仍需试听。 ");
  timeline.contentHash = timelineDecisionHash(timeline);
  const parsedTimeline = timelineSchema.parse(timeline);
  const base = { id, projectId: truth.projectId, inputHash: input.operationKey, source: "RULE_BASED_AUTO_EDIT_V1" as const,
    plannerVersion: AUTO_EDIT_PLANNER_VERSION,
    truthRef: reference("ProductTruth", truth), scriptRef: reference("ScriptDraft", script), productionPlanRef: reference("ProductionPlan", plan),
    ...(input.referenceVideoProfileHash ? { referenceVideoProfileHash: input.referenceVideoProfileHash } : {}), settings,
    targetDurationMs: input.targetDurationMs, actualDurationMs: timelineDurationMs(parsedTimeline),
    inputs: sources.map(s => ({ clipId: s.clip.id, clipHash: s.clip.contentHash, attemptId: s.attemptId, artifactId: s.artifact.id,
      artifactHash: s.artifact.sha256, sourceDurationMs: s.media.durationMs, sourceHasAudio: s.media.hasAudio,
      ...(s.visualAssessment ? { visualAssessment: {
        artifactId: s.visualAssessment.artifactId,
        artifactHash: s.visualAssessment.artifactHash,
        evaluatorVersion: s.visualAssessment.assessment.evaluatorVersion,
        status: s.visualAssessment.assessment.status,
        confidence: s.visualAssessment.assessment.confidence,
        inMs: s.visualAssessment.selectedWindow.inMs,
        outMs: s.visualAssessment.selectedWindow.outMs
      } } : {}) })),
    audioProvenance: audio.map(a => ({ segmentId: a.segmentId, kind: a.kind, artifactId: a.artifact.id, artifactHash: a.artifact.sha256,
      measuredDurationMs: a.media.durationMs, synthesized: a.synthesized === true, voiceName: a.voiceName })),
    timeline: parsedTimeline, renderConfig: config, rationale, warnings, captionTiming: "DIRECTOR_SEGMENTS_OR_SYNTHESIZED_AUDIO_NOT_ASR" as const, createdAt: now };
  return autoEditPlanSchema.parse({ ...base, contentHash: hashValue(base) });
}
