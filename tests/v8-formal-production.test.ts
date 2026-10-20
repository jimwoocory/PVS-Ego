import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Script as VmScript } from "node:vm";
import type { AddressInfo } from "node:net";
import { FormalV8Production, formalV8Options, voices } from "./v8-production-fixtures.js";
import { MemorySmartRuns } from "./smart-test-support.js";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { runnableSmartStatuses, smartRunSchema, type SmartGenerationRun } from "../src/domain/smart-generation.js";
import { sealV8 } from "../src/domain/v8-production.js";
import { assertV8DecisionBinding, assertV8PromptBinding } from "../src/application/services/v8-production-binding.js";
import { reviewV8DirectorConformance } from "../src/application/services/v8-director-conformance.js";
import { createV8PaidRequestGuard } from "../src/application/services/v8-paid-request-guard.js";
import { ApprovalService } from "../src/application/services/approval-service.js";
import { GenerationPreflightService } from "../src/application/services/generation-preflight.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { VideoProvider } from "../src/application/ports/video-provider.js";
import type { DreaminaAgentCapabilityService } from "../src/application/services/dreamina-agent-capability.js";
import type { CompiledPrompt, GenerationRequest, PreflightReport, WorkflowBlocker, AssetRef } from "../src/domain/schemas.js";
import { handleSmartGenerationHttp } from "../src/web/smart-generation-http.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";
import { hashValue } from "../src/domain/hashing.js";
import { planAutoEdit } from "../src/application/services/auto-edit-planner.js";
import { postProductionSettingsSchema } from "../src/domain/auto-edit.js";
import { assertV8TimelineConformance } from "../src/application/services/v8-timeline-conformance.js";
import { H, ISO } from "./fixtures.js";

async function drain(service: SmartGenerationService, run: SmartGenerationRun) {
  for (let i=0;i<24 && runnableSmartStatuses.includes(run.status);i++) run=await service.advance(run.projectId,run.id);
  return run;
}
async function start() {
  const repo=new MemorySmartRuns(), production=new FormalV8Production(), service=new SmartGenerationService(repo,production);
  const before=process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
  process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING="1";
  let run: SmartGenerationRun;
  try { run=await service.create("project-1","formal-v8",formalV8Options,2); }
  finally { if(before===undefined)delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;else process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING=before; }
  run=await drain(service,run);
  run=await service.review(run.projectId,run.id,{action:"SELECT_CREATIVE",expectedRevision:run.revision,creativeId:"creative-1"});
  run=await drain(service,run);
  run=await service.review(run.projectId,run.id,{action:"CONFIRM_SCRIPT",expectedRevision:run.revision,
    confirmV8Screenplay:true,screenplayHash:run.v8Screenplay!.screenplayHash});
  run=await drain(service,run);
  assert.equal(run.status,"WAITING_FOR_DIRECTOR_REVIEW",run.blocker?.message ?? "director review");
  return {repo,production,service,run};
}
async function planFixture() {
  const f=await start();
  f.run=await f.service.review(f.run.projectId,f.run.id,{action:"CONFIRM_V8_DIRECTOR",expectedRevision:f.run.revision,
    confirmV8Review:true,artifactHash:f.run.v8Director!.contentHash});
  f.run=await drain(f.service,f.run);
  assert.equal(f.run.status,"WAITING_FOR_PLAN_REVIEW",f.run.blocker?.message ?? "plan review");
  return f;
}
async function promptFixture() {
  const f=await planFixture();
  f.run=await f.service.review(f.run.projectId,f.run.id,{action:"CONFIRM_PLAN",expectedRevision:f.run.revision,
    confirmV8Review:true,artifactHash:f.run.productionPlan!.contentHash});
  f.run=await drain(f.service,f.run);
  assert.equal(f.run.status,"WAITING_FOR_PROMPT_REVIEW",f.run.blocker?.message ?? "prompt review");
  f.run=await f.service.compilePromptV8(f.run.projectId,f.run.id,{expectedRevision:f.run.revision,voiceBindings:voices});
  return f;
}
async function adoptedFixture() {
  const f=await promptFixture();
  f.run=await f.service.review(f.run.projectId,f.run.id,{action:"CONFIRM_V8_PROMPTS",expectedRevision:f.run.revision,
    confirmV8Review:true,artifactHash:f.run.v8Prompts!.contentHash});
  return f;
}

