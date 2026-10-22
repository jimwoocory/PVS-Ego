// A new local DB, original services/workers, synthetic tasks and real local file errors.
import fs from "node:fs/promises";
import path from "node:path";
import {createInterface} from "node:readline";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {PrismaClient} from "@prisma/client";
import {PrismaSmartRunRepository} from "../src/adapters/db/prisma-smart-run-repository.js";
import {PrismaAgentCycleRepository} from "../src/adapters/db/prisma-agent-cycle-repository.js";
import {SmartGenerationService} from "../src/application/services/smart-generation-service.js";
import {AgentCycleService,startAgentCycleWorker} from "../src/application/services/agent-cycle-service.js";
import {startSmartGenerationWorker} from "../src/application/services/smart-generation-worker.js";
import {SmartFlowPause} from "../src/application/ports/smart-production.js";
import {hashValue} from "../src/domain/hashing.js";
import {smartRunSchema} from "../src/domain/smart-generation.js";
const db=new PrismaClient(),smartRepo=new PrismaSmartRunRepository(db),agentRepo=new PrismaAgentCycleRepository(db);
const session=process.env.PVS_ISOLATION_SESSION!,folder=path.join(process.env.PROJECTS_ROOT!,"synthetic-worker-sources");await fs.mkdir(folder,{recursive:true});
const stops:Array<()=>void>=[],recoveryFaults=new Set<string>(),stats={smartPages:0,agentPages:0,maxSmartPage:0,maxAgentPage:0,activePages:0,maxActivePages:0,forbidden:0,errors:{} as Record<string,number>,lastErrors:[] as string[]};
const delay=monitorEventLoopDelay({resolution:20});delay.enable();
const emit=(v:unknown)=>process.stdout.write(JSON.stringify(v)+"\n");
const event=async(kind:string,id:string,detail?:unknown)=>fs.appendFile(path.join(session,"evidence",`events-${process.pid}.jsonl`),JSON.stringify({kind,id,pid:process.pid,at:Date.now(),detail})+"\n");
const production:any=new Proxy({async sources(run:any){
  await event("SOURCE",run.id);await fs.readFile(path.join(folder,run.id+".json"),"utf8");
  if(run.id.includes("directory-write"))await fs.writeFile(path.join(folder,run.id+".result"),"inert local output");
  throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW","SYNTHETIC_HUMAN_GATE","Synthetic source awaits human review",false);
}},{get(t,k){if(k in t)return Reflect.get(t,k);return async()=>{stats.forbidden++;throw Error("FORBIDDEN_PRODUCTION:"+String(k));};}});
const smart=new SmartGenerationService(smartRepo,production);
const denied:any={id:"FORBIDDEN_MODEL",version:"1",async generateJson(){stats.forbidden++;throw Error("MODEL_FORBIDDEN");}};
const catalog:any={async snapshot(){return {};},get(id:string){return {id,title:"Synthetic saved read",effect:"READ",async run(c:any){await event("AGENT",c.cycleId);return {status:"WAITING_USER",summary:"Inert local read; user input required"};}};}};
const agent=new AgentCycleService(agentRepo,catalog,denied);
const onError=(e:unknown)=>{const s=e instanceof Error?e.message:String(e);const key=/ENOENT/.test(s)?"ENOENT":/FIXTURE_CHECKPOINT_WRITE_DENIED/.test(s)?"CHECKPOINT_WRITE_DENIED":/locked|timed out|timeout|P2028|P1008|P2010/i.test(s)?"SQLITE_IO_OR_LOCK":/正在处理|另一个执行器/.test(s)?"LEASE_BUSY":"UNEXPECTED";stats.errors[key]=(stats.errors[key]??0)+1;stats.lastErrors.push(s.slice(0,800));if(stats.lastErrors.length>8)stats.lastErrors.shift();};
function proxy<T extends object>(target:T,methods:Record<string,unknown>):T{return new Proxy(target,{get(t,k){if(k in methods)return methods[String(k)];const v=Reflect.get(t,k);return typeof v==="function"?v.bind(t):v;}});}
const smartWorker=proxy(smart,{async listWorkerPage(q:any){stats.activePages++;stats.maxActivePages=Math.max(stats.maxActivePages,stats.activePages);try{const p=await smart.listWorkerPage(q);stats.smartPages++;stats.maxSmartPage=Math.max(stats.maxSmartPage,p.runs.length);return p;}finally{stats.activePages--;}},async recoverAbandonedScoped(p:string,id:string){if(recoveryFaults.has(id))await fs.readFile(path.join(folder,"missing-recovery-"+id));return smart.recoverAbandonedScoped(p,id);}});
const agentWorker=proxy(agent,{async listWorkerPage(after?:string){const p=await agent.listWorkerPage(after);stats.agentPages++;stats.maxAgentPage=Math.max(stats.maxAgentPage,p.cycles.length);return p;}});
const options={requestText:"Synthetic scale regression",generationSettings:{requestedModelVersion:"seedance2.0mini",aspectRatio:"9:16",videoResolution:"720p",nativeAudioOutputRequested:false},reviewMode:"MANUAL"};
async function project(id:string){await db.project.create({data:{id:"project-"+id,name:"Synthetic scale case",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});return "project-"+id;}
async function seedSmart(id:string,kind="eligible"){
  const projectId=await project(id),now=new Date().toISOString();
  const run=smartRunSchema.parse({id,projectId,requestKey:id,inputHash:hashValue({id}),revision:1,status:kind==="closed"?"CANCELLED":kind==="waiting-owned"?"WAITING_FOR_TRUTH_REVIEW":"PLANNING",stage:"SOURCES",options,targetDurationMs:15000,expectedWorkspace:{},attemptIds:[],notes:[],createdAt:now,updatedAt:now,...(!["closed","ungranted"].includes(kind)?{autoAdvanceGrant:{projectId,runId:id,authorizedAt:now,source:"USER_CREATED"}}:{})});
  await fs.writeFile(path.join(folder,id+".json"),"{\"synthetic\":true}");
  if(kind==="missing")await fs.unlink(path.join(folder,id+".json"));
  if(kind==="directory-write")await fs.mkdir(path.join(folder,id+".result"));
  await smartRepo.create(run);
  if(kind==="live"||kind==="waiting-owned")await smartRepo.acquire(projectId,id,"synthetic-live-owner",process.pid);
  return run;
}
async function seedAgent(id:string,kind="due"){
  const projectId=await project(id),now=new Date().toISOString(),input={requestKey:id,goal:"Synthetic saved action",stages:["OPERATIONS"] as const,maxSteps:1,maxToolCalls:1};
  const cycle:any={id,projectId,input,inputHash:hashValue(input),revision:1,status:"READY",steps:0,actions:[{id:"action-"+id,requestKey:id,capabilityId:"saved-read",input:{},inputHash:hashValue({}),contextHash:"synthetic",status:"PROPOSED",effect:"READ",preview:"Inert read",proposedAt:now}],evidence:[],loadedSkills:[],messages:[],createdAt:now,updatedAt:now,...(kind==="future"?{nextWakeAt:new Date(Date.now()+86400000).toISOString()}:{})};
  await agentRepo.create(cycle);if(kind==="live")await agentRepo.claim(projectId,id,"synthetic-agent-live");return cycle;
}
async function command(m:any):Promise<any>{
  if(m.op==="seed-bulk"){
    for(let i=0;i<32;i++)await seedSmart("00-live-"+String(i).padStart(4,"0"),"live");
    for(let i=0;i<480;i++)await seedSmart("10-eligible-"+String(i).padStart(4,"0"));
    for(let i=0;i<128;i++)await seedSmart("z-closed-"+String(i).padStart(4,"0"),"closed");
    for(let i=0;i<384;i++)await seedSmart("z-ungranted-"+String(i).padStart(4,"0"),"ungranted");
    for(let i=0;i<32;i++)await seedAgent("00-future-"+String(i).padStart(4,"0"),"future");
    for(let i=0;i<32;i++)await seedAgent("01-live-agent-"+String(i).padStart(4,"0"),"live");
    for(let i=0;i<96;i++)await seedAgent("10-agent-"+String(i).padStart(4,"0"));
    return {smart:1024,agent:160};
  }
  if(m.op==="seed-smart")return seedSmart(m.id,m.kind);
  if(m.op==="recovery-fault"){m.enabled?recoveryFaults.add(m.id):recoveryFaults.delete(m.id);return true;}
  if(m.op==="start"){stops.push(startSmartGenerationWorker(smartWorker,{policy:{mode:"MANAGED"},intervalMs:1000,onError}));stops.push(startAgentCycleWorker(agentWorker,onError));return {pid:process.pid,at:Date.now()};}
  if(m.op==="stop"){for(const stop of stops.splice(0))stop();return true;}
  if(m.op==="get")return smartRepo.get("project-"+m.id,m.id);
  if(m.op==="page")return smartRepo.listWorkerPage(m.query);
  if(m.op==="agent-page")return agentRepo.listWorkerPage(new Date().toISOString(),m.afterId);
  if(m.op==="summary"){
    const smart=await db.smartGenerationRunRecord.groupBy({by:["status"],_count:true}),agent=await db.agentCycleRecord.groupBy({by:["status"],_count:true});
    return {smart,agent,checkpoints:await db.smartGenerationCheckpointRecord.count(),providers:await db.aiProviderConfigRecord.count(),executions:await db.aiExecutionRecord.count(),attempts:await db.generationAttemptRecord.count()};
  }
  if(m.op==="sample")return {pid:process.pid,at:Date.now(),uptime:process.uptime(),memory:process.memoryUsage(),resources:process.getActiveResourcesInfo(),delayMaxMs:delay.max/1e6,stats};
  if(m.op==="close"){for(const stop of stops.splice(0))stop();delay.disable();await db.$disconnect();lines.close();process.stdin.pause();return {closed:true};}
  throw Error("UNKNOWN_SCALE_OPERATION");
}
const lines=createInterface({input:process.stdin});lines.on("line",line=>{const m=JSON.parse(line);void command(m).then(result=>emit({requestId:m.requestId,result})).catch(e=>emit({requestId:m.requestId,error:e instanceof Error?e.message:String(e)}));});
emit({ready:true,pid:process.pid});
