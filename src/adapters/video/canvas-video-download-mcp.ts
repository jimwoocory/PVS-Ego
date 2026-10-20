import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import type {CanvasVideoDownload,CanvasVideoDownloadRequest} from "../../application/ports/canvas-video-download.js";
import {CanvasRuntimeError} from "./dreamina-canvas-runtime.js";

const configSchema=z.object({contract:z.literal("pvs-canvas-video-download-v1"),endpoint:z.string().url(),
  accountFingerprint:z.string().regex(/^[a-f0-9]{64}$/),capabilityTool:z.string().min(1),downloadTool:z.string().min(1),
  tokenEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional()}).strict();
/** Explicitly registered local, read-only MCP. No hidden URLs, copied OAuth tokens or guessed vendor APIs. */
export class CanvasVideoDownloadMcp implements CanvasVideoDownload{
  constructor(private readonly configPath=process.env.PVS_CANVAS_VIDEO_DELIVERY_MCP_CONFIG,private readonly fetcher:typeof fetch=fetch){}
  private async config(){
    if(!this.configPath)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_NOT_REGISTERED");
    const config=configSchema.parse(JSON.parse(await fs.readFile(this.configPath,"utf8"))),url=new URL(config.endpoint);
    if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)
      throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_MUST_BE_LOCAL");
    return config;
  }
  private async rpc(config:z.infer<typeof configSchema>,method:string,params:unknown){
    const token=config.tokenEnv?process.env[config.tokenEnv]:undefined;
    if(config.tokenEnv&&!token)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_AUTH_MISSING");
    const response=await this.fetcher(config.endpoint,{method:"POST",redirect:"error",signal:AbortSignal.timeout(60_000),headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});
    if(!response.ok)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_HTTP_FAILED");
    const text=await response.text();if(text.length>65536)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_RESPONSE_TOO_LARGE");
    const body=JSON.parse(text);if(body.error||body.result?.isError)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_MCP_FAILED");return body.result;
  }
  async readiness(accountFingerprint:string){
    try{const config=await this.config();if(config.accountFingerprint!==accountFingerprint)throw new CanvasRuntimeError("VIDEO_DOWNLOAD_ACCOUNT_MISMATCH");
      const catalog=await this.rpc(config,"tools/list",{});
      for(const name of [config.capabilityTool,config.downloadTool])if(!catalog?.tools?.some((t:any)=>t.name===name&&t.annotations?.readOnlyHint===true&&t.annotations?.destructiveHint!==true))
        throw new CanvasRuntimeError("VIDEO_DOWNLOAD_READ_ONLY_TOOL_MISSING");
      const result=await this.rpc(config,"tools/call",{name:config.capabilityTool,arguments:{contract:config.contract,accountFingerprint}});
      const data=z.object({contract:z.literal("pvs-canvas-video-download-v1"),accountFingerprint:z.string(),mediaTypes:z.array(z.string()),ready:z.boolean()}).strict().parse(result.structuredContent);
      if(data.accountFingerprint!==accountFingerprint||!data.ready||!data.mediaTypes.includes("video"))throw new CanvasRuntimeError("VIDEO_DOWNLOAD_NOT_SUPPORTED_BY_CURRENT_ACCOUNT");
      return {ready:true};
    }catch(error){const code=error instanceof CanvasRuntimeError?error.code:"VIDEO_DOWNLOAD_MCP_INVALID";
      return {ready:false,code,message:code==="VIDEO_DOWNLOAD_MCP_NOT_REGISTERED"?"未登记同账号的视频文件交付MCP；本机Canvas CLI视频下载能力应独立实测，不能据此判断CLI不支持视频。":"Canvas视频文件交付接口未通过同账号及只读能力校验："+code,
        missingInterface:{contract:"pvs-canvas-video-download-v1",requiredUpstream:"同账号Canvas成功视频资源的官方文件导出/下载接口，或已实现该导出的只读本地MCP服务",
          identityFields:["canvasProjectId","nodeId","submitId","resourceId","accountFingerprint"],fileFields:["path","sha256","sizeBytes"],
          configuration:"PVS_CANVAS_VIDEO_DELIVERY_MCP_CONFIG",consumerImplemented:true,upstreamVerified:false}};}
  }
  async download(input:CanvasVideoDownloadRequest){
    const check=await this.readiness(input.accountFingerprint);if(!check.ready)throw new CanvasRuntimeError(check.code!);
    const config=await this.config(),result=await this.rpc(config,"tools/call",{name:config.downloadTool,arguments:{contract:config.contract,...input}});
    const data=z.object({contract:z.literal("pvs-canvas-video-download-v1"),canvasProjectId:z.string(),nodeId:z.string(),submitId:z.string(),resourceId:z.string(),accountFingerprint:z.string(),
      path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().positive()}).strict().parse(result.structuredContent);
    if(["canvasProjectId","nodeId","submitId","resourceId","accountFingerprint"].some(k=>data[k as keyof typeof data]!==input[k as keyof CanvasVideoDownloadRequest])||path.resolve(data.path)!==path.resolve(input.outputPath))
      throw new CanvasRuntimeError("VIDEO_DOWNLOAD_BINDING_MISMATCH");
    return {path:data.path,sha256:data.sha256,sizeBytes:data.sizeBytes};
  }
}
