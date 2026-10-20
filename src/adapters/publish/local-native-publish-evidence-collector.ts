import type {Page,CDPSession} from "playwright-core";
import {z} from "zod";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import {browserPageBindingSchema,browserPublishScopeSchema,type BrowserPageBinding,type BrowserPublishScope} from "../../application/ports/browser-publish-preparation.js";
import {verifyDouyinUploadProof,verifyDouyinPublicationProof,type DouyinUploadProof} from "../../application/services/ego-douyin-site-proof.js";

const contractSchema=z.object({version:z.literal("pvs-local-native-evidence-v1"),mode:z.literal("LOCAL_FIXTURE_ONLY"),origin:z.string().url(),identitySelector:z.literal("#fixture-account"),uploadPath:z.literal("/fixture-upload"),submitPath:z.literal("/fixture-submit"),workPath:z.literal("/fixture-work"),maxEvents:z.number().int().min(4).max(500),maxBytes:z.number().int().min(1024).max(1024*1024)}).strict();
export type LocalNativeEvidenceContract=z.infer<typeof contractSchema>;
export type EvidenceControlGuard=()=>Promise<{binding:BrowserPageBinding;account:{type:"DOUYIN_UNIQUE_ID";id:string};control:"AGENT"|"USER";epoch:string}>;
type Packet={id:string;kind:"upload"|"submit"|"work";url:string;method:string;body?:string;response?:string;status?:number;terminal:boolean;failed:boolean};
type Sealed={kind:"UPLOAD"|"PUBLICATION";payload:any;digest:string;window:unknown};
export type CollectedEvidenceHandle=Readonly<{kind:"UPLOAD"|"PUBLICATION";digest:string;mode:"LOCAL_FIXTURE_ONLY"}>;
const uploadBody=z.object({uploadId:z.string().min(1),offset:z.number().int().nonnegative(),bytesBase64:z.string().min(1)}).strict();
const uploadResponse=z.object({uploadId:z.string().min(1),assetId:z.string().min(1),accountUniqueId:z.string().min(1),offset:z.number().int().nonnegative(),length:z.number().int().positive(),completed:z.boolean()}).strict();
const commitBody=z.object({submissionKey:z.string().min(1),scopeHash:z.string(),assetId:z.string(),accountUniqueId:z.string(),sourceSha256:z.string(),submittedAt:z.string().datetime()}).strict();
const workResponse=commitBody.extend({awemeId:z.string().regex(/^\d{8,30}$/),platformState:z.literal("PUBLISHED")}).strict();

