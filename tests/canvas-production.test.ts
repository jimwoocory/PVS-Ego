import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {inspectMedia} from "../src/adapters/media/inspect-media.js";
import {CanvasProductionService,canvasGenerationHash,newCanvasNodeId,isCanvasNodeId,validateCanvasQuote} from "../src/application/services/canvas-production-service.js";
import {DreaminaCanvasRuntime,type CanvasEnvelope,type CanvasRuntimeConfig} from "../src/adapters/video/dreamina-canvas-runtime.js";
import {ProductionQuoteService,buildProductionQuoteRequest,assertCurrentQuote} from "../src/application/services/production-quote-service.js";
import {hashValue} from "../src/domain/hashing.js";
import type {SmartGenerationRun} from "../src/domain/smart-generation.js";
import type {CanvasProductionBinding} from "../src/domain/canvas-production.js";
import {renderProductionQuote,renderCanvasShortPreview,renderCanvasShortPlan,renderAgentCyclePage} from "../src/web/agent-cycle-ui.js";
import {SmartGenerationService} from "../src/application/services/smart-generation-service.js";
import type {SmartRunRepository} from "../src/application/ports/smart-run-repository.js";
import type {SmartProduction} from "../src/application/ports/smart-production.js";
import {CanvasVideoDownloadMcp} from "../src/adapters/video/canvas-video-download-mcp.js";
import {CanvasVideoResultService} from "../src/application/services/canvas-video-result-service.js";
import type {ArtifactRepository} from "../src/application/ports/artifact-repository.js";
import type {GenerationRepository} from "../src/application/ports/generation-repository.js";
import type {WorkflowRepository} from "../src/application/ports/workflow-repository.js";
import {makeRequest,makeAttempt,makeApproval,makeValidClip} from "./fixtures.js";
import {CanvasCliVideoDownload} from "../src/adapters/video/canvas-cli-video-download.js";
import {CanvasShortProductionService} from "../src/application/services/canvas-short-production.js";
import {CanvasShortDeliveryService} from "../src/application/services/canvas-short-delivery.js";
import {CanvasVideoPreflightService,canvasPaidScopeHash} from "../src/application/services/canvas-video-preflight.js";
import {CanvasShortPreviewService} from "../src/application/services/canvas-short-preview-service.js";
import {submitAttemptOnce} from "../src/application/services/submission-service.js";
import {quoteShortReferences} from "../src/application/services/canvas-short-reference-quote.js";
import {generateZeroShortReference,syncShortReference} from "../src/application/services/canvas-short-reference-image.js";
import {writeFileSync} from "node:fs";
import {adoptShortReference,quoteShortBoundVideo} from "../src/application/services/canvas-short-bound-video-quote.js";

async function boundVideoFixture(t:test.TestContext,price=72){
  const f=await zeroReferenceFixture(t),q=f.plan.referenceQuote;
  await generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save);
  const image=f.plan.referenceImage;image.state="NEEDS_REVIEW";image.resources=[f.resourceId];
  image.artifact={id:"actual-setting-artifact",sha256:H,relativePath:"setting.png",sizeBytes:123,mimeType:"image/png",width:1440,height:2560};
  const product=f.run.canvasBinding!.nodes.find(n=>n.kind==="PRODUCT")!,setting=q.nodes.find((n:any)=>n.key==="SETTING"),video=q.nodes.find((n:any)=>n.key==="VIDEO");
  f.remote.get(product.nodeId).resources=[{resourceId:product.resourceId,type:"image",status:"success",source:"uploaded"}];
  f.remote.get(setting.nodeId).resources=[{resourceId:f.resourceId,submitId:image.submitId,type:"image",status:"success",source:"generated",creditsAmount:0}];
  const v=f.remote.get(video.nodeId);v.resources=[];v.upstreamNodeIds=[product.nodeId,setting.nodeId];v.generation.references.forEach((r:any)=>r.type="image");
  f.inject(args=>args[1]==="quote"?{ok:true,data:{draftVersion:7,confirmable:true,items:[{nodeId:video.nodeId,maxCredits:price}],totalMaxCredits:price},meta:{requestId:"bound-video-real-quote"}}:undefined);
  return {...f,product,setting,video,image};
}
test("bound video pricing requires exact explicit image adoption and binds both real resources without running",async t=>{
  const f=await boundVideoFixture(t),start=f.calls.length;
  await assert.rejects(quoteShortBoundVideo(f.service,f.run,f.plan,f.save),/USER_ADOPTION_REQUIRED/);
  await assert.rejects(adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,H,false,f.save),/EXPLICIT_ADOPTION/);
  await assert.rejects(adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,"b".repeat(64),true,f.save),/ADOPTION_CHANGED/);
  await adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,H,true,f.save);assert.equal(f.image.state,"ADOPTED");
  const reviewed=f.image.review.reviewedAt;await adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,H,true,f.save);assert.equal(f.image.review.reviewedAt,reviewed);
  const quote=await quoteShortBoundVideo(f.service,f.run,f.plan,f.save);assert.equal(quote.videoCredits,72);assert.equal(quote.totalCredits,72);assert.equal(quote.imageCredits,0);
  assert.equal(quote.references[0]!.resourceId,f.product.resourceId);assert.equal(quote.references[1]!.resourceId,f.resourceId);assert.equal(quote.videoGenerationAuthorized,false);
  assert.equal(f.plan.consent,undefined);assert.equal(f.plan.boundVideoQuotes.length,1);assert.equal(f.calls.slice(start).some(a=>["run","confirm","create","update"].includes(a[1]??"")),false);
});
test("bound video quote rejects changed remote outputs and reference order even when previous image was adopted",async t=>{
  const f=await boundVideoFixture(t);await adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,H,true,f.save);
  const resource=f.remote.get(f.setting.nodeId).resources[0];resource.resourceId=randomUUID();
  await assert.rejects(quoteShortBoundVideo(f.service,f.run,f.plan,f.save),/REMOTE_CHANGED/);resource.resourceId=f.resourceId;
  f.remote.get(f.video.nodeId).generation.references.reverse();await assert.rejects(quoteShortBoundVideo(f.service,f.run,f.plan,f.save),/REMOTE_CHANGED/);
  assert.equal(f.plan.boundVideoQuotes,undefined);
});
test("bound video total above 72 stops and quote history preserves every observation",async t=>{
  const f=await boundVideoFixture(t,73);await adoptShortReference(f.service,f.run,f.plan,f.revisionHash,f.image.artifact.id,H,true,f.save);
  const first=await quoteShortBoundVideo(f.service,f.run,f.plan,f.save);assert.equal(first.status,"OVER_BUDGET");assert.equal(first.totalCredits,73);
  await quoteShortBoundVideo(f.service,f.run,f.plan,f.save);assert.equal(f.plan.boundVideoQuotes.length,2);assert.equal(f.plan.boundVideoQuotes[0],first);assert.equal(f.plan.consent,undefined);
});

async function referenceQuoteFixture(t:test.TestContext,videoCredits:number|null){
  const f=await fixture(t),run=f.run,b=run.canvasBinding!,remote=new Map<string,any>();
  b.nodes=[{key:"PRODUCT",kind:"PRODUCT",nodeId:newCanvasNodeId(),resourceId:randomUUID(),sourceRequestHash:H,updateId:randomUUID(),submitId:randomUUID(),saved:true}];
  const product=b.nodes[0]!;remote.set(product.nodeId,{nodeId:product.nodeId,resources:[{resourceId:product.resourceId}]});
  const original={original:true,sourceScriptHash:H,sourcePlanHash:H};
  const payload={sourcePlanHash:hashValue(original),productReference:{artifactId:"original",sha256:H},draftVideoPrompt:"已审核单人动作，不变形"};
  const revisionHash=hashValue(payload),plan={id:"short",parentRunId:run.id,projectId:run.projectId,payload:original,contentHash:payload.sourcePlanHash,attemptIds:[],
    visualRevisions:[{id:"revision",contentHash:revisionHash,payload,designReview:{contentHash:revisionHash,scope:"TEXT_DESIGN_ONLY"}}]} as any;
  let injected:((args:string[])=>CanvasEnvelope|undefined)|undefined;
  f.override(args=>{
    const changed=injected?.(args);if(changed)return changed;
    const value=(flag:string)=>args[args.indexOf(flag)+1]!;
    if(args[0]==="model"){const image=args[2]==="seedream_5.0_lite";return {ok:true,data:{items:[{model:args[2],modes:[{name:image?"t2i":"m2v",flags:[{flag:"--ratio",values:["9:16"]},{flag:"--resolution",values:[image?"2K":"720p"]},{flag:"--duration",min:4,max:15}],references:{types:[{mediaType:"image",max:9}]}}]}]}};}
    if(args[1]==="show"){const ids=args.flatMap((a,i)=>a==="--node-id"?[args[i+1]!]:[]);return {ok:true,data:{draftVersion:7,nodes:ids.map(id=>remote.has(id)?{result:"FOUND",node:remote.get(id)}:{result:"NOT_FOUND"})}};}
    if(args[1]==="create"){const refs=args.flatMap((a,i)=>a==="--ref"?[{id:args[i+1]!.slice(5),kind:"node"}]:[]),g={mode:value("--mode"),prompt:value("--prompt"),model:value("--model"),ratio:value("--ratio"),resolution:value("--resolution"),outputCount:1,...(args.includes("--duration")?{durationSeconds:12,references:refs}:{})};
      const node={nodeId:value("--node-id"),generation:g};remote.set(node.nodeId,node);return {ok:true,data:{node}};}
    if(args[1]==="quote"){const items=plan.referenceQuote.nodes.map((n:any)=>n.key==="VIDEO"&&videoCredits===null?{nodeId:n.nodeId,error:{validation:{reasonCode:"REFERENCE_SOURCE_NO_OUTPUT"}}}:{nodeId:n.nodeId,maxCredits:n.key==="SETTING"?2:n.key==="VIDEO"?videoCredits:72});return {ok:true,data:{draftVersion:7,items,totalMaxCredits:items.reduce((sum:number,i:any)=>sum+(i.maxCredits??0),0),confirmable:videoCredits!==null},meta:{requestId:"real-quote-fixture"}};}
    return undefined;
  });
  let checkpoints=0;return {...f,plan,revisionHash,remote,inject:(fn:typeof injected)=>injected=fn,save:async()=>{checkpoints++;},checkpoints:()=>checkpoints};
}

