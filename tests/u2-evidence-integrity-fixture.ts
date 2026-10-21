// Actual blank Prisma under the original guard. All semantic responses are inert fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {PrismaArtifactRepository} from "../src/adapters/db/prisma-artifact-repository.js";
import {PrismaReferenceVideoRepository} from "../src/adapters/db/prisma-reference-video-repository.js";
import {ReferenceVideoAnalysisService} from "../src/application/services/reference-video-analysis.js";
import {AiGenerationService} from "../src/application/services/ai-generation.js";
import {HermesProductDirectorGenerator} from "../src/adapters/ai/hermes-product-director-generator.js";
import {ProductDirectorService} from "../src/application/services/product-director.js";
import {LocalArtifactStore} from "../src/adapters/store/local-artifact-store.js";
import {hashValue,sha256Bytes} from "../src/domain/hashing.js";
import {directorCase} from "./model-aware-fixtures.js";
import {confirmScriptDraft} from "../src/application/services/review-actions.js";
import {observationsForDouyinPage} from "../src/application/services/douyin-read-evidence-audit.js";
import {assertEvidenceScope} from "../src/domain/douyin-feedback-validation.js";
import {DouyinCreativeFeedbackService} from "../src/application/services/douyin-creative-feedback-service.js";
import {PrismaDouyinOpsRepository} from "../src/adapters/db/prisma-douyin-ops-repository.js";

