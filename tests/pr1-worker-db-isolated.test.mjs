// One bounded native-timer/multi-process suite; it never opens a real provider.
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

const session=process.env.PVS_PR1_WORKER_DB_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[];
const sql=new DatabaseSync(database);
try{
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);
  for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const f=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(f))sql.exec(fs.readFileSync(f,'utf8'));}
  const tables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  assert.ok(tables.every(({name})=>sql.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
  fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({newBlankDatabase:true,businessRows:0,tables:tables.length,copiedExistingDatabase:false}));
}finally{sql.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=25000,interval=100){const start=Date.now();while(Date.now()-start<timeout){const result=await fn();if(result)return result;await sleep(interval);}throw Error('BOUNDED_WAIT_EXPIRED');}
async function child(label){
  const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-worker-db-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const c={p,label,closed:false,code:null,stdout:'',stderr:'',pending:new Map(),expectedCode:0};children.push(c);
  p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
  p.once('error',e=>c.stderr+=e.message);p.once('close',code=>{c.closed=true;c.code=code;for(const h of c.pending.values())h.reject(Error('CHILD_CLOSED:'+code));c.pending.clear();});
  createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.ready)c.ready=true;const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
  c.call=(op,extra={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...extra,requestId})+'\n');});
  c.stop=()=>c.call('stop');
  c.close=async()=>{await c.stop();await until(async()=>!(await c.call('stats')).activeTicks);await c.call('close');p.stdin.end();await until(()=>c.closed);assert.equal(c.code,0,c.stderr);};
  await until(()=>c.ready||c.closed);assert.ok(c.ready,c.stderr);return c;
}
const ids=run=>({projectId:run.input?.projectId??run.projectId,id:run.id});
function events(){return fs.readdirSync(evidence).filter(f=>/^events-\d+\.jsonl$/.test(f)).flatMap(f=>fs.readFileSync(path.join(evidence,f),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));}
const reads=(key,kind)=>events().filter(e=>e.key===key&&e.kind===kind);

