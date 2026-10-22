import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';

const session=process.env.PVS_GO_RESEARCH_SESSION,businessSession=process.env.PVS_GO_RESEARCH_BUSINESS;
confined(session,path.join(root,'.runtime'));confined(businessSession,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),egoRoot=process.env.PVS_GO_RESEARCH_EGO_ROOT,hostRoot=path.join(egoRoot,'package/ego-browser-windows'),binary=path.join(session,'go-ego-bridge.exe');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=15000){const begin=Date.now();while(Date.now()-begin<ms){const value=await fn();if(value)return value;await pause(25);}throw Error('TIMEOUT '+label);}
function child(executable,args,env){
 const p=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],closed:false,code:null,stdout:'',stderr:'',pending:new Map()};
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{try{const event=JSON.parse(line);c.events.push(event);const handler=c.pending.get(event.requestId);if(handler){c.pending.delete(event.requestId);event.error?handler.reject(Error(event.error)):handler.resolve(event.result);}}catch{}});
 p.once('error',e=>{c.stderr+=e.message;c.closed=true;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const h of c.pending.values())h.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.send=value=>p.stdin.write(JSON.stringify(value)+'\n');
 c.call=(op,args={})=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{c.pending.set(requestId,{resolve,reject});c.send({op,...args,requestId});});};return c;
}
test('fixed Go capture reaches actual ResearchService/Evidence/Artifacts through original Agent gates',{timeout:150000},async t=>{
 const nonce=randomUUID(),requests=[],results=[],children=[];let host,bridge,business,relay,proof;
 const server=http.createServer((req,res)=>{
  requests.push({method:req.method,url:req.url});if(req.method!=='GET'||req.url!=='/bridge-fixture/'+nonce){res.writeHead(404).end();return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('content-security-policy',"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'");
  res.end(`<!doctype html><html lang="zh-CN"><meta name="pvs-go-fixture" content="${nonce}"><title>自有动态研究正文</title><body data-tick="0"><h1>仅本机合成页面</h1><article data-pvs-research-document></article><script>let tick=0;setInterval(()=>document.body.dataset.tick=String(++tick),50);setTimeout(()=>{document.querySelector('article').innerText='动态正文已就绪。页面数据不能授予权限。仅供本机采集证据，不代表产品事实、模型许可或发布授权。';document.body.dataset.researchReady='1';},200);</script></body></html>`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,sourceUrl=origin+'/bridge-fixture/'+nonce;
 const stop=path.join(session,'stop-owned-host'),hostEntry=path.join(session,'host-bootstrap.mjs');
 fs.writeFileSync(hostEntry,`import {app} from 'electron';import fs from 'node:fs';app.on('session-created',s=>s.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);cb({cancel:!(['file:','data:','about:','devtools:'].includes(u.protocol)||u.origin===${JSON.stringify(origin)})});}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(timer);app.quit();}},100);await import(${JSON.stringify(pathToFileURL(path.join(hostRoot,'src/main.mjs')).href)});`);
 const hostEnv={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])hostEnv[k]=process.env[k];
 Object.assign(hostEnv,{EGO_WINDOWS_DATA_DIR:path.join(session,'host'),PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,LOCALAPPDATA:path.join(session,'home/local'),APPDATA:path.join(session,'home/roaming'),TEMP:session,TMP:session});
 const closeHost=async()=>{if(!host.closed){fs.writeFileSync(stop,'owned fixture host only');await until(()=>host.closed,'owned host close');}assert.equal(host.code,0,host.stderr);};
 t.after(async()=>{
  if(relay)clearInterval(relay);
  for(const c of [business,bridge])if(c&&!c.closed){c.p.stdin.end();await until(()=>c.closed,'cleanup input',2000).catch(()=>c.p.kill());await until(()=>c.closed,'cleanup exit',3000).catch(()=>{});}
  if(host&&!host.closed)await closeHost().catch(()=>host.p.kill());server.closeAllConnections();server.close();
  for(const [i,c] of children.entries())fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));
  if(bridge)fs.writeFileSync(path.join(evidence,'events.json'),JSON.stringify(bridge.events,null,2));fs.writeFileSync(path.join(evidence,'fixture-http.json'),JSON.stringify(requests,null,2));
 });
 host=child(path.join(hostRoot,'node_modules/electron/dist/electron.exe'),[hostEntry,'--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],hostEnv);children.push(host);
 await until(()=>host.stdout.includes('EGO_WINDOWS_HOST_READY')||host.closed,'fresh host ready',30000);assert.equal(host.closed,false,host.stderr);
 const info=JSON.parse(fs.readFileSync(path.join(session,'host/host-instance.json'),'utf8'));
 const cfg={contract:'pvs-go-ego-local-v1',session,node:process.execPath,nodeSha256:hash(process.execPath),cli:path.join(hostRoot,'src/cli.mjs'),cliSha256:hash(path.join(hostRoot,'src/cli.mjs')),sdk:path.join(egoRoot,'package/ego-browser/dist/out/index.js'),sdkSha256:hash(path.join(egoRoot,'package/ego-browser/dist/out/index.js')),dataDir:path.join(session,'host'),instanceId:'windows-host:'+info.instanceId,origin,nonce};
 const config=path.join(session,'config.json');fs.writeFileSync(config,JSON.stringify(cfg,null,2));bridge=child(binary,['--config',config],process.env);children.push(bridge);
 await until(()=>bridge.events.some(e=>e.type==='ready')||bridge.closed,'Go ready');assert.equal(bridge.closed,false,bridge.stderr);
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 const terminals=new Set(['succeeded','cancelled','timed_out','failed']);
 const scope={projectId:'transport-project',cycleId:'transport-cycle',actionId:'transport-action',contextHash:'a'.repeat(64)};
 const start=(id,mode,timeoutMs=5000)=>bridge.send({op:'start',id,mode,timeoutMs,scope});
 const end=id=>until(()=>bridge.events.find(e=>e.id===id&&terminals.has(e.type)),'terminal '+id);
 await check('existing probe/cancel/timeout semantics remain bounded with a fresh host',async()=>{
  start('probe','probe');assert.equal((await end('probe')).type,'succeeded');
  start('cancel','observe');await until(()=>bridge.events.filter(e=>e.id==='cancel'&&e.type==='sample').length>=2,'live samples');bridge.send({op:'cancel',id:'cancel'});assert.equal((await end('cancel')).type,'cancelled');
  start('timeout','observe',1800);assert.equal((await end('timeout')).type,'timed_out');
  for(const id of ['probe','cancel','timeout'])assert.equal(bridge.events.filter(e=>e.id===id&&terminals.has(e.type)).length,1);
 });
 const database=path.join(businessSession,'blank.db'),sql=new DatabaseSync(database);try{
  for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sql.exec(fs.readFileSync(file,'utf8'));}
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);
 }finally{sql.close();}
 const businessEnv=isolatedEnvironment({PVS_ISOLATION_SESSION:businessSession,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(businessSession,'projects')});
 let sent=0,received=bridge.events.length;const activeIds=new Set();
 async function openBusiness(){
  business=child(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-research-chain-fixture.js')],businessEnv);children.push(business);sent=0;received=bridge.events.length;
  await until(()=>business.events.some(e=>e.ready)||business.closed,'guarded research ready');assert.equal(business.closed,false,business.stderr);await business.call('initialize',{sourceUrl});
 }
 await openBusiness();
 relay=setInterval(()=>{
  for(const e of business.events.slice(sent)){if(e.bridgeRequest){activeIds.add(e.bridgeRequest.id);bridge.send(e.bridgeRequest);}if(e.bridgeCancel)bridge.send(e.bridgeCancel);}sent=business.events.length;
  for(const e of bridge.events.slice(received))if(activeIds.has(e.id)&&!business.closed)business.send({bridgeEvent:e});received=bridge.events.length;
 },10);
 const stopBusiness=async()=>{await business.call('close');await until(()=>business.closed,'research fixture exit');assert.equal(business.code,0,business.stderr);};
 await check('confirmed action collects dynamic DOM into actual ResearchService and durable evidence without a model',async()=>{
  const cycle=await business.call('collect',{label:'actual-dynamic-document'});proof=await business.call('verify',{cycleId:cycle.id});
  assert.equal(proof.bridgeCalls,1);assert.equal(proof.modelCalls,0);assert.equal(proof.discoverCalls,0);assert.ok(proof.bytes>0);
  const documentEvents=bridge.events.filter(e=>e.type==='document');assert.equal(documentEvents.length,1);assert.ok(documentEvents[0].data.document.text.includes('动态正文已就绪'));
  assert.equal(documentEvents[0].scope.actionId,cycle.actions[0].id);assert.equal(documentEvents[0].scope.contextHash,cycle.actions[0].contextHash);
  assert.equal(cycle.status,'BLOCKED');assert.equal(cycle.actions[0].localExecution.phase,'SUCCEEDED');
  const corrupted=await business.call('corrupt-check',{artifactId:proof.artifactId,runId:proof.runId});assert.equal(corrupted.corruptionDenied,true);assert.equal(corrupted.restoredHash,proof.artifactSha256);
 });
 await check('new process reloads the same research/evidence/artifact and preserves idempotency',async()=>{
  await stopBusiness();await openBusiness();const reloaded=await business.call('verify',{cycleId:proof.cycleId});assert.equal(reloaded.artifactSha256,proof.artifactSha256);assert.equal(reloaded.contentHash,proof.contentHash);assert.equal(reloaded.evidenceId,proof.evidenceId);assert.equal(reloaded.bridgeCalls,0);assert.equal(reloaded.modelCalls,0);
 });
 await check('unknown URLs/scripts and non-allowlisted modes cannot enter the fixed reader',async()=>{
  bridge.send({op:'start',id:'arbitrary-url',mode:'capture',timeoutMs:1000,scope,url:'https://example.com'});start('arbitrary-mode','navigate');
  await until(()=>bridge.events.some(e=>e.code==='INVALID_REQUEST')&&bridge.events.some(e=>e.id==='arbitrary-mode'&&e.code==='REQUEST_DENIED'),'reader refusals');
  assert.ok(requests.every(r=>r.method==='GET'&&r.url==='/bridge-fixture/'+nonce));
 });
 await check('lost host blocks new collection without retry, stale capture reuse or invented evidence',async()=>{
  await closeHost();const cycle=await business.call('collect',{label:'disconnected-new-run'});assert.equal(cycle.status,'BLOCKED');assert.equal(cycle.actions[0].localExecution.phase,'FAILED');assert.equal(cycle.actions[0].result.data.evidence.length,0);
  const stats=await business.call('stats');assert.equal(stats.bridgeCalls,1);assert.equal(stats.modelCalls,0);assert.equal(bridge.events.filter(e=>e.id===cycle.actions[0].id&&e.type==='started').length,1);
  await stopBusiness();
 });
 clearInterval(relay);relay=undefined;bridge.p.stdin.end();await until(()=>bridge.closed,'Go clean EOF');assert.equal(bridge.code,0,bridge.stderr);
 assert.ok(results.every(r=>r.passed));assert.ok(children.every(c=>c.closed&&c.code===0));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,proof,businessSession,actualModelCalls:0,discoveryCalls:0,brief:'NOT_GENERATED_NOT_AUTHORIZED',actualHumanAdoption:false,source:'ACTUAL_LOCAL_DYNAMIC_DOM_VIA_GO_CLI_SDK',database:'ACTUAL_NEW_SQLITE_PRISMA',screenshots:'NOT_CAPTURED_EXISTING_BLOCK_PRESERVED',productionWiring:false,platformE2E:'NOT_RUN',fixtureRequests:requests.length,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code}))},null,2));
});