async function zeroReferenceFixture(t:test.TestContext,price=0){
  const f=await referenceQuoteFixture(t,null);await quoteShortReferences(f.service,f.run,f.plan,f.revisionHash,"人物与书房同框，右前桌面留空",f.save);
  let unknown=false,bytes:Buffer|undefined;const resourceId=randomUUID();
  f.inject(args=>{
    if(args[1]==="quote"){const id=args[args.indexOf("--node-id")+1];return {ok:true,data:{draftVersion:7,confirmable:true,items:[{nodeId:id,maxCredits:price}],totalMaxCredits:price},meta:{requestId:"zero-image-live-quote"}};}
    if(args[1]==="confirm")return {ok:true,data:{creditConfirmationToken:"fixture-private-token",creditCeiling:0,expiresAt:new Date(Date.now()+60000).toISOString()}};
    if(args[1]==="run"){if(unknown)throw Error("response lost");return {ok:true,data:{items:[{nodeId:args[args.indexOf("--node-id")+1],submitId:args[args.indexOf("--submit-id")+1],state:"accepted",resources:[]}]},meta:{requestId:"single-image-submit"}};}
    if(args[0]==="operation")return {ok:true,data:{operationRef:args[2],state:"succeeded",resources:[{resourceId,state:"succeeded"}]},meta:{requestId:"single-image-status"}};
    if(args[0]==="resource"&&bytes){writeFileSync(args[args.indexOf("--output")+1]!,bytes);return {ok:true,data:{resourceId,sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length}};}
    return undefined;
  });
  const records=new Map<string,any>(),artifacts={async findById(id:string){return records.get(id)??null;},async createPending(i:any){const a={...i,integrityStatus:"PENDING",createdAt:new Date().toISOString()};records.set(i.id,a);return a;},async markReady(id:string,i:any){const a={...records.get(id),...i,integrityStatus:"READY"};records.set(id,a);return a;}} as unknown as ArtifactRepository;
  return {...f,resourceId,artifacts,records,unknown:()=>unknown=true,setBytes:(b:Buffer)=>bytes=b};
}
test("single reference image requires explicit consent and fresh zero price; changed price or count cannot run",async t=>{
  const f=await zeroReferenceFixture(t,1),q=f.plan.referenceQuote;
  await assert.rejects(generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,false,f.save),/EXPLICIT_ZERO_CONSENT/);
  await assert.rejects(generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save),/NO_LONGER_ZERO/);
  assert.equal(f.plan.referenceImage,undefined);assert.equal(f.calls.some(a=>a[1]==="confirm"||a[1]==="run"),false);
  const node=q.nodes.find((n:any)=>n.key==="SETTING");f.remote.get(node.nodeId).generation.outputCount=2;
  await assert.rejects(generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save),/NODE_CHANGED/);
});
test("single zero reference grant runs only the setting node once and never grants video or stores the token",async t=>{
  const f=await zeroReferenceFixture(t),q=f.plan.referenceQuote;
  const result=await generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save);
  assert.equal(result.state,"ACCEPTED");assert.equal(result.creditCeiling,0);assert.equal(result.count,1);assert.equal(f.plan.consent,undefined);assert.equal(f.plan.paidScope,undefined);
  const calls=f.calls.filter(a=>a[1]==="run");assert.equal(calls.length,1);assert.equal(calls[0]![calls[0]!.indexOf("--node-id")+1],q.nodes.find((n:any)=>n.key==="SETTING").nodeId);
  assert.ok(!JSON.stringify(f.plan).includes("fixture-private-token"));
  await generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save);assert.equal(f.calls.filter(a=>a[1]==="run").length,1);
});
test("uncertain reference image submission retains original submit and cannot auto repeat",async t=>{
  const f=await zeroReferenceFixture(t),q=f.plan.referenceQuote;f.unknown();
  await assert.rejects(generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save),/RECONCILE_ORIGINAL/);
  const submit=f.plan.referenceImage.submitId;assert.equal(f.plan.referenceImage.state,"UNKNOWN");
  await generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save);
  assert.equal(f.plan.referenceImage.submitId,submit);assert.equal(f.calls.filter(a=>a[1]==="run").length,1);
});
test("reference image recovery downloads original submission as an immutable unadopted image without confirm/run",async t=>{
  const f=await zeroReferenceFixture(t),q=f.plan.referenceQuote;await generateZeroShortReference(f.service,f.run,f.plan,f.revisionHash,q.requestHash,true,f.save);
  const sample=path.join(path.dirname(f.config.executablePath),"reference-fixture.png");
  await promisify(execFile)("ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=teal:s=1152x2048","-frames:v","1","-threads","1",sample],{windowsHide:true,timeout:30000});
  f.setBytes(await fs.readFile(sample));const count=f.calls.length,root=path.dirname(f.config.executablePath);
  const image=await syncShortReference(f.service,f.run,f.plan,f.artifacts,root,f.save);
  assert.equal(image.state,"NEEDS_REVIEW");assert.equal(image.artifact!.width,1152);assert.equal(image.artifact!.height,2048);assert.equal(f.records.size,1);
  assert.equal(f.calls.slice(count).some(a=>a[1]==="confirm"||a[1]==="run"),false);assert.equal(f.plan.referenceImage.humanConfirmedAt,undefined);
  const downloads=f.calls.filter(a=>a[0]==="resource").length;await syncShortReference(f.service,f.run,f.plan,f.artifacts,root,f.save);
  assert.equal(f.calls.filter(a=>a[0]==="resource").length,downloads);
});

test("new references quote keeps missing video cost unknown and comparison outside total; no run or approval",async t=>{
  const f=await referenceQuoteFixture(t,null),receipt=await quoteShortReferences(f.service,f.run,f.plan,f.revisionHash,"单人书房同框，桌面右前留空",f.save);
  assert.equal(receipt.totalCredits,null);assert.equal(receipt.status,"INCOMPLETE");assert.equal(receipt.items?.find(i=>i.key==="VIDEO")?.error,"REFERENCE_SOURCE_NO_OUTPUT");
  assert.equal(receipt.items?.find(i=>i.key==="PRODUCT_ONLY_COMPARISON")?.credits,72);assert.equal(f.plan.feeQuote,undefined);assert.equal(f.plan.paidScope,undefined);
  assert.ok(f.checkpoints()>=4);assert.equal(f.calls.some(a=>["confirm","run"].includes(a[1]??"")),false);
  const creates=f.calls.filter(a=>a[1]==="create").length;await quoteShortReferences(f.service,f.run,f.plan,f.revisionHash,"单人书房同框，桌面右前留空",f.save);
  assert.equal(f.calls.filter(a=>a[1]==="create").length,creates);
});
test("new references enforce combined 72 credit ceiling and exact reviewed hash",async t=>{
  const f=await referenceQuoteFixture(t,72);await assert.rejects(quoteShortReferences(f.service,f.run,f.plan,H,"同框",f.save),/REVIEW_OR_SOURCE/);
  const receipt=await quoteShortReferences(f.service,f.run,f.plan,f.revisionHash,"同框",f.save);assert.equal(receipt.totalCredits,74);assert.equal(receipt.status,"OVER_BUDGET");
  await assert.rejects(quoteShortReferences(f.service,f.run,f.plan,f.revisionHash,"更换提示词",f.save),/DRAFT_CHANGED/);
});

const H="a".repeat(64),uid=17,account=createHash("sha256").update("jimeng:"+uid).digest("hex");
function originalRun(){
  const entries=["DAUGHTER","FATHER","LIVING_ROOM"].map((key,n)=>({key,label:key,kind:n===2?"SET":"CHARACTER",source:"DREAMINA_GENERATED",status:"PLANNED",
    generationPrompt:"原创设定 "+key,generationRequestHash:hashValue(key),sourceReferenceAssetIds:[]}));
  return {id:"original-run",projectId:"original-project",revision:1,status:"ASSET_PREPARING",stage:"ASSET_PREP",script:{contentHash:H},
    productionStrategy:{contentHash:H},productionAssetSet:{contentHash:H,entries},productionPlan:{contentHash:H,
      generationTarget:{requestedModelVersion:"seedance2.0_vip",aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:true},
      scenes:[{clips:[6,8,9,11,10,9].map((seconds,n)=>({id:"C"+(n+1),order:n+1,durationMs:seconds*1000,referenceAssets:[]}))}]},
    attemptIds:[],notes:[],workspaceContinuation:{sourceArtifactHash:H}} as unknown as SmartGenerationRun;
}
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-canvas-test-")),exe=path.join(root,"official-fixture.exe");
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(exe,"fixture-binary");
  const config:CanvasRuntimeConfig={executablePath:exe,executableSha256:createHash("sha256").update("fixture-binary").digest("hex"),profile:"test-profile",
    expectedAccountFingerprint:account,imageModel:"seedream_5.0_lite",videoModel:"seedance_2.0_vip",modelApprovalSource:"USER_CONFIRMED_5_0_LITE",officialSourceUrl:"https://jimeng.jianying.com/canvas-cli/install.ps1"};
  const run=originalRun(),request=buildProductionQuoteRequest(run),calls:string[][]=[],events:string[]=[],saved:any[]=[];
  const generation={mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1};
  const binding:CanvasProductionBinding={runtime:"DREAMINA_CANVAS",projectId:randomUUID(),runId:run.id,scopeHash:request.scopeHash,
    profile:config.profile,accountFingerprint:account,modelApprovalSource:config.modelApprovalSource,executableSha256:config.executableSha256,created:true,checkedAt:new Date().toISOString(),draftVersion:10,
    nodes:request.items.map(i=>({key:i.key,kind:i.kind,nodeId:newCanvasNodeId(),updateId:randomUUID(),submitId:randomUUID(),sourceRequestHash:i.sourceRequestHash,
      saved:true,canonicalModel:i.kind==="IMAGE"?config.imageModel:config.videoModel,generationHash:canvasGenerationHash(generation)}))};
  run.canvasBinding=binding;
  let override:((args:string[])=>CanvasEnvelope|undefined)|undefined;
  const runtime=new DreaminaCanvasRuntime(config,async(_exe,args)=>{
    calls.push(args);events.push(args.slice(0,2).join("."));const changed=override?.(args);if(changed)return changed;
    const ids=args.flatMap((arg,n)=>arg==="--node-id"?[args[n+1]!]:[]);
    if(args[0]==="auth")return {ok:true,data:{userId:uid,isVip:true}};
    if(args[0]==="model")return {ok:true,data:{items:[]}};
    if(args[1]==="show")return {ok:true,data:{draftVersion:10,nodes:binding.nodes.map(n=>({result:"FOUND",node:{nodeId:n.nodeId,generation}}))}};
    if(args[1]==="quote")return {ok:true,data:{items:ids.map(nodeId=>({nodeId,maxCredits:10})),totalMaxCredits:ids.length*10,draftVersion:10,confirmable:true},meta:{requestId:"quote-request"}};
    if(args[1]==="confirm")return {ok:true,data:{creditConfirmationToken:"in-memory-secret",creditCeiling:10,expiresAt:new Date(Date.now()+60000).toISOString()}};
    if(args[1]==="run")return {ok:true,data:{items:[{nodeId:ids[0],submitId:args[args.indexOf("--submit-id")+1],state:"accepted",resources:[]}]}};
    throw Error("Unexpected fixture command "+args.slice(0,2).join(" "));
  });
  run.feeQuote=await new ProductionQuoteService({quote:async({item,requestHash})=>{const node=binding.nodes.find(n=>n.key===item.key)!;
    return {status:"QUOTED",kind:"CREDIT_CEILING",requestHash,sourceRequestId:"quote-request",accountFingerprint:account,currency:"CREDITS",credits:10,
      issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),sourceUrl:config.officialSourceUrl,pricingParametersSufficient:false,validityBasis:"REVALIDATE_DRAFT",
      canvas:{projectId:binding.projectId,nodeId:node.nodeId,draftVersion:10,generationHash:node.generationHash!,canonicalModel:node.canonicalModel!}};}}).quote(request);
  const assets=request.items.filter(i=>i.kind==="IMAGE").map(i=>({key:i.key,requestHash:i.sourceRequestHash,costStatus:"KNOWN" as const,estimatedCredits:10}));
  run.assetPaidScope={strategyHash:H,assets,preparedAt:new Date().toISOString(),hash:hashValue({strategyHash:H,assets})};
  const consent=()=>run.assetConsent={scopeHash:run.assetPaidScope!.hash,approvedAt:new Date().toISOString(),acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_ASSET_PAID_CONFIRMATION"};
  const checkpoint=async(b:CanvasProductionBinding)=>{events.push("checkpoint:"+b.nodes[0]?.execution?.state);saved.push(structuredClone(b));};
  return {service:new CanvasProductionService(runtime),runtime,config,run,binding,calls,events,saved,consent,checkpoint,override:(fn:typeof override)=>override=fn};
}

