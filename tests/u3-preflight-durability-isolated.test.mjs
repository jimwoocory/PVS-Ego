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

const session=process.env.PVS_U3_DURABLE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
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
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/u3-preflight-durable-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const event=JSON.parse(line);c.events.push(event);if(event.requestId){const handler=c.pending.get(event.requestId);if(handler){c.pending.delete(event.requestId);event.error?handler.reject(Error(event.error)):handler.resolve(event.result);}}});
 p.once('error',error=>{c.closed=true;c.stderr+=error.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const handler of c.pending.values())handler.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});};
 c.stop=async()=>{if(!c.closed){await c.call('close');await until(()=>c.closed,'child clean exit');}assert.equal(c.code,0,c.stderr);};
 await until(()=>c.events.some(e=>e.ready)||c.closed,'guarded Prisma ready');assert.equal(c.closed,false,c.stderr);c.origin=c.events.find(e=>e.ready).origin;return c;
}
const consent=cp=>({expectedAccountId:cp.scope.account.id,scopeHash:cp.scopeHash,revision:cp.version});
async function api(c,f,action,body){const base='/api/projects/'+f.projectId+'/publish/packages/'+f.package.id;const r=await fetch(c.origin+base+(action==='/direct'?action:'/browser-preflight'+(action?'/'+action:'')),body===undefined?{}:{method:'POST',headers:{'content-type':'application/json',Origin:c.origin},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const state=(c,f)=>c.call('state',{projectId:f.projectId,packageId:f.package.id});
async function prepared(c){const f=await c.call('seed'),r=await api(c,f,'prepare',{confirmedPreparation:true,expectedAccountId:'synthetic-account'});assert.equal(r.status,200,JSON.stringify(r.data));return {...f,checkpoint:r.data.checkpoint};}
async function handed(c){const f=await prepared(c),r=await api(c,f,'handoff',{confirmed:true,...consent(f.checkpoint)});assert.equal(r.status,200,JSON.stringify(r.data));return {...f,checkpoint:r.data.checkpoint};}

test('U3 durable preparation reservation, current handoff consent and read-only continuation',{timeout:990000},async t=>{
 t.after(async()=>{
  for(const c of children)if(!c.closed){c.p.stdin.end();await until(()=>c.closed,'cleanup',1000).catch(()=>c.p.kill());await until(()=>c.closed,'killed child',3000).catch(()=>{});}
  for(const [i,c] of children.entries())fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));
 });
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});if(!passed)throw Error('STOP_AFTER_FAILED_CASE_'+name);};
 let c=await child();
 await check('actual HTTP rejects missing preparation consent and wrong strong account before mutation',async()=>{
  const f=await c.call('seed');assert.equal((await api(c,f,'prepare',{confirmedPreparation:false,expectedAccountId:'synthetic-account'})).status,400);assert.equal((await api(c,f,'prepare',{confirmedPreparation:true,expectedAccountId:'nickname'})).status,400);const s=await state(c,f);assert.equal(s.checkpoint,null);assert.equal(s.counts.uploads,0);assert.equal(s.reservations.length,0);
 });
 await check('two actual processes competing through different packages reserve one media and assembly atomically',async()=>{
  const f=await c.call('seed'),other=await c.call('create-package',{projectId:f.projectId}),peer=await child();
  await c.call('gate-account');await peer.call('gate-account');const before=(await state(c,f)).counts.uploads;
  const a=c.call('prepare',{projectId:f.projectId,packageId:f.package.id}),b=peer.call('prepare',{projectId:f.projectId,packageId:other.id});a.catch(()=>{});b.catch(()=>{});
  await until(()=>c.events.some(e=>e.accountCheckWaiting)&&peer.events.some(e=>e.accountCheckWaiting),'both loaded before durable fence');
  await Promise.all([c.call('release-account'),peer.call('release-account')]);const out=await Promise.allSettled([a,b]);assert.equal(out.filter(r=>r.status==='fulfilled').length,1);
  const own=await state(c,f),foreign=await peer.call('state',{projectId:f.projectId,packageId:other.id});assert.equal(own.counts.uploads-before+foreign.counts.uploads,1);assert.equal(own.reservations.length,2);assert.ok(own.reservations.every(r=>r.version===1));
  const next=await c.call('create-package',{projectId:f.projectId});await assert.rejects(c.call('prepare',{projectId:f.projectId,packageId:next.id}),/检查点|占用/);await peer.stop();
 });
 await check('a failed transaction rolls back both media reservations and PREPARING before any fixture preparation',async()=>{
  const f=await c.call('seed'),before=(await state(c,f)).counts.uploads;await c.call('rollback-next');await assert.rejects(c.call('prepare',{projectId:f.projectId,packageId:f.package.id,rollback:true}),/INJECTED_TRANSACTION_ROLLBACK/);
  const s=await state(c,f);assert.equal(s.checkpoint,null);assert.equal(s.reservations.length,0);assert.equal(s.counts.uploads,before);
  await c.call('prepare',{projectId:f.projectId,packageId:f.package.id});assert.equal((await state(c,f)).reservations.length,2);
 });
 await check('handoff and return require the current version, scope and account; only original binding resumes',async()=>{
  const f=await prepared(c),cp=f.checkpoint,before=await state(c,f);
  for(const body of [{confirmed:true},{confirmed:true,...consent(cp),revision:cp.version-1},{confirmed:true,...consent(cp),scopeHash:'0'.repeat(64)},{confirmed:true,...consent(cp),expectedAccountId:'wrong-account'}])assert.equal((await api(c,f,'handoff',body)).status,400);
  assert.deepEqual((await state(c,f)).checkpoint,cp);assert.equal((await state(c,f)).counts.handoffs,before.counts.handoffs);
  const h=await api(c,f,'handoff',{confirmed:true,...consent(cp)});assert.equal(h.status,200);assert.equal(h.data.checkpoint.phase,'WAITING_USER_CONTROL');
  assert.equal((await api(c,f,'resume',{confirmedReturnControl:true})).status,400);assert.equal((await api(c,f,'resume',{confirmedReturnControl:true,...consent(cp)})).status,400);
  await c.call('actor',{projectId:f.projectId,change:'return'});const r=await api(c,f,'resume',{confirmedReturnControl:true,...consent(h.data.checkpoint)});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.checkpoint.phase,'RESTORED_WAITING_CONTINUE');assert.deepEqual(r.data.checkpoint.binding,cp.binding);
  const s=await state(c,f);assert.equal(s.counts.uploads,before.counts.uploads);assert.equal(s.counts.submits,0);assert.equal(s.counts.resumes-before.counts.resumes,1);
 });
 for(const change of ['account','title','document','disconnect'])await check('explicit return with '+change+' drift blocks without refill, reupload or submit',async()=>{
  const f=await handed(c),before=await state(c,f);await c.call('actor',{projectId:f.projectId,change:'return'});await c.call('actor',{projectId:f.projectId,change});assert.equal((await api(c,f,'resume',{confirmedReturnControl:true,...consent(f.checkpoint)})).status,400);
  const after=await state(c,f);assert.equal(after.checkpoint.phase,'BLOCKED');assert.equal(after.counts.uploads,before.counts.uploads);assert.equal(after.counts.submits,before.counts.submits);const next=await c.call('create-package',{projectId:f.projectId});await assert.rejects(c.call('prepare',{projectId:f.projectId,packageId:next.id}),/检查点/);
 });
 await check('expiry during user control blocks locally before the continuation runtime reads the page',async()=>{
  const f=await handed(c),before=await state(c,f);await c.call('expire',{packageId:f.package.id});assert.equal((await api(c,f,'resume',{confirmedReturnControl:true,...consent(f.checkpoint)})).status,400);const s=await state(c,f);assert.equal(s.checkpoint.phase,'BLOCKED');assert.equal(s.counts.resumes,before.counts.resumes);assert.equal(s.counts.uploads,before.counts.uploads);
 });
 await check('a single inert submit with lost response remains UNKNOWN and fences all future packages',async()=>{
  const f=await handed(c);await c.call('actor',{projectId:f.projectId,change:'return'});const r=await api(c,f,'resume',{confirmedReturnControl:true,...consent(f.checkpoint)});assert.equal(r.status,200);const cp=r.data.checkpoint,before=await state(c,f),body={confirmed:true,expectedAccountId:cp.scope.account.id,preparedScopeHash:cp.scopeHash,preparedRevision:cp.version};
  assert.equal((await api(c,f,'/direct',body)).status,400);assert.equal((await api(c,f,'/direct',body)).status,400);const s=await state(c,f);assert.equal(s.package.status,'SUBMISSION_UNKNOWN');assert.equal(s.checkpoint.phase,'SUBMISSION_UNKNOWN');assert.equal(s.counts.submits-before.counts.submits,1);assert.ok(s.receipts.some(r=>r.kind==='SUBMISSION_UNKNOWN'&&!r.trusted));assert.equal(s.receipts.some(r=>r.trusted),false);
  const next=await c.call('create-package',{projectId:f.projectId});await assert.rejects(c.call('prepare',{projectId:f.projectId,packageId:next.id}));
 });
 for(const kind of ['scopeHash','package','binding'])await check('checkpoint '+kind+' mismatch is rejected even when the envelope hash is recomputed',async()=>{
  const f=await prepared(c);await c.call('corrupt',{projectId:f.projectId,packageId:f.package.id,kind});await assert.rejects(state(c,f),/INTEGRITY/);const rejected=await api(c,f,'');assert.equal(rejected.status,400);assert.match(JSON.stringify(rejected.data),/完整性无法核验/);assert.doesNotMatch(rejected.data.message,/请重试/);
 });
 await check('actual process death after inert preparation preserves PREPARING and never uploads again',async()=>{
  const f=await c.call('seed'),crash=await child();await crash.call('crash-next');crash.call('prepare',{projectId:f.projectId,packageId:f.package.id}).catch(()=>{});await until(()=>crash.closed,'actual deliberate process exit');assert.equal(crash.code,73);
  const restarted=await child(),s=await state(restarted,f);assert.equal(s.checkpoint.phase,'PREPARING');assert.equal(s.reservations.length,2);assert.equal(s.counts.uploads,0);await assert.rejects(restarted.call('prepare',{projectId:f.projectId,packageId:f.package.id}));const next=await restarted.call('create-package',{projectId:f.projectId});await assert.rejects(restarted.call('prepare',{projectId:f.projectId,packageId:next.id}));assert.equal((await state(restarted,f)).counts.uploads,0);await restarted.stop();
 });
 let browser;
 await check('original UI fragment sends current handoff/return confirmation through native browser clicks',async()=>{
  const f=await c.call('seed'),before=await state(c,f);browser={session,origin:c.origin,projectId:f.projectId,packageId:f.package.id,url:c.origin+'/fixture-panel/'+f.projectId+'/'+f.package.id};
  fs.writeFileSync(path.join(evidence,'browser-ready.json'),JSON.stringify(browser,null,2));fs.writeFileSync(path.join(root,'.runtime/u3-preflight-browser-ready.json'),JSON.stringify(browser,null,2));console.log('U3_BROWSER_READY '+JSON.stringify(browser));
  await until(()=>fs.existsSync(path.join(evidence,'browser-result.json')),'native browser verification receipt',720000);
  const proof=JSON.parse(fs.readFileSync(path.join(evidence,'browser-result.json'),'utf8'));assert.equal(proof.nativeClicks,true);assert.equal(proof.submitAttempted,false);assert.equal(proof.reloadedRestored,true);
  const after=await state(c,f);assert.equal(after.checkpoint.phase,'RESTORED_WAITING_CONTINUE');assert.equal(after.counts.uploads-before.counts.uploads,1);assert.equal(after.counts.handoffs-before.counts.handoffs,1);assert.equal(after.counts.resumes-before.counts.resumes,1);assert.equal(after.counts.submits,before.counts.submits);assert.equal(after.counts.legacy,0);
  const posts=after.requests.filter(r=>r.method==='POST'&&r.url.includes(f.package.id));assert.ok(posts.some(r=>r.url.endsWith('/handoff')&&r.status===200));assert.ok(posts.some(r=>r.url.endsWith('/resume')&&r.status===200));assert.equal(posts.some(r=>r.url.endsWith('/direct')),false);
  fs.writeFileSync(path.join(evidence,'browser-business-state.json'),JSON.stringify({before,after},null,2));
 });
 assert.ok(results.every(r=>r.passed));await c.stop();assert.ok(children.every(c=>c.closed&&(c.code===0||c.code===73)));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,browser,database:'ACTUAL_NEW_SQLITE_PRISMA',businessHttp:'ACTUAL_ORIGINAL_SERVER',ui:'ORIGINAL_PREFLIGHT_FRAGMENT_NATIVE_CLICKS',publisher:'INERT_FILE_BACKED_NO_NETWORK',actualModelCalls:0,realUploads:0,realSubmissions:0,realPlatformE2E:'NOT_RUN',realEditor:'BLOCKED_PRESERVED',realEgoRuntime:'NOT_RUN_THIS_SUITE',expectedCrashExit:73,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code}))},null,2));
});
