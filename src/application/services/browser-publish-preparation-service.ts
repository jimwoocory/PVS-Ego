import {randomUUID} from "node:crypto";
import {hashValue} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import {browserPageBindingSchema,browserPublishScopeSchema,type BrowserPublishCheckpoint as Checkpoint,type BrowserPublishScope as Scope,type BrowserPageSnapshot,type BrowserPublishCheckpointRepository,type BrowserPublishPreparationRuntime} from "../ports/browser-publish-preparation.js";
import type {PublishRepository} from "../ports/publish-repository.js";

type ScopeLoader=(projectId:string,packageId:string,expectedAccountId:string,previous?:Scope)=>Promise<{scope:Scope;videoPath:string}>;
export class BrowserPublishPreparationService {
 constructor(readonly checkpoints:BrowserPublishCheckpointRepository,private readonly runtime:BrowserPublishPreparationRuntime|undefined,private readonly load:ScopeLoader,private readonly packages:PublishRepository){}
 status(projectId:string,packageId:string){return this.checkpoints.latest(projectId,packageId);}
 private requireRuntime(){if(!this.runtime)throw new DomainValidationError("当前浏览器运行时没有分阶段预检/人工接管能力；停止，不降级为组合上传发布");return this.runtime;}
 private async append(prior:Checkpoint|null,scope:Scope,phase:Checkpoint["phase"],binding?:Checkpoint["binding"],reason?:string){
  const body={id:randomUUID(),projectId:scope.projectId,packageId:scope.packageId,version:(prior?.version??0)+1,phase,scope,scopeHash:hashValue(scope),...(binding?{binding:browserPageBindingSchema.parse(binding)}:{}),...(reason?{reason}:{}),createdAt:new Date().toISOString()};
  const cp:Checkpoint={...body,contentHash:hashValue(body)};
  if(!await this.checkpoints.append(cp,prior?.version??0))throw new DomainValidationError("发布检查点已改变或由另一任务占用；停止，不自动重试");return cp;
 }
 private async current(cp:Checkpoint){
  const {scope,videoPath}=await this.load(cp.projectId,cp.packageId,cp.scope.account.id,cp.scope);
  if(hashValue(scope)!==cp.scopeHash||Date.parse(scope.expiresAt)<=Date.now()||this.requireRuntime().identity!==scope.runtimeId)throw new DomainValidationError("发布账号、成片、文案、许可期限或运行实例已改变；停止，不沿用旧确认");
  return {scope,videoPath};
 }
 private phase(scope:Scope,snapshot:BrowserPageSnapshot,binding?:Checkpoint["binding"]):Checkpoint["phase"]{
  if(!snapshot.connected||snapshot.binding.runtimeId!==scope.runtimeId||snapshot.binding.accountKey!==scope.accountKey||(binding&&hashValue(binding)!==hashValue(snapshot.binding)))throw new DomainValidationError("原浏览器实例、页面或文档已断开/改变；不能重开页面续接");
  if(snapshot.account.type!==scope.account.type||snapshot.account.id!==scope.account.id)throw new DomainValidationError("发布账号强身份或标识类型已改变");
  if(snapshot.control!=="AGENT")throw new DomainValidationError("页面正在由用户接管；禁止自动读取或夺回控制");
  if(snapshot.challenge!=="NONE")return "WAITING_PLATFORM_VERIFICATION";
  if(!snapshot.uploadComplete||snapshot.videoSha256!==scope.videoSha256||snapshot.title!==scope.title||snapshot.description!==scope.description||hashValue(snapshot.tags)!==hashValue(scope.tags)||snapshot.declaration!==scope.declaration)throw new DomainValidationError("上传未完成或当前页面成片/标题/话题/AI声明不匹配；停止，不自动重填或重传");
  return "READY_FOR_CONFIRMATION";
 }
 private async blocked(cp:Checkpoint){await this.append(cp,cp.scope,"BLOCKED",cp.binding,"REVALIDATION_FAILED_NO_AUTOMATIC_RETRY").catch(()=>undefined);}
 async prepare(input:{projectId:string;packageId:string;expectedAccountId:string;confirmedPreparation:boolean}){
  if(!input.confirmedPreparation)throw new DomainValidationError("预检可能包含上传和填表，必须明确确认本次准备范围；这不是提交授权");
  const runtime=this.requireRuntime();const old=await this.status(input.projectId,input.packageId);
  if(old)throw new DomainValidationError("该发布包已有检查点，请查看或续接原任务，禁止重复准备/上传");
  const {scope,videoPath}=await this.load(input.projectId,input.packageId,input.expectedAccountId);browserPublishScopeSchema.parse(scope);
  let cp=await this.append(null,scope,"PREPARING");
  await this.packages.updatePackage(scope.packageId,{status:"AWAITING_USER_ACTION"});
  try{const snapshot=await runtime.prepare(scope,videoPath);cp=await this.append(cp,scope,this.phase(scope,snapshot),snapshot.binding);return cp;}
  catch(error){await this.blocked(cp);throw error;}
 }
 async handoff(input:{projectId:string;packageId:string;confirmed:boolean}){
  let cp=await this.status(input.projectId,input.packageId);
  if(!cp?.binding||!["WAITING_PLATFORM_VERIFICATION","READY_FOR_CONFIRMATION","RESTORED_WAITING_CONTINUE"].includes(cp.phase)||!input.confirmed)throw new DomainValidationError("需要当前等待状态和明确人工接管确认");
  await this.current(cp);cp=await this.append(cp,cp.scope,"HANDOFF_PENDING",cp.binding);
  try{await this.requireRuntime().handoff(cp.binding!);return await this.append(cp,cp.scope,"WAITING_USER_CONTROL",cp.binding);}
  catch(error){await this.blocked(cp);throw error;}
 }
 async resume(input:{projectId:string;packageId:string;confirmedReturnControl:boolean}){
  let cp=await this.status(input.projectId,input.packageId);
  if(!cp?.binding||cp.phase!=="WAITING_USER_CONTROL"||!input.confirmedReturnControl)throw new DomainValidationError("用户完成验证并明确归还控制后才能续接；归还不代表同意发布");
  try{await this.current(cp);cp=await this.append(cp,cp.scope,"RESUMING",cp.binding);const snapshot=await this.requireRuntime().resume(cp.binding!);const phase=this.phase(cp.scope,snapshot,cp.binding);return await this.append(cp,cp.scope,phase==="READY_FOR_CONFIRMATION"?"RESTORED_WAITING_CONTINUE":phase,cp.binding);}
  catch(error){await this.blocked(cp);throw error;}
 }
 async authorizeSubmit(input:{projectId:string;packageId:string;scopeHash?:string;revision?:number;expectedAccountId?:string;confirmed:boolean}){
  const cp=await this.status(input.projectId,input.packageId);
  if(!cp?.binding||!["READY_FOR_CONFIRMATION","RESTORED_WAITING_CONTINUE"].includes(cp.phase)||!input.confirmed||input.scopeHash!==cp.scopeHash||input.revision!==cp.version||input.expectedAccountId!==cp.scope.account.id)throw new DomainValidationError("需要本次预检范围和最新检查点的单独提交确认；旧确认或未知结果禁止重提");
  try{await this.current(cp);const snapshot=await this.requireRuntime().inspect(cp.binding);const phase=this.phase(cp.scope,snapshot,cp.binding);if(phase!=="READY_FOR_CONFIRMATION"){await this.append(cp,cp.scope,phase,cp.binding);throw new DomainValidationError("仍在等待平台验证，需要人工处理后重新确认");}}
  catch(error){const latest=await this.status(cp.projectId,cp.packageId);if(latest?.version===cp.version)await this.blocked(cp);throw error;}
  return this.append(cp,cp.scope,"SUBMITTING",cp.binding);
 }
 async finish(cp:Checkpoint,phase:"PUBLISHED_CONFIRMED"|"SUBMISSION_UNKNOWN"){return this.append(cp,cp.scope,phase,cp.binding);}
}