test("new node IDs satisfy the installed release Crockford contract",()=>{
  const ids=Array.from({length:1000},newCanvasNodeId);assert.equal(new Set(ids).size,1000);assert.ok(ids.every(isCanvasNodeId));
  for(const id of ["node_391327e8149b46f294624ff37eeac15d","node_IIIIIIIIII","node_abcdefghiu"])assert.equal(isCanvasNodeId(id),false);
});
test("partial server quote keeps real zero image ceilings and does not make a zero grand total",async()=>{
  const request=buildProductionQuoteRequest(originalRun()),ids=request.items.map((_,n)=>"n"+n);
  const data={items:ids.map((nodeId,n)=>n<3?{nodeId,maxCredits:0}:{nodeId,error:{validation:{reasonCode:"REFERENCE_SOURCE_NO_OUTPUT"}}}),totalMaxCredits:0,draftVersion:10,confirmable:false};
  const observed=validateCanvasQuote(data,ids,10);assert.equal(observed.items.length,9);assert.equal(observed.confirmable,false);
  const q=await new ProductionQuoteService({quote:async({item,requestHash})=>item.kind==="VIDEO"?{status:"UNAVAILABLE",code:"REFERENCE_SOURCE_NO_OUTPUT",message:"参考图未生成，缺少按待生成参考规格核价的接口"}:
    {status:"QUOTED",kind:"CREDIT_CEILING",requestHash,providerQuoteId:"fixture",accountFingerprint:account,currency:"CREDITS",credits:0,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),sourceUrl:"https://example.invalid",pricingParametersSufficient:true}}).quote(request);
  assert.equal(q.status,"UNAVAILABLE");assert.deepEqual(q.totals,[]);assert.equal(q.grandTotal,undefined);
  const original=originalRun();original.feeQuote=q;assert.throws(()=>assertCurrentQuote(original,"IMAGE"),/参考图未生成/);
  const html=renderProductionQuote(q);assert.equal((html.match(/最高0积分/g)??[]).length,3);assert.match(html,/总费用：待核实/);assert.doesNotMatch(html,/总费用：最高0/);
});
for(const change of ["missing","duplicate","changedDraft","wrongTotal","negative","silentUnconfirmable","diff"]){
  test("authoritative quote rejects "+change,()=>{
    const data:any={items:[{nodeId:"a",maxCredits:10},{nodeId:"b",maxCredits:20}],totalMaxCredits:30,draftVersion:10,confirmable:true};
    if(change==="missing")data.items.pop();if(change==="duplicate")data.items[1].nodeId="a";if(change==="changedDraft")data.draftVersion++;
    if(change==="wrongTotal")data.totalMaxCredits=0;if(change==="negative")data.items[0].maxCredits=-1;
    if(change==="silentUnconfirmable")data.confirmable=false;if(change==="diff")data.items[0].generationDiff=[{fieldPath:"model"}];
    assert.throws(()=>validateCanvasQuote(data,["a","b"],10));
  });
}
test("runtime forbids confirm/run and combined generation without a spend grant",async t=>{
  const f=await fixture(t);for(const args of [["node","confirm"],["node","run"],["node","create","image","--run"],["node","edit","video","--yes"]])await assert.rejects(f.runtime.call(args),/PAID_ACTION_NOT_AUTHORIZED/);
  assert.equal(f.calls.length,0);
});
test("identity pins executable bytes and authenticated actor",async t=>{
  const f=await fixture(t);f.override(args=>args[0]==="auth"?{ok:true,data:{userId:uid+1}}:undefined);await assert.rejects(f.runtime.assertAccount(),/ACCOUNT_MISMATCH/);
  await fs.writeFile(f.config.executablePath,"changed");await assert.rejects(f.runtime.assertAccount(),/EXECUTABLE_CHANGED/);
});
test("ambiguous model discovery never picks the first matching model",async t=>{
  const f=await fixture(t);f.override(args=>args[0]==="model"?{ok:true,data:{items:[{model:"seedream_5.0_lite",aliases:["5.0"]},{model:"seedream_5.0_pro",aliases:["5.0"]}]}}:undefined);
  await assert.rejects(f.runtime.findModel("5.0","image"),/MODEL_NOT_UNAMBIGUOUS/);
});
test("full quotation and draft authorization cannot manufacture consent, including a free result",async t=>{
  const f=await fixture(t);await assert.rejects(f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint),/PAID_ACTION_NOT_AUTHORIZED/);assert.equal(f.calls.length,0);
});
test("quote content upload refuses unapproved projects/content before remote saves",async t=>{
  const f=await fixture(t);await assert.rejects(f.service.quote(f.run,{truth:{} as any,product:{path:"do-not-read",sha256:H}},f.checkpoint),/DRAFT_TRANSFER_NOT_AUTHORIZED/);
  assert.deepEqual(f.calls.map(a=>a.slice(0,2).join(".")),["auth.account"]);assert.equal(f.saved.length,0);
});
test("node references must remain linked sources, not just matching thumbnails",async t=>{
  const f=await fixture(t);f.override(args=>args[1]==="show"?{ok:true,data:{draftVersion:10,nodes:f.binding.nodes.map(n=>({result:"FOUND",node:{nodeId:n.nodeId,generation:{mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1,references:[{kind:"node",id:f.binding.nodes[1]!.nodeId}]},upstreamNodeIds:[]}}))}}:undefined);
  const changed=canvasGenerationHash({mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1,references:[{id:f.binding.nodes[1]!.nodeId}]});
  f.binding.nodes.forEach(n=>n.generationHash=changed);
  await assert.rejects(f.service.inspectBoundNodes(f.binding),/BOUND_REFERENCE_OR_LINK_CHANGED/);
});
for(const change of ["nodeEdit","account","priceRise","missingReference","badScope","expired","wrongBinding"]){
  test("spend preflight blocks "+change+" before confirm or run",async t=>{
    const f=await fixture(t);f.consent();
    if(change==="nodeEdit")f.binding.nodes[0]!.generationHash="b".repeat(64);
    if(change==="account")f.config.expectedAccountFingerprint="b".repeat(64);
    if(change==="badScope")f.run.assetPaidScope!.assets[0]!.estimatedCredits=999;
    if(change==="expired")f.run.feeQuote!.expiresAt=new Date(Date.now()-1000).toISOString();
    if(change==="wrongBinding")f.binding.projectId=randomUUID();
    if(change==="priceRise"||change==="missingReference")f.override(args=>args[1]==="quote"?{ok:true,data:{draftVersion:10,confirmable:change==="priceRise",items:f.binding.nodes.filter(n=>n.kind==="IMAGE").map(n=>change==="priceRise"?{nodeId:n.nodeId,maxCredits:11}:{nodeId:n.nodeId,error:{validation:{reasonCode:"REFERENCE_SOURCE_NO_OUTPUT"}}}),totalMaxCredits:change==="priceRise"?33:0}}:undefined);
    await assert.rejects(f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint));assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
  });
}
test("approved execution checkpoints ceiling and stable submit identity; token never persists",async t=>{
  const f=await fixture(t);f.consent();const result=await f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint);
  assert.equal(result.submitId,f.binding.nodes[0]!.submitId);assert.equal(result.state,"ACCEPTED");
  assert.ok(f.events.indexOf("checkpoint:PREPARED")<f.events.indexOf("node.confirm"));
  assert.ok(f.events.indexOf("checkpoint:DISPATCHING")<f.events.indexOf("node.run"));
  assert.doesNotMatch(JSON.stringify(f.saved),/in-memory-secret|creditConfirmationToken/);
  const calls=f.calls.length;const replay=await f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint);assert.equal(replay.recovered,true);assert.equal(f.calls.length,calls);
});
test("lost run receipt is unknown and cannot be automatically resubmitted",async t=>{
  const f=await fixture(t);f.consent();f.override(args=>{if(args[1]==="run")throw Error("transport lost");return undefined;});
  await assert.rejects(f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint),/提交结果未知/);assert.equal(f.binding.nodes[0]!.execution!.state,"UNKNOWN");
  const calls=f.calls.length;await f.service.submitAuthorizedNode(f.run,"DAUGHTER",f.checkpoint);assert.equal(f.calls.length,calls);
});
test("failed native refresh invalidates old known prices on the original task",async()=>{
  let current=originalRun();current.status="READY_FOR_ASSET_PAID_CONFIRM";current.assetPaidScope={strategyHash:H,assets:[{key:"DAUGHTER",requestHash:hashValue("DAUGHTER"),costStatus:"KNOWN",estimatedCredits:10}],hash:H,preparedAt:new Date().toISOString()};
  const repo={async acquire(){return true;},async release(){},async get(){return structuredClone(current);},async save(run:SmartGenerationRun,revision:number){assert.equal(revision,current.revision);current={...run,revision:revision+1};return structuredClone(current);}} as unknown as SmartRunRepository;
  const production={async assertCurrent(){},async quoteCurrent(){throw Object.assign(Error("private upstream details"),{code:"ACCOUNT_MISMATCH"});}} as unknown as SmartProduction;
  const result=await new SmartGenerationService(repo,production).quoteCurrent(current.projectId,current.id,1);
  assert.equal(result.status,"UNAVAILABLE");assert.equal(current.id,"original-run");assert.ok(current.assetPaidScope!.assets.every(a=>a.costStatus==="UNKNOWN"));
  assert.equal(current.assetConsent,undefined);assert.equal(current.consent,undefined);assert.equal(result.canRequestPaidConfirmation,false);assert.doesNotMatch(JSON.stringify(result),/private upstream details/);
});

async function zeroImageFixture(t:test.TestContext){
  const f=await fixture(t);let current=structuredClone(f.run);current.status="READY_FOR_ASSET_PAID_CONFIRM";
  const repo={async acquire(){return true;},async release(){},async get(){return structuredClone(current);},async save(run:SmartGenerationRun,revision:number){assert.equal(revision,current.revision);current={...run,revision:revision+1};return structuredClone(current);}} as unknown as SmartRunRepository;
  const production={async assertCurrent(){},quoteCanvasImages:async(run:SmartGenerationRun)=>f.service.quoteSaved(run,"IMAGE"),validateAssetPaidScope:async(run:SmartGenerationRun)=>{await f.service.validateBudget(run,"IMAGE");}} as unknown as SmartProduction;
  let price=0;
  f.override(args=>{const ids=args.flatMap((a,n)=>a==="--node-id"?[args[n+1]!]:[]);
    if(args[1]==="quote")return {ok:true,data:{draftVersion:10,confirmable:true,items:ids.map(nodeId=>({nodeId,maxCredits:price})),totalMaxCredits:ids.length*price},meta:{requestId:"zero-image-price"}};
    if(args[1]==="confirm")return {ok:true,data:{creditConfirmationToken:"zero-ceiling-secret",creditCeiling:0,expiresAt:new Date(Date.now()+60000).toISOString()}};
    return undefined;});
  return {...f,smart:new SmartGenerationService(repo,production),current:()=>current,price:(p:number)=>price=p};
}
test("explicit three-image zero ceiling is independent from unpaid downstream video quotation",async t=>{
  const f=await zeroImageFixture(t);
  const preview=await f.smart.previewZeroCanvasImages(f.run.projectId,f.run.id,1);
  assert.equal(preview.images.length,3);assert.equal(preview.creditCeiling,0);assert.equal(preview.videoGenerationAuthorized,false);assert.equal(f.current().assetConsent,undefined);
  const authorized=await f.smart.authorizeZeroCanvasImages(f.run.projectId,f.run.id,{expectedRevision:1,creditCeiling:0,confirmed:true});
  assert.equal(authorized.assetConsent?.scopeHash,authorized.assetPaidScope?.hash);assert.equal(authorized.consent,undefined);
  assert.equal(authorized.canvasBinding?.imageBudgetGrant?.creditCeiling,0);assert.ok(authorized.assetPaidScope!.assets.every(a=>a.estimatedCredits===0));
  const executed=await f.service.submitAuthorizedNode(authorized,"DAUGHTER",f.checkpoint);assert.equal(executed.state,"ACCEPTED");
  const confirms=f.calls.filter(a=>a[1]==="confirm");assert.equal(confirms.length,1);assert.equal(confirms[0]![confirms[0]!.indexOf("--credit-ceiling")+1],"0");
  await assert.rejects(f.service.submitAuthorizedNode(authorized,"C1",f.checkpoint),/PAID_ACTION_NOT_AUTHORIZED/);
  assert.equal(f.calls.filter(a=>a[1]==="run").length,1);assert.doesNotMatch(JSON.stringify(f.saved),/zero-ceiling-secret/);
});
test("one credit price rise after preview stops before saving any generation grant",async t=>{
  const f=await zeroImageFixture(t);await f.smart.previewZeroCanvasImages(f.run.projectId,f.run.id,1);f.price(1);
  await assert.rejects(f.smart.authorizeZeroCanvasImages(f.run.projectId,f.run.id,{expectedRevision:1,creditCeiling:0,confirmed:true}),/不是0积分/);
  assert.equal(f.current().revision,1);assert.equal(f.current().assetConsent,undefined);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});
test("zero-price confirmation still requires explicit user permission",async t=>{
  const f=await zeroImageFixture(t);await assert.rejects(f.smart.authorizeZeroCanvasImages(f.run.projectId,f.run.id,{expectedRevision:1,creditCeiling:0,confirmed:false}),/用户明确授权/);assert.equal(f.calls.length,0);
});
test("post-authorization price change cannot exceed the zero ceiling",async t=>{
  const f=await zeroImageFixture(t),authorized=await f.smart.authorizeZeroCanvasImages(f.run.projectId,f.run.id,{expectedRevision:1,creditCeiling:0,confirmed:true});f.price(1);
  await assert.rejects(f.service.submitAuthorizedNode(authorized,"DAUGHTER",f.checkpoint),/BUDGET_REQUOTE_REQUIRED/);assert.equal(f.saved.length,0);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});
