// One 15-minute native-timer suite. Only a newly migrated synthetic DB is opened.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {randomUUID,createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {root,isolatedEnvironment,confined} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_PR1_SCALE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[],samples=[];
const sql=new DatabaseSync(database);sql.exec('PRAGMA busy_timeout=50');
assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);
for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const f=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(f))sql.exec(fs.readFileSync(f,'utf8'));}
const tables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>sql.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({newBlankDatabase:true,businessRows:0,tables:tables.length,copiedExistingDatabase:false}));
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=60000,interval=200){const start=Date.now();while(Date.now()-start<timeout){const r=await fn();if(r)return r;await sleep(interval);}throw Error('BOUNDED_WAIT_EXPIRED');}
async function child(label){const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-worker-scale-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,label,closed:false,code:null,stdout:'',stderr:'',pending:new Map()};children.push(c);p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);p.once('error',e=>c.stderr+=e.message);p.once('close',code=>{c.closed=true;c.code=code;for(const h of c.pending.values())h.reject(Error('CHILD_CLOSED:'+code));c.pending.clear();});
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.ready)c.ready=true;const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 c.call=(op,extra={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...extra,requestId})+'\n');});
 c.close=async()=>{await c.call('stop');await sleep(2000);await c.call('close');p.stdin.end();await until(()=>c.closed);assert.equal(c.code,0,c.stderr);};await until(()=>c.ready||c.closed);assert.ok(c.ready,c.stderr);return c;
}
function events(){return fs.readdirSync(evidence).filter(f=>/^events-\d+\.jsonl$/.test(f)).flatMap(f=>fs.readFileSync(path.join(evidence,f),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));}
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
test('native worker stability, scale, fair scan and local I/O faults',{timeout:1200000},async t=>{
 t.after(async()=>{try{sql.exec('ROLLBACK');}catch{}for(const c of children){if(!c.closed){try{await c.close();}catch{c.p.kill();await until(()=>c.closed,5000).catch(()=>{});}}fs.writeFileSync(path.join(evidence,c.label+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,stdout:c.stdout,stderr:c.stderr},null,2));}sql.close();});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});if(!passed)throw Error('STOP_AFTER_FAILED_CHECK:'+name);};
 const admin=await child('admin'),a=await child('worker-a'),b=await child('worker-b');
 await check('migrated blank Prisma seeds 1024 smart tasks and 160 Agent tasks',async()=>{assert.deepEqual(await admin.call('seed-bulk'),{smart:1024,agent:160});assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM SmartGenerationRunRecord').get().n,1024);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM AgentCycleRecord').get().n,160);});
 const inertBefore=digest(sql.prepare("SELECT id,dataJson,leaseOwner,leasePid FROM SmartGenerationRunRecord WHERE id LIKE 'z-%' OR id LIKE '00-live-%' ORDER BY id").all());
 const agentInertBefore=digest(sql.prepare("SELECT id,dataJson,leaseOwner,leasePid FROM AgentCycleRecord WHERE id NOT LIKE '10-agent-%' ORDER BY id").all());
 await check('bounded keyset smart index reaches 512 authorized runnable tasks beyond the old 200 row window',async()=>{
   let afterId;const seen=[];do{const p=await admin.call('page',{query:{mode:'MANAGED',afterId}});assert.ok(p.runs.length<=30);seen.push(...p.runs.map(r=>r.id));afterId=p.nextAfterId;}while(afterId);
   assert.equal(seen.length,512);assert.equal(new Set(seen).size,512);assert.ok(seen.every(id=>id.startsWith('00-live-')||id.startsWith('10-eligible-')));assert.equal(events().length,0);
 });
 await check('Agent due filtering and keyset rotation reach 128 tasks beyond sleeping and live-owned heads',async()=>{let afterId;const seen=[];do{const p=await admin.call('agent-page',{afterId});assert.ok(p.cycles.length<=30);seen.push(...p.cycles.map(c=>c.id));afterId=p.nextAfterId;}while(afterId);assert.equal(seen.length,128);assert.equal(new Set(seen).size,128);assert.ok(seen.every(id=>!id.startsWith('00-future-')));});
 const fault='00-a-recovery-io';await admin.call('seed-smart',{id:fault});for(const c of [a,b])await c.call('recovery-fault',{id:fault,enabled:true});
 const starts=[await a.call('start'),await b.call('start')],startedAt=Math.max(...starts.map(s=>s.at));
 await check('two native workers drain the eligible backlog while live leases and one recovery error remain',async()=>{
   await until(()=>sql.prepare("SELECT COUNT(*) AS n FROM SmartGenerationRunRecord WHERE id LIKE '10-eligible-%' AND status='WAITING_FOR_TRUTH_REVIEW'").get().n===480,90000);
   await until(()=>sql.prepare("SELECT COUNT(*) AS n FROM AgentCycleRecord WHERE id LIKE '10-agent-%' AND status='WAITING_USER'").get().n===96,60000);
   const e=events();for(const id of sql.prepare("SELECT id FROM SmartGenerationRunRecord WHERE id LIKE '10-eligible-%'").all().map(r=>r.id))assert.equal(e.filter(v=>v.id===id&&v.kind==='SOURCE').length,1);
   for(const id of sql.prepare("SELECT id FROM AgentCycleRecord WHERE id LIKE '10-agent-%'").all().map(r=>r.id))assert.equal(e.filter(v=>v.id===id&&v.kind==='AGENT').length,1);
   assert.equal((await admin.call('get',{id:fault})).status,'PLANNING');assert.ok((await a.call('sample')).stats.errors.ENOENT>0);
   const owner=await child('waiting-owner'),waiting=await owner.call('seed-smart',{id:'02-human-waiting-owner',kind:'waiting-owned'});
   const saved=sql.prepare("SELECT dataJson,leasePid FROM SmartGenerationRunRecord WHERE id='02-human-waiting-owner'").get();assert.equal(saved.leasePid,owner.p.pid);
   await owner.close();assert.equal(owner.code,0);
   await until(()=>sql.prepare("SELECT leaseOwner FROM SmartGenerationRunRecord WHERE id='02-human-waiting-owner'").get().leaseOwner===null);
   assert.equal(sql.prepare("SELECT dataJson FROM SmartGenerationRunRecord WHERE id='02-human-waiting-owner'").get().dataJson,saved.dataJson);
   assert.equal((await admin.call('get',{id:waiting.id})).status,'WAITING_FOR_TRUTH_REVIEW');assert.equal(events().filter(v=>v.id===waiting.id).length,0);
 });
 await check('actual SQLite checkpoint write abort rolls back the revision and does not starve other tasks',async()=>{
   sql.exec("CREATE TRIGGER scale_checkpoint_failure BEFORE INSERT ON SmartGenerationCheckpointRecord WHEN NEW.runId='01-checkpoint-write' AND NEW.revision>1 BEGIN SELECT RAISE(ABORT,'FIXTURE_CHECKPOINT_WRITE_DENIED'); END");
   await admin.call('seed-smart',{id:'01-checkpoint-write'});await admin.call('seed-smart',{id:'20-good-after-write-error'});
   await until(()=>events().some(e=>e.id==='01-checkpoint-write'));await until(async()=>(await admin.call('get',{id:'20-good-after-write-error'})).status==='WAITING_FOR_TRUTH_REVIEW');
   const run=await admin.call('get',{id:'01-checkpoint-write'});assert.equal(run.revision,1);assert.equal(run.status,'PLANNING');assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM SmartGenerationCheckpointRecord WHERE runId='01-checkpoint-write'").get().n,1);
   sql.exec('DROP TRIGGER scale_checkpoint_failure');await until(async()=>(await admin.call('get',{id:'01-checkpoint-write'})).status==='WAITING_FOR_TRUTH_REVIEW');
 });
 await check('real missing-file and directory-write errors remain failures while unrelated work continues',async()=>{
   for(const [id,kind] of [['03-missing-file','missing'],['04-directory-write','directory-write']]){await admin.call('seed-smart',{id,kind});const run=await until(async()=>{const r=await admin.call('get',{id});return r.status==='FAILED'&&r;});assert.match(run.blocker.message,/ENOENT|EISDIR|EACCES|EPERM/);assert.equal(run.consent,undefined);}
 });
 await check('real exclusive SQLite lock surfaces I/O errors and the unchanged workers recover after unlock',async()=>{
   await until(()=>{try{sql.exec('BEGIN EXCLUSIVE');return true;}catch{return false;}},20000);
   try{await sleep(12000);const errors=[(await a.call('sample')).stats.errors,(await b.call('sample')).stats.errors];assert.ok(errors.some(e=>e.SQLITE_IO_OR_LOCK>0));}finally{sql.exec('ROLLBACK');}
   await admin.call('seed-smart',{id:'20-after-unlock'});await until(async()=>(await admin.call('get',{id:'20-after-unlock'})).status==='WAITING_FOR_TRUTH_REVIEW');
 });
 let pulse=0,lastPulse=0;
 await check('15 uninterrupted native-timer minutes keep bounded pages, resources and new-task service',async()=>{
   while(Date.now()-startedAt<900000){
     for(const c of [a,b]){assert.equal(c.closed,false);const s=await c.call('sample');samples.push(s);assert.equal(s.stats.forbidden,0);assert.equal(s.stats.errors.UNEXPECTED??0,0);assert.ok(s.stats.maxSmartPage<=30&&s.stats.maxAgentPage<=30&&s.stats.maxActivePages<=1);assert.ok(s.memory.rss<768*1024*1024&&s.memory.heapUsed<192*1024*1024);}
     if(Date.now()-lastPulse>=60000){lastPulse=Date.now();for(let i=0;i<8;i++)await admin.call('seed-smart',{id:'20-pulse-'+String(pulse).padStart(5,'0')+'-'+i});pulse++;}
     fs.writeFileSync(path.join(evidence,'soak-progress.json'),JSON.stringify({startedAt,elapsedMs:Date.now()-startedAt,samples:samples.length,pulseBatches:pulse,children:children.map(c=>({pid:c.p.pid,closed:c.closed}))}));
     await sleep(Math.min(10000,Math.max(1,900000-(Date.now()-startedAt))));
   }
   for(const c of [a,b]){const series=samples.filter(s=>s.pid===c.p.pid&&s.at-startedAt>=60000);assert.ok(series.length>=70);const early=series.slice(0,3),late=series.slice(-3);assert.ok(Math.max(...late.map(s=>s.memory.rss))-Math.min(...early.map(s=>s.memory.rss))<128*1024*1024);assert.ok(Math.max(...late.map(s=>s.memory.heapUsed))-Math.min(...early.map(s=>s.memory.heapUsed))<64*1024*1024);assert.ok(late.at(-1).resources.length<=early[0].resources.length+16);}
   fs.writeFileSync(path.join(evidence,'resource-samples.json'),JSON.stringify(samples,null,2));
 });
 await check('all fresh tasks are eventually served without changing old grants, live owners or future wakes',async()=>{
   for(const c of [a,b])await c.call('recovery-fault',{id:fault,enabled:false});await until(async()=>(await admin.call('get',{id:fault})).status==='WAITING_FOR_TRUTH_REVIEW');
   await until(()=>sql.prepare("SELECT COUNT(*) AS n FROM SmartGenerationRunRecord WHERE id LIKE '20-pulse-%' AND status='WAITING_FOR_TRUTH_REVIEW'").get().n===pulse*8);
   assert.equal(digest(sql.prepare("SELECT id,dataJson,leaseOwner,leasePid FROM SmartGenerationRunRecord WHERE id LIKE 'z-%' OR id LIKE '00-live-%' ORDER BY id").all()),inertBefore);
   assert.equal(digest(sql.prepare("SELECT id,dataJson,leaseOwner,leasePid FROM AgentCycleRecord WHERE id NOT LIKE '10-agent-%' ORDER BY id").all()),agentInertBefore);
   assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM (SELECT runId,revision,COUNT(*) AS n FROM SmartGenerationCheckpointRecord GROUP BY runId,revision HAVING n>1)').get().n,0);
 });
 let summary;
 await check('worker stop drains normally and leaves zero provider or generation records',async()=>{
   summary=await admin.call('summary');assert.equal(summary.providers,0);assert.equal(summary.executions,0);assert.equal(summary.attempts,0);
   for(const c of [a,b])await c.call('stop');await sleep(2500);const before=await a.call('sample');await sleep(3200);const after=await a.call('sample');assert.equal(after.stats.smartPages,before.stats.smartPages);assert.equal(after.stats.agentPages,before.stats.agentPages);
   for(const c of children)if(!c.closed)await c.close();assert.ok(children.every(c=>c.closed&&c.code===0));
 });
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({pass:results.length+1,fail:0,results,children:children.map(c=>({label:c.label,pid:c.p.pid,closed:c.closed,code:c.code})),startedAt,endedAt:Date.now(),nativeWorkerWindowMs:Date.now()-startedAt,pulseBatches:pulse,baseSmartTasks:1024,baseAgentTasks:160,finalSummary:summary,sampleCount:samples.length,database:'ACTUAL_NEW_SHARED_SQLITE_PRISMA',observations:'FIXED_LOCAL_FUNCTIONS_AND_LOCAL_FILES',modelCalls:0,realPlatformCalls:0,httpBrowserCalls:0,selectedModel:'aihubmix/deepseek-v4.1-flash',audio:'NOT_OBSERVED',actualCost:'UNKNOWN'},null,2));
});