/** Native CDP capture on a server-owned loopback fixture only. Never enabled for real Douyin. */
export class LocalNativePublishEvidenceCollector{
 #session!:CDPSession;
 #handles=new WeakMap<object,Sealed>();
 #publicationUploads=new WeakMap<object,CollectedEvidenceHandle>();
 #packets=new Map<string,Packet>();
 #tasks:Promise<void>[]=[];
 #errors:string[]=[];
 #count=0;#bytes=0;#active=false;#disconnected=false;#revoked=false;#epoch="";#startedAt="";
 #mode:"UPLOAD"|"PUBLICATION"="UPLOAD";
 #lost=()=>{this.#disconnected=true;};
 #publication?:{upload:CollectedEvidenceHandle;submittedAt:string;submissionKey:string};
 private constructor(private readonly page:Page,private readonly contract:LocalNativeEvidenceContract,private readonly scope:BrowserPublishScope,private readonly binding:BrowserPageBinding,private readonly expectedSource:Uint8Array,private readonly guard:EvidenceControlGuard){}
 static async attach(page:Page,rawContract:unknown,scope:BrowserPublishScope,binding:BrowserPageBinding,expectedSource:Uint8Array,guard:EvidenceControlGuard){
  const contract=contractSchema.parse(rawContract),u=new URL(contract.origin);
  if(u.protocol!=="http:"||u.hostname!=="127.0.0.1"||u.username||u.password||u.pathname!=="/"||u.search||u.hash||u.origin!==contract.origin)throw new DomainValidationError("NATIVE_COLLECTOR_LOCAL_ORIGIN_ONLY");
  scope=browserPublishScopeSchema.parse(scope);binding=browserPageBindingSchema.parse(binding);
  if(scope.runtimeId!==binding.runtimeId||scope.accountKey!==binding.accountKey||sha256Bytes(expectedSource)!==scope.videoSha256||expectedSource.byteLength>contract.maxBytes||!expectedSource.byteLength)throw new DomainValidationError("NATIVE_SOURCE_OR_SCOPE_MISMATCH");
  const collector=new LocalNativePublishEvidenceCollector(page,contract,scope,binding,Uint8Array.from(expectedSource),guard);
  collector.#session=await page.context().newCDPSession(page);
  try{
   await collector.check();
   const marker=await collector.#session.send("Runtime.evaluate",{expression:"document.querySelector('meta[name=\"pvs-native-evidence-fixture\"]')?.content==='v1'",returnByValue:true});
   if(marker.result?.value!==true)throw new DomainValidationError("OWNED_NATIVE_FIXTURE_MARKER_REQUIRED");
   page.on("close",collector.#lost);page.on("crash",collector.#lost);page.context().browser()?.on("disconnected",collector.#lost);
   collector.#session.on("Network.requestWillBeSent",e=>collector.request(e));
   collector.#session.on("Network.responseReceived",e=>collector.response(e));
   collector.#session.on("Network.loadingFinished",e=>collector.finished(e));
   collector.#session.on("Network.loadingFailed",e=>{const p=collector.#packets.get(e.requestId);if(p){p.failed=true;p.terminal=true;}});
   await collector.#session.send("Network.enable",{maxTotalBufferSize:contract.maxBytes*2,maxResourceBufferSize:contract.maxBytes,maxPostDataSize:contract.maxBytes});
   return collector;
  }catch(error){await collector.#session.detach().catch(()=>undefined);throw error;}
 }
 private async check(){
  if(this.#disconnected)throw new DomainValidationError("NATIVE_SESSION_DISCONNECTED");
  if(this.#revoked)throw new DomainValidationError("NATIVE_CAPTURE_CONTEXT_REVOKED");
  try{
  const current=await this.guard();
  if(current.control!=="AGENT"||current.account.type!==this.scope.account.type||current.account.id!==this.scope.account.id||hashValue(current.binding)!==hashValue(this.binding)||!current.epoch||(this.#epoch&&this.#epoch!==current.epoch))throw new DomainValidationError("NATIVE_CONTROL_ACCOUNT_OR_BINDING_CHANGED");
  this.#epoch=current.epoch;
  const f=(await this.#session.send("Page.getFrameTree")).frameTree.frame;
  const target=(await this.#session.send("Target.getTargetInfo")).targetInfo;
  if(new URL(f.url).origin!==this.contract.origin||new URL(f.url).pathname!=="/fixture-editor"||target.targetId!==f.id||this.binding.pageId!=="p1:"+target.targetId||this.binding.documentId!==JSON.stringify({frameId:f.id,loaderId:f.loaderId}))throw new DomainValidationError("NATIVE_DOCUMENT_CHANGED");
  const world=(await this.#session.send("Page.createIsolatedWorld",{frameId:f.id,worldName:"pvs-owned-local-evidence-account"})).executionContextId;
  const identity=await this.#session.send("Runtime.evaluate",{contextId:world,returnByValue:true,expression:"(()=>{const n=document.querySelectorAll('#fixture-account');if(n.length!==1)return null;return n[0].innerText.trim().match(/^抖音号[：:]\\s*([A-Za-z0-9_.-]+)$/)?.[1]??null;})()"});
  if(identity.exceptionDetails||identity.result?.value!==this.scope.account.id)throw new DomainValidationError("NATIVE_VISIBLE_ACCOUNT_CHANGED");
  }catch(error){this.#revoked=true;throw error;}
 }
 private error(code:string){if(!this.#errors.includes(code))this.#errors.push(code);}
 private bounded(text:string){this.#bytes+=Buffer.byteLength(text);if(this.#bytes>this.contract.maxBytes){this.error("CAPTURE_BYTES_TRUNCATED");return false;}return true;}
 private request(e:any){
  if(!this.#active)return;
  let u:URL;try{u=new URL(e.request.url);}catch{return;}
  if(u.origin!==this.contract.origin)return;
  const kind=u.pathname===this.contract.uploadPath?"upload":u.pathname===this.contract.submitPath?"submit":u.pathname===this.contract.workPath?"work":undefined;if(!kind)return;
  if(++this.#count>this.contract.maxEvents){this.error("CAPTURE_EVENTS_TRUNCATED");return;}
  const document=JSON.parse(this.binding.documentId);
  if(e.redirectResponse||this.#packets.has(e.requestId)||u.search||u.hash||e.frameId!==document.frameId||e.loaderId!==document.loaderId||e.request.method!==(kind==="work"?"GET":"POST")||typeof e.wallTime!=="number"||e.wallTime*1000<Date.parse(this.#startedAt)||(kind!=="work"&&e.wallTime*1000>Date.parse(this.scope.expiresAt))){this.error("UNBOUND_REDIRECT_DUPLICATE_OR_METHOD");return;}
  const p:Packet={id:e.requestId,kind,url:u.href,method:e.request.method,terminal:false,failed:false};this.#packets.set(p.id,p);
  if(p.method==="POST"){
   if(typeof e.request.postData==="string"){if(this.bounded(e.request.postData))p.body=e.request.postData;}
   else this.#tasks.push(this.#session.send("Network.getRequestPostData",{requestId:p.id}).then(r=>{if(this.bounded(r.postData))p.body=r.postData;}).catch(()=>{this.error("NATIVE_REQUEST_BODY_UNAVAILABLE");}));
  }
 }
 private response(e:any){const p=this.#packets.get(e.requestId);if(!p||!this.#active)return;
  if(e.response.url!==p.url||e.response.fromDiskCache||e.response.fromServiceWorker||e.response.status!==200||!String(e.response.mimeType).includes("json")){this.error("RESPONSE_NOT_CURRENT_NATIVE_JSON_SUCCESS");return;}
  p.status=e.response.status;
 }
 private finished(e:any){const p=this.#packets.get(e.requestId);if(!p||!this.#active)return;p.terminal=true;
  if(e.encodedDataLength>this.contract.maxBytes){this.error("RESPONSE_TOO_LARGE");return;}
  if(p.status!==200)return;
  this.#tasks.push(this.#session.send("Network.getResponseBody",{requestId:p.id}).then(r=>{const text=r.base64Encoded?Buffer.from(r.body,"base64").toString("utf8"):r.body;if(this.bounded(text))p.response=text;}).catch(()=>{this.error("NATIVE_RESPONSE_BODY_UNAVAILABLE");}));
 }
 private async begin(mode:"UPLOAD"|"PUBLICATION"){
  if(this.#active)throw new DomainValidationError("NATIVE_CAPTURE_ALREADY_ACTIVE");
  await this.check();if(Date.parse(this.scope.expiresAt)<=Date.now())throw new DomainValidationError("NATIVE_SCOPE_EXPIRED");
  this.#packets.clear();this.#tasks=[];this.#errors=[];this.#count=0;this.#bytes=0;this.#mode=mode;this.#startedAt=new Date().toISOString();this.#active=true;
 }
 beginUpload(){return this.begin("UPLOAD");}
 captureStatus(){return {active:this.#active,nativeRequests:this.#count,pendingRequests:[...this.#packets.values()].filter(p=>!p.terminal).length,errors:[...this.#errors]};}
 async beginPublication(upload:CollectedEvidenceHandle,submittedAt:string,submissionKey:string){
  await this.verifyUpload(upload);if(!Number.isFinite(Date.parse(submittedAt))||Date.parse(submittedAt)>Date.now()||Date.parse(submittedAt)>Date.parse(this.scope.expiresAt)||!submissionKey)throw new DomainValidationError("SUBMISSION_TIME_OR_KEY_INVALID");
  await this.begin("PUBLICATION");this.#publication={upload,submittedAt,submissionKey};
 }
 private async end(mode:"UPLOAD"|"PUBLICATION"){
  if(!this.#active||this.#mode!==mode)throw new DomainValidationError("NATIVE_CAPTURE_PHASE_CHANGED");
  this.#active=false;await Promise.all(this.#tasks);await this.check();
  if(Date.now()-Date.parse(this.#startedAt)>30000)this.error("CAPTURE_WINDOW_EXCEEDED");
  if([...this.#packets.values()].some(p=>!p.terminal))this.error("NATIVE_REQUEST_STILL_PENDING");
  return {startedAt:this.#startedAt,finishedAt:new Date().toISOString(),nativeRequests:this.#count,bytes:this.#bytes,errors:[...this.#errors],boundedWindowOnly:true,platformExactlyOnce:false};
 }
 private seal(kind:Sealed["kind"],payload:any,window:unknown){const digest=hashValue(payload),handle=Object.freeze({kind,digest,mode:"LOCAL_FIXTURE_ONLY" as const});this.#handles.set(handle,{kind,payload:structuredClone(payload),digest,window});return handle;}
 private sealed(handle:unknown,kind:Sealed["kind"]){const value=handle&&typeof handle==="object"?this.#handles.get(handle):undefined;if(!value||value.kind!==kind||value.digest!==hashValue(value.payload))throw new DomainValidationError("COLLECTOR_ATTESTATION_REQUIRED_NOT_SOURCE_JSON");return value;}
 async finishUpload(){
  const window=await this.end("UPLOAD");if(window.errors.length)throw new DomainValidationError(window.errors.join(";"));
  const packets=[...this.#packets.values()];if(!packets.length||packets.some(p=>p.kind!=="upload"||p.failed||!p.body||!p.response))throw new DomainValidationError("NATIVE_UPLOAD_INCOMPLETE");
  const chunks=packets.map(p=>({p,request:uploadBody.parse(JSON.parse(p.body!)),response:uploadResponse.parse(JSON.parse(p.response!))})).sort((a,b)=>a.request.offset-b.request.offset);
  let offset=0;const parts:Buffer[]=[];let assetId="",uploadId="";
  for(const [index,c]of chunks.entries()){
   const bytes=Buffer.from(c.request.bytesBase64,"base64");
   if(!bytes.length||bytes.toString("base64")!==c.request.bytesBase64||c.request.offset!==offset||c.response.offset!==offset||c.response.length!==bytes.length||c.response.accountUniqueId!==this.scope.account.id||c.response.uploadId!==c.request.uploadId||(assetId&&assetId!==c.response.assetId)||(uploadId&&uploadId!==c.request.uploadId)||c.response.completed!==(index===chunks.length-1))throw new DomainValidationError("NATIVE_CHUNK_OR_ASSET_LINK_INVALID");
   assetId=c.response.assetId;uploadId=c.request.uploadId;offset+=bytes.length;parts.push(bytes);
  }
  const source=Buffer.concat(parts);if(source.length!==this.expectedSource.length||sha256Bytes(source)!==this.scope.videoSha256||!source.equals(Buffer.from(this.expectedSource)))throw new DomainValidationError("NATIVE_SOURCE_BYTES_NOT_PROVEN");
  const proof:DouyinUploadProof={version:"ego-douyin-upload-v1",source:"TRUSTED_CDP_NETWORK_COLLECTOR",binding:this.binding,scopeHash:hashValue(this.scope),sourceSha256:this.scope.videoSha256,requestId:chunks.map(c=>c.p.id).join(","),requestBodySha256:hashValue(chunks.map(c=>sha256Bytes(Buffer.from(c.p.body!)))),responseSha256:hashValue(chunks.map(c=>sha256Bytes(Buffer.from(c.p.response!)))),assetId,accountUniqueId:this.scope.account.id,completed:true,observedAt:new Date().toISOString()};
  verifyDouyinUploadProof(proof,this.binding,this.scope);return this.seal("UPLOAD",proof,window);
 }
 async verifyUpload(handle:unknown){await this.check();const value=this.sealed(handle,"UPLOAD");const proof=verifyDouyinUploadProof(value.payload,this.binding,this.scope,new Date(Math.min(Date.now(),Date.parse(this.scope.expiresAt)-1)));return {proof,window:value.window,mode:"LOCAL_FIXTURE_ONLY" as const,productionAccepted:false as const};}
 async finishPublication(){
  const window=await this.end("PUBLICATION"),p=this.#publication!;
  const unknown=(reason:string)=>({status:"SUBMISSION_UNKNOWN" as const,verified:false as const,reason,window,automaticResubmit:false as const,productionAccepted:false as const});
  if(window.errors.length)return unknown(window.errors.join(";"));
  const packets=[...this.#packets.values()],commits=packets.filter(p=>p.kind==="submit"),works=packets.filter(p=>p.kind==="work");
  if(commits.length!==1||works.length!==1||packets.some(p=>p.kind==="upload"))return unknown("EXACTLY_ONE_NATIVE_SUBMIT_AND_DETAIL_REQUIRED");
  const c=commits[0]!,w=works[0]!;if(!c.body||w.failed||!w.response)return unknown("CURRENT_WORK_DETAIL_UNAVAILABLE");
  try{
   const upload=(await this.verifyUpload(p.upload)).proof,body=commitBody.parse(JSON.parse(c.body)),work=workResponse.parse(JSON.parse(w.response));
   const expected={submissionKey:p.submissionKey,scopeHash:hashValue(this.scope),assetId:upload.assetId,accountUniqueId:this.scope.account.id,sourceSha256:this.scope.videoSha256,submittedAt:p.submittedAt};
   const {awemeId:_,platformState:__,...workLink}=work;
   if(hashValue(body)!==hashValue(expected)||hashValue(workLink)!==hashValue(expected))return unknown("SUBMISSION_AND_WORK_DETAIL_NOT_LINKED");
   const proof={version:"ego-douyin-publication-v1",source:"TRUSTED_WORK_DETAIL_COLLECTOR",scopeHash:hashValue(this.scope),uploadRequestId:upload.requestId,assetId:upload.assetId,accountUniqueId:this.scope.account.id,awemeId:work.awemeId,platformState:"PUBLISHED",workDetailSha256:sha256Bytes(Buffer.from(w.response)),submittedAt:p.submittedAt,observedAt:new Date().toISOString()};
   verifyDouyinPublicationProof(proof,upload,this.scope,p.submittedAt);
   const handle=this.seal("PUBLICATION",{proof,uploadDigest:p.upload.digest,submittedAt:p.submittedAt},window);this.#publicationUploads.set(handle,p.upload);
   return {status:"COLLECTED_LOCAL_PUBLICATION" as const,verified:false as const,handle,window,productionAccepted:false as const};
  }catch{return unknown("INVALID_OR_UNATTESTED_WORK_DETAIL");}
 }
 async verifyPublication(handle:unknown){await this.check();const v=this.sealed(handle,"PUBLICATION"),uploadHandle=this.#publicationUploads.get(handle as object);if(!uploadHandle||uploadHandle.digest!==v.payload.uploadDigest)throw new DomainValidationError("ORIGINAL_UPLOAD_ATTESTATION_MISSING");const upload=(await this.verifyUpload(uploadHandle)).proof;const result=verifyDouyinPublicationProof(v.payload.proof,upload,this.scope,v.payload.submittedAt);return {...result,verified:false as const,localEvidenceVerified:true as const,window:v.window,mode:"LOCAL_FIXTURE_ONLY" as const,productionAccepted:false as const};}
 async close(){this.#active=false;this.page.off("close",this.#lost);this.page.off("crash",this.#lost);this.page.context().browser()?.off("disconnected",this.#lost);await this.#session.detach().catch(()=>undefined);this.#disconnected=true;}
}
