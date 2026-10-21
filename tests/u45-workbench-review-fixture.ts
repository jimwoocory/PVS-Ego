// Guarded, actual blank Prisma. Runtime observations are fixed local functions, no network/model.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {PrismaDouyinOperationsScheduleRepository} from "../src/adapters/db/prisma-douyin-operations-schedule-repository.js";
import {PrismaDouyinOpsRepository} from "../src/adapters/db/prisma-douyin-ops-repository.js";
import {PrismaDouyinCollectionRepository} from "../src/adapters/db/prisma-douyin-collection-repository.js";
import {DouyinOperationsScheduleService} from "../src/application/services/douyin-operations-schedule-service.js";
import {DouyinCollectionService} from "../src/application/services/douyin-collection-service.js";
import {DouyinCommentService} from "../src/application/services/douyin-comment-service.js";
import {DouyinMetricService} from "../src/application/services/douyin-metric-service.js";
import {DouyinOpsRuntimeError} from "../src/application/ports/douyin-ops-runtime.js";
import {PvsAgentCapabilities} from "../src/application/services/pvs-agent-capabilities.js";
import {DouyinRetrospectiveService} from "../src/application/services/douyin-retrospective-service.js";
import {DouyinCreativeFeedbackService} from "../src/application/services/douyin-creative-feedback-service.js";
import {PrismaProductFlowRepository} from "../src/adapters/db/prisma-product-flow-repository.js";
import {ProductFlowService} from "../src/application/services/product-flow.js";
import {AiGenerationService} from "../src/application/services/ai-generation.js";
import {PrismaArtifactRepository} from "../src/adapters/db/prisma-artifact-repository.js";
import {directorCase} from "./model-aware-fixtures.js";
import {hashValue,sha256Bytes} from "../src/domain/hashing.js";
import {OperationsEvidenceReader} from "../src/application/services/operations-evidence-reader.js";
import {createAppServer} from "../src/web/server.js";
import {PrismaAgentCycleRepository} from "../src/adapters/db/prisma-agent-cycle-repository.js";
import {AgentCycleService} from "../src/application/services/agent-cycle-service.js";
import {PrismaPublishRepository} from "../src/adapters/db/prisma-publish-repository.js";
import {PrismaWorkflowRepository} from "../src/adapters/db/prisma-workflow-repository.js";
import {LocalArtifactStore} from "../src/adapters/store/local-artifact-store.js";

