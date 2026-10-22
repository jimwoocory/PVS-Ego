// Original workers/services and Prisma; only inert observations in a new shared DB.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import {PrismaClient} from "@prisma/client";
import {PrismaDouyinOpsRepository} from "../src/adapters/db/prisma-douyin-ops-repository.js";
import {PrismaDouyinOperationsScheduleRepository} from "../src/adapters/db/prisma-douyin-operations-schedule-repository.js";
import {PrismaDouyinCollectionRepository} from "../src/adapters/db/prisma-douyin-collection-repository.js";
import {PrismaSmartRunRepository} from "../src/adapters/db/prisma-smart-run-repository.js";
import {PrismaAgentCycleRepository} from "../src/adapters/db/prisma-agent-cycle-repository.js";
import {DouyinMetricService} from "../src/application/services/douyin-metric-service.js";
import {DouyinCommentService} from "../src/application/services/douyin-comment-service.js";
import {DouyinCollectionService} from "../src/application/services/douyin-collection-service.js";
import {DouyinOperationsScheduleService,startDouyinOperationsScheduleWorker} from "../src/application/services/douyin-operations-schedule-service.js";
import {SmartGenerationService} from "../src/application/services/smart-generation-service.js";
import {startSmartGenerationWorker,type SmartWorkerPolicy} from "../src/application/services/smart-generation-worker.js";
import {AgentCycleService,startAgentCycleWorker} from "../src/application/services/agent-cycle-service.js";
import {SmartFlowPause} from "../src/application/ports/smart-production.js";
import {DouyinOpsRuntimeError} from "../src/application/ports/douyin-ops-runtime.js";
import {hashValue} from "../src/domain/hashing.js";

