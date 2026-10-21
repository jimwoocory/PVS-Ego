// This process has no spawn or outbound network primitive. IPC accepts only the
// fixed Go receipt protocol, never executable code or an alternate URL.
import './isolation-guard.mjs';
import {randomUUID} from 'node:crypto';
const pending=new Map(),finishes=new Map();let launch,server,dbClient,closing=false;
process.on('message',message=>{
  if(message?.egoLiteInit&&!launch){launch=message.egoLiteInit;return;}
  if(message?.egoLiteEvent){const e=message.egoLiteEvent,p=pending.get(e.id);if(!p)return;p.events.push(e);if(e.type==='connected')p.context.localExecution?.report({phase:'CONNECTED',samples:0,workerExited:false});
    if(['succeeded','failed','timed_out','cancelled','rejected'].includes(e.type)){pending.delete(e.id);p.cleanup();p.resolve(p.events);}return;}
  if(message?.egoLiteError){const e=message.egoLiteError,p=pending.get(e.id);if(p){pending.delete(e.id);p.cleanup();p.reject(Error(e.code));}return;}
  const completed=message?.egoLiteFinished??message?.egoLiteFinishError?.id;
  if(completed){const p=finishes.get(completed);if(p){finishes.delete(completed);clearTimeout(p.timer);message.egoLiteFinishError?p.reject(Error(message.egoLiteFinishError.code)):p.resolve();}return;}
  if(message?.shutdown)void close();
});
process.once('disconnect',()=>void close());
const send=value=>{if(!process.connected)throw Error('EGO_LITE_SUPERVISOR_DISCONNECTED');process.send(value);};
const launchDeadline=Date.now()+10000;
while(!launch&&!closing&&Date.now()<launchDeadline)await new Promise(r=>setTimeout(r,10));
if(!launch||closing)throw Error('EGO_LITE_LAUNCH_DISCONNECTED');
const {createDefaultDependencies,createAppServer}=await import('../dist/src/web/server.js');
const {prisma}=await import('../dist/src/adapters/db/prisma-client.js');
dbClient=prisma;
const {GoOwnedEgoResearchRuntime}=await import('../dist/src/adapters/research/go-owned-ego-research-runtime.js');
const {EgoBrowserResearchProvider}=await import('../dist/src/adapters/research/ego-browser-research-provider.js');
const u=new URL(launch.sourceUrl);
if(u.origin!=='http://127.0.0.1:'+process.env.PORT||!/^\/bridge-fixture\/[a-f0-9-]{36}$/.test(u.pathname)||!(/^[a-f0-9]{64}$/.test(launch.fingerprint)))throw Error('EGO_LITE_LAUNCH_DENIED');
const finish=(scope,runId)=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{finishes.delete(id);reject(Error('EGO_LITE_FINISH_TIMEOUT'));},30000);finishes.set(id,{resolve,reject,timer});send({egoLiteFinish:{id,scope,runId}});});
let deps;
deps=createDefaultDependencies({egoLiteSourceUrl:launch.sourceUrl,egoLiteReadSource:async({source,projectId,runId,action})=>{
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
    try{await finish(scope,runId);clean=true;}finally{
      const phase=captured?'SUCCEEDED':action.localExecution.signal.aborted?'CANCELLED':ended==='timed_out'?'TIMED_OUT':'FAILED';
      action.localExecution.report({phase,samples:0,workerExited:clean});
    }
  }
}});
server=createAppServer(deps);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.PORT),'127.0.0.1',resolve);});
send({ready:true});console.log('PVS_EGO_LITE_LOCAL_READY '+process.env.PORT);
async function close(){if(closing)return;closing=true;for(const [id,p] of pending){try{send({egoLiteCancel:{id}});}catch{}p.cleanup();p.reject(Error('EGO_LITE_APPLICATION_CLOSING'));}pending.clear();
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await dbClient?.$disconnect();if(process.connected)process.disconnect();
}
