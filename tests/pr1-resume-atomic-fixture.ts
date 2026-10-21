import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import {PrismaClient} from "@prisma/client";
import {PrismaDouyinOpsRepository} from "../src/adapters/db/prisma-douyin-ops-repository.js";
import {PrismaDouyinCollectionRepository} from "../src/adapters/db/prisma-douyin-collection-repository.js";
import {PrismaDouyinOperationsScheduleRepository} from "../src/adapters/db/prisma-douyin-operations-schedule-repository.js";
import {DouyinOperationsScheduleService} from "../src/application/services/douyin-operations-schedule-service.js";
import {operationsScheduleSchema,type DouyinOperationsSchedule} from "../src/domain/douyin-operations-schedule.js";
import {douyinCollectionRunSchema} from "../src/domain/douyin-collection.js";
import {hashValue} from "../src/domain/hashing.js";
import {OperationsEvidenceReader} from "../src/application/services/operations-evidence-reader.js";

const db=new PrismaClient(),ops=new PrismaDouyinOpsRepository(db),children=new PrismaDouyinCollectionRepository(db),plans=new PrismaDouyinOperationsScheduleRepository(db);
const uid="synthetic-pr1-uid";
let identityCalls=0,dataReads=0,childResumeCalls=0;
const forbidden=async()=>{dataReads++;throw Error("DATA_READ_NOT_AUTHORIZED");};
const service=(repo=plans,identity=async()=>{identityCalls++;return {uid};})=>new DouyinOperationsScheduleService(repo,{ops,identity,metrics:{refresh:forbidden},collections:{get:children.get.bind(children),start:forbidden,advance:forbidden,resumeAfterHuman:async i=>{childResumeCalls++;const result=await children.resumeAfterHuman(i.projectId,i.runId,i.expectedRevision,new Date().toISOString());if(!result)throw Error("CHILD_CONFLICT");return result;}}});
async function seed(cadence=false){
 const projectId="pr1-atomic-"+randomUUID(),bindingId=randomUUID(),awemeId=String(7900000000000000000n+BigInt("0x"+randomUUID().replaceAll("-","").slice(0,12))),now=new Date().toISOString();
 await db.project.create({data:{id:projectId,name:"合成事务回归",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});
 await ops.upsertWorkBinding({id:bindingId,projectId,awemeId,opsAccountUid:uid,source:"HISTORICAL_WORK",status:"BOUND",confidence:"USER_CONFIRMED",boundAt:now,createdAt:now,updatedAt:now});
 let plan=await service().create({projectId,bindingId,awemeId,opsAccountUid:uid,requestKey:randomUUID(),startAt:now,intervalSeconds:60,maxCaptures:3,maxReplyParents:1,pageSize:2,...(cadence?{cadence:{version:"stage-data-v1" as const,minIntervalSeconds:60,maxIntervalSeconds:120,maxDurationSeconds:600}}:{})});
 const runs=[];
 for(const kind of ["COMMENTS","REPLIES"] as const){
  const options={projectId,bindingId,awemeId,opsAccountUid:uid,kind,...(kind==="REPLIES"?{parentCid:"1001"}:{}),pageSize:2,batchPages:1};
  runs.push((await children.create(douyinCollectionRunSchema.parse({...options,id:randomUUID(),requestKey:`schedule:${plan.id}:1:${kind==="COMMENTS"?"comments":"replies:1001"}`,inputHash:hashValue(options),status:"BLOCKED",cursor:kind==="COMMENTS"?"0":"1",pages:kind==="COMMENTS"?0:1,syncedCount:0,hasMore:true,truncated:true,partial:true,revision:1,visitedCursors:["0"],retryable:false,errorCode:kind==="COMMENTS"?"AUTH_REQUIRED":"RISK_CONTROL",errorMessage:"合成人工阻断",createdAt:now,updatedAt:now}))).run);
 }
 plan=operationsScheduleSchema.parse({...plan,status:"PAUSED",errorCode:"AUTH_REQUIRED",checkpoint:{index:1,startedAt:now,commentsRunId:runs[0]!.id,parents:["1001"],replyRuns:{"1001":runs[1]!.id},parentLimitReached:false}});
 await db.douyinOperationsScheduleRecord.update({where:{id:plan.id},data:{status:plan.status,dataJson:JSON.stringify(plan)}});
 return {plan,runs};
}
const snapshot=async(plan:DouyinOperationsSchedule)=>({parent:await db.douyinOperationsScheduleRecord.findUnique({where:{id:plan.id}}),children:await db.douyinCollectionRunRecord.findMany({where:{projectId:plan.input.projectId},orderBy:{id:"asc"}})});
const confirm=(plan:DouyinOperationsSchedule)=>({projectId:plan.input.projectId,id:plan.id,expectedRevision:plan.revision,inputHash:plan.inputHash,expectedAccountId:uid,confirmed:true});
async function replacePlan(plan:DouyinOperationsSchedule){await db.douyinOperationsScheduleRecord.update({where:{id:plan.id},data:{dataJson:JSON.stringify(plan)}});}
async function runCase(name:string){
 const {plan,runs}=await seed(name.startsWith("cadence")),before=await snapshot(plan),calls=identityCalls;
 if(name==="success"){
  const result=await service().resume(confirm(plan));assert.equal(result.status,"SCHEDULED");assert.deepEqual(result.input,plan.input);assert.equal(result.completedCaptures,0);
  for(const old of runs){const current=(await children.get(plan.input.projectId,old.id))!;assert.equal(current.status,old.pages?"PARTIAL":"QUEUED");assert.equal(current.revision,old.revision+1);assert.equal(current.cursor,old.cursor);assert.equal(current.errorCode,undefined);}
  const after=await snapshot(plan);await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),after);
 }else if(name==="parent-race"){
  const instance=service(plans,async()=>{identityCalls++;await plans.pause(plan.input.projectId,plan.id,plan.revision,new Date().toISOString());return {uid};});
  await assert.rejects(instance.resume(confirm(plan)));assert.deepEqual((await snapshot(plan)).children,before.children);assert.equal((await plans.get(plan.input.projectId,plan.id))!.status,"PAUSED");
 }else if(name==="child-race"){
  const wrapped=new Proxy(plans,{get(target,key){if(key==="resume")return async(...args:Parameters<typeof plans.resume>)=>{const old=runs[1]!,next={...old,revision:old.revision+1};await db.douyinCollectionRunRecord.update({where:{id:old.id},data:{revision:next.revision,runJson:JSON.stringify(next)}});return target.resume(...args);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
  await assert.rejects(service(wrapped).resume(confirm(plan)));const after=await snapshot(plan);assert.deepEqual(after.parent,before.parent);assert.deepEqual(after.children.find(c=>c.id===runs[0]!.id),before.children.find(c=>c.id===runs[0]!.id));assert.equal((await children.get(plan.input.projectId,runs[1]!.id))!.status,"BLOCKED");
 }else if(name==="write-failure"){
  await db.$executeRawUnsafe(`CREATE TEMP TRIGGER pr1_fail_resume BEFORE UPDATE ON DouyinCollectionRunRecord WHEN NEW.id='${runs[1]!.id}' BEGIN SELECT RAISE(ABORT,'INJECTED_SECOND_CHILD_FAILURE'); END`);
  try{await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),before);}finally{await db.$executeRawUnsafe("DROP TRIGGER pr1_fail_resume");}
 }else if(name==="parent-lease"||name==="child-lease"){
  const lease={leaseOwner:"synthetic-live-owner",leaseExpiresAt:new Date(Date.now()+60000)};
  if(name==="parent-lease")await db.douyinOperationsScheduleRecord.update({where:{id:plan.id},data:lease});else await db.douyinCollectionRunRecord.update({where:{id:runs[1]!.id},data:lease});
  const leased=await snapshot(plan);await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),leased);
 }else if(name==="missing-child"){
  await db.douyinCollectionRunRecord.delete({where:{id:runs[1]!.id}});const changed=await snapshot(plan);await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),changed);
 }else if(name.startsWith("scope-")){
  const field=name.slice(6),other={...runs[1]!};
  if(field==="work")other.awemeId="7900000000000000002";else if(field==="account")other.opsAccountUid="synthetic-other-uid";else if(field==="parent")other.parentCid="1002";else if(field==="pages")other.batchPages=5;else if(field==="size")other.pageSize=20;else if(field==="binding")other.bindingId=randomUUID();else throw Error("CASE_UNKNOWN");
  await db.douyinCollectionRunRecord.update({where:{id:other.id},data:{runJson:JSON.stringify(other)}});const changed=await snapshot(plan);await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),changed);
 }else if(name==="stale-consent"){
  await assert.rejects(service().resume({...confirm(plan),expectedRevision:plan.revision+1}));assert.deepEqual(await snapshot(plan),before);assert.equal(identityCalls,calls);
 }else if(name==="parent-budget"){
  await replacePlan({...plan,checkpoint:{...plan.checkpoint!,parents:["1001","1002"]}});const changed=await snapshot(plan);await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),changed);assert.equal(identityCalls,calls);
 }else if(name.startsWith("cadence")){
  await replacePlan({...plan,cadenceState:name==="cadence-missing"?undefined:{...plan.cadenceState!,deadlineAt:new Date(Date.parse(plan.cadenceState!.deadlineAt)+600000).toISOString()}});const changed=await snapshot(plan);
  const reader=new OperationsEvidenceReader(plans,children,ops,{getProject:async()=>null},{findById:async()=>null,listByProject:async()=>[]},process.env.PROJECTS_ROOT!);
  const view=await reader.schedule(plan.input.projectId,plan.id);assert.equal(view?.status,"VERIFIED");assert.ok(view?.status==="VERIFIED"&&!view.resumeAllowed);
  await assert.rejects(service().resume(confirm(plan)));assert.deepEqual(await snapshot(plan),changed);assert.equal(identityCalls,calls);
 }else if(name==="unknown-intent"){
  const unknown={...plan,errorCode:"READ_OUTCOME_UNKNOWN",checkpoint:{...plan.checkpoint!,pendingRead:{kind:"METRICS" as const,requestKey:`schedule:${plan.id}:1:metrics`,startedAt:new Date().toISOString()}}};await replacePlan(unknown);
  const result=await service().resume(confirm(plan));assert.deepEqual(result.checkpoint!.pendingRead,unknown.checkpoint.pendingRead);assert.equal(dataReads,0);
 }else throw Error("CASE_UNKNOWN");
 assert.equal(dataReads,0);assert.equal(childResumeCalls,0,"No standalone child mutation before parent CAS");
 return {passed:true,name,dataReads,standaloneChildResumes:childResumeCalls};
}
const emit=(v:unknown)=>console.log(JSON.stringify(v));
emit({ready:true});
const pending=new Set<Promise<void>>();
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);const job=(async()=>{try{if(m.op==="close"){await db.$disconnect();emit({requestId:m.requestId,result:true});return;}emit({requestId:m.requestId,result:await runCase(m.name)});}catch(error){emit({requestId:m.requestId,error:error instanceof Error?error.stack:String(error)});}})();pending.add(job);void job.finally(()=>pending.delete(job));}).on("close",()=>{void Promise.all(pending).then(async()=>{await fs.writeFile(path.join(process.env.PVS_ISOLATION_SESSION!,"evidence","fixture-final.json"),JSON.stringify({dataReads,identityCalls,standaloneChildResumes:childResumeCalls,modelCalls:0}));await db.$disconnect();});});