const db=new PrismaClient(),ops=new PrismaDouyinOpsRepository(db),schedules=new PrismaDouyinOperationsScheduleRepository(db),runs=new PrismaDouyinCollectionRepository(db);
const session=process.env.PVS_ISOLATION_SESSION!,evidence=path.join(session,"evidence"),uid="synthetic-operations-uid";
let clock=Date.now(),mode:any={},account=uid,held:undefined|(()=>void),forbiddenModelCalls=0;
const emit=(v:unknown)=>console.log(JSON.stringify(v));
const log=async(v:any)=>{await fs.appendFile(path.join(evidence,"reads.jsonl"),JSON.stringify({...v,pid:process.pid,at:new Date(clock).toISOString()})+"\n");};
const die=(point:string)=>{emit({crashing:point});process.exit(73);};
async function before(kind:string,args:any){
 await log({kind,...args});
 if(mode.crash===kind)die(kind);
 if(mode.hold===kind){emit({held:kind});await new Promise<void>(resolve=>held=resolve);}
 if(mode.failure===kind)throw new DouyinOpsRuntimeError(mode.code??"PROVIDER_ERROR","本地固定读取错误");
}
const runtime:any={async identity(){return {uid:account};},async getWork(awemeId:string){
 await before("METRICS",{awemeId});
 return {awemeId,author:{uid},description:"合成作品",publishedAt:null,durationMs:15000,externalUrl:"",metrics:{likes:0},metricAvailability:{plays:"NOT_VISIBLE",likes:"OBSERVED",comments:"NOT_PROVIDED",shares:"NOT_PROVIDED",collects:"NOT_PROVIDED"}};
},async getComments(input:any){return page("COMMENTS",input);},async getReplies(input:any){return page("REPLIES",input);}};
async function page(kind:string,input:any){
 const {awemeId,count,cursor="0"}=input,parentCid=input.cid;
 await before(kind,{awemeId,cursor,parentCid});
 const second=cursor!=="0",cid=kind==="COMMENTS"?(second?"1002":"1001"):(second?"2002":"2001"),next=second?"2":"1",text=kind==="COMMENTS"?"合成问题：如何使用？":"合成楼中楼回应";
 return {comments:[{cid,awemeId,parentCid:parentCid??"",nickname:"仅合成用户",text,diggCount:0,replyCount:2}],cursor:next,hasMore:!second,coverage:{status:"UNKNOWN",truncated:!second,reason:"固定合成分页，平台覆盖未知"},readEvidence:{version:"douyin-read-page-v1",kind,awemeId,parentCid:parentCid??null,requestCursor:cursor,count,observedAt:new Date().toISOString(),raw:{status_code:0,cursor:Number(next),has_more:second?0:1,comments:[{cid,aweme_id:awemeId,reply_id:parentCid??"0",text,reply_to_reply_id:kind==="REPLIES"&&second?"2001":"0"}]}}};
}
let activeProject="",activeId="";
const wrappedOps=new Proxy(ops,{get(target,key){
 const value=Reflect.get(target,key);
 if(key==="createMetricSnapshot"||key==="upsertComments")return async(...args:any[])=>{
  if(mode.pauseAtWrite===key){mode.pauseAtWrite=undefined;const run=(await schedules.get(activeProject,activeId))!;await service.pause(activeProject,activeId,run.revision);}
  return value.apply(target,args);
 };
 return typeof value==="function"?value.bind(target):value;
}});
const metrics=new DouyinMetricService(wrappedOps,runtime),comments=new DouyinCommentService(wrappedOps,runtime),collections=new DouyinCollectionService(runs,ops,comments);
const wrappedRepo=new Proxy(schedules,{get(target,key){const value=Reflect.get(target,key);
 if(key==="save")return async(...args:any[])=>{const run=await value.apply(target,args);if(mode.crash==="EMPTY_CHECKPOINT"&&run.checkpoint&&!run.checkpoint.pendingRead&&!run.checkpoint.metricsSnapshotId)die("EMPTY_CHECKPOINT");return run;};
 return typeof value==="function"?value.bind(target):value;
}});
const wrappedMetrics={async refresh(input:any){const result=await metrics.refresh(input);if(mode.crash==="METRICS_SAVED")die("METRICS_SAVED");return result;}};
const wrappedCollections={get:collections.get.bind(collections),findByRequestKey:collections.findByRequestKey.bind(collections),resumeAfterHuman:collections.resumeAfterHuman.bind(collections),
 async start(...args:Parameters<DouyinCollectionService["start"]>){const result=await collections.start(...args);if(mode.crash==="TOP_SAVED"&&result.kind==="COMMENTS"||mode.crash==="REPLIES_SAVED"&&result.kind==="REPLIES")die(mode.crash);return result;},
 advance:collections.advance.bind(collections)};
