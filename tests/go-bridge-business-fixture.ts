// Real AgentCycleService with an in-memory repository; no production wiring or model.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import type {AgentCycleRepository} from '../src/application/ports/agent-cycle-repository.js';
import type {AgentCapabilityCatalog} from '../src/application/ports/agent-capability.js';
import type {AgentCycle} from '../src/domain/agent-cycle.js';
import {hashValue} from '../src/domain/hashing.js';
class Memory implements AgentCycleRepository {
 rows=new Map<string,AgentCycle>(); locks=new Map<string,string>();
 async create(c:AgentCycle){this.rows.set(c.id,structuredClone(c));return structuredClone(c);}
 async get(p:string,id:string){const c=this.rows.get(id);return c?.projectId===p?structuredClone(c):null;}
 async list(){return [...this.rows.values()].map(c=>structuredClone(c));}
 async claim(p:string,id:string,owner:string){if(this.rows.get(id)?.projectId!==p||this.locks.has(id))return false;this.locks.set(id,owner);return true;}
 async save(c:AgentCycle,revision:number,owner:string){assert.equal(this.rows.get(c.id)?.revision,revision);assert.equal(this.locks.get(c.id),owner);this.rows.set(c.id,structuredClone(c));return c;}
 async release(id:string,owner:string){assert.equal(this.locks.get(id),owner);this.locks.delete(id);}
 async recoverAbandoned(){return false;}
}
const input=createInterface({input:process.stdin});
let resolveResponse:((v:any)=>void)|undefined;
input.on('line',line=>resolveResponse?.(JSON.parse(line)));
const repo=new Memory(),projectId='synthetic-go-project';let fingerprint=hashValue('initial'),bridgeCalls=0,modelCalls=0;
const capability={id:'research.go-local-probe',title:'仅本机连接验证',description:'仅测试目录中注册；原确认链',stage:'RESEARCH' as const,effect:'HUMAN_DECISION' as const,inputSchema:z.object({mode:z.literal('probe')}).strict(),
 async run(ctx:{projectId:string;cycleId:string;actionId:string;confirmed:boolean}){
  assert.equal(ctx.confirmed,true);const running=await repo.get(ctx.projectId,ctx.cycleId),action=running!.actions.find(a=>a.id===ctx.actionId)!;assert.equal(action.status,'RUNNING');assert.equal(action.contextHash,fingerprint);bridgeCalls++;
  const response=await new Promise<any>(resolve=>{resolveResponse=resolve;console.log(JSON.stringify({bridgeRequest:{id:ctx.actionId,mode:'probe',scope:{projectId:ctx.projectId,cycleId:ctx.cycleId,actionId:ctx.actionId,contextHash:action.contextHash}}}));});
  assert.equal(response.type,'succeeded');assert.equal(response.scope.actionId,ctx.actionId);
  return {status:'COMPLETE' as const,summary:'仅本地 Go/Ego 连接完成',data:{bridgeId:response.id}};
 }};
const catalog:AgentCapabilityCatalog={list:()=>[capability],get:id=>{assert.equal(id,capability.id);return capability;},async snapshot(p){assert.equal(p,projectId);return {};},async fingerprint(){return fingerprint;},async validateCompletion(){return [];}};
const cycles=new AgentCycleService(repo,catalog,{id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}});
const prepare=async()=>{let c=await cycles.create(projectId,{goal:'仅本地 Go 连接',requestKey:randomUUID(),stages:['RESEARCH']});return cycles.invoke(projectId,c.id,{capabilityId:capability.id,arguments:{mode:'probe'},requestKey:randomUUID()});};
const old=await prepare();assert.equal((await cycles.advance(projectId,old.id)).status,'WAITING_CONFIRMATION');assert.equal(bridgeCalls,0);
await assert.rejects(cycles.confirm(projectId,old.id,{expectedRevision:old.revision+1,actionId:old.actions[0]!.id,inputHash:old.actions[0]!.inputHash}),/变化/);
fingerprint=hashValue('changed');await assert.rejects(cycles.confirm(projectId,old.id,{expectedRevision:old.revision,actionId:old.actions[0]!.id,inputHash:old.actions[0]!.inputHash}),/失效/);assert.equal(bridgeCalls,0);
let cancelled=await prepare();cancelled=await cycles.cancel(projectId,cancelled.id,cancelled.revision);assert.equal((await cycles.advance(projectId,cancelled.id)).status,'CANCELLED');assert.equal(bridgeCalls,0);
let fresh=await prepare();fresh=await cycles.confirm(projectId,fresh.id,{expectedRevision:fresh.revision,actionId:fresh.actions[0]!.id,inputHash:fresh.actions[0]!.inputHash});assert.equal(bridgeCalls,0);
fresh=await cycles.advance(projectId,fresh.id);assert.equal(fresh.actions[0]!.status,'SUCCEEDED');assert.equal(bridgeCalls,1);
await cycles.invoke(projectId,fresh.id,{capabilityId:capability.id,arguments:{mode:'probe'},requestKey:fresh.actions[0]!.requestKey});assert.equal(bridgeCalls,1);assert.equal(modelCalls,0);
console.log(JSON.stringify({businessResult:{unconfirmedDenied:true,staleContextDenied:true,staleRevisionDenied:true,cancelledCycleNotRun:true,confirmedActualBridgeCalls:bridgeCalls,duplicateNotRun:true,modelCalls}}));
input.close();