test("formal V8 resumes through three explicit adoption gates without V3 or automatic payment",async()=>{
  const f=await start();
  assert.deepEqual(f.run.v8Director!.decision.clips.map(c=>c.durationMs),[5000,5000]);
  assert.equal(f.production.visualCalls,0);
  await assert.rejects(f.service.review(f.run.projectId,f.run.id,{action:"CONFIRM_V8_DIRECTOR",expectedRevision:f.run.revision,artifactHash:f.run.v8Director!.contentHash}),/明确审核/);
  const g=await promptFixture();
  const run=g.run;
  assert.equal(run.v8Prompts!.packages.length,2);
  assert.equal(run.paidScope,undefined);
  assert.equal(g.production.counts.approvals,0);
  assert.equal(g.production.counts.generate,0);
  const restarted=new SmartGenerationService(g.repo,g.production);
  assert.equal((await restarted.advance(run.projectId,run.id)).revision,run.revision);
  await assert.rejects(restarted.review(run.projectId,run.id,{action:"CONFIRM_V8_PROMPTS",expectedRevision:run.revision,confirmV8Review:true,artifactHash:H.f}),/旧哈希/);
  const adopted=await restarted.review(run.projectId,run.id,{action:"CONFIRM_V8_PROMPTS",expectedRevision:run.revision,confirmV8Review:true,artifactHash:run.v8Prompts!.contentHash});
  const ready=await drain(restarted,adopted);
  assert.equal(ready.status,"READY_FOR_PAID_CONFIRM",ready.blocker?.message ?? "paid review");
  assert.equal(ready.paidScope!.v8Binding!.promptRecordHash,ready.v8Prompts!.contentHash);
  assert.equal(ready.consent,undefined);
  assert.equal(g.production.visualCalls,1);
  assert.equal(g.production.counts.director,0,"old V3 director must not run");
});

test("formal V8 multiple director, visual and voice revisions invalidate exact downstream adoption",async()=>{
  const f=await adoptedFixture();
  let run=await drain(f.service,f.run);
  const oldPrompt=run.v8Prompts!.contentHash, oldScope=run.paidScope!.hash;
  run=await f.service.compilePromptV8(run.projectId,run.id,{expectedRevision:run.revision,voiceBindings:{...voices,室友:{...voices.室友,voiceType:"清晰女声，稍有气息"}}});
  assert.equal(run.v8Prompts!.revision,2);
  assert.equal(run.v8Prompts!.status,"DRAFT");
  assert.equal(run.paidScope,undefined);
  assert.notEqual(run.v8Prompts!.contentHash,oldPrompt);
  await assert.rejects(f.service.confirmPaid(run.projectId,run.id,{scopeHash:oldScope,confirmPaidGeneration:true,acceptedUnknownCostRisk:true}),/旧页面|必须明确/);
  await assert.rejects(f.service.review(run.projectId,run.id,{action:"CONFIRM_V8_PROMPTS",expectedRevision:run.revision,confirmV8Review:true,artifactHash:oldPrompt}),/旧哈希/);
  const segment=run.productionPlan!.scenes[0]!.clips[0]!.segments[0]!;
  run=await f.service.updatePlanV8(run.projectId,run.id,{expectedRevision:run.revision,segments:[{id:segment.id,composition:"室友左侧，主人公右侧；保持视线和轴线"}]});
  assert.equal(run.productionPlan!.status,"DRAFT");
  assert.equal(run.v8Prompts,undefined);
  run=await drain(f.service,run);
  assert.equal(run.status,"WAITING_FOR_PLAN_REVIEW");
  run=await f.service.updateDirectorV8(run.projectId,run.id,{expectedRevision:run.revision,visualGuidance:{[run.v8Director!.decision.clips[0]!.shots[0]!.shotId]:"先保持室友左侧视线，暂不明确谜底"}});
  assert.equal(run.v8Director!.revision,2);
  assert.equal(run.v8Director!.status,"DRAFT");
  assert.equal(run.productionPlan,undefined);
  assert.equal(run.paidScope,undefined);
  assert.equal(run.consent,undefined);
  assert.equal(f.repo.history.some(r=>r.v8Prompts?.contentHash===oldPrompt),true);
  assert.doesNotThrow(()=>assertV8DecisionBinding(run));
});

