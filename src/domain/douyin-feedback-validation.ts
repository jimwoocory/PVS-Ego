import type {ObservationEvidence} from "./douyin-feedback-evidence.js";
import {hashValue} from "./hashing.js";
import {DomainValidationError} from "./validation.js";

export function assertEvidenceScope(e:ObservationEvidence,scope:{projectId:string;bindingId:string;awemeId:string;productTruthHash:string;evidenceHash:string;metricSnapshotIds?:string[];commentIds?:string[]}){
 if(e.projectId!==scope.projectId||e.bindingId!==scope.bindingId||e.awemeId!==scope.awemeId||e.productTruthHash!==scope.productTruthHash||hashValue(e)!==scope.evidenceHash)throw new DomainValidationError("复盘观察证据范围或内容哈希校验失败");
 if(Date.parse(e.window.start)>Date.parse(e.window.end))throw new DomainValidationError("复盘观察时间窗无效");
 const items=[...e.metrics,...e.comments],refs=new Set(items.map(item=>item.evidenceRef));
 if(refs.size!==items.length||e.coverage.metrics.count!==e.metrics.length||e.coverage.comments.count!==e.comments.length||
    e.metrics.some(item=>!item.evidenceRef.startsWith("metric:"))||e.comments.some(item=>!item.evidenceRef.startsWith("comment:")))throw new DomainValidationError("复盘证据引用重复、类型或样本数量不一致");
 const start=Date.parse(e.window.start),end=Date.parse(e.window.end);
 const times=[...e.metrics.map(item=>item.capturedAt),...e.comments.map(item=>item.observation?.observedAt??item.syncedAt),...e.coverage.collectionScopes.flatMap(item=>item.observedAt?[item.observedAt]:[])];
 if(!Number.isFinite(start)||!Number.isFinite(end)||times.some(time=>!Number.isFinite(Date.parse(time))||Date.parse(time)<start||Date.parse(time)>end))throw new DomainValidationError("复盘证据超出冻结观察时间窗");
 for(const item of e.metrics)for(const [key,status] of Object.entries(item.availability??{})){
  if(status==="OBSERVED"?item.values[key]===undefined:item.values[key]!==undefined)throw new DomainValidationError("复盘指标可见性与冻结数值不一致");
 }
 for(const [ids,refs,prefix] of [[scope.metricSnapshotIds,e.metrics,"metric:"],[scope.commentIds,e.comments,"comment:"]] as const){
  if(ids&&(new Set(ids).size!==ids.length||ids.length!==refs.length||refs.some(item=>!ids.includes(item.evidenceRef.slice(prefix.length)))))throw new DomainValidationError("复盘冻结证据与原指标或评论 ID 清单不一致");
 }
 if(new Set(e.coverage.collectionScopes.map(item=>item.runId)).size!==e.coverage.collectionScopes.length)throw new DomainValidationError("复盘包含重复采集检查点");
}

/** A conservative guard for explicit unsupported claims, not a general natural-language proof system. */
export function assertNoUnsupportedEffect(text:string){
 for(const sentence of text.split(/[。！？!\n;，,]|但是|然而|but |however /i)){
  if(/不能|无法|未能|不代表|尚未|不应|并不|未观察/.test(sentence))continue;
  if(/(?:导致|因此|使得|证明|保证|带来).{0,35}(?:销量|转化|完播|销售|提升|提高|增长)|(?:销量|转化率|完播率|销售额).{0,15}(?:提升|提高|增长|达到|为\s*\d)|(?:caused?|guarantee[sd]?|proven).{0,40}(?:sales|conversion|completion)|(?:sales|conversion|completion).{0,20}(?:increas|improv|\d\s*%)/i.test(sentence))throw new DomainValidationError("复盘含未经证据支持的因果或商业效果结论");
 }
}
