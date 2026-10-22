// This process has no spawn or outbound network primitive. IPC accepts only the
// fixed Go receipt protocol, never executable code or an alternate URL.
import './isolation-guard.mjs';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const pending=new Map(),finishes=new Map(),opsPending=new Map();let launch,server,dbClient,deps,closing=false;
let shutdownPhase='RUNNING';
const diagnostic=extra=>{try{fs.writeFileSync(path.join(process.env.TMP,'ego-lite-child-shutdown.json'),JSON.stringify({phase:shutdownPhase,...extra}));}catch{}};
process.on('uncaughtExceptionMonitor',error=>diagnostic({error:error.message,stack:error.stack}));
process.once('exit',code=>diagnostic({exitCode:code}));
process.on('message',message=>{
  if(message?.egoLiteInit&&!launch){launch=message.egoLiteInit;return;}
  if(message?.egoOpsReply){const r=message.egoOpsReply,p=opsPending.get(r.id);if(p){opsPending.delete(r.id);p.cleanup();r.error?p.reject(Error(r.error)):p.resolve(r.reply);}return;}
  if(message?.egoLiteEvent){const e=message.egoLiteEvent,p=pending.get(e.id);if(!p)return;p.events.push(e);if(e.type==='connected')p.context.localExecution?.report({phase:'CONNECTED',samples:0,workerExited:false});
    if(['succeeded','failed','timed_out','cancelled','rejected'].includes(e.type)){pending.delete(e.id);p.cleanup();p.resolve(p.events);}return;}
  if(message?.egoLiteError){const e=message.egoLiteError,p=pending.get(e.id);if(p){pending.delete(e.id);p.cleanup();p.reject(Error(e.code));}return;}
  const completed=message?.egoLiteFinished?.id??message?.egoLiteFinishError?.id;
  if(completed){const p=finishes.get(completed);if(p){finishes.delete(completed);clearTimeout(p.timer);message.egoLiteFinishError?p.reject(Error(message.egoLiteFinishError.code)):p.resolve(message.egoLiteFinished);}return;}
  if(message?.shutdown)void close();
});
process.once('disconnect',()=>void close());
const send=value=>{if(!process.connected)throw Error('EGO_LITE_SUPERVISOR_DISCONNECTED');process.send(value,()=>{});};
const launchDeadline=Date.now()+10000;
while(!launch&&!closing&&Date.now()<launchDeadline)await new Promise(r=>setTimeout(r,10));
if(!launch||closing)throw Error('EGO_LITE_LAUNCH_DISCONNECTED');
const {createDefaultDependencies,createAppServer}=await import('../dist/src/web/server.js');
const {prisma}=await import('../dist/src/adapters/db/prisma-client.js');
dbClient=prisma;
const {GoOwnedEgoResearchRuntime}=await import('../dist/src/adapters/research/go-owned-ego-research-runtime.js');
const {EgoBrowserResearchProvider}=await import('../dist/src/adapters/research/ego-browser-research-provider.js');
const {BrowserResearchBlockedError}=await import('../dist/src/application/ports/research-provider.js');
const {EgoLiteDouyinReadRuntime}=await import('../dist/src/adapters/douyin/ego-lite-douyin-read-runtime.js');
const u=new URL(launch.sourceUrl);
if(u.origin!=='http://127.0.0.1:'+process.env.PORT||!/^\/bridge-fixture\/[a-f0-9-]{36}$/.test(u.pathname)||!(/^[a-f0-9]{64}$/.test(launch.fingerprint)))throw Error('EGO_LITE_LAUNCH_DENIED');
const finish=(scope,runId)=>new Promise((resolve,reject)=>{
  if(!process.connected){reject(Error('EGO_LITE_SUPERVISOR_DISCONNECTED'));return;}
  const id=randomUUID(),timer=setTimeout(()=>{finishes.delete(id);reject(Error('EGO_LITE_FINISH_TIMEOUT'));},35000);finishes.set(id,{resolve,reject,timer});send({egoLiteFinish:{id,scope,runId}});
});
const opsRuntime=new EgoLiteDouyinReadRuntime(launch.opsEpoch,(context,input)=>new Promise((resolve,reject)=>{
  if(!context.localExecution||context.localExecution.signal.aborted||!process.connected){reject(Error('EGO_OPS_ACTION_CANCELLED'));return;}
  const id=randomUUID(),cancel=()=>{if(process.connected)send({egoOpsCancel:{id}});};
  const timer=setTimeout(()=>{opsPending.delete(id);cancel();cleanup();reject(Error('EGO_OPS_TIMEOUT'));},65000);
  const cleanup=()=>{clearTimeout(timer);context.localExecution.signal.removeEventListener('abort',cancel);};
  opsPending.set(id,{resolve,reject,cleanup});context.localExecution.signal.addEventListener('abort',cancel,{once:true});
  void deps.agentCycles.get(context.projectId,context.cycleId).then(cycle=>{const action=cycle?.actions.find(a=>a.id===context.actionId);if(!action||action.status!=='RUNNING'||!action.confirmedAt)throw Error('EGO_OPS_ACTION_CHANGED');send({egoOpsRequest:{id,...input,scope:{projectId:context.projectId,cycleId:context.cycleId,actionId:context.actionId,contextHash:action.contextHash}}});}).catch(error=>{opsPending.delete(id);cleanup();reject(error);});
}),launch.opsSource);
deps=createDefaultDependencies({egoLiteDouyinRead:opsRuntime,egoLiteSourceUrl:launch.sourceUrl,egoLiteReadSource:async({source,projectId,runId,action})=>{
  if(source.url!==launch.sourceUrl||!action.confirmed||!action.localExecution)throw Error('EGO_LITE_CONFIRMED_LOCAL_ACTION_REQUIRED');
  const cycle=await deps.agentCycles.get(projectId,action.cycleId),a=cycle?.actions.find(a=>a.id===action.actionId);
  if(!a||cycle.status!=='RUNNING'||a.status!=='RUNNING'||!a.confirmedAt)throw Error('EGO_LITE_ACTION_CHANGED');
  const scope={projectId,cycleId:action.cycleId,actionId:action.actionId,contextHash:a.contextHash};let ended='failed',captured=false,clean=false;
  try{
    const runtime=new GoOwnedEgoResearchRuntime({projectId,runId,sourceUrl:launch.sourceUrl,scope,executorFingerprint:launch.fingerprint,projectsRoot:deps.projectsRoot},request=>new Promise((resolve,reject)=>{
      if(action.localExecution.signal.aborted){reject(Error('EGO_LITE_ACTION_CANCELLED'));return;}
      const cancel=()=>send({egoLiteCancel:{id:request.id}});
      const timer=setTimeout(()=>{pending.delete(request.id);cancel();cleanup();reject(Error('EGO_LITE_RECEIPT_TIMEOUT'));},45000);
      const cleanup=()=>{clearTimeout(timer);action.localExecution.signal.removeEventListener('abort',cancel);};
      pending.set(request.id,{events:[],context:action,cleanup,resolve:events=>{ended=events.at(-1).type;resolve(events);},reject});
      action.localExecution.signal.addEventListener('abort',cancel,{once:true});send({egoLiteRequest:request});
    }));
    const provider=new EgoBrowserResearchProvider(runtime,deps.artifacts,deps.projectsRoot,{searchUrlTemplate:launch.sourceUrl,allowPrivateNetwork:true});
    const document=await provider.fetchOwnedSource(source,{projectId,runId});captured=true;return document;
  }finally{
    try{const receipt=await finish(scope,runId);clean=receipt.workerExited===true;if(receipt.failureCode)throw Error(receipt.failureCode);}catch(error){
      const code=/^EGO_LITE_[A-Z_]{1,70}$/.test(error.message)?error.message:'EGO_LITE_CLEANUP_FAILED';
      throw new BrowserResearchBlockedError({status:'BLOCKED',blockerCode:'BROWSER_SESSION_EXPIRED',message:'本机Ego执行已阻断：'+code,requiredUserAction:'核对原动作和退出回执；不自动重启宿主、恢复旧许可或重新采集。'});
    }finally{
      const phase=!clean?'FAILED':captured?'SUCCEEDED':ended==='timed_out'?'TIMED_OUT':action.localExecution.signal.aborted?'CANCELLED':'FAILED';
      action.localExecution.report({phase,samples:0,workerExited:clean});
    }
  }
}});
await deps.agentCycles.recoverInterruptedLocalExecutions();
server=createAppServer(deps);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.PORT),'127.0.0.1',resolve);});
send({ready:true});console.log('PVS_EGO_LITE_LOCAL_READY '+process.env.PORT);
async function close(){if(closing)return;closing=true;
  // An unresolved native Prisma promise does not itself keep Node alive once
  // IPC/listening sockets close. Hold a local handle through the durable drain.
  const keepAlive=setInterval(()=>{},100);shutdownPhase='DRAINING';
  try{
  const closed=server?new Promise(resolve=>server.close(resolve)):Promise.resolve();
  if(!process.connected){
    for(const p of opsPending.values()){p.cleanup();p.reject(Error('EGO_LITE_SUPERVISOR_DISCONNECTED'));}opsPending.clear();
    for(const p of pending.values()){p.cleanup();p.reject(Error('EGO_LITE_SUPERVISOR_DISCONNECTED'));}pending.clear();
    for(const p of finishes.values()){clearTimeout(p.timer);p.reject(Error('EGO_LITE_SUPERVISOR_DISCONNECTED'));}finishes.clear();
  }
  // Keep Prisma and the transport alive until Agent.advance has saved its
  // terminal result AND released its lease, including a late-cancel race.
  await deps?.agentCycles?.drainLocalExecutions();shutdownPhase='LEASES_RELEASED';await closed;
  await dbClient?.$disconnect();shutdownPhase='CLOSED';if(process.connected)process.disconnect();
  }finally{clearInterval(keepAlive);}
}