test("recovery queries original accepted submissions without confirm/run or new identities",async t=>{
  const f=await zeroImageFixture(t),run=await f.smart.authorizeZeroCanvasImages(f.run.projectId,f.run.id,{expectedRevision:1,creditCeiling:0,confirmed:true});
  const now=new Date().toISOString(),set=run.productionAssetSet!;
  Object.assign(set,{id:"set",projectId:run.projectId,version:1,strategyRef:{entityType:"ProductionStrategy",entityId:"strategy",version:1,hash:H},selectedCreativeId:"creative",status:"PREPARING",createdAt:now,updatedAt:now});
  for(const entry of set.entries)Object.assign(entry,{referenceAssetId:"asset-"+entry.key,description:"设定",purpose:"一致性",required:true,reuseScope:"MULTI_CLIP",artifactIds:[],dependsOnAssetKeys:[],identityLock:[],status:"SUBMISSION_UNKNOWN"});
  for(const node of run.canvasBinding!.nodes.filter(n=>n.kind==="IMAGE"))node.execution={scopeHash:run.assetPaidScope!.hash,authorizedCeiling:0,state:"UNKNOWN",resources:[],updatedAt:now};
  f.override(args=>args[0]==="operation"?{ok:true,data:{operationRef:args[2],state:"succeeded",resources:[{resourceId:randomUUID(),state:"succeeded"}],submission:{state:"completed",adviceCode:"submission_accepted",resubmittable:false}}}:undefined);
  const result=await f.service.recoverImages(run,f.checkpoint);assert.ok(result.entries.every(e=>e.status==="SUBMITTED"));
  assert.ok(result.entries.every(e=>e.submitId===run.canvasBinding!.nodes.find(n=>n.key===e.key)!.submitId));
  assert.equal(f.calls.filter(a=>a[0]==="operation").length,3);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});

async function videoFixture(t:test.TestContext,hasAudio=true,realMedia=false){
  const f=await fixture(t),root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-canvas-video-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const run=f.run,node=run.canvasBinding!.nodes.find(n=>n.kind==="VIDEO")!,resourceId=randomUUID();
  run.consent={scopeHash:H,approvedAt:new Date().toISOString(),acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"};
  run.paidScope={hash:H,requests:[{clipId:node.key,requestId:"request-1",requestHash:H}]} as any;
  node.execution={scopeHash:H,authorizedCeiling:10,state:"ACCEPTED",resources:[resourceId],updatedAt:new Date().toISOString()};
  const request={...makeRequest(),provider:"dreamina-canvas" as const,projectId:run.projectId,clipId:node.key,requestHash:H,durationMs:6000},approval={...makeApproval(),projectId:run.projectId,requestHash:H};
  let attempt={...makeAttempt(),status:"SUBMITTED" as any,projectId:run.projectId,clipId:node.key,requestHash:H,providerHandle:{submitId:node.submitId}};
  run.attemptIds=[attempt.id];const records=new Map<string,any>();
  const artifacts={async createPending(input:any){const a={...input,integrityStatus:"PENDING",createdAt:new Date().toISOString()};records.set(a.id,a);return a;},async markReady(id:string,fields:any){const a={...records.get(id),...fields,integrityStatus:"READY"};records.set(id,a);return a;},async findById(id:string){return records.get(id)??null;}} as unknown as ArtifactRepository;
  const generation={async getGenerationRequest(){return request;},async getUserApproval(){return approval;}} as unknown as GenerationRepository;
  const workflow={async listGenerationAttempts(){return [attempt];},async updateGenerationAttemptStatus(_id:string,patch:any){attempt={...attempt,...patch};return attempt;}} as unknown as WorkflowRepository;
  f.override(args=>args[0]==="operation"?{ok:true,data:{operationRef:node.submitId,state:"succeeded",resources:[{resourceId,state:"succeeded"}],submission:{adviceCode:"submission_accepted"}}}:
    args[0]==="resource"?{ok:true,data:{resourceId,type:"video",status:"success"}}:undefined);
  let downloads=0,badHash=false;let media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(24)]);
  if(realMedia){const file=path.join(root,"local-codec-sample.mp4");await promisify(execFile)("ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=90x160:r=6","-f","lavfi","-i","anullsrc=r=16000:cl=mono","-t","6","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac","-shortest",file],{windowsHide:true,timeout:30000});media=await fs.readFile(file);}
  const port={async readiness(){return {ready:true};},async download(input:any){downloads++;await fs.writeFile(input.outputPath,media);return {path:input.outputPath,sha256:badHash?H:createHash("sha256").update(media).digest("hex"),sizeBytes:media.length};}};
  const service=new CanvasVideoResultService(f.service,port,artifacts,generation,workflow,root,realMedia?inspectMedia:async()=>({durationMs:6000,width:720,height:1280,hasVideo:true,hasAudio}));
  return {...f,run,node,records,service,root,media,downloads:()=>downloads,corrupt:()=>badHash=true,restoreAudio:()=>hasAudio=true,attempt:()=>attempt};
}
test("Canvas video delivery persists the original artifact and reuses the original review/attempt record",async t=>{
  const f=await videoFixture(t),out=await f.service.sync(f.run,f.node.key,f.checkpoint);
  assert.equal(out.status,"SUCCEEDED");assert.ok(out.outputArtifactId);assert.equal(f.node.delivery!.state,"NEEDS_REVIEW");
  assert.equal(f.run.consent!.scopeHash,H);assert.equal(f.run.attemptIds.length,1);assert.equal(f.downloads(),1);
  const replay=await f.service.sync(f.run,f.node.key,f.checkpoint);assert.equal(replay.outputArtifactId,out.outputArtifactId);assert.equal(f.downloads(),1);
  assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});
test("local real MP4 passes file SHA, ffprobe duration, ratio and audio checks before human review",async t=>{
  const f=await videoFixture(t,true,true),out=await f.service.sync(f.run,f.node.key,f.checkpoint);
  assert.equal(out.status,"SUCCEEDED");assert.equal(f.node.delivery!.state,"NEEDS_REVIEW");assert.equal(f.node.delivery!.width,90);assert.equal(f.node.delivery!.height,160);assert.equal(f.node.delivery!.hasAudio,true);
  assert.ok(Math.abs(f.node.delivery!.durationMs!-6000)<500);assert.equal(f.node.delivery!.sha256,createHash("sha256").update(f.media).digest("hex"));
});
test("missing native audio blocks acceptance but preserves the paid video artifact",async t=>{
  const f=await videoFixture(t,false),out=await f.service.sync(f.run,f.node.key,f.checkpoint);
  assert.equal(out.status,"FAILED");assert.ok(out.outputArtifactId);assert.equal(f.node.delivery!.state,"QC_FAILED");
  const artifact=f.records.get(out.outputArtifactId!);assert.equal(artifact.integrityStatus,"READY");
  assert.deepEqual(await fs.readFile(path.join(f.root,f.run.projectId,artifact.relativePath)),f.media);assert.match(out.errorMessage!,/没有音轨/);
});
test("media QC can retry the same stored original without another download or paid submission",async t=>{
  const f=await videoFixture(t,false);assert.equal((await f.service.sync(f.run,f.node.key,f.checkpoint)).status,"FAILED");
  f.restoreAudio();assert.equal((await f.service.sync(f.run,f.node.key,f.checkpoint)).status,"SUCCEEDED");assert.equal(f.downloads(),1);
  assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});
test("corrupt downloader result never enters the artifact or review pipeline",async t=>{
  const f=await videoFixture(t);f.corrupt();await assert.rejects(f.service.sync(f.run,f.node.key,f.checkpoint),/INTEGRITY_FAILED/);
  assert.equal(f.records.size,0);assert.equal(f.attempt().outputArtifactId,undefined);
});
test("unapproved video cannot be downloaded through a fabricated current task",async t=>{
  const f=await videoFixture(t);f.run.consent=undefined;await assert.rejects(f.service.sync(f.run,f.node.key,f.checkpoint),/NO_AUTHORIZED_ORIGINAL_SUBMISSION/);assert.equal(f.downloads(),0);assert.equal(f.calls.length,0);
});
test("unregistered video MCP is an explicit capability gap rather than a fallback to another account",async()=>{
  const result=await new CanvasVideoDownloadMcp("").readiness(account);assert.equal(result.ready,false);assert.equal(result.code,"VIDEO_DOWNLOAD_MCP_NOT_REGISTERED");assert.match(result.message!,/独立实测/);
});
for(const mismatch of ["account","writeTool"]){
  test("video MCP rejects "+mismatch+" before requesting files",async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-delivery-mcp-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const config=path.join(root,"config.json");
    await fs.writeFile(config,JSON.stringify({contract:"pvs-canvas-video-download-v1",endpoint:"http://127.0.0.1:8765/mcp",accountFingerprint:mismatch==="account"?"b".repeat(64):account,capabilityTool:"info",downloadTool:"download"}));
    let calls=0;const fetcher=(async()=>{calls++;return new Response(JSON.stringify({result:{tools:[{name:"info",annotations:{readOnlyHint:true}},{name:"download",annotations:{readOnlyHint:false}}]}}),{status:200});}) as typeof fetch;
    const result=await new CanvasVideoDownloadMcp(config,fetcher).readiness(account);assert.equal(result.ready,false);assert.equal(calls,mismatch==="account"?0:1);
  });
}

async function nativePreflightFixture(t:test.TestContext){
  const f=await fixture(t),run=f.run,b=run.canvasBinding!;
  Object.assign(run.script!,{id:"script",version:7,selectedCreativeId:"creative",status:"CONFIRMED"});
  Object.assign(run.productionPlan!,{id:"plan",version:1,status:"CONFIRMED"});
  Object.assign(run.productionAssetSet!,{id:"set",version:1});
  run.productionPlan!.scenes.flatMap(s=>s.clips).forEach(c=>c.contentHash=H);
  run.creativeBatch={id:"creative-batch",version:2,contentHash:H} as any;
  run.truthRef={entityType:"ProductTruth",entityId:"truth",version:1,hash:H};run.selectedCreativeId="creative";
  b.sourceScriptHash=H;b.sourcePlanHash=H;b.originalQuoteRequest={contract:run.feeQuote!.contract,projectId:run.projectId,runId:run.id,scopeHash:b.scopeHash,items:run.feeQuote!.items.map(i=>i.request)};
  const model={model:f.config.videoModel,modes:[{name:"m2v",flags:[{flag:"--duration",min:4,max:15},{flag:"--resolution",values:["720p"]}]}]};
  const generation=(key:string)=>({mode:"m2v",prompt:"父女漫剧情节植入产品，不编功效",model:f.config.videoModel,ratio:"9:16",resolution:"720p",outputCount:1,
    durationSeconds:run.productionPlan!.scenes.flatMap(s=>s.clips).find(c=>c.id===key)!.durationMs/1000,references:[]});
  for(const n of b.nodes.filter(n=>n.kind==="VIDEO"))n.generationHash=canvasGenerationHash(generation(n.key));
  run.feeQuote!.items.forEach(i=>{if(i.result.status==="QUOTED")i.result.canvas!.generationHash=b.nodes.find(n=>n.key===i.request.key)!.generationHash!;});
  f.override(args=>args[0]==="model"?{ok:true,data:{items:[model]}}:args[1]==="show"?{ok:true,data:{draftVersion:10,nodes:b.nodes.map(n=>({result:"FOUND",node:{nodeId:n.nodeId,
    generation:n.kind==="VIDEO"?generation(n.key):{mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1}}}))}}:undefined);
  let stored:any,delivery=true;
  const repo={async listCompiledPrompts(){return [];},async replacePreflightChain(chain:any){stored=structuredClone(chain);},
    async listCurrentGenerationRequests(){return stored?.requests??[];},async getPreflightReport(id:string){return stored?.reports.find((p:any)=>p.id===id)??null;}} as unknown as GenerationRepository;
  const service=new CanvasVideoPreflightService(f.service,repo,{} as ArtifactRepository,"unused",async()=>delivery?{ready:true}:{ready:false,code:"VIDEO_DOWNLOAD_MCP_NOT_REGISTERED"});
  return {...f,canvasService:f.service,service,stored:()=>stored,delivery:(ready:boolean)=>delivery=ready};
}

test("native Canvas preflight builds and atomically binds all six requests without legacy provider calls or spending",async t=>{
  const f=await nativePreflightFixture(t),scope=await f.service.prepare(f.run);f.run.paidScope=scope;
  assert.equal(scope.requests.length,6);assert.equal(f.stored().requests.length,6);
  for(const r of f.stored().requests){assert.equal(r.provider,"dreamina-canvas");assert.equal(r.canvasBinding.runId,f.run.id);assert.equal(r.model,"seedance_2.0_vip");}
  await f.service.validate(f.run);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));assert.equal(f.run.consent,undefined);
});

