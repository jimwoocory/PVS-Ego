import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import {LocalArtifactStore} from "../../adapters/store/local-artifact-store.js";
import {inspectMedia} from "../../adapters/media/inspect-media.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";

const execute=promisify(execFile),VERSION="canvas-short-delivery-v1";
export class CanvasShortDeliveryService {
  constructor(private readonly artifacts:ArtifactRepository,private readonly projectsRoot:string){}
  async verifyAccepted(p:CanvasShortPlan){
    try{if(p.status!=="DELIVERED"||!p.final?.acceptedAt||!p.clipReview)return false;
      await this.file(p.projectId,p.final.artifactId,p.final.sha256);
      const qc=await this.artifacts.findById(p.final.qcArtifactId),manifest=await this.artifacts.findById(p.final.manifestArtifactId);
      if(!qc?.sha256||!manifest?.sha256)return false;
      const report=JSON.parse(await fs.readFile(await this.file(p.projectId,qc.id,qc.sha256),"utf8"));
      const delivery=JSON.parse(await fs.readFile(await this.file(p.projectId,manifest.id,manifest.sha256),"utf8"));
      return report.status==="PASS"&&report.planHash===p.contentHash&&report.sha256===p.final.sha256&&delivery.planHash===p.contentHash&&
        delivery.final?.sha256===p.final.sha256&&delivery.sourceClip?.decisionId===p.clipReview.decisionId;
    }catch{return false;}
  }
  private async file(projectId:string,id:string,sha:string){
    const a=await this.artifacts.findById(id),root=path.resolve(this.projectsRoot,projectId),file=a?path.resolve(root,a.relativePath):"";
    if(!a||a.projectId!==projectId||a.integrityStatus!=="READY"||a.sha256!==sha||!file.startsWith(root+path.sep)||sha256Bytes(await fs.readFile(file))!==sha)
      throw new CanvasRuntimeError("SHORT_DELIVERY_INPUT_CHANGED");return file;
  }
  private async font(){for(const f of [process.env.PVS_FONT_PATH,"C:/Windows/Fonts/msyh.ttc","/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"])
    if(f&&await fs.stat(f).catch(()=>null))return f.replaceAll("\\","/").replace(":","\\:");throw new CanvasRuntimeError("SHORT_CHINESE_FONT_MISSING");}
  private async textFilter(dir:string,text:string,name:string,y:number,fontsize:number,enable?:string){
    await fs.writeFile(path.join(dir,name),text,"utf8");const width=Math.max(...text.split("\n").map(s=>Array.from(s).length),1);
    const size=Math.min(fontsize,Math.floor(660/width));
    return `drawtext=fontfile='${await this.font()}':textfile='${name}':expansion=none:fix_bounds=1:fontcolor=white:fontsize=${size}:box=1:boxcolor=black@0.65:boxborderw=14:x=(w-text_w)/2:y=${y}${enable?`:enable='${enable}'`:""}`;
  }
  private async tail(dir:string,image:string,texts:string[]){
    const filters=["scale=720:1280:force_original_aspect_ratio=decrease","pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x172438","setsar=1"];
    for(const [index,text] of texts.entries())filters.push(await this.textFilter(dir,text,`tail-${index}.txt`,920+index*80,index===0?44:38));
    const target=path.join(dir,"tail.mp4");await execute(process.env.FFMPEG_PATH??"ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-loop","1","-framerate","24","-i",image,
      "-f","lavfi","-i","anullsrc=r=48000:cl=mono","-t","3","-vf",filters.join(","),"-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","1","-shortest",target],
      {cwd:dir,windowsHide:true,timeout:60000,maxBuffer:2e6});return target;
  }
  private async save(projectId:string,id:string,relativePath:string,bytes:Buffer,kind:"FINAL_VIDEO"|"OTHER",mimeType:string){
    const existing=await this.artifacts.findById(id);
    if(existing){await this.file(projectId,id,sha256Bytes(bytes));return existing;}
    return new LocalArtifactStore(path.resolve(this.projectsRoot,projectId),this.artifacts).writeImmutable({id,projectId,relativePath,bytes,kind,mimeType,immutable:true});
  }
  async previewTail(p:CanvasShortPlan){
    const product=p.payload.references.find(r=>r.key==="PRODUCT")!,image=await this.file(p.projectId,product.artifactId,product.sha256);
    const key=hashValue({version:VERSION,planHash:p.contentHash,kind:"DRAFT_TAIL_PREVIEW"}),id="short-tail:"+key,existing=await this.artifacts.findById(id);
    if(existing){await this.file(p.projectId,id,existing.sha256!);return {artifactId:id,sha256:existing.sha256,durationMs:3000,kind:"DRAFT_TAIL_PREVIEW",notFinalVideo:true,paidGeneration:false};}
    const root=path.resolve(this.projectsRoot,p.projectId),tempRoot=path.join(root,".tmp");await fs.mkdir(tempRoot,{recursive:true});const dir=await fs.mkdtemp(path.join(tempRoot,"short-tail-"));
    try{const file=await this.tail(dir,image,p.payload.tailCardText),bytes=await fs.readFile(file);
      const artifact=await this.save(p.projectId,"short-tail:"+key,"previews/short/"+key+".mp4",bytes,"OTHER","video/mp4");
      return {artifactId:artifact.id,sha256:artifact.sha256,durationMs:3000,kind:"DRAFT_TAIL_PREVIEW",notFinalVideo:true,paidGeneration:false};
    }finally{if(path.resolve(dir).startsWith(tempRoot+path.sep))await fs.rm(dir,{recursive:true,force:true});}
  }
  async assemble(p:CanvasShortPlan):Promise<NonNullable<CanvasShortPlan["final"]>>{
    if(!p.clipReview)throw new CanvasRuntimeError("SHORT_DELIVERY_CLIP_REVIEW_REQUIRED");
    const clip=await this.file(p.projectId,p.clipReview.artifactId,p.clipReview.sha256),product=p.payload.references.find(r=>r.key==="PRODUCT")!,image=await this.file(p.projectId,product.artifactId,product.sha256);
    const original=await inspectMedia(clip);
    if(!original.hasVideo||!original.hasAudio||!original.width||!original.height||Math.abs(original.durationMs-12000)>500||Math.abs(original.width/original.height-9/16)>0.01)
      throw new CanvasRuntimeError("SHORT_DELIVERY_SOURCE_MEDIA_INVALID");
    const key=hashValue({version:VERSION,planHash:p.contentHash,review:p.clipReview}),id="short-final:"+key;
    const root=path.resolve(this.projectsRoot,p.projectId),tempRoot=path.join(root,".tmp");await fs.mkdir(tempRoot,{recursive:true});const dir=await fs.mkdtemp(path.join(tempRoot,"short-final-"));
    try{
      let artifact=await this.artifacts.findById(id);
      if(!artifact){const tail=await this.tail(dir,image,p.payload.tailCardText),captionFilters=[];
        for(const [index,segment] of p.payload.productionPlan.scenes[0]!.clips[0]!.segments.entries())if(segment.dialogueOrNarration.kind!=="NONE")
          captionFilters.push(await this.textFilter(dir,segment.dialogueOrNarration.text,`caption-${index}.txt`,1100,42,`between(t,${segment.startMs/1000},${segment.endMs/1000})`));
        const graph=`[0:v]scale=720:1280:flags=lanczos,setsar=1,fps=24,trim=duration=12,setpts=PTS-STARTPTS${captionFilters.length?","+captionFilters.join(","):""}[v0];`+
          "[0:a]aresample=48000,aformat=channel_layouts=mono,atrim=duration=12,asetpts=PTS-STARTPTS[a0];[1:v]setsar=1,fps=24,setpts=PTS-STARTPTS[v1];[1:a]aresample=48000,aformat=channel_layouts=mono,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]";
        const output=path.join(dir,"final.mp4");await execute(process.env.FFMPEG_PATH??"ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-i",clip,"-i",tail,"-filter_complex",graph,
          "-map","[v]","-map","[a]","-t","15","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","1","-movflags","+faststart",output],{cwd:dir,windowsHide:true,timeout:90000,maxBuffer:3e6});
        artifact=await this.save(p.projectId,id,"final/short/"+key+".mp4",await fs.readFile(output),"FINAL_VIDEO","video/mp4");}
      const file=await this.file(p.projectId,artifact.id,artifact.sha256!),media=await inspectMedia(file);
      const checks={mp4:(await fs.readFile(file)).toString("ascii",4,8)==="ftyp",duration:Math.abs(media.durationMs-15000)<=250,
        resolution:media.width===720&&media.height===1280,audio:media.hasAudio,video:media.hasVideo,reviewBound:Boolean(p.clipReview.decisionId)};
      const qc={version:VERSION,planId:p.id,planHash:p.contentHash,artifactId:artifact.id,sha256:artifact.sha256,checks,media,status:Object.values(checks).every(Boolean)?"PASS":"BLOCKED",requiresHumanFinalReview:true};
      const qcBytes=Buffer.from(JSON.stringify(qc,null,2)),qcArtifact=await this.save(p.projectId,"short-qc:"+key,"final/short/"+key+".qc.json",qcBytes,"OTHER","application/json");
      if(qc.status!=="PASS")throw new CanvasRuntimeError("SHORT_FINAL_QC_BLOCKED_FILE_PRESERVED");
      const manifest={version:VERSION,projectId:p.projectId,planId:p.id,planHash:p.contentHash,sourceClip:p.clipReview,tailProduct:product,tailText:p.payload.tailCardText,
        final:{artifactId:artifact.id,sha256:artifact.sha256,...media},qcArtifactId:qcArtifact.id,downloadHref:"/api/artifacts/"+encodeURIComponent(artifact.id)+"/content",status:"AWAITING_HUMAN_FINAL_REVIEW",published:false};
      const manifestArtifact=await this.save(p.projectId,"short-delivery:"+key,"final/short/"+key+".delivery.json",Buffer.from(JSON.stringify(manifest,null,2)),"OTHER","application/json");
      return {artifactId:artifact.id,sha256:artifact.sha256!,manifestArtifactId:manifestArtifact.id,qcArtifactId:qcArtifact.id,durationMs:media.durationMs,width:media.width!,height:media.height!,hasAudio:media.hasAudio};
    }finally{if(path.resolve(dir).startsWith(tempRoot+path.sep))await fs.rm(dir,{recursive:true,force:true});}
  }
}
