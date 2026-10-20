import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { inspectMedia } from "./inspect-media.js";
import { DomainValidationError } from "../../domain/validation.js";

const execute = promisify(execFile);

/**
 * Seedance can occasionally return an unsolicited music bed even when the
 * prompt forbids BGM. For clips whose plan requests no native audio at all,
 * remove the entire provider audio track locally before the output becomes
 * the canonical generated artifact. The original provider download remains
 * transient; post-production supplies the only BGM.
 */
export async function sanitizeGeneratedClipAudio(
  file: string,
  generateAudio: boolean,
  tempDir: string,
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg"
): Promise<string> {
  if (generateAudio) return file;
  const media = await inspectMedia(file);
  if (!media.hasAudio) return file;

  const output = path.join(
    tempDir,
    "no-native-audio-" + path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_")
  );
  await execute(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      "-movflags",
      "+faststart",
      "-y",
      output
    ],
    { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
  );
  const checked = await inspectMedia(output);
  if (!checked.hasVideo || checked.hasAudio) {
    throw new DomainValidationError(
      "无声分镜音轨清理失败，已阻止带模型背景音乐的结果进入审片"
    );
  }
  return output;
}