test("native Canvas missing real downloader blocks prepare and leaves prior requests unchanged",async t=>{
  const f=await nativePreflightFixture(t);f.delivery(false);const inspected=await f.service.inspect(f.run);
  assert.equal(inspected.chain.requests.length,6);assert.equal(inspected.ready,false);assert.deepEqual(inspected.blockers,["VIDEO_DOWNLOAD_MCP_NOT_REGISTERED"]);
  assert.ok(inspected.chain.reports.every(p=>p.status==="BLOCKED"));
  await assert.rejects(f.service.prepare(f.run),/VIDEO_DOWNLOAD_MCP_NOT_REGISTERED/);assert.equal(f.stored(),undefined);
});
test("a draft production plan cannot report ready or become a paid Canvas request",async t=>{
  const f=await nativePreflightFixture(t);f.run.productionPlan!.status="DRAFT";
  const inspected=await f.service.inspect(f.run);assert.equal(inspected.ready,false);assert.ok(inspected.blockers.includes("PLAN_REVIEW_REQUIRED"));
  await assert.rejects(f.service.prepare(f.run),/PLAN_REVIEW_REQUIRED/);assert.equal(f.stored(),undefined);
});
test("unspent plan review rebinds provenance only when the saved generation remains exactly equal",async t=>{
  const f=await nativePreflightFixture(t),b=f.binding,plan=f.run.productionPlan!;
  const oldScope=b.scopeHash,oldNodes=b.nodes.map(n=>n.nodeId),oldPlan=b.sourcePlanHash;
  plan.contentHash="b".repeat(64);f.run.productionAssetSet!.entries.forEach(e=>e.status="READY");
  const prompts=plan.scenes.flatMap(s=>s.clips).map(c=>({clipId:c.id,promptText:"父女漫剧情节植入产品，不编功效"}));
  await f.canvasService.rebindUnspentPlan(f.run,prompts,f.checkpoint);
  assert.equal(b.sourcePlanHash,plan.contentHash);assert.notEqual(b.scopeHash,oldScope);assert.deepEqual(b.nodes.map(n=>n.nodeId),oldNodes);
  assert.equal(b.planBindingHistory![0]!.fromPlanHash,oldPlan);assert.equal(f.run.consent,undefined);assert.ok(f.calls.every(a=>!["confirm","run","create","edit"].includes(a[1]!)));
  plan.contentHash="c".repeat(64);prompts[0]!.promptText="new product claim";
  await assert.rejects(f.canvasService.rebindUnspentPlan(f.run,prompts,f.checkpoint),/GENERATION_CHANGED/);assert.equal(b.sourcePlanHash,"b".repeat(64));
});
for(const mutation of ["submitId","duration","prompt","price","duplicateClip"]){
  test("native Canvas rejects paid request mutation: "+mutation,async t=>{
    const f=await nativePreflightFixture(t);f.run.paidScope=await f.service.prepare(f.run);
    const r=f.stored().requests[0];
    if(mutation==="submitId")r.canvasBinding.submitId=randomUUID();
    if(mutation==="duration")r.durationMs=15000;
    if(mutation==="prompt")r.promptText="another prompt";
    if(mutation==="price")f.stored().reports[0].costEstimate.estimatedCredits=0;
    if(mutation==="duplicateClip")f.run.paidScope.requests[1]!.clipId=f.run.paidScope.requests[0]!.clipId;
    await assert.rejects(f.service.validate(f.run));assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
  });
}

test("a Canvas request cannot enter the generic legacy submission service",async()=>{
  let called=false;await assert.rejects(submitAttemptOnce({provider:{submit:async()=>{called=true;}} as any,
    request:{...makeRequest(),provider:"dreamina-canvas"},attempt:makeAttempt(),approval:makeApproval(),preflight:{} as any,artifacts:[]}),/Canvas/);assert.equal(called,false);
});

test("15 second price drafts preserve the original run and checkpoint six stable node identities before writes",async t=>{
  const f=await fixture(t),run=f.run,b=run.canvasBinding!;b.sourceScriptHash=H;b.sourcePlanHash=H;
  b.nodes.push({key:"PRODUCT",kind:"PRODUCT",nodeId:newCanvasNodeId(),updateId:randomUUID(),submitId:randomUUID(),sourceRequestHash:H,saved:true,resourceId:randomUUID()});
  const remote=new Map<string,any>(),saved:any[]=[],events:string[]=[],original=JSON.stringify({script:run.script,plan:run.productionPlan,scope:run.paidScope,nodes:b.nodes});
  f.override(args=>{
    if(args[0]==="model")return {ok:true,data:{items:[{model:args[2],modes:[{name:"m2v",flags:[{flag:"--duration",min:4,max:30},{flag:"--resolution",values:["720p"]},{flag:"--ratio",values:["9:16"]}],references:{max:12}}]}]}};
    const flag=(s:string)=>args[args.indexOf(s)+1]!;
    if(args[1]==="create"){events.push("create");assert.ok(saved.length);const nodeId=flag("--node-id"),generation={mode:"m2v",prompt:flag("--prompt"),model:flag("--model"),ratio:"9:16",resolution:"720p",outputCount:1,durationSeconds:Number(flag("--duration")),references:args.flatMap((v,n)=>v==="--ref"?[{kind:"node",id:args[n+1]!.slice(5)}]:[])};remote.set(nodeId,generation);return {ok:true,data:{node:{nodeId,generation}}};}
    if(args[1]==="show")return {ok:true,data:{draftVersion:10,nodes:[...b.nodes.map(n=>({result:"FOUND",node:{nodeId:n.nodeId,resources:n.kind==="PRODUCT"?[{resourceId:n.resourceId}]:[],generation:{mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1}}})),...Array.from(remote,([nodeId,generation])=>({result:"FOUND",node:{nodeId,generation}}))]}};
    if(args[1]==="quote")return {ok:true,data:{draftVersion:10,confirmable:true,items:Array.from(remote,([nodeId,g])=>({nodeId,maxCredits:g.durationSeconds*(g.model==="seedance_2.0_fast_vip"?2:5)})),totalMaxCredits:Array.from(remote.values()).reduce((s,g)=>s+g.durationSeconds*(g.model==="seedance_2.0_fast_vip"?2:5),0)},meta:{requestId:"short-fixture-quote"}};
    return undefined;
  });
  const svc=new CanvasShortPreviewService(f.service),input={sourceScriptHash:H,title:"先听他的需要",prompt12s:"12秒父女情节植入",prompt15s:"15秒父女情节植入",tailCardText:["了解规格和用法"]};
  const checkpoint=async(p:any)=>{events.push("checkpoint");saved.push(structuredClone(p));run.canvasShortPreviews=[structuredClone(p)];};
  const result=await svc.quote(run,input,checkpoint);assert.equal(result.status,"QUOTED");assert.equal(result.recommendedKey,"seedance_2.0_fast_vip-12000");assert.equal(result.paidGenerationAuthorized,false);
  assert.equal(result.candidates.length,6);assert.ok(events.indexOf("checkpoint")<events.indexOf("create"));
  const html=renderCanvasShortPreview(result);assert.match(html,/最高24积分/);assert.match(html,/原60秒方案保留/);assert.match(html,/当前未授权视频生成或发布/);
  const ids=result.candidates.map(c=>c.nodeId);await svc.quote(run,input,checkpoint);assert.equal(events.filter(e=>e==="create").length,6);assert.deepEqual(run.canvasShortPreviews![0]!.candidates.map(c=>c.nodeId),ids);
  assert.equal(JSON.stringify({script:run.script,plan:run.productionPlan,scope:run.paidScope,nodes:b.nodes}),original);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});

test("replayed download detects a changed file rather than reporting the old checksum as ready",async t=>{
  const f=await videoFixture(t),out=await f.service.sync(f.run,f.node.key,f.checkpoint),a=f.records.get(out.outputArtifactId!);
  await fs.writeFile(path.join(f.root,f.run.projectId,a.relativePath),"changed");await assert.rejects(f.service.sync(f.run,f.node.key,f.checkpoint),/STORED_BYTES_CHANGED/);assert.equal(f.downloads(),1);
});

async function nativeDownloadFixture(t:test.TestContext){
  const f=await fixture(t),root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-native-download-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(24)]),sha=hashValue("unused"),resourceId=randomUUID(),projectId=randomUUID(),submitId=randomUUID(),nodeId=newCanvasNodeId();
  const proof=path.join(root,"proof.json"),digest=createHash("sha256").update(media).digest("hex"),calls:string[][]=[];let fault="";
  await fs.writeFile(proof,JSON.stringify({contract:"pvs-canvas-cli-video-download-proof-v1",accountFingerprint:account,executableSha256:f.config.executableSha256,projectId,resourceId,sha256:digest,sizeBytes:media.length,verifiedAt:new Date().toISOString()}));
  const runtime=new DreaminaCanvasRuntime(f.config,async(_exe,args)=>{calls.push(args);
    if(args[0]==="auth")return {ok:true,data:{userId:uid}};
    if(args[0]==="resource"&&args[1]==="get")return {ok:true,data:{resourceId:args[2],type:fault==="image"?"image":"video",status:"success"}};
    if(args[0]==="resource"&&args[1]==="download"){const target=args[args.indexOf("--output")+1]!;await fs.writeFile(target,media);return {ok:true,data:{resourceId:args[2],path:target,size:media.length,sha256:fault==="sha"?sha:digest}};}
    if(args[0]==="operation")return {ok:true,data:{operationRef:submitId,state:"succeeded",submission:{adviceCode:"submission_accepted"},resources:fault==="operation"?[]:[{resourceId,state:"succeeded"}]}};
    if(args[1]==="show")return {ok:true,data:{nodes:[{result:"FOUND",node:{nodeId,resources:fault==="node"?[]:[{resourceId}]}}]}};
    throw Error("Unexpected command");
  });
  await fs.mkdir(path.join(root,"project",".tmp"),{recursive:true});
  return {port:new CanvasCliVideoDownload(runtime,root,proof),calls,root,fault:(s:string)=>fault=s,
    input:{canvasProjectId:projectId,nodeId,submitId,resourceId,accountFingerprint:account,outputPath:path.join(root,"project",".tmp","original.mp4")}};
}
test("native CLI downloader proves a real video byte round trip and checks original operation/node before copying output",async t=>{
  const f=await nativeDownloadFixture(t);assert.equal((await f.port.readiness(account)).ready,true);const r=await f.port.download(f.input);
  assert.ok(r.sizeBytes>12);assert.equal(r.path,f.input.outputPath);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});
for(const fault of ["sha","image","operation","node"]){
  test("native video downloader fails closed for "+fault,async t=>{const f=await nativeDownloadFixture(t);
    if(fault==="sha"||fault==="image"){f.fault(fault);assert.equal((await f.port.readiness(account)).ready,false);}
    else{assert.equal((await f.port.readiness(account)).ready,true);f.fault(fault);await assert.rejects(f.port.download(f.input));assert.equal(await fs.stat(f.input.outputPath).catch(()=>null),null);}
  });
}

