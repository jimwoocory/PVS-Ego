// Inert execution port, actual Prisma repositories, guarded process, synthetic rows only.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import {PrismaAgentCycleRepository} from '../src/adapters/db/prisma-agent-cycle-repository.js';
import type {AgentCapability,AgentCapabilityCatalog,AgentCapabilityContext} from '../src/application/ports/agent-capability.js';
import type {CapabilityResult} from '../src/domain/agent-cycle.js';
import {hashValue} from '../src/domain/hashing.js';

const db=new PrismaClient(),peerDb=new PrismaClient(),repo=new PrismaAgentCycleRepository(db),peerRepo=new PrismaAgentCycleRepository(peerDb);
const projectId='durable-synthetic-project';let modelCalls=0,executions=0,aborts=0,fingerprint=hashValue('initial');
type Control={hooks:NonNullable<AgentCapabilityContext['localExecution']>;resolve:(r:CapabilityResult)=>void;reject:(e:Error)=>void};
const controls=new Map<string,Control>();
const emit=(value:unknown)=>console.log(JSON.stringify(value));
const caps:AgentCapability[]=(['READ','HUMAN_DECISION'] as const).map(effect=>({id:'fixture.local-'+effect,title:'本机合成执行端口',description:'不连接Go或浏览器，仅注入生命周期事件',stage:'RESEARCH',effect,
  inputSchema:z.object({label:z.string().min(1).max(80)}).strict(),
  async run(ctx){
    assert.ok(ctx.localExecution);assert.equal(effect==='READ'||ctx.confirmed,true);executions++;
    return new Promise<CapabilityResult>((resolve,reject)=>{
      controls.set(ctx.actionId,{hooks:ctx.localExecution!,resolve,reject});ctx.localExecution!.signal.addEventListener('abort',()=>{aborts++;emit({aborted:ctx.actionId});},{once:true});
      emit({executionStarted:{cycleId:ctx.cycleId,actionId:ctx.actionId}});
    });
  }}));
const catalog:AgentCapabilityCatalog={list:()=>caps,get:id=>{const cap=caps.find(c=>c.id===id);assert.ok(cap);return cap;},async snapshot(p){assert.equal(p,projectId);return {};},async fingerprint(){return fingerprint;},async validateCompletion(){return [];}};
const runtime={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
const service=new AgentCycleService(repo,catalog,runtime,undefined,new Set(caps.map(c=>c.id)));
const otherService=new AgentCycleService(peerRepo,catalog,runtime,undefined,new Set(caps.map(c=>c.id)));
const lines=createInterface({input:process.stdin});
async function command(m:any):Promise<unknown>{
  if(m.op==='initialize'){
    await db.project.upsert({where:{id:projectId},create:{id:projectId,name:'新建空白库合成项目',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'},update:{}});
    return {projectId};
  }
  if(m.op==='prepare'){
    let c=await service.create(projectId,{goal:'仅持久化与异常测试 '+m.label,requestKey:randomUUID(),stages:['RESEARCH']});
    c=await service.invoke(projectId,c.id,{capabilityId:'fixture.local-'+(m.effect??'HUMAN_DECISION'),arguments:{label:m.label},requestKey:randomUUID()});
    if(m.confirm!==false&&c.status==='WAITING_CONFIRMATION')c=await service.confirm(projectId,c.id,{expectedRevision:c.revision,actionId:c.actions[0]!.id,inputHash:c.actions[0]!.inputHash});return c;
  }
  if(m.op==='get')return m.stored?peerRepo.get(m.projectId??projectId,m.id):service.get(m.projectId??projectId,m.id);
  if(m.op==='lease')return db.$queryRaw`SELECT leaseOwner,leasePid,revision FROM AgentCycleRecord WHERE id=${m.id} AND projectId=${projectId}`;
  if(m.op==='advance')return service.advance(projectId,m.id);
  if(m.op==='cancel'||m.op==='peer-cancel')return (m.op==='cancel'?service:otherService).cancel(m.projectId??projectId,m.id,m.revision);
  if(m.op==='invoke')return service.invoke(projectId,m.id,{capabilityId:m.capabilityId,arguments:m.arguments,requestKey:m.requestKey});
  if(m.op==='confirm')return service.confirm(projectId,m.id,m.input);
  if(m.op==='fingerprint'){fingerprint=hashValue(m.value);return true;}
  if(m.op==='recover')return peerRepo.recoverAbandoned(projectId,m.id);
  if(m.op==='event'){
    const control=controls.get(m.actionId);assert.ok(control);
    try{control.hooks.report(m.update);}catch(error){control.reject(error as Error);throw error;}return true;
  }
  if(m.op==='settle'){const control=controls.get(m.actionId);assert.ok(control);control.resolve({status:m.status??'COMPLETE',summary:'合成本机动作回执'});return true;}
  if(m.op==='disconnect'){const control=controls.get(m.actionId);assert.ok(control);control.reject(Error('FIXTURE_TRANSPORT_DISCONNECTED'));return true;}
  if(m.op==='stats')return {modelCalls,executions,aborts};
  if(m.op==='crash'){process.exit(73);}
  if(m.op==='close'){await Promise.all([db.$disconnect(),peerDb.$disconnect()]);return {closed:true};}
  throw Error('FIXTURE_COMMAND_DENIED');
}
lines.on('line',line=>{
  const m=JSON.parse(line);
  void command(m).then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error instanceof Error?error.message:String(error)}));
});
emit({ready:true,pid:process.pid});