for (const [name,mutate,code] of [
  ["dropped dialogue",(s:any)=>{s.dialogueOrNarration={kind:"NONE"};},"SPEAKER_OR_VOICE_DRIFT"],
  ["wrong actual speaker",(s:any)=>{s.dialogueOrNarration.text='别人：“'+s.v8.spoken.exactText+'”';},"SPEAKER_OR_VOICE_DRIFT"],
  ["extra dialogue",(s:any)=>{s.dialogueOrNarration.text+='新增台词';},"SPEAKER_OR_VOICE_DRIFT"],
  ["early reveal",(s:any)=>{s.v8.audienceKnowledgeChange="提前揭晓";},"REVEAL_TIMING_DRIFT"],
  ["actual action loss despite correct metadata",(s:any)=>{s.subjectAction="另一人直接取走产品";},"ACTION_DRIFT"],
  ["native sound loss",(s:any)=>{s.ambientSound={kind:"NONE"};},"SOUND_DRIFT"]
] as const) test("formal conformance rejects "+name,async()=>{
  const f=await planFixture();
  const plan=structuredClone(f.run.productionPlan!);
  const spoken=plan.scenes.flatMap(s=>s.clips.flatMap(c=>c.segments)).find(s=>s.v8?.spoken)!;
  mutate(spoken);
  assert.ok(reviewV8DirectorConformance(f.run.v8Director!.decision,plan).issues.some(i=>i.code===code));
});
test("formal conformance rejects deleted/duplicated shot and lost or misplaced postproduction cue",async()=>{
  const f=await planFixture();
  for(const mutate of [(c:any)=>c.segments.pop(),(c:any)=>c.segments.push(c.segments[0])]) {
    const plan=structuredClone(f.run.productionPlan!);mutate(plan.scenes[0]!.clips[0]!);
    assert.ok(reviewV8DirectorConformance(f.run.v8Director!.decision,plan).issues.some(i=>i.code==="SHOT_COUNT_DRIFT"));
  }
  for(const mutate of [(s:any)=>s.postProductionText.pop(),(s:any)=>{s.postProductionText[0].startMs=0;}]) {
    const plan=structuredClone(f.run.productionPlan!);const cue=plan.scenes.flatMap(s=>s.clips.flatMap(c=>c.segments)).find(s=>s.postProductionText.length)!;
    mutate(cue);assert.ok(reviewV8DirectorConformance(f.run.v8Director!.decision,plan).issues.some(i=>i.code==="POST_CUE_DRIFT"));
  }
});
test("formal model limits and unavailable native audio block before visual or paid generation",async()=>{
  const f=await start();
  f.production.registry.operations.forEach(o=>o.models.forEach(m=>m.durationMaxSeconds=4));
  await assert.rejects(f.production.buildDirectorV8(f.run),/时间预算|时长/);
  f.production.registry.operations.forEach(o=>o.supportsNativeAudioOutput=false);
  await assert.rejects(f.production.buildDirectorV8(f.run),/原生|声音/);
  assert.equal(f.production.visualCalls,0);assert.equal(f.production.counts.generate,0);
});
test("formal durable hashes reject forged decision, stale asset or plan and unauthorized paid state",async()=>{
  const f=await adoptedFixture();
  assert.throws(()=>smartRunSchema.parse({...f.run,v8Director:{...f.run.v8Director,decision:{...f.run.v8Director!.decision,targetDurationMs:11000}}}),/哈希/);
  assert.throws(()=>smartRunSchema.parse({...f.run,status:"GENERATING"}),/V8 导演|付费|Paid/);
  const plan=structuredClone(f.run.productionPlan!);plan.scenes[0]!.clips[0]!.segments[0]!.composition="内容被改动但未保存";
  assert.throws(()=>assertV8PromptBinding({...f.run,productionPlan:plan}),/哈希/);
  const changed={...f.run.productionAssetSet!,contentHash:H.f};
  assert.throws(()=>assertV8PromptBinding({...f.run,productionAssetSet:changed}),/失效/);
  const d=structuredClone(f.run.v8Director!.decision);d.clips[0]!.shots.pop();
  const {contentHash:_d,...db}=d;const {contentHash:_r,...rb}=f.run.v8Director!;
  assert.throws(()=>assertV8DecisionBinding({...f.run,v8Director:sealV8({...rb,decision:sealV8(db)})}),/不得增删/);
});
test("formal Prompt edit cannot delete locked speech and actor identities cannot be guessed/reused",async()=>{
  const f=await promptFixture();
  await assert.rejects(f.service.compilePromptV8(f.run.projectId,f.run.id,{expectedRevision:f.run.revision,voiceBindings:voices,
    packages:f.run.v8Prompts!.packages.map(p=>({...p,promptText:p.promptText.replace("这是什么？","")}))}),/自由文本/);
  await assert.rejects(f.service.compilePromptV8(f.run.projectId,f.run.id,{expectedRevision:f.run.revision,voiceBindings:{}}),/绑定/);
  await assert.rejects(f.service.compilePromptV8(f.run.projectId,f.run.id,{expectedRevision:f.run.revision,voiceBindings:{...voices,主人公:voices.室友}}),/同一演员/);
});

