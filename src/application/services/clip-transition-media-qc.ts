import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import type { ClipTransitionContract } from "./clip-continuity-engine.js";
import { assessMediaRatio } from "./generated-media-spec-qc.js";

const run=promisify(execFile);

async function frameSignature(file:string, timestampMs:number):Promise<Buffer>{
  const {stdout}=await run(process.env.FFMPEG_PATH ?? "ffmpeg",[
    "-hide_banner","-loglevel","error","-ss",(timestampMs/1000).toFixed(3),
    "-i",file,"-frames:v","1","-vf","scale=16:16:flags=area,format=rgb24",
    "-f","rawvideo","-pix_fmt","rgb24","pipe:1"
  ],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:"buffer"});
  const pixels=Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout as string,"binary");
  if(pixels.length!==16*16*3)throw new Error("无法核验视频边界的真实画面");
  return pixels;
}

export type ClipTransitionQC={
  status:"BLOCKED"|"REVIEW_REQUIRED";
  sourceDurationMs:number;
  targetDurationMs:number;
  pixelDistance?:number;
  issues:string[];
  evidence:string[];
};

/** No generative API calls, no automatic adoption or retry; only local media. */
export async function inspectClipTransitionMedia(input:{
  contract:ClipTransitionContract;
  sourceVideoPath:string;
  targetVideoPath:string;
  requestedRatio:string;
  nativeAudioRequired:boolean;
}):Promise<ClipTransitionQC>{
  const [source,target]=await Promise.all([
    inspectMedia(input.sourceVideoPath),inspectMedia(input.targetVideoPath)
  ]);
  const issues:string[]=[];
  const evidence:string[]=[];
  if(!source.hasVideo||!target.hasVideo){
    issues.push("前段或后段缺少真实视频轨");
  }
  for(const [label,media] of [["上一段",source],["下一段",target]] as const){
    const ratio=assessMediaRatio(input.requestedRatio,media);
    if(ratio.status!=="PASS"){
      issues.push(label+"视频画幅与项目规格不一致："+ratio.detail);
    }
  }
  if(input.nativeAudioRequired&&!target.hasAudio){
    issues.push("下一段要求原生声音，但实际没有音轨");
  }
  let pixelDistance:number|undefined;
  if(!issues.length && input.contract.relationship==="HARD_CONTINUITY"){
    const [end,start]=await Promise.all([
      frameSignature(input.sourceVideoPath,Math.max(0,source.durationMs-110)),
      frameSignature(input.targetVideoPath,Math.min(80,Math.max(0,target.durationMs-1)))
    ]);
    let sum=0;
    for(let i=0;i<end.length;i++)sum+=Math.abs(end[i]!-start[i]!);
    pixelDistance=Number((sum/(end.length*255)).toFixed(4));
    evidence.push("已比较上一段接近末尾的真实帧与下一段接近开头的真实帧；16×16色彩采样差异="+pixelDistance);
    if(pixelDistance>0.16){
      issues.push("强连续首尾画面差异明显，需复核机位、人物道具及前后动作（不可直接AI自动采用）");
    }
  }else if(input.contract.relationship==="SAME_SCENE_CUT"){
    evidence.push("正常切机位不要求逐帧完全一致，但人物与道具锚点需要进一步视觉审查");
  }else if(input.contract.relationship==="SCENE_OR_TIME_JUMP"){
    evidence.push("明确时空切换，不要求前后视频画面像素相同");
  }
  return {
    status:issues.length?"BLOCKED":"REVIEW_REQUIRED",
    sourceDurationMs:source.durationMs,targetDurationMs:target.durationMs,
    ...(pixelDistance!==undefined?{pixelDistance}:{}),
    issues,evidence
  };
}
