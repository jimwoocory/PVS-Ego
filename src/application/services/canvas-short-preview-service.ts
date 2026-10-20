import {randomUUID} from "node:crypto";
import {hashValue} from "../../domain/hashing.js";
import {canvasShortPreviewInput,canvasShortPreviewSchema,type CanvasShortPreview} from "../../domain/canvas-short-preview.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import {CanvasProductionService,canvasGenerationHash,newCanvasNodeId,validateCanvasQuote} from "./canvas-production-service.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";

/** Side-by-side quote drafts. They never replace the original script, plan, nodes or paid scope. */
export class CanvasShortPreviewService {
  constructor(private readonly canvas:CanvasProductionService){}
  async quote(run:SmartGenerationRun,input:unknown,checkpoint:(p:CanvasShortPreview)=>Promise<void>){
    const i=canvasShortPreviewInput.parse(input),b=run.canvasBinding,account=await this.canvas.runtime.assertAccount();
    if(!b||i.sourceScriptHash!==run.script?.contentHash||b.sourceScriptHash!==i.sourceScriptHash||b.sourcePlanHash!==run.productionPlan?.contentHash||
      b.accountFingerprint!==account.accountFingerprint||b.runId!==run.id||b.profile!==this.canvas.runtime.config.profile||b.executableSha256!==this.canvas.runtime.config.executableSha256)
      throw new CanvasRuntimeError("SHORT_PREVIEW_SOURCE_CHANGED");
    await this.canvas.inspectBoundNodes(b);
    const refs=["PRODUCT","DAUGHTER","FATHER","LIVING_ROOM"].map(key=>b.nodes.find(n=>n.key===key)?.nodeId);
    if(refs.some(id=>!id))throw new CanvasRuntimeError("SHORT_PREVIEW_REFERENCES_MISSING");
    const inputHash=hashValue({input:i,sourcePlanHash:b.sourcePlanHash,account:account.accountFingerprint,references:refs});
    let p=run.canvasShortPreviews?.find(p=>p.inputHash===inputHash)??canvasShortPreviewSchema.parse({
      id:randomUUID(),sourceRunId:run.id,sourceScriptHash:i.sourceScriptHash,sourcePlanHash:b.sourcePlanHash,inputHash,title:i.title,outputDurationMs:15000,
      tailCardText:i.tailCardText,accountFingerprint:b.accountFingerprint,canvasProjectId:b.projectId,referenceNodeIds:refs,
      candidates:["seedance_2.0_fast_vip","seedance_2.0_vip","seedance_2.5"].flatMap(model=>[12000,15000].map(ms=>({
        key:model+"-"+ms,nodeId:newCanvasNodeId(),updateId:randomUUID(),model,generatedDurationMs:ms,localTailMs:15000-ms,
        prompt:ms===12000?i.prompt12s:i.prompt15s,saved:false
      }))),status:"DRAFTING",paidGenerationAuthorized:false,publishAuthorized:false,checkedAt:new Date().toISOString()});
    const save=async()=>{p.checkedAt=new Date().toISOString();await checkpoint(canvasShortPreviewSchema.parse(p));};
    p.status="DRAFTING";p.recommendedKey=undefined;
    for(const c of p.candidates){c.quote=undefined;c.errorCode=undefined;}
    await save(); // Stable IDs first, invalidate old prices before any remote write.
    for(const c of p.candidates){
      c.quote=undefined;c.errorCode=undefined;
      const model=await this.canvas.runtime.findModel(c.model,"video");
      const mode=model.modes?.find((m:any)=>m.name==="m2v"),duration=mode?.flags?.find((f:any)=>f.flag==="--duration");
      if(!duration||c.generatedDurationMs/1000<duration.min||c.generatedDurationMs/1000>duration.max||
        !mode.flags.some((f:any)=>f.flag==="--resolution"&&f.values?.some((v:string)=>v.toLowerCase()==="720p"))||
        !mode.flags.some((f:any)=>f.flag==="--ratio"&&f.values?.includes("9:16"))||mode.references?.max<refs.length)
        throw new CanvasRuntimeError("SHORT_PREVIEW_MODEL_SPEC_UNSUPPORTED");
      const desired={mode:"m2v",prompt:c.prompt,model:c.model,ratio:"9:16",resolution:"720p",durationSeconds:c.generatedDurationMs/1000,outputCount:1,references:refs.map(id=>({id}))};
      if(!c.saved){
        const result=await this.canvas.runtime.call(["node","create","video","--project-id",b.projectId,"--node-id",c.nodeId,"--update-id",c.updateId,
          "--title",`PVS15秒比价 ${c.model} ${c.generatedDurationMs/1000}+${c.localTailMs/1000}秒`,"--mode","m2v","--prompt",c.prompt,"--model",c.model,
          "--ratio","9:16","--resolution","720p","--duration",String(c.generatedDurationMs/1000),"--count","1",...refs.flatMap(id=>["--ref","node:"+id])]);
        if(result.data?.node?.nodeId!==c.nodeId||!result.data.node.generation||canvasGenerationHash(result.data.node.generation)!==canvasGenerationHash(desired)||result.data?.mutation?.generationDiff?.length)
          throw new CanvasRuntimeError("SHORT_PREVIEW_SAVED_NODE_CHANGED");
        c.saved=true;c.generationHash=canvasGenerationHash(desired);await save();
      }
    }
    const shown=(await this.canvas.runtime.call(["node","show","--project-id",b.projectId,...p.candidates.flatMap(c=>["--node-id",c.nodeId])])).data;
    for(const c of p.candidates){const g=shown?.nodes?.find((n:any)=>n.result==="FOUND"&&n.node?.nodeId===c.nodeId)?.node?.generation;
      if(!g||canvasGenerationHash(g)!==c.generationHash)throw new CanvasRuntimeError("SHORT_PREVIEW_NODE_EDITED");}
    const response=await this.canvas.runtime.call(["node","quote","--project-id",b.projectId,...p.candidates.flatMap(c=>["--node-id",c.nodeId])]);
    const checked=validateCanvasQuote(response.data,p.candidates.map(c=>c.nodeId),shown.draftVersion);
    if(!response.meta?.requestId)throw new CanvasRuntimeError("SHORT_PREVIEW_QUOTE_REQUEST_ID_MISSING");
    for(const c of p.candidates){const price=checked.items.find(item=>item.nodeId===c.nodeId)!;
      if(price.error)c.errorCode=price.error.validation.reasonCode;
      else c.quote={maxCredits:price.maxCredits!,requestId:response.meta.requestId,draftVersion:checked.draftVersion,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600_000).toISOString()};}
    p.status=p.candidates.every(c=>c.quote)?"QUOTED":"PARTIAL";
    // Price comparison only; account entitlement and quality are never inferred from price.
    p.recommendedKey=p.candidates.filter(c=>c.quote).sort((a,b)=>a.quote!.maxCredits-b.quote!.maxCredits||a.generatedDurationMs-b.generatedDurationMs)[0]?.key;
    await save();return {...p,quoteOnly:true,requiresNewProductionPlanAndPaidConfirmation:true,
      blockers:[...run.productionAssetSet?.entries.filter(e=>e.source==="DREAMINA_GENERATED"&&e.status!=="READY").map(e=>"ASSET_REVIEW_REQUIRED:"+e.key)??[]],
      costMeaning:"同账号服务端积分上限；仅比较这6种720p单次生成方案，本地3秒尾卡不消耗生成积分；不代表全平台最低价或质量保证"};
  }
}
