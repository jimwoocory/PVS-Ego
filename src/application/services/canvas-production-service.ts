import {randomUUID,randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import type {CanvasProductionBinding,CanvasNodeBinding} from "../../domain/canvas-production.js";
import {canvasProductionBindingSchema} from "../../domain/canvas-production.js";
import type {QuoteRequest,ProviderQuote} from "../../domain/generation-quote.js";
import type {ProductTruth} from "../../domain/schemas.js";
import {DreaminaCanvasRuntime,CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {ProductionQuoteService,buildProductionQuoteRequest,assertCurrentQuote} from "./production-quote-service.js";
import type {ProductionImageProvider} from "../ports/production-image-provider.js";
import {ProductionImageSubmissionUnknownError} from "../../adapters/image/domestic-jimeng-image-provider.js";
import {compileExistingDirector} from "./production-continuation.js";
import {productionAssetSetSchema} from "../../domain/production-strategy.js";

type Checkpoint=(binding:CanvasProductionBinding)=>Promise<void>;
type Generation={mode:string;prompt?:string;model?:string;ratio?:string;resolution?:string;outputCount:number;durationSeconds?:number;references?:Array<{id?:string}>};
export const isCanvasNodeId=(id:string)=>/^node_[0123456789abcdefghjkmnpqrstvwxyz]{10}$/.test(id);
export const newCanvasNodeId=()=>"node_"+[...randomBytes(10)].map(b=>"0123456789abcdefghjkmnpqrstvwxyz"[b&31]).join("");
export function canvasDraftPayload(run:SmartGenerationRun,truth:ProductTruth,productSha256:string){
  if(!run.script||!run.productionPlan||!run.productionAssetSet)throw new CanvasRuntimeError("PVS_SOURCE_INCOMPLETE");
  const compiled=compileExistingDirector({truth,script:run.script,plan:run.productionPlan,assets:run.productionAssetSet});
  return {projectId:run.projectId,runId:run.id,scriptHash:run.script.contentHash,planHash:run.productionPlan.contentHash,productSha256,
    images:run.productionAssetSet.entries.filter(e=>e.source==="DREAMINA_GENERATED").map(e=>({key:e.key,prompt:e.generationPrompt})),
    videos:compiled.seedancePromptDrafts.map(p=>({key:p.clipId,prompt:p.promptText})),imageModel:"seedream_5.0_lite",videoModel:"seedance_2.0_vip"};
}
export function canvasGenerationHash(g:Generation){
  return hashValue({mode:g.mode,prompt:g.prompt??"",model:g.model??"",ratio:g.ratio??"",resolution:(g.resolution??"").toLowerCase(),
    outputCount:g.outputCount,durationSeconds:g.durationSeconds??null,references:(g.references??[]).map(r=>r.id)});
}
export function validateCanvasQuote(data:any,expectedIds:string[],draftVersion:number){
  if(!data||!Number.isSafeInteger(data.draftVersion)||data.draftVersion!==draftVersion||!Array.isArray(data.items)||
      data.items.length!==expectedIds.length||new Set(data.items.map((i:any)=>i.nodeId)).size!==expectedIds.length||typeof data.confirmable!=="boolean")
    throw new CanvasRuntimeError("QUOTE_DRAFT_OR_COVERAGE_INVALID");
  let total=0;
  for(const id of expectedIds){const item=data.items.find((i:any)=>i.nodeId===id);
    if(!item||item.generationDiff?.length)throw new CanvasRuntimeError("QUOTE_ITEM_UNAVAILABLE_OR_CHANGED");
    if(item.error){if(item.maxCredits!==undefined||!item.error.validation?.reasonCode)throw new CanvasRuntimeError("QUOTE_ITEM_ERROR_INVALID");continue;}
    if(!Number.isSafeInteger(item.maxCredits)||item.maxCredits<0)throw new CanvasRuntimeError("QUOTE_ITEM_UNAVAILABLE_OR_CHANGED");total+=item.maxCredits;}
  if(!Number.isSafeInteger(data.totalMaxCredits)||total!==data.totalMaxCredits)throw new CanvasRuntimeError("QUOTE_TOTAL_MISMATCH");
  if(!data.items.some((i:any)=>i.error)&&!data.confirmable)throw new CanvasRuntimeError("QUOTE_NOT_CONFIRMABLE");
  return {total,confirmable:data.confirmable,items:data.items as Array<{nodeId:string;maxCredits?:number;error?:{validation:{reasonCode:string}}}>,draftVersion:data.draftVersion};
}
export function canvasBoundQuoteRequest(run:SmartGenerationRun,kind?:"IMAGE"|"VIDEO"):QuoteRequest{
  const original=run.canvasBinding?.originalQuoteRequest??(run.feeQuote?{contract:run.feeQuote.contract,projectId:run.projectId,runId:run.id,scopeHash:run.feeQuote.scopeHash,items:run.feeQuote.items.map(i=>i.request)}:undefined);
  if(!original||original.scopeHash!==run.canvasBinding?.scopeHash||original.projectId!==run.projectId||original.runId!==run.id)throw new CanvasRuntimeError("ORIGINAL_QUOTE_BINDING_MISSING");
  return kind?{...original,items:original.items.filter(i=>i.kind===kind),scopeHash:hashValue({sourceScopeHash:original.scopeHash,kind,items:original.items.filter(i=>i.kind===kind)})}:original;
}
export class CanvasProductionService {
  constructor(readonly runtime:DreaminaCanvasRuntime){}
  private node(key:string,kind:CanvasNodeBinding["kind"],sourceRequestHash:string):CanvasNodeBinding{
    return {key,kind,sourceRequestHash,nodeId:newCanvasNodeId(),updateId:randomUUID(),submitId:randomUUID(),saved:false,
      ...(kind==="PRODUCT"?{resourceId:randomUUID()}: {})};
  }
  /** Reprice saved identities without uploading, rewriting prompts, or requiring generated assets to be adopted. */
  async rebindUnspentPlan(run:SmartGenerationRun,prompts:Array<{clipId:string;promptText:string}>,checkpoint:Checkpoint){
    const b=run.canvasBinding,plan=run.productionPlan;
    if(!b||!plan||run.consent||run.attemptIds.length||b.nodes.some(n=>n.kind==="VIDEO"&&n.execution)||
      b.sourceScriptHash!==run.script?.contentHash||!b.sourcePlanHash)throw new CanvasRuntimeError("PLAN_REBIND_REQUIRES_UNSPENT_SAME_SCRIPT");
    if(b.sourcePlanHash===plan.contentHash)return;
    const account=await this.runtime.assertAccount();
    if(account.accountFingerprint!==b.accountFingerprint||b.profile!==this.runtime.config.profile||b.executableSha256!==this.runtime.config.executableSha256)throw new CanvasRuntimeError("PLAN_REBIND_ACCOUNT_CHANGED");
    await this.inspectBoundNodes(b);
    const request=buildProductionQuoteRequest(run),items=request.items.filter(i=>i.kind==="VIDEO"),nodes=b.nodes.filter(n=>n.kind==="VIDEO");
    const shown=(await this.runtime.call(["node","show","--project-id",b.projectId,...nodes.flatMap(n=>["--node-id",n.nodeId])])).data;
    if(items.length!==nodes.length||prompts.length!==nodes.length)throw new CanvasRuntimeError("PLAN_REBIND_COVERAGE_CHANGED");
    for(const n of nodes){const item=items.find(i=>i.key===n.key),prompt=prompts.find(p=>p.clipId===n.key),g=shown?.nodes?.find((x:any)=>x.result==="FOUND"&&x.node?.nodeId===n.nodeId)?.node?.generation;
      if(!item||!prompt||!g||g.prompt!==prompt.promptText||canvasGenerationHash(g)!==n.generationHash||g.model!==this.runtime.config.videoModel||g.ratio!==item.aspectRatio||
        g.durationSeconds*1000!==item.durationMs||g.resolution?.toLowerCase()!==item.resolution.toLowerCase()||g.outputCount!==1||g.references?.length!==item.references.images||
        item.model.replace(/[_-]/g,"")!==g.model.replace(/[_-]/g,"")||b.originalQuoteRequest?.items.find(i=>i.key===n.key)?.nativeAudio!==item.nativeAudio)
        throw new CanvasRuntimeError("PLAN_REBIND_GENERATION_CHANGED");
    }
    b.planBindingHistory=[...(b.planBindingHistory??[]),{fromPlanHash:b.sourcePlanHash,toPlanHash:plan.contentHash,fromScopeHash:b.scopeHash,toScopeHash:request.scopeHash,checkedAt:new Date().toISOString()}];
    b.sourcePlanHash=plan.contentHash;b.scopeHash=request.scopeHash;b.originalQuoteRequest=request;b.quoteObservation=undefined;
    for(const n of nodes)n.sourceRequestHash=items.find(i=>i.key===n.key)!.sourceRequestHash;
    await checkpoint(b); // Local provenance only. No node edit, confirmation or submission.
  }
  async quoteSaved(run:SmartGenerationRun,kind?:"IMAGE"|"VIDEO"){
    const binding=run.canvasBinding,request=canvasBoundQuoteRequest(run,kind),account=await this.runtime.assertAccount();
    if(!binding||binding.runId!==run.id||binding.accountFingerprint!==account.accountFingerprint||binding.profile!==this.runtime.config.profile||
      binding.executableSha256!==this.runtime.config.executableSha256||
      binding.sourceScriptHash&&binding.sourceScriptHash!==run.script?.contentHash||binding.sourcePlanHash&&binding.sourcePlanHash!==run.productionPlan?.contentHash)
      throw new CanvasRuntimeError("SAVED_QUOTE_SOURCE_CHANGED");
    const observed=await this.inspectBoundNodes(binding);
    const nodes=request.items.map(item=>{const n=binding.nodes.find(n=>n.key===item.key);
      if(!n?.saved||n.sourceRequestHash!==item.sourceRequestHash||n.canonicalModel!==(item.kind==="IMAGE"?this.runtime.config.imageModel:this.runtime.config.videoModel))throw new CanvasRuntimeError("SAVED_QUOTE_NODE_CHANGED");return n;});
    const response=await this.runtime.call(["node","quote","--project-id",binding.projectId,...nodes.flatMap(n=>["--node-id",n.nodeId])]);
    const checked=validateCanvasQuote(response.data,nodes.map(n=>n.nodeId),observed.draftVersion);
    if(!response.meta?.requestId)throw new CanvasRuntimeError("QUOTE_REQUEST_ID_MISSING");
    const issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+10*60_000).toISOString();
    return new ProductionQuoteService({quote:async({item,requestHash}):Promise<ProviderQuote>=>{
      const node=nodes.find(n=>n.key===item.key)!,price=checked.items.find(i=>i.nodeId===node.nodeId)!;
      if(price.error)return {status:"UNAVAILABLE",code:price.error.validation.reasonCode,message:"Canvas当前已保存节点无法核价："+price.error.validation.reasonCode+"；未提交视频生成，缺项不按0计算"};
      return {status:"QUOTED",kind:"CREDIT_CEILING",requestHash,accountFingerprint:account.accountFingerprint,currency:"CREDITS",credits:price.maxCredits!,issuedAt,expiresAt,
        sourceUrl:this.runtime.config.officialSourceUrl,sourceRequestId:response.meta!.requestId,pricingParametersSufficient:false,validityBasis:"REVALIDATE_DRAFT",
        canvas:{projectId:binding.projectId,nodeId:node.nodeId,draftVersion:checked.draftVersion,generationHash:node.generationHash!,canonicalModel:node.canonicalModel!}};
    }}).quote(request);
  }
  async quote(run:SmartGenerationRun,input:{truth:ProductTruth;product:{path:string;sha256:string}},checkpoint:Checkpoint){
    const request=buildProductionQuoteRequest(run),account=await this.runtime.assertAccount();
    if(!run.script||!run.productionPlan||!run.productionAssetSet)throw new CanvasRuntimeError("PVS_SOURCE_INCOMPLETE");
    const grant=this.runtime.config.draftTransferGrant;
    if(!grant||grant.projectId!==run.projectId||grant.runId!==run.id||grant.scopeHash!==request.scopeHash||grant.productSha256!==input.product.sha256||
      grant.payloadHash!==hashValue(canvasDraftPayload(run,input.truth,input.product.sha256)))throw new CanvasRuntimeError("DRAFT_TRANSFER_NOT_AUTHORIZED_FOR_THIS_CONTENT");
    const image=await this.runtime.findModel(this.runtime.config.imageModel,"image"),video=await this.runtime.findModel(this.runtime.config.videoModel,"video");
    this.validateModelOptions(image,video,request);
    const current=run.canvasBinding;
    if(current&&(current.scopeHash!==request.scopeHash||current.accountFingerprint!==account.accountFingerprint||current.profile!==this.runtime.config.profile||
        current.executableSha256!==this.runtime.config.executableSha256))throw new CanvasRuntimeError("BINDING_SOURCE_CHANGED");
    let binding=current??canvasProductionBindingSchema.parse({runtime:"DREAMINA_CANVAS",projectId:randomUUID(),runId:run.id,scopeHash:request.scopeHash,
      profile:this.runtime.config.profile,accountFingerprint:account.accountFingerprint,modelApprovalSource:this.runtime.config.modelApprovalSource,
      executableSha256:this.runtime.config.executableSha256,created:false,checkedAt:new Date().toISOString(),
      nodes:[this.node("PRODUCT","PRODUCT",input.product.sha256),...request.items.map(i=>this.node(i.key,i.kind,i.sourceRequestHash))]});
    const save=async()=>{binding={...binding,checkedAt:new Date().toISOString()};await checkpoint(binding);};
    if(!current)await save(); // Persist identities BEFORE remote effects.
    try{
      if(binding.nodes.some(n=>!isCanvasNodeId(n.nodeId))){
        if(binding.nodes.some(n=>n.saved&&!isCanvasNodeId(n.nodeId)))throw new CanvasRuntimeError("SAVED_NODE_ID_INVALID");
        binding.nodes=binding.nodes.map(n=>isCanvasNodeId(n.nodeId)?n:{...n,nodeId:newCanvasNodeId()});
        await save(); // Only unsaved, locally rejected IDs may migrate; preserve remote canvas/resource/submit identities.
      }
      if(!binding.created){const created=await this.runtime.call(["canvas","create","PVS · 原项目漫剧报价","--project-id",binding.projectId]);
        if(created.data?.project?.projectId!==binding.projectId)throw new CanvasRuntimeError("CANVAS_ID_MISMATCH");
        binding={...binding,created:true,...(created.data.project.webUrl?{webUrl:created.data.project.webUrl}:{})};await save();}
      const product=binding.nodes.find(n=>n.kind==="PRODUCT")!;
      if(!product.saved){const bytes=await fs.readFile(input.product.path);if(sha256Bytes(bytes)!==input.product.sha256)throw new CanvasRuntimeError("PRODUCT_FILE_CHANGED");
        const uploaded=await this.runtime.call(["resource","upload","--project-id",binding.projectId,"--resource-id",product.resourceId!,"--file",input.product.path,"--type","image"]);
        if(uploaded.data?.resourceId!==product.resourceId||uploaded.data?.mediaType!=="image")throw new CanvasRuntimeError("PRODUCT_UPLOAD_MISMATCH");
        const imported=await this.runtime.call(["node","create","image","--project-id",binding.projectId,"--node-id",product.nodeId,"--update-id",product.updateId,
          "--title","PVS 原产品参考","--resource-id",product.resourceId!,"--import-kind","local_upload","--submit-id",product.submitId]);
        if(imported.data?.node?.nodeId!==product.nodeId)throw new CanvasRuntimeError("PRODUCT_NODE_MISMATCH");product.saved=true;await save();}
      const compiled=compileExistingDirector({truth:input.truth,script:run.script,plan:run.productionPlan,assets:run.productionAssetSet});
      for(const item of request.items){
        const node=binding.nodes.find(n=>n.key===item.key)!;if(node.saved)continue;
        const canonicalModel=item.kind==="IMAGE"?image.model:video.model;
        const mode=item.kind==="IMAGE"?"t2i":"m2v";
        const prompt=item.kind==="IMAGE"?run.productionAssetSet.entries.find(e=>e.key===item.key)?.generationPrompt:
          compiled.seedancePromptDrafts.find(p=>p.clipId===item.key)?.promptText;
        if(!prompt)throw new CanvasRuntimeError("PROMPT_BINDING_MISSING");
        const clip=run.productionPlan.scenes.flatMap(s=>s.clips).find(c=>c.id===item.key);
        const referenceIds=item.kind==="IMAGE"?[]:(clip?.referenceAssets??[]).map(ref=>{
          const entry=run.productionAssetSet!.entries.find(e=>e.referenceAssetId===ref.assetId||e.sourceReferenceAssetIds.includes(ref.assetId));
          const key=entry?.source==="PRODUCT_INPUT"?"PRODUCT":entry?.key;
          const target=binding.nodes.find(n=>n.key===key);if(!target)throw new CanvasRuntimeError("REFERENCE_NODE_MISSING");return target.nodeId;
        });
        if(referenceIds.length!==item.references.images)throw new CanvasRuntimeError("REFERENCE_COUNT_MISMATCH");
        const desired:Generation={mode,prompt,model:canonicalModel,ratio:item.aspectRatio,resolution:item.kind==="IMAGE"?"2K":item.resolution,
          outputCount:item.count,...(item.durationMs?{durationSeconds:item.durationMs/1000}:{}),references:referenceIds.map(id=>({id}))};
        const args=["node","create",item.kind.toLowerCase(),"--project-id",binding.projectId,"--node-id",node.nodeId,"--update-id",node.updateId,
          "--title",item.label,"--mode",mode,"--prompt",prompt,"--model",canonicalModel,"--ratio",desired.ratio!,"--resolution",desired.resolution!,"--count",String(item.count)];
        if(item.durationMs)args.push("--duration",String(item.durationMs/1000));for(const id of referenceIds)args.push("--ref","node:"+id);
        const result=await this.runtime.call(args),saved=result.data?.node;
        if(saved?.nodeId!==node.nodeId||!saved.generation||canvasGenerationHash(saved.generation)!==canvasGenerationHash(desired)||result.data?.mutation?.generationDiff?.length)
          throw new CanvasRuntimeError("SAVED_NODE_GENERATION_MISMATCH");
        node.saved=true;node.canonicalModel=canonicalModel;node.generationHash=canvasGenerationHash(saved.generation);await save();
      }
      const observed=await this.inspectBoundNodes(binding);binding.draftVersion=observed.draftVersion;await save();
      const response=await this.runtime.call(["node","quote","--project-id",binding.projectId,...binding.nodes.filter(n=>n.kind!=="PRODUCT").flatMap(n=>["--node-id",n.nodeId])]);
      const checked=validateCanvasQuote(response.data,binding.nodes.filter(n=>n.kind!=="PRODUCT").map(n=>n.nodeId),binding.draftVersion!);
      if(!response.meta?.requestId)throw new CanvasRuntimeError("QUOTE_REQUEST_ID_MISSING");
      binding.quoteObservation={requestId:response.meta.requestId,draftVersion:checked.draftVersion,confirmable:checked.confirmable,totalMaxCredits:checked.total,
        items:checked.items.map(i=>({nodeId:i.nodeId,...(i.error?{reason:i.error.validation.reasonCode}:{maxCredits:i.maxCredits})}))};await save();
      const observedAt=new Date().toISOString(),cacheUntil=new Date(Date.now()+10*60_000).toISOString();
      const byKey=new Map(binding.nodes.filter(n=>n.kind!=="PRODUCT").map(n=>[n.key,n]));
      const feeQuote=await new ProductionQuoteService({quote:async({item,requestHash}):Promise<ProviderQuote>=>{
        const node=byKey.get(item.key)!,price=checked.items.find(i=>i.nodeId===node.nodeId)!;
        if(price.error)return {status:"UNAVAILABLE",code:price.error.validation.reasonCode,message:price.error.validation.reasonCode==="REFERENCE_SOURCE_NO_OUTPUT"?
          "Canvas已保存本镜头，但角色/场景参考节点尚无生成产物；上游node quote不支持按待生成参考的规格报价。缺少无需先生成参考图的预估报价接口，未提交生成，缺项不按0积分计算。":"Canvas拒绝本项报价："+price.error.validation.reasonCode};
        return {status:"QUOTED",kind:"CREDIT_CEILING",requestHash,accountFingerprint:account.accountFingerprint,currency:"CREDITS",credits:price.maxCredits!,
          issuedAt:observedAt,expiresAt:cacheUntil,validityBasis:"REVALIDATE_DRAFT",sourceUrl:"https://jimeng.jianying.com/canvas-cli/install.ps1",
          pricingParametersSufficient:false,...(response.meta?.requestId?{sourceRequestId:response.meta.requestId}:{}),
          canvas:{projectId:binding.projectId,nodeId:node.nodeId,draftVersion:checked.draftVersion,generationHash:node.generationHash!,canonicalModel:node.canonicalModel!}};
      }}).quote(request);
      binding.errorCode=undefined;await save();return feeQuote;
    }catch(error){binding.errorCode=error instanceof CanvasRuntimeError?error.code:"CANVAS_QUOTE_FAILED";await save();throw error;}
  }
  private validateModelOptions(image:any,video:any,request:QuoteRequest){
    for(const item of request.items){const model=item.kind==="IMAGE"?image:video,mode=item.kind==="IMAGE"?"t2i":"m2v";
      const modes=model.modes?.filter((m:any)=>m.name===mode)??[];
      if(!modes.some((m:any)=>["--ratio","--resolution"].every(flag=>{const f=m.flags?.find((x:any)=>x.flag===flag);const value=flag==="--ratio"?item.aspectRatio:item.resolution;return Array.isArray(f?.values)&&f.values.some((v:string)=>v.toLowerCase()===value.toLowerCase());})&&
        (!item.durationMs||m.flags.some((f:any)=>f.flag==="--duration"&&item.durationMs!/1000>=f.min&&item.durationMs!/1000<=f.max))&&
        m.flags.some((f:any)=>f.flag==="--count"&&item.count>=f.min&&item.count<=f.max)&&
        (!item.references.images||(m.references?.min<=item.references.images&&m.references.max>=item.references.images&&
          m.references.types?.some((t:any)=>t.mediaType==="image"&&item.references.images>=t.min&&item.references.images<=t.max)))))throw new CanvasRuntimeError("MODEL_SPEC_NOT_SUPPORTED");
    }
  }
  async inspectBoundNodes(binding:CanvasProductionBinding){
    const response=await this.runtime.call(["node","show","--project-id",binding.projectId,...binding.nodes.map(n=>n.nodeId).flatMap(id=>["--node-id",id])]);
    for(const bound of binding.nodes){const node=response.data?.nodes?.find((n:any)=>n.result==="FOUND"&&n.node?.nodeId===bound.nodeId)?.node;
      if(!node)throw new CanvasRuntimeError("BOUND_NODE_UNAVAILABLE");
      if(bound.kind!=="PRODUCT"&&(!node.generation||canvasGenerationHash(node.generation)!==bound.generationHash))throw new CanvasRuntimeError("BOUND_NODE_EDITED");
      if(bound.kind!=="PRODUCT"&&(node.generation.references??[]).some((r:any)=>r.kind!=="node"||!binding.nodes.some(n=>n.nodeId===r.id)||!node.upstreamNodeIds?.includes(r.id)))
        throw new CanvasRuntimeError("BOUND_REFERENCE_OR_LINK_CHANGED");
      if(bound.kind==="PRODUCT"&&!node.resources?.some((r:any)=>r.resourceId===bound.resourceId))throw new CanvasRuntimeError("BOUND_PRODUCT_CHANGED");
    }
    if(!Number.isSafeInteger(response.data?.draftVersion))throw new CanvasRuntimeError("DRAFT_VERSION_MISSING");return {draftVersion:response.data.draftVersion};
  }
  /** Read-only checks. A quotation is never itself a grant to run. */
  async validateBudget(run:SmartGenerationRun,kind:"IMAGE"|"VIDEO"){
    const quote=assertCurrentQuote(run,kind),binding=run.canvasBinding;
    const account=await this.runtime.assertAccount();
    if(!binding||binding.runId!==run.id||(binding.scopeHash!==quote.scopeHash&&!(kind==="IMAGE"&&binding.imageBudgetGrant?.quoteScopeHash===quote.scopeHash))||binding.accountFingerprint!==account.accountFingerprint||
      binding.profile!==this.runtime.config.profile||binding.executableSha256!==this.runtime.config.executableSha256)
      throw new CanvasRuntimeError("BUDGET_ACCOUNT_OR_SCOPE_CHANGED");
    if(kind==="IMAGE"&&binding.imageBudgetGrant){const {grantHash,...grant}=binding.imageBudgetGrant;
      if(hashValue(grant)!==grantHash||grant.projectId!==run.projectId||grant.runId!==run.id||grant.scopeHash!==run.assetPaidScope?.hash||
        quote.items.some(i=>i.result.status!=="QUOTED"||i.result.credits>0))throw new CanvasRuntimeError("ZERO_IMAGE_BUDGET_EXCEEDED_OR_CHANGED");}
    if(kind==="IMAGE"&&run.assetPaidScope){const s=run.assetPaidScope;
      if(hashValue({strategyHash:s.strategyHash,assets:s.assets,...(s.authorizationNonce?{authorizationNonce:s.authorizationNonce}:{})})!==s.hash||
        s.strategyHash!==run.productionStrategy?.contentHash)throw new CanvasRuntimeError("ASSET_PAID_SCOPE_HASH_INVALID");}
    const scoped=kind==="IMAGE"?run.assetPaidScope?.assets.map(a=>({key:a.key,hash:a.requestHash,credits:a.estimatedCredits,cost:a.costStatus})):
      run.paidScope?.requests.map(r=>({key:r.clipId,hash:binding.nodes.find(n=>n.key===r.clipId)?.sourceRequestHash,credits:r.estimatedCredits,cost:r.costStatus}));
    const selected=quote.items.filter(i=>i.request.kind===kind);
    if(!scoped?.length||scoped.length!==selected.length)throw new CanvasRuntimeError("BUDGET_COVERAGE_CHANGED");
    for(const s of scoped){const item=selected.find(i=>i.request.key===s.key),node=binding.nodes.find(n=>n.key===s.key);
      if(!item||item.result.status!=="QUOTED"||s.cost!=="KNOWN"||s.credits!==item.result.credits||item.request.sourceRequestHash!==s.hash||
        item.result.accountFingerprint!==binding.accountFingerprint||item.result.validityBasis!=="REVALIDATE_DRAFT"||!node?.saved||
        item.result.canvas?.projectId!==binding.projectId||item.result.canvas.nodeId!==node.nodeId||
        item.result.canvas.generationHash!==node.generationHash||item.result.canvas.canonicalModel!==node.canonicalModel)
        throw new CanvasRuntimeError("BUDGET_NODE_OR_PRICE_CHANGED");
    }
    const observed=await this.inspectBoundNodes(binding);
    const ids=selected.map(i=>(i.result as Extract<ProviderQuote,{status:"QUOTED"}>).canvas!.nodeId);
    const live=validateCanvasQuote((await this.runtime.call(["node","quote","--project-id",binding.projectId,...ids.flatMap(id=>["--node-id",id])])).data,ids,observed.draftVersion);
    if(!live.confirmable||live.items.some(i=>{const prior=selected.find(q=>q.result.status==="QUOTED"&&q.result.canvas?.nodeId===i.nodeId)?.result;
      return i.error||prior?.status!=="QUOTED"||i.maxCredits!>prior.credits;}))
      throw new CanvasRuntimeError("BUDGET_REQUOTE_REQUIRED");
    return {binding,selected};
  }
  /** Only called from the existing SmartRun consent path, under its durable lease. */
  async submitAuthorizedNode(run:SmartGenerationRun,key:string,checkpoint:Checkpoint){
    const binding=run.canvasBinding,node=binding?.nodes.find(n=>n.key===key);
    if(!binding||!node||node.kind==="PRODUCT")throw new CanvasRuntimeError("EXECUTION_NODE_MISSING");
    const kind=node.kind,consent=kind==="IMAGE"?run.assetConsent:run.consent,scope=kind==="IMAGE"?run.assetPaidScope:run.paidScope;
    if(!consent||!scope||consent.scopeHash!==scope.hash||consent.acceptedUnknownCostRisk||
      !(kind==="IMAGE"?["ASSET_PREPARING"]:["APPROVING","GENERATING"]).includes(run.status)||
      consent.source!==(kind==="IMAGE"?"EXPLICIT_SMART_RUN_ASSET_PAID_CONFIRMATION":"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"))
      throw new CanvasRuntimeError("PAID_ACTION_NOT_AUTHORIZED");
    if(node.execution){
      if(node.execution.scopeHash!==scope.hash)throw new CanvasRuntimeError("EXECUTION_SCOPE_CHANGED");
      // Even PREPARED/absent/unknown is never permission for an automatic repeat.
      return {submitId:node.submitId,recovered:true,state:node.execution.state};
    }
    const checked=await this.validateBudget(run,kind),item=checked.selected.find(i=>i.request.key===key)!;
    if(item.result.status!=="QUOTED")throw new CanvasRuntimeError("EXECUTION_PRICE_MISSING");
    const ceiling=item.result.credits;
    node.execution={scopeHash:scope.hash,authorizedCeiling:ceiling,state:"PREPARED",resources:[],updatedAt:new Date().toISOString()};await checkpoint(binding);
    // Token lives only in this stack frame; never include it in durable state or diagnostics.
    const approved=await this.runtime.call(["node","confirm","--project-id",binding.projectId,"--node-id",node.nodeId,"--credit-ceiling",String(ceiling)],true);
    if(!approved.data?.creditConfirmationToken||approved.data.creditCeiling!==ceiling||Date.parse(approved.data.expiresAt)<=Date.now())
      throw new CanvasRuntimeError("BUDGET_TOKEN_INVALID");
    node.execution.state="DISPATCHING";node.execution.updatedAt=new Date().toISOString();await checkpoint(binding);
    try{
      const response=await this.runtime.call(["node","run","--project-id",binding.projectId,"--node-id",node.nodeId,"--submit-id",node.submitId,"--credit-token",approved.data.creditConfirmationToken],true);
      const result=response.data?.items?.[0];
      if(response.data?.items?.length!==1||result.nodeId!==node.nodeId||result.submitId!==node.submitId||result.generationDiff?.length)throw new CanvasRuntimeError("RUN_RECEIPT_MISMATCH");
      const state=String(result.state).toLowerCase();
      node.execution.state=state==="accepted"?"ACCEPTED":state==="rejected"?"REJECTED":"UNKNOWN";
      node.execution.resources=(result.resources??[]).map((r:any)=>r.resourceId);node.execution.updatedAt=new Date().toISOString();await checkpoint(binding);
      if(node.execution.state!=="ACCEPTED")throw new CanvasRuntimeError("RUN_"+node.execution.state);
      return {submitId:node.submitId,recovered:false,state:node.execution.state};
    }catch(error){node.execution.state="UNKNOWN";node.execution.updatedAt=new Date().toISOString();await checkpoint(binding);
      throw new ProductionImageSubmissionUnknownError("Canvas提交结果未知；仅按原提交编号查询，不会自动重提");}
  }
  async recoverImages(run:SmartGenerationRun,checkpoint:Checkpoint){
    const binding=run.canvasBinding,set=run.productionAssetSet;
    if(!binding?.imageBudgetGrant||!set||run.assetConsent?.scopeHash!==binding.imageBudgetGrant.scopeHash||run.consent)throw new CanvasRuntimeError("RECOVERY_IMAGE_SCOPE_MISSING");
    await this.runtime.assertAccount();await this.inspectBoundNodes(binding);
    const entries=structuredClone(set.entries);
    for(const node of binding.nodes.filter(n=>n.kind==="IMAGE"&&n.execution)){
      const data=(await this.runtime.call(["operation","status",node.submitId,"--project-id",binding.projectId])).data;
      if(data?.operationRef!==node.submitId)throw new CanvasRuntimeError("OPERATION_ID_MISMATCH");
      if(data.submission?.adviceCode!=="submission_accepted"||!["completed","in_progress"].includes(data.submission.state))continue;
      node.execution!.state="ACCEPTED";node.execution!.resources=data.resources?.map((r:any)=>r.resourceId)??[];node.execution!.updatedAt=new Date().toISOString();await checkpoint(binding);
      const entry=entries.find(e=>e.key===node.key);
      if(entry&&["PLANNED","SUBMISSION_UNKNOWN"].includes(entry.status)){
        entry.status="SUBMITTED";entry.submitId=node.submitId;entry.submittedAt=node.execution!.updatedAt;entry.errorCode=undefined;entry.errorMessage=undefined;
      }
    }
    const body={...set,entries,status:"PREPARING" as const,updatedAt:new Date().toISOString()};const {contentHash:_,...hashable}=body;
    return productionAssetSetSchema.parse({...body,contentHash:hashValue(hashable)});
  }
  imageProvider(run:SmartGenerationRun,checkpoint:Checkpoint):ProductionImageProvider{
    const binding=run.canvasBinding;if(!binding)throw new CanvasRuntimeError("IMAGE_BINDING_MISSING");
    const find=(submitId:string)=>{const node=binding.nodes.find(n=>n.kind==="IMAGE"&&n.submitId===submitId);if(!node?.execution)throw new CanvasRuntimeError("UNKNOWN_IMAGE_SUBMISSION");return node;};
    return {id:"dreamina-canvas-image",
      probe:async()=>{try{await this.validateBudget(run,"IMAGE");return {ready:true};}catch(error){return {ready:false,reason:error instanceof Error?error.message:"Canvas预算未就绪"};}},
      submit:async input=>{const entry=run.productionAssetSet?.entries.find(e=>e.key===input.businessKey);
        if(input.projectId!==run.projectId||entry?.generationRequestHash!==input.requestHash||entry.generationPrompt!==input.prompt)throw new CanvasRuntimeError("IMAGE_REQUEST_CHANGED");
        return this.submitAuthorizedNode(run,input.businessKey,checkpoint);},
      status:async submitId=>{find(submitId);await this.runtime.assertAccount();
        const result=await this.runtime.call(["operation","status",submitId,"--project-id",binding.projectId]),data=result.data;
        if(data?.operationRef!==submitId)throw new CanvasRuntimeError("OPERATION_ID_MISMATCH");
        const resource=data.resources?.find((r:any)=>r.state==="succeeded");
        if(data.state==="succeeded"&&resource)return {status:"SUCCEEDED",imageUrl:"canvas-resource:"+resource.resourceId};
        if(data.state==="failed")return {status:"FAILED",reason:"Canvas原任务生成失败，未自动重新提交"};
        if(["running","pending"].includes(data.state))return {status:"PROCESSING"};
        return {status:"UNKNOWN",reason:"Canvas原提交状态待核实，不会重提"};},
      download:async (imageUrl,outputPath)=>{const resourceId=imageUrl.replace(/^canvas-resource:/,"");
        if(!/^canvas-resource:[a-f0-9-]{36}$/.test(imageUrl))throw new CanvasRuntimeError("IMAGE_RESOURCE_INVALID");
        await this.runtime.assertAccount();const result=await this.runtime.call(["resource","download",resourceId,"--project-id",binding.projectId,"--output",outputPath]);
        const bytes=await fs.readFile(outputPath),sha256=sha256Bytes(bytes);
        if(result.data?.resourceId!==resourceId||result.data.sha256!==sha256||result.data.size!==bytes.length)throw new CanvasRuntimeError("IMAGE_DOWNLOAD_INTEGRITY_FAILED");
        const mimeType=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png" as const:
          bytes[0]===255&&bytes[1]===216?"image/jpeg" as const:bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"?"image/webp" as const:undefined;
        if(!mimeType)throw new CanvasRuntimeError("IMAGE_FORMAT_INVALID");return {path:outputPath,sha256,sizeBytes:bytes.length,mimeType};}
    };
  }
}
