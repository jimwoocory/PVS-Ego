import {hashValue,sha256Text} from "../../domain/hashing.js";
import {douyinMetricSnapshotSchema,type DouyinMetricSnapshot} from "../../domain/douyin-ops.js";
import {metricKeys} from "../../domain/douyin-observation.js";
import type {DouyinOpsCommentPage,DouyinOpsWork} from "../ports/douyin-ops-runtime.js";
import {commentObservationSchema,legacyCommentObservation,type CommentObservation} from "../../domain/douyin-comment-observation.js";
import {DomainValidationError} from "../../domain/validation.js";

/** Check saved normalized values against the original bytes before display or reuse. */
export function assertSavedMetricSnapshot(snapshot:DouyinMetricSnapshot,scope:{projectId:string;bindingId:string;awemeId:string;opsAccountUid?:string}){
 try{
  douyinMetricSnapshotSchema.parse(snapshot);
  const raw=JSON.parse(snapshot.rawJson);
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||snapshot.projectId!==scope.projectId||snapshot.bindingId!==scope.bindingId||snapshot.awemeId!==scope.awemeId||raw.awemeId!==scope.awemeId||sha256Text(snapshot.rawJson)!==snapshot.contentHash||raw.durationMs!==snapshot.durationMs||
   scope.opsAccountUid&&(raw.opsAccountUid!==scope.opsAccountUid||raw.authorUid!==scope.opsAccountUid))throw Error("SCOPE_CHANGED");
  for(const key of metricKeys){
   const value=raw.metrics?.[key],state=raw.metricAvailability?.[key]??(value===undefined?"NOT_PROVIDED":value===0?"LEGACY_UNVERIFIED":"OBSERVED");
   if(value!==snapshot[key]||snapshot.metricAvailability?.[key]!==state)throw Error("METRIC_CHANGED");
  }
 }catch{throw new DomainValidationError("保存的指标原文、数值、可见性或账号范围不一致，停止展示或复用，不重新采集");}
}

type Observation={value?:number;status:"OBSERVED"|"UNKNOWN"};
const counter=(v:unknown):Observation=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?{value:v,status:"OBSERVED"}:{status:"UNKNOWN"};
const obj=(v:unknown):Record<string,any>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown)=>typeof v==="string"&&/^\d{1,40}$/.test(v)?v:undefined;
const cursor=(v:unknown)=>typeof v==="string"&&/^\d{1,40}$/.test(v)?v:typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?String(v):undefined;
export type DouyinReadPageInput={kind:"COMMENTS"|"REPLIES";awemeId:string;parentCid?:string|null;requestCursor:string;count:number;observedAt:string;raw:unknown;normalized:DouyinOpsCommentPage};

