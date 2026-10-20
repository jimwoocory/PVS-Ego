import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import {assessDouyinPage,douyinReadOnlyDomExpression} from "../../application/services/douyin-page-observation.js";
import type {EgoInspectionConfig} from "./ego-douyin-inspection-driver.js";

const selector=z.string().trim().min(1).max(512),hash=z.string().regex(/^[a-f0-9]{64}$/);
const configSchema=z.object({cliPath:z.string(),cliSha256:hash,sdkPath:z.string(),sdkSha256:hash,dataDir:z.string(),session:z.object({instanceId:z.string().min(1),spaceId:z.number().int().positive(),spaceName:z.string().min(1),targetId:z.string().min(1)}).strict()}).strict();
export const douyinObservationContractSchema=z.object({version:z.literal("ego-douyin-readonly-page-v1"),url:z.string().url(),
 selectors:z.object({uploadEntry:selector,title:selector.nullable(),description:selector.nullable(),tags:selector.nullable(),declaration:selector.nullable(),submit:selector.nullable()}).strict(),
 evidence:z.object({source:z.enum(["REAL_SITE_CAPTURE","LOCAL_MIRROR"]),captureSha256:hash,sdkSha256:hash,capturedAt:z.string().datetime(),expiresAt:z.string().datetime(),reviewed:z.literal(true),scope:z.literal("OBSERVATION_ONLY_NOT_EDITOR_OR_WRITE_APPROVAL")}).strict()
}).strict();
export type DouyinObservationContract=z.infer<typeof douyinObservationContractSchema>;
const exec=promisify(execFile);

/** An actual pinned Ego SDK driver with read-only APIs only. Never imports the dedicated Chromium session. */
export class EgoDouyinReadOnlyPageDriver{
 private readonly config:EgoInspectionConfig;
 private readonly contract:DouyinObservationContract;
 private readonly pin:string;
 constructor(config:EgoInspectionConfig,contract:unknown,private readonly localMirror=false){
  this.config=configSchema.parse(config);this.contract=douyinObservationContractSchema.parse(contract);this.pin=hashValue({config:this.config,contract:this.contract});this.validate();
 }
 private validate(){
  const c=this.config,k=this.contract,u=new URL(k.url),now=Date.now();
  if(![c.cliPath,c.sdkPath,c.dataDir].every(path.isAbsolute)||u.username||u.password||u.search||u.hash)throw new DomainValidationError("READ_ONLY_PAGE_CONFIG_INVALID");
  if(this.localMirror?u.protocol!=="http:"||u.hostname!=="127.0.0.1":u.origin!=="https://creator.douyin.com"||!/^\/creator-micro\/content\/(upload|post\/video)$/.test(u.pathname))throw new DomainValidationError("READ_ONLY_PAGE_ORIGIN_REJECTED");
  if(k.evidence.source!==(this.localMirror?"LOCAL_MIRROR":"REAL_SITE_CAPTURE")||k.evidence.sdkSha256!==c.sdkSha256||Date.parse(k.evidence.capturedAt)>now||Date.parse(k.evidence.expiresAt)<=now||Date.parse(k.evidence.expiresAt)<=Date.parse(k.evidence.capturedAt))throw new DomainValidationError("READ_ONLY_PAGE_EVIDENCE_INVALID_OR_EXPIRED");
  const known=Object.values(k.selectors).filter(s=>s!==null);
  if(new Set(known).size!==known.length)throw new DomainValidationError("READ_ONLY_CONTROL_SELECTORS_NOT_DISTINCT");
  if(this.pin!==hashValue({config:c,contract:k}))throw new DomainValidationError("READ_ONLY_CONFIG_CHANGED");
 }
 async observe(expectedAccountId?:string,expectedNative?:{instanceId:string;spaceId:number;targetId:string;frameId:string;loaderId:string}){
  this.validate();const c=this.config,k=this.contract;
  for(const [file,expected]of[[c.cliPath,c.cliSha256],[c.sdkPath,c.sdkSha256]])if(sha256Bytes(await fs.readFile(file!))!==expected)throw new DomainValidationError("PINNED_EGO_CODE_CHANGED");
  const expression=douyinReadOnlyDomExpression(k.selectors);
  const script=`const cfg=${JSON.stringify(c)},url=${JSON.stringify(k.url)};
if(process.env.EGO_BROWSER_HOST_INSTANCE_ID!==cfg.session.instanceId)throw Error('INSTANCE_CHANGED');
const descriptor=(await ego.listTaskSpaces()).taskSpaces.find(s=>s.id===cfg.session.spaceId);
if(!descriptor||descriptor.name!==cfg.session.spaceName||descriptor.profileId!=='Default'||descriptor.ownership!=='agent')throw Error('CONTROL_OR_SPACE_CHANGED');
const task=await taskSpace(cfg.session.spaceId),page=task.page('p1');
async function native(){const f=(await page.cdp('Page.getFrameTree')).frameTree.frame,t=(await task.cdp('Target.getTargetInfo',{targetId:page.targetId})).targetInfo;
if(t.targetId!==cfg.session.targetId||t.url!==url||f.url!==url||!f.id||!f.loaderId)throw Error('PAGE_CHANGED');return {frameId:f.id,loaderId:f.loaderId};}
const before=await native(),world=(await page.cdp('Page.createIsolatedWorld',{frameId:before.frameId,worldName:'pvs-u3-page-observation'})).executionContextId;
const r=await page.cdp('Runtime.evaluate',{contextId:world,returnByValue:true,expression:${JSON.stringify(expression)}});
if(r.exceptionDetails||!r.result?.value)throw Error('OBSERVATION_FAILED');const after=await native();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('DOCUMENT_CHANGED');
console.log('PVS_U3_OBSERVE '+JSON.stringify({native:before,observation:r.result.value}));`;
  try{
   const {stdout}=await exec(process.execPath,[c.cliPath,"nodejs","--sdk-path",c.sdkPath,"-e",script],{env:{...process.env,EGO_WINDOWS_DATA_DIR:c.dataDir,PSModulePath:path.join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/Modules")},windowsHide:true,timeout:30000,maxBuffer:1024*1024});
   const line=stdout.split(/\r?\n/).find(s=>s.startsWith("PVS_U3_OBSERVE "));if(!line)throw Error('NO_NATIVE_RESULT');
   const result=JSON.parse(line.slice(15));this.validate();
   const native={instanceId:c.session.instanceId,spaceId:c.session.spaceId,targetId:c.session.targetId,...result.native};
   if(expectedNative&&hashValue(native)!==hashValue(expectedNative))throw Error('ORIGINAL_DOCUMENT_CHANGED');
   return {...assessDouyinPage(result.observation,expectedAccountId),native,source:this.localMirror?"ACTUAL_EGO_LOCAL_MIRROR":"ACTUAL_EGO_REAL_PAGE",evidenceScope:k.evidence.scope};
  }catch{throw new DomainValidationError("READ_ONLY_ORIGINAL_PAGE_UNAVAILABLE_NO_REOPEN_NO_UPLOAD_NO_SUBMIT");}
 }
}
