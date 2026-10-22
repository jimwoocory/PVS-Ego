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

const session=process.env.PVS_CAPTURE_DURABLE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
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
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-capture-durability-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const event=JSON.parse(line);c.events.push(event);if(event.requestId){const handler=c.pending.get(event.requestId);if(handler){c.pending.delete(event.requestId);event.error?handler.reject(Error(event.error)):handler.resolve(event.result);}}});
 p.once('error',error=>{c.closed=true;c.stderr+=error.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const handler of c.pending.values())handler.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});};
 c.stop=async()=>{if(!c.closed){await c.call('close');await until(()=>c.closed,'child clean exit');}assert.equal(c.code,0,c.stderr);};
 await until(()=>c.events.some(e=>e.ready)||c.closed,'guarded Prisma ready');assert.equal(c.closed,false,c.stderr);return c;
}
async function crashed(c,runId,fault){
 c.call('collect',{runId,fault}).catch(()=>{});await until(()=>c.closed,'injected actual process exit');assert.equal(c.code,73);
}
test('owned acquisition reservation and explicit published-file recovery',{timeout:120000},async t=>{
 t.after(async()=>{
  for(const c of children)if(!c.closed){c.p.stdin.end();await until(()=>c.closed,'cleanup',1000).catch(()=>c.p.kill());await until(()=>c.closed,'killed child',3000).catch(()=>{});}
  for(const [i,c] of children.entries())fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));
 });
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 let c=await child();await c.call('initialize');
 await check('same-process competing providers reserve before acquisition and never duplicate a capture',async()=>{
  const runId='same-process';await c.call('prepare',{runId});
  const winner=c.call('collect',{runId,hold:true});winner.catch(()=>{});
  await until(()=>c.events.some(e=>e.captureStarted===runId),'winner acquired');
  const contenders=await Promise.allSettled(Array.from({length:12},()=>c.call('collect',{runId})));
  assert.ok(contenders.every(r=>r.status==='rejected'&&r.reason.message==='GO_RESEARCH_CAPTURE_PENDING'));
  assert.equal((await c.call('state',{runId})).captureCalls,1);
  await c.call('release',{runId});assert.equal((await winner).title,'合成中断证据');
  assert.equal((await c.call('state',{runId})).artifact.integrityStatus,'READY');
 });
 await check('a second actual process cannot capture an active reservation; restart reuses verified READY bytes',async()=>{
  const runId='cross-process';await c.call('prepare',{runId});const winner=c.call('collect',{runId,hold:true});winner.catch(()=>{});
  await until(()=>c.events.some(e=>e.captureStarted===runId),'cross-process winner');
  const peer=await child();await assert.rejects(peer.call('collect',{runId}),/GO_RESEARCH_CAPTURE_PENDING/);assert.equal((await peer.call('state',{runId})).captureCalls,0);
  const liveBefore=await peer.call('state',{runId}),generic=await peer.call('generic-recovery');
  assert.ok(generic.pending.deferred.includes(liveBefore.artifact.id));assert.ok(generic.project.deferred.includes(liveBefore.artifact.id));
  assert.equal((await peer.call('state',{runId})).artifact.integrityStatus,'PENDING');
  await c.call('release',{runId});const doc=await winner;await c.stop();c=peer;
  assert.deepEqual(await c.call('collect',{runId}),doc);assert.equal((await c.call('state',{runId})).captureCalls,0);
 });
 await check('actual death after reservation stays PENDING and cannot recapture or invent missing bytes',async()=>{
  const runId='death-before-capture';await c.call('prepare',{runId});await crashed(c,runId,'before-capture');c=await child();
  await assert.rejects(c.call('collect',{runId}),/GO_RESEARCH_CAPTURE_PENDING/);
  await assert.rejects(c.call('recover',{runId}));const s=await c.call('state',{runId});assert.equal(s.artifact.integrityStatus,'PENDING');assert.equal(s.captureCalls,0);assert.equal(s.evidence,0);
 });
 await check('actual death after publication finalizes the exact receipt without a worker or Evidence insertion',async()=>{
  const runId='death-after-publication';await c.call('prepare',{runId});await crashed(c,runId,'after-publish');c=await child();
  const before=await c.call('state',{runId});assert.equal(before.artifact.integrityStatus,'PENDING');await assert.rejects(c.call('collect',{runId}),/GO_RESEARCH_CAPTURE_PENDING/);
  const generic=await c.call('generic-recovery');assert.ok(generic.project.deferred.includes(before.artifact.id));assert.equal((await c.call('state',{runId})).artifact.integrityStatus,'PENDING');
  const doc=await c.call('recover',{runId});const after=await c.call('state',{runId});assert.equal(after.artifact.integrityStatus,'READY');assert.equal(after.captureCalls,0);assert.equal(after.evidence,0);assert.deepEqual(after.run,before.run);
  assert.deepEqual(await c.call('collect',{runId}),doc);await assert.rejects(c.call('recover',{runId}),/GO_RESEARCH_RECOVERY_NOT_AVAILABLE/);
 });
 for(const kind of ['bytes','missing','receipt','missing-receipt','path'])await check('pending recovery refuses '+kind+' without recapture, repair or status promotion',async()=>{
  const runId='denied-'+kind;await c.call('prepare',{runId});await crashed(c,runId,'after-publish');c=await child();
  await c.call('corrupt',{runId,kind});await assert.rejects(c.call('recover',{runId}));await assert.rejects(c.call('collect',{runId}),/GO_RESEARCH_CAPTURE_PENDING|GO_RESEARCH_ARTIFACT_DENIED/);
  const s=await c.call('state',{runId});assert.equal(s.artifact.integrityStatus,'PENDING');assert.equal(s.captureCalls,0);assert.equal(s.evidence,0);
 });
 await check('scope and completed-run gates precede cached bytes or recovery',async()=>{
  const runId='scope-gates';await c.call('prepare',{runId});await assert.rejects(c.call('collect',{runId,projectId:'capture-foreign-project'}),/GO_RESEARCH_SCOPE_DENIED/);
  await assert.rejects(c.call('recover',{runId,projectId:'capture-foreign-project'}),/GO_RESEARCH_SCOPE_DENIED/);
  await c.call('collect',{runId});const before=(await c.call('state',{runId})).captureCalls;
  await c.call('corrupt',{runId,kind:'complete-run'});await assert.rejects(c.call('collect',{runId}),/GO_RESEARCH_RUN_DENIED/);await assert.rejects(c.call('recover',{runId}),/GO_RESEARCH_RUN_DENIED/);
  assert.equal((await c.call('state',{runId})).captureCalls,before);
 });
 await check('legacy READY documents need no new receipt; hash tampering still blocks with no recapture',async()=>{
  const runId='legacy-ready';await c.call('prepare',{runId});const doc=await c.call('collect',{runId});await c.call('corrupt',{runId,kind:'missing-receipt'});
  assert.deepEqual(await c.call('collect',{runId}),doc);const before=(await c.call('state',{runId})).captureCalls;
  await c.call('corrupt',{runId,kind:'bytes'});await assert.rejects(c.call('collect',{runId}),/GO_RESEARCH_ARTIFACT_CHANGED/);assert.equal((await c.call('state',{runId})).captureCalls,before);
 });
 await check('ordinary immutable storage retains no-overwrite semantics and validates a reserved target',async()=>{
  assert.equal(await c.call('store-baseline'),true);
 });
 await check('saved Ego documents above 120k characters and 512KiB remain reviewable within the capture contract',async()=>{
  const runId='large-ego-document';await c.call('prepare',{runId});const result=await c.call('long-ego',{runId,repetitions:25000});
  assert.ok(result.characters>120000&&result.characters<=300000);assert.ok(result.bytes>512*1024);assert.equal(result.status,'VERIFIED');assert.equal(result.textLength,result.characters);
 });
 await check('saved Ego text over the actual 300k capture contract remains blocked',async()=>{
  const runId='oversized-ego-document';await c.call('prepare',{runId});const result=await c.call('long-ego',{runId,repetitions:40000});
  assert.ok(result.characters>300000);assert.equal(result.status,'BLOCKED');assert.equal(result.code,'DOCUMENT_INVALID');
 });
 assert.ok(results.every(r=>r.passed));await c.stop();
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,database:'ACTUAL_NEW_SQLITE_PRISMA',acquisition:'INERT_FIXED_CAPTURE',realGo:'NOT_RUN_THIS_SUITE',platformE2E:'NOT_RUN',actualModelCalls:0,actualExternalCalls:0,productionWiring:false,expectedCrashExit:73,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code}))},null,2));
});