async function shortFixture(t:test.TestContext,realVideo=false){
  const f=await fixture(t),root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-short-cycle-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  f.config.videoModel="seedance_2.0_fast_vip";const run=f.run,records=new Map<string,any>(),approvals:any[]=[],attempts:any[]=[],decisions:any[]=[];let chain:any;
  const projectRoot=path.join(root,run.projectId);await fs.mkdir(projectRoot,{recursive:true});
  const image=path.join(projectRoot,"product.png");await promisify(execFile)("ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=teal:s=120x160","-frames:v","1","-threads","1",image],{windowsHide:true,timeout:30000});
  const imageBytes=await fs.readFile(image),imageSha=createHash("sha256").update(imageBytes).digest("hex");
  const artifacts={async findById(id:string){return records.get(id)??null;},async createPending(input:any){const a={...input,createdAt:new Date().toISOString(),integrityStatus:"PENDING"};records.set(input.id,a);return a;},
    async markReady(id:string,patch:any){const a={...records.get(id),...patch,integrityStatus:"READY"};records.set(id,a);return a;}} as unknown as ArtifactRepository;
  const assetKeys=["PRODUCT","DAUGHTER","FATHER","LIVING_ROOM"];
  const uses=assetKeys.map((key,index)=>({assetId:"ref-"+key,role:(index===0?"PRIMARY_PRODUCT":index===3?"ENVIRONMENT":"CHARACTER") as any,priority:index,required:true}));
  run.productionAssetSet={...run.productionAssetSet,id:"asset-set",version:1,entries:assetKeys.map((key,index)=>({key,label:key,kind:index===0?"PRODUCT":index===3?"SET":"CHARACTER",source:index===0?"PRODUCT_INPUT":"DREAMINA_GENERATED",status:"READY",artifactIds:["image-"+key],referenceAssetId:"ref-"+key,sourceReferenceAssetIds:[],generationRequestHash:H}))} as any;
  for(const key of assetKeys)records.set("image-"+key,{id:"image-"+key,projectId:run.projectId,relativePath:"product.png",sha256:imageSha,integrityStatus:"READY",kind:"REFERENCE_IMAGE",mimeType:"image/png"});
  run.truthRef={entityType:"ProductTruth",entityId:"truth",version:1,hash:H};run.selectedCreativeId="creative";run.creativeBatch={id:"batch",version:1,contentHash:H} as any;
  run.script={id:"script",projectId:run.projectId,version:7,status:"CONFIRMED",confirmedAt:new Date().toISOString(),productTruthRef:run.truthRef,creativeBatchRef:{entityType:"CreativeBatch",entityId:"batch",version:1,hash:H},
    selectedCreativeId:"creative",targetDurationMs:60000,beats:[{id:"beat",order:1,purpose:"PRODUCT",text:"原营销剧情",estimatedDurationMs:60000,requiredFactIds:[]}],contentHash:H};
  const clip=makeValidClip();clip.referenceAssets=uses;
  run.productionPlan={id:"original-plan",projectId:run.projectId,version:1,status:"DRAFT",productTruthRef:run.truthRef,scriptRef:{entityType:"ScriptDraft",entityId:"script",version:7,hash:H},selectedCreativeId:"creative",
    visualDirection:"生活向二维漫剧",soundDirection:"普通话对白，无背景音乐",productShowcaseRules:["不编造功效"],continuityLock:{product:{stableAttributes:["完整产品"],forbiddenChanges:[]},characters:[],environments:[]},
    generationTarget:{source:"DREAMINA_CAPABILITY_REGISTRY",requestedModelVersion:"seedance2.0_vip",aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:true,registryFingerprint:H,capabilityCheckedAt:new Date().toISOString(),
      operationConstraints:[{operation:"multimodal2video",operationLabel:"多模态视频",modelMode:"EXPLICIT",modelVersion:"seedance2.0_vip",supportsReferenceAudio:false,supportsNativeAudioOutput:true,explicitRatioAllowed:true,supportedResolutions:["720p"]}]},
    scenes:[{id:"scene-1",order:1,purpose:"原60秒剧情",location:"客厅",visualState:"父女在桌边",sourceBeatIds:["beat"],requiredFactIds:[],clips:[clip]}],contentHash:H};
  const b=run.canvasBinding!;b.sourceScriptHash=H;b.sourcePlanHash=H;
  b.nodes=b.nodes.filter(n=>n.kind==="IMAGE");b.nodes.unshift({key:"PRODUCT",kind:"PRODUCT",sourceRequestHash:imageSha,nodeId:newCanvasNodeId(),resourceId:randomUUID(),updateId:randomUUID(),submitId:randomUUID(),saved:true});
  const referenceIds=b.nodes.map(n=>n.nodeId),nodeId=newCanvasNodeId(),generation={mode:"m2v",prompt:"父女剧情广告，完整产品，不编造功效",model:"seedance_2.0_fast_vip",ratio:"9:16",resolution:"720p",outputCount:1,durationSeconds:12,references:referenceIds.map(id=>({kind:"node",id}))};
  const previewId=randomUUID();run.canvasShortPreviews=[{id:previewId,sourceRunId:run.id,sourceScriptHash:H,sourcePlanHash:H,inputHash:H,title:"爸，这次你来选",outputDurationMs:15000,tailCardText:["品牌 · 产品","了解枕形、配方和用法"],accountFingerprint:account,canvasProjectId:b.projectId,referenceNodeIds:referenceIds,
    candidates:[{key:"seedance_2.0_fast_vip-12000",nodeId,updateId:randomUUID(),model:"seedance_2.0_fast_vip",generatedDurationMs:12000,localTailMs:3000,prompt:generation.prompt,generationHash:canvasGenerationHash(generation),saved:true}],status:"QUOTED",recommendedKey:"seedance_2.0_fast_vip-12000",paidGenerationAuthorized:false,publishAuthorized:false,checkedAt:new Date().toISOString()} as any];
  const resourceId=randomUUID();let price=72;
  f.override(args=>{
    if(args[0]==="model")return {ok:true,data:{items:[{model:"seedance_2.0_fast_vip",modes:[{name:"m2v",flags:[{flag:"--duration",min:4,max:15},{flag:"--resolution",values:["720p"]}]}]}]}};
    if(args[1]==="show")return {ok:true,data:{draftVersion:19,nodes:[...b.nodes.map(n=>({result:"FOUND",node:{nodeId:n.nodeId,resources:n.kind==="PRODUCT"?[{resourceId:n.resourceId}]:[],generation:{mode:"t2i",prompt:"原创设定",model:"seedream_5.0_lite",ratio:"3:4",resolution:"2K",outputCount:1}}})),{result:"FOUND",node:{nodeId,generation,upstreamNodeIds:referenceIds,resources:[{resourceId}]}}]}};
    if(args[1]==="quote")return {ok:true,data:{draftVersion:19,confirmable:true,items:[{nodeId,maxCredits:price}],totalMaxCredits:price},meta:{requestId:"short-quote"}};
    if(args[1]==="confirm")return {ok:true,data:{creditConfirmationToken:"private-short-token",creditCeiling:price,expiresAt:new Date(Date.now()+60000).toISOString()}};
    if(args[0]==="operation")return {ok:true,data:{operationRef:args[2],state:"succeeded",submission:{adviceCode:"submission_accepted"},resources:[{resourceId,state:"succeeded"}]}};
    if(args[0]==="resource")return {ok:true,data:{resourceId,type:"video",status:"success"}};
    return undefined;
  });
  const generationRepo={async listCompiledPrompts(){return chain?.compiledPrompts??[];},async replacePreflightChain(c:any){chain=structuredClone(c);},async listCurrentGenerationRequests(){return chain?.requests??[];},
    async getGenerationRequest(id:string){return chain?.requests.find((r:any)=>r.id===id)??null;},async listPreflightReports(){return chain?.reports??[];},async getPreflightReport(id:string){return chain?.reports.find((r:any)=>r.id===id)??null;},
    async listUserApprovals(){return approvals;},async createUserApproval(a:any){approvals.push(a);return a;},async getUserApproval(id:string){return approvals.find(a=>a.id===id)??null;}} as unknown as GenerationRepository;
  const workflow={async listGenerationAttempts(){return attempts;},async nextAttemptNumber(){return attempts.length+1;},async createGenerationAttempt(a:any){attempts.push(a);return a;},async getGenerationAttempt(id:string){return attempts.find(a=>a.id===id)??null;},
    async claimCreatedAttempt(id:string){const a=attempts.find(a=>a.id===id);if(a?.status!=="CREATED")return null;a.status="SUBMITTING";return a;},async updateGenerationAttemptStatus(id:string,p:any){const a=attempts.find(a=>a.id===id);Object.assign(a,p);return a;}} as unknown as WorkflowRepository;
  const reviews={async createDecision(d:any){decisions.push(d);return d;},async listDecisionsForClip(){return decisions;}} as any;
  let media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(24)]),downloads=0;
  if(realVideo){const target=path.join(root,"synthetic-12s.mp4");await promisify(execFile)("ffmpeg",["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=90x160:rate=6","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","12","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac",target],{windowsHide:true,timeout:30000});media=await fs.readFile(target);}
  const port={async readiness(){return {ready:true};},async download(i:any){downloads++;await fs.writeFile(i.outputPath,media);return {path:i.outputPath,sizeBytes:media.length,sha256:createHash("sha256").update(media).digest("hex")};}};
  const service=new CanvasShortProductionService(f.service,port,artifacts,generationRepo,workflow,reviews,root,()=>f.service);
  const saved:any[]=[],save=async(p:any)=>{saved.push(structuredClone(p));run.canvasShortPlans=[p];};
  const plan=await service.createDraft(run,previewId);await save(plan);
  return {...f,service,run,plan,save,saved,records,approvals,attempts,decisions,root,port,chain:()=>chain,price:(n:number)=>price=n,downloads:()=>downloads};
}

