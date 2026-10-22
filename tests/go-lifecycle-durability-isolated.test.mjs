import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {root,isolatedEnvironment,confined} from '../scripts/isolation-policy.mjs';

const session=process.env.PVS_LIFECYCLE_DURABLE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[];
// New database from repository migrations; no existing DB is read or copied.
const sqlite=new DatabaseSync(database);try{
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){
  const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sqlite.exec(fs.readFileSync(file,'utf8'));
 }
 const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
 assert.ok(tables.every(({name})=>sqlite.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
 fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({createdFromMigrations:true,tables:tables.length,businessRows:0,copiedExistingDatabase:false}));
}finally{sqlite.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=10000){const begin=Date.now();while(Date.now()-begin<ms){const value=await fn();if(value)return value;await pause(30);}throw Error('TIMEOUT '+label);}
async function child(){
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-lifecycle-durable-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const event=JSON.parse(line);c.events.push(event);if(event.requestId){const handler=c.pending.get(event.requestId);if(handler){c.pending.delete(event.requestId);event.error?handler.reject(Error(event.error)):handler.resolve(event.result);}}});
 p.once('error',error=>{c.closed=true;c.stderr+=error.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const handler of c.pending.values())handler.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});};
 c.stop=async()=>{if(!c.closed){await c.call('close');await until(()=>c.closed,'child clean exit');}assert.equal(c.code,0,c.stderr);};
 await until(()=>c.events.some(e=>e.ready)||c.closed,'guarded Prisma ready');assert.equal(c.closed,false,c.stderr);return c;
}
const action=c=>c.actions[0];
async function begin(c,label,effect='HUMAN_DECISION'){
 const cycle=await c.call('prepare',{label,effect});const running=c.call('advance',{id:cycle.id});running.catch(()=>{});
 await until(()=>c.events.some(e=>e.executionStarted?.cycleId===cycle.id),'execution started');return {cycle,running,actionId:action(cycle).id};
}
const progress=(c,job,phase,samples=0,workerExited=false)=>c.call('event',{actionId:job.actionId,update:{phase,samples,workerExited}});
const stored=(c,id)=>c.call('get',{id,stored:true});
test('actual blank Prisma lifecycle persistence, owned process restart and injected faults',{timeout:120000},async t=>{
 t.after(async()=>{
  for(const c of children){if(!c.closed){c.p.stdin.end();await until(()=>c.closed,'cleanup',1000).catch(()=>c.p.kill());await until(()=>c.closed,'killed child',3000).catch(()=>{});}}
  for(const [i,c] of children.entries())fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));
 });
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 let c=await child();await c.call('initialize');let successId;
 await check('live progress is durable under the existing lease; a peer cannot cancel or advance',async()=>{
  const j=await begin(c,'durable-success');successId=j.cycle.id;
  assert.equal(action(await stored(c,successId)).localExecution.phase,'CONNECTING');
  await progress(c,j,'CONNECTED');await progress(c,j,'OBSERVING',1);
  const live=await until(async()=>{const row=await stored(c,successId);return action(row).localExecution.samples===1?row:false;},'persisted sample');
  assert.ok((await c.call('lease',{id:successId}))[0].leaseOwner);
  await assert.rejects(c.call('peer-cancel',{id:successId,revision:live.revision}),/处理/);
  await assert.rejects(c.call('advance',{id:successId}),/处理/);
  await assert.rejects(c.call('cancel',{projectId:'foreign',id:successId,revision:live.revision}),/处理/);
  await assert.rejects(c.call('cancel',{id:successId,revision:live.revision-1}),/版本/);
  await progress(c,j,'SUCCEEDED',1,true);await c.call('settle',{actionId:j.actionId});const done=await j.running;
  assert.equal(action(done).status,'SUCCEEDED');assert.equal((await c.call('lease',{id:successId}))[0].leaseOwner,null);
 });
 await check('a new process reads terminal progress and request-key idempotency without another execution',async()=>{
  await c.stop();c=await child();const row=await stored(c,successId);assert.equal(action(row).localExecution.samples,1);assert.equal(action(row).localExecution.workerExited,true);
  await c.call('invoke',{id:row.id,capabilityId:action(row).capabilityId,arguments:action(row).input,requestKey:action(row).requestKey});assert.equal((await c.call('stats')).executions,0);
 });
 await check('duplicate cancellation retains RUNNING until an exit acknowledgement and ignores late events',async()=>{
  const j=await begin(c,'duplicate-cancel');await progress(c,j,'OBSERVING',1);
  const before=await until(async()=>{const row=await stored(c,j.cycle.id);return action(row).localExecution.samples===1?row:false;},'cancel sample');
  const responses=await Promise.allSettled([c.call('cancel',{id:before.id,revision:before.revision}),c.call('cancel',{id:before.id,revision:before.revision})]);assert.ok(responses.some(r=>r.status==='fulfilled'));
  const waiting=await until(async()=>{const row=await stored(c,j.cycle.id);return action(row).localExecution.phase==='CANCELLING'?row:false;},'durable cancelling');assert.equal(waiting.status,'RUNNING');assert.equal(action(waiting).localExecution.workerExited,false);
  await progress(c,j,'OBSERVING',2);assert.equal(action(await c.call('get',{id:before.id})).localExecution.phase,'CANCELLING');
  await progress(c,j,'CANCELLED',1,true);await c.call('settle',{actionId:j.actionId,status:'BLOCKED'});const done=await j.running;assert.equal(done.status,'CANCELLED');
  await progress(c,j,'SUCCEEDED',2,true);assert.deepEqual(await stored(c,done.id),done);assert.equal((await c.call('stats')).aborts,1);
 });
 await check('timeout, disconnect and missing worker-exit acknowledgement block without a model or retry',async()=>{
  for(const mode of ['timeout','disconnect','missing-exit']){
   const j=await begin(c,mode);await progress(c,j,'OBSERVING',1);
   if(mode==='disconnect')await c.call('disconnect',{actionId:j.actionId});else{await progress(c,j,mode==='timeout'?'TIMED_OUT':'CANCELLED',1,mode==='timeout');await c.call('settle',{actionId:j.actionId,status:'BLOCKED'});}
   const done=await j.running;assert.equal(done.status,'BLOCKED');assert.equal(action(done).status,'FAILED');if(mode==='missing-exit')assert.equal(action(done).localExecution.workerExited,false);
   const before=await c.call('stats');await c.call('advance',{id:done.id});assert.deepEqual(await c.call('stats'),before);
  }
 });
 await check('completion racing cancellation preserves success and stops subsequent scheduling',async()=>{
  const j=await begin(c,'cancel-race');const before=await stored(c,j.cycle.id);await c.call('cancel',{id:before.id,revision:before.revision});await progress(c,j,'SUCCEEDED',0,true);await c.call('settle',{actionId:j.actionId});const done=await j.running;
  assert.equal(done.status,'CANCELLED');assert.equal(action(done).status,'SUCCEEDED');assert.ok(done.messages.some(m=>m.text.includes('先于取消完成')));
  const k=await begin(c,'complete-before-cancel');await progress(c,k,'SUCCEEDED',0,true);
  const current=await until(async()=>{const row=await stored(c,k.cycle.id);return action(row).localExecution.phase==='SUCCEEDED'?row:false;},'terminal checkpoint');
  await assert.rejects(c.call('cancel',{id:current.id,revision:current.revision}),/已结束/);await c.call('settle',{actionId:k.actionId});assert.equal((await k.running).status,'READY');
 });
 await check('dead owner is observed across processes; READ recovery blocks and cannot resurrect a handle',async()=>{
  const j=await begin(c,'read-crash','READ');await progress(c,j,'OBSERVING',1);await until(async()=>action(await stored(c,j.cycle.id)).localExecution.samples===1,'saved crash progress');
  const oldPid=c.p.pid;c.call('crash').catch(()=>{});await until(()=>c.closed,'actual crashed child');assert.equal(c.code,73);
  c=await child();assert.equal((await c.call('lease',{id:j.cycle.id}))[0].leasePid,oldPid);assert.equal(await c.call('recover',{id:j.cycle.id}),true);
  const recovered=await c.call('advance',{id:j.cycle.id});assert.equal(recovered.status,'BLOCKED');assert.equal(action(recovered).localExecution.workerExited,false);assert.equal(action(recovered).localExecution.phase,'FAILED');
  await c.call('advance',{id:j.cycle.id});await assert.rejects(c.call('event',{actionId:j.actionId,update:{phase:'SUCCEEDED',samples:1,workerExited:true}}));assert.equal((await c.call('stats')).executions,0);assert.equal((await c.call('stats')).modelCalls,0);
 });
 await check('confirmed HUMAN_DECISION interrupted by a dead owner becomes unknown without permission revival',async()=>{
  const j=await begin(c,'confirmed-crash');c.call('crash').catch(()=>{});await until(()=>c.closed,'confirmed crashed child');assert.equal(c.code,73);
  c=await child();const recovered=await c.call('advance',{id:j.cycle.id});assert.equal(recovered.status,'OUTCOME_UNKNOWN');assert.equal(action(recovered).status,'OUTCOME_UNKNOWN');
  await c.call('advance',{id:j.cycle.id});await assert.rejects(c.call('confirm',{id:j.cycle.id,input:{expectedRevision:recovered.revision,actionId:j.actionId,inputHash:action(recovered).inputHash}}),/失效/);
  await c.call('invoke',{id:j.cycle.id,capabilityId:action(recovered).capabilityId,arguments:action(recovered).input,requestKey:action(recovered).requestKey});assert.equal((await c.call('stats')).executions,0);
 });
 await check('malformed or decreasing progress cannot claim an exit or mutate a completed action',async()=>{
  for(const update of [{phase:'OBSERVING',samples:0,workerExited:false},{phase:'CONNECTED',samples:1,workerExited:true},{phase:'UNKNOWN',samples:1,workerExited:false},{phase:'CONNECTED',samples:1,workerExited:false},{phase:'CANCELLING',samples:1,workerExited:false}]){
   const j=await begin(c,'invalid-'+randomUUID());await progress(c,j,'OBSERVING',1);await assert.rejects(c.call('event',{actionId:j.actionId,update}));const done=await j.running;assert.equal(done.status,'BLOCKED');assert.equal(action(done).localExecution.phase,'FAILED');
  }
 });
 await check('cancelling after owner death stops scheduling without claiming the old worker exited',async()=>{
  const j=await begin(c,'cancel-dead-owner','READ');c.call('crash').catch(()=>{});await until(()=>c.closed,'dead owner for cancellation');assert.equal(c.code,73);
  c=await child();const prior=await stored(c,j.cycle.id),cancelled=await c.call('cancel',{id:prior.id,revision:prior.revision});
  assert.equal(cancelled.status,'CANCELLED');assert.equal(action(cancelled).status,'FAILED');assert.equal(action(cancelled).localExecution.phase,'FAILED');assert.equal(action(cancelled).localExecution.workerExited,false);
  await c.call('advance',{id:prior.id});assert.equal((await c.call('stats')).executions,0);
 });
 assert.ok(results.every(r=>r.passed),'no pre-exit pass on failed children');assert.equal((await c.call('stats')).modelCalls,0);await c.stop();
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,executionPort:'INERT_FAULT_FIXTURE',database:'ACTUAL_NEW_SQLITE_PRISMA',actualModelCalls:0,realGo:'NOT_RUN_THIS_SUITE',productionWiring:false,platformE2E:'NOT_RUN',expectedCrashExit:73,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code}))},null,2));
});