/** Offline raw/normalized comparison. A successful comparison does not establish platform visibility or exhaustive coverage. */
export function auditDouyinReadPage(input:DouyinReadPageInput){
 const raw=obj(input.raw),issues:string[]=[];
 if(!id(input.awemeId)||!cursor(input.requestCursor)||!Number.isInteger(input.count)||input.count<1||input.count>20||!Number.isFinite(Date.parse(input.observedAt))||input.kind==="REPLIES"&&!id(input.parentCid)||input.kind==="COMMENTS"&&Boolean(input.parentCid))throw Error("INVALID_READ_AUDIT_SCOPE");
 const list=Array.isArray(raw.comments)?raw.comments:undefined;
 const returnedCount=list?.length,nextCursor=cursor(raw.cursor),hasMore=raw.has_more===true||raw.has_more===1?true:raw.has_more===false||raw.has_more===0?false:undefined;
 if(raw.status_code!==0)issues.push("SOURCE_STATUS_UNKNOWN_OR_FAILED");
 if(!list)issues.push("COMMENT_LIST_NOT_OBSERVED");
 if(list&&list.length>input.count)issues.push("SOURCE_PAGE_EXCEEDS_BOUND");
 if(nextCursor===undefined||hasMore===undefined)issues.push("PAGINATION_NOT_OBSERVED");
 if(hasMore&&nextCursor===input.requestCursor)issues.push("CURSOR_STALLED");
 if(nextCursor!==input.normalized.cursor||hasMore!==input.normalized.hasMore)issues.push("PAGINATION_NORMALIZATION_MISMATCH");
 if(returnedCount!==input.normalized.comments.length)issues.push("NORMALIZED_COMMENT_COUNT_MISMATCH");
 const known=new Set<string>();
 const comments=(list??[]).map((value,index)=>{
  const c=obj(value),cid=id(c.cid),workId=id(c.aweme_id),rootParent=id(c.reply_id),normalized=input.normalized.comments[index];
  if(!cid||known.has(cid))issues.push("COMMENT_ID_MISSING_UNSAFE_OR_DUPLICATE");else known.add(cid);
  if(workId!==input.awemeId)issues.push("RAW_COMMENT_WORK_NOT_PROVEN");
  const relationExpected=input.kind==="COMMENTS"?"0":input.parentCid!;
  const rawRelationMatches=rootParent===relationExpected;
  if(rootParent!==undefined&&!rawRelationMatches)issues.push("RAW_REPLY_PARENT_CONFLICT");
  // parent_cid is distinct from root_comment_id, which can identify a child reply thread.
  const explicitParent=id(c.parent_cid);
  if(explicitParent!==undefined&&explicitParent!==relationExpected)issues.push("EXPLICIT_PARENT_CONFLICT");
  if(!normalized||normalized.cid!==cid||normalized.awemeId!==input.awemeId||normalized.parentCid!==(input.kind==="COMMENTS"?"":input.parentCid))issues.push("NORMALIZED_COMMENT_RELATION_MISMATCH");
  if(typeof c.text!=="string"||c.text!==normalized?.text)issues.push("COMMENT_TEXT_NOT_PROVEN_OR_MISMATCH");
  const diggCount=counter(c.digg_count),replyCount=counter(c.reply_comment_total);
  if(diggCount.status==="OBSERVED"&&diggCount.value!==normalized?.diggCount||replyCount.status==="OBSERVED"&&replyCount.value!==normalized?.replyCount)issues.push("COMMENT_COUNTER_NORMALIZATION_MISMATCH");
  return {cid,awemeId:workId,rootParent:input.kind==="REPLIES"?input.parentCid:undefined,relationEvidence:rawRelationMatches?"RAW_REPLY_ID_MATCH":"REQUEST_SCOPE_ONLY_UNKNOWN",rawReplyId:rootParent,replyToReplyId:id(c.reply_to_reply_id),rawThreadRootId:id(c.root_comment_id),diggCount,replyCount};
 });
 const replyIds=new Set(comments.map(c=>c.cid));
 const unresolvedReplyTargets=comments.filter(c=>c.replyToReplyId&&c.replyToReplyId!=="0"&&!replyIds.has(c.replyToReplyId)).map(c=>({cid:c.cid,replyToReplyId:c.replyToReplyId}));
 return {kind:input.kind,awemeId:input.awemeId,parentCid:input.parentCid??null,requestCursor:input.requestCursor,observedAt:input.observedAt,rawHash:hashValue(input.raw),normalizedHash:hashValue(input.normalized),accepted:issues.length===0,issues:[...new Set(issues)],returnedCount,nextCursor,hasMore,reportedTotal:counter(raw.total),comments,unresolvedReplyTargets,coverage:{status:"UNKNOWN" as const,truncated:false,reason:"原始响应未证明隐藏/删除/排序遗漏或全平台覆盖；终页不等于全部可见"},completePlatformCoverage:false as const};
}

export function compareDouyinPageReadings(first:ReturnType<typeof auditDouyinReadPage>,second:ReturnType<typeof auditDouyinReadPage>){
 if(first.kind!==second.kind||first.awemeId!==second.awemeId||first.parentCid!==second.parentCid||first.requestCursor!==second.requestCursor)throw Error("READING_SCOPES_DIFFER");
 const a=new Set(first.comments.map(c=>c.cid)),b=new Set(second.comments.map(c=>c.cid));
 return {sameCommentIds:a.size===b.size&&[...a].every(c=>b.has(c)),addedIds:[...b].filter(c=>!a.has(c)),removedIds:[...a].filter(c=>!b.has(c)),sameRawHash:first.rawHash===second.rawHash,stableSnapshotProven:false as const,missingCommentDeletionInferred:false as const};
}

