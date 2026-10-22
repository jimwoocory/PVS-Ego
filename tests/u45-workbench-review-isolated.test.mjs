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
const session=process.env.PVS_U45_REVIEW_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),children=[],results=[];
const sqlite=new DatabaseSync(database);try{
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sqlite.exec(fs.readFileSync(file,'utf8'));}
 const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>sqlite.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));
 fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({businessRows:0,tables:tables.length,copiedExistingDatabase:false}));
}finally{sqlite.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=20000){const begin=Date.now();while(Date.now()-begin<timeout){if(fn())return;await pause(50);}throw Error('TIMEOUT');}
async function child(){
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/u45-workbench-review-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);c.events.push(e);if(e.ready)c.ready=e.ready;const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 p.once('error',error=>{c.closed=true;c.stderr+=error.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const h of c.pending.values())h.reject(Error(c.stderr||'CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});
 c.stop=async()=>{if(!c.closed){await c.call('close');await until(()=>c.closed);}assert.equal(c.code,0,c.stderr);};
 await until(()=>c.ready||c.closed);assert.equal(c.closed,false,c.stderr);return c;
}
const schedule=(p,id)=>`/projects/${p}/operations/schedules/${id}`;
const candidate=(p,id)=>`/projects/${p}/operations/candidates/${id}`;
async function http(c,url,options={}){const r=await fetch(c.ready.origin+url,options);const body=await r.text();return {code:r.status,body,headers:Object.fromEntries(r.headers),json:()=>JSON.parse(body)};}
const post=(body,headers={})=>({method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('original workbench U4/U5 saved evidence and exact resume confirmation',{timeout:900000},async t=>{
 t.after(async()=>{for(const [i,c] of children.entries()){if(!c.closed){c.p.stdin.end();await until(()=>c.closed,2000).catch(()=>c.p.kill());await until(()=>c.closed,3000).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,stdout:c.stdout,stderr:c.stderr},null,2));}});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 let c=await child(),r=c.ready,p=r.main.projectId,initial=await c.call('observe');
 await check('original workbench shows scoped saved plan states and candidate review links',async()=>{
  const response=await http(c,r.workbench);assert.equal(response.code,200);assert.match(response.body,/保存的运营计划与候选输入/);assert.match(response.body,/原读取结果不明/);assert.match(response.body,/租约已过期/);assert.match(response.body,/租约有效/);assert.ok(response.body.includes(r.candidatePage));assert.ok(response.body.includes(r.authPage));assert.match(response.body,/脚本与分镜尚未准备/);assert.doesNotMatch(response.body,/已有脚本与分镜，待接入执行任务/);
 });
 await check('schedule inspection separates frozen historical coverage from current cursor and missing metric values',async()=>{
  const response=await http(c,'/api'+schedule(p,r.main.run.id));assert.equal(response.code,200);const v=response.json().result;assert.equal(v.status,'VERIFIED');assert.ok(v.run.history.every(h=>h.coverage==='PARTIAL'));assert.ok(v.metrics.every(m=>m.plays===undefined&&m.likes===0));assert.equal(v.resumeAllowed,false);
  const page=await http(c,schedule(p,r.main.run.id));assert.match(page.body,/当前游标可能晚于上方历史范围/);assert.match(page.body,/播放 不可见/);assert.doesNotMatch(page.body,/id="open-resume"/);
 });
 await check('unknown original read remains blocked with no resume control',async()=>{const a=await http(c,'/api'+schedule(p,r.unknownId));assert.equal(a.json().result.resumeAllowed,false);const v=await http(c,schedule(p,r.unknownId));assert.match(v.body,/原读取结果不明/);assert.doesNotMatch(v.body,/id="open-resume"/);});
 await check('paused exact plan offers current confirmation while receipt inspection remains read only',async()=>{const v=await http(c,r.authPage);assert.equal(v.code,200);assert.match(v.body,/我已核对运营账号和原观察范围/);assert.match(v.body,/确认并保存续接/);assert.match(v.body,/取消，保留暂停/);assert.match(v.body,/synthetic-operations-uid/);});
 await check('candidate receipt retains generated-time feedback after deactivation without adopting the candidate',async()=>{
  const v=await http(c,'/api'+r.candidatePage);assert.equal(v.code,200);assert.equal(v.json().result.feedback[0].currentState,'INACTIVE');assert.equal(v.json().result.isCurrent,false);assert.equal(v.json().result.currentTruthMatches,true);
  const page=await http(c,r.candidatePage);assert.match(page.body,/生成时已采用，当前已停用/);assert.match(page.body,/当前项目没有采用此批次/);assert.ok(page.body.includes('&lt;script&gt;globalThis.__u45Executed=true&lt;/script&gt;'));assert.doesNotMatch(page.body,/<script>globalThis\.__u45Executed/);assert.equal(page.headers['cache-control'],'no-store');assert.ok(page.headers['content-security-policy'].includes("frame-ancestors 'none'"));
 });
 for(const kind of Object.keys(r.damaged))await check('receipt '+kind+' mismatch returns explicit unverified state without repair',async()=>{
  const v=await http(c,'/api'+candidate(p,r.damaged[kind]));assert.equal(v.code,409);assert.equal(v.json().result.status,'UNVERIFIABLE');const page=await http(c,candidate(p,r.damaged[kind]));assert.equal(page.code,409);assert.match(page.body,/保存证据暂不可核验/);
 });
 await check('foreign project, wrong methods and cross-origin requests are denied',async()=>{
  assert.equal((await http(c,'/api'+schedule(r.foreign.projectId,r.authId))).code,404);assert.equal((await http(c,'/api'+candidate(r.foreign.projectId,r.candidate.receiptId))).code,404);
  assert.equal((await http(c,'/api'+r.candidatePage,post({confirmed:true}))).code,405);assert.equal((await http(c,'/api'+r.authPage,{headers:{origin:'https://external.invalid'}})).code,403);assert.equal((await http(c,'/api'+r.authPage,{headers:{'sec-fetch-site':'cross-site'}})).code,403);
 });
 await check('damaged plan list does not make the original workbench unusable or invent an empty valid state',async()=>{
  const response=await http(c,`/projects/${r.corruptProject.projectId}/agent-cycle`);assert.equal(response.code,200);assert.match(response.body,/原计划记录暂不可核验/);const detail=await http(c,schedule(r.corruptProject.projectId,r.corruptProject.run.id));assert.equal(detail.code,409);
 });
 await check('invalid immutable Artifact metadata is unavailable rather than a failed workbench or an empty valid list',async()=>{
  const v=await http(c,candidate(r.mutableProject.projectId,r.mutableId));assert.equal(v.code,409);assert.match(v.body,/保存证据暂不可核验/);
  const main=await http(c,`/projects/${r.mutableProject.projectId}/agent-cycle`);assert.equal(main.code,200);assert.match(main.body,/原候选回执列表暂不可核验/);
 });
 await check('all saved-data GETs preserve database and invoke no runtime or model',async()=>{
  const after=await c.call('observe');assert.equal(after.digest,initial.digest);assert.equal(after.identityCalls,initial.identityCalls);assert.equal(after.dataReads,initial.dataReads);assert.equal(after.forbiddenModelCalls,0);
 });
 let current=(await http(c,'/api'+r.authPage)).json().result.run;
 const body=()=>({expectedRevision:current.revision,inputHash:current.inputHash,expectedAccountId:current.input.opsAccountUid,confirmed:true});
 await check('missing consent, mismatched scope and expanded bounds cannot submit a resume',async()=>{
  const before=await c.call('observe');
  for(const input of [{...body(),confirmed:false},{...body(),expectedAccountId:'wrong'},{...body(),inputHash:'0'.repeat(64)},{...body(),maxCaptures:30}])assert.equal((await http(c,'/api'+r.authPage+'/resume',post(input))).code,409);
  assert.equal((await http(c,'/api'+r.authPage+'/resume')).code,405);assert.equal((await http(c,'/api'+schedule(p,r.unknownId)+'/resume',post({...body(),expectedRevision:(await http(c,'/api'+schedule(p,r.unknownId))).json().result.run.revision}))).code,409);
  const after=await c.call('observe');assert.equal(after.digest,before.digest);assert.equal(after.identityCalls,before.identityCalls);
 });
 await check('stale confirmation is rejected without using the new version automatically',async()=>{
  const stale=body();await c.call('pause-auth');const before=await c.call('observe');assert.equal((await http(c,'/api'+r.authPage+'/resume',post(stale))).code,409);const after=await c.call('observe');assert.equal(after.digest,before.digest);assert.equal(after.auth.status,'PAUSED');
 });
 await check('actual application restart preserves file-backed receipt and paused plan with no generation',async()=>{
  const before=await c.call('observe');await c.stop();c=await child();r=c.ready;p=r.main.projectId;const after=await c.call('observe');assert.equal(after.digest,before.digest);assert.equal(after.dataReads,before.dataReads);assert.equal(after.identityCalls,0);assert.equal((await http(c,r.candidatePage)).code,200);assert.equal((await http(c,r.authPage)).code,200);
 });
 assert.ok(results.every(r=>r.passed),'HTTP checks failed before browser verification');
 const beforeBrowser=await c.call('observe');
 await check('native browser reviews saved evidence, cancels then confirms only the exact original plan',async()=>{
  const info={session,origin:r.origin,projectId:p,workbench:r.workbench,authPage:r.authPage,candidatePage:r.candidatePage,unknownPage:schedule(p,r.unknownId),damagedPage:candidate(p,r.damaged.bytes)};
  fs.writeFileSync(path.join(evidence,'browser-ready.json'),JSON.stringify(info,null,2));fs.writeFileSync(path.join(root,'.runtime/u45-workbench-browser-ready.json'),JSON.stringify(info,null,2));console.log('U45_BROWSER_READY '+JSON.stringify(info));
  await until(()=>fs.existsSync(path.join(evidence,'browser-result.json')),720000);const proof=JSON.parse(fs.readFileSync(path.join(evidence,'browser-result.json'),'utf8'));assert.equal(proof.nativeClicks,true);assert.equal(proof.cancelledWithoutSubmit,true);assert.equal(proof.confirmedOriginalPlan,true);assert.equal(proof.candidateReadOnly,true);assert.equal(proof.scriptExecuted,false);assert.ok(proof.screenshotSha256);
  const after=await c.call('observe');assert.equal(after.auth.status,'SCHEDULED');assert.deepEqual(after.auth.input,beforeBrowser.auth.input);assert.equal(after.auth.completedCaptures,beforeBrowser.auth.completedCaptures);assert.equal(after.dataReads,beforeBrowser.dataReads);assert.deepEqual(after.workspace,beforeBrowser.workspace);assert.equal(after.identityCalls,beforeBrowser.identityCalls+1);assert.equal(after.requests.filter(v=>v.method==='POST'&&v.url.endsWith('/resume')&&v.status===200).length,1);assert.equal(after.providers,0);assert.equal(after.executions,0);assert.equal(after.attempts,0);assert.equal(after.forbiddenModelCalls,0);fs.writeFileSync(path.join(evidence,'browser-business-state.json'),JSON.stringify({before:beforeBrowser,after},null,2));
 });
 assert.ok(results.every(r=>r.passed));await c.stop();assert.ok(children.every(c=>c.closed&&c.code===0));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code})),database:'ACTUAL_NEW_SQLITE_PRISMA',http:'ACTUAL_ORIGINAL_SERVER_AND_WORKBENCH',browser:'NATIVE_TABBIT_CLICKS',backend:'FIXED_LOCAL_OPERATIONS_AND_CREATIVE_RESPONSES',actualModelCalls:0,actualCost:'UNKNOWN',audio:'NOT_OBSERVED',realPlatformE2E:'NOT_RUN',realU3Editor:'BLOCKED_PRESERVED',realU5Adoption:'NOT_PERFORMED',selectedModelPreserved:'aihubmix/deepseek-v4.1-flash'},null,2));
});
