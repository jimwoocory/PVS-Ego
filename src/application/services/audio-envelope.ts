import { DomainValidationError } from "../../domain/validation.js";

export type AudioWindow = { start: number; end: number };

/** Merge overlapping/adjacent speech windows before constructing volume ramps.
 * A later window must never restore full volume during an earlier one.
 * All times are local to the audio item and all gain points are deterministic.
 */
export function duckingEnvelope(input: {
  durationMs: number; volume: number; windows: AudioWindow[];
  gain?: number; attackMs?: number; releaseMs?: number; fadeOut?: boolean;
}): Array<{ atMs: number; volume: number }> {
  const { durationMs, volume, windows } = input;
  const gain = input.gain ?? 0.3, attackMs = input.attackMs ?? 100, releaseMs = input.releaseMs ?? 120;
  if (!Number.isInteger(durationMs) || durationMs <= 0 || !Number.isFinite(volume) || volume < 0 || volume > 2 ||
      !Number.isFinite(gain) || gain < 0 || gain > 1 || !Number.isInteger(attackMs) || attackMs < 0 ||
      !Number.isInteger(releaseMs) || releaseMs < 0 || windows.some(w => !Number.isInteger(w.start) || !Number.isInteger(w.end) || w.end <= w.start)) {
    throw new DomainValidationError("音频包络的时长、音量或语音区间无效");
  }
  const ordered = windows.filter(w => w.start < durationMs && w.end > 0)
    .map(w => ({ start: Math.max(0, w.start), end: Math.min(durationMs, w.end) }))
    .sort((a,b) => a.start-b.start || a.end-b.end);
  const merged: AudioWindow[] = [];
  for (const window of ordered) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + attackMs + releaseMs) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  const points = new Map<number, number>([[0, volume]]);
  for (const window of merged) {
    const attackStart = Math.max(0, window.start - attackMs);
    if (attackStart < window.start) points.set(attackStart, volume);
    points.set(window.start, volume * gain);
    points.set(window.end, volume * gain);
    const releaseEnd = Math.min(durationMs, window.end + releaseMs);
    if (releaseEnd > window.end) points.set(releaseEnd, volume);
  }
  if (input.fadeOut) {
    const fadeStart = Math.max(0, durationMs - 150);
    const original = [...points].sort((a,b) => a[0]-b[0]);
    let level = original[0]![1];
    for (let i=1; i<original.length; i++) {
      const left=original[i-1]!, right=original[i]!;
      if (fadeStart <= right[0]) { level=left[1]+(right[1]-left[1])*(fadeStart-left[0])/(right[0]-left[0]); break; }
      level=right[1];
    }
    points.set(fadeStart, level);
    for (const [atMs, current] of points) if (atMs > fadeStart) points.set(atMs, Math.min(current, level*(durationMs-atMs)/(durationMs-fadeStart)));
    points.set(durationMs, 0);
  }
  return [...points].sort((a,b) => a[0]-b[0]).map(([atMs, level]) => ({ atMs, volume: level }));
}
