import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectMedia } from "./inspect-media.js";

const exec = promisify(execFile);

export async function sampleGeneratedVisualReviewFrames(input: {
  filePath: string;
  outputDir: string;
  maxFrames?: number;
}): Promise<{
  durationMs: number;
  frames: Array<{
    path: string;
    timestampMs: number;
    mimeType: "image/png";
  }>;
}> {
  const media = await inspectMedia(input.filePath);
  if (!media.hasVideo || media.durationMs <= 0) {
    throw new Error("生成结果没有可分析的视频轨");
  }
  const count = Math.max(3, Math.min(8, Math.trunc(input.maxFrames ?? 6)));
  const end = Math.max(
    0,
    media.durationMs - Math.min(600, Math.round(media.durationMs / 5))
  );
  const targets = [
    ...new Set(
      Array.from({ length: count }, (_, index) =>
        Math.round((end * index) / Math.max(1, count - 1))
      )
    )
  ];
  await fs.mkdir(input.outputDir, { recursive: true });
  const frames: Array<{
    path: string;
    timestampMs: number;
    mimeType: "image/png";
  }> = [];
  for (const [index, timestampMs] of targets.entries()) {
    const target = path.join(input.outputDir, "review-" + index + ".png");
    await exec(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        (timestampMs / 1000).toFixed(3),
        "-i",
        input.filePath,
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-threads",
        "1",
        "-y",
        target
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    const stat = await fs.stat(target);
    if (!stat.size) {
      throw new Error("AI 审片采样帧为空");
    }
    frames.push({
      path: target,
      timestampMs,
      mimeType: "image/png"
    });
  }
  return {
    durationMs: media.durationMs,
    frames
  };
}
