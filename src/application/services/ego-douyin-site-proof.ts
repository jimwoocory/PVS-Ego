import {z} from "zod";
import {hashValue} from "../../domain/hashing.js";
import {browserPageBindingSchema,browserPublishScopeSchema,type BrowserPageBinding,type BrowserPublishScope} from "../ports/browser-publish-preparation.js";
import {DomainValidationError} from "../../domain/validation.js";

const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().trim().min(1),time=z.string().datetime();
const selector=text.max(512);
export const douyinPageContractSchema=z.object({
 version:z.literal("ego-douyin-site-v1"),editorUrl:z.string().url(),
 selectors:z.object({account:selector,title:selector,description:selector,file:selector,selectedDeclaration:selector,submit:selector}).strict(),
 evidence:z.object({source:z.enum(["LOCAL_MIRROR","REAL_SITE_CAPTURE"]),captureSha256:hash,capturedAt:time,expiresAt:time,
  sdkSha256:hash,sourceRevision:hash,reviewed:z.boolean()}).strict()
}).strict();
export type DouyinPageContract=z.infer<typeof douyinPageContractSchema>;

/** Reviewed selectors are evidence, never inferred from an old third-party source. */
export function requireDouyinPageContract(raw:unknown,actualSdkSha256:string,now=new Date(),localMirror=false){
 const c=douyinPageContractSchema.parse(raw),u=new URL(c.editorUrl),e=c.evidence;
 if(u.username||u.password||u.hash||u.search)throw new DomainValidationError("页面地址包含未审阅参数");
 const originOk=localMirror?u.protocol==="http:"&&u.hostname==="127.0.0.1":u.protocol==="https:"&&u.hostname==="creator.douyin.com"&&u.port==="";
 if(!originOk||(!localMirror&&!/^\/creator-micro\/(?:content\/(?:upload|post\/video))$/.test(u.pathname)))throw new DomainValidationError("页面不属于已限定的创作者编辑页");
 if(!e.reviewed||e.sdkSha256!==actualSdkSha256||Date.parse(e.capturedAt)>now.getTime()||Date.parse(e.expiresAt)<=now.getTime()||Date.parse(e.expiresAt)<=Date.parse(e.capturedAt))throw new DomainValidationError("页面契约未审核、已过期或 SDK 已变化");
 if(e.source!==(localMirror?"LOCAL_MIRROR":"REAL_SITE_CAPTURE"))throw new DomainValidationError("本机模拟证据不能启用真实平台");
 if(new Set(Object.values(c.selectors)).size!==Object.values(c.selectors).length)throw new DomainValidationError("账号、媒体、文案和提交选择器必须分离");
 return c;
}

const uploadSchema=z.object({version:z.literal("ego-douyin-upload-v1"),source:z.literal("TRUSTED_CDP_NETWORK_COLLECTOR"),binding:browserPageBindingSchema,
 scopeHash:hash,sourceSha256:hash,requestId:text,requestBodySha256:hash,responseSha256:hash,
 assetId:text,accountUniqueId:text,completed:z.literal(true),observedAt:time}).strict();
export type DouyinUploadProof=z.infer<typeof uploadSchema>;
/** Structural consistency only; the source field is not collector provenance or publication authority. */
export function verifyDouyinUploadProof(raw:unknown,binding:BrowserPageBinding,scope:BrowserPublishScope,now=new Date()){
 const p=uploadSchema.parse(raw);browserPublishScopeSchema.parse(scope);browserPageBindingSchema.parse(binding);
 if(hashValue(p.binding)!==hashValue(binding)||binding.runtimeId!==scope.runtimeId||binding.accountKey!==scope.accountKey||
  p.scopeHash!==hashValue(scope)||p.sourceSha256!==scope.videoSha256||p.accountUniqueId!==scope.account.id||
  Date.parse(p.observedAt)>now.getTime()||Date.parse(p.observedAt)>Date.parse(scope.expiresAt)||Date.parse(scope.expiresAt)<=now.getTime())throw new DomainValidationError("上传证明与原页面、账号、素材、授权范围或时间不一致");
 // requestBodySha256 is the actual (possibly multipart/chunk aggregate) request digest;
 // it is NOT assumed equal to the source file digest. Collector must prove the linkage.
 return p;
}

const publicationSchema=z.object({version:z.literal("ego-douyin-publication-v1"),source:z.literal("TRUSTED_WORK_DETAIL_COLLECTOR"),
 scopeHash:hash,uploadRequestId:text,assetId:text,accountUniqueId:text,awemeId:z.string().regex(/^\d{8,30}$/),
 platformState:z.literal("PUBLISHED"),workDetailSha256:hash,submittedAt:time,observedAt:time}).strict();
/** Structural consistency only. Accept native evidence through an audited collector, never client/page JSON. */
export function verifyDouyinPublicationProof(raw:unknown,upload:DouyinUploadProof,scope:BrowserPublishScope,submittedAt:string,now=new Date()){
 const p=publicationSchema.parse(raw);verifyDouyinUploadProof(upload,upload.binding,scope,new Date(Math.min(now.getTime(),Date.parse(scope.expiresAt)-1)));
 if(p.scopeHash!==hashValue(scope)||p.uploadRequestId!==upload.requestId||p.assetId!==upload.assetId||p.accountUniqueId!==scope.account.id||
  p.submittedAt!==submittedAt||!Number.isFinite(Date.parse(submittedAt))||Date.parse(submittedAt)<Date.parse(upload.observedAt)||
  Date.parse(submittedAt)>Date.parse(scope.expiresAt)||Date.parse(p.observedAt)<Date.parse(submittedAt)||Date.parse(p.observedAt)>now.getTime())throw new DomainValidationError("作品证明未关联本次上传、账号、范围和单次提交");
 return {verified:true as const,videoId:p.awemeId,externalReference:"https://www.douyin.com/video/"+p.awemeId,proofHash:hashValue(p)};
}

/** No persistent publication claim can be made from a toast, HTTP 200, title or URL alone. */
export function unverifiedDouyinSubmission(){return {verified:false as const,status:"SUBMITTED_UNVERIFIED",message:"结果未知，保留原检查点；禁止重传、重提或切换引擎"};}
