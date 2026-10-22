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
const session=process.env.PVS_U4_DURABLE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[];
const sqlite=new DatabaseSync(database);try{
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sqlite.exec(fs.readFileSync(file,'utf8'));}
 const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
 assert.ok(tables.every(({name})=>sqlite.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
 fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({createdFromMigrations:true,businessRows:0,copiedExistingDatabase:false,tables:tables.length}));
}finally{sqlite.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
let now=Date.now();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=15000){const begin=Date.now();while(Date.now()-begin<timeout){if(fn())return;await pause(20);}throw Error('TIMEOUT');}
async function child(){
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/u4-schedule-durability-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);c.events.push(e);const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 p.once('error',e=>{c.closed=true;c.stderr+=e.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const h of c.pending.values())h.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});
 c.stop=async()=>{if(!c.closed){await c.call('close');await until(()=>c.closed);}assert.equal(c.code,0,c.stderr);};
 await until(()=>c.events.some(e=>e.ready)||c.closed);assert.equal(c.closed,false,c.stderr);await c.call('clock',{now});return c;
}
const scope=f=>({projectId:f.projectId,id:f.run.id});
const reads=f=>fs.existsSync(path.join(evidence,'reads.jsonl'))?fs.readFileSync(path.join(evidence,'reads.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.awemeId===f.awemeId):[];
async function time(c,value){now=typeof value==='string'?Date.parse(value):value;await c.call('clock',{now});}
async function tick(c,f){return c.call('tick',scope(f));}
async function state(c,f){return c.call('get',scope(f));}
async function atNext(c,f){const run=(await state(c,f)).run;await time(c,run.nextAt);return tick(c,f);}
async function crash(c,f,point){await c.call('mode',{value:{crash:point}});c.call('tick',scope(f)).catch(()=>{});await until(()=>c.closed);assert.equal(c.code,73,c.stderr);}
test('U4 durable bounded schedules, lease fencing and U5 frozen downstream evidence',{timeout:180000},async t=>{
 t.after(async()=>{for(const [i,c] of children.entries()){if(!c.closed){c.p.stdin.end();await until(()=>c.closed,2000).catch(()=>c.p.kill());await until(()=>c.closed,3000).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));}});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 let c=await child(),normal;
 await check('same request survives actual competing Prisma processes and cannot alter bounded input',async()=>{
  const f=await c.call('seed'),peer=await child();
  const duplicate=await Promise.all([c.call('create-again',{input:f.run.input}),peer.call('create-again',{input:f.run.input})]);assert.ok(duplicate.every(r=>r.id===f.run.id));
  await assert.rejects(peer.call('create-again',{input:{...f.run.input,maxCaptures:30}}));assert.equal(reads(f).length,0);await peer.stop();
 });
 await check('actual restart retains top/reply cursor IDs, at most one page per scope per tick and max captures',async()=>{
  normal=await c.call('seed');let run=await tick(c,normal);assert.equal(run.completedCaptures,1);assert.equal(run.history[0].coverage,'PARTIAL');const top=run.checkpoint.commentsRunId;
  const before=reads(normal).length;await tick(c,normal);assert.equal(reads(normal).length,before);
  await c.stop();c=await child();run=await atNext(c,normal);assert.equal(run.completedCaptures,2);assert.equal(run.checkpoint.commentsRunId,top);const reply=Object.values(run.checkpoint.replyRuns)[0];
  run=await atNext(c,normal);assert.equal(run.status,'COMPLETED');assert.equal(run.terminalReason,'MAX_CAPTURES');assert.equal(run.completedCaptures,3);assert.equal(run.history[2].commentsRunId,top);assert.deepEqual(run.history[2].replyRunIds,[reply]);
  const data=await state(c,normal);assert.ok(data.metrics.every(m=>m.plays===undefined&&m.likes===0));assert.ok(data.comments.every(v=>v.diggCount===undefined&&v.observation.counts.diggCount.status==='UNKNOWN'));assert.ok(run.history.every(h=>h.coverage==='PARTIAL'));
  assert.deepEqual(reads(normal).filter(r=>r.kind==='COMMENTS').map(r=>r.cursor),['0','1']);assert.deepEqual(reads(normal).filter(r=>r.kind==='REPLIES').map(r=>r.cursor),['0','1']);assert.equal(reads(normal).filter(r=>r.kind==='METRICS').length,3);
  await tick(c,normal);assert.equal(reads(normal).length,7);assert.ok(!(await c.call('due')).some(r=>r.id===run.id));fs.writeFileSync(path.join(evidence,'bounded-restart.json'),JSON.stringify(data,null,2));
 });
 await check('expired lease without a read intent can transfer; old writes and release cannot affect the successor',async()=>{
  const f=await c.call('seed'),owner='synthetic-old-owner',old=await c.call('claim',{...scope(f),owner,duration:1000});await time(c,now+1001);
  await tick(c,f);await assert.rejects(c.call('old-save',{run:old,owner}));const before=await state(c,f);await c.call('old-release',{...scope(f),owner});assert.deepEqual((await state(c,f)).run,before.run);
 });
 await check('second process cannot read under a live lease; expired in-flight outcome blocks and stale response cannot save',async()=>{
  const f=await c.call('seed'),peer=await child();await c.call('mode',{value:{hold:'METRICS'}});const pending=tick(c,f);pending.catch(()=>{});await until(()=>c.events.some(e=>e.held==='METRICS'));
  assert.equal((await tick(peer,f)).status,'RUNNING');assert.equal(reads(f).length,1);
  await time(peer,now+180001);const blocked=await tick(peer,f);assert.equal(blocked.errorCode,'READ_OUTCOME_UNKNOWN');await time(c,now);await c.call('release');await pending;
  const data=await state(peer,f);assert.equal(data.metrics.length,0);assert.equal(data.comments.length,0);assert.equal(data.run.completedCaptures,0);assert.equal(reads(f).length,1);
  await c.call('mode');await peer.stop();
 });
 for(const kind of ['METRICS','COMMENTS'])await check('pause while '+kind+' is in flight prevents response persistence',async()=>{
  const f=await c.call('seed');c.events=[];await c.call('mode',{value:{hold:kind}});const pending=tick(c,f);pending.catch(()=>{});await until(()=>c.events.some(e=>e.held===kind));await c.call('pause',scope(f));await c.call('release');assert.equal((await pending).status,'PAUSED');
  const data=await state(c,f);assert.equal(data.comments.length,0);assert.equal(data.metrics.length,kind==='METRICS'?0:1);const count=reads(f).length;await tick(c,f);assert.equal(reads(f).length,count);await c.call('mode');
 });
 for(const operation of ['createMetricSnapshot','upsertComments'])await check('transaction fence rejects pause after callback but before '+operation+' transaction',async()=>{
  const f=await c.call('seed');await c.call('mode',{value:{pauseAtWrite:operation}});assert.equal((await tick(c,f)).status,'PAUSED');const data=await state(c,f);assert.equal(data.comments.length,0);assert.equal(data.metrics.length,operation==='createMetricSnapshot'?0:1);await c.call('mode');
 });
 for(const point of ['EMPTY_CHECKPOINT','METRICS','METRICS_SAVED','TOP_SAVED','REPLIES_SAVED'])await check('actual process death at '+point+' preserves original outcome and never resets the cursor',async()=>{
  const f=await c.call('seed');if(point==='REPLIES_SAVED'){await tick(c,f);await time(c,(await state(c,f)).run.nextAt);}
  await crash(c,f,point);c=await child();await time(c,now+180001);const run=await tick(c,f),data=await state(c,f);
  const log=reads(f);assert.equal(log.filter(r=>r.kind==='METRICS').length,point==='REPLIES_SAVED'?2:1);
  if(point==='METRICS'){assert.equal(run.status,'BLOCKED');assert.equal(run.errorCode,'READ_OUTCOME_UNKNOWN');assert.equal(data.metrics.length,0);await tick(c,f);assert.equal(reads(f).length,1);}
  else {assert.equal(run.status,'SCHEDULED');assert.ok(data.metrics.length>0);assert.equal(log.filter(r=>r.kind==='COMMENTS'&&r.cursor==='0').length,1);}
  if(point==='TOP_SAVED')assert.deepEqual(log.filter(r=>r.kind==='COMMENTS').map(r=>r.cursor),['0','1']);
  if(point==='REPLIES_SAVED')assert.deepEqual(log.filter(r=>r.kind==='REPLIES').map(r=>r.cursor),['0','1']);
 });
 for(const kind of ['METRICS','COMMENTS'])await check('AUTH_REQUIRED '+kind+' pauses, requires fresh exact confirmation and resumes the same task',async()=>{
  const f=await c.call('seed');await c.call('mode',{value:{failure:kind,code:'AUTH_REQUIRED'}});const run=await tick(c,f);assert.equal(run.status,'PAUSED');const count=reads(f).length;
  await assert.rejects(c.call('resume',scope(f)));await assert.rejects(c.call('resume',{...scope(f),confirmed:true,expectedRevision:run.revision-1}));await assert.rejects(c.call('resume',{...scope(f),confirmed:true,inputHash:'0'.repeat(64)}));await assert.rejects(c.call('resume',{...scope(f),confirmed:true,expectedAccountId:'wrong-account'}));assert.equal(reads(f).length,count);
  await c.call('mode');const resumed=await c.call('resume',{...scope(f),confirmed:true});assert.equal(resumed.data.status,'SCHEDULED');assert.deepEqual(resumed.data.input,f.run.input);assert.equal(reads(f).length,count);
  const result=await atNext(c,f);assert.equal(result.completedCaptures,1);assert.equal(result.status,'SCHEDULED');
  if(kind==='COMMENTS')assert.equal(result.checkpoint.commentsRunId,run.checkpoint.commentsRunId);
 });
 await check('known provider failures back off at original key and stop after three without consuming captures',async()=>{
  const f=await c.call('seed');await c.call('mode',{value:{failure:'METRICS',code:'PROVIDER_ERROR'}});let run;
  for(let i=1;i<=3;i++){run=await tick(c,f);assert.equal(run.consecutiveFailures,i);assert.equal(run.completedCaptures,0);assert.equal(run.checkpoint.pendingRead,undefined);if(i<3)await time(c,run.nextAt);}
  assert.equal(run.status,'BLOCKED');await assert.rejects(c.call('resume',{...scope(f),confirmed:true}));await tick(c,f);assert.equal(reads(f).length,3);await c.call('mode');
 });
 for(const change of ['account','binding'])await check(change+' changes block before data reads without rebind',async()=>{
  const f=await c.call('seed');if(change==='account')await c.call('change-account',{uid:'different'});else await c.call('change-binding',{bindingId:f.bindingId});const result=await tick(c,f);assert.equal(result.status,'BLOCKED');assert.equal(reads(f).length,0);await c.call('change-account',{uid:'synthetic-operations-uid'});
 });
 await check('deadline reached during a held read stops without saving or extending the original window',async()=>{
  const f=await c.call('seed',{overrides:{cadence:{version:'stage-data-v1',minIntervalSeconds:60,maxIntervalSeconds:600,maxDurationSeconds:60,minAbsoluteGrowth:10,growthThresholdPercent:20}}});c.events=[];await c.call('mode',{value:{hold:'METRICS'}});const pending=tick(c,f);pending.catch(()=>{});await until(()=>c.events.some(e=>e.held==='METRICS'));await time(c,now+60001);await c.call('release');const run=await pending;assert.equal(run.status,'COMPLETED');assert.equal(run.terminalReason,'MAX_DURATION');assert.equal(run.completedCaptures,0);assert.equal((await state(c,f)).metrics.length,0);assert.deepEqual(run.input,f.run.input);await assert.rejects(c.call('resume',{...scope(f),confirmed:true}));await c.call('mode');
 });
 for(const kind of ['hash','row'])await check('corrupt '+kind+' metadata refuses execution before data reads',async()=>{
  const f=await c.call('seed');await c.call('corrupt',{...scope(f),kind});await assert.rejects(tick(c,f));assert.equal(reads(f).length,0);
 });
 for(const kind of ['legacy-running','legacy-scheduled'])await check(kind+' without an intent protocol is handled without guessing an in-flight result',async()=>{
  const f=await c.call('seed');await c.call('corrupt',{...scope(f),kind});const run=await tick(c,f);
  if(kind==='legacy-running'){assert.equal(run.status,'BLOCKED');assert.equal(reads(f).length,0);assert.equal(run.executionProtocol,undefined);}
  else {assert.equal(run.status,'SCHEDULED');assert.equal(run.executionProtocol,'operations-read-intent-v1');assert.equal(reads(f).length,2);}
 });
 for(const kind of ['missing-collection','foreign-collection'])await check(kind+' never restarts the first page or substitutes a task',async()=>{
  const f=await c.call('seed');await tick(c,f);const other=await c.call('seed');await tick(c,other);await c.call('corrupt',{...scope(f),kind,otherProject:other.projectId});await time(c,(await state(c,f)).run.nextAt);const run=await tick(c,f);assert.equal(run.status,'BLOCKED');assert.equal(reads(f).filter(r=>r.kind==='COMMENTS').length,1);
 });
 await check('U5 freezes actual saved bounded observations and candidate uses only explicitly adopted feedback',async()=>{
  const proof=await c.call('u5',{projectId:normal.projectId});assert.equal(proof.selectedContentUnchanged,true);assert.equal(proof.insight.observationEvidence.coverage.status,'PARTIAL');assert.equal(proof.insight.observationEvidence.coverage.platformCoverage,'UNKNOWN');assert.equal(proof.afterDeactivationReceipt,null);assert.ok(proof.insight.observationEvidence.coverage.collectionScopes.length>=2);
  await c.stop();c=await child();assert.equal(await c.call('verify-candidate',{projectId:normal.projectId,candidate:proof.persistedCandidate}),true);
 });
 for(const kind of ['comment','metric'])await check('U5 refuses changed saved '+kind+' without creating an insight or calling a model',async()=>{
  const f=await c.call('seed');await tick(c,f);assert.equal(await c.call('u5-corrupt',{projectId:f.projectId,kind}),true);
 });
 await check('U5 cannot adopt a frozen snapshot after the original ID list changes',async()=>{const f=await c.call('seed');await tick(c,f);assert.equal(await c.call('u5-wrong-id',{projectId:f.projectId}),true);});
 const boundary=await c.call('boundary');assert.equal(boundary.providers,0);assert.equal(boundary.executions,0);assert.equal(boundary.attempts,0);assert.equal(boundary.forbiddenModelCalls,0);fs.writeFileSync(path.join(evidence,'boundary.json'),JSON.stringify(boundary,null,2));
 assert.ok(results.every(r=>r.passed));await c.stop();assert.ok(children.every(c=>c.closed&&(c.code===0||c.code===73)));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code})),database:'ACTUAL_NEW_SQLITE_PRISMA',runtime:'FIXED_LOCAL_OPERATIONS_NO_NETWORK',u5:'ACTUAL_SAVED_OBSERVATIONS_LOCAL_REVIEW_FIXED_CREATIVE_RESPONSE',expectedCrashExit:73,selectedModelPreserved:'aihubmix/deepseek-v4.1-flash',actualModelCalls:0,actualCost:'UNKNOWN',audio:'NOT_OBSERVED',realUpload:0,realPublication:0,realReply:0,realPlatformE2E:'NOT_RUN',realU3Editor:'BLOCKED_PRESERVED',realU5Adoption:'NOT_PERFORMED'},null,2));
});
