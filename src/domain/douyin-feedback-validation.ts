import type {ObservationEvidence} from "./douyin-feedback-evidence.js";
import {hashValue} from "./hashing.js";
import {DomainValidationError} from "./validation.js";

export function assertEvidenceScope(e:ObservationEvidence,scope:{projectId:string;bindingId:string;awemeId:string;productTruthHash:string;evidenceHash:string}){
 if(e.projectId!==scope.projectId||e.bindingId!==scope.bindingId||e.awemeId!==scope.awemeId||e.productTruthHash!==scope.productTruthHash||hashValue(e)!==scope.evidenceHash)throw new DomainValidationError("复盘观察证据范围或内容哈希校验失败");
 if(Date.parse(e.window.start)>Date.parse(e.window.end))throw new DomainValidationError("复盘观察时间窗无效");
}

/** A conservative guard for explicit unsupported claims, not a general natural-language proof system. */
export function assertNoUnsupportedEffect(text:string){
 for(const sentence of text.split(/[。！？!\n;，,]|但是|然而|but |however /i)){
  if(/不能|无法|未能|不代表|尚未|不应|并不|未观察/.test(sentence))continue;
  if(/(?:导致|因此|使得|证明|保证|带来).{0,35}(?:销量|转化|完播|销售|提升|提高|增长)|(?:销量|转化率|完播率|销售额).{0,15}(?:提升|提高|增长|达到|为\s*\d)|(?:caused?|guarantee[sd]?|proven).{0,40}(?:sales|conversion|completion)|(?:sales|conversion|completion).{0,20}(?:increas|improv|\d\s*%)/i.test(sentence))throw new DomainValidationError("复盘含未经证据支持的因果或商业效果结论");
 }
}
