import {randomUUID} from "node:crypto";
import {hashValue} from "../../domain/hashing.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import {realisticShortExecutionSchema,type CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import {scriptDraftSchema,productionPlanSchema} from "../../domain/schemas.js";
import {productionAssetSetSchema} from "../../domain/production-strategy.js";
import {canvasProductionBindingSchema} from "../../domain/canvas-production.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {buildProductionQuoteRequest} from "./production-quote-service.js";
import {inspectShortBoundReferences} from "./canvas-short-bound-video-quote.js";
import type {CanvasProductionService} from "./canvas-production-service.js";

const seal=(v:any)=>{const {contentHash:_,...body}=v;return {...body,contentHash:hashValue(body)};};
const ref=(entityType:string,v:{id:string;version:number;contentHash:string})=>({entityType,entityId:v.id,version:v.version,hash:v.contentHash});
export type RealisticBoundContext=Awaited<ReturnType<typeof inspectShortBoundReferences>>;
/** Fixed metadata/reference compilation of the exact approved visual revision. No new creative text. */
export function buildRealisticExecution(parent:SmartGenerationRun,p:CanvasShortPlan,c:RealisticBoundContext){
  const image=c.image,review=image.review,head=c.head;
  if(image.state!=="ADOPTED"||!review||review.sha256!==image.artifact?.sha256||review.revisionHash!==head.contentHash)
    throw new CanvasRuntimeError("SHORT_REALISTIC_REFERENCE_BINDING_REQUIRED");
  const product=parent.productionAssetSet?.entries.find(e=>e.key==="PRODUCT"),original=parent.canvasBinding?.nodes.find(n=>n.key==="PRODUCT");
  const clip=head.payload.productionPlan.scenes[0]?.clips[0],settingRef="realistic-setting:"+head.id;
  if(!product||!original||!parent.productionAssetSet||!clip||head.payload.productionPlan.scenes.length!==1||head.payload.productionPlan.scenes[0]!.clips.length!==1||
    clip.referenceAssets.length!==1||clip.referenceAssets[0]?.assetId!==product.referenceAssetId||clip.referenceAssets[0].role!=="PRIMARY_PRODUCT"||clip.durationMs!==12000)
    throw new CanvasRuntimeError("SHORT_REALISTIC_SOURCE_ASSETS_CHANGED");
  const assets=productionAssetSetSchema.parse(seal({...parent.productionAssetSet,id:"short-realistic-assets:"+head.id,projectId:parent.projectId,version:1,status:"READY",createdAt:review.reviewedAt,updatedAt:review.reviewedAt,
    entries:[{...product,label:product.label??"真实产品主图",description:product.description??"原产品图",purpose:product.purpose??"产品身份基准",reuseScope:product.reuseScope??"RUN",required:true,
      artifactIds:[head.payload.productReference.artifactId],status:"READY"},
      {key:"REALISTIC_SETTING",referenceAssetId:settingRef,kind:"CHARACTER",label:"已采用人物与书房同框参考",description:head.payload.designs.map(d=>d.description).join("；"),
        purpose:"锁定已审核的同一人物、袖口、座位、书房和光线",required:true,reuseScope:"RUN",source:"DREAMINA_GENERATED",status:"READY",artifactIds:[image.artifact!.id],sourceReferenceAssetIds:[],dependsOnAssetKeys:[],
        identityLock:head.payload.designs.flatMap(d=>d.consistency).slice(0,20),generationPrompt:c.q.imagePrompt,generationRequestHash:image.generationHash,submitId:image.submitId,
        humanConfirmedAt:review.reviewedAt,reviewSummary:"用户明确采用精确图片SHA256 "+image.artifact!.sha256}]}));
  const script=scriptDraftSchema.parse(seal({...head.payload.script,status:"CONFIRMED",confirmedAt:head.designReview!.confirmedAt,productionAssetSetRef:ref("ProductionAssetSet",assets)}));
  const preparedClip=seal({...clip,referenceAssets:[...clip.referenceAssets,{assetId:settingRef,role:"CHARACTER",priority:1,required:true}]});
  const plan=productionPlanSchema.parse(seal({...head.payload.productionPlan,status:"CONFIRMED",confirmedAt:head.designReview!.confirmedAt,scriptRef:ref("ScriptDraft",script),productionAssetSetRef:ref("ProductionAssetSet",assets),
    scenes:[{...head.payload.productionPlan.scenes[0]!,clips:[preparedClip]}]}));
  const payload={...p.payload,title:head.payload.title,nodeId:c.video.nodeId,submitId:p.realisticExecution?.payload.submitId??randomUUID(),generationHash:c.video.generationHash,
    prompt:head.payload.draftVideoPrompt,script,productionPlan:plan,tailCardText:head.payload.tailCardText,
    references:c.references.map(r=>({key:r.role==="PRODUCT"?"PRODUCT":"REALISTIC_SETTING",artifactId:r.artifactId,sha256:r.sha256}))};
  const shadow={...parent,id:p.id,script,productionPlan:plan,productionAssetSet:assets,targetDurationMs:15000,paidScope:undefined,canvasBinding:undefined,feeQuote:undefined,
    consent:undefined,attemptIds:[],assetConsent:undefined,assetPaidScope:undefined,canvasShortPlans:undefined,status:"READY_FOR_PAID_CONFIRM"} as SmartGenerationRun;
  const request=buildProductionQuoteRequest(shadow),item=request.items[0]!;
  if(request.items.length!==1||item.kind!=="VIDEO"||item.count!==1||item.durationMs!==12000||item.references.images!==2)throw new CanvasRuntimeError("SHORT_REALISTIC_REQUEST_SCOPE_CHANGED");
  const binding=canvasProductionBindingSchema.parse({runtime:"DREAMINA_CANVAS",projectId:c.q.projectId,runId:p.id,scopeHash:request.scopeHash,profile:c.q.profile,
    accountFingerprint:c.account.accountFingerprint,modelApprovalSource:"USER_CONFIRMED_5_0_LITE",executableSha256:c.q.executableSha256,created:true,
    sourceScriptHash:script.contentHash,sourcePlanHash:plan.contentHash,originalQuoteRequest:request,checkedAt:review.reviewedAt,
    nodes:[structuredClone(original),{key:"REALISTIC_SETTING",kind:"IMAGE",nodeId:c.setting.nodeId,updateId:c.setting.updateId,submitId:image.submitId,saved:true,
      sourceRequestHash:image.artifact!.sha256,canonicalModel:"seedream_5.0_lite",generationHash:image.generationHash},
      {key:preparedClip.id,kind:"VIDEO",nodeId:c.video.nodeId,updateId:c.video.updateId,submitId:payload.submitId,saved:true,sourceRequestHash:item.sourceRequestHash,
        canonicalModel:"seedance_2.0_fast_vip",generationHash:c.video.generationHash}]});
  // The original payload/binding/feeQuote remain historical, unchanged.
  return realisticShortExecutionSchema.parse({sourceRevisionId:head.id,sourceRevisionHash:head.contentHash,sourcePlanHash:p.contentHash,contentHash:hashValue(payload),payload,assets,binding});
}
export async function realisticExecutionContext(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan){
  const execution=p.realisticExecution;if(!execution)throw new CanvasRuntimeError("SHORT_REALISTIC_REFERENCE_BINDING_REQUIRED");
  const c=await inspectShortBoundReferences(canvas,parent,p,true),expected=buildRealisticExecution(parent,p,c);
  if(execution.sourceRevisionId!==expected.sourceRevisionId||execution.sourceRevisionHash!==expected.sourceRevisionHash||execution.sourcePlanHash!==p.contentHash||
    execution.contentHash!==hashValue(execution.payload)||hashValue(execution.payload)!==hashValue(expected.payload)||hashValue(execution.assets)!==hashValue(expected.assets)||
    execution.binding.runId!==expected.binding.runId||execution.binding.projectId!==expected.binding.projectId||execution.binding.scopeHash!==expected.binding.scopeHash||
    hashValue(execution.binding.originalQuoteRequest)!==hashValue(expected.binding.originalQuoteRequest)||execution.binding.nodes.length!==3||
    execution.binding.nodes.some((n,i)=>{const {execution:_,delivery:__,...staticNode}=n;return hashValue(staticNode)!==hashValue(expected.binding.nodes[i]);}))
    throw new CanvasRuntimeError("SHORT_REALISTIC_EXECUTION_SNAPSHOT_CHANGED");
  return {...parent,id:p.id,script:execution.payload.script,productionPlan:execution.payload.productionPlan,productionAssetSet:execution.assets,targetDurationMs:15000,
    canvasBinding:execution.binding,feeQuote:execution.feeQuote,paidScope:execution.paidScope,consent:p.consent,attemptIds:p.attemptIds,
    assetConsent:undefined,assetPaidScope:undefined,canvasShortPlans:undefined,status:p.consent?"GENERATING":"READY_FOR_PAID_CONFIRM"} as SmartGenerationRun;
}
