import type { TimelineAudioSettings, Timeline, TimelineTextItem } from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";

/** Numeric-only expression. User text is never interpolated into a filter expression. */
export function audioVolumeFilter(settings: TimelineAudioSettings, durationMs: number, trackMuted = false): string {
  if (settings.muted || trackMuted) return "volume=0";
  const frames = settings.keyframes;
  if (!frames.length) return "volume=" + settings.volume.toFixed(6);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (!Number.isFinite(f.atMs) || f.atMs < 0 || f.atMs > durationMs || !Number.isFinite(f.volume) || f.volume < 0 || f.volume > 2 || (i > 0 && frames[i-1]!.atMs >= f.atMs)) {
      throw new DomainValidationError("音量关键帧必须递增且位于当前片段内");
    }
  }
  const values = frames[0]!.atMs > 0 ? [{ atMs: 0, volume: settings.volume }, ...frames] : frames;
  let expression = String(values.at(-1)!.volume);
  for (let i = values.length - 2; i >= 0; i--) {
    const left = values[i]!, right = values[i+1]!;
    const from = left.atMs / 1000, until = right.atMs / 1000;
    const slope = (right.volume - left.volume) / (until - from);
    expression = `if(lt(t,${until}),${left.volume}+(${slope})*(t-${from}),${expression})`;
  }
  return "volume='" + expression + "':eval=frame";
}

export function renderableText(timeline: Timeline): TimelineTextItem[] {
  const muted = new Set(timeline.tracks.filter(t => t.muted).map(t => t.id));
  const result = timeline.textItems.filter(t => !t.deleted && !muted.has(t.trackId)).map(t => ({ ...t }));
  let cursor = 0;
  for (const clip of [...timeline.clips].filter(c => !c.deleted).sort((a,b) => a.order-b.order)) {
    if (!muted.has(clip.trackId)) for (const caption of clip.captions) {
      const start = Math.max(clip.inMs, caption.startMs), end = Math.min(clip.outMs, caption.endMs);
      if (end > start) result.push({ ...caption, id: clip.id + ":" + caption.id, kind: "CAPTION", startMs: cursor + start - clip.inMs,
        endMs: cursor + end - clip.inMs, trackId: clip.trackId, order: result.length, fontScale: 1, deleted: false });
    }
    cursor += clip.outMs - clip.inMs - (clip.transition.type === "CUT" ? 0 : clip.transition.durationMs);
  }
  return result.sort((a,b) => a.order-b.order);
}
