import type {ResearchService} from "./research-service.js";
import type {ResearchMediaAnalyzer,WebResearchMedia} from "../ports/research-provider.js";
import type {ProductFlowService} from "./product-flow.js";
import {withSerialOperation} from "./serial-operation.js";
import {DomainValidationError} from "../../domain/validation.js";

/** Explicit user action to reuse already-discovered media. Never promotes research claims or bypasses site access. */
export async function collectResearchReferences(projectId:string,research:Pick<ResearchService,"pageData">,flow:ProductFlowService,analyzer:ResearchMediaAnalyzer){
 return withSerialOperation("collect-references:"+projectId,async()=>{
  const data=await research.pageData(projectId),w=await flow.getWorkspace(projectId);
  if(!w)throw new DomainValidationError("项目不存在");
  if(!data.latestRun)throw new DomainValidationError("请先运行深度研究，获取图片或视频媒体证据");
  const evidence=data.evidence.filter(e=>e.status==="ACTIVE"&&e.mediaContext&&e.mediaContext.type!=="AUDIO"),unique=[...new Map(evidence.map(e=>[e.mediaContext!.mediaUrl,e])).values()];
  if(!unique.length)throw new DomainValidationError("当前研究未发现可直接下载的图片或视频；请补充来源或重新进行深度研究");
  const failures:string[]=[];
  if(unique.length>8)failures.push("本次仅处理前8个媒体来源，其余保留在研究证据中");
  for(const e of unique.slice(0,8)){
   const context=e.mediaContext!,media:WebResearchMedia={type:context.type==="IMAGE"?"IMAGE":"VIDEO",url:context.mediaUrl};
   const result=await analyzer.analyze({projectId,runId:e.runId,parentSourceUrl:context.parentSourceUrl,pageTitle:e.title,sourceType:e.sourceType,
     productIdentity:w.productTruth?{productName:w.productTruth.productName,brand:w.productTruth.brand,category:w.productTruth.category}:undefined,media:[media]});
   failures.push(...result.failures);
  }
  return {mediaCount:Math.min(unique.length,8),failures};
 });
}