export function auditDouyinReadMetrics(rawInput:unknown,work:DouyinOpsWork){
 const raw=obj(rawInput),detail=obj(raw.aweme_detail),statistics=obj(detail.statistics),mapping={plays:"play_count",likes:"digg_count",comments:"comment_count",shares:"share_count",collects:"collect_count"} as const;
 const metrics=Object.fromEntries(Object.entries(mapping).map(([key,field])=>[key,counter(statistics[field])]));
 const issues:string[]=[];
 if(raw.status_code!==0||id(detail.aweme_id)!==work.awemeId||id(obj(detail.author).uid)!==work.author.uid)issues.push("RAW_WORK_ACCOUNT_OR_STATUS_MISMATCH");
 for(const key of Object.keys(mapping) as Array<keyof typeof mapping>){const m=metrics[key]!;if(m.status==="OBSERVED"&&m.value!==work.metrics[key])issues.push("METRIC_NORMALIZATION_MISMATCH:"+key);}
 return {accepted:issues.length===0,issues,metrics,rawHash:hashValue(rawInput),missingIsZero:false as const};
}

/** Business ingress: derive per-comment facts from the same page, never from a caller's source label. */
export function observationsForDouyinPage(page:DouyinOpsCommentPage,scope:{awemeId:string;parentCid?:string;requestCursor:string;count:number}){
 const e=page.readEvidence,observations=new Map<string,CommentObservation>();
 if(!e){for(const c of page.comments)observations.set(c.cid,legacyCommentObservation({awemeId:scope.awemeId,cid:c.cid,...(scope.parentCid?{parentCid:scope.parentCid}:{})}));return {observations,coverage:page.coverage??{status:"UNKNOWN" as const,truncated:false,reason:"未取得归一化前响应，计数及关系来源未知"}};}
 if(e.version!=="douyin-read-page-v1"||e.kind!==(scope.parentCid?"REPLIES":"COMMENTS")||e.awemeId!==scope.awemeId||e.parentCid!==(scope.parentCid??null)||e.requestCursor!==scope.requestCursor||e.count!==scope.count)throw new DomainValidationError("原始评论页证据与本次作品、父评论或游标范围不一致");
 const {readEvidence:_,...normalized}=page;
 const audit=auditDouyinReadPage({...e,normalized});
 if(!audit.accepted)throw new DomainValidationError("原始评论页对照失败："+audit.issues.join(","));
 for(const c of audit.comments){
  const unavailable=page.coverage?.status==="NOT_VISIBLE";
  const target=c.replyToReplyId;
  observations.set(c.cid!,commentObservationSchema.parse({version:"douyin-comment-observation-v1",source:"RAW_PAGE_COMPARISON",awemeId:scope.awemeId,cid:c.cid,...(scope.parentCid?{parentCid:scope.parentCid}:{}),relationEvidence:c.relationEvidence,rawReplyId:c.rawReplyId,replyToReplyId:target,rawThreadRootId:c.rawThreadRootId,replyTargetResolution:target===undefined?"UNKNOWN":target==="0"?"NONE_REPORTED":audit.comments.some(x=>x.cid===target)?"IN_CAPTURED_PAGE":"NOT_IN_CAPTURED_PAGE_UNKNOWN",counts:unavailable?{diggCount:{status:"NOT_VISIBLE"},replyCount:{status:"NOT_VISIBLE"}}:{diggCount:c.diggCount,replyCount:c.replyCount},pageHash:audit.rawHash,normalizedPageHash:audit.normalizedHash,requestCursor:scope.requestCursor,responseCursor:audit.nextCursor,observedAt:e.observedAt}));
 }
 return {observations,coverage:page.coverage&&["PARTIAL","NOT_VISIBLE"].includes(page.coverage.status)?page.coverage:{...audit.coverage,truncated:page.coverage?.truncated??false}};
}
