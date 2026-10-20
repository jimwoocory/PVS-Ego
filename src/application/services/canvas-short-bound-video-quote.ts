import {hashValue} from "../../domain/hashing.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import {shortBoundVideoQuoteSchema} from "../../domain/canvas-short-bound-video-quote.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {CanvasProductionService,canvasGenerationHash,validateCanvasQuote} from "./canvas-production-service.js";
type Save=(p:CanvasShortPlan)=>Promise<void>;

/** Reuse the saved video node, verifying the exact current two image resources. No edit, confirm or run. */
export async function inspectShortBoundReferences(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,allowAuthorizedExecution=false){
  const authorized=allowAuthorizedExecution&&p.realisticExecution?.paidScope?.hash===p.consent?.scopeHash&&Boolean(p.consent)&&
    p.consent?.source==="EXPLICIT_SMART_RUN_PAID_CONFIRMATION"&&!p.consent.acceptedUnknownCostRisk;
  const head=p.visualRevisions?.at(-1),q=p.referenceQuote,image=p.referenceImage,product=parent.canvasBinding?.nodes.find(n=>n.kind==="PRODUCT"),
    setting=q?.nodes.find(n=>n.key==="SETTING"),video=q?.nodes.find(n=>n.key==="VIDEO");
  if(!head||head.contentHash!==hashValue(head.payload)||head.designReview?.contentHash!==head.contentHash||head.payload.sourcePlanHash!==p.contentHash||p.contentHash!==hashValue(p.payload)||
    p.projectId!==parent.projectId||p.parentRunId!==parent.id||p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash||
    !q||q.revisionHash!==head.contentHash||!image?.artifact||image.revisionHash!==head.contentHash||image.quoteRequestHash!==q.requestHash||image.creditCeiling!==0||image.liveQuote.credits!==0||
    image.resources.length!==1||!setting?.saved||!video?.saved||!product?.saved||!product.resourceId||q.productNodeId!==product.nodeId||
    q.productSha256!==head.payload.productReference.sha256||product.sourceRequestHash!==q.productSha256||image.nodeId!==setting.nodeId||image.generationHash!==setting.generationHash||
    parent.consent||parent.attemptIds.length||(!authorized&&(p.consent||p.attemptIds.length))||p.paidScope)
    throw new CanvasRuntimeError("SHORT_BOUND_REFERENCE_SOURCE_CHANGED");
  const account=await canvas.runtime.assertAccount(),binding=parent.canvasBinding!;
  if(account.accountFingerprint!==q.accountFingerprint||account.accountFingerprint!==image.accountFingerprint||account.accountFingerprint!==binding.accountFingerprint||
    q.projectId!==binding.projectId||q.profile!==canvas.runtime.config.profile||q.profile!==binding.profile||q.executableSha256!==canvas.runtime.config.executableSha256||q.executableSha256!==binding.executableSha256)
    throw new CanvasRuntimeError("SHORT_BOUND_REFERENCE_ACCOUNT_CHANGED");
  const response=await canvas.runtime.call(["node","show","--project-id",q.projectId,...[product.nodeId,setting.nodeId,video.nodeId].flatMap(id=>["--node-id",id])]),data=response.data;
  const node=(id:string)=>data?.nodes?.find((n:any)=>n.result==="FOUND"&&n.node?.nodeId===id)?.node;
  const productNode=node(product.nodeId),settingNode=node(setting.nodeId),videoNode=node(video.nodeId),g=videoNode?.generation;
  if(!Number.isSafeInteger(data?.draftVersion)||productNode?.resources?.length!==1||productNode.resources[0].resourceId!==product.resourceId||
    productNode.resources[0].type!=="image"||productNode.resources[0].status!=="success"||productNode.resources[0].source!=="uploaded"||
    !settingNode?.generation||canvasGenerationHash(settingNode.generation)!==setting.generationHash||settingNode.resources?.length!==1||
    settingNode.resources[0].resourceId!==image.resources[0]||settingNode.resources[0].submitId!==image.submitId||settingNode.resources[0].type!=="image"||settingNode.resources[0].status!=="success"||
    settingNode.resources[0].creditsAmount!==0||!g||canvasGenerationHash(g)!==video.generationHash||g.model!=="seedance_2.0_fast_vip"||g.mode!=="m2v"||g.prompt!==head.payload.draftVideoPrompt||
    g.ratio!=="9:16"||g.resolution!=="720p"||g.durationSeconds!==12||g.outputCount!==1||g.references?.length!==2||
    !g.references.every((r:any,i:number)=>r.kind==="node"&&r.type==="image"&&r.id===[product.nodeId,setting.nodeId][i])||
    videoNode.upstreamNodeIds?.length!==2||![product.nodeId,setting.nodeId].every(id=>videoNode.upstreamNodeIds.includes(id))||(!authorized&&videoNode.resources?.length!==0))
    throw new CanvasRuntimeError("SHORT_BOUND_REFERENCE_REMOTE_CHANGED");
  return {head,q,image,setting,video,account,draftVersion:data.draftVersion as number,references:[
    {role:"PRODUCT" as const,nodeId:product.nodeId,resourceId:product.resourceId,artifactId:head.payload.productReference.artifactId,sha256:head.payload.productReference.sha256},
    {role:"SETTING" as const,nodeId:setting.nodeId,resourceId:image.resources[0]!,artifactId:image.artifact.id,sha256:image.artifact.sha256}]};
}
export async function adoptShortReference(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,revisionHash:string,artifactId:string,sha256:string,confirmed:boolean,save:Save){
  if(!confirmed)throw new CanvasRuntimeError("SHORT_REFERENCE_EXPLICIT_ADOPTION_REQUIRED");
  const c=await inspectShortBoundReferences(canvas,parent,p);
  if(revisionHash!==c.head.contentHash||artifactId!==c.image.artifact!.id||sha256!==c.image.artifact!.sha256||!["NEEDS_REVIEW","ADOPTED"].includes(c.image.state))
    throw new CanvasRuntimeError("SHORT_REFERENCE_ADOPTION_CHANGED");
  if(c.image.review){if(c.image.review.artifactId!==artifactId||c.image.review.sha256!==sha256||c.image.review.resourceId!==c.image.resources[0]||c.image.review.revisionHash!==revisionHash)
    throw new CanvasRuntimeError("SHORT_REFERENCE_ADOPTION_CHANGED");return c.image;}
  c.image.review={source:"EXPLICIT_USER_ADOPT_REFERENCE",revisionHash,artifactId,sha256,resourceId:c.image.resources[0]!,reviewedAt:new Date().toISOString()};
  c.image.state="ADOPTED";c.image.updatedAt=c.image.review.reviewedAt;p.blocker="同框参考图已由用户采用；与真实产品图绑定待实时视频报价，视频仍未授权";
  await save(p);return c.image;
}
export async function quoteShortBoundVideo(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
  const c=await inspectShortBoundReferences(canvas,parent,p),review=c.image.review;
  if(c.image.state!=="ADOPTED"||!review||review.source!=="EXPLICIT_USER_ADOPT_REFERENCE"||review.revisionHash!==c.head.contentHash||review.artifactId!==c.image.artifact!.id||review.sha256!==c.image.artifact!.sha256||review.resourceId!==c.image.resources[0])
    throw new CanvasRuntimeError("SHORT_REFERENCE_USER_ADOPTION_REQUIRED");
  if((p.boundVideoQuotes?.length??0)>=20)throw new CanvasRuntimeError("SHORT_BOUND_VIDEO_QUOTE_HISTORY_LIMIT");
  const model=await canvas.runtime.findModel("seedance_2.0_fast_vip","video"),mode=model.modes?.find((m:any)=>m.name==="m2v"),duration=mode?.flags?.find((f:any)=>f.flag==="--duration");
  if(model.model!=="seedance_2.0_fast_vip"||!mode?.flags?.find((f:any)=>f.flag==="--ratio")?.values?.includes("9:16")||!mode.flags?.find((f:any)=>f.flag==="--resolution")?.values?.includes("720p")||
    !Number.isFinite(duration?.min)||!Number.isFinite(duration?.max)||duration.min>12||duration.max<12||!mode.references?.types?.some((r:any)=>r.mediaType==="image"&&r.max>=2))
    throw new CanvasRuntimeError("SHORT_BOUND_VIDEO_MODEL_CHANGED");
  const source={revisionHash:c.head.contentHash,canvasProjectId:c.q.projectId,accountFingerprint:c.account.accountFingerprint,profile:c.q.profile,executableSha256:c.q.executableSha256,
    videoNodeId:c.video.nodeId,generationHash:c.video.generationHash,model:"seedance_2.0_fast_vip" as const,resolution:"720p" as const,ratio:"9:16" as const,durationMs:12000 as const,count:1 as const,references:c.references};
  const receipt=shortBoundVideoQuoteSchema.parse({...source,scopeHash:hashValue(source),draftVersion:c.draftVersion,checkedAt:new Date().toISOString(),imageCredits:0,videoCredits:null,totalCredits:null,creditCeiling:72,
    status:"INCOMPLETE",validity:"REVALIDATE_DRAFT_AND_REFERENCES",videoGenerationAuthorized:false,noVideoGenerationSubmitted:true,publishAuthorized:false});
  try{
    const response=await canvas.runtime.call(["node","quote","--project-id",c.q.projectId,"--node-id",c.video.nodeId]),checked=validateCanvasQuote(response.data,[c.video.nodeId],c.draftVersion),item=checked.items[0]!;
    if(!response.meta?.requestId)throw new CanvasRuntimeError("QUOTE_REQUEST_ID_MISSING");
    receipt.sourceRequestId=response.meta.requestId;receipt.checkedAt=new Date().toISOString();
    if(item.error)receipt.error=item.error.validation.reasonCode;
    else{receipt.videoCredits=item.maxCredits!;receipt.totalCredits=item.maxCredits!;receipt.status=item.maxCredits!>72?"OVER_BUDGET":"QUOTED";}
  }catch(error){receipt.error=error instanceof CanvasRuntimeError?error.code:"SHORT_BOUND_VIDEO_QUOTE_FAILED";}
  p.boundVideoQuotes=[...(p.boundVideoQuotes??[]),receipt];
  p.blocker=receipt.status==="QUOTED"?"已核实真实产品图＋已采用同框图的视频报价；视频未授权，须完成执行预检并由用户另行确认":receipt.status==="OVER_BUDGET"?"本版实际总价超过72积分上限，停止":"本版视频报价仍有缺项，不计0，不生成";
  await save(p);return receipt;
}
