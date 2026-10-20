import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import type {DouyinBrowserPublisherRuntime} from "../../application/ports/douyin-browser-publisher-runtime.js";
import {browserPageBindingSchema,browserPublishScopeSchema,type BrowserPageBinding,type BrowserPublishScope,type BrowserPageSnapshot,type BrowserPublishPreparationRuntime} from "../../application/ports/browser-publish-preparation.js";

export const egoStagedPublisherConfigSchema=z.object({
 contract:z.literal("pvs-ego-staged-local-v1"),mode:z.literal("LOCAL_FIXTURE_ONLY"),
 cliPath:z.string().min(1),cliSha256:z.string().regex(/^[a-f0-9]{64}$/),sdkPath:z.string().min(1),sdkSha256:z.string().regex(/^[a-f0-9]{64}$/),dataDir:z.string().min(1),
 editorUrl:z.string().url(),accountKey:z.string().min(1),
 session:z.object({instanceId:z.string().min(1),spaceId:z.number().int().positive(),spaceName:z.string().min(1),targetId:z.string().min(1)}).strict()
}).strict();
export type EgoStagedPublisherConfig=z.infer<typeof egoStagedPublisherConfigSchema>;
/** Supplied by the audited page integration, never by page text. No DOM-only success fallback. */
export type EgoUploadVerifier=(binding:BrowserPageBinding,selectedFileSha256:string)=>Promise<boolean>;
const exec=promisify(execFile);
const nativeStateSchema=z.object({account:z.object({type:z.literal("DOUYIN_UNIQUE_ID"),id:z.string().min(1)}),title:z.string(),description:z.string(),tags:z.array(z.string()),declaration:z.string(),videoSha256:z.string(),uploadState:z.string(),challenge:z.enum(["NONE","CAPTCHA","LOGIN","RISK"])}).strict();