test('bounded native workers compete and recover with actual shared Prisma',{timeout:540000},async t=>{
  t.after(async()=>{for(const c of children){if(!c.closed){try{await c.stop();const held=(await c.call('stats')).held;for(const key of held)await c.call('release',{key});await c.close();}catch{c.p.kill();await until(()=>c.closed,4000).catch(()=>{});}}fs.writeFileSync(path.join(evidence,c.label+'.json'),JSON.stringify({pid:c.p.pid,label:c.label,closed:c.closed,code:c.code,expectedCode:c.expectedCode,stdout:c.stdout,stderr:c.stderr},null,2));}});
  const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});if(!passed)throw Error('STOP_AFTER_FAILED_CHECK:'+name);};
  const admin=await child('admin');let a=await child('worker-a');const b=await child('worker-b');
  const startedAt=Date.now(),long=await admin.call('seed-plan',{maxCaptures:2});
  await a.call('start',{kind:'operations'});await b.call('start',{kind:'operations'});
  const state=run=>admin.call('plan',ids(run));
  const heldBy=async key=>until(async()=>{for(const c of [a,b])if((await c.call('stats')).held.includes(key))return c;});
  const modeBoth=async(key,value)=>{await a.call('mode',{key,value});await b.call('mode',{key,value});};

  await check('two native interval workers claim one first observation without duplicate acquisition',async()=>{
    const s=await until(async()=>{const s=await state(long);return s.run.completedCaptures===1&&s;});
    assert.equal(s.metrics.length,1);assert.equal(reads(long.input.awemeId,'METRICS').length,1);assert.equal(reads(long.input.awemeId,'COMMENTS').length,1);assert.equal(s.run.status,'SCHEDULED');
    assert.equal(s.run.history[0].coverage,'PARTIAL');assert.equal(s.row.leaseOwner,null);
  });
  await check('slow acquisition stays single flight across native intervals and a live DB lease',async()=>{
    const run=await admin.call('seed-plan');await modeBoth(run.input.awemeId,{hold:'METRICS'});const holder=await heldBy(run.input.awemeId);
    const before=await state(run);assert.ok(before.row.leaseOwner);await sleep(5600);assert.equal(reads(run.input.awemeId,'METRICS').length,1);
    const during=await state(run);assert.equal(during.row.leaseOwner,before.row.leaseOwner);assert.equal(during.run.revision,before.run.revision);
    await holder.call('release',{key:run.input.awemeId});await until(async()=>(await state(run)).run.status==='COMPLETED');
    assert.equal((await holder.call('stats')).maxTicks,1);
  });
  await check('a newer human pause fences out an in-flight metric response',async()=>{
    const run=await admin.call('seed-plan');await modeBoth(run.input.awemeId,{hold:'METRICS'});const holder=await heldBy(run.input.awemeId);
    const paused=await admin.call('pause',ids(run));await holder.call('release',{key:run.input.awemeId});await until(async()=>!(await holder.call('stats')).activeTicks);
    const s=await state(run);assert.equal(s.run.status,'PAUSED');assert.equal(s.run.revision,paused.revision);assert.equal(s.metrics.length,0);assert.equal(s.collections.length,0);assert.equal(reads(run.input.awemeId,'COMMENTS').length,0);assert.equal(s.run.checkpoint.pendingRead.kind,'METRICS');
    await assert.rejects(admin.call('resume',{...ids(run),confirmed:false}));
  });
  await check('natural 180 second lease expiry preserves unknown intent and rejects the older response',async()=>{
    const run=await admin.call('seed-plan');await modeBoth(run.input.awemeId,{hold:'METRICS'});const holder=await heldBy(run.input.awemeId);
    const heldAt=Date.now(),leased=await state(run),expiresAt=Date.parse(leased.row.leaseExpiresAt);
    assert.ok(expiresAt-heldAt>170000); // The original TTL is unmodified.
    await until(async()=>(await state(run)).run.status==='BLOCKED',expiresAt-Date.now()+20000,1000);
    assert.ok(Date.now()>=expiresAt);
    const blocked=await state(run);assert.equal(blocked.run.errorCode,'READ_OUTCOME_UNKNOWN');assert.equal(blocked.run.checkpoint.pendingRead.kind,'METRICS');
    fs.writeFileSync(path.join(evidence,'natural-lease-expiry.json'),JSON.stringify({heldAt,expiresAt,blockedAt:Date.now(),waitMs:Date.now()-heldAt,expiredLeaseInjected:false}));
    await holder.call('release',{key:run.input.awemeId});await until(async()=>!(await holder.call('stats')).activeTicks);
    const after=await state(run);assert.equal(after.run.revision,blocked.run.revision);assert.equal(after.metrics.length,0);assert.equal(after.collections.length,0);assert.equal(reads(run.input.awemeId,'METRICS').length,1);
  });
  await check('actual owner process exit after read intent blocks automatic replay',async()=>{
    await a.stop();await b.stop();await until(async()=>!(await a.call('stats')).activeTicks&&!(await b.call('stats')).activeTicks);
    const run=await admin.call('seed-plan',{delayStartMs:0}),crash=await child('operations-crash');crash.expectedCode=73;
    await crash.call('mode',{key:run.input.awemeId,value:{crash:'METRICS'}});await assert.rejects(crash.call('tick',ids(run)));await until(()=>crash.closed);assert.equal(crash.code,73);
    const before=await state(run);assert.equal(before.run.status,'RUNNING');assert.equal(before.run.checkpoint.pendingRead.kind,'METRICS');
    await a.call('start',{kind:'operations'});await b.call('start',{kind:'operations'});
    await admin.call('expire',{id:run.id});await until(async()=>(await state(run)).run.status==='BLOCKED');
    const after=await state(run);assert.equal(after.run.errorCode,'READ_OUTCOME_UNKNOWN');assert.equal(after.metrics.length,0);assert.equal(reads(run.input.awemeId,'METRICS').length,1);assert.equal(reads(run.input.awemeId,'COMMENTS').length,0);
  });
  await check('native workers retain authentication pause without automatic retry',async()=>{
    const run=await admin.call('seed-plan');await modeBoth(run.input.awemeId,{failure:'METRICS',code:'AUTH_REQUIRED'});
    await until(async()=>(await state(run)).run.status==='PAUSED');const before=await state(run);await sleep(5300);
    const after=await state(run);assert.equal(after.run.revision,before.run.revision);assert.equal(after.run.errorCode,'AUTH_REQUIRED');assert.equal(reads(run.input.awemeId,'METRICS').length,1);
  });
  await check('native Agent workers execute one saved read and preserve a concrete human gate',async()=>{
    const read=await admin.call('seed-agent'),human=await admin.call('seed-agent',{human:true});await a.call('start',{kind:'agent'});await b.call('start',{kind:'agent'});
    await until(async()=>(await admin.call('agent',ids(read))).status==='WAITING_USER');await until(async()=>(await admin.call('agent',ids(human))).status==='WAITING_CONFIRMATION');
    assert.equal(reads(read.id,'AGENT_READ').length,1);assert.equal(reads(human.id,'AGENT_READ').length,0);
    assert.equal((await admin.call('agent',ids(human))).actions[0].confirmedAt,undefined);
  });
  await check('ALL workers recover a process that dies after both workers completed startup',async()=>{
    const run=await admin.call('seed-smart'),owner=await child('smart-dead-owner');owner.expectedCode=73;
    assert.equal(await owner.call('smart-own',{...ids(run),owner:'late-death-owner'}),true);
    await a.call('start',{kind:'smart',policy:{mode:'ALL'}});await b.call('start',{kind:'smart',policy:{mode:'ALL'}});
    await until(async()=>(await a.call('stats')).smartLists>=2&&(await b.call('stats')).smartLists>=2);
    assert.equal((await admin.call('smart',ids(run))).lease.pid,owner.p.pid);assert.equal(reads(run.id,'SOURCES').length,0);
    await assert.rejects(owner.call('exit-owner'));await until(()=>owner.closed);assert.equal(owner.code,73);
    const after=await until(async()=>{const s=await admin.call('smart',ids(run));return s.run.status==='WAITING_FOR_TRUTH_REVIEW'&&s;});
    assert.equal(after.lease,null);assert.equal(reads(run.id,'SOURCES').length,1);assert.equal(after.run.consent,undefined);assert.equal(after.run.blocker.code,'FIXTURE_HUMAN_GATE');
  });
  await check('ALL workers do not steal another live process owner even after repeated ticks',async()=>{
    const run=await admin.call('seed-smart'),owner=await child('smart-live-owner');assert.equal(await owner.call('smart-own',{...ids(run),owner:'live-owner'}),true);
    await sleep(2300);assert.equal((await admin.call('smart',ids(run))).lease.pid,owner.p.pid);assert.equal(reads(run.id,'SOURCES').length,0);
    await owner.call('smart-release',{...ids(run),owner:'live-owner'});await owner.close();await until(async()=>(await admin.call('smart',ids(run))).run.status==='WAITING_FOR_TRUTH_REVIEW');assert.equal(reads(run.id,'SOURCES').length,1);
    await a.stop();await b.stop();await until(async()=>!(await a.call('stats')).activeTicks&&!(await b.call('stats')).activeTicks);
  });
  await check('MANAGED exact legacy scope leaves an unrelated real DB task and lease untouched',async()=>{
    const selected=await admin.call('seed-smart'),old=await admin.call('seed-smart'),before=await admin.call('smart',ids(old));
    await a.call('start',{kind:'smart',policy:{mode:'MANAGED',legacyScope:{projectId:selected.projectId,runId:selected.id}}});
    await until(async()=>(await admin.call('smart',ids(selected))).run.status==='WAITING_FOR_TRUTH_REVIEW');await sleep(1300);
    assert.deepEqual(await admin.call('smart',ids(old)),before);assert.equal(reads(old.id,'SOURCES').length,0);await a.stop();
  });
  await check('SCOPED native worker advances only the exact current DB task',async()=>{
    const run=await admin.call('seed-smart');await a.call('start',{kind:'smart',policy:{mode:'SCOPED',scope:{projectId:run.projectId,runId:run.id}}});
    await until(async()=>(await admin.call('smart',ids(run))).run.status==='WAITING_FOR_TRUTH_REVIEW');assert.equal(reads(run.id,'SOURCES').length,1);await a.stop();
  });
  await check('stopping native workers prevents later DB scans and advancement',async()=>{
    await a.stop();await b.stop();const beforeA=await a.call('stats'),beforeB=await b.call('stats');await sleep(5300);
    const afterA=await a.call('stats'),afterB=await b.call('stats');for(const k of ['due','ticks','smartLists','agentLists','recover']){assert.equal(afterA[k],beforeA[k]);assert.equal(afterB[k],beforeB[k]);}
  });
  await check('actual worker process restart reuses original observation and schedules',async()=>{
    const before=await state(long);await a.close();a=await child('worker-a-restarted');await a.call('start',{kind:'operations'});await b.call('start',{kind:'operations'});
    const after=await state(long);assert.deepEqual(after.run.input,before.run.input);assert.deepEqual(after.run.history.slice(0,before.run.history.length),before.run.history);
  });
  await check('two bounded captures use the real 60 second cadence and then remain terminal',async()=>{
    const s=await until(async()=>{const s=await state(long);return s.run.status==='COMPLETED'&&s;},85000);
    assert.equal(s.run.completedCaptures,2);assert.equal(s.run.history.length,2);assert.equal(s.metrics.length,2);assert.equal(s.run.terminalReason,'MAX_CAPTURES');
    const observed=reads(long.input.awemeId,'METRICS').sort((x,y)=>x.at-y.at);assert.equal(observed.length,2);assert.ok(observed[1].at-observed[0].at>=60000);
    await sleep(5300);assert.equal((await state(long)).run.revision,s.run.revision);assert.equal(reads(long.input.awemeId,'METRICS').length,2);
    fs.writeFileSync(path.join(evidence,'bounded-duration.json'),JSON.stringify({startedAt,endedAt:Date.now(),wallMs:Date.now()-startedAt,observationGapMs:observed[1].at-observed[0].at,realTimers:true,naturalLeaseExpiry:JSON.parse(fs.readFileSync(path.join(evidence,'natural-lease-expiry.json'),'utf8')),crashLeaseExpiryInjected:true,productionSoak:false}));
  });
  await check('all processes drain with zero provider records and all boundaries retained',async()=>{
    await a.stop();await b.stop();await until(async()=>!(await a.call('stats')).activeTicks&&!(await b.call('stats')).activeTicks);
    const audit=await admin.call('audit');assert.equal(audit.providers,0);assert.equal(audit.executions,0);assert.equal(audit.attempts,0);
    for(const c of children.filter(c=>!c.closed)){const s=await c.call('stats');assert.equal(s.forbidden,0);assert.ok(s.maxTicks<=1);await c.close();}
    assert.ok(children.every(c=>c.closed&&c.code===c.expectedCode));
  });
  fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({pass:results.length+1,fail:0,results,children:children.map(c=>({label:c.label,pid:c.p.pid,closed:c.closed,code:c.code,expectedCode:c.expectedCode})),duration:JSON.parse(fs.readFileSync(path.join(evidence,'bounded-duration.json'),'utf8')),database:'ACTUAL_NEW_SHARED_SQLITE_PRISMA',timers:'NATIVE_INTERVALS',observations:'FIXED_IN_PROCESS_ONLY',modelCalls:0,realPlatformCalls:0,httpBrowserCalls:0,selectedModel:'aihubmix/deepseek-v4.1-flash',audio:'NOT_OBSERVED',actualCost:'UNKNOWN'},null,2));
});
