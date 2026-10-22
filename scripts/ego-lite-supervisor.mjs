// Trusted local supervisor. Never imported by the guarded business process.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {root,confined,assertEnvironment} from './isolation-policy.mjs';
import {digest,loadInstallation,loadInstallationAsync} from './ego-lite-installation.mjs';
import {createDouyinReadSupervisor} from './ego-lite-douyin-supervisor.mjs';
import {writeHostHeartbeat} from './ego-lite-host-watchdog.mjs';

const terminal=new Set(['succeeded','failed','timed_out','cancelled','rejected']);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v);
const actionKey=s=>JSON.stringify([s?.projectId,s?.cycleId,s?.actionId,s?.contextHash]);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await delay(20);}throw Error(label);}
function child(exe,args,env,ipc=false,role='application'){
  const p=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe',...(ipc?['ipc']:[])]});
  const c={p,role,closed:false,code:null,signal:null,stdout:'',stderr:''};
  p.stdin.on('error',e=>{c.stdinError=e.code??'STDIN_CLOSED';});
  p.stdout.on('data',b=>{c.stdout=(c.stdout+b).slice(-8000000);});p.stderr.on('data',b=>{c.stderr=(c.stderr+b).slice(-100000);});
  p.on('error',e=>{c.error=e.code??'SPAWN_FAILED';});
  c.exit=new Promise(resolve=>p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});resolve(c);}));
  return c;
}
export async function startWorkbench({env,installation=loadInstallation(),opsFixture}){
  const scope=assertEnvironment(env);
  // Re-read every pin before any application or host process is started.
  if(JSON.stringify(loadInstallation())!==JSON.stringify(installation))throw Error('EGO_LITE_INSTALLATION_CHANGED');
  for(const dir of ['projects','tmp','home/local','home/roaming'])fs.mkdirSync(path.join(scope.session,dir),{recursive:true});
  const session=confined(path.join(root,'.runtime','go-bridge-workbench-'+randomUUID()));fs.mkdirSync(session,{recursive:true});
  const nonce=randomUUID(),origin='http://127.0.0.1:'+scope.port,sourceUrl=origin+'/bridge-fixture/'+nonce;
  const fingerprint=digest(path.join(root,'.runtime/ego-lite-installation.json'));
  const db=new DatabaseSync(scope.database,{readOnly:true});
  const children=[],events=[],completedScopes=new Set();let active,stopping=false,stopPromise;
  const app=child(process.execPath,[path.join(root,'scripts/serve-ego-lite-child.mjs')],env,true);children.push(app);
  if(opsFixture){const u=new URL(opsFixture.origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password||!id(opsFixture.nonce))throw Error('LOCAL_OPS_FIXTURE_REQUIRED');}
  const ops=createDouyinReadSupervisor({env,installation,origin,nonce,fixture:opsFixture,onHostClosed:event=>send({egoOpsHostClosed:event})}),opsEpoch=fingerprint+':'+nonce,opsScopes=new Set();
  const send=value=>{if(app.p.connected)app.p.send(value,()=>{});};
  function permit(request){
    if(!request||request.op!=='start'||!id(request.id)||!['session-open','session-read'].includes(request.mode)||request.timeoutMs!==10000||!id(request.researchRunId)||!request.scope||!id(request.scope.projectId)||!id(request.scope.cycleId)||!id(request.scope.actionId)||!(/^[a-f0-9]{64}$/.test(request.scope.contextHash)))throw Error('EGO_LITE_REQUEST_DENIED');
    const r=db.prepare('SELECT projectId,status,dataJson,leasePid,leaseOwner FROM AgentCycleRecord WHERE id=?').get(request.scope.cycleId);
    if(!r||r.projectId!==request.scope.projectId||r.status!=='RUNNING'||r.leasePid!==app.p.pid||!r.leaseOwner)throw Error('EGO_LITE_NO_LIVE_LEASE');
    const cycle=JSON.parse(r.dataJson),a=cycle.actions.find(a=>a.id===request.scope.actionId);
    if(cycle.status!=='RUNNING'||!cycle.input.stages.includes('RESEARCH')||!a||a.status!=='RUNNING'||a.capabilityId!=='research.collect-evidence'||a.effect!=='HUMAN_DECISION'||!a.confirmedAt||a.contextHash!==request.scope.contextHash||a.localExecution?.phase==='CANCELLING'||a.input.sourceUrls?.length!==1||a.input.sourceUrls[0].url!==sourceUrl||a.input.sourceUrls[0].sourceType!=='USER_URL')throw Error('EGO_LITE_ACTION_SCOPE_DENIED');
    const run=db.prepare('SELECT * FROM ResearchRunRecord WHERE id=?').get(request.researchRunId);
    if(!run||run.projectId!==r.projectId||run.status!=='RUNNING'||run.mode!=='BASIC'||run.goal!==a.input.goal||JSON.parse(run.queriesJson).length||JSON.parse(run.sourceUrlsJson).length!==1||JSON.parse(run.sourceUrlsJson)[0].url!==sourceUrl||JSON.parse(run.browserStateJson??'{}').collectionOnly!==true)throw Error('EGO_LITE_RESEARCH_SCOPE_DENIED');
    return actionKey(request.scope);
  }
  async function initialize(key,runId,request){
    if(stopping||completedScopes.has(key)||completedScopes.size>=256)throw Error('EGO_LITE_SCOPE_ALREADY_CLOSED');
    if(active){if(active.key!==key||active.runId!==runId||active.finishing)throw Error('EGO_LITE_BUSY');return active.ready;}
    const local=active={key,runId,pending:new Map(),waitingIds:new Set(),ids:new Set(),requests:0,cancelled:false,dir:path.join(session,'go-bridge-action-'+randomUUID())};
    fs.mkdirSync(local.dir,{recursive:true});fs.mkdirSync(path.join(local.dir,'evidence'));
    // Full pin I/O yields to cancellation, shutdown and durable scope changes.
    // Recheck before either owned process is created, not only before Go input.
    const assertLaunchAllowed=()=>{
      if(stopping||local.cancelled||local.finishing||active!==local)throw Error('EGO_LITE_CANCELLED_BEFORE_HOST');
      if(permit(request)!==key)throw Error('EGO_LITE_ACTION_SCOPE_DENIED');
    };
    local.ready=(async()=>{
      if(JSON.stringify(await loadInstallationAsync())!==JSON.stringify(installation)||digest(path.join(root,'.runtime/ego-lite-installation.json'))!==fingerprint)throw Error('EGO_LITE_INSTALLATION_CHANGED');
      assertLaunchAllowed();
      const stop=path.join(local.dir,'stop'),entry=path.join(local.dir,'host.mjs'),heartbeat=path.join(local.dir,'supervisor-heartbeat');local.stopFile=stop;
      const leaseId=randomUUID();let sequence=0;
      writeHostHeartbeat(heartbeat,process.pid,leaseId,sequence++);local.heartbeat=setInterval(()=>{try{writeHostHeartbeat(heartbeat,process.pid,leaseId,sequence++);}catch{clearInterval(local.heartbeat);}},500);
      fs.writeFileSync(entry,`import {app} from 'electron';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {installHostWatchdog} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/ego-lite-host-watchdog.mjs')).href)};app.on('session-created',s=>{s.webRequest.onBeforeRequest((d,cb)=>{let allow=false;try{const u=new URL(d.url);if(u.protocol==='file:'){const rel=path.relative(${JSON.stringify(path.dirname(installation.hostMain))},fileURLToPath(u));allow=rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);}else allow=u.href==='about:blank'||(d.method==='GET'&&u.href===${JSON.stringify(sourceUrl)});}catch{}cb({cancel:!allow});});s.on('will-download',(event,item)=>{event.preventDefault();item.cancel();});});installHostWatchdog({app,parentPid:${process.pid},leaseId:${JSON.stringify(leaseId)},heartbeatFile:${JSON.stringify(heartbeat)},stopFile:${JSON.stringify(stop)}});await import(${JSON.stringify(pathToFileURL(installation.hostMain).href)});`);
      const hostEnv={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(env[k])hostEnv[k]=env[k];
      Object.assign(hostEnv,{EGO_WINDOWS_DATA_DIR:path.join(local.dir,'host'),PATH:path.dirname(process.execPath),HOME:local.dir,USERPROFILE:local.dir,LOCALAPPDATA:path.join(local.dir,'home/local'),APPDATA:path.join(local.dir,'home/roaming'),TEMP:local.dir,TMP:local.dir});
      local.host=child(installation.electron,[entry,'--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],hostEnv,false,'host');children.push(local.host);
      local.host.p.once('close',()=>{
        if(!local.finishing){local.failureCode='EGO_LITE_HOST_DISCONNECTED';for(const requestId of local.pending.keys())local.bridge?.p.stdin.write(JSON.stringify({op:'cancel',id:requestId})+'\n');}
      });
      await until(()=>local.host.stdout.includes('EGO_WINDOWS_HOST_READY')||local.host.closed,'EGO_LITE_HOST_START_TIMEOUT',30000);
      if(local.host.closed)throw Error('EGO_LITE_HOST_START_FAILED');
      assertLaunchAllowed();
      const host=JSON.parse(fs.readFileSync(path.join(local.dir,'host/host-instance.json'),'utf8'));
      const pin=file=>installation.pins.find(p=>p.file===file).sha256;
      const cfg={contract:'pvs-go-ego-local-v1',session:local.dir,node:installation.node,nodeSha256:pin(installation.node),cli:installation.cli,cliSha256:pin(installation.cli),sdk:installation.sdk,sdkSha256:pin(installation.sdk),dataDir:path.join(local.dir,'host'),instanceId:'windows-host:'+host.instanceId,origin,nonce};
      const config=path.join(local.dir,'config.json');fs.writeFileSync(config,JSON.stringify(cfg));
      local.bridge=child(installation.bridge,['--config',config],hostEnv,false,'bridge');children.push(local.bridge);
      createInterface({input:local.bridge.p.stdout}).on('line',line=>{
        if(line.length>2000000){local.bridge.p.kill();return;}
        let event;try{event=JSON.parse(line);}catch{local.bridge.p.kill();return;}
        if(event.type==='ready'){local.bridgeReady=true;return;}
        const pending=local.pending.get(event.id);if(!pending)return;
        if(++pending.count>66){local.bridge.p.kill();return;}
        events.push({id:event.id,type:event.type,at:event.at,code:event.code,workerPid:event.data?.workerPid,workerExited:event.data?.workerExited});send({egoLiteEvent:event});
        if(terminal.has(event.type))local.pending.delete(event.id);
      });
      local.bridge.p.once('close',()=>{if(!local.finishing)local.failureCode??='EGO_LITE_BRIDGE_DISCONNECTED';for(const requestId of local.pending.keys())send({egoLiteError:{id:requestId,code:'EGO_LITE_BRIDGE_CLOSED'}});local.pending.clear();});
      await until(()=>local.bridgeReady||local.bridge.closed,'EGO_LITE_BRIDGE_START_TIMEOUT');if(local.bridge.closed)throw Error('EGO_LITE_BRIDGE_START_FAILED');
    })().catch(error=>{
      local.failureCode??=/^EGO_LITE_[A-Z_]{1,70}$/.test(error.message)?error.message:'EGO_LITE_INITIALIZATION_FAILED';
      throw Error(local.failureCode);
    });return local.ready;
  }
  function finish(){
    const local=active;if(!local)return Promise.resolve({workerExited:true,clean:true});
    if(local.finishing)return local.finishing;
    local.finishing=(async()=>{
    await local.ready.catch(()=>{});
    if(local.heartbeat)clearInterval(local.heartbeat);
    if(local.bridge&&!local.bridge.closed){local.bridge.p.stdin.end();await until(()=>local.bridge.closed,'EGO_LITE_BRIDGE_STOP_TIMEOUT',12000).catch(()=>{local.bridge.forced=true;local.bridge.p.kill();});await until(()=>local.bridge.closed,'EGO_LITE_BRIDGE_KILL_UNCONFIRMED',3000).catch(()=>{});}
    if(local.host&&!local.host.closed){fs.writeFileSync(local.stopFile,'owned host only');await until(()=>local.host.closed,'EGO_LITE_HOST_STOP_TIMEOUT',10000).catch(()=>{local.host.forced=true;local.host.p.kill();});await until(()=>local.host.closed,'EGO_LITE_HOST_KILL_UNCONFIRMED',3000).catch(()=>{});}
    const owned=[local.bridge,local.host].filter(Boolean),workerExited=owned.every(c=>c.closed&&!c.forced),clean=owned.every(c=>c.closed&&c.code===0&&!c.forced);
    const receipt={workerExited,clean,...(local.failureCode?{failureCode:local.failureCode}:!clean?{failureCode:'EGO_LITE_CHILD_EXIT_UNCONFIRMED'}:{})};
    fs.writeFileSync(path.join(local.dir,'exit-receipt.json'),JSON.stringify({...receipt,diagnostics:owned.map(c=>({role:c.role,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr}))}));completedScopes.add(local.key);active=undefined;return receipt;
    })();return local.finishing;
  }
  app.p.on('message',message=>{
    if(message?.ready){app.ready=true;return;}
    if(message?.egoOpsCancel){if(id(message.egoOpsCancel.id))ops.cancel(message.egoOpsCancel.id);return;}
    if(message?.egoOpsRequest){void(async()=>{const r=message.egoOpsRequest;try{
      if(!r||!id(r.id)||r.epoch!==opsEpoch||!['open','identity','works'].includes(r.operation)||!r.scope||!id(r.scope.projectId)||!id(r.scope.cycleId)||!id(r.scope.actionId)||!(/^[a-f0-9]{64}$/.test(r.scope.contextHash)))throw Error('EGO_OPS_REQUEST_DENIED');
      const row=db.prepare('SELECT projectId,status,dataJson,leasePid,leaseOwner FROM AgentCycleRecord WHERE id=?').get(r.scope.cycleId);
      if(!row||row.projectId!==r.scope.projectId||row.status!=='RUNNING'||row.leasePid!==app.p.pid||!row.leaseOwner)throw Error('EGO_OPS_LEASE_DENIED');
      const cycle=JSON.parse(row.dataJson),a=cycle.actions.find(a=>a.id===r.scope.actionId),key=actionKey(r.scope);
      if(stopping||!cycle.input.stages.includes('OPERATIONS')||!a||a.status!=='RUNNING'||a.effect!=='HUMAN_DECISION'||a.capabilityId!=='operations.ego-lite-'+r.operation||!a.confirmedAt||a.contextHash!==r.scope.contextHash||a.input.epoch!==opsEpoch||a.localExecution?.phase==='CANCELLING'||a.input.expectedAccountUid!==r.expectedAccountUid||a.input.count!==r.count||a.input.cursor!==r.cursor||a.input.expectedPageToken!==r.expectedPageToken||opsScopes.has(key)||opsScopes.size>=256)throw Error('EGO_OPS_ACTION_DENIED');
      opsScopes.add(key);const reply=await ops.execute(r);send({egoOpsReply:{id:r.id,reply}});
    }catch(error){send({egoOpsReply:{id:r?.id,error:/^EGO_[A-Z_]+$/.test(error.message)?error.message:'EGO_OPS_FAILED'}});}})();return;}
    if(message?.egoLiteRequest){void(async()=>{
      const r=message.egoLiteRequest;
      try{
        const key=permit(r),ready=initialize(key,r.researchRunId,r);
        if(active?.key===key&&active.runId===r.researchRunId)active.waitingIds.add(r.id);
        await ready;if(!active||active.key!==key||active.runId!==r.researchRunId||active.cancelled||active.finishing){send({egoLiteError:{id:r.id,code:'EGO_LITE_CANCELLED_BEFORE_WORKER',workerExited:true}});return;}
        active.waitingIds.delete(r.id);
        if(active.failureCode)throw Error(active.failureCode);
        permit(r);if(active.requests>=8||active.ids.has(r.id)||active.pending.size)throw Error('EGO_LITE_REQUEST_LIMIT');
        active.requests++;active.ids.add(r.id);active.pending.set(r.id,{count:0});active.bridge.p.stdin.write(JSON.stringify(r)+'\n');
      }catch(error){send({egoLiteError:{id:r?.id,code:error.message}});}
    })();return;}
    if(message?.egoLiteCancel){const r=message.egoLiteCancel;if(active&&id(r.id)&&(active.pending.has(r.id)||active.waitingIds.has(r.id))){active.cancelled=true;if(active.pending.has(r.id))active.bridge.p.stdin.write(JSON.stringify({op:'cancel',id:r.id})+'\n');}return;}
    if(message?.egoLiteFinish){const r=message.egoLiteFinish;if(!id(r.id))return;
      const own=active&&active.key===actionKey(r.scope)&&active.runId===r.runId;
      void(own?finish():Promise.resolve({workerExited:true,clean:true})).then(receipt=>send({egoLiteFinished:{id:r.id,...receipt}})).catch(error=>send({egoLiteFinishError:{id:r.id,code:error.message}}));}
  });
  send({egoLiteInit:{sourceUrl,fingerprint,opsEpoch,opsSource:ops.source}});
  try{
    await until(()=>app.ready||app.closed,'EGO_LITE_APPLICATION_START_TIMEOUT');
    if(app.closed)throw Error('EGO_LITE_APPLICATION_START_FAILED '+app.stderr);
  }catch(error){
    send({shutdown:true});await until(()=>app.closed,'EGO_LITE_STARTUP_CLEANUP_TIMEOUT',3000).catch(()=>app.p.kill());await app.exit;db.close();throw error;
  }
  const stop=()=>stopPromise??=(async()=>{
    stopping=true;send({shutdown:true});if(active){active.cancelled=true;for(const requestId of active.pending.keys())active.bridge?.p.stdin.write(JSON.stringify({op:'cancel',id:requestId})+'\n');}
    const cleanup=await finish().catch(error=>({workerExited:false,clean:false,failureCode:error.message}));
    await until(()=>app.closed,'EGO_LITE_APPLICATION_STOP_TIMEOUT',45000).catch(()=>{app.forced=true;app.p.kill();});await until(()=>app.closed,'EGO_LITE_APPLICATION_KILL_UNCONFIRMED',3000).catch(()=>{});const opsChildren=await ops.stop();db.close();
    const recorded=[...children.map(c=>({pid:c.p.pid,role:c.role,closed:c.closed,code:c.code,signal:c.signal,error:c.error,forced:c.forced??false})),...opsChildren];
    const record={sourceUrl,events,cleanup,children:recorded,status:recorded.every(c=>c.closed&&c.code===0&&!c.forced)?'CLEAN_OWNED_EXITS':'EXIT_NOT_CLEAN'};
    fs.writeFileSync(path.join(session,'receipt.json'),JSON.stringify(record,null,2));return record;
  })();
  app.p.once('close',()=>{if(!stopping)void stop().catch(()=>{});});
  const snapshot=()=>({events:[...events],children:[...children.map(c=>({pid:c.p.pid,role:c.role,closed:c.closed,code:c.code})),...ops.snapshot().children],active:active?{dir:active.dir}:null,ops:ops.snapshot()});
  return {origin,sourceUrl,session,stop,application:app,events,snapshot};
}