test("confirmed V8 screenplay can be revised before consent, preserves Beat identity and invalidates all downstream",async()=>{
  const f=await adoptedFixture();
  const old=await drain(f.service,f.run), proposal=structuredClone(old.v8Screenplay!.screenplay);
  proposal.scenes[0]!.beats[0]!.dialogue[0]!.text="这是新物品吗？";
  let run=await f.service.updateV8Screenplay(old.projectId,old.id,{expectedRevision:old.revision,screenplay:proposal});
  assert.equal(run.v8Screenplay!.status,"DRAFT");
  assert.notEqual(run.script!.contentHash,old.script!.contentHash);
  assert.deepEqual(run.script!.beats.map(b=>b.id),old.script!.beats.map(b=>b.id));
  assert.equal(run.v8Director,undefined);assert.equal(run.productionPlan,undefined);assert.equal(run.v8Prompts,undefined);assert.equal(run.paidScope,undefined);
  run=await drain(f.service,run);assert.equal(run.status,"WAITING_FOR_SCRIPT_REVIEW");
  await assert.rejects(f.service.review(run.projectId,run.id,{action:"CONFIRM_SCRIPT",expectedRevision:run.revision,confirmV8Screenplay:true,screenplayHash:old.v8Screenplay!.screenplayHash}),/旧哈希/);
});

test("actual ProductDirector output that drops source speech or changes locked timing blocks closed before installation",async()=>{
  for (const mutate of [(p:any)=>{p.scenes[0].clips[0].segments.find((s:any)=>s.v8.spoken).dialogueOrNarration={kind:"NONE"};},
    (p:any)=>{p.scenes[0].clips[0].segments[0].endMs-=100;}]) {
    const f=await start();f.production.mutateProposal=mutate;
    f.run=await f.service.review(f.run.projectId,f.run.id,{action:"CONFIRM_V8_DIRECTOR",expectedRevision:f.run.revision,confirmV8Review:true,artifactHash:f.run.v8Director!.contentHash});
    const run=await drain(f.service,f.run);
    assert.equal(run.status,"BLOCKED");assert.equal(run.productionPlan,undefined);
    assert.match(run.blocker!.message,/不一致|continuity|Segment|segments/);
    assert.equal(f.production.counts.approvals,0);assert.equal(f.production.counts.generate,0);
  }
});

