import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainValidationError } from "../../domain/validation.js";
const execute = promisify(execFile);
export type MediaInfo = { durationMs: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean };

/** Probe real streams. An unreadable file never becomes a guessed/silent success. */
export async function inspectMedia(file: string, ffprobe = process.env.FFPROBE_PATH ?? "ffprobe"): Promise<MediaInfo> {
  const { stdout } = await execute(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", file],
    { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }> };
  const streams = parsed.streams ?? [];
  const seconds = Number(parsed.format?.duration ?? streams.find(s => Number.isFinite(Number(s.duration)))?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new DomainValidationError("媒体文件没有可验证的正时长");
  const video = streams.find(s => s.codec_type === "video");
  return { durationMs: Math.round(seconds * 1000), hasVideo: Boolean(video), hasAudio: streams.some(s => s.codec_type === "audio"),
    ...(video?.width ? { width: video.width } : {}), ...(video?.height ? { height: video.height } : {}) };
}
