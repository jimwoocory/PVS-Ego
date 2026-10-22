import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_EVIDENCE_REVIEW_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));const out=path.join(session,'evidence'),database=path.join(session,'blank.db');
const sql=new DatabaseSync(database);try{for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sql.exec(fs.readFileSync(file,'utf8'));}assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);}finally{sql.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn,label,ms=15000){const begin=Date.now();while(Date.now()-begin<ms){if(fn())return;await sleep(30);}throw Error('TIMEOUT '+label);}
test('read-only evidence inspection via actual app routes, Prisma and native browser',{timeout:720000},async t=>{
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/research-evidence-review-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const child={closed:false,code:null,stdout:'',stderr:''},pending=new Map(),results=[];
 p.stdout.on('data',b=>child.stdout+=b);p.stderr.on('data',b=>child.stderr+=b);p.once('close',(code,signal)=>{Object.assign(child,{closed:true,code,signal});for(const h of pending.values())h.reject(Error('CHILD_CLOSED'));pending.clear();});
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.requestId){const h=pending.get(e.requestId);if(h){pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}}});
 const call=op=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,requestId})+'\n');});};
 t.after(async()=>{if(!child.closed){p.stdin.end();await until(()=>child.closed,'cleanup',1000).catch(()=>p.kill());await until(()=>child.closed,'killed fixture',3000).catch(()=>{});}fs.writeFileSync(path.join(out,'fixture-exit.json'),JSON.stringify({pid:p.pid,...child},null,2));});
 await until(()=>fs.existsSync(path.join(out,'ready.json'))||child.closed,'ready');assert.equal(child.closed,false,child.stderr);
 const ready=JSON.parse(fs.readFileSync(path.join(out,'ready.json'),'utf8'));
 const request=(route,options={})=>new Promise((resolve,reject)=>{const req=http.request(new URL(route,ready.origin),options,res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body,json:()=>JSON.parse(body)}));});req.once('error',reject);req.end();});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 await check('valid document verifies bytes and content hashes without interpreting source markup',async()=>{
  const api=await request(ready.cases.main.api);assert.equal(api.status,200);const value=api.json().result;assert.equal(value.status,'VERIFIED');assert.equal(value.contentHash,ready.cases.main.contentHash);assert.equal(value.artifactSha256,ready.cases.main.artifactSha256);assert.equal(value.truncated,false);
  const page=await request(ready.cases.main.page);assert.equal(page.status,200);assert.ok(page.body.includes('&lt;script&gt;'));assert.ok(!page.body.includes('<script>globalThis.__evidenceScriptRan'));assert.ok(page.headers['content-security-policy'].includes("default-src 'none'"));assert.equal(page.headers['cache-control'],'no-store');
  const truncated=(await request(ready.cases.truncated.api)).json().result;assert.equal(truncated.status,'VERIFIED');assert.equal(truncated.truncated,true);
 });
 await check('missing, changed, foreign-path and metadata-mismatched files are blocked without body disclosure',async()=>{
  for(const [key,code] of [['missing','FILE_MISSING'],['changed','ARTIFACT_CHANGED'],['path','PATH_DENIED'],['mismatch','EVIDENCE_MISMATCH']]){const r=await request(ready.cases[key].api);assert.equal(r.status,409);assert.equal(r.json().result.code,code);assert.equal(r.json().result.text,undefined);}
 });
 await check('project/run/evidence ownership, local origin and GET-only semantics hold',async()=>{
  assert.equal((await request(ready.cases.main.api.replace(ready.projectId,ready.foreign))).status,404);
  assert.equal((await request(ready.cases.main.api.replace(ready.cases.main.runId,ready.cases.truncated.runId))).status,404);
  assert.equal((await request(ready.cases.main.api,{method:'POST'})).status,405);
  assert.equal((await request(ready.cases.main.api,{headers:{origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await request(ready.cases.main.api,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await request(ready.cases.main.api.replace(ready.cases.main.evidenceId,'%2e%2e%2fforeign'))).status,404);
 });
 await check('collection-only BASIC status offers saved evidence and cannot offer a deep-research resume',async()=>{
  const r=await request(ready.researchPage);assert.equal(r.status,200);assert.ok(r.body.includes('来源证据已保存，摘要尚未生成'));assert.ok(r.body.includes('查看已保存正文'));assert.ok(!r.body.includes('id="research-resume"'));assert.ok(!r.body.includes('<h3>深度研究需要你处理</h3>'));
 });
 console.log('PVS_EVIDENCE_REVIEW_BROWSER_READY '+ready.origin+ready.researchPage);
 fs.writeFileSync(path.join(root,'.runtime/evidence-review-active.json'),JSON.stringify({session,ready},null,2));
 await check('native browser opens saved evidence, reloads it and returns without executing source text',async()=>{
  const file=path.join(out,'browser-result.json');await until(()=>fs.existsSync(file)||child.closed,'native browser result',600000);assert.equal(child.closed,false,child.stderr);
  const browser=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(browser.status,'PASS');assert.equal(browser.actualBrowserClicks,true);assert.equal(browser.sourceScriptExecuted,false);assert.equal(browser.deepResumeOffered,false);assert.equal(browser.pageErrors.length,0);
 });
 await check('all reads leave persistent state and acquisition/model counters unchanged',async()=>{
  const state=await call('state');assert.equal(state.after,state.before);assert.deepEqual(state.current,state.initial);assert.equal(state.current.modelCalls,0);assert.equal(state.current.discoveryCalls,0);
  const browserRequests=state.requests.filter(r=>r.method==='POST');assert.equal(browserRequests.length,1);assert.equal(browserRequests[0].status,405);
 });
 assert.ok(results.every(r=>r.passed));const result=await call('close');await until(()=>child.closed,'actual fixture exit');assert.equal(child.code,0,child.stderr);
 fs.writeFileSync(path.join(out,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,fixture:result,browser:JSON.parse(fs.readFileSync(path.join(out,'browser-result.json'),'utf8')),actualGo:'NOT_RUN_THIS_SUITE',platformE2E:'NOT_RUN',productionExecution:false,child:{pid:p.pid,closed:child.closed,code:child.code}},null,2));
});