async function isolatedPreflight(run:SmartGenerationRun,production:FormalV8Production) {
  const compiled:CompiledPrompt[]=[], requests:GenerationRequest[]=[], reports:PreflightReport[]=[], blockers:WorkflowBlocker[]=[];
  const generation={listCompiledPrompts:async()=>compiled,listGenerationRequests:async()=>requests,listCurrentGenerationRequests:async()=>requests,
    listPreflightReports:async()=>reports,listUserApprovals:async()=>[], markSubmissionChainStale:async()=>{},
    saveCompiledPrompt:async(p:CompiledPrompt)=>{compiled.push(p);return p;},createGenerationRequest:async(r:GenerationRequest)=>{requests.push(r);return r;},
    createPreflightReport:async(r:PreflightReport)=>{reports.push(r);return r;}} as unknown as GenerationRepository;
  const workflow={listGenerationAttempts:async()=>[],listOpenBlockers:async()=>blockers,createBlocker:async(b:WorkflowBlocker)=>{blockers.push(b);return b;},resolveBlocker:async()=>{}} as unknown as WorkflowRepository;
  let probes=0,submits=0;
  const provider={id:"domestic-jimeng-cli",probe:async()=>{probes++;return {code:"READY",cliFound:true,identityVerified:true,providerIdentityHash:H.c,
    capabilityFingerprint:H.d, executablePath:"isolated-fixture",executableSha256:H.a,cliVersion:"fixture",supportedModels:["seedance2.0mini"],supportedOperations:["submit","status","download","text2video","multimodal2video"],rawStdout:"",rawStderr:""};},
    accountStatus:async()=>({status:"AUTHENTICATED",availableCredits:100}),estimate:async()=>({status:"KNOWN",estimatedCredits:1}),
    submit:async()=>{submits++;throw Error("PAID SUBMISSION FORBIDDEN IN TEST");}} as unknown as VideoProvider;
  const capability={registry:async()=>production.registry} as unknown as DreaminaAgentCapabilityService;
  const service=new GenerationPreflightService(generation,workflow,provider,async()=>1,"seedance2.0mini",undefined,capability);
  const assets:AssetRef[]=run.productionAssetSet!.entries.map(e=>({id:e.referenceAssetId,type:"image",source:"user_upload",artifactId:e.artifactIds[0]!,sha256:H.a,
    width:1024,height:1024,sizeBytes:1000,mimeType:"image/png",createdAt:ISO}));
  const input={projectId:run.projectId,productTruth:production.c.input.productTruth,creativeBatch:run.creativeBatch!,script:run.script!,productionPlan:run.productionPlan!,
    productionAssetSet:run.productionAssetSet!,v8Run:run,assets,generationSettings:run.options.generationSettings};
  return {service,input,generation,workflow,compiled,requests,reports,counts:()=>({probes,submits})};
}
test("actual Preflight requests preserve adopted V8 prompts/audio/manifests and direct legacy preflight fails closed",async()=>{
  const f=await adoptedFixture(),p=await isolatedPreflight(f.run,f.production);
  const result=await p.service.run(p.input);
  assert.equal(result.requests.length,2);
  assert.ok(result.reports.every(r=>r.status==="PASS"),JSON.stringify(result.reports.map(r=>r.blockers)));
  for(const [i,r] of result.requests.entries()) {
    assert.equal(r.promptText,f.run.v8Prompts!.packages[i]!.promptText);
    assert.equal(r.v8Binding!.promptPackageHash,f.run.v8Prompts!.packages[i]!.contentHash);
    assert.equal(r.generateAudio,true);assert.equal(r.audioPolicy,"V3_NATIVE_NO_BGM");
    assert.match(r.promptText,/禁止生成背景音乐/);
    if (r.assetManifest.length && f.run.v8Prompts?.imageBindingMode === "V1") {
      assert.match(r.promptText, /@图片1/);
      assert.equal(r.imageBindings?.length, r.assetManifest.length);
      assert.deepEqual(r.imageBindings?.map(b=>b.assetId),
        [...r.assetManifest].sort((a,b)=>a.priority-b.priority||a.assetId.localeCompare(b.assetId)).map(a=>a.assetId));
    }
  }
  assert.equal(p.counts().submits,0);
  const priorProbes=p.counts().probes;
  await assert.rejects(p.service.run({...p.input,v8Run:undefined}),/绕过|PromptPackage/);
  assert.equal(p.counts().probes,priorProbes,"review must block before provider probes");
  const tampered=structuredClone(f.run);const current=tampered.v8Prompts!.packages[0]!;
  const {contentHash:_p,...pb}=current;tampered.v8Prompts!.packages[0]=sealV8({...pb,promptText:"已删除台词的坏 Prompt"});
  const {contentHash:_r,...rb}=tampered.v8Prompts!;tampered.v8Prompts=sealV8(rb);
  await assert.rejects(p.service.run({...p.input,v8Run:tampered}),/不一致|语义/);
  assert.equal(p.counts().submits,0);
});
test("new V8 image binding opt-in is version-pinned and preflight uses true input asset hashes", async()=>{
  const before = process.env.PVS_SCENE_CONTINUITY_V1;
  process.env.PVS_SCENE_CONTINUITY_V1 = "1";
  try {
    const f=await adoptedFixture();
    assert.equal(f.run.v8Prompts?.imageBindingMode,"V1");
    const p=await isolatedPreflight(f.run,f.production);
    const dependent=f.run.v8Prompts!.packages.filter(p=>p.incomingContinuity &&
      p.incomingContinuity.relationship!=="SCENE_OR_TIME_JUMP");
    if(dependent.length) await assert.rejects(p.service.run(p.input),/强连续视频必须按实际生成结果逐段预检/);
    const firstWave=f.run.v8Prompts!.packages.filter(p=>
      !p.incomingContinuity || p.incomingContinuity.relationship==="SCENE_OR_TIME_JUMP").map(p=>p.clipId);
    assert.ok(firstWave.length>=1);
    const result=await p.service.run({...p.input,clipIds:firstWave});
    assert.equal(result.requests.length,firstWave.length);
    for(const r of result.requests){
      assert.ok(r.imageBindings?.length,"V8 new mode must pin image number bindings");
      assert.match(r.promptText,/@图片1/);
      assert.equal(r.imageBindings?.[0]?.artifactHash,r.assetManifest[0]?.artifactHash);
    }
    assert.equal(p.counts().submits,0);
  } finally {
    if(before===undefined)delete process.env.PVS_SCENE_CONTINUITY_V1;
    else process.env.PVS_SCENE_CONTINUITY_V1=before;
  }
});
test("ordinary approval POST path cannot authorize a V8 request without exact durable consent",async()=>{
  const f=await adoptedFixture(),p=await isolatedPreflight(f.run,f.production);
  const result=await p.service.run(p.input),request=result.requests[0]!;
  const guard=createV8PaidRequestGuard(f.repo);
  await assert.rejects(guard(request),/本任务精确授权/);
  const approval=new ApprovalService(p.generation,p.workflow,guard);
  await assert.rejects(approval.approveCurrentRequests({projectId:f.run.projectId,acceptedUnknownCostRisk:true,acceptedDuplicateSubmissionRisk:false}),/本任务精确授权/);
  const noGuard=new ApprovalService(p.generation,p.workflow);
  await assert.rejects(noGuard.approveCurrentRequests({projectId:f.run.projectId,acceptedUnknownCostRisk:true,acceptedDuplicateSubmissionRisk:false}),/未配置/);
  assert.equal(p.counts().submits,0);
});

