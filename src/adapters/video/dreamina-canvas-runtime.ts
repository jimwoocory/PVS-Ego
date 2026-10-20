import "../../isolation/require-isolation.js";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import {z} from "zod";
import {DomainValidationError} from "../../domain/validation.js";

const execute=promisify(execFile);
export const canvasRuntimeConfigSchema=z.object({
  executablePath:z.string().min(1),executableSha256:z.string().regex(/^[a-f0-9]{64}$/i),
  profile:z.string().min(1),expectedAccountFingerprint:z.string().regex(/^[a-f0-9]{64}$/i),
  imageModel:z.literal("seedream_5.0_lite"),videoModel:z.enum(["seedance_2.0_vip","seedance_2.0_fast_vip","seedance_2.5"]),
  modelApprovalSource:z.literal("USER_CONFIRMED_5_0_LITE"),
  officialSourceUrl:z.literal("https://jimeng.jianying.com/canvas-cli/install.ps1"),
  draftTransferGrant:z.object({projectId:z.string(),runId:z.string(),scopeHash:z.string().regex(/^[a-f0-9]{64}$/),
    productSha256:z.string().regex(/^[a-f0-9]{64}$/),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),
    source:z.literal("EXPLICIT_USER_REVIEWED_DRAFT_TRANSFER"),approvedAt:z.string().datetime()}).strict().optional()
}).strict();
export type CanvasRuntimeConfig=z.infer<typeof canvasRuntimeConfigSchema>;
export type CanvasEnvelope={ok:boolean;data?:any;meta?:{requestId?:string};error?:{code?:string;reason?:string;class?:string;requestId?:string;message?:string;validation?:{reasonCode?:string;fieldPath?:string}}};
export type CanvasCommandRunner=(exe:string,args:string[],timeout:number)=>Promise<CanvasEnvelope>;
export class CanvasRuntimeError extends DomainValidationError {
  constructor(readonly code:string,readonly requestId?:string){super(`Canvas后台调用未完成：${code}${requestId?`（请求${requestId}）`:""}`);}
}
const defaultRunner:CanvasCommandRunner=async(exe,args,timeout)=>{
  try{const r=await execute(exe,args,{windowsHide:true,timeout,maxBuffer:4*1024*1024});return JSON.parse(r.stdout);}
  catch(error){const e=error as {stdout?:string;stderr?:string};for(const raw of [e.stdout,e.stderr])try{const j=JSON.parse(raw??"");if(typeof j.ok==="boolean")return j;}catch{}
    throw new CanvasRuntimeError("LOCAL_EXECUTION_OR_TIMEOUT");}
};
export class DreaminaCanvasRuntime {
  constructor(readonly config:CanvasRuntimeConfig,private readonly runner:CanvasCommandRunner=defaultRunner){}
  static async load(configPath:string){return new DreaminaCanvasRuntime(canvasRuntimeConfigSchema.parse(JSON.parse(await fs.readFile(configPath,"utf8"))));}
  async verifyIdentity(){const bytes=await fs.readFile(this.config.executablePath);if(createHash("sha256").update(bytes).digest("hex")!==this.config.executableSha256.toLowerCase())throw new CanvasRuntimeError("EXECUTABLE_CHANGED");}
  async call(args:string[],spendAuthorized=false):Promise<CanvasEnvelope>{
    const spends=args[0]==="node"&&["confirm","run","upscale"].includes(args[1]??"")||args.includes("--run")||args.includes("--yes");
    if(spends&&!spendAuthorized)throw new CanvasRuntimeError("PAID_ACTION_NOT_AUTHORIZED");
    const result=await this.runner(this.config.executablePath,[...args,"--profile",this.config.profile,"--format","json","--non-interactive"],60_000);
    if(!result.ok){const code=result.error?.reason??result.error?.code??"INVALID_RESPONSE";
      const detail=result.error?.code==="cli.invalid_command"?":"+[result.error.validation?.reasonCode,result.error.validation?.fieldPath].filter(Boolean).join(":"):"";
      throw new CanvasRuntimeError(args.slice(0,2).join(".")+":"+code+detail,result.meta?.requestId??result.error?.requestId);}
    return result;
  }
  async assertAccount(){
    await this.verifyIdentity();
    const result=await this.call(["auth","account"]),uid=result.data?.userId;
    if(!Number.isSafeInteger(uid)||uid<=0)throw new CanvasRuntimeError("ACCOUNT_ID_MISSING");
    const fingerprint=createHash("sha256").update("jimeng:"+String(uid)).digest("hex");
    if(fingerprint!==this.config.expectedAccountFingerprint)throw new CanvasRuntimeError("ACCOUNT_MISMATCH");
    return {accountFingerprint:fingerprint,isVip:result.data?.isVip===true};
  }
  async findModel(name:string,type:"image"|"video"){
    const response=await this.call(["model","find",name,"--type",type]);
    const matches=(response.data?.items??[]).filter((m:any)=>m.model===name||m.aliases?.includes(name));
    if(matches.length!==1)throw new CanvasRuntimeError("MODEL_NOT_UNAMBIGUOUS");return matches[0];
  }
}
