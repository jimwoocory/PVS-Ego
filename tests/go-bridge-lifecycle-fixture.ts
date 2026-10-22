// Guarded synthetic fixture only. No process spawning, outbound sockets or factory import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import type {AgentCycleRepository} from '../src/application/ports/agent-cycle-repository.js';
import type {AgentCapability,AgentCapabilityCatalog} from '../src/application/ports/agent-capability.js';
import type {AgentCycle,LocalActionExecution} from '../src/domain/agent-cycle.js';
import type {ProductFlowService} from '../src/application/services/product-flow.js';
import {handleAgentCycleHttp} from '../src/web/agent-cycle-http.js';
import {hashValue} from '../src/domain/hashing.js';

class Memory implements AgentCycleRepository {
  rows=new Map<string,AgentCycle>();locks=new Map<string,string>();
  async create(c:AgentCycle){this.rows.set(c.id,structuredClone(c));return structuredClone(c);}
  async get(p:string,id:string){const c=this.rows.get(id);return c?.projectId===p?structuredClone(c):null;}
  async list(p?:string){return [...this.rows.values()].filter(c=>!p||c.projectId===p).map(c=>structuredClone(c));}
  async claim(p:string,id:string,owner:string){if(this.rows.get(id)?.projectId!==p||this.locks.has(id))return false;this.locks.set(id,owner);return true;}
  async save(c:AgentCycle,revision:number,owner:string){assert.equal(this.rows.get(c.id)?.revision,revision);assert.equal(this.locks.get(c.id),owner);this.rows.set(c.id,structuredClone(c));return c;}
  async release(id:string,owner:string){assert.equal(this.locks.get(id),owner);this.locks.delete(id);}
  async recoverAbandoned(){return false;}
}
const repo=new Memory(),projectId='synthetic-lifecycle-project',capabilityId='research.go-lifecycle-fixture';
let fingerprint=hashValue('lifecycle-context'),bridgeCalls=0,modelCalls=0,cancelRequests=0;
const input=createInterface({input:process.stdin}),events:unknown[]=[],checks:Record<string,boolean>={};
let receive:((event:any)=>void)|undefined;
input.on('line',line=>{const message=JSON.parse(line);if(message.fixtureClose===true){input.close();return;}receive?.(message);});
const emit=(value:unknown)=>console.log(JSON.stringify(value));
const capability:AgentCapability={id:capabilityId,title:'仅本机只读生命周期验证',description:'合成确认不代表真实业务许可',stage:'RESEARCH',effect:'HUMAN_DECISION',
  inputSchema:z.object({mode:z.enum(['probe','observe']),timeoutMs:z.union([z.literal(1800),z.literal(10000)])}).strict(),
  async run(ctx,raw){
    assert.equal(ctx.confirmed,true);assert.ok(ctx.localExecution);
    const c=(await repo.get(projectId,ctx.cycleId))!,action=c.actions.find(a=>a.id===ctx.actionId)!;
    assert.equal(action.status,'RUNNING');assert.equal(action.contextHash,fingerprint);assert.ok(repo.locks.has(c.id));
    const scope={projectId,cycleId:c.id,actionId:action.id,contextHash:action.contextHash};
    let sequence=0,samples=0,settled=false,boundary:Promise<void>|undefined;
    const hooks=ctx.localExecution;
    bridgeCalls++;
    const result=await new Promise<any>((resolve,reject)=>{
      const cancel=()=>{cancelRequests++;emit({bridgeCancel:{op:'cancel',id:action.id}});};
      hooks.signal.addEventListener('abort',cancel,{once:true});
      receive=event=>{
        try {
          assert.equal(settled,false);assert.equal(event.id,action.id);assert.deepEqual(event.scope,scope);
          assert.ok(Number.isSafeInteger(event.sequence)&&event.sequence>sequence);sequence=event.sequence;events.push(event);
          const phases:Record<string,LocalActionExecution['phase']>={started:'CONNECTING',connected:'CONNECTED',page:'CONNECTED',sample:'OBSERVING',succeeded:'SUCCEEDED',cancelled:'CANCELLED',timed_out:'TIMED_OUT',failed:'FAILED'};
          if(event.type==='sample'){samples++;boundary??=duringRun(c.id);}
          const terminal=['succeeded','cancelled','timed_out','failed'].includes(event.type);
          if(phases[event.type])hooks.report({phase:phases[event.type]!,samples,workerExited:terminal&&event.data?.workerExited===true});
          if(terminal){assert.equal(event.data.workerExited,true);settled=true;receive=undefined;hooks.signal.removeEventListener('abort',cancel);resolve(event);}
          else assert.ok(['started','connected','page','sample','done'].includes(event.type),'unknown transport event');
        }catch(error){receive=undefined;hooks.signal.removeEventListener('abort',cancel);reject(error);}
      };
      emit({bridgeRequest:{op:'start',id:action.id,mode:raw.mode,timeoutMs:raw.timeoutMs,scope}});
    });
    await boundary;
    return {status:result.type==='succeeded'?'COMPLETE':'BLOCKED',summary:result.type==='succeeded'?'本机连接已完成':result.type==='cancelled'?'本机只读观察已取消，工作进程退出已确认':result.type==='timed_out'?'本机只读观察超时，已停止且不会自动重试':'本机执行失败，保留回执',data:{terminal:result.type,workerExited:true}};
  }};