const db=new PrismaClient(),artifacts=new PrismaArtifactRepository(db),repo=new PrismaReferenceVideoRepository(db);
const root=process.env.PROJECTS_ROOT!,session=process.env.PVS_ISOLATION_SESSION!;
const manifest=JSON.parse(await fs.readFile(path.join(session,"media-manifest.json"),"utf8"));
assert.equal(manifest.contract,"LOCAL_SYNTHETIC_DECODED_MEDIA_ONLY");
const requests:any[]=[];let invalidSamples="",mutateAfter:undefined|(()=>Promise<void>),complianceOnly=false,directorProposal:any;
const rehash=(value:any)=>{const {contentHash,...body}=value;return {...body,contentHash:hashValue(body)};};
const runtime={id:"FIXED_IN_PROCESS_TEST_DOUBLE_NO_MODEL",version:"1",async generateJson(request:any){
 requests.push(structuredClone(request));
 const compliance=request.task.startsWith("Check whether product-video content");
 if(mutateAfter&&(!complianceOnly||compliance)){const mutate=mutateAfter;mutateAfter=undefined;await mutate();}
 if(compliance)return {violations:[]};
 if(request.context.step==="REFERENCE_VIDEO_ANALYSIS")return {analysisConfidence:"MEDIUM",hook:{firstThreeSecondsPattern:"合成色块",structuralPurpose:"本地验证"},pacing:{overall:"合成画面",estimatedShotCount:1},shotLanguage:{shotSizes:["全景"],cameraPositions:["正面"],cameraMovements:[],compositionPatterns:["色块"]},productAppearance:{firstAppearanceMs:null,visibilityPattern:"无真实产品",showcasePattern:"无"},sellingPointPattern:[],dialogueNarrationStructure:"invented speech",audioBgMusicStructure:"invented music",ctaPattern:"无",reusableStylePrinciples:["仅结构参考"],frameObservations:request.input.sampledFrames.slice(0,-2).map((f:any,i:number)=>({timestampMs:f.timestampMs,observation:"合成色块",visibleText:i===1?"L0CAL":"LOCAL",confidence:i===1?"LOW":"HIGH",textStatus:i===1?"UNCERTAIN":"READABLE"}))};
 if(request.context.step==="CREATIVE")return {concepts:Array.from({length:4},(_,i)=>({title:"合成候选"+i,targetAudience:"本地验收",painPoint:"输入绑定",hook:"先呈现情境",coreSellingPoint:"Feature one",narrativePattern:"情境展示",expectedDurationMs:15000,productShowcaseStrategy:"保留产品",generationRisk:"LOW",requiredFactIds:["fact-1"]}))};
 if(request.context.step==="SCRIPT")return {beats:[{purpose:"PRODUCT",text:"Feature one",estimatedDurationMs:15000,requiredFactIds:["fact-1"]}]};
 if(request.context.step==="DIRECTOR")return directorProposal;
 throw Error("UNEXPECTED_FIXTURE_REQUEST");
}};
const media:any={async probeReferenceVideo(file:string){assert.equal(sha256Bytes(await fs.readFile(file)),manifest.sha256);return manifest.info;},async sampleReferenceFrames(input:any){
 assert.equal(sha256Bytes(await fs.readFile(input.filePath)),manifest.sha256);
 if(invalidSamples==="empty")return [];
 const frames=manifest.frames.map((f:any)=>({...f}));
 for(const frame of frames)assert.equal(sha256Bytes(await fs.readFile(frame.path)),frame.sha256);
 if(invalidSamples==="duplicate")frames[1].timestampMs=frames[0].timestampMs;
 return frames;
},async createReferenceVideoBrowserPreview(){throw Error("UNEXPECTED_PREVIEW");}};
const service=new ReferenceVideoAnalysisService(repo,artifacts,runtime,root,media);
const verify=(profile:any,projectId:string)=>service.assertCurrentEvidence(profile,projectId);
const ai=new AiGenerationService(runtime,undefined,undefined,verify);
async function seed(analyze=true){
 const projectId="u2-evidence-"+randomUUID();
 await db.project.create({data:{id:projectId,name:"仅合成媒体证据",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});
 const store=new LocalArtifactStore(path.join(root,projectId),artifacts);
 const artifact=await store.writeImmutable({id:randomUUID(),projectId,kind:"OTHER",relativePath:"reference-video/synthetic.mp4",bytes:await fs.readFile(manifest.file),mimeType:"video/mp4",immutable:true});
 const profile=analyze?await service.analyzeUpload({projectId,artifactId:artifact.id}):undefined;
 return {projectId,artifact,profile};
}
async function corrupt(projectId:string,kind:string){
 const p=(await repo.latestActive(projectId))!,frame=p.observation!.frames[1]!,ref=p.observation!.samplingManifest!;
 const target=await artifacts.findById(kind==="source"?p.videoArtifactId:kind.startsWith("manifest")?ref.artifactId:frame.artifactId);
 assert.ok(target);const file=path.join(root,projectId,target.relativePath);
 if(["source","frame","manifest"].includes(kind))await fs.appendFile(file,"changed");
 else if(kind==="missing")await fs.unlink(file);
 else if(kind==="size")await db.artifactRecord.update({where:{id:target.id},data:{sizeBytes:target.sizeBytes!+1}});
 else if(kind==="mime")await db.artifactRecord.update({where:{id:target.id},data:{mimeType:"image/png"}});
 else if(kind==="status")await artifacts.markMissing(target.id);
 else if(kind==="mutable")await db.artifactRecord.update({where:{id:target.id},data:{immutable:false}});
 else if(kind==="path")await db.artifactRecord.update({where:{id:target.id},data:{relativePath:"../../escape.jpg"}});
 else if(kind==="row")await db.referenceVideoProfileRecord.update({where:{id:p.id},data:{contentHash:"0".repeat(64)}});
 else if(kind==="stale")await service.deactivate(projectId);
 else if(kind==="no-manifest"||kind==="timing"){
  const changed=structuredClone(p);
  if(kind==="no-manifest")delete changed.observation!.samplingManifest;
  else {changed.observation!.frames[1]!.timestampMs++;changed.observation!.frameObservations[1]!.timestampMs++;}
  const value=rehash(changed);await db.referenceVideoProfileRecord.update({where:{id:p.id},data:{dataJson:JSON.stringify(value),contentHash:value.contentHash}});
 }
}
function downstreamInputs(projectId:string,profile:any,withRules=false){
 const c=directorCase(15000),truth=rehash({...c.input.productTruth,projectId,...(withRules?{usageRules:[{id:"synthetic-rule",category:"USAGE_METHOD",polarity:"MUST",statement:"遵守合成用途",sourceType:"user",confidence:"HIGH",status:"CONFIRMED",dispositionConfirmedByUser:true}]}:{})});
 const ref={entityType:"ReferenceVideoProfile",entityId:profile.id,version:profile.version,hash:profile.contentHash};
 const batch=rehash({...c.input.creativeBatch,projectId,referenceVideoProfileRef:ref,productTruthRef:{entityType:"ProductTruth",entityId:truth.id,version:truth.version,hash:truth.contentHash}});
 const script=rehash({...c.input.script,projectId,referenceVideoProfileRef:ref,productTruthRef:batch.productTruthRef,creativeBatchRef:{entityType:"CreativeBatch",entityId:batch.id,version:batch.version,hash:batch.contentHash}});
 return {c,truth,batch,script};
}
async function downstream(projectId:string,stage:string,profile:any,noVerifier=false,withRules=false){
 const {c,truth,batch,script}=downstreamInputs(projectId,profile,withRules);
 const generator=noVerifier?new AiGenerationService(runtime):ai;
 if(stage==="CREATIVE")return generator.generateCreativeBatch(truth,2,15000,profile);
 if(stage==="SCRIPT")return generator.generateScriptDraft({truth,batch,selectedCreativeId:batch.concepts[0]!.id,version:2,targetDurationMs:15000,referenceVideoProfile:profile});
 directorProposal=c.proposal;
 return new ProductDirectorService(new HermesProductDirectorGenerator(runtime,noVerifier?undefined:verify),withRules?runtime:undefined,undefined,noVerifier?undefined:verify).generate({...c.input,productTruth:truth,creativeBatch:batch,script,referenceVideoProfile:profile});
}
async function chain(projectId:string){
 const p=(await service.latest(projectId))!,{c,truth}=downstreamInputs(projectId,p),begin=requests.length;
 const batch=await ai.generateCreativeBatch(truth,2,15000,p);
 const script=confirmScriptDraft(await ai.generateScriptDraft({truth,batch,selectedCreativeId:batch.concepts[0]!.id,version:2,targetDurationMs:15000,referenceVideoProfile:p}));
 directorProposal=structuredClone(c.proposal);directorProposal.scenes[0].sourceBeatIds=[script.beats[0]!.id];
 for(const clip of directorProposal.scenes.flatMap((s:any)=>s.clips)){clip.sourceBeatIds=[script.beats[0]!.id];for(const segment of clip.segments)segment.sourceBeatIds=[script.beats[0]!.id];}
 const plan=await new ProductDirectorService(new HermesProductDirectorGenerator(runtime,verify),undefined,undefined,verify).generate({...c.input,productTruth:truth,creativeBatch:batch,selectedCreativeId:batch.concepts[0]!.id,script,referenceVideoProfile:p});
 for(const entity of [batch,script,plan])assert.deepEqual(entity.referenceVideoProfileRef,{entityType:"ReferenceVideoProfile",entityId:p.id,version:p.version,hash:p.contentHash});
 for(const request of requests.slice(begin)){assert.deepEqual(request.input.referenceVideoProfile.observation,p.observation);assert.ok(!request.media?.length);assert.match(request.instructions,/audio NOT_OBSERVED/);}
 return {stages:requests.slice(begin).map(r=>r.context.step),refs:[batch,script,plan].map(v=>v.referenceVideoProfileRef),observation:p.observation};
}
async function operationsChecks(){
 const awemeId="7900000000000000001",parentCid="1001",now=new Date().toISOString();
 const page:any={comments:[{cid:"2001",awemeId,parentCid,text:"合成问题",nickname:"合成",diggCount:0,replyCount:0}],cursor:"2",hasMore:false,readEvidence:{version:"douyin-read-page-v1",kind:"REPLIES",awemeId,parentCid,requestCursor:"1",count:20,observedAt:now,raw:{status_code:0,cursor:2,has_more:0,comments:[{cid:"2001",aweme_id:awemeId,reply_id:parentCid,text:"合成问题"}]}}};
 const scope={awemeId,parentCid,requestCursor:"1",count:20},audit=observationsForDouyinPage(page,scope);
 assert.equal(audit.observations.get("2001")!.counts.diggCount.status,"UNKNOWN");assert.equal(audit.coverage.status,"UNKNOWN");
 for(const field of ["text","reply_id"]){const bad=structuredClone(page);bad.readEvidence.raw.comments[0][field]=field==="text"?"错误":"999";assert.throws(()=>observationsForDouyinPage(bad,scope),/对照失败/);}
 const missing=structuredClone(page);delete missing.readEvidence.raw.comments[0].text;assert.throws(()=>observationsForDouyinPage(missing,scope),/对照失败/);
 const {projectId}=await seed(false),ops=new PrismaDouyinOpsRepository(db),truth=rehash({...directorCase(15000).input.productTruth,projectId}),truthHash=truth.contentHash,bindingId=randomUUID();
 await ops.upsertWorkBinding({id:bindingId,projectId,awemeId,opsAccountUid:"synthetic-account",source:"HISTORICAL_WORK",status:"BOUND",confidence:"USER_CONFIRMED",boundAt:now,createdAt:now,updatedAt:now});
 const observation:any={version:"u5-observation-v1",projectId,bindingId,awemeId,opsAccountUid:"synthetic-account",productTruthHash:truthHash,window:{start:now,end:now,basis:"SAVED_OBSERVATION_TIMES",continuous:false},coverage:{status:"PARTIAL",platformCoverage:"UNKNOWN",metrics:{selection:"LATEST_SAVED",limit:100,count:1,capped:false},comments:{selection:"LATEST_SAVED",limit:500,count:0,capped:false},collectionScopes:[],scopesCapped:false,collectionEvidenceAvailable:false},metrics:[{evidenceRef:"metric:synthetic",contentHash:"b".repeat(64),capturedAt:now,values:{likes:0},availability:{likes:"OBSERVED",plays:"NOT_VISIBLE"}}],comments:[],unavailableMetrics:{completionRate:"NOT_AVAILABLE",conversionRate:"NOT_AVAILABLE",sales:"NOT_AVAILABLE"},interpretation:"CORRELATION_ONLY_NOT_CAUSAL",applicability:"METHOD_HYPOTHESIS_ONLY_NOT_PRODUCT_FACT_OR_BUSINESS_EFFECT"};
 const insight:any={id:randomUUID(),projectId,bindingId,awemeId,productTruthHash:truthHash,metricSnapshotIds:["synthetic"],commentIds:[],evidenceHash:hashValue(observation),observationEvidence:observation,summary:"仅合成待审方法",strengths:[],weaknesses:[],audienceQuestions:[],nextCreativeActions:[{text:"下一轮可尝试提出问题，效果待验证",claimType:"METHOD_HYPOTHESIS",evidenceRefs:["metric:synthetic"]}],runtimeId:"LOCAL_FIXTURE_NO_MODEL",runtimeVersion:"1",createdAt:now};
 await ops.createInsight(insight);
 const frozen=(await db.versionedEntity.findFirst({where:{projectId,entityType:"DouyinInsightEvidence",entityKey:insight.id}}))!;
 const feedback=new DouyinCreativeFeedbackService(ops,{async getWorkspace(){return {productTruth:{status:"CONFIRMED",contentHash:truthHash},project:{currentProductTruthRef:{hash:truthHash}}} as any;}});
 assert.deepEqual(await feedback.context(projectId),[]);
 await assert.rejects(feedback.promote({projectId,insightId:insight.id,actionIndex:0,confirmed:false}),/明确确认/);
 const adopted=await feedback.promote({projectId,insightId:insight.id,actionIndex:0,confirmed:true});
 assert.equal((await feedback.context(projectId))[0]!.evidenceHash,insight.evidenceHash);
 for(const kind of ["duplicate","count","window","visibility"]){
  const bad=structuredClone(observation);
  if(kind==="duplicate"){bad.metrics.push({...bad.metrics[0]});bad.coverage.metrics.count=2;}
  if(kind==="count")bad.coverage.metrics.count=2;
  if(kind==="window")bad.metrics[0].capturedAt="2020-01-01T00:00:00.000Z";
  if(kind==="visibility")bad.metrics[0].values.plays=0;
  const changed={...insight,observationEvidence:bad,evidenceHash:hashValue(bad)};
  assert.throws(()=>assertEvidenceScope(bad,changed));
  // Persist independently rehashed tampering: active feedback must still refuse it.
  await db.douyinInsightRecord.update({where:{id:insight.id},data:{evidenceHash:changed.evidenceHash}});
  await db.versionedEntity.update({where:{id:frozen.id},data:{dataJson:JSON.stringify(bad),contentHash:changed.evidenceHash}});
  await assert.rejects(feedback.context(projectId));
 }
 await db.douyinInsightRecord.update({where:{id:insight.id},data:{evidenceHash:insight.evidenceHash}});
 await db.versionedEntity.update({where:{id:frozen.id},data:{dataJson:JSON.stringify(observation),contentHash:insight.evidenceHash}});
 const creative=new AiGenerationService(runtime,undefined,p=>feedback.context(p));
 const candidate=await creative.generateCreativeBatch(truth,2,15000);
 assert.equal(candidate.douyinFeedbackReceipt!.items[0]!.feedbackId,adopted.id);
 mutateAfter=async()=>{await feedback.deactivate({projectId,feedbackId:adopted.id,confirmed:true});};
 await assert.rejects(creative.generateCreativeBatch(truth,3,15000),/反馈发生变化/);
 await feedback.deactivate({projectId,feedbackId:adopted.id,confirmed:true});assert.deepEqual(await feedback.context(projectId),[]);
 return {rawTextAndParentVerified:true,missingCounts:"UNKNOWN",coverage:"UNKNOWN",adoption:"SYNTHETIC_EXPLICIT_ONLY",tamperedFrozenEvidenceRejected:["duplicate","count","window","visibility"],candidateHasActualFeedbackReceipt:true,deactivationDuringGenerationRejected:true,deactivatedExcluded:true};
}
async function command(m:any){
 if(m.op==="seed")return seed();
 if(m.op==="latest")return service.latest(m.projectId);
 if(m.op==="cache")return service.analyzeUpload({projectId:m.projectId,artifactId:m.artifactId});
 if(m.op==="corrupt")return corrupt(m.projectId,m.kind);
 if(m.op==="downstream")return downstream(m.projectId,m.stage,m.profile,m.noVerifier);
 if(m.op==="chain")return chain(m.projectId);
 if(m.op==="invalid-sample"){
  const f=await seed(false);invalidSamples=m.kind;const before=requests.length;
  try{await assert.rejects(service.analyzeUpload({projectId:f.projectId,artifactId:f.artifact.id}));}finally{invalidSamples="";}
  assert.equal(requests.length,before);assert.equal(await repo.latestActive(f.projectId),null);return true;
 }
 if(m.op==="analysis-race"){
  const f=await seed(false);mutateAfter=()=>fs.appendFile(path.join(root,f.projectId,f.artifact.relativePath),"changed");
  await assert.rejects(service.analyzeUpload({projectId:f.projectId,artifactId:f.artifact.id}));assert.equal(await repo.latestActive(f.projectId),null);return true;
 }
 if(m.op==="downstream-race"){
  const f=await seed();mutateAfter=()=>corrupt(f.projectId,"frame");const before=requests.length;
  await assert.rejects(downstream(f.projectId,m.stage,f.profile));assert.equal(requests.length,before+1);return true;
 }
 if(m.op==="compliance-race"){
  const f=await seed();complianceOnly=true;mutateAfter=()=>corrupt(f.projectId,"frame");const before=requests.length;
  try{await assert.rejects(downstream(f.projectId,m.stage,f.profile,false,true),/证据/);}finally{complianceOnly=false;mutateAfter=undefined;}
  assert.equal(requests.length,before+2);assert.match(requests.at(-1).task,/Check whether/);return true;
 }
 if(m.op==="operations")return operationsChecks();
 if(m.op==="director-output-ref"){
  const f=await seed(),plan=await downstream(f.projectId,"DIRECTOR",f.profile),{c,truth,batch,script}=downstreamInputs(f.projectId,f.profile);
  for(const kind of ["missing","wrong"]){
   const changed:any=structuredClone(plan);if(kind==="missing")delete changed.referenceVideoProfileRef;else changed.referenceVideoProfileRef.hash="0".repeat(64);
   const generator={id:"INERT_CUSTOM_DIRECTOR",version:"1",async generate(){return changed;}};
   await assert.rejects(new ProductDirectorService(generator,undefined,undefined,verify).generate({...c.input,productTruth:truth,creativeBatch:batch,script,referenceVideoProfile:f.profile}),/参考视频/);
  }return true;
 }
 if(m.op==="state")return {requests,modelCalls:0,providerConfigs:await db.aiProviderConfigRecord.count(),aiExecutions:await db.aiExecutionRecord.count(),guard:(globalThis as any)[Symbol.for("pvs.isolation.boundary.v1")].counters()};
 if(m.op==="close"){await db.$disconnect();setTimeout(()=>process.exit(0),20);return true;}
 throw Error("UNEXPECTED_COMMAND");
}
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);void command(m).then(result=>console.log(JSON.stringify({requestId:m.requestId,result})),error=>console.log(JSON.stringify({requestId:m.requestId,error:String(error)})));});
console.log(JSON.stringify({ready:true}));
