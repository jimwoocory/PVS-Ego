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
const session=process.env.PVS_PR1_METRICS_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[];
const sql=new DatabaseSync(database);try{
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sql.exec(fs.readFileSync(file,'utf8'));}
 const tables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>sql.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
 fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({newBlankDatabase:true,businessRows:0,tables:tables.length,copiedExistingDatabase:false}));
}finally{sql.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=30000){const begin=Date.now();while(Date.now()-begin<timeout){if(fn())return;await pause(40);}throw Error('BOUNDED_WAIT_EXPIRED');}
async function child(){
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-metrics-integration-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);p.once('error',e=>c.stderr+=e.message);p.once('close',code=>{c.closed=true;c.code=code;for(const h of c.pending.values())h.reject(Error(c.stderr||'CHILD_CLOSED'));c.pending.clear();});
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.ready)c.ready=e.ready;const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 c.call=(op,name,extra={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,name,...extra,requestId})+'\n');});
 c.stop=async()=>{await c.call('close');p.stdin.end();await until(()=>c.closed);assert.equal(c.code,0,c.stderr);};
 await until(()=>c.ready||c.closed);assert.ok(c.ready,c.stderr);return c;
}
const page=c=>`/projects/${c.projectId}/operations/schedules/${c.runId}`;
async function http(c,url,options={}){const response=await fetch(c.ready.origin+url,options),body=await response.text();return {code:response.status,body,headers:Object.fromEntries(response.headers),json:()=>JSON.parse(body)};}
test('current shared metrics through actual Prisma, original HTTP and native browser',{timeout:900000},async t=>{
 t.after(async()=>{for(const [i,c] of children.entries()){if(!c.closed){c.p.stdin.end();await until(()=>c.closed,1000).catch(()=>c.p.kill());await until(()=>c.closed,3000).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,stdout:c.stdout,stderr:c.stderr},null,2));}});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});if(!passed)throw Error('STOP_AFTER_FAILED_CHECK '+name);};
 let c=await child(),cases=c.ready.cases;
 await check('actual Prisma preserves unknown metrics without fake numeric rows',async()=>{
  const partial=await c.call('storage','partial'),full=await c.call('storage','full');assert.equal(partial.full.length,0);assert.equal(partial.partial.length,1);assert.equal(full.full.length,1);assert.equal(full.partial.length,0);
  const data=JSON.parse(partial.partial[0].dataJson);assert.equal(data.likes,0);assert.equal(data.plays,undefined);assert.equal(data.metricAvailability.plays,'NOT_VISIBLE');assert.equal(full.full[0].plays,0);
 });
 await check('partial metric HTTP returns unavailable plays and observed zero likes',async()=>{
  const api=await http(c,'/api'+page(cases.partial));assert.equal(api.code,200,api.body);const m=api.json().result.metrics[0];assert.equal(m.likes,0);assert.equal(m.plays,undefined);assert.equal(m.metricAvailability.plays,'NOT_VISIBLE');
  const html=await http(c,page(cases.partial));assert.equal(html.code,200);assert.match(html.body,/播放 不可见，点赞 0/);assert.equal(html.headers['cache-control'],'no-store');
 });
 await check('full metric HTTP preserves actual observed zeros',async()=>{const html=await http(c,page(cases.full));assert.equal(html.code,200,html.body);assert.match(html.body,/播放 0，点赞 0/);});
 await check('both repository lookup and list agree for valid full and partial records',async()=>{for(const name of ['partial','full']){const single=await c.call('lookup',name),list=await c.call('list',name);assert.equal(list.length,1);assert.deepEqual(list[0],single);}});
 await check('offline rule review saves actual frozen observation with zero model calls',async()=>{const insight=await c.call('review','partial',{local:true});assert.equal(insight.observationEvidence.metrics[0].values.likes,0);assert.equal(insight.observationEvidence.metrics[0].values.plays,undefined);assert.equal(insight.observationEvidence.metrics[0].availability.plays,'NOT_VISIBLE');assert.equal((await c.call('observe')).modelCalls,0);});
 const beforeReads=await c.call('observe');
 for(const name of Object.keys(cases).filter(name=>!['partial','full','pending','badPending'].includes(name)))await check(name+' is rejected without repair, model calls or new acquisition',async()=>{
  const info=cases[name],before=await c.call('observe');
  if(info.storageDenied){await assert.rejects(c.call('lookup',name));await assert.rejects(c.call('list',name));}
  await assert.rejects(c.call('review',name));
  const api=await http(c,'/api'+page(info));assert.equal(api.code,409,api.body);assert.equal(api.json().result.status,'UNVERIFIABLE');
  const html=await http(c,page(info));assert.equal(html.code,409);assert.match(html.body,/保存证据暂不可核验/);assert.doesNotMatch(html.body,/id="open-resume"|点赞 777|点赞 991/);
  const workbench=await http(c,`/projects/${info.projectId}/agent-cycle`);assert.equal(workbench.code,200,workbench.body);assert.match(workbench.body,/保存指标暂不可核验/);
  const context=await c.call('catalog',name);assert.equal(context.operations.metricReadError,true);assert.deepEqual(context.operations.snapshots,[]);
  const after=await c.call('observe');assert.equal(after.digest,before.digest);assert.deepEqual(after.reads,before.reads);assert.equal(after.modelCalls,0);
 });
 await check('all saved-data inspection preserves DB and fixed acquisition counts',async()=>{const after=await c.call('observe');assert.equal(after.digest,beforeReads.digest);assert.deepEqual(after.reads,beforeReads.reads);assert.equal(after.identityCalls,beforeReads.identityCalls);});
 await check('foreign project, cross-origin and non-read methods stay denied',async()=>{
  assert.equal((await http(c,'/api'+page({...cases.partial,projectId:cases.full.projectId}))).code,404);
  assert.equal((await http(c,'/api'+page(cases.partial),{headers:{origin:'https://foreign.invalid'}})).code,403);
  assert.equal((await http(c,'/api'+page(cases.partial),{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).code,405);
 });
 await check('actual application restart preserves original Prisma records and HTTP projection',async()=>{
  const before=await c.call('observe');await c.stop();c=await child();cases=c.ready.cases;const after=await c.call('observe');assert.equal(after.digest,before.digest);assert.deepEqual(after.reads,before.reads);assert.equal((await http(c,'/api'+page(cases.partial))).code,200);assert.equal((await http(c,'/api'+page(cases['partial-rehashed-json']))).code,409);
 });
 await check('persisted valid metric intent reconciles after restart without repeating metrics read',async()=>{
  const before=await c.call('observe'),run=await c.call('tick','pending'),after=await c.call('observe');assert.equal(run.completedCaptures,1,run.errorMessage);assert.equal(run.history[0].metricsSnapshotId,cases.pending.snapshotId);
  assert.equal(after.reads.filter(r=>r.kind==='METRICS').length,before.reads.filter(r=>r.kind==='METRICS').length);assert.equal(after.reads.filter(r=>r.kind==='COMMENTS').length,before.reads.filter(r=>r.kind==='COMMENTS').length+1);
 });
 await check('damaged persisted metric intent remains blocked without any new page read',async()=>{
  const before=await c.call('observe'),run=await c.call('tick','badPending'),after=await c.call('observe');assert.equal(run.status,'BLOCKED');assert.equal(run.errorCode,'READ_OUTCOME_UNKNOWN');assert.equal(run.checkpoint.pendingRead.kind,'METRICS');assert.equal(run.completedCaptures,0);assert.deepEqual(after.reads,before.reads);
 });
 const beforeBrowser=await c.call('observe');
 await check('native browser reads saved metrics and only resumes one explicitly confirmed original plan',async()=>{
  const info={session,origin:c.ready.origin,partialPage:page(cases.partial),fullPage:page(cases.full),damagedPage:page(cases['partial-rehashed-json']),workbench:`/projects/${cases.partial.projectId}/agent-cycle`,expectedAccountId:'synthetic-metrics-owner'};
  fs.writeFileSync(path.join(evidence,'browser-ready.json'),JSON.stringify(info,null,2));fs.writeFileSync(path.join(root,'.runtime/pr1-metrics-browser-ready.json'),JSON.stringify(info,null,2));console.log('PR1_METRICS_BROWSER_READY '+JSON.stringify(info));
  await until(()=>fs.existsSync(path.join(evidence,'browser-result.json')),720000);const proof=JSON.parse(fs.readFileSync(path.join(evidence,'browser-result.json'),'utf8'));
  assert.equal(proof.nativeClicks,true);assert.equal(proof.observedZeroAndUnavailable,true);assert.equal(proof.cancelledWithoutSubmit,true);assert.equal(proof.confirmedOriginalPlan,true);assert.equal(proof.damagedUnavailable,true);assert.equal(proof.taskFinished,true);assert.ok(['VERIFIED','BLOCKED'].includes(proof.screenshot));
  if(proof.screenshot==='VERIFIED'){assert.ok(proof.screenshotSha256);assert.equal(proof.imageInspected,true);}
  const after=await c.call('observe');assert.equal(after.partial.status,'SCHEDULED');assert.deepEqual(after.partial.input,beforeBrowser.partial.input);assert.equal(after.partial.completedCaptures,beforeBrowser.partial.completedCaptures);assert.deepEqual(after.workspace,beforeBrowser.workspace);assert.deepEqual(after.reads,beforeBrowser.reads);assert.equal(after.identityCalls,beforeBrowser.identityCalls+1);assert.equal(after.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/resume')&&r.status===200).length,1);assert.equal(after.modelCalls,0);assert.equal(after.providers,0);assert.equal(after.executions,0);assert.equal(after.attempts,0);
  fs.writeFileSync(path.join(evidence,'browser-business-state.json'),JSON.stringify({before:beforeBrowser,after},null,2));
 });
 const final=await c.call('observe');await c.stop();assert.ok(children.every(v=>v.closed&&v.code===0));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_SUITE_EXIT',pass:results.length+1,fail:0,results,children:children.map(v=>({pid:v.p.pid,closed:v.closed,code:v.code})),database:'ACTUAL_NEW_SQLITE_PRISMA',http:'ORIGINAL_APP_ROUTES',browser:'TABBIT_NATIVE_CLICKS',runtime:'FIXED_IN_PROCESS_OBSERVATIONS',actualModelCalls:final.modelCalls,realPlatformCalls:0,realGoCalls:0,readEvents:final.reads.length,audio:'NOT_OBSERVED',actualCost:'UNKNOWN',selectedModel:'aihubmix/deepseek-v4.1-flash'},null,2));
});
