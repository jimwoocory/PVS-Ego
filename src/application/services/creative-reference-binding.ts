import {creativeReferenceSetSchema,type CreativeReferenceSet} from "../../domain/creative-reference.js";
import type {ProductTruth} from "../../domain/schemas.js";
type VersionRef=ProductTruth["inputRefs"][number];
import {hashValue} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
export interface CreativeReferenceGuard {
 current(projectId:string):Promise<CreativeReferenceSet|null>;
 assertExpected(projectId:string,expected?:VersionRef):Promise<CreativeReferenceSet|null>;
}
export function referenceSetRef(set?:CreativeReferenceSet|null):VersionRef|undefined {
 return set?.entries.length?{entityType:"CreativeReferenceSet",entityId:set.id,version:set.version,hash:set.contentHash}:undefined;
}
export function assertReferenceBinding(expected:VersionRef|undefined,set?:CreativeReferenceSet|null,truth?:ProductTruth):void{
 if(set){
  const parsed=creativeReferenceSetSchema.parse(set),{contentHash,...body}=parsed;
  if(hashValue(body)!==contentHash)throw new DomainValidationError("创作参考集合内容哈希不匹配");
  if(truth&&(set.projectId!==truth.projectId||set.truthRef.entityId!==truth.id||set.truthRef.version!==truth.version||set.truthRef.hash!==truth.contentHash))throw new DomainValidationError("创作参考集合不属于当前已确认产品事实");
 }
 if(hashValue(expected??null)!==hashValue(referenceSetRef(set)??null))throw new DomainValidationError("创作参考集合绑定缺失或不一致，不能沿用旧版本");
}