/** Staged execution core, presently restricted to an owned local contract page. Not a verified Douyin site adapter. */
export class EgoStagedPublisherRuntime implements DouyinBrowserPublisherRuntime,BrowserPublishPreparationRuntime {
 readonly staged=this;
 readonly identity:string;
 readonly config:EgoStagedPublisherConfig;
 constructor(config:EgoStagedPublisherConfig,private readonly verifyUpload:EgoUploadVerifier){
  this.config=egoStagedPublisherConfigSchema.parse(config);
  const url=new URL(this.config.editorUrl);
  if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.username||url.password||![config.cliPath,config.sdkPath,config.dataDir].every(path.isAbsolute))throw new DomainValidationError("Ego 候选仅允许明确指定的本机模拟页和绝对路径；真实平台适配尚未验收");
  if(typeof verifyUpload!=="function")throw new DomainValidationError("缺少独立上传证明校验，不接受页面自报成功");
  this.identity="ego-staged:"+hashValue(this.config);
 }
 async resolveAccountName(){return this.config.accountKey;}
 async login():Promise<never>{throw new DomainValidationError("Ego 候选不自动登录或处理验证码，请使用原页面的明确人工接管流程");}
 async publish():Promise<never>{throw new DomainValidationError("Ego 候选仅支持原授权链中的分阶段准备与单次提交，不调用组合发布");}
 async probe(){try{await this.call("return {ready:true};");return {ok:true,status:"READY",engine:"EGO_STAGED_LOCAL_CANDIDATE"};}catch{return {ok:false,status:"UNAVAILABLE",message:"原 Ego 宿主、页面或控制权不可用，停止，不创建替代会话"};}}
 async check(account=this.config.accountKey){
  if(account!==this.config.accountKey)throw new DomainValidationError("原发布账号配置已变化");
  const raw=await this.call("return await nativeRead();");
  const value=nativeStateSchema.parse(raw);
  return {ok:true,account,valid:value.challenge!=="LOGIN",status:value.challenge==="LOGIN"?"AUTH_REQUIRED":"VALID",platformUserId:value.account.id};
 }
 private async call(body:string,binding?:BrowserPageBinding){
  if(this.identity!=="ego-staged:"+hashValue(this.config))throw new DomainValidationError("原 Ego 配置已改变，停止，不自动切换会话");
  for(const [file,sha] of [[this.config.cliPath,this.config.cliSha256],[this.config.sdkPath,this.config.sdkSha256]])if(sha256Bytes(await fs.readFile(file!))!==sha)throw new DomainValidationError("固定 Ego CLI/SDK 内容已变化，停止，不自动信任新版本");
  if(binding){browserPageBindingSchema.parse(binding);if(binding.runtimeId!==this.identity||binding.instanceId!==this.config.session.instanceId||binding.spaceId!==String(this.config.session.spaceId)||binding.pageId!=="p1:"+this.config.session.targetId||binding.accountKey!==this.config.accountKey)throw new DomainValidationError("原 Ego 运行时或宿主/Space/页面绑定已变化");}
  const nativeExpression=`(async()=>{
 if(document.querySelector('meta[name="pvs-ego-publish-fixture"]')?.content!=='v1')throw Error('UNSUPPORTED_PAGE_CONTRACT');
 const account=document.querySelector('#account'),file=document.querySelector('#video').files[0];
 const sha=file?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join(''):'';
 return {account:{type:account.getAttribute('data-kind'),id:account.getAttribute('data-id')},title:document.querySelector('#title').value,description:document.querySelector('#description').value,tags:document.querySelector('#tags').value.split(',').map(s=>s.trim()).filter(Boolean),declaration:document.querySelector('#declaration').value,videoSha256:sha,uploadState:document.querySelector('#upload').textContent,challenge:document.querySelector('#challenge').getAttribute('data-state')};})()`;
  const script=`const cfg=${JSON.stringify(this.config)},expected=${JSON.stringify(binding??null)};
if(process.env.EGO_BROWSER_HOST_INSTANCE_ID!==cfg.session.instanceId)throw Error('HOST_INSTANCE_CHANGED');
const descriptor=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===cfg.session.spaceId);
if(!descriptor||descriptor.name!==cfg.session.spaceName||descriptor.profileId!=='Default'||descriptor.ownership!=='agent')throw Error('CONTROL_OR_SPACE_CHANGED');
const task=await taskSpace(cfg.session.spaceId),page=task.page('p1');
async function guard(){const frame=(await page.cdp('Page.getFrameTree')).frameTree.frame;const target=(await task.cdp('Target.getTargetInfo',{targetId:page.targetId})).targetInfo;
 if(target.targetId!==cfg.session.targetId||target.url!==cfg.editorUrl||frame.url!==cfg.editorUrl||!frame.id||!frame.loaderId)throw Error('TARGET_OR_URL_CHANGED');
 const documentId=JSON.stringify({frameId:frame.id,loaderId:frame.loaderId});if(expected&&expected.documentId!==documentId)throw Error('DOCUMENT_CHANGED');return {frameId:frame.id,documentId};}
let nativeDocument=await guard();
async function nativeRead(){nativeDocument=await guard();const context=(await page.cdp('Page.createIsolatedWorld',{frameId:nativeDocument.frameId,worldName:'pvs-ego-staged-read'})).executionContextId;
 const result=await page.cdp('Runtime.evaluate',{contextId:context,returnByValue:true,awaitPromise:true,expression:${JSON.stringify(nativeExpression)}});
 if(result.exceptionDetails||!result.result?.value)throw Error('NATIVE_PAGE_READ_FAILED');await guard();return result.result.value;}
const result=await(async()=>{${body}})();console.log('PVS_EGO_STAGED '+JSON.stringify({result,documentId:nativeDocument.documentId}));`;
  try{
   const {stdout}=await exec(process.execPath,[this.config.cliPath,"nodejs","--sdk-path",this.config.sdkPath,"-e",script],{env:{...process.env,EGO_WINDOWS_DATA_DIR:this.config.dataDir,PSModulePath:path.join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/Modules")},windowsHide:true,timeout:30000,maxBuffer:1024*1024});
   const line=stdout.split(/\r?\n/).reverse().find(s=>s.startsWith("PVS_EGO_STAGED "));if(!line)throw Error("NO_RESULT");return JSON.parse(line.slice(15)).result;
  }catch{throw new DomainValidationError("Ego 原会话/页面/控制权或执行结果无法核实，停止；不重开、不重传、不自动重试");}
 }
 private binding(documentId:string):BrowserPageBinding{return {runtimeId:this.identity,instanceId:this.config.session.instanceId,spaceId:String(this.config.session.spaceId),pageId:"p1:"+this.config.session.targetId,documentId,accountKey:this.config.accountKey};}
 private async snapshot(binding?:BrowserPageBinding):Promise<BrowserPageSnapshot>{
  const raw=await this.call("const state=await nativeRead();return {state,documentId:nativeDocument.documentId};",binding),value=nativeStateSchema.parse(raw.state),pin=binding??this.binding(raw.documentId);
  const uploadComplete=value.uploadState==="COMPLETE"&&Boolean(value.videoSha256)&&await this.verifyUpload(pin,value.videoSha256);
  return {binding:pin,account:value.account,title:value.title,description:value.description,tags:value.tags,declaration:value.declaration,videoSha256:value.videoSha256,uploadComplete,challenge:value.challenge,connected:true,control:"AGENT"};
 }
 private scope(scope:BrowserPublishScope){browserPublishScopeSchema.parse(scope);if(scope.runtimeId!==this.identity||scope.accountKey!==this.config.accountKey||Date.parse(scope.expiresAt)<=Date.now())throw new DomainValidationError("原范围、运行时或许可期限失效");}
 async prepare(scope:BrowserPublishScope,videoPath:string){
  this.scope(scope);
  const before=await this.snapshot();
  if(before.account.id!==scope.account.id||before.challenge!=="NONE"||before.videoSha256)throw new DomainValidationError("需要原账号、无挑战且未准备过的当前页面；不重复上传或自动解决验证");
  if(!path.isAbsolute(videoPath)||sha256Bytes(await fs.readFile(videoPath))!==scope.videoSha256)throw new DomainValidationError("原成片文件或哈希不匹配");
  await this.call(`const state=await nativeRead(),scope=${JSON.stringify(scope)};
if(state.account.id!==scope.account.id||state.challenge!=='NONE'||state.videoSha256)throw Error('PREPARATION_SCOPE_CHANGED');
async function beforeMutation(){await guard();const current=await nativeRead();if(current.account.type!=='DOUYIN_UNIQUE_ID'||current.account.id!==scope.account.id||current.challenge!=='NONE'||current.videoSha256)throw Error('PREPARATION_IDENTITY_OR_STATE_CHANGED');}await beforeMutation();await page.fill('#title',scope.title);await beforeMutation();await page.fill('#description',scope.description);await beforeMutation();await page.fill('#tags',scope.tags.join(','));await beforeMutation();await page.fill('#declaration',scope.declaration);await beforeMutation();await page.setInputFiles('#video',${JSON.stringify(videoPath)});await page.waitForFunction(()=>document.querySelector('#upload').textContent==='COMPLETE',undefined,{timeout:10000});await guard();return {prepared:true};`,before.binding);
  return this.snapshot(before.binding);
 }
 inspect(binding:BrowserPageBinding){return this.snapshot(binding);}
 async handoff(binding:BrowserPageBinding){await this.call("await task.handOff();return {handedOff:true};",binding);}
 resume(binding:BrowserPageBinding){return this.inspect(binding);}
 async submit(binding:BrowserPageBinding,scope:BrowserPublishScope){
  this.scope(scope);const before=await this.inspect(binding);
  if(!before.uploadComplete||before.challenge!=="NONE"||before.account.id!==scope.account.id||before.videoSha256!==scope.videoSha256||before.title!==scope.title||before.description!==scope.description||hashValue(before.tags)!==hashValue(scope.tags)||before.declaration!==scope.declaration)throw new DomainValidationError("临提交原页面、账号、媒体或文案不匹配");
  await this.call(`const state=await nativeRead(),scope=${JSON.stringify(scope)};if(state.challenge!=='NONE'||state.account.type!=='DOUYIN_UNIQUE_ID'||state.account.id!==scope.account.id||state.uploadState!=='COMPLETE'||state.videoSha256!==scope.videoSha256||state.title!==scope.title||state.description!==scope.description||JSON.stringify(state.tags)!==JSON.stringify(scope.tags)||state.declaration!==scope.declaration)throw Error('LAST_MOMENT_DRIFT');await guard();await page.click('#submit',{label:'提交本地模拟表单'});return {clicked:true};`,binding);
  // DOM success is never trusted publication evidence. Original coordinator durably fences any unverified outcome.
  return {ok:true,account:this.config.accountKey,status:"SUBMITTED_UNVERIFIED",verified:false,message:"本地候选动作已调用，未核实平台结果；禁止自动重提"};
 }
}