const session=process.env.PVS_ISOLATION_SESSION!,db=new PrismaClient();
const ops=new PrismaDouyinOpsRepository(db),plans=new PrismaDouyinOperationsScheduleRepository(db),runs=new PrismaDouyinCollectionRepository(db),smartRepo=new PrismaSmartRunRepository(db),agentRepo=new PrismaAgentCycleRepository(db);
const uid="synthetic-worker-owner",stops:Array<()=>void>=[],holds=new Map<string,()=>void>(),modes=new Map<string,any>();
const stats={due:0,ticks:0,activeTicks:0,maxTicks:0,recover:0,smartLists:0,agentLists:0,errors:[] as string[],forbidden:0};
const emit=(v:unknown)=>process.stdout.write(JSON.stringify(v)+"\n");
const log=async(kind:string,key:string,detail:unknown={})=>fs.appendFile(path.join(session,"evidence",`events-${process.pid}.jsonl`),JSON.stringify({kind,key,detail,pid:process.pid,at:Date.now()})+"\n");
async function before(kind:string,key:string){
  await log(kind,key);const mode=modes.get(key)??{};
  if(mode.crash===kind){emit({crash:kind,key});process.exit(73);}
  if(mode.hold===kind){emit({held:kind,key});await new Promise<void>(resolve=>holds.set(key,resolve));holds.delete(key);}
  if(mode.delayMs)await new Promise(resolve=>setTimeout(resolve,mode.delayMs));
  if(mode.failure===kind)throw new DouyinOpsRuntimeError(mode.code??"AUTH_REQUIRED","Inert fixture requires human review");
}
const runtime:any={async identity(){return {uid};},async getWork(awemeId:string){
  await before("METRICS",awemeId);return {awemeId,author:{uid},description:"Fixed local observation",publishedAt:null,durationMs:15000,externalUrl:"",metrics:{likes:0},metricAvailability:{plays:"NOT_VISIBLE",likes:"OBSERVED",comments:"NOT_PROVIDED",shares:"NOT_PROVIDED",collects:"NOT_PROVIDED"}};
},async getComments(input:any){await before("COMMENTS",input.awemeId);return {comments:[],cursor:"1",hasMore:false,coverage:{status:"UNKNOWN",truncated:false,reason:"Inert empty page"}};},async getReplies(){stats.forbidden++;throw Error("REPLIES_FORBIDDEN");}};
const metrics=new DouyinMetricService(ops,runtime),comments=new DouyinCommentService(ops,runtime),collections=new DouyinCollectionService(runs,ops,comments);
const schedules=new DouyinOperationsScheduleService(plans,{ops,metrics,collections,identity:()=>runtime.identity()});
const production:any=new Proxy({async initial(){return {targetDurationMs:15000,binding:{}};},async sources(run:any){
  await before("SOURCES",run.id);throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW","FIXTURE_HUMAN_GATE","Synthetic truth requires human review",false);
}},{get(target,key){if(key in target)return Reflect.get(target,key);return async()=>{stats.forbidden++;throw Error("PRODUCTION_FORBIDDEN:"+String(key));};}});
const smart=new SmartGenerationService(smartRepo,production);
const denied:any={id:"FORBIDDEN_MODEL",version:"1",async generateJson(){stats.forbidden++;throw Error("MODEL_FORBIDDEN");}};
const catalog:any={async snapshot(){return {};},async fingerprint(){return "fixed-context";},get(id:string){return {id,title:"Inert read",effect:id==="human"?"HUMAN_DECISION":"READ",async run(context:any){await before("AGENT_READ",context.cycleId);return {status:"WAITING_USER",summary:"Saved local observation; awaiting user"};}};}};
const agent=new AgentCycleService(agentRepo,catalog,denied);
const onError=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);stats.errors.push(message);};
function instrument<T extends object>(target:T,overrides:Record<string,unknown>):T{return new Proxy(target,{get(t,k){if(k in overrides)return overrides[String(k)];const v=Reflect.get(t,k);return typeof v==="function"?v.bind(t):v;}});}
const scheduled=instrument(schedules,{async due(){stats.due++;return schedules.due();},async tick(p:string,id:string){stats.ticks++;stats.activeTicks++;stats.maxTicks=Math.max(stats.maxTicks,stats.activeTicks);try{return await schedules.tick(p,id);}finally{stats.activeTicks--;}}});
const smartWorker=instrument(smart,{async list(){stats.smartLists++;return smart.list();},async recoverAbandonedScoped(p:string,id:string){stats.recover++;return smart.recoverAbandonedScoped(p,id);}});
const agentWorker=instrument(agent,{async list(){stats.agentLists++;return agent.list();}});
async function project(){const id="worker-db-"+randomUUID();await db.project.create({data:{id,name:"Synthetic worker regression",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});return id;}
async function command(m:any):Promise<any>{
  if(m.op==="seed-plan"){
    const projectId=await project(),bindingId=randomUUID(),awemeId=String(7900000000000000000n+BigInt("0x"+randomUUID().replaceAll("-","").slice(0,12))),now=new Date().toISOString();
    await ops.upsertWorkBinding({id:bindingId,projectId,awemeId,opsAccountUid:uid,source:"HISTORICAL_WORK",status:"BOUND",confidence:"USER_CONFIRMED",boundAt:now,createdAt:now,updatedAt:now});
    return schedules.create({projectId,requestKey:randomUUID(),bindingId,awemeId,opsAccountUid:uid,startAt:new Date(Date.now()+(m.delayStartMs??1000)).toISOString(),intervalSeconds:60,maxCaptures:m.maxCaptures??1,maxReplyParents:1,pageSize:2});
  }
  if(m.op==="seed-smart"){
    const projectId=await project();return smart.create(projectId,randomUUID(),{requestText:"Inert worker test",generationSettings:{requestedModelVersion:"seedance2.0mini",aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:false},reviewMode:"MANUAL"});
  }
  if(m.op==="seed-agent"){
    const projectId=await project(),cycle=await agent.create(projectId,{requestKey:randomUUID(),goal:"Synthetic worker gate",stages:["OPERATIONS"]});
    const capabilityId=m.human?"human":"read";
    cycle.actions.push({id:randomUUID(),requestKey:randomUUID(),capabilityId,input:{},inputHash:hashValue({}),contextHash:"fixed-context",status:"PROPOSED",effect:m.human?"HUMAN_DECISION":"READ",preview:"Synthetic only",proposedAt:new Date().toISOString()});
    await db.agentCycleRecord.update({where:{id:cycle.id},data:{dataJson:JSON.stringify(cycle)}});return cycle;
  }
  if(m.op==="mode"){modes.set(m.key,m.value??{});return true;}
  if(m.op==="release"){const release=holds.get(m.key);assert.ok(release);release();return true;}
  if(m.op==="start"){
    if(m.kind==="operations")stops.push(startDouyinOperationsScheduleWorker(scheduled,onError));
    else if(m.kind==="agent")stops.push(startAgentCycleWorker(agentWorker,onError));
    else stops.push(startSmartGenerationWorker(smartWorker,{policy:m.policy as SmartWorkerPolicy,intervalMs:1000,onError}));
    return {pid:process.pid,startedAt:Date.now()};
  }
  if(m.op==="stop"){for(const stop of stops.splice(0))stop();return {...stats};}
  if(m.op==="stats")return {...stats,held:[...holds.keys()]};
  if(m.op==="plan")return {run:await schedules.get(m.projectId,m.id),row:await db.douyinOperationsScheduleRecord.findUnique({where:{id:m.id}}),metrics:await ops.listMetricSnapshots({projectId:m.projectId}),collections:await collections.list(m.projectId)};
  if(m.op==="smart")return {run:await smart.get(m.projectId,m.id),lease:await smartRepo.lease(m.projectId,m.id)};
  if(m.op==="agent")return agent.get(m.projectId,m.id);
  if(m.op==="pause"){const run=(await schedules.get(m.projectId,m.id))!;return schedules.pause(m.projectId,m.id,run.revision);}
  if(m.op==="resume"){const run=(await schedules.get(m.projectId,m.id))!;return schedules.resume({projectId:m.projectId,id:m.id,expectedRevision:run.revision,inputHash:run.inputHash,expectedAccountId:uid,confirmed:m.confirmed===true});}
  if(m.op==="expire"){
    // Deliberate DB fault injection, not evidence of waiting through the 180s TTL.
    await db.douyinOperationsScheduleRecord.update({where:{id:m.id},data:{leaseExpiresAt:new Date(Date.now()-1000)}});return true;
  }
  if(m.op==="tick")return schedules.tick(m.projectId,m.id);
  if(m.op==="smart-own")return smartRepo.acquire(m.projectId,m.id,m.owner,process.pid);
  if(m.op==="smart-release"){await smartRepo.release(m.projectId,m.id,m.owner);return true;}
  if(m.op==="exit-owner"){process.exit(73);}
  if(m.op==="audit"){
    return {providers:await db.aiProviderConfigRecord.count(),executions:await db.aiExecutionRecord.count(),attempts:await db.generationAttemptRecord.count(),smart:await smart.list(),agent:await agent.list(m.projectId),stats,guard:(globalThis as any)[Symbol.for("pvs.isolation.boundary.v1")].counters()};
  }
  if(m.op==="close"){
    for(const stop of stops.splice(0))stop();assert.equal(holds.size,0,"Release fixture holds before close");
    // The suite first stops and observes that native ticks have drained.
    assert.equal(stats.activeTicks,0);await db.$disconnect();lines.close();process.stdin.pause();return {closed:true};
  }
  throw Error("UNKNOWN_FIXTURE_OPERATION");
}
const lines=createInterface({input:process.stdin});
lines.on("line",line=>{const m=JSON.parse(line);void command(m).then(result=>emit({requestId:m.requestId,result})).catch(error=>emit({requestId:m.requestId,error:error instanceof Error?error.message:String(error)}));});
emit({ready:true,pid:process.pid});
