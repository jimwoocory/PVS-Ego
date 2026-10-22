import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';
import {hashValue} from '../dist/src/domain/hashing.js';
const run=promisify(execFile),session=process.env.PVS_LIFECYCLE_SESSION,powershell=path.join(process.env.SystemRoot??process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
confined(session,path.join(root,'.runtime/isolation-sessions'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(read,test,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await read();if(test(v))return v;await pause(15);}throw Error('TIMEOUT '+label);}
test('actual owned Ego host disconnect, supervisor shutdown and timeout combinations',{timeout:240000},async t=>{
 const results=[],cases=[],resources=[];let baseline;
 async function open(name,previous){
  const business=previous?.business??path.join(session,name);for(const d of ['projects','tmp','home/local','home/roaming'])fs.mkdirSync(path.join(business,d),{recursive:true});
  const database=path.join(business,'blank.db'),db=new DatabaseSync(database);
  if(!previous){for(const dir of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const sql=path.join(root,'prisma/migrations',dir,'migration.sql');if(fs.existsSync(sql))db.exec(fs.readFileSync(sql,'utf8'));}assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);}
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const env=isolatedEnvironment({PVS_ISOLATION_SESSION:business,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(business,'projects'),PORT:String(port)});
  const p=spawn(process.execPath,[path.join(root,'tests/support/ego-lite-lifecycle-supervisor.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const c={name,business,database,db,p,closed:false,pending:new Map(),output:'',errors:'',knownPids:new Set(),faults:[],frozen:false};resources.push(c);
  p.stdout.on('data',b=>c.output+=b);p.stderr.on('data',b=>c.errors+=b);p.on('error',e=>c.errors+=e.message);
  p.on('message',m=>{if(m.ready)c.ready=m.ready;const h=c.pending.get(m.requestId);if(h){c.pending.delete(m.requestId);clearTimeout(h.timer);m.error?h.reject(Error(m.error)):h.resolve(m.result);}});
  c.exit=new Promise(resolve=>p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const h of c.pending.values()){clearTimeout(h.timer);h.reject(Error('TEST_SUPERVISOR_CLOSED'));}c.pending.clear();resolve({pid:p.pid,code,signal});}));
  c.rpc=(op,ms=45000)=>new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{c.pending.delete(requestId);reject(Error('SUPERVISOR_RPC_TIMEOUT_'+op));},ms);c.pending.set(requestId,{resolve,reject,timer});p.send({op,requestId},()=>{});});
  await until(()=>c.ready??c.closed,v=>Boolean(v),'supervisor ready');assert.equal(c.closed,false,c.errors);
  c.request=async(method,url,body)=>{const r=await fetch(c.ready.origin+url,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const text=await r.text();let value;try{value=JSON.parse(text);}catch{}return {status:r.status,type:r.headers.get('content-type'),text,value};};
  c.post=async(url,body)=>{const r=await c.request('POST',url,body);assert.equal(r.status,200,r.text);return r.value.result;};
  c.project=previous?.project??(await c.request('POST','/api/projects',{name:'Synthetic lifecycle '+name,targetDurationMs:15000})).value.project;
  c.base='/api/projects/'+c.project.id+'/agent-cycles';
  c.readCycle=()=>JSON.parse(db.prepare('SELECT dataJson FROM AgentCycleRecord WHERE id=?').get(c.cycle.id).dataJson);
  c.start=async({waitForWorker=true}={})=>{
   let cycle=await c.post(c.base,{goal:'Only synthetic local lifecycle '+name,requestKey:randomUUID(),stages:['RESEARCH']});
   cycle=await c.post(c.base+'/'+cycle.id+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal:'Only synthetic local lifecycle '+name,sourceUrls:[{url:c.ready.sourceUrl,sourceType:'USER_URL'}]},requestKey:randomUUID()});
   c.cycle=await c.post(c.base+'/'+cycle.id+'/confirm',{expectedRevision:cycle.revision,actionId:cycle.actions[0].id,inputHash:cycle.actions[0].inputHash});
   c.advance=c.post(c.base+'/'+cycle.id+'/advance',{}).then(value=>({value}),error=>({error:error.message}));
   if(!waitForWorker)return;
   const state=await until(async()=>{const s=await c.rpc('snapshot');if(!s.events.length&&c.readCycle().actions[0].status==='FAILED')throw Error('EARLY_ACTION_FAILURE '+JSON.stringify(c.readCycle().actions[0]));return s;},s=>s.events.some(e=>e.type==='started'),'actual Go started');await remember(c,state);return state;
  };
  c.arm=async()=>{
   const helper=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests/support/ego-lite-owned-fault.ps1'),'-TargetProcessId','0','-ExpectedParentId',String(c.p.pid),'-ActionDirectory',c.ready.session,'-Mode','ArmSuspend'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
   let output='',errors='';helper.stdout.on('data',b=>output+=b);helper.stderr.on('data',b=>errors+=b);
   c.armed=new Promise((resolve,reject)=>helper.once('close',code=>{if(code!==0){reject(Error('ARM_SUSPEND_FAILED '+errors));return;}const value=JSON.parse(output.trim().split(/\r?\n/).at(-1));Object.assign(c,{frozen:true,hostPid:value.pid,actionDirectory:value.actionDirectory});c.faults.push({mode:'ArmSuspend',value});resolve(value);}));
   void c.armed.catch(()=>{});await until(()=>output.includes('ARMED')?true:errors||false,v=>Boolean(v),'native fault controller armed',10000);assert.ok(output.includes('ARMED'),errors);
  };
  return c;
 }
 async function remember(c,s){c.snapshot=s;for(const child of s.children)c.knownPids.add(child.pid);for(const event of s.events)if(event.workerPid)c.knownPids.add(event.workerPid);if(s.active)c.actionDirectory=s.active.dir;}
 async function fault(c,mode){
  const snapshot=await c.rpc('snapshot');await remember(c,snapshot);
  const target=snapshot.children.find(v=>v.role===(mode==='FreezeWorker'?'bridge':'host')&&!v.closed);assert.ok(target,'owned target is live');
  const r=await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests/support/ego-lite-owned-fault.ps1'),'-TargetProcessId',String(target.pid),'-ExpectedParentId',String(c.p.pid),'-ActionDirectory',c.actionDirectory,'-Mode',mode],{cwd:root,windowsHide:true,timeout:10000});
  const value=JSON.parse(r.stdout.trim());c.faults.push({mode,value});if(mode==='FreezeWorker')for(const pid of [...value.workers,...value.ancillary])c.knownPids.add(pid);if(mode==='Suspend'){c.frozen=true;c.hostPid=target.pid;}if(mode==='Resume'||mode==='Terminate')c.frozen=false;
 }
 async function resumeAfterDeath(c){
  if(!c.frozen||!alive(c.hostPid))return;
  const r=await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests/support/ego-lite-owned-fault.ps1'),'-TargetProcessId',String(c.hostPid),'-ExpectedParentId',String(c.p.pid),'-ActionDirectory',c.actionDirectory,'-Mode','Resume'],{cwd:root,windowsHide:true,timeout:10000});c.faults.push({mode:'ResumeAfterSupervisorDeath',value:JSON.parse(r.stdout.trim())});c.frozen=false;
 }
 async function stop(c,expectedHostFault=false){
  if(c.frozen)await fault(c,'Resume');
  const receipt=await c.rpc('stop');c.receipt=receipt;const exit=await c.exit;assert.equal(exit.code,0,c.errors);
  assert.ok(receipt.children.every(ch=>ch.closed&&!ch.forced),JSON.stringify(receipt));
  for(const ch of receipt.children){if(expectedHostFault&&ch.role==='host')assert.equal(ch.code,91);else assert.equal(ch.code,0,JSON.stringify(ch));c.knownPids.add(ch.pid);}
  await until(()=>[...c.knownPids].filter(alive),pids=>!pids.length,'owned PIDs gone');return receipt;
 }
 function verifyDb(c){for(const table of ['AiProviderConfigRecord','AiExecutionRecord','GenerationRequestRecord','GenerationAttemptRecord'])assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);}
 function record(c,expectedExitsVerified=true){verifyDb(c);const state={name:c.name,expectedExitsVerified,ownedGone:[...c.knownPids].every(pid=>!alive(pid)),knownPids:[...c.knownPids],actionDirectory:c.actionDirectory,supervisor:{pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal},faults:c.faults,receipt:c.receipt??null,cycle:c.cycle?c.readCycle():null};cases.push(state);fs.writeFileSync(path.join(session,'evidence',c.name+'.json'),JSON.stringify({...state,stderr:c.errors,stdout:c.output},null,2));}
 t.after(async()=>{for(const c of resources){try{if(c.frozen){if(c.closed)await resumeAfterDeath(c);else await fault(c,'Resume');}if(!c.closed)await stop(c,c.faults.some(f=>f.mode==='Terminate'));}catch(error){fs.writeFileSync(path.join(session,'evidence',c.name+'-cleanup-failed.json'),JSON.stringify({error:error.message,stderr:c.errors}));if(!c.closed)c.p.kill();}finally{c.db.close();}}});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});assert.ok(passed,name);};
 const finishAction=async c=>{const result=await c.advance;assert.ok(result.value,result.error);return result.value;};
 const evidenceCount=c=>c.db.prepare('SELECT COUNT(*) AS n FROM ResearchEvidenceRecord').get().n;
 const terminalEvents=s=>s.events.filter(e=>['succeeded','failed','timed_out','cancelled','rejected'].includes(e.type));
 const watchdogReceipt=c=>{const files=fs.readdirSync(c.actionDirectory).filter(f=>/^host-lifecycle-[a-f0-9-]{36}\.json$/.test(f));assert.equal(files.length,1);return JSON.parse(fs.readFileSync(path.join(c.actionDirectory,files[0]),'utf8'));};
 await check('default research bootstrap survives a forward and backward host clock jump with fresh heartbeats',async()=>{
  const c=await open('clock-sweep');await c.rpc('clock-sweep');await c.start({waitForWorker:false});
  const state=await until(()=>c.rpc('snapshot'),s=>Boolean(s.active),'actual default initialization');await remember(c,state);
  const result=await finishAction(c);assert.equal(result.status,'WAITING_USER',JSON.stringify(result.actions[0]));assert.equal(result.actions[0].localExecution.phase,'SUCCEEDED');assert.equal(evidenceCount(c),1);
  await remember(c,await c.rpc('snapshot'));await stop(c);
  const clock=JSON.parse(fs.readFileSync(path.join(c.actionDirectory,'test-clock-probe.json'),'utf8'));assert.deepEqual(clock.steps.map(s=>s.offset),[3600000,-3600000,0]);assert.equal(clock.readyReleased,true);assert.equal(clock.originalReadyObserved,true);assert.ok(clock.steps.every(s=>s.heartbeatAgeMs>=-5&&s.heartbeatAgeMs<1500));
  const receipt=watchdogReceipt(c);assert.equal(receipt.reason,'STOP_REQUESTED');assert.equal(receipt.phase,'QUIT');assert.equal(receipt.exitCode,0);record(c);
 });
 for(const [mode,reason]of [['frozen-heartbeat','HEARTBEAT_STALE'],['regressed-heartbeat','HEARTBEAT_INVALID'],['wrong-lease','HEARTBEAT_INVALID']])await check('default research watchdog rejects '+mode+' despite a backward host clock',async()=>{
  const c=await open(mode);await c.rpc(mode);await c.start({waitForWorker:false});await remember(c,await until(()=>c.rpc('snapshot'),s=>Boolean(s.active),'default research action'));
  const result=await finishAction(c);assert.equal(result.status,'BLOCKED',JSON.stringify(result.actions[0]));assert.equal(result.actions[0].localExecution.phase,'FAILED');assert.equal(result.actions[0].localExecution.workerExited,true);assert.match(JSON.stringify(result.actions[0]),/EGO_LITE_HOST_DISCONNECTED/);assert.equal(evidenceCount(c),0);
  await remember(c,await c.rpc('snapshot'));const before=c.snapshot;assert.equal(before.events.length,0);assert.deepEqual(before.children.map(v=>v.role),['application','host']);
  await c.post(c.base+'/'+c.cycle.id+'/advance',{});assert.equal((await c.rpc('snapshot')).children.length,2);await stop(c);
  const clock=JSON.parse(fs.readFileSync(path.join(c.actionDirectory,'test-clock-probe.json'),'utf8'));assert.deepEqual(clock.steps.map(s=>s.offset),[-3600000]);assert.equal(clock.readyReleased,false);assert.equal(clock.originalReadyObserved,true);
  const receipt=watchdogReceipt(c);assert.equal(receipt.reason,reason);assert.equal(receipt.phase,'QUIT');assert.equal(receipt.exitCode,0);
  if(mode==='frozen-heartbeat'){assert.ok(receipt.gapMs>=5000&&receipt.gapMs<6500,JSON.stringify(receipt));assert.ok(c.receipt.watchdogProbe.writes>=10);assert.equal(c.receipt.watchdogProbe.lastPublished.sequence,0);}else assert.ok(receipt.gapMs<5000);
  record(c);
 });
 await check('normal capture remains usable and Douyin GET only shows an unconnected read-only snapshot',async()=>{
  const c=await open('normal-and-ops');
  for(const url of ['/douyin-ops','/projects/'+c.project.id+'/douyin']){const r=await c.request('GET',url);assert.equal(r.status,200);assert.ok(r.type.includes('text/html'));assert.ok(r.text.includes('Ego Lite 抖音只读运营'));assert.ok(r.text.includes('NOT_CONNECTED'));assert.ok(r.text.includes('尚未核验'));assert.ok(r.text.includes('返回项目工作台'));assert.ok(!r.text.includes('DOUYIN_OPS_FAILED'));assert.ok(!r.text.includes('id="launch-ops"'));}
  const status=await c.request('GET','/api/douyin/ops/status');assert.equal(status.status,200);assert.equal(status.value.status,'NOT_CONNECTED');assert.equal(status.value.identity,undefined);assert.equal(status.value.coverage,'NOT_READ');assert.deepEqual(status.value.works,[]);
  const launch=await c.request('POST','/api/douyin/ops/launch',{});assert.equal(launch.status,403);assert.equal(launch.value.code,'EGO_DOUYIN_READ_ONLY');
  const idle=await c.rpc('snapshot');assert.equal(idle.events.length,0);assert.equal(idle.children.length,1);assert.equal(idle.active,null);assert.equal(idle.ops.children.length,0);
  await c.start();const result=await finishAction(c);assert.equal(result.status,'WAITING_USER');assert.equal(result.actions[0].localExecution.phase,'SUCCEEDED');assert.equal(evidenceCount(c),1);await remember(c,await c.rpc('snapshot'));await stop(c);record(c);baseline=c;
 });
 await check('graceful shutdown while asynchronous pin reads are held starts no late host or worker',async()=>{
  const c=await open('pin-graceful-stop');await c.rpc('hold-pins');await c.start({waitForWorker:false});
  const held=await until(()=>c.rpc('snapshot'),s=>s.pinVerification?.held,'actual asynchronous pin read held');await remember(c,held);
  assert.equal(held.children.length,1);assert.equal(held.events.length,0);assert.ok(held.active);c.pinBefore=held.pinVerification;
  const stopping=c.rpc('stop');await c.rpc('release-pins');c.receipt=await stopping;await c.exit;
  assert.equal(c.code,0,c.errors);assert.ok(c.receipt.children.every(ch=>ch.role==='application'&&ch.closed&&ch.code===0&&!ch.forced));assert.equal(c.receipt.events.length,0);
  assert.equal(c.receipt.pinVerification.files,30);assert.equal(c.receipt.pinVerification.complete,30);
  const done=await finishAction(c);assert.equal(done.status,'CANCELLED');assert.equal(done.actions[0].localExecution.workerExited,true);assert.equal(evidenceCount(c),0);
  assert.equal(c.db.prepare('SELECT leaseOwner FROM AgentCycleRecord WHERE id=?').get(c.cycle.id).leaseOwner,null);
  await until(()=>[...c.knownPids].filter(alive),pids=>!pids.length,'pin stop owned PIDs gone');record(c);
 });
 await check('abrupt supervisor death during pin initialization creates no host and cannot revive old permission',async()=>{
  const c=await open('pin-abrupt-stop');await c.rpc('hold-pins');await c.start({waitForWorker:false});
  const held=await until(()=>c.rpc('snapshot'),s=>s.pinVerification?.held,'pin read held before supervisor death');await remember(c,held);
  assert.equal(held.children.length,1);assert.equal(held.events.length,0);c.pinBefore=held.pinVerification;
  c.p.kill();await c.exit;assert.notEqual(c.code,0);await c.advance;
  await until(()=>[...c.knownPids].filter(alive),pids=>!pids.length,'pin abrupt owned EOF shutdown',20000);
  assert.ok(!fs.existsSync(path.join(c.actionDirectory,'host.mjs')));assert.ok(!fs.existsSync(path.join(c.actionDirectory,'config.json')));
  const old=c.readCycle();assert.ok(['RUNNING','BLOCKED'].includes(old.status));assert.equal(old.actions[0].localExecution.workerExited,false);assert.equal(evidenceCount(c),0);record(c);
  const reopened=await open('pin-abrupt-reopen',c);reopened.cycle=c.cycle;assert.notEqual(reopened.ready.sourceUrl,c.ready.sourceUrl);
  const done=await reopened.post(reopened.base+'/'+c.cycle.id+'/advance',{});assert.equal(done.status,old.status==='RUNNING'?'OUTCOME_UNKNOWN':'BLOCKED');assert.equal(done.actions[0].localExecution.workerExited,false);
  assert.equal(reopened.db.prepare('SELECT leaseOwner FROM AgentCycleRecord WHERE id=?').get(c.cycle.id).leaseOwner,null);assert.equal((await reopened.rpc('snapshot')).children.length,1);assert.equal((await reopened.rpc('snapshot')).events.length,0);await stop(reopened);record(reopened);
 });
 await check('startup reconciliation preserves a different live executor lease and never advances ready work',async()=>{
  // Synthetic lease row only: no browser work or claimed outcome for this row.
  const fixture=structuredClone(baseline.readCycle());fixture.id=randomUUID();fixture.input.requestKey=randomUUID();fixture.inputHash=hashValue({projectId:fixture.projectId,input:fixture.input});fixture.status='RUNNING';
  const a=fixture.actions[0];a.status='RUNNING';a.localExecution={phase:'CONNECTING',version:1,samples:0,workerExited:false};delete a.result;delete a.completedAt;delete a.error;
  const frozen=JSON.stringify(fixture),owner='synthetic-live-owner';
  baseline.db.prepare('INSERT INTO AgentCycleRecord (id,projectId,requestKey,inputHash,revision,status,dataJson,createdAt,updatedAt,leaseOwner,leasePid) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(fixture.id,fixture.projectId,fixture.input.requestKey,fixture.inputHash,fixture.revision,fixture.status,frozen,fixture.createdAt,fixture.updatedAt,owner,process.pid);
  const c=await open('live-lease',baseline);c.cycle=fixture;
  const row=c.db.prepare('SELECT dataJson,leaseOwner,leasePid FROM AgentCycleRecord WHERE id=?').get(fixture.id);assert.equal(row.dataJson,frozen);assert.equal(row.leaseOwner,owner);assert.equal(row.leasePid,process.pid);assert.equal((await c.rpc('snapshot')).events.length,0);
  await stop(c);record(c);
  fixture.status='CANCELLED';fixture.actions[0].status='FAILED';fixture.actions[0].localExecution.phase='FAILED';
  baseline.db.prepare('UPDATE AgentCycleRecord SET status=?,dataJson=?,leaseOwner=NULL,leasePid=NULL WHERE id=?').run(fixture.status,JSON.stringify(fixture),fixture.id);
 });
 await check('abnormal host termination blocks the original action, preserves the cause and does not retry',async()=>{
  const c=await open('host-disconnect');await c.arm();await c.start();await c.armed;await fault(c,'FreezeWorker');await fault(c,'Terminate');
  const result=await finishAction(c);assert.equal(result.status,'BLOCKED',JSON.stringify(result.actions[0]));assert.equal(result.actions[0].localExecution.phase,'FAILED');assert.equal(result.actions[0].localExecution.workerExited,true);assert.ok(result.actions[0].result.data.run.blockerMessage.includes('EGO_LITE_HOST_DISCONNECTED'));assert.equal(evidenceCount(c),0);
  const before=await c.rpc('snapshot');await c.post(c.base+'/'+c.cycle.id+'/advance',{});const after=await c.rpc('snapshot');assert.equal(after.events.length,before.events.length);await remember(c,after);assert.ok(terminalEvents(after).every(e=>e.workerExited));await stop(c,true);record(c);
 });
 await check('running graceful supervisor shutdown waits for cancellation, durable final state and lease release',async()=>{
  const c=await open('graceful-stop');await c.arm();await c.start();await c.armed;await fault(c,'FreezeWorker');
  const stopping=c.rpc('stop');await until(()=>c.rpc('snapshot'),s=>s.events.some(e=>e.type==='cancelled'),'Go cancellation before host cleanup');await fault(c,'Resume');
  c.receipt=await stopping;await c.exit;assert.equal(c.code,0,c.errors);assert.ok(c.receipt.children.every(ch=>ch.closed&&ch.code===0&&!ch.forced));
  const result=await finishAction(c);assert.equal(result.status,'CANCELLED',JSON.stringify(result.actions[0]));assert.equal(result.actions[0].localExecution.workerExited,true);assert.equal(c.readCycle().status,'CANCELLED');assert.equal(c.db.prepare('SELECT leaseOwner FROM AgentCycleRecord WHERE id=?').get(c.cycle.id).leaseOwner,null);assert.equal(evidenceCount(c),0);
  for(const child of c.receipt.children)c.knownPids.add(child.pid);for(const event of c.receipt.events)if(event.workerPid)c.knownPids.add(event.workerPid);await until(()=>[...c.knownPids].filter(alive),v=>!v.length,'graceful owned exits');record(c);
 });
 await check('abrupt supervisor death closes owned pipes, saves an uncertain failure and cannot revive old permission',async()=>{
  const c=await open('abrupt-stop');await c.arm();await c.start();await c.armed;await fault(c,'FreezeWorker');assert.ok(c.knownPids.size>=4);
  c.p.kill();await c.exit;assert.notEqual(c.code,0);await resumeAfterDeath(c);await c.advance;
  await until(()=>[...c.knownPids].filter(alive),v=>!v.length,'orphan-free owned EOF shutdown',20000);
  const old=c.readCycle();assert.ok(['RUNNING','BLOCKED'].includes(old.status));assert.equal(old.actions[0].localExecution.workerExited,false);assert.equal(evidenceCount(c),0);record(c);
  const reopened=await open('abrupt-reopen',c);reopened.cycle=c.cycle;assert.notEqual(reopened.ready.sourceUrl,c.ready.sourceUrl);const result=await reopened.post(reopened.base+'/'+c.cycle.id+'/advance',{});
  assert.equal(result.status,old.status==='RUNNING'?'OUTCOME_UNKNOWN':'BLOCKED');assert.equal(result.actions[0].localExecution.workerExited,false);assert.equal(reopened.db.prepare('SELECT leaseOwner FROM AgentCycleRecord WHERE id=?').get(c.cycle.id).leaseOwner,null);assert.equal((await reopened.rpc('snapshot')).events.length,0);await stop(reopened);record(reopened);
 });
 async function timed(c,lateCancel=false){
  await c.arm();await c.start();await c.armed;await fault(c,'FreezeWorker');
  const state=await until(()=>c.rpc('snapshot'),s=>s.events.some(e=>e.type==='timed_out'),'actual ten-second Go deadline',15000);await remember(c,state);
  const end=state.events.find(e=>e.type==='timed_out'),start=state.events.find(e=>e.id===end.id&&e.type==='started');assert.ok(Date.parse(end.at)-Date.parse(start.at)>=9500);assert.ok(end.workerExited);assert.equal(terminalEvents(state).filter(e=>e.id===end.id).length,1);
  if(lateCancel){const current=c.readCycle();assert.equal(current.status,'RUNNING');await c.post(c.base+'/'+c.cycle.id+'/cancel',{expectedRevision:current.revision});}
  await fault(c,'Resume');const result=await finishAction(c);assert.equal(result.status,'BLOCKED',JSON.stringify(result.actions[0]));assert.equal(result.actions[0].localExecution.phase,'TIMED_OUT');assert.equal(result.actions[0].localExecution.workerExited,true);assert.equal(evidenceCount(c),0);await remember(c,await c.rpc('snapshot'));await stop(c);record(c);
 }
 await check('a stalled real host reaches the Go deadline once and closes before the action becomes terminal',async()=>{await timed(await open('timeout'));});
 await check('a late cancel during timeout cleanup cannot relabel an observed timeout as cancellation',async()=>{await timed(await open('timeout-then-cancel'),true);});
 await check('cancellation before the deadline wins once and cannot become a later timeout',async()=>{
  const c=await open('cancel-before-timeout');await c.arm();await c.start();await c.armed;await fault(c,'FreezeWorker');const started=(await c.rpc('snapshot')).events.findLast(e=>e.type==='started');
  await until(()=>Date.now()-Date.parse(started.at),ms=>ms>=8500,'near deadline cancellation',10000);const current=c.readCycle();await c.post(c.base+'/'+c.cycle.id+'/cancel',{expectedRevision:current.revision});
  const state=await until(()=>c.rpc('snapshot'),s=>s.events.some(e=>e.id===started.id&&e.type==='cancelled'),'cancel wins Go terminal');assert.equal(state.events.some(e=>e.id===started.id&&e.type==='timed_out'),false);await remember(c,state);await fault(c,'Resume');const result=await finishAction(c);assert.equal(result.status,'CANCELLED');assert.equal(result.actions[0].localExecution.phase,'CANCELLED');assert.equal(result.actions[0].localExecution.workerExited,true);assert.equal(evidenceCount(c),0);await stop(c);assert.equal(c.receipt.events.filter(e=>e.id===started.id&&['cancelled','timed_out','failed','succeeded'].includes(e.type)).length,1);record(c);
 });
 fs.writeFileSync(path.join(session,'evidence/assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,cases,source:'ACTUAL_GO_CLI_SDK_HOST_WITH_OWNED_WINDOWS_FAULTS',database:'NEW_SQLITE_ACTUAL_PRISMA',nativeClicks:'NOT_RUN',modelCalls:0,platformCalls:0,abruptExitEvidence:'OS_PID_GONE_NOT_FABRICATED_CHILD_EXIT_CODES',platformE2E:'NOT_RUN'},null,2));
});