const catalog:AgentCapabilityCatalog={list:()=>[capability],get:id=>{assert.equal(id,capabilityId);return capability;},async snapshot(p){assert.equal(p,projectId);return {};},async fingerprint(){return fingerprint;},async validateCompletion(){return [];}};
const runtime={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
const cycles=new AgentCycleService(repo,catalog,runtime,undefined,new Set([capabilityId]));
async function prepare(mode:'probe'|'observe',timeoutMs:1800|10000,goal:string,confirmed=true){
  let c=await cycles.create(projectId,{goal,requestKey:randomUUID(),stages:['RESEARCH']});
  c=await cycles.invoke(projectId,c.id,{capabilityId,arguments:{mode,timeoutMs},requestKey:randomUUID()});
  if(confirmed)c=await cycles.confirm(projectId,c.id,{expectedRevision:c.revision,actionId:c.actions[0]!.id,inputHash:c.actions[0]!.inputHash});
  return c;
}
async function duringRun(id:string){
  const c=(await cycles.get(projectId,id))!;
  await assert.rejects(cycles.cancel(projectId,id,c.revision-1),/版本/);
  await assert.rejects(cycles.cancel('foreign-project',id,c.revision),/处理/);
  await assert.rejects(cycles.advance(projectId,id),/处理/);
  await assert.rejects(cycles.confirm(projectId,id,{expectedRevision:c.revision,actionId:c.actions[0]!.id,inputHash:c.actions[0]!.inputHash}),/处理/);
  assert.ok(repo.locks.has(id));checks.activeLeaseRetained=true;checks.staleCancelDenied=true;checks.foreignCancelDenied=true;checks.concurrentAdvanceDenied=true;
}
// No-injection service retains its old active cancellation restriction.
let finishPlain:()=>void=()=>{},plainStarted=false;
const plain:AgentCapability={...capability,async run(ctx){assert.equal(ctx.localExecution,undefined);plainStarted=true;await new Promise<void>(resolve=>finishPlain=resolve);return {status:'COMPLETE',summary:'仅内存替身完成'};}};
const plainCatalog:AgentCapabilityCatalog={...catalog,get:()=>plain};
const defaultService=new AgentCycleService(repo,plainCatalog,runtime);
const plainCycle=await prepare('probe',10000,'默认未注入接口验证');
const plainRun=defaultService.advance(projectId,plainCycle.id);
while(!plainStarted)await new Promise(resolve=>setTimeout(resolve,5));
await assert.rejects(defaultService.cancel(projectId,plainCycle.id,(await repo.get(projectId,plainCycle.id))!.revision),/处理/);
finishPlain();await plainRun;repo.rows.delete(plainCycle.id);checks.defaultNoCancellationHook=true;
const unconfirmed=await prepare('probe',10000,'未确认门验证',false);
assert.equal((await cycles.advance(projectId,unconfirmed.id)).status,'WAITING_CONFIRMATION');assert.equal(bridgeCalls,0);
await assert.rejects(cycles.confirm(projectId,unconfirmed.id,{expectedRevision:unconfirmed.revision+1,actionId:unconfirmed.actions[0]!.id,inputHash:unconfirmed.actions[0]!.inputHash}),/变化/);
fingerprint=hashValue('changed');await assert.rejects(cycles.confirm(projectId,unconfirmed.id,{expectedRevision:unconfirmed.revision,actionId:unconfirmed.actions[0]!.id,inputHash:unconfirmed.actions[0]!.inputHash}),/失效/);
await cycles.cancel(projectId,unconfirmed.id,unconfirmed.revision);assert.equal((await cycles.advance(projectId,unconfirmed.id)).status,'CANCELLED');repo.rows.delete(unconfirmed.id);
checks.unconfirmedDenied=true;checks.staleConfirmationDenied=true;checks.cancelledCycleNotRun=true;
const probe=await prepare('probe',10000,'连接：本轮合成只读探针');
const cancel=await prepare('observe',10000,'取消：本轮合成页面观察');
const timeout=await prepare('observe',1800,'超时：本轮合成页面观察');
const ids={probe:probe.id,cancel:cancel.id,timeout:timeout.id};
const session=process.env.PVS_ISOLATION_SESSION!,evidence=path.join(session,'evidence');fs.mkdirSync(evidence,{recursive:true});
const productFlow={async getProject(id:string){return id===projectId?{id,name:'Go 生命周期隔离验证'}:null;},async listProjects(){return [{id:projectId,name:'Go 生命周期隔离验证'}];}} as unknown as ProductFlowService;
const requests:Array<{method?:string;url?:string}>=[];
const server=http.createServer(async(req,res)=>{
  try {
    requests.push({method:req.method,url:req.url});const url=new URL(req.url!,'http://'+req.headers.host);
    if(url.pathname==='/__fixture-state'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ids,projectId,cycles:await cycles.list(projectId),checks,bridgeCalls,cancelRequests}));return;}
    if(url.pathname==='/__fixture-finish'&&req.method==='POST'){
      const p=(await cycles.get(projectId,ids.probe))!,c=(await cycles.get(projectId,ids.cancel))!,d=(await cycles.get(projectId,ids.timeout))!;
      assert.equal(p.actions[0]!.status,'SUCCEEDED');assert.equal(c.status,'CANCELLED');assert.equal(c.actions[0]!.localExecution!.phase,'CANCELLED');assert.equal(d.status,'BLOCKED');assert.equal(d.actions[0]!.localExecution!.phase,'TIMED_OUT');
      const before=bridgeCalls;await cycles.advance(projectId,c.id);await cycles.advance(projectId,d.id);
      await cycles.invoke(projectId,p.id,{capabilityId,arguments:p.actions[0]!.input,requestKey:p.actions[0]!.requestKey});
      assert.equal(bridgeCalls,before);assert.equal(before,3);assert.equal(cancelRequests,1);assert.equal(modelCalls,0);assert.equal(repo.locks.size,0);
      assert.ok(Object.values(checks).every(Boolean));
      const result={status:'PASS_GUARDED_LOCAL_LIFECYCLE',checks,bridgeCalls,cancelRequests,modelCalls,ids,cycles:[p,c,d],requests,events,productionWiring:false};
      fs.writeFileSync(path.join(evidence,'lifecycle-result.json'),JSON.stringify(result,null,2));
      res.end(JSON.stringify({status:'PASS',bridgeCalls,cancelRequests,modelCalls}));return;
    }
    if(await handleAgentCycleHttp(req,res,url,{agentCycles:cycles,productFlow}))return;
    res.writeHead(404).end();
  }catch(error){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({message:error instanceof Error?error.message:String(error)}));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address==='object');
const ready={origin:'http://127.0.0.1:'+address.port,projectId,ids,session};
input.once('close',()=>{
  // Parent acknowledges that the browser received the finish response before
  // asking us to close all connections owned by this synthetic HTTP server.
  server.close();server.closeAllConnections();process.stdin.destroy();
  fs.writeFileSync(path.join(evidence,'lifecycle-shutdown.json'),JSON.stringify({inputDestroyed:process.stdin.destroyed,activeResources:process.getActiveResourcesInfo()}));
});
process.once('beforeExit',()=>fs.writeFileSync(path.join(evidence,'lifecycle-before-exit.json'),JSON.stringify({code:process.exitCode??0,activeResources:process.getActiveResourcesInfo()})));
fs.writeFileSync(path.join(evidence,'lifecycle-ready.json'),JSON.stringify(ready,null,2));emit({lifecycleReady:ready});