async function realisticPreflightFixture(t:test.TestContext){
  const f=await shortFixture(t);let price=72,delivery=true;
  const set=f.run.productionAssetSet!;Object.assign(set,{strategyRef:{entityType:"ProductionStrategy",entityId:"strategy",version:1,hash:H},selectedCreativeId:"creative",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await f.service.reviseStyle(f.run,f.plan,f.save);const head=f.plan.visualRevisions!.at(-1)!;await f.service.reviewVisualDesign(f.run,f.plan,head.id,head.contentHash,true,f.save);
  const settingId=newCanvasNodeId(),videoId=newCanvasNodeId(),resourceId=randomUUID(),submitId=randomUUID(),product=f.run.canvasBinding!.nodes.find(n=>n.kind==="PRODUCT")!;
  const source=f.records.get("image-DAUGHTER"),settingArtifact={...source,id:"image-realistic-setting"};f.records.set(settingArtifact.id,settingArtifact);
  const settingGeneration={mode:"t2i",prompt:"已审核人物场景",model:"seedream_5.0_lite",ratio:"9:16",resolution:"2K",outputCount:1},videoGeneration={mode:"m2v",prompt:head.payload.draftVideoPrompt,
    model:"seedance_2.0_fast_vip",ratio:"9:16",resolution:"720p",durationSeconds:12,outputCount:1,references:[{kind:"node",type:"image",id:product.nodeId},{kind:"node",type:"image",id:settingId}]};
  const q={revisionId:head.id,revisionHash:head.contentHash,requestHash:H,projectId:f.run.canvasBinding!.projectId,accountFingerprint:account,profile:f.config.profile,executableSha256:f.config.executableSha256,
    productNodeId:product.nodeId,productSha256:head.payload.productReference.sha256,imagePrompt:settingGeneration.prompt,
    nodes:[{key:"SETTING",nodeId:settingId,updateId:randomUUID(),generationHash:canvasGenerationHash(settingGeneration),saved:true},
      {key:"VIDEO",nodeId:videoId,updateId:randomUUID(),generationHash:canvasGenerationHash(videoGeneration),saved:true},
      {key:"PRODUCT_ONLY_COMPARISON",nodeId:newCanvasNodeId(),updateId:randomUUID(),generationHash:H,saved:true}],checkedAt:new Date().toISOString(),totalCredits:null,status:"INCOMPLETE",validity:"REVALIDATE_DRAFT_AND_REFERENCES",generationAuthorized:false,publishAuthorized:false};
  f.plan.referenceQuote=q as any;
  f.plan.referenceImage={scopeHash:H,revisionHash:head.contentHash,quoteRequestHash:H,nodeId:settingId,generationHash:canvasGenerationHash(settingGeneration),accountFingerprint:account,creditCeiling:0,count:1,model:"seedream_5.0_lite",
    consent:{source:"EXPLICIT_USER_ZERO_REFERENCE_IMAGE",approvedAt:new Date().toISOString()},submitId,state:"ADOPTED",liveQuote:{draftVersion:30,sourceRequestId:"image-quote",checkedAt:new Date().toISOString(),credits:0},resources:[resourceId],updatedAt:new Date().toISOString(),
    artifact:{id:settingArtifact.id,sha256:settingArtifact.sha256,relativePath:settingArtifact.relativePath,sizeBytes:100,mimeType:"image/png",width:1440,height:2560},
    review:{source:"EXPLICIT_USER_ADOPT_REFERENCE",revisionHash:head.contentHash,artifactId:settingArtifact.id,sha256:settingArtifact.sha256,resourceId,reviewedAt:new Date().toISOString()}};
  const remote=new Map<string,any>([[product.nodeId,{nodeId:product.nodeId,resources:[{resourceId:product.resourceId,type:"image",status:"success",source:"uploaded"}]}],
    [settingId,{nodeId:settingId,generation:settingGeneration,resources:[{resourceId,submitId,type:"image",status:"success",source:"generated",creditsAmount:0}],upstreamNodeIds:[]}],
    [videoId,{nodeId:videoId,generation:videoGeneration,resources:[],upstreamNodeIds:[product.nodeId,settingId]}]]);
  f.override(args=>{
    if(args[0]==="model")return {ok:true,data:{items:[{model:"seedance_2.0_fast_vip",modes:[{name:"m2v",flags:[{flag:"--duration",min:4,max:15},{flag:"--ratio",values:["9:16"]},{flag:"--resolution",values:["720p"]}],references:{types:[{mediaType:"image",max:9}]}}]}]}};
    const ids=args.flatMap((a,i)=>a==="--node-id"?[args[i+1]!]:[]);
    if(args[1]==="show")return {ok:true,data:{draftVersion:31,nodes:ids.map(id=>({result:"FOUND",node:remote.get(id)}))}};
    if(args[1]==="quote")return {ok:true,data:{draftVersion:31,confirmable:true,items:ids.map(nodeId=>({nodeId,maxCredits:price})),totalMaxCredits:ids.length*price},meta:{requestId:"realistic-native-quote"}};
    return undefined;
  });
  f.port.readiness=async()=>delivery?{ready:true}:{ready:false,code:"VIDEO_DOWNLOAD_UNAVAILABLE"} as any;
  return {...f,head,remote,videoId,price:(n:number)=>price=n,delivery:(ready:boolean)=>delivery=ready};
}

test("delivered realistic final is visible outside history and never reverts to unpaid draft labels",async t=>{
  const f=await realisticPreflightFixture(t);await f.service.prepare(f.run,f.plan,f.save);
  const p=f.plan,attemptId="accepted-attempt",artifactId="accepted-realistic-clip",at=new Date().toISOString();
  p.status="DELIVERED";p.attemptIds=[attemptId];p.consent={scopeHash:H,approvedAt:at,acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"};
  p.realisticExecution!.binding.nodes.find(n=>n.kind==="VIDEO")!.delivery={attemptId,resourceId:randomUUID(),state:"NEEDS_REVIEW",artifactId,sha256:H,findings:[],durationMs:12096,width:720,height:1280,hasAudio:true};
  p.clipReview={attemptId,artifactId,sha256:H,decisionId:"clip-decision",reviewedAt:at};
  p.final={artifactId:"accepted-final",sha256:H,manifestArtifactId:"accepted-manifest",qcArtifactId:"accepted-qc",durationMs:15000,width:720,height:1280,hasAudio:true,acceptedAt:at};
  f.run.canvasShortPlans=[p];f.run.status="WAITING_FOR_ASSET_REVIEW";
  const before=JSON.stringify(f.run),calls=f.calls.length,html=renderCanvasShortPlan(p);
  assert.match(html,/成片已确认并可下载/);assert.match(html,/<h3>已审核通过的15秒成片<\/h3>/);assert.match(html,/方案原始标题（保留历史文字）：/);assert.match(html,/实际15秒成片 · 已确认/);assert.match(html,/实际12秒原视频 · 已采用/);
  for(const id of ["accepted-final","accepted-manifest","accepted-qc",artifactId])assert(html.includes('/api/artifacts/'+id+'/content'));
  assert.doesNotMatch(html,/视频未授权|视频尚未授权|尚未提交|待你确认具体生成范围|原15秒方案历史稿/);
  const page=renderAgentCyclePage({project:{id:f.run.projectId,name:"本机合成验收项目"},projects:[],cycles:[],skills:[],snapshot:{workspace:{project:{id:f.run.projectId,name:"本机合成验收项目"},script:f.run.script,productionPlan:f.run.productionPlan},production:[f.run]}});
  assert.match(page,/15秒成片已确认并可下载，原60秒任务单独保留/);assert.match(page,/成片已审阅，发布须独立确认/);assert.doesNotMatch(page,/视频与发布仍未授权|待成片审阅与发布确认/);
  assert.equal(JSON.stringify(f.run),before);assert.equal(f.calls.length,calls);
  if(process.env.PVS_ACCEPTANCE_OUTPUT_ROOT)await fs.writeFile(path.join(process.env.PVS_ACCEPTANCE_OUTPUT_ROOT,"delivered-state.html"),page);
});

test("realistic execution presentation follows original submission and requires final acceptance receipt",async t=>{
  const f=await realisticPreflightFixture(t);await f.service.prepare(f.run,f.plan,f.save);const p=f.plan;
  p.status="AUTHORIZED";p.consent={scopeHash:H,approvedAt:new Date().toISOString(),acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"};
  assert.match(renderCanvasShortPlan(p),/已确认本次生成范围，尚未提交/);assert.doesNotMatch(renderCanvasShortPlan(p),/视频未授权/);
  p.status="GENERATING";p.attemptIds=["original-attempt"];assert.match(renderCanvasShortPlan(p),/正在接收原生成任务，不自动重提/);
  p.status="FINAL_REVIEW";p.final={artifactId:"pending-final",sha256:H,manifestArtifactId:"pending-manifest",qcArtifactId:"pending-qc",durationMs:15000,width:720,height:1280,hasAudio:true};
  assert.match(renderCanvasShortPlan(p),/实际15秒成片 · 等待你审阅/);assert.doesNotMatch(renderCanvasShortPlan(p),/成片已确认并可下载|已审核通过的15秒成片/);
  p.status="DELIVERED";assert.match(renderCanvasShortPlan(p),/成片确认回执待核对/);assert.doesNotMatch(renderCanvasShortPlan(p),/实际15秒成片 · 已确认/);
});

test("approved realistic references prepare one native request and preserve every legacy field without spending",async t=>{
  const f=await realisticPreflightFixture(t),old={payload:JSON.stringify(f.plan.payload),binding:JSON.stringify(f.plan.binding),feeQuote:JSON.stringify(f.plan.feeQuote),script:JSON.stringify(f.run.script),plan:JSON.stringify(f.run.productionPlan),assets:JSON.stringify(f.run.productionAssetSet),head:JSON.stringify(f.head)};
  await f.service.prepare(f.run,f.plan,f.save);const e=f.plan.realisticExecution!;assert.equal(e.preflight!.status,"PASS");assert.equal(f.plan.status,"REQUEST_READY");assert.equal(e.paidScope!.requests.length,1);
  const request=f.chain().requests[0];assert.equal(request.assetManifest.length,2);assert.equal(request.canvasBinding.nodeId,f.videoId);assert.equal(request.canvasBinding.submitId,e.payload.submitId);assert.equal(e.feeQuote!.grandTotal!.credits,72);
  assert.equal(JSON.stringify(f.plan.payload),old.payload);assert.equal(JSON.stringify(f.plan.binding),old.binding);assert.equal(JSON.stringify(f.plan.feeQuote),old.feeQuote);
  assert.equal(JSON.stringify(f.run.script),old.script);assert.equal(JSON.stringify(f.run.productionPlan),old.plan);assert.equal(JSON.stringify(f.run.productionAssetSet),old.assets);assert.equal(JSON.stringify(f.head),old.head);
  assert.deepEqual(e.payload.script.beats,f.head.payload.script.beats);assert.deepEqual(e.payload.productionPlan.scenes[0]!.clips[0]!.segments,f.head.payload.productionPlan.scenes[0]!.clips[0]!.segments);
  assert.equal(f.plan.consent,undefined);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);assert.equal(f.calls.some(a=>["confirm","run"].includes(a[1]??"")),false);
  const checked=await f.service.inspect(f.run,f.plan);assert.deepEqual(checked.blockers,[]);assert.equal(checked.status,"REQUEST_READY");
  const id=request.id,scope=e.paidScope!.hash;await f.service.prepare(f.run,f.plan,f.save);assert.equal(f.chain().requests[0].id,id);
  e.paidScope=undefined;await f.service.prepare(f.run,f.plan,f.save);assert.equal(f.chain().requests[0].id,id);assert.equal(e.paidScope!.hash,scope);
});
test("realistic preparation stops for over-budget quote or failed video delivery without native requests or approval",async t=>{
  const f=await realisticPreflightFixture(t);f.price(73);await assert.rejects(f.service.prepare(f.run,f.plan,f.save),/72_CREDIT/);assert.equal(f.chain(),undefined);
  f.price(72);f.delivery(false);await assert.rejects(f.service.prepare(f.run,f.plan,f.save),/PREFLIGHT_BLOCKED/);assert.equal(f.chain(),undefined);assert.equal(f.plan.realisticExecution!.preflight!.status,"BLOCKED");
  assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);assert.equal(f.calls.some(a=>["confirm","run"].includes(a[1]??"")),false);
});
test("expired unspent native preflight renews locally and preserves scope history and original remote submit",async t=>{
  const f=await realisticPreflightFixture(t);await f.service.prepare(f.run,f.plan,f.save);const e=f.plan.realisticExecution!,submit=e.payload.submitId,request=f.chain().requests[0].id,report=f.chain().reports[0];
  report.costEstimate.expiresAt=new Date(Date.now()-1000).toISOString();const {reportHash:_,...body}=report;report.reportHash=hashValue(body);
  e.paidScope!.requests[0]!.preflightHash=report.reportHash;e.paidScope!.hash=canvasPaidScopeHash(e.paidScope!);const old=structuredClone(e.paidScope!);
  await f.service.prepare(f.run,f.plan,f.save);assert.notEqual(f.chain().requests[0].id,request);assert.equal(e.payload.submitId,submit);assert.deepEqual(e.paidScopeHistory,[old]);
  assert.equal(e.preflight!.status,"PASS");assert.equal(f.plan.consent,undefined);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);assert.equal(f.calls.some(a=>["confirm","run"].includes(a[1]??"")),false);
});
test("realistic exact snapshot and native scope must validate before any separate user authorization",async t=>{
  const f=await realisticPreflightFixture(t);await f.service.prepare(f.run,f.plan,f.save);const e=f.plan.realisticExecution!,scope=e.paidScope!.hash;
  await assert.rejects(f.service.authorize(f.run,f.plan,scope,false,f.save),/EXPLICIT_72_CREDIT/);assert.equal(f.plan.consent,undefined);
  const text=e.payload.script.beats[0]!.text;e.payload.script.beats[0]!.text+="改动";e.contentHash=hashValue(e.payload);
  await assert.rejects(f.service.authorize(f.run,f.plan,scope,true,f.save),/SNAPSHOT_CHANGED/);assert.equal(f.plan.consent,undefined);
  e.payload.script.beats[0]!.text=text;e.contentHash=hashValue(e.payload);await f.service.authorize(f.run,f.plan,scope,true,f.save);
  assert.equal(f.plan.consent!.scopeHash,scope);assert.equal(f.plan.paidScope,undefined);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);assert.equal(f.calls.some(a=>["confirm","run"].includes(a[1]??"")),false);
});
test("selected 72-credit short plan has its own script, clip, request IDs and budget without replacing the original",async t=>{
  const f=await shortFixture(t);assert.equal(f.plan.status,"DRAFT");assert.equal(f.plan.payload.creditCeiling,72);assert.equal(f.plan.payload.script.targetDurationMs,15000);
  assert.equal(f.plan.payload.productionPlan.scenes[0]!.clips[0]!.durationMs,12000);assert.equal(f.run.script!.targetDurationMs,60000);assert.equal(f.run.productionPlan!.status,"DRAFT");
  assert.equal(f.plan.payload.productionPlan.generationTarget!.operationConstraints[0]!.modelVersion,"seedance_2.0_fast_vip");
  assert.equal(f.run.productionPlan!.generationTarget!.operationConstraints[0]!.modelVersion,"seedance2.0_vip");
  f.plan.payload.productionPlan.generationTarget!.operationConstraints[0]!.modelVersion="seedance2.0_vip";
  const corrected=await f.service.createDraft(f.run,f.plan.payload.previewId);
  assert.equal(corrected.id,f.plan.id);assert.equal(corrected.payload.productionPlan.generationTarget!.operationConstraints[0]!.modelVersion,"seedance_2.0_fast_vip");
  await assert.rejects(f.service.advance(f.run,f.plan,f.save),/PERMISSION_MISSING/);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);
  await assert.rejects(f.service.reviewPlan(f.run,f.plan,f.plan.contentHash,false,f.save),/EXPLICIT_REVIEW/);
  await assert.rejects(f.service.acceptFinal(f.run,f.plan,H,true,f.save),/EXPLICIT_REVIEW/);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
  const html=renderCanvasShortPlan(f.plan);assert.match(html,/15秒独立制作/);assert.match(html,/上限72/);assert.match(html,/尚无15秒实际成片/);assert.doesNotMatch(html,/<video/);
});
test("short video request preparation and 72-credit approval fail when live price exceeds the selected ceiling",async t=>{
  const f=await shortFixture(t);await f.service.reviewPlan(f.run,f.plan,f.plan.contentHash,true,f.save);f.price(73);
  await f.service.quote(f.run,f.plan,f.save);assert.equal(f.plan.blocker,"SHORT_72_CREDIT_CEILING_EXCEEDED");await assert.rejects(f.service.prepare(f.run,f.plan,f.save),/72_CREDIT/);
  assert.equal(f.approvals.length,0);assert.ok(f.calls.every(a=>!["confirm","run"].includes(a[1]!)));
});

