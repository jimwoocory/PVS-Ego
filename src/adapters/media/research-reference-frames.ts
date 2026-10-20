import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { inspectMedia } from "./inspect-media.js";
const exec = promisify(execFile);

/** Explicit seek targets, not invented source frame PTS. frameIndex is the sample ordinal. */
export async function sampleResearchReferenceFrames(file: string, directory: string, count = 8) {
  const info = await inspectMedia(file);
  if (!info.hasVideo || info.durationMs > 600_000) throw new Error("研究参考视频必须包含画面且不超过10分钟");
  const n = Math.max(1, Math.min(12, Math.trunc(count)));
  await fs.mkdir(directory, {recursive: true});
  const targets = [...new Set(Array.from({length:n}, (_,i) => Math.round(Math.max(0,info.durationMs-100)*i/Math.max(n-1,1))))];
  const frames: Array<{path:string;timestampMs:number;frameIndex:number;mimeType:"image/jpeg"}> = [];
  for (const [frameIndex,timestampMs] of targets.entries()) {
    const out = path.join(directory, `reference-${frameIndex}.jpg`);
    await exec(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner","-loglevel","error","-ss",String(timestampMs/1000),"-i",file,"-frames:v","1","-q:v","3","-y",out], {windowsHide:true,timeout:30000,maxBuffer:1024*1024});
    if (!(await fs.stat(out)).size) throw new Error("参考帧为空");
    frames.push({path:out,timestampMs,frameIndex,mimeType:"image/jpeg"});
  }
  return frames;
}

/** Tiny decoded RGB signature; does not replace immutable SHA256 or visual identity review. */
export async function referencePixelSignature(file: string): Promise<string> {
  const result = await exec(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner","-loglevel","error","-i",file,"-vf","scale=16:16:flags=area","-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"], {windowsHide:true,timeout:20000,maxBuffer:1024*1024,encoding:"buffer"});
  if (result.stdout.length !== 768) throw new Error("无法获取参考图像指纹");
  return result.stdout.toString("hex");
}
export function nearDuplicatePixels(a: string, b: string): boolean {
  if (!/^[a-f0-9]{1536}$/.test(a) || !/^[a-f0-9]{1536}$/.test(b)) return false;
  const x=Buffer.from(a,"hex"),y=Buffer.from(b,"hex");let sum=0,large=0;
  for(let i=0;i<x.length;i++){const d=Math.abs(x[i]!-y[i]!);sum+=d;if(d>10)large++;}
  return sum/x.length <= 1.2 && large/x.length <= 0.01;
}
