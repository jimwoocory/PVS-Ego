import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {z} from "zod";
import {sha256Bytes} from "../../domain/hashing.js";
import type {CanvasVideoDownload,CanvasVideoDownloadRequest} from "../../application/ports/canvas-video-download.js";
import {DreaminaCanvasRuntime,CanvasRuntimeError} from "./dreamina-canvas-runtime.js";

const proofSchema=z.object({contract:z.literal("pvs-canvas-cli-video-download-proof-v1"),accountFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  executableSha256:z.string().regex(/^[a-f0-9]{64}$/),projectId:z.string().uuid(),resourceId:z.string().uuid(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().positive(),verifiedAt:z.string().datetime()}).strict();

/** Actual MP4 capability is tested, rather than inferred from the CLI's outdated image-only summary. */
export class CanvasCliVideoDownload implements CanvasVideoDownload {
  private verified?:{at:number;identity:string};
  constructor(private readonly runtime:DreaminaCanvasRuntime,private readonly projectsRoot:string,
    private readonly proofPath=process.env.PVS_CANVAS_VIDEO_DOWNLOAD_PROOF){}
  private async verifyFile(resourceId:string,projectId:string,outputPath:string){
    const response=await this.runtime.call(["resource","download",resourceId,"--project-id",projectId,"--output",outputPath]);
    const bytes=await fs.readFile(outputPath),sha256=sha256Bytes(bytes),r=response.data;
    if(r?.resourceId!==resourceId||path.resolve(r.path??"")!==path.resolve(outputPath)||r.size!==bytes.length||r.sha256!==sha256||bytes.length<12||bytes.toString("ascii",4,8)!=="ftyp")
      throw new CanvasRuntimeError("VIDEO_DOWNLOAD_CLI_INTEGRITY_FAILED");
    return {path:outputPath,sha256,sizeBytes:bytes.length};
  }
  async readiness(accountFingerprint:string){
    try{
      if(!this.proofPath)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_CLI_PROOF_MISSING");
      const proof=proofSchema.parse(JSON.parse(await fs.readFile(this.proofPath,"utf8"))),account=await this.runtime.assertAccount();
      if(proof.accountFingerprint!==accountFingerprint||account.accountFingerprint!==accountFingerprint||proof.executableSha256!==this.runtime.config.executableSha256)
        throw new CanvasRuntimeError("VIDEO_DOWNLOAD_CLI_PROOF_IDENTITY_CHANGED");
      const identity=sha256Bytes(Buffer.from(JSON.stringify(proof)));
      if(!this.verified||this.verified.identity!==identity||Date.now()-this.verified.at>120_000){
        const resource=(await this.runtime.call(["resource","get",proof.resourceId,"--project-id",proof.projectId])).data;
        if(resource?.resourceId!==proof.resourceId||resource.type!=="video"||resource.status!=="success")throw new CanvasRuntimeError("VIDEO_DOWNLOAD_CANARY_UNAVAILABLE");
        const tempRoot=path.resolve(os.tmpdir()),temp=await fs.mkdtemp(path.join(tempRoot,"pvs-canvas-download-proof-"));
        try{const result=await this.verifyFile(proof.resourceId,proof.projectId,path.join(temp,"proof.mp4"));
          if(result.sha256!==proof.sha256||result.sizeBytes!==proof.sizeBytes)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_CANARY_BYTES_CHANGED");
        }finally{if(path.resolve(temp).startsWith(tempRoot+path.sep))await fs.rm(temp,{recursive:true,force:true});}
        this.verified={at:Date.now(),identity};
      }
      return {ready:true,backend:"LOCAL_CANVAS_CLI",verificationBasis:"ACTUAL_SAME_ACCOUNT_VIDEO_DOWNLOAD",generatedVideoEndToEnd:"NOT_RUN",
        verifiedAt:new Date(this.verified.at).toISOString(),message:"本机Canvas CLI已实际下载同账号测试MP4并校验SHA和字节数；付费生成视频仍按原提交编号下载，并须独立审片。"};
    }catch(error){const code=error instanceof CanvasRuntimeError?error.code:"VIDEO_DOWNLOAD_CLI_PROOF_INVALID";
      return {ready:false,code,message:"本机Canvas视频下载实际校验未通过："+code};}
  }
  async download(input:CanvasVideoDownloadRequest){
    const readiness=await this.readiness(input.accountFingerprint);if(!readiness.ready)throw new CanvasRuntimeError(readiness.code!);
    const root=await fs.realpath(this.projectsRoot),directory=await fs.realpath(path.dirname(input.outputPath));
    if(!directory.startsWith(root+path.sep)||!path.isAbsolute(input.outputPath)||await fs.stat(input.outputPath).catch(()=>null))
      throw new CanvasRuntimeError("VIDEO_DOWNLOAD_OUTPUT_PATH_INVALID");
    const operation=(await this.runtime.call(["operation","status",input.submitId,"--project-id",input.canvasProjectId])).data;
    if(operation?.operationRef!==input.submitId||operation.state!=="succeeded"||operation.submission?.adviceCode!=="submission_accepted"||
      !operation.resources?.some((r:any)=>r.resourceId===input.resourceId&&r.state==="succeeded"))throw new CanvasRuntimeError("VIDEO_DOWNLOAD_ORIGINAL_OPERATION_CHANGED");
    const shown=(await this.runtime.call(["node","show","--project-id",input.canvasProjectId,"--node-id",input.nodeId])).data;
    const node=shown?.nodes?.find((n:any)=>n.result==="FOUND"&&n.node?.nodeId===input.nodeId)?.node;
    if(!node?.resources?.some((r:any)=>r.resourceId===input.resourceId))throw new CanvasRuntimeError("VIDEO_DOWNLOAD_ORIGINAL_NODE_CHANGED");
    const resource=(await this.runtime.call(["resource","get",input.resourceId,"--project-id",input.canvasProjectId])).data;
    if(resource?.resourceId!==input.resourceId||resource.type!=="video"||resource.status!=="success")throw new CanvasRuntimeError("VIDEO_DOWNLOAD_ORIGINAL_RESOURCE_CHANGED");
    return this.verifyFile(input.resourceId,input.canvasProjectId,input.outputPath);
  }
}