test("realistic visual revision preserves old plans and references and cannot inherit old cartoon quotes or spend permission",async t=>{
  const f=await shortFixture(t),oldPayload=JSON.stringify(f.plan.payload),oldScript=JSON.stringify(f.run.script),oldOriginalPlan=JSON.stringify(f.run.productionPlan),calls=f.calls.length;
  await f.service.reviseStyle(f.run,f.plan,f.save);const revision=f.plan.visualRevisions!.at(-1)!;
  assert.equal(JSON.stringify(f.plan.payload),oldPayload);assert.equal(JSON.stringify(f.run.script),oldScript);assert.equal(JSON.stringify(f.run.productionPlan),oldOriginalPlan);
  assert.equal(revision.contentHash,hashValue(revision.payload));assert.equal(revision.payload.sourcePlanHash,f.plan.contentHash);
  assert.equal(revision.payload.style,"REALISTIC_AI_SHORT_DRAMA");assert.equal(revision.payload.creditCeiling,72);assert.equal(revision.payload.budgetScope,"NEW_SETTING_IMAGES_AND_VIDEO");
  assert.equal(revision.payload.script.targetDurationMs,15000);assert.equal(revision.payload.productionPlan.scenes[0]!.clips[0]!.durationMs,12000);
  assert.equal(revision.payload.productionPlan.scenes[0]!.clips[0]!.referenceAssets.length,1);assert.equal(revision.payload.designs.length,3);
  assert.equal(revision.payload.excludedReferenceArtifactIds.length,3);assert.ok(revision.payload.designs.every(d=>d.state==="TEXT_DESIGN_PENDING_REVIEW"&&!d.imageArtifactId));
  assert.match(revision.payload.productionPlan.visualDirection,/仿真人/);assert.doesNotMatch(revision.payload.productionPlan.soundDirection,/53秒|52秒|8秒/);
  assert.equal(revision.payload.productionPlan.continuityLock.environments[0]!.sceneId,revision.payload.productionPlan.scenes[0]!.id);
  await f.service.reviseStyle(f.run,f.plan,f.save);assert.equal(f.plan.visualRevisions!.length,1);assert.equal(f.calls.length,calls);
  const checked=await f.service.inspect(f.run,f.plan);assert.equal(checked.hasPaidConsent,false);assert.equal(checked.feeQuote,undefined);assert.ok(checked.blockers.includes("REALISTIC_REFERENCE_IMAGES_NOT_CREATED"));
  await assert.rejects(f.service.quote(f.run,f.plan,f.save),/REALISTIC_REFERENCE_BINDING_REQUIRED/);
  await assert.rejects(f.service.reviewPlan(f.run,f.plan,f.plan.contentHash,true,f.save),/REALISTIC_REFERENCE_BINDING_REQUIRED/);
  await assert.rejects(f.service.prepare(f.run,f.plan,f.save),/REALISTIC_REFERENCE_BINDING_REQUIRED/);
  await assert.rejects(f.service.advance(f.run,f.plan,f.save),/PERMISSION_MISSING/);
  const html=renderCanvasShortPlan(f.plan);assert.match(html,/仿真人15秒修订稿/);assert.match(html,/文字设定待审核/);assert.match(html,/图片费用未知不能按0计/);assert.doesNotMatch(html.split('原15秒方案历史稿')[0]!,/<img/);
  await assert.rejects(f.service.reviewVisualDesign(f.run,f.plan,revision.id,revision.contentHash,false,f.save),/VISUAL_EXPLICIT_REVIEW_REQUIRED/);
  await assert.rejects(f.service.reviewVisualDesign(f.run,f.plan,revision.id,H,true,f.save),/VISUAL_EXPLICIT_REVIEW_REQUIRED/);
  await f.service.reviewVisualDesign(f.run,f.plan,revision.id,revision.contentHash,true,f.save);assert.equal(revision.designReview!.scope,"TEXT_DESIGN_ONLY");
  assert.equal(revision.status,"DESIGN_CONFIRMED");await assert.rejects(f.service.quote(f.run,f.plan,f.save),/REALISTIC_REFERENCE_BINDING_REQUIRED/);
  assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);
  f.plan.referenceImage={revisionHash:revision.contentHash,artifact:{id:"image-PRODUCT",sha256:f.records.get("image-PRODUCT").sha256}} as any;
  const actual=await f.service.inspect(f.run,f.plan);assert.equal(actual.status,"REFERENCE_IMAGE_REVIEW");assert.equal(actual.noGenerationSubmitted,false);
  assert.ok(actual.blockers.includes("REALISTIC_REFERENCE_IMAGE_REVIEW_REQUIRED"));assert.ok(!actual.blockers.includes("REALISTIC_REFERENCE_IMAGES_NOT_CREATED"));
});

test("creative editing appends an unapproved candidate, preserves the reviewed version and is idempotent without provider calls",async t=>{
  const f=await shortFixture(t);await f.service.reviseStyle(f.run,f.plan,f.save);const head=f.plan.visualRevisions!.at(-1)!;
  await f.service.reviewVisualDesign(f.run,f.plan,head.id,head.contentHash,true,f.save);
  const original=JSON.stringify(head),payload=JSON.stringify(f.plan.payload),calls=f.calls.length,proposal=structuredClone(head.payload);
  proposal.replacesRevisionId=head.id;proposal.title="谁说送你了";proposal.storyPremise="古装姐妹以误会和反应推进剧情";
  proposal.designs[0]!.key="CHARACTER_A";proposal.designs[1]!.key="CHARACTER_B";proposal.designs[2]!.key="INTERIOR";
  await f.service.editVisualDraft(f.run,f.plan,head.contentHash,proposal,f.save);const next=f.plan.visualRevisions!.at(-1)!;
  assert.equal(f.plan.visualRevisions!.length,2);assert.equal(JSON.stringify(head),original);assert.equal(JSON.stringify(f.plan.payload),payload);
  assert.equal(next.status,"DRAFT");assert.equal(next.designReview,undefined);assert.equal(next.payload.replacesRevisionId,head.id);
  await f.service.editVisualDraft(f.run,f.plan,head.contentHash,proposal,f.save);assert.equal(f.plan.visualRevisions!.length,2);
  assert.equal(f.calls.length,calls);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);
  assert.match(renderCanvasShortPlan(f.plan),/古装姐妹以误会和反应推进剧情/);
  await assert.rejects(f.service.quote(f.run,f.plan,f.save),/REALISTIC_REFERENCE_BINDING_REQUIRED/);
});

test("creative editing rejects stale heads, changed evidence, fake approval, budget increases and broken script binding",async t=>{
  const f=await shortFixture(t);await f.service.reviseStyle(f.run,f.plan,f.save);const head=f.plan.visualRevisions!.at(-1)!;
  const proposal=structuredClone(head.payload);proposal.replacesRevisionId=head.id;proposal.title="待审核新创意";
  await assert.rejects(f.service.editVisualDraft(f.run,f.plan,H,proposal,f.save),/HEAD_CHANGED/);
  const evidence=structuredClone(proposal);evidence.productReference.sha256=H;
  await assert.rejects(f.service.editVisualDraft(f.run,f.plan,head.contentHash,evidence,f.save),/HEAD_CHANGED/);
  const budget={...proposal,creditCeiling:73};await assert.rejects(f.service.editVisualDraft(f.run,f.plan,head.contentHash,budget,f.save));
  const permission=structuredClone(proposal);(permission.execution as any).videoGenerationAuthorized=true;
  await assert.rejects(f.service.editVisualDraft(f.run,f.plan,head.contentHash,permission,f.save));
  const broken=structuredClone(proposal);broken.productionPlan.scriptRef.hash=H;
  const {contentHash:_,...data}=broken.productionPlan;broken.productionPlan.contentHash=hashValue(data);
  await assert.rejects(f.service.editVisualDraft(f.run,f.plan,head.contentHash,broken,f.save),/DRAFT_CONTRACT_INVALID/);
  assert.equal(f.plan.visualRevisions!.length,1);assert.equal(f.approvals.length,0);assert.equal(f.attempts.length,0);
});

test("visual revision refuses already authorized or tampered source plans",async t=>{
  const f=await shortFixture(t);f.plan.consent={scopeHash:H,approvedAt:new Date().toISOString(),acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"};
  await assert.rejects(f.service.reviseStyle(f.run,f.plan,f.save),/REQUIRES_UNAUTHORIZED_PLAN/);assert.equal(f.plan.visualRevisions,undefined);
  f.plan.consent=undefined;f.plan.payload.prompt+=' changed';await assert.rejects(f.service.reviseStyle(f.run,f.plan,f.save),/SOURCE_CHANGED/);
});
test("local synthetic short lifecycle verifies consent, original download, human clip review, 15 second assembly, QC, manifest and final acceptance",async t=>{
  const f=await shortFixture(t,true);await f.service.reviewPlan(f.run,f.plan,f.plan.contentHash,true,f.save);
  await f.service.quote(f.run,f.plan,f.save);await f.service.prepare(f.run,f.plan,f.save);
  await assert.rejects(f.service.authorize(f.run,f.plan,f.plan.paidScope!.hash,false,f.save),/PERMISSION_REQUIRED/);
  await f.service.authorize(f.run,f.plan,f.plan.paidScope!.hash,true,f.save);await f.service.advance(f.run,f.plan,f.save);
  assert.equal(f.plan.status,"CLIP_REVIEW");assert.equal(f.attempts.length,1);assert.equal(f.downloads(),1);
  await assert.rejects(f.service.assemble(f.run,f.plan,f.save),/CLIP_REVIEW_REQUIRED/);
  const a=f.attempts[0],artifact=f.records.get(a.outputArtifactId);
  await f.service.reviewClip(f.run,f.plan,a.id,artifact.sha256,"ACCEPT",true,f.save);await f.service.assemble(f.run,f.plan,f.save);
  assert.equal(f.plan.status,"FINAL_REVIEW");assert.equal(f.plan.final!.width,720);assert.equal(f.plan.final!.height,1280);assert.ok(Math.abs(f.plan.final!.durationMs-15000)<250);
  const qc=f.records.get(f.plan.final!.qcArtifactId),manifest=f.records.get(f.plan.final!.manifestArtifactId);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,f.run.projectId,qc.relativePath),"utf8")).status,"PASS");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,f.run.projectId,manifest.relativePath),"utf8")).published,false);
  const ids=f.plan.attemptIds.slice();await f.service.advance(f.run,f.plan,f.save);assert.deepEqual(f.plan.attemptIds,ids);assert.equal(f.downloads(),1);
  const finalId=f.plan.final!.artifactId;await f.service.reviewClip(f.run,f.plan,a.id,artifact.sha256,"ACCEPT",true,f.save);assert.equal(f.plan.final!.artifactId,finalId);
  const qcPath=path.join(f.root,f.run.projectId,qc.relativePath),qcBytes=await fs.readFile(qcPath);await fs.writeFile(qcPath,"changed");
  await assert.rejects(f.service.acceptFinal(f.run,f.plan,f.plan.final!.sha256,true,f.save),/CHANGED/);await fs.writeFile(qcPath,qcBytes);
  await f.service.acceptFinal(f.run,f.plan,f.plan.final!.sha256,true,f.save);assert.equal(f.plan.status,"DELIVERED");assert.equal(f.run.consent,undefined);assert.deepEqual(f.run.attemptIds,[]);
  const deliveryService=new CanvasShortDeliveryService({findById:async(id:string)=>f.records.get(id)??null} as ArtifactRepository,f.root);
  assert.equal(await deliveryService.verifyAccepted(f.plan),true);
  const finalPath=path.join(f.root,f.run.projectId,f.records.get(f.plan.final!.artifactId).relativePath);await fs.writeFile(finalPath,"corrupt");
  assert.equal(await deliveryService.verifyAccepted(f.plan),false);
  assert.doesNotMatch(JSON.stringify(f.saved),/private-short-token/);assert.equal(f.calls.filter(a=>a[1]==="run").length,1);
});
