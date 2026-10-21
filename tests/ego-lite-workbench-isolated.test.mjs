import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startWorkbench} from '../scripts/ego-lite-supervisor.mjs';
import {loadInstallation,installationFile} from '../scripts/ego-lite-installation.mjs';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_EGO_LITE_TEST_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,test,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(test(value))return value;await pause(10);}throw Error('TIMEOUT '+label);}
test('actual local Ego host is reached through the default guarded workbench and exact Agent authorization',{timeout:180000},async t=>{
  const results=[],receipts=[],database=path.join(session,'blank.db'),db=new DatabaseSync(database);let workbench,project,cycle,proof,stale;
  for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const sql=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(sql))db.exec(fs.readFileSync(sql,'utf8'));}
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects'),PORT:String(port)});
  const open=async()=>workbench=await startWorkbench({env});
  const stop=async()=>{if(workbench){const receipt=await workbench.stop();receipts.push(receipt);fs.writeFileSync(path.join(session,'evidence/supervisor-'+receipts.length+'.json'),JSON.stringify({receipt,stderr:workbench.application.stderr},null,2));workbench=undefined;assert.ok(receipt.children.every(c=>c.closed&&c.code===0));}};
  t.after(async()=>{try{await stop();}finally{db.close();}});
  const request=async(method,url,body)=>{const r=await fetch(workbench.origin+url,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const text=await r.text();let value;try{value=JSON.parse(text);}catch{}return {status:r.status,text,value};};
  const post=async(url,body)=>{const r=await request('POST',url,body);assert.equal(r.status,200,r.text);return r.value.result;};
  const base=()=>'/api/projects/'+project.id+'/agent-cycles';
  const prepare=async(goal)=>{let c=await post(base(),{goal,requestKey:randomUUID(),stages:['RESEARCH']});return post(base()+'/'+c.id+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal,sourceUrls:[{url:workbench.sourceUrl,sourceType:'USER_URL'}]},requestKey:randomUUID()});};
  const confirm=async c=>post(base()+'/'+c.id+'/confirm',{expectedRevision:c.revision,actionId:c.actions[0].id,inputHash:c.actions[0].inputHash});
  const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});assert.ok(passed,name);};
  await check('pinned installation refuses changed source and starts the same default factory without a host',async()=>{
    const copy=JSON.parse(fs.readFileSync(installationFile,'utf8'));copy.pins[0].sha256='0'.repeat(64);const file=path.join(session,'bad-pins.json');fs.writeFileSync(file,JSON.stringify(copy));assert.throws(()=>loadInstallation(file),/PIN_CHANGED/);
    await open();assert.equal((await request('GET','/health')).status,200);assert.equal(fs.readdirSync(workbench.session).length,0);
    project=(await request('POST','/api/projects',{name:'Ego Lite synthetic workbench',targetDurationMs:15000})).value.project;assert.ok(project.id);
    const page=await request('GET','/projects/'+project.id+'/agent-cycle');assert.ok(page.text.includes('准备本机页面采集'));assert.ok(page.text.includes(workbench.sourceUrl));
    const fixture=await request('GET',new URL(workbench.sourceUrl).pathname);assert.ok(fixture.text.includes('data-pvs-research-document'));assert.equal((await request('GET',new URL(workbench.sourceUrl).pathname+'?extra=1')).status,404);
  });
  await check('external or unbound sources and stale confirmation cannot start an executor',async()=>{
    cycle=await prepare('Collect only the current owned synthetic page');
    assert.equal(cycle.status,'WAITING_CONFIRMATION');await post(base()+'/'+cycle.id+'/advance',{});assert.equal(workbench.events.length,0);assert.equal(fs.readdirSync(workbench.session).length,0);
    const a=cycle.actions[0],bad=await request('POST',base()+'/'+cycle.id+'/confirm',{expectedRevision:cycle.revision+1,actionId:a.id,inputHash:a.inputHash});assert.equal(bad.status,400);
    const other=await post(base(),{goal:'Reject sources outside this local fixture',requestKey:randomUUID(),stages:['RESEARCH']});
    for(const url of ['https://example.invalid/denied',workbench.origin+'/bridge-fixture/other',workbench.sourceUrl+'?extra=1'])assert.equal((await request('POST',base()+'/'+other.id+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal:'Do not execute unbound source',sourceUrls:[{url,sourceType:'USER_URL'}]},requestKey:randomUUID()})).status,400);
    assert.equal(workbench.events.length,0);
  });
  await check('exact confirmation reads dynamic DOM and real PNG through Go CLI SDK and original ResearchService',async()=>{
    cycle=await confirm(cycle);assert.equal(workbench.events.length,0);
    cycle=await post(base()+'/'+cycle.id+'/advance',{});const a=cycle.actions[0];assert.equal(cycle.status,'WAITING_USER',JSON.stringify(a));assert.equal(a.localExecution.phase,'SUCCEEDED',JSON.stringify(a));assert.equal(a.localExecution.workerExited,true);assert.equal(a.status,'SUCCEEDED');
    const row=db.prepare('SELECT * FROM ResearchEvidenceRecord WHERE projectId=?').get(project.id);assert.ok(row);assert.ok(row.excerpt.includes('内容不是商品事实'));proof=JSON.parse(row.mediaContextJson).sourceCapture;assert.equal(proof.provider,'ego-browser-research');
    for(const [id,sha] of [[proof.documentArtifactId,proof.documentSha256],[proof.screenshotArtifactId,proof.screenshotSha256]]){const artifact=db.prepare('SELECT * FROM ArtifactRecord WHERE id=?').get(id);assert.equal(artifact.projectId,project.id);const bytes=fs.readFileSync(path.join(session,'projects',project.id,artifact.relativePath));assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);if(artifact.mimeType==='image/png'){assert.ok(bytes.length>1000);assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);}}
    assert.ok(workbench.events.some(e=>e.type==='screenshot'));assert.equal(workbench.events.filter(e=>e.type==='succeeded').length,3);assert.ok(workbench.events.filter(e=>e.workerExited!==undefined).every(e=>e.workerExited===true));
    const count=workbench.events.length;await post(base()+'/'+cycle.id+'/advance',{});assert.equal(workbench.events.length,count);
    const research=await request('GET','/projects/'+project.id+'/research');assert.ok(research.text.includes('Ego Lite 本机合成页面'));
  });
  await check('original Agent cancellation reaches an actual Go worker and waits for owned child exits',async()=>{
    let c=await confirm(await prepare('Cancel this separate local capture'));const before=workbench.events.length;
    const advancing=post(base()+'/'+c.id+'/advance',{});
    await until(()=>workbench.events.slice(before),events=>events.some(e=>e.type==='started'),'actual worker started');
    c=(await request('GET',base()+'/'+c.id)).value.result;assert.equal(c.status,'RUNNING');
    await post(base()+'/'+c.id+'/cancel',{expectedRevision:c.revision});c=await advancing;
    assert.equal(c.status,'CANCELLED',JSON.stringify(c.actions[0]));assert.equal(c.actions[0].localExecution.phase,'CANCELLED');assert.equal(c.actions[0].localExecution.workerExited,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchEvidenceRecord WHERE projectId=?').get(project.id).n,1);
    assert.ok(workbench.events.slice(before).some(e=>e.type==='cancelled'&&e.workerExited));
  });
  await check('a competing confirmed action cannot stop or reuse the active action host',async()=>{
    const first=await confirm(await prepare('Read one local page under the first action'));
    const second=await confirm(await prepare('Competing read must remain bounded to its own action'));
    const before=workbench.events.length,advancing=post(base()+'/'+first.id+'/advance',{});
    await until(()=>workbench.events.slice(before),events=>events.some(e=>e.type==='started'),'first action worker started');
    const rejected=await post(base()+'/'+second.id+'/advance',{});assert.equal(rejected.status,'BLOCKED');assert.equal(rejected.actions[0].localExecution.phase,'FAILED');assert.equal(rejected.actions[0].localExecution.workerExited,true);
    const done=await advancing;assert.equal(done.status,'WAITING_USER',JSON.stringify(done.actions[0]));assert.equal(done.actions[0].localExecution.phase,'SUCCEEDED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchEvidenceRecord WHERE projectId=?').get(project.id).n,2);
  });
  await check('application restart keeps saved artifacts but expires an old fixture proposal without opening a host',async()=>{
    stale=await prepare('This proposal belongs to the previous application start');const previousSource=workbench.sourceUrl;await stop();await open();assert.notEqual(workbench.sourceUrl,previousSource);
    const a=stale.actions[0],r=await request('POST',base()+'/'+stale.id+'/confirm',{expectedRevision:stale.revision,actionId:a.id,inputHash:a.inputHash});assert.equal(r.status,400,r.text);assert.ok(r.text.includes('状态已变化'));
    assert.equal(workbench.events.length,0);assert.equal(fs.readdirSync(workbench.session).length,0);
    const artifact=await request('GET','/api/artifacts/'+encodeURIComponent(proof.screenshotArtifactId)+'/content');assert.equal(artifact.status,200);
    assert.ok((await request('GET','/projects/'+project.id+'/agent-cycle')).text.includes('工作进程退出已确认'));
  });
  for(const table of ['AiProviderConfigRecord','AiExecutionRecord','GenerationRequestRecord','GenerationAttemptRecord'])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  await stop();fs.writeFileSync(path.join(session,'evidence/assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,receipts,source:'ACTUAL_GO_CLI_SDK_HOST_DYNAMIC_DOM_PNG',database:'NEW_SQLITE_ACTUAL_PRISMA',ui:'HTTP_AND_RENDERED_HTML_ONLY',nativeClicks:'NOT_RUN',modelCalls:0,platformCalls:0,defaultWiring:true,platformE2E:'NOT_RUN'},null,2));
});
