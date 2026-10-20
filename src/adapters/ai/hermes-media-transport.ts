import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StructuredAiRequest } from "../../application/ports/structured-ai-runtime.js";

const exec = promisify(execFile);
export async function prepareHermesMedia(media: NonNullable<StructuredAiRequest["media"]>) {
  if (!media.length || media.length > 16 || media.some(item => item.type !== "image")) {
    throw new Error("当前 Hermes 媒体通道仅支持1至16张图片；音频需要单独验证的运行环境。");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-hermes-media-"));
  const cleanup = async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("pvs-hermes-media-")) throw new Error("Invalid temporary media path");
    await fs.rm(root, {recursive:true, force:true});
  };
  try {
    const files: string[] = [];
    for (let index=0; index<media.length; index++) {
      const item=media[index]!;
      const extension = ({"image/jpeg":"jpg", "image/png":"png", "image/webp":"webp"} as Record<string,string>)[item.mimeType];
      if (!extension) throw new Error("不支持的图片格式");
      const file=path.join(root, `${index}.${extension}`);
      await fs.writeFile(file, Buffer.from(item.dataBase64,"base64")); files.push(file);
    }
    if (files.length === 1) return {image:files[0]!, columns:1, labels:media.map(item=>item.label??"图片"), cleanup};
    const columns=Math.ceil(Math.sqrt(files.length)), cell=768;
    const filters=files.map((_,i)=>`[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[v${i}]`);
    const layout=files.map((_,i)=>`${(i%columns)*cell}_${Math.floor(i/columns)*cell}`).join("|");
    filters.push(files.map((_,i)=>`[v${i}]`).join("")+`xstack=inputs=${files.length}:layout=${layout}:fill=white[out]`);
    const image=path.join(root,"frames.png");
    await exec(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-y",...files.flatMap(file=>["-i",file]),"-filter_complex",filters.join(";"),"-map","[out]","-frames:v","1",image],{windowsHide:true,timeout:60_000,maxBuffer:1024*1024});
    return {image, columns, labels:media.map(item=>item.label??"图片"), cleanup};
  } catch(error) { await cleanup(); throw error; }
}
