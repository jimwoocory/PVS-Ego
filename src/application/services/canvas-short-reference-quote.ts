import {randomUUID} from "node:crypto";
import {hashValue} from "../../domain/hashing.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {CanvasProductionService,canvasGenerationHash,newCanvasNodeId,validateCanvasQuote} from "./canvas-production-service.js";

/** Separate non-executable quotation receipt. Never enters feeQuote, paidScope, or native requests. */
export async function quoteShortReferences(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,
  revisionHash:string,imagePrompt:string,save:(p:CanvasShortPlan)=>Promise<void>){
  const head=p.visualRevisions?.at(-1),binding=parent.canvasBinding,product=binding?.nodes.find(n=>n.kind==="PRODUCT");
  if(!head||head.contentHash!==revisionHash||head.contentHash!==hashValue(head.payload)||head.designReview?.contentHash!==revisionHash||
    head.payload.sourcePlanHash!==p.contentHash||p.contentHash!==hashValue(p.payload)||p.parentRunId!==parent.id||p.projectId!==parent.projectId||
    p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash||
    parent.consent||p.consent||parent.attemptIds.length||p.attemptIds.length||!binding||!product?.saved||
    product.sourceRequestHash!==head.payload.productReference.sha256||!imagePrompt.trim()||imagePrompt.length>2000)
    throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_REVIEW_OR_SOURCE_REQUIRED");
  const account=await canvas.runtime.assertAccount();
  if(account.accountFingerprint!==binding.accountFingerprint||binding.profile!==canvas.runtime.config.profile||binding.executableSha256!==canvas.runtime.config.executableSha256)
    throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_ACCOUNT_CHANGED");
  const image=await canvas.runtime.findModel("seedream_5.0_lite","image"),video=await canvas.runtime.findModel("seedance_2.0_fast_vip","video");
  for(const [model,mode,resolution] of [[image,"t2i","2K"],[video,"m2v","720p"]] as const){
    const modes=model.modes?.filter((m:any)=>m.name===mode),m=modes?.[0];
    if(model.model!==(mode==="t2i"?"seedream_5.0_lite":"seedance_2.0_fast_vip")||modes?.length!==1||
      !m.flags?.find((f:any)=>f.flag==="--ratio")?.values?.includes("9:16")||!m.flags?.find((f:any)=>f.flag==="--resolution")?.values?.includes(resolution)||
      mode==="m2v"&&(!m.references?.types?.some((t:any)=>t.mediaType==="image"&&t.max>=2)||
        !Number.isFinite(m.flags?.find((f:any)=>f.flag==="--duration")?.min)||!Number.isFinite(m.flags?.find((f:any)=>f.flag==="--duration")?.max)||
        m.flags?.find((f:any)=>f.flag==="--duration")?.min>12||m.flags?.find((f:any)=>f.flag==="--duration")?.max<12))
      throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_MODEL_CHANGED");
  }
  // Verify the original remote product import as well as all historical bindings; never rewrite them.
  await canvas.inspectBoundNodes(binding);
  const requestHash=hashValue({revisionHash,imagePrompt,product:head.payload.productReference,imageModel:image.model,videoModel:video.model,ratio:"9:16",resolution:"720p",duration:12});
  if(p.referenceQuote&&p.referenceQuote.requestHash!==requestHash)throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_DRAFT_CHANGED");
  const ids=p.referenceQuote?.nodes??(["SETTING","VIDEO","PRODUCT_ONLY_COMPARISON"] as const).map(key=>({key,nodeId:newCanvasNodeId(),updateId:randomUUID(),generationHash:"",saved:false}));
  const generations=ids.map(n=>n.key==="SETTING"?{mode:"t2i",prompt:imagePrompt,model:image.model,ratio:"9:16",resolution:"2K",outputCount:1}:
    {mode:"m2v",prompt:head.payload.draftVideoPrompt,model:video.model,ratio:"9:16",resolution:"720p",outputCount:1,durationSeconds:12,
      references:[{id:product.nodeId},...(n.key==="VIDEO"?[{id:ids.find(n=>n.key==="SETTING")!.nodeId}]:[])]});
  p.referenceQuote??={revisionId:head.id,revisionHash,requestHash,projectId:binding.projectId,accountFingerprint:account.accountFingerprint,
    profile:binding.profile,executableSha256:binding.executableSha256,productNodeId:product.nodeId,productSha256:head.payload.productReference.sha256,imagePrompt,
    nodes:ids.map((n,i)=>({...n,generationHash:canvasGenerationHash(generations[i]!)})),checkedAt:new Date().toISOString(),totalCredits:null,status:"PREPARING",
    validity:"REVALIDATE_DRAFT_AND_REFERENCES",generationAuthorized:false,publishAuthorized:false};
  const receipt=p.referenceQuote;
  if(receipt.revisionHash!==head.contentHash||receipt.projectId!==binding.projectId||receipt.accountFingerprint!==account.accountFingerprint||
    receipt.profile!==binding.profile||receipt.executableSha256!==binding.executableSha256||receipt.productNodeId!==product.nodeId||
    receipt.nodes.some((n,i)=>n.generationHash!==canvasGenerationHash(generations[i]!)))throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_BINDING_CHANGED");
  receipt.totalCredits=null;receipt.items=undefined;receipt.status="PREPARING";receipt.error=undefined;await save(p); // identities before effects
  try{
    for(const [i,node] of receipt.nodes.entries()){
      if(node.saved)continue;const g=generations[i]!;
      // Reconcile a previous uncertain create before retrying the same durable node/update IDs.
      const shown=(await canvas.runtime.call(["node","show","--project-id",binding.projectId,"--node-id",node.nodeId])).data;
      let remote=shown?.nodes?.find((x:any)=>x.result==="FOUND"&&x.node?.nodeId===node.nodeId)?.node;
      if(!remote){
        const args=["node","create",node.key==="SETTING"?"image":"video","--project-id",binding.projectId,"--node-id",node.nodeId,"--update-id",node.updateId,
          "--title","PVS 选枕参考报价 "+node.key,"--mode",g.mode,"--prompt",g.prompt,"--model",g.model,"--ratio",g.ratio,"--resolution",g.resolution,"--count","1"];
        if("durationSeconds" in g)args.push("--duration","12");if("references" in g)for(const ref of g.references??[])args.push("--ref","node:"+ref.id);
        const created=await canvas.runtime.call(args);remote=created.data?.node;
        if(created.data?.mutation?.generationDiff?.length)throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_GENERATION_DIFF");
      }
      if(remote?.nodeId!==node.nodeId||!remote.generation||canvasGenerationHash(remote.generation)!==node.generationHash)
        throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_NODE_CHANGED");
      node.saved=true;await save(p);
    }
    const shown=(await canvas.runtime.call(["node","show","--project-id",binding.projectId,...receipt.nodes.flatMap(n=>["--node-id",n.nodeId])])).data;
    for(const node of receipt.nodes){const remote=shown?.nodes?.find((x:any)=>x.result==="FOUND"&&x.node?.nodeId===node.nodeId)?.node;
      if(!remote?.generation||canvasGenerationHash(remote.generation)!==node.generationHash)throw new CanvasRuntimeError("SHORT_REFERENCE_QUOTE_NODE_CHANGED");}
    const quote=await canvas.runtime.call(["node","quote","--project-id",binding.projectId,...receipt.nodes.flatMap(n=>["--node-id",n.nodeId])]);
    const checked=validateCanvasQuote(quote.data,receipt.nodes.map(n=>n.nodeId),shown.draftVersion);
    if(!quote.meta?.requestId)throw new CanvasRuntimeError("QUOTE_REQUEST_ID_MISSING");
    receipt.draftVersion=checked.draftVersion;receipt.sourceRequestId=quote.meta.requestId;receipt.checkedAt=new Date().toISOString();
    receipt.items=receipt.nodes.map(node=>{const item=checked.items.find(i=>i.nodeId===node.nodeId)!;return {key:node.key,nodeId:node.nodeId,
      credits:item.error?null:item.maxCredits!,...(item.error?{error:item.error.validation.reasonCode}:{})};});
    const actual=receipt.items.filter(i=>i.key!=="PRODUCT_ONLY_COMPARISON");
    receipt.totalCredits=actual.every(i=>i.credits!==null)?actual.reduce((sum,i)=>sum+i.credits!,0):null;
    receipt.status=receipt.totalCredits===null?"INCOMPLETE":receipt.totalCredits>72?"OVER_BUDGET":"QUOTED";
    p.blocker=receipt.totalCredits===null?"新设定参考没有实际产物，上游视频报价未齐；禁止先生成换取报价，比较草稿不可作为总价":
      receipt.totalCredits>72?"新图与视频总价超过72积分上限；停止": "报价仍须在实际参考图审核绑定后重验；任何生成均需另行确认";
    await save(p);return receipt;
  }catch(error){receipt.status="INCOMPLETE";receipt.totalCredits=null;receipt.error=error instanceof CanvasRuntimeError?error.code:"SHORT_REFERENCE_QUOTE_FAILED";
    receipt.checkedAt=new Date().toISOString();await save(p);throw error;}
}
