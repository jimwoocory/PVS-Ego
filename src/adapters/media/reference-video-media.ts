import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type ReferenceVideoMediaInfo = {
  durationMs: number;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  sceneCutTimestampsMs: number[];
};

function exec(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error?.message ?? ""),
          exitCode: error ? 1 : 0
        });
      }
    );
  });
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value || value === "0/0") return undefined;
  if (value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    if (
      a === undefined ||
      b === undefined ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      !b
    ) {
      return undefined;
    }
    const rate = a / b;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  }
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export async function probeReferenceVideo(
  filePath: string
): Promise<ReferenceVideoMediaInfo> {
  const result = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ],
    20_000
  );
  if (result.exitCode !== 0) {
    throw new Error("ffprobe 无法读取参考视频");
  }
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
  };
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("参考视频时长无效");
  }
  const video = parsed.streams?.find((item) => item.codec_type === "video");
  if (!video) throw new Error("参考文件没有可解码视频轨");
  const audio = parsed.streams?.find((item) => item.codec_type === "audio");
  const sceneCutTimestampsMs = await detectSceneCuts(filePath);
  return {
    durationMs: Math.round(durationSeconds * 1000),
    ...(typeof video.width === "number" && video.width > 0
      ? { width: video.width }
      : {}),
    ...(typeof video.height === "number" && video.height > 0
      ? { height: video.height }
      : {}),
    ...(parseRate(video.avg_frame_rate ?? video.r_frame_rate)
      ? { frameRate: parseRate(video.avg_frame_rate ?? video.r_frame_rate)! }
      : {}),
    ...(typeof video.codec_name === "string" && video.codec_name
      ? { videoCodec: video.codec_name.toLowerCase() }
      : {}),
    ...(typeof audio?.codec_name === "string" && audio.codec_name
      ? { audioCodec: audio.codec_name.toLowerCase() }
      : {}),
    hasAudio: Boolean(
      audio
    ),
    sceneCutTimestampsMs
  };
}

export function referenceVideoNeedsBrowserPreview(
  media: ReferenceVideoMediaInfo
): boolean {
  return media.videoCodec !== "h264";
}

export async function createReferenceVideoBrowserPreview(input: {
  filePath: string;
  outputPath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  const result = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input.filePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      input.outputPath
    ],
    180_000
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "ffmpeg 无法生成浏览器兼容的参考视频预览：" +
        result.stderr.slice(0, 500)
    );
  }
  const stat = await fs.stat(input.outputPath);
  if (!stat.size) {
    throw new Error("参考视频浏览器兼容预览为空");
  }
}

async function detectSceneCuts(filePath: string): Promise<number[]> {
  const result = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      filePath,
      "-vf",
      "select='gt(scene,0.35)',showinfo",
      "-an",
      "-f",
      "null",
      "-"
    ],
    45_000
  );
  const text = result.stderr;
  const values = [
    ...text.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)
  ].map((match) => Math.round(Number(match[1]) * 1000));
  return [...new Set(values.filter((value) => Number.isFinite(value)))].sort(
    (a, b) => a - b
  );
}

export async function sampleReferenceFrames(input: {
  filePath: string;
  outputDir: string;
  durationMs: number;
  maxFrames?: number;
}): Promise<
  Array<{
    path: string;
    timestampMs: number;
    mimeType: "image/jpeg";
  }>
> {
  const maxFrames = Math.max(4, Math.min(input.maxFrames ?? 10, 12));
  await fs.mkdir(input.outputDir, { recursive: true });
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    throw new Error("参考视频时长无效，不能确定采样时间");
  }
  const interval = input.durationMs / 1000 / maxFrames;
  const pattern = path.join(input.outputDir, "frame-%02d.jpg");
  const result = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      input.filePath,
      "-vf",
      // Keep actual decoded frame PTS instead of manufacturing evenly spaced labels.
      "setpts=PTS-STARTPTS,select='gte(t,selected_n*" + interval.toFixed(9) + ")',showinfo",
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(maxFrames),
      "-q:v",
      "3",
      pattern
    ],
    60_000
  );
  if (result.exitCode !== 0) {
    throw new Error("ffmpeg 无法抽取参考视频采样帧");
  }
  const files = (await fs.readdir(input.outputDir))
    .filter((name) => /^frame-\d+\.jpg$/i.test(name))
    .sort();
  if (!files.length) {
    throw new Error("参考视频未抽取到可分析画面");
  }
  const timestamps = new Map<number, number>();
  for (const match of result.stderr.matchAll(/Parsed_showinfo[^\r\n]*\bn:\s*(\d+)[^\r\n]*\bpts_time:([^\s]+)/g)) {
    const value = Math.round(Number(match[2]) * 1000);
    if (Number.isFinite(value)) timestamps.set(Number(match[1]), value);
  }
  const times = files.map((_, index) => timestamps.get(index));
  if (times.some((value, index) => value === undefined || value < 0 || value >= input.durationMs ||
      (index > 0 && value <= times[index - 1]!))) {
    throw new Error("参考视频实际解码帧时间戳缺失或无序，停止分析");
  }
  return files.map((name, index) => ({
    path: path.join(input.outputDir, name),
    timestampMs: times[index]!,
    mimeType: "image/jpeg" as const
  }));
}

export async function extractReferenceAudio(input: {
  filePath: string;
  outputPath: string;
  maxDurationSeconds?: number;
}): Promise<{ path: string; mimeType: "audio/mpeg" }> {
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.filePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k"
  ];
  if (input.maxDurationSeconds) {
    args.push("-t", String(input.maxDurationSeconds));
  }
  args.push(input.outputPath);
  const result = await exec("ffmpeg", args, 90_000);
  if (result.exitCode !== 0) {
    throw new Error("ffmpeg 无法提取视频音频");
  }
  const stat = await fs.stat(input.outputPath);
  if (!stat.size) throw new Error("视频音频轨为空");
  return { path: input.outputPath, mimeType: "audio/mpeg" };
}