const service=new DouyinOperationsScheduleService(wrappedRepo,{ops,metrics:wrappedMetrics,collections:wrappedCollections,identity:()=>runtime.identity()},()=>new Date(clock));
const catalog=new PvsAgentCapabilities({schedules:service,opsRepo:ops,readOpsAccount:()=>runtime.identity()} as any);
const flowRepo=new PrismaProductFlowRepository(db),flow=new ProductFlowService(flowRepo);
const denied={id:"FORBIDDEN_EXTERNAL_MODEL",version:"1",async generateJson(){forbiddenModelCalls++;throw Error("MODEL_FORBIDDEN");}};
const review=new DouyinRetrospectiveService(ops,flow,denied,runs),feedback=new DouyinCreativeFeedbackService(ops,flow);
async function seed(overrides:any={}){
 const projectId="u4-bounded-"+randomUUID(),bindingId=randomUUID(),awemeId=String(7900000000000000000n+BigInt("0x"+randomUUID().replaceAll("-","").slice(0,12)));
 await db.project.create({data:{id:projectId,name:"仅本地有界计划",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});
 const now=new Date(clock).toISOString();await ops.upsertWorkBinding({id:bindingId,projectId,awemeId,opsAccountUid:uid,source:"HISTORICAL_WORK",status:"BOUND",confidence:"USER_CONFIRMED",boundAt:now,createdAt:now,updatedAt:now});
 const base=directorCase(15000).input.productTruth,{contentHash,...body}={...base,projectId,id:randomUUID()};const truth={...body,contentHash:hashValue(body)};
 await flowRepo.commitVersion({version:{id:truth.id,projectId,entityType:"ProductTruth",entityKey:"ProductTruth",version:truth.version,status:truth.status,contentHash:truth.contentHash,data:truth},staleEntityTypes:[],projectPatch:{}});
 await db.project.update({where:{id:projectId},data:{currentProductTruthId:truth.id,currentProductTruthVersion:truth.version,currentProductTruthHash:truth.contentHash}});
 const prior=directorCase(15000).input.creativeBatch,{contentHash:priorHash,...priorBody}={...prior,projectId,id:randomUUID(),productTruthRef:{entityType:"ProductTruth" as const,entityId:truth.id,version:truth.version,hash:truth.contentHash}};
 const batch={...priorBody,contentHash:hashValue(priorBody)};
 await flowRepo.commitVersion({version:{id:batch.id,projectId,entityType:"CreativeBatch",entityKey:"creative-batch",version:batch.version,status:batch.status,contentHash:batch.contentHash,data:batch},staleEntityTypes:[],projectPatch:{}});
 await db.project.update({where:{id:projectId},data:{currentCreativeBatchId:batch.id,currentCreativeBatchVersion:batch.version,currentCreativeBatchHash:batch.contentHash,selectedCreativeId:batch.concepts[0]!.id}});
 const input={projectId,requestKey:"synthetic-"+randomUUID(),bindingId,awemeId,opsAccountUid:uid,startAt:now,intervalSeconds:60,maxCaptures:3,maxReplyParents:1,pageSize:2,...overrides};
 const run=await service.create(input);return {projectId,bindingId,awemeId,run,truth};
}
async function state(projectId:string,id:string){return {run:await service.get(projectId,id),collections:await collections.list(projectId),metrics:await ops.listMetricSnapshots({projectId}),comments:await ops.listComments({projectId}),row:await db.douyinOperationsScheduleRecord.findUnique({where:{id}})};}
async function command(m:any):Promise<any>{
 if(m.op==="seed")return seed(m.overrides);
 if(m.op==="clock"){clock=m.now;return clock;}
 if(m.op==="mode"){mode=m.value??{};return true;}
 if(m.op==="release"){assert.ok(held);held();held=undefined;return true;}
 if(m.op==="tick"){activeProject=m.projectId;activeId=m.id;return service.tick(m.projectId,m.id);}
 if(m.op==="due")return service.due();
 if(m.op==="get")return state(m.projectId,m.id);
 if(m.op==="pause"){const run=(await service.get(m.projectId,m.id))!;return service.pause(m.projectId,m.id,m.expectedRevision??run.revision);}
 if(m.op==="resume"){
  const run=(await service.get(m.projectId,m.id))!,input={scheduleId:run.id,expectedRevision:m.expectedRevision??run.revision,inputHash:m.inputHash??run.inputHash,expectedAccountId:m.expectedAccountId??uid};
  const capability=catalog.get("operations.schedule-resume");assert.equal(capability.effect,"HUMAN_DECISION");
  return capability.run({projectId:m.projectId,cycleId:"synthetic-cycle",actionId:"synthetic-action",confirmed:m.confirmed===true},input);
 }
 if(m.op==="create-again")return service.create(m.input);
 if(m.op==="change-account"){account=m.uid;return true;}
 if(m.op==="change-binding"){await db.douyinWorkBindingRecord.update({where:{id:m.bindingId},data:{awemeId:"7900000000000000099"}});return true;}
 if(m.op==="corrupt"){
  const row=(await db.douyinOperationsScheduleRecord.findUnique({where:{id:m.id}}))!,run=JSON.parse(row.dataJson);
  if(m.kind==="hash")run.input.maxCaptures=30;
  if(m.kind==="legacy-running"||m.kind==="legacy-scheduled"){
   delete run.executionProtocol;run.status=m.kind==="legacy-running"?"RUNNING":"SCHEDULED";
   await db.douyinOperationsScheduleRecord.update({where:{id:m.id},data:{status:run.status,dataJson:JSON.stringify(run)}});return true;
  }
  if(m.kind==="row")await db.douyinOperationsScheduleRecord.update({where:{id:m.id},data:{revision:row.revision+1}});
  else if(m.kind==="missing-collection")await db.douyinCollectionRunRecord.delete({where:{id:run.checkpoint.commentsRunId}});
  else if(m.kind==="foreign-collection"){const other=(await collections.list(m.otherProject))[0]!;run.checkpoint.commentsRunId=other.id;await db.douyinOperationsScheduleRecord.update({where:{id:m.id},data:{dataJson:JSON.stringify(run)}});}
  else if(m.kind==="hash")await db.douyinOperationsScheduleRecord.update({where:{id:m.id},data:{dataJson:JSON.stringify(run)}});
  return true;
 }
 if(m.op==="claim"){const run=(await service.get(m.projectId,m.id))!;return schedules.claim(m.projectId,m.id,run.revision,m.owner,new Date(clock).toISOString(),new Date(clock+m.duration).toISOString());}
 if(m.op==="old-save")return schedules.save({...m.run,updatedAt:new Date(clock).toISOString()},m.owner,new Date(clock+180000).toISOString());
 if(m.op==="old-release"){await schedules.release(m.projectId,m.id,m.owner);return true;}
 if(m.op==="u5"){
  const before=await flow.getWorkspace(m.projectId);const insight=await review.prepareLocalReview({projectId:m.projectId});
  assert.equal(forbiddenModelCalls,0);assert.equal((await feedback.active(m.projectId)).length,0);
  await assert.rejects(feedback.promote({projectId:m.projectId,insightId:insight.id,actionIndex:0,confirmed:false}));
  const adopted=await feedback.promote({projectId:m.projectId,insightId:insight.id,actionIndex:0,confirmed:true});
  const requests:any[]=[];const fixed={id:"FIXED_LOCAL_CREATIVE_NO_MODEL",version:"1",async generateJson(r:any){requests.push(structuredClone(r));return {concepts:Array.from({length:4},(_,i)=>({title:"隔离候选"+i,targetAudience:"合成用户",painPoint:"方法待验证",hook:"先呈现问题",coreSellingPoint:"Feature one",narrativePattern:"情境再展示",expectedDurationMs:15000,productShowcaseStrategy:"保留原产品",generationRisk:"LOW",requiredFactIds:["fact-1"]}))};}};
  const ai=new AiGenerationService(fixed,undefined,p=>feedback.context(p));
  const artifacts=new PrismaArtifactRepository(db);
  const strategy=new PvsAgentCapabilities({productFlow:flow,productRepo:flowRepo,aiGeneration:ai,feedback,artifacts,projectsRoot:process.env.PROJECTS_ROOT!,publicBaseUrl:"http://127.0.0.1",referenceVideo:{async latest(){return null;}},research:{async pageData(){return {};}},productInput:{async latest(){return null;}},smartGeneration:{async list(){return [];}}} as any);
  const generated=await strategy.get("strategy.generate").run({projectId:m.projectId,cycleId:"synthetic-feedback-cycle",actionId:"adopted-candidate",confirmed:false},{requestText:"仅合成方法候选，不替换原选择 <script>globalThis.__u45Executed=true</script>",activate:false});
  const candidate=(generated.data as any).batch;
  assert.deepEqual(candidate.douyinFeedbackReceipt!.items[0]!.observation,insight.observationEvidence);
  assert.equal(candidate.douyinFeedbackReceipt!.items[0]!.feedbackId,adopted.id);
  await feedback.deactivate({projectId:m.projectId,feedbackId:adopted.id,confirmed:true});
  const following=await strategy.get("strategy.generate").run({projectId:m.projectId,cycleId:"synthetic-feedback-cycle",actionId:"after-deactivation",confirmed:false},{requestText:"仅合成停用后候选，不替换原选择",activate:false});
  const next=(following.data as any).batch;assert.equal(next.douyinFeedbackReceipt,undefined);
  const after=await flow.getWorkspace(m.projectId);for(const key of ["productTruth","creativeBatch","script","productionPlan"] as const)assert.deepEqual(after![key],before![key]);assert.equal(after!.project.selectedCreativeId,before!.project.selectedCreativeId);assert.deepEqual(after!.project.currentCreativeBatchRef,before!.project.currentCreativeBatchRef);
  const stored=await flowRepo.getVersion<any>(m.projectId,"CreativeBatch",candidate.id,candidate.version);assert.deepEqual(stored,candidate);
  const result={insight,candidateReceipt:candidate.douyinFeedbackReceipt,afterDeactivationReceipt:next.douyinFeedbackReceipt??null,persistedCandidate:{id:candidate.id,version:candidate.version,hash:candidate.contentHash,receiptId:(generated.data as any).inputReceiptId},requests:requests.map(r=>({input:r.input,instructions:r.instructions})),selectedContentUnchanged:true,actualHumanAdoption:false};
  await fs.writeFile(path.join(evidence,"u5-frozen-chain.json"),JSON.stringify(result,null,2));return result;
 }
 if(m.op==="verify-candidate"){
  const candidate=await flowRepo.getVersion<any>(m.projectId,"CreativeBatch",m.candidate.id,m.candidate.version);assert.ok(candidate);assert.equal(candidate.contentHash,m.candidate.hash);assert.ok(candidate.douyinFeedbackReceipt);
  const artifact=await new PrismaArtifactRepository(db).findById(m.candidate.receiptId);assert.ok(artifact);assert.equal(artifact.projectId,m.projectId);const bytes=await fs.readFile(path.join(process.env.PROJECTS_ROOT!,m.projectId,artifact.relativePath));assert.equal(sha256Bytes(bytes),artifact.sha256);
  const payload=JSON.parse(bytes.toString()).payload;assert.equal(payload.batchHash,candidate.contentHash);assert.deepEqual(payload.feedbackInputReceipt,candidate.douyinFeedbackReceipt);assert.equal(payload.activate,false);return true;
 }
 if(m.op==="u5-corrupt"){
  if(m.kind==="comment"){const item=(await ops.listComments({projectId:m.projectId}))[0]!;await db.douyinCommentRecord.update({where:{id:item.id},data:{text:"篡改保存的正文"}});}
  if(m.kind==="metric"){const item=(await ops.listMetricSnapshots({projectId:m.projectId}))[0]!;const row=(await db.versionedEntity.findFirst({where:{projectId:m.projectId,entityType:"DouyinMetricPartialSnapshot",entityKey:item.captureKey}}))!;await db.versionedEntity.update({where:{id:row.id},data:{dataJson:JSON.stringify({...item,likes:9})}});}
  const count=await db.douyinInsightRecord.count({where:{projectId:m.projectId}});await assert.rejects(review.prepareLocalReview({projectId:m.projectId}));assert.equal(await db.douyinInsightRecord.count({where:{projectId:m.projectId}}),count);assert.equal(forbiddenModelCalls,0);return true;
 }
 if(m.op==="u5-wrong-id"){
  const insight=await review.prepareLocalReview({projectId:m.projectId});await db.douyinInsightRecord.update({where:{id:insight.id},data:{metricSnapshotIdsJson:JSON.stringify(["unrelated-snapshot"])}});
  await assert.rejects(feedback.promote({projectId:m.projectId,insightId:insight.id,actionIndex:0,confirmed:true}),/ID 清单/);return true;
 }
 if(m.op==="boundary")return {guard:(globalThis as any)[Symbol.for("pvs.isolation.boundary.v1")].counters(),providers:await db.aiProviderConfigRecord.count(),executions:await db.aiExecutionRecord.count(),attempts:await db.generationAttemptRecord.count(),forbiddenModelCalls};
 if(m.op==="close"){await db.$disconnect();setTimeout(()=>process.exit(0),20);return true;}
 throw Error("UNEXPECTED_COMMAND");
}

// This fixture deliberately reuses the previous suite's local seed helpers;
// all browser/HTTP traffic goes through the original application server below.
let identityCalls=0;const originalIdentity=runtime.identity;runtime.identity=async()=>{identityCalls++;return originalIdentity();};
const artifacts=new PrismaArtifactRepository(db),reader=new OperationsEvidenceReader(schedules,runs,ops,flowRepo,artifacts,process.env.PROJECTS_ROOT!,()=>new Date(clock));
const bootFile=path.join(evidence,"seed.json");
let cases:any;
try{cases=JSON.parse(await fs.readFile(bootFile,"utf8"));clock=cases.clock;}catch{
 const main=await seed();await db.project.update({where:{id:main.projectId},data:{name:"仅合成 · U4/U5 原工作台验收"}});
 let run=await service.tick(main.projectId,main.run.id);clock=Date.parse(run.nextAt);run=await service.tick(main.projectId,main.run.id);clock=Date.parse(run.nextAt);await service.tick(main.projectId,main.run.id);
 const u5=await command({op:"u5",projectId:main.projectId});
 async function plan(){return service.create({...main.run.input,startAt:new Date(clock).toISOString(),requestKey:randomUUID()});}
 const auth=await plan();mode={failure:"METRICS",code:"AUTH_REQUIRED"};await service.tick(main.projectId,auth.id);mode={};
 const unknown=await plan(),owner="synthetic-intent-owner",claimed=(await schedules.claim(main.projectId,unknown.id,unknown.revision,owner,new Date(clock).toISOString(),new Date(clock+180000).toISOString()))!;
 await schedules.save({...claimed,status:"BLOCKED",errorCode:"READ_OUTCOME_UNKNOWN",checkpoint:{index:1,startedAt:new Date(clock).toISOString(),replyRuns:{},parentLimitReached:false,pendingRead:{kind:"METRICS",requestKey:`schedule:${unknown.id}:1:metrics`,startedAt:new Date(clock).toISOString()}}},owner,new Date(clock+180000).toISOString());await schedules.release(main.projectId,unknown.id,owner);
 const expired=await service.create({...main.run.input,startAt:new Date(clock-300000).toISOString(),requestKey:randomUUID()});await schedules.claim(main.projectId,expired.id,expired.revision,"synthetic-expired",new Date(clock-200000).toISOString(),new Date(clock-1000).toISOString());
 const active=await plan();await schedules.claim(main.projectId,active.id,active.revision,"synthetic-active",new Date(clock).toISOString(),new Date(clock+180000).toISOString());
 const foreign=await seed(),corruptProject=await seed();await db.douyinOperationsScheduleRecord.update({where:{id:corruptProject.run.id},data:{revision:999}});
 const receipt=await artifacts.findById(u5.persistedCandidate.receiptId);assert.ok(receipt);
 const originalRecord=JSON.parse(await fs.readFile(path.join(process.env.PROJECTS_ROOT!,main.projectId,receipt.relativePath),"utf8"));
 const damaged:Record<string,string>={};
 for(const kind of ["missing","bytes","path","size","mime","context","candidate","feedback","row"]){
  const record=structuredClone(originalRecord);record.actionId="negative-"+kind;
  if(kind==="context")record.payload.inputHash="0".repeat(64);
  if(kind==="candidate")record.payload.batchHash="0".repeat(64);
  if(kind==="feedback")delete record.payload.feedbackInputReceipt;
  if(kind==="row"){
   const source=(await db.versionedEntity.findUnique({where:{id:record.payload.batchId}}))!,id=randomUUID();
   await db.versionedEntity.create({data:{id,projectId:main.projectId,entityType:"CreativeBatch",entityKey:"negative-candidate-"+id,version:record.payload.version,status:"CANDIDATE",contentHash:source.contentHash,dataJson:source.dataJson}});record.payload.batchId=id;
  }
  const key=hashValue({projectId:main.projectId,cycleId:record.cycleId,actionId:record.actionId,kind:record.kind}),id="agent-evidence-"+key,relativePath="agent-evidence/"+key+".json";
  const saved=await new LocalArtifactStore(path.join(process.env.PROJECTS_ROOT!,main.projectId),artifacts).writeImmutable({id,projectId:main.projectId,kind:"STRUCTURED_SNAPSHOT",relativePath,bytes:Buffer.from(JSON.stringify(record)),mimeType:"application/json",immutable:true});
  const file=path.join(process.env.PROJECTS_ROOT!,main.projectId,relativePath);
  if(kind==="missing")await fs.unlink(file);if(kind==="bytes")await fs.appendFile(file,"changed");
  if(kind==="path")await db.artifactRecord.update({where:{id},data:{relativePath:"../"+foreign.projectId+"/outside.json"}});
  if(kind==="size")await db.artifactRecord.update({where:{id},data:{sizeBytes:saved.sizeBytes!+1}});
  if(kind==="mime")await db.artifactRecord.update({where:{id},data:{mimeType:"text/html"}});
  damaged[kind]=id;
 }
 const mutableProject=await seed(),mutableKey=hashValue({projectId:mutableProject.projectId,cycleId:"mutable-row",actionId:"input",kind:"STRATEGY_INPUT"}),mutableId="agent-evidence-"+mutableKey;
 await new LocalArtifactStore(path.join(process.env.PROJECTS_ROOT!,mutableProject.projectId),artifacts).writeImmutable({id:mutableId,projectId:mutableProject.projectId,kind:"STRUCTURED_SNAPSHOT",relativePath:"agent-evidence/"+mutableKey+".json",bytes:Buffer.from(JSON.stringify(originalRecord)),mimeType:"application/json",immutable:true});await db.artifactRecord.update({where:{id:mutableId},data:{immutable:false}});
 cases={main,authId:auth.id,unknownId:unknown.id,expiredId:expired.id,activeId:active.id,foreign,corruptProject,mutableProject,mutableId,candidate:u5.persistedCandidate,damaged,clock};await fs.writeFile(bootFile,JSON.stringify(cases,null,2));
}
const publish=new PrismaPublishRepository(db),catalogForPage=new PvsAgentCapabilities({productFlow:flow,productRepo:flowRepo,opsRepo:ops,artifacts,projectsRoot:process.env.PROJECTS_ROOT!,publicBaseUrl:"http://127.0.0.1",schedules:service,collections,feedback,
 research:{async pageData(){return {runs:[],evidence:[],brief:null};}},smartGeneration:{async list(){return [];}},finalOutput:{async latestAssembly(){return null;}},publishRepo:publish} as any);
const cycles=new AgentCycleService(new PrismaAgentCycleRepository(db),catalogForPage,denied);
const app=createAppServer({productFlow:flow,agentCycles:cycles,operationsEvidence:reader,douyinSchedules:service,artifacts,projectsRoot:process.env.PROJECTS_ROOT!,workflow:new PrismaWorkflowRepository(db),productInput:{async latest(){return null;}}} as any);
const requests:Array<{method?:string;url?:string;status:number}>=[],handlers=app.listeners("request");app.removeAllListeners("request");
app.on("request",(req,res)=>{const entry={method:req.method,url:req.url,status:0};requests.push(entry);res.once("finish",()=>entry.status=res.statusCode);for(const h of handlers)(h as any).call(app,req,res);});
await new Promise<void>(resolve=>app.listen(0,"127.0.0.1",resolve));const address=app.address();assert.ok(address&&typeof address!=="string");const origin="http://127.0.0.1:"+address.port;
async function digest(){
 const tables=await Promise.all([db.project.findMany({orderBy:{id:"asc"}}),db.versionedEntity.findMany({orderBy:{id:"asc"}}),db.artifactRecord.findMany({orderBy:{id:"asc"}}),db.douyinOperationsScheduleRecord.findMany({orderBy:{id:"asc"}}),db.douyinCollectionRunRecord.findMany({orderBy:{id:"asc"}}),db.douyinCreativeFeedbackRecord.findMany({orderBy:{id:"asc"}}),db.douyinInsightRecord.findMany({orderBy:{id:"asc"}}),db.agentCycleRecord.findMany({orderBy:{id:"asc"}})]);
 return hashValue(tables);
}
async function observed(){return {digest:await digest(),identityCalls,dataReads:(await fs.readFile(path.join(evidence,"reads.jsonl"),"utf8")).trim().split("\n").filter(Boolean).length,requests,workspace:await flow.getWorkspace(cases.main.projectId),auth:await service.get(cases.main.projectId,cases.authId),providers:await db.aiProviderConfigRecord.count(),executions:await db.aiExecutionRecord.count(),attempts:await db.generationAttemptRecord.count(),forbiddenModelCalls,guard:(globalThis as any)[Symbol.for("pvs.isolation.boundary.v1")].counters()};}
const ready={origin,...cases,workbench:`/projects/${cases.main.projectId}/agent-cycle`,authPage:`/projects/${cases.main.projectId}/operations/schedules/${cases.authId}`,candidatePage:`/projects/${cases.main.projectId}/operations/candidates/${cases.candidate.receiptId}`};
await fs.writeFile(path.join(evidence,"ready.json"),JSON.stringify(ready,null,2));emit({ready});
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);void(async()=>{
 if(m.op==="observe")return observed();
 if(m.op==="pause-auth"){const run=(await service.get(cases.main.projectId,cases.authId))!;return service.pause(cases.main.projectId,run.id,run.revision);}
 if(m.op==="close"){const result=await observed();await fs.writeFile(path.join(evidence,"fixture-final.json"),JSON.stringify(result,null,2));app.close();app.closeAllConnections();await db.$disconnect();setTimeout(()=>process.exit(0),20);return result;}
 return command(m);
 })().then(result=>emit({requestId:m.requestId,result}),error=>emit({requestId:m.requestId,error:String(error)}));});