test("exact V8 paid guard accepts only current consent and refuses old package, run and modified actual request",async()=>{
  const f=await adoptedFixture(),p=await isolatedPreflight(f.run,f.production);
  const result=await p.service.run(p.input);
  const plan=f.run.productionPlan!,planRef={entityType:"ProductionPlan",entityId:plan.id,version:plan.version,hash:plan.contentHash};
  const requests=result.requests.map((r,i)=>({requestId:r.id,requestHash:r.requestHash,preflightId:result.reports[i]!.id,preflightHash:result.reports[i]!.reportHash,costStatus:"KNOWN" as const}));
  const v8Binding={runId:f.run.id,screenplayHash:f.run.v8Screenplay!.screenplayHash,directorRecordHash:f.run.v8Director!.contentHash,promptRecordHash:f.run.v8Prompts!.contentHash};
  const paidScope={planRef,requests,v8Binding,hash:hashValue({planRef,requests,v8Binding}),preparedAt:ISO};
  const authorized=smartRunSchema.parse({...f.run,stage:"APPROVAL",status:"APPROVING",paidScope,
    consent:{scopeHash:paidScope.hash,approvedAt:ISO,acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"}});
  f.repo.runs.set(authorized.id,authorized);
  const guard=createV8PaidRequestGuard(f.repo),request=result.requests[0]!;
  await assert.doesNotReject(guard(request));
  await assert.rejects(guard({...request,promptText:"删改台词"}),/失效/);
  await assert.rejects(guard({...request,v8Binding:{...request.v8Binding!,promptPackageHash:H.f}}),/失效/);
  await assert.rejects(guard({...request,v8Binding:{...request.v8Binding!,runId:"other-run"}}),/精确授权/);
  const approval=new ApprovalService(p.generation,p.workflow,guard);
  await assert.rejects(approval.approveCurrentRequests({projectId:f.run.projectId,acceptedUnknownCostRisk:true,acceptedDuplicateSubmissionRisk:false,reuseMatchingApprovals:true}),/复用旧付费/);
  assert.equal(p.counts().submits,0);
});
test("formal same-page UI exposes semantic decisions, real segments and voice/prompt adoption with valid browser JS",async()=>{
  const f=await promptFixture();
  const page=renderSmartGenerationPage({project:{id:f.run.projectId,name:"隔离测试",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:10000,aspectRatio:"16:9",createdAt:ISO,updatedAt:ISO}},[f.run]);
  for(const value of ["完整创作工作流","观众此刻获知","data-action=\"plan-v8\"","data-action=\"prompts-v8\"","CONFIRM_V8_PROMPTS","说话人身份绑定","请按说明使用"])assert.ok(page.includes(value),value);
  assert.doesNotMatch(page,/data-action="paid"/);
  for(const script of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new VmScript(script[1]!);
});
test("V8 actual auto-edit carries all post cues and native voice; final timeline blocks deletion, retiming, skip and muting",async()=>{
  const f=await adoptedFixture(),run=f.run;
  const sources=run.productionPlan!.scenes.flatMap(s=>s.clips).map((clip,i)=>({clip,attemptId:"fixture-attempt-"+i,
    artifact:{id:"fixture-output-"+i,projectId:run.projectId,kind:"GENERATED_VIDEO" as const,relativePath:"fixture-"+i+".mp4",sha256:H.a,sizeBytes:10,mimeType:"video/mp4",integrityStatus:"READY" as const,immutable:true as const,createdAt:ISO},
    media:{durationMs:clip.durationMs,width:1280,height:720,hasVideo:true,hasAudio:true}}));
  const input={operationKey:H.e,truth:f.production.c.input.productTruth,script:run.script!,plan:run.productionPlan!,sources,audio:[],
    settings:postProductionSettingsSchema.parse({narrationMode:"SOURCE_ONLY",sourceVolume:1,allowSilentOutput:false}),targetDurationMs:10000,now:ISO};
  const result=planAutoEdit(input);
  assert.equal(result.actualDurationMs,10000);
  assert.ok(result.timeline.textItems.some(t=>t.text==="请按说明使用"));
  assert.doesNotThrow(()=>assertV8TimelineConformance(run.productionPlan!,result.timeline));
  for (const mutate of [(t:any)=>{t.textItems.find((t:any)=>t.text==="请按说明使用").deleted=true;},
    (t:any)=>{t.textItems.find((t:any)=>t.text==="产品名称").startMs+=100;},(t:any)=>{t.clips[0].deleted=true;},
    (t:any)=>{t.clips[0].audio.muted=true;}]) {
    const timeline=structuredClone(result.timeline);mutate(timeline);
    assert.throws(()=>assertV8TimelineConformance(run.productionPlan!,timeline),/V8/);
  }
  const noAudio=structuredClone(input);noAudio.sources[0]!.media.hasAudio=false;
  assert.throws(()=>planAutoEdit(noAudio),/原生对白/);
});
test("formal V8 HTTP actions require POST, exact revision/hash and strict editable fields/project isolation",async()=>{
  const f=await start();
  const server=http.createServer((req,res)=>void handleSmartGenerationHttp(req,res,new URL(req.url!,"http://127.0.0.1"),
    {smartGeneration:f.service} as Parameters<typeof handleSmartGenerationHttp>[3]).catch(e=>{res.writeHead(400);res.end(JSON.stringify({message:String(e)}));}));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const base="http://127.0.0.1:"+(server.address() as AddressInfo).port+"/api/projects/"+f.run.projectId+"/smart-runs/"+f.run.id;
    for(const action of ["director-v8","plan-v8","prompts-v8"])assert.equal((await fetch(base+"/"+action)).status,405);
    const post=(url:string,body:unknown)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await post(base+"/director-v8",{expectedRevision:f.run.revision-1,visualGuidance:{}})).status,400);
    assert.equal((await post(base+"/plan-v8",{expectedRevision:f.run.revision,segments:[{id:"fake",subjectAction:"删除台词"}]})).status,400);
    assert.equal((await post(base+"/review",{action:"CONFIRM_V8_DIRECTOR",expectedRevision:f.run.revision,confirmV8Review:true,artifactHash:H.f})).status,400);
    assert.equal((await post(base.replace("/projects/project-1/","/projects/other/")+"/director-v8",{expectedRevision:f.run.revision,visualGuidance:{}})).status,400);
    assert.equal((await f.service.get(f.run.projectId,f.run.id))!.revision,f.run.revision);
    assert.equal(f.production.counts.generate,0);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test("V8 continuity orchestration requires a separate consent per batch and waits for human source review",async()=>{
  const savedFlag=process.env.PVS_SCENE_CONTINUITY_V1;
  process.env.PVS_SCENE_CONTINUITY_V1="1";
  try {
    const f=await adoptedFixture();
    const first=f.run.v8Prompts!.packages[0]!.clipId;
    const second=f.run.v8Prompts!.packages[1]!.clipId;
    const previous=f.run.v8Prompts!.packages[1]!;
    const {contentHash:_oldPkg,...pkgBase}=previous;
    const updatedPkg=sealV8({...pkgBase,incomingContinuity:{
      sourceClipId:first,relationship:"HARD_CONTINUITY" as const,
      plannedSourceEndStateHash:H.a,plannedTargetStartStateHash:H.a,
      contractHash:H.b,requiresHardFirstFrame:true
    }});
    const {contentHash:_oldRecord,...recordBase}=f.run.v8Prompts!;
    const prompts=sealV8({...recordBase,packages:[f.run.v8Prompts!.packages[0]!,updatedPkg]});
    const original=smartRunSchema.parse({...f.run,v8Prompts:prompts});
    f.repo.runs.set(original.id,original);
    f.production.validatePromptsV8=async()=>{};
    let humanAccepted=false;
    let prepared=0,approved=0,generated=0;
    f.production.preparePaidScope=async run=>{
      const wave=(run.completedContinuityWaves?.length??0)+1;
      if(wave>2)throw Error("unexpected third paid batch");
      if(wave===2&&!humanAccepted)throw new (await import("../src/application/ports/smart-production.js")).SmartFlowPause(
        "WAITING_FOR_CLIP_REVIEW","CONTINUITY_SOURCE_REVIEW_REQUIRED",
        "first source requires explicit human ACCEPT");
      prepared++;
      const plan=run.productionPlan!;
      const planRef={entityType:"ProductionPlan",entityId:plan.id,version:plan.version,hash:plan.contentHash};
      const requests=[{requestId:"request-"+wave,requestHash:wave===1?H.a:H.b,
        preflightId:"preflight-"+wave,preflightHash:H.c,costStatus:"UNKNOWN" as const}];
      const v8Binding={runId:run.id,screenplayHash:run.v8Screenplay!.screenplayHash,
        directorRecordHash:run.v8Director!.contentHash,promptRecordHash:run.v8Prompts!.contentHash};
      const continuityBatch={wave,clipIds:[wave===1?first:second]};
      return {planRef,requests,v8Binding,continuityBatch,preparedAt:ISO,
        hash:hashValue({planRef,requests,v8Binding,continuityBatch})};
    };
    f.production.approve=async run=>{
      if(!run.consent||run.consent.scopeHash!==run.paidScope?.hash)throw Error("scope mismatch");
      approved++;
      return ["attempt-"+run.paidScope!.continuityBatch!.wave];
    };
    f.production.generate=async run=>{
      generated++;
      const wave=run.paidScope!.continuityBatch!.wave;
      assert.deepEqual(run.activeBatchAttemptIds,["attempt-"+wave],
        "worker may only poll and submit current independent consent scope");
      return {done:true};
    };
    f.production.reviewClips=async()=>{};
    let run=await f.service.advance(original.projectId,original.id);
    assert.equal(run.status,"READY_FOR_PAID_CONFIRM");
    assert.deepEqual(run.paidScope!.continuityBatch!.clipIds,[first]);
    const scope1=run.paidScope!.hash;
    run=await f.service.confirmPaid(run.projectId,run.id,{
      scopeHash:scope1,confirmPaidGeneration:true,acceptedUnknownCostRisk:true
    });
    run=await f.service.advance(run.projectId,run.id);
    assert.deepEqual(run.attemptIds,["attempt-1"]);
    run=await f.service.advance(run.projectId,run.id);
    assert.equal(run.stage,"CLIP_REVIEW");
    assert.equal(run.completedContinuityWaves?.length,1);
    run=await f.service.advance(run.projectId,run.id);
    assert.equal(run.status,"WAITING_FOR_CLIP_REVIEW");
    assert.equal(approved,1);
    const unchanged=await f.service.confirmPaid(run.projectId,run.id,{
      scopeHash:scope1,confirmPaidGeneration:true,acceptedUnknownCostRisk:true
    });
    assert.equal(unchanged.revision,run.revision);
    assert.equal(unchanged.status,"WAITING_FOR_CLIP_REVIEW","replaying old consent is idempotent, not a new approval");
    humanAccepted=true;
    run=await f.service.resume(run.projectId,run.id);
    run=await f.service.advance(run.projectId,run.id);
    assert.equal(run.status,"READY_FOR_PAID_CONFIRM");
    assert.notEqual(run.paidScope!.hash,scope1);
    assert.equal(run.consent,undefined,"first paid consent must never authorize second wave");
    assert.deepEqual(run.paidScope!.continuityBatch!.clipIds,[second]);
    assert.deepEqual(run.attemptIds,["attempt-1"]);
    run=await f.service.confirmPaid(run.projectId,run.id,{
      scopeHash:run.paidScope!.hash,confirmPaidGeneration:true,acceptedUnknownCostRisk:true
    });
    run=await f.service.advance(run.projectId,run.id);
    assert.deepEqual(run.attemptIds,["attempt-1","attempt-2"]);
    assert.deepEqual(run.activeBatchAttemptIds,["attempt-2"]);
    run=await f.service.advance(run.projectId,run.id);
    assert.equal(run.completedContinuityWaves?.length,2);
    run=await f.service.advance(run.projectId,run.id);
    assert.equal(run.stage,"AUTO_EDIT");
    assert.equal(run.status,"AUTO_EDITING");
    assert.equal(approved,2);
    assert.equal(generated,2);
    assert.equal(prepared,2);
  } finally {
    if(savedFlag===undefined)delete process.env.PVS_SCENE_CONTINUITY_V1;
    else process.env.PVS_SCENE_CONTINUITY_V1=savedFlag;
  }
});
