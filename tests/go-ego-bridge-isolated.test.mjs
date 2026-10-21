import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {root,isolatedEnvironment,confined} from '../scripts/isolation-policy.mjs';

const session=process.env.PVS_GO_TEST_SESSION;confined(session,path.join(root,'.runtime'));
const evidence=path.join(session,'evidence'),egoRoot=process.env.PVS_GO_TEST_EGO_ROOT;
const hostRoot=path.join(egoRoot,'package/ego-browser-windows'),binary=process.env.PVS_GO_TEST_BINARY;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminal=new Set(['succeeded','cancelled','timed_out','failed']);
async function until(predicate,description,ms=15000){const started=Date.now();while(!predicate()){if(Date.now()-started>ms)throw Error('TIMEOUT: '+description);await sleep(30);}return predicate();}
function child(executable,args,options={}){
 const p=spawn(executable,args,{cwd:root,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe'],...options});
 const state={p,events:[],stdout:'',stderr:'',closed:false,code:null};
 p.stdout.on('data',b=>state.stdout+=b);p.stderr.on('data',b=>state.stderr+=b);
 p.once('error',e=>{state.stderr+=e.code;state.closed=true;});p.once('close',(code,signal)=>{Object.assign(state,{closed:true,code,signal});});
 const lines=createInterface({input:p.stdout});lines.on('line',line=>{try{state.events.push(JSON.parse(line));}catch{}});
 state.send=value=>p.stdin.write(JSON.stringify(value)+'\n');return state;
}
test('Go bridge against a fresh instance of the existing Ego host and original business gates',{timeout:900000},async t=>{
 const nonce=randomUUID(),requests=[];let fixtureTicks=0,host,bridge,business,lifecycle;
 const server=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url});if(req.method!=='GET'||req.url!=='/bridge-fixture/'+nonce){res.writeHead(404).end();return;}
  fixtureTicks++;res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'");
  res.end(`<!doctype html><html lang="zh-CN"><meta name="pvs-go-fixture" content="${nonce}"><title>PVS Go 本地只读验证</title><body data-tick="0"><h1>仅本地合成观察，不连接平台或模型</h1><script>let tick=0;setInterval(()=>document.body.dataset.tick=String(++tick),50);</script></body></html>`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const hostEntry=path.join(session,'host-bootstrap.mjs'),stop=path.join(session,'stop-owned-host');
 fs.writeFileSync(hostEntry,`import {app} from 'electron';import fs from 'node:fs';
 app.on('session-created',s=>s.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);const allow=['file:','data:','about:','devtools:'].includes(u.protocol)||u.origin===${JSON.stringify(origin)};if(!allow)console.log('PVS_BLOCKED_NETWORK '+u.protocol+'//'+u.hostname);cb({cancel:!allow});}));
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(timer);app.quit();}},100);
 await import(${JSON.stringify(pathToFileURL(path.join(hostRoot,'src/main.mjs')).href)});`);
 const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{EGO_WINDOWS_DATA_DIR:path.join(session,'host'),PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,LOCALAPPDATA:path.join(session,'home/local'),APPDATA:path.join(session,'home/roaming'),TEMP:session,TMP:session});
 const all=[];
 async function closeHost(){if(!host?.closed){fs.writeFileSync(stop,'owned test host only');await until(()=>host.closed,'owned host exit');}assert.equal(host.code,0,host.stderr);}
 t.after(async()=>{
  for(const p of [lifecycle,business,bridge])if(p&&!p.closed){p.p.stdin.end();await until(()=>p.closed,'owned child exit').catch(()=>p.p.kill());}
  await closeHost().catch(()=>host?.p.kill());server.close();
  for(const [name,p] of [['host',host],['bridge',bridge],['business',business],['lifecycle',lifecycle]])if(p){fs.writeFileSync(path.join(evidence,name+'-stdout.log'),p.stdout);fs.writeFileSync(path.join(evidence,name+'-stderr.log'),p.stderr);fs.writeFileSync(path.join(evidence,name+'-exit.json'),JSON.stringify({pid:p.p.pid,closed:p.closed,code:p.code,signal:p.signal}));}
  fs.writeFileSync(path.join(evidence,'events.json'),JSON.stringify(all.length?all:bridge?.events??[],null,2));fs.writeFileSync(path.join(evidence,'fixture-http.json'),JSON.stringify({requests,fixtureTicks},null,2));
  if(host)assert.equal(host.code,0,'Owned host must exit cleanly; keep nonzero failures');
 });
 host=child(path.join(hostRoot,'node_modules/electron/dist/electron.exe'),[hostEntry,'--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],{env});
 await until(()=>host.stdout.includes('EGO_WINDOWS_HOST_READY')||host.closed,'fresh Ego host ready',30000);assert.equal(host.closed,false,host.stderr);
 const info=JSON.parse(fs.readFileSync(path.join(session,'host/host-instance.json'),'utf8'));
 const cfg={contract:'pvs-go-ego-local-v1',session,node:process.execPath,nodeSha256:digest(process.execPath),cli:path.join(hostRoot,'src/cli.mjs'),cliSha256:digest(path.join(hostRoot,'src/cli.mjs')),sdk:path.join(egoRoot,'package/ego-browser/dist/out/index.js'),sdkSha256:digest(path.join(egoRoot,'package/ego-browser/dist/out/index.js')),dataDir:path.join(session,'host'),instanceId:'windows-host:'+info.instanceId,origin,nonce};
 const configFile=path.join(session,'config.json');fs.writeFileSync(configFile,JSON.stringify(cfg,null,2));
 bridge=child(binary,['--config',configFile]);await until(()=>bridge.events.some(e=>e.type==='ready')||bridge.closed,'Go ready');assert.equal(bridge.closed,false,bridge.stderr);
 const scope={projectId:'synthetic-project',cycleId:'synthetic-cycle',actionId:'synthetic-action',contextHash:'a'.repeat(64)};
 const start=(id,mode='probe',timeoutMs=10000)=>bridge.send({op:'start',id,mode,timeoutMs,scope});
 const ended=id=>until(()=>bridge.events.find(e=>e.id===id&&terminal.has(e.type))||bridge.closed,'terminal '+id).then(e=>{assert.equal(bridge.closed,false,bridge.stderr);return e;});
 const results=[];const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 const noLate=async id=>{const before=bridge.events.filter(e=>e.id===id).length;await sleep(350);assert.equal(bridge.events.filter(e=>e.id===id).length,before);};
 await check('pinned Go -> original Node CLI/SDK -> fresh Ego host connects and returns correlated events',async()=>{start('probe');const end=await ended('probe');assert.equal(end.type,'succeeded',JSON.stringify(bridge.events));assert.equal(end.scope.contextHash,scope.contextHash);assert.equal(bridge.events.find(e=>e.id==='probe'&&e.type==='connected').data.instanceId,cfg.instanceId);});
 await check('real browser observations stream; cancellation waits for worker exit and stops further events',async()=>{start('cancel','observe');await until(()=>bridge.events.filter(e=>e.id==='cancel'&&e.type==='sample').length>=2||bridge.events.some(e=>e.id==='cancel'&&terminal.has(e.type)),'browser samples');assert.ok(bridge.events.some(e=>e.id==='cancel'&&e.type==='sample'),JSON.stringify(bridge.events));bridge.send({op:'cancel',id:'cancel'});const end=await ended('cancel');assert.equal(end.type,'cancelled');assert.equal(end.data.workerExited,true);await noLate('cancel');});
 await check('bounded deadline produces one timed_out terminal event without retry',async()=>{start('deadline','observe',1800);const end=await ended('deadline');assert.equal(end.type,'timed_out');assert.equal(end.data.workerExited,true);assert.equal(bridge.events.filter(e=>e.id==='deadline'&&e.type==='started').length,1);await noLate('deadline');});
 await check('unknown operations/scripts, excess deadlines, duplicates and concurrent jobs are denied',async()=>{
  bridge.send({op:'publish',id:'forbidden'});bridge.send({op:'start',id:'script',mode:'probe',timeoutMs:1000,scope,script:'anything'});start('over-limit','probe',10001);start('probe');
  await until(()=>bridge.events.some(e=>e.id==='probe'&&e.code==='DUPLICATE_ID')&&bridge.events.some(e=>e.id==='forbidden'&&e.code==='OPERATION_DENIED')&&bridge.events.some(e=>e.id==='over-limit'&&e.code==='REQUEST_DENIED')&&bridge.events.some(e=>e.code==='INVALID_REQUEST'),'specific denials');
  start('busy','observe');await until(()=>bridge.events.some(e=>e.id==='busy'&&e.type==='sample'),'busy sample');start('second');await until(()=>bridge.events.some(e=>e.id==='second'&&e.code==='BUSY'),'capacity refusal');bridge.send({op:'cancel',id:'busy'});assert.equal((await ended('busy')).type,'cancelled');
 });
 await check('original AgentCycle confirmation/revision/context/cancellation and idempotency gate actual Go execution',async()=>{
  const businessSession=path.join(root,'.runtime/isolation-sessions','go-business-'+randomUUID());for(const dir of ['projects','home/local','home/roaming','tmp'])fs.mkdirSync(path.join(businessSession,dir),{recursive:true});
  const businessEnv=isolatedEnvironment({PVS_ISOLATION_SESSION:businessSession,DATABASE_URL:'file:'+path.join(businessSession,'blank.db').replaceAll('\\','/'),PROJECTS_ROOT:path.join(businessSession,'projects')});
  business=child(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-bridge-business-fixture.js')],{env:businessEnv});
  await until(()=>business.events.some(e=>e.bridgeRequest)||business.closed,'business request');assert.equal(business.closed,false,business.stderr);
  const r=business.events.find(e=>e.bridgeRequest).bridgeRequest;bridge.send({op:'start',...r,timeoutMs:10000});const end=await ended(r.id);business.send(end);
  await until(()=>business.closed,'business fixture exit');assert.equal(business.code,0,business.stderr);assert.equal(business.events.at(-1).businessResult.confirmedActualBridgeCalls,1);assert.equal(business.events.at(-1).businessResult.modelCalls,0);
 });
 await check('guarded lifecycle HTTP/UI preserves live leases and cancels only the owned read-only worker',async()=>{
  const lifecycleSession=path.join(root,'.runtime/isolation-sessions','go-lifecycle-'+randomUUID());
  for(const dir of ['projects','evidence','home/local','home/roaming','tmp'])fs.mkdirSync(path.join(lifecycleSession,dir),{recursive:true});
  const lifecycleEnv=isolatedEnvironment({PVS_ISOLATION_SESSION:lifecycleSession,DATABASE_URL:'file:'+path.join(lifecycleSession,'blank.db').replaceAll('\\','/'),PROJECTS_ROOT:path.join(lifecycleSession,'projects')});
  lifecycle=child(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-bridge-lifecycle-fixture.js')],{env:lifecycleEnv});
  let sent=0,received=bridge.events.length;const activeIds=new Set();
  const relay=setInterval(()=>{
   for(const e of lifecycle.events.slice(sent)){if(e.bridgeRequest){activeIds.add(e.bridgeRequest.id);bridge.send(e.bridgeRequest);}if(e.bridgeCancel)bridge.send(e.bridgeCancel);}
   sent=lifecycle.events.length;
   for(const e of bridge.events.slice(received))if(activeIds.has(e.id))lifecycle.send(e);
   received=bridge.events.length;
  },10);
  try {
   await until(()=>lifecycle.events.find(e=>e.lifecycleReady)||lifecycle.closed,'lifecycle ready');assert.equal(lifecycle.closed,false,lifecycle.stderr);
   const ready=lifecycle.events.find(e=>e.lifecycleReady).lifecycleReady;
   fs.writeFileSync(path.join(root,'.runtime/go-lifecycle-active.json'),JSON.stringify({...ready,transportEvidence:evidence},null,2));
   console.log('PVS_GO_LIFECYCLE_BROWSER_READY '+ready.origin+'/projects/'+ready.projectId+'/agent-cycle');
   const browserFile=path.join(lifecycleSession,'evidence/browser-result.json');
   // Browser control writes its receipt after the fixture's finish HTTP response;
   // a clean child exit can precede that file. It is not an absent-receipt failure.
   await until(()=>fs.existsSync(browserFile)||(lifecycle.closed&&lifecycle.code!==0),'native browser completion',720000);
   assert.ok(fs.existsSync(browserFile),lifecycle.stderr);const browser=JSON.parse(fs.readFileSync(browserFile,'utf8'));
   assert.equal(browser.status,'PASS');assert.equal(browser.actualBrowserClicks,true);
   // The guarded fixture has finished all actions and HTTP work. Close its
   // parent-owned input pipe explicitly before waiting for process teardown.
   lifecycle.send({fixtureClose:true});lifecycle.p.stdin.end();
   await until(()=>lifecycle.closed,'lifecycle fixture exit');assert.equal(lifecycle.code,0,lifecycle.stderr);
   const receipt=JSON.parse(fs.readFileSync(path.join(lifecycleSession,'evidence/lifecycle-result.json'),'utf8'));
   assert.equal(receipt.bridgeCalls,3);assert.equal(receipt.cancelRequests,1);assert.equal(receipt.modelCalls,0);
   assert.ok(receipt.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/advance')).length===3);
   assert.ok(receipt.requests.some(r=>r.method==='POST'&&r.url.endsWith('/cancel')));
   for(const id of activeIds){assert.equal(bridge.events.filter(e=>e.id===id&&terminal.has(e.type)).length,1);await noLate(id);}
   fs.writeFileSync(path.join(evidence,'lifecycle-summary.json'),JSON.stringify({session:lifecycleSession,browser,checks:receipt.checks,bridgeCalls:3,cancelRequests:1,modelCalls:0},null,2));
  } finally {clearInterval(relay);}
 });
 await check('changed binary pins and mismatched host instance fail closed at startup',async()=>{
  for(const patch of [{nodeSha256:'0'.repeat(64)},{instanceId:'windows-host:stale'}]){const file=path.join(session,'invalid-'+randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify({...cfg,...patch}));const invalid=child(binary,['--config',file]);await until(()=>invalid.closed,'invalid config exit');assert.equal(invalid.code,2);assert.equal(invalid.events.length,0);assert.match(invalid.stderr,/PIN_CHANGED|HOST_BINDING_REQUIRED/);}
 });
 await check('input EOF cancels active work; host disconnect cannot auto-restart or resubmit',async()=>{
  start('eof','observe');await until(()=>bridge.events.some(e=>e.id==='eof'&&e.type==='sample'),'EOF sample');bridge.p.stdin.end();await until(()=>bridge.closed,'bridge EOF exit');assert.equal(bridge.code,0);assert.equal(bridge.events.filter(e=>e.id==='eof'&&terminal.has(e.type)).length,1);assert.equal(bridge.events.find(e=>e.id==='eof'&&terminal.has(e.type)).type,'cancelled');all.push(...bridge.events);
  bridge=child(binary,['--config',configFile]);await until(()=>bridge.events.some(e=>e.type==='ready'),'new transport only');await closeHost();start('disconnected','probe',3000);assert.equal((await ended('disconnected')).type,'failed');assert.equal(bridge.events.filter(e=>e.id==='disconnected'&&e.type==='started').length,1);bridge.p.stdin.end();await until(()=>bridge.closed,'final bridge exit');assert.equal(bridge.code,0);all.push(...bridge.events);
 });
 assert.ok(requests.length>=3);assert.ok(requests.every(r=>r.method==='GET'&&r.url==='/bridge-fixture/'+nonce));
 for(const stream of [all.slice(0,all.findIndex((e,i)=>i&&e.sequence===1)),all.slice(all.findIndex((e,i)=>i&&e.sequence===1))])if(stream.length)assert.deepEqual(stream.map(e=>e.sequence),Array.from({length:stream.length},(_,i)=>i+1));
 assert.ok(results.every(r=>r.passed),'Failed subtests cannot emit a qualification candidate');
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',hostReuse:'Existing unmodified Electron/Chromium implementation; fresh isolated instance/profile',businessGate:business.events.at(-1).businessResult,events:all.length,fixtureRequests:requests.length,u3RealEditor:'BLOCKED_PRESERVED',productionWiring:false,activeBusinessUICancelWiring:'FIXTURE_ONLY',remoteRollbackClaim:false,modelCalls:0,materialEgress:0,realUpload:0,paidGeneration:0,publication:0,commentReplies:0,deploy3090:false,restart3090:false,pass:results.length+1,fail:0},null,2));
});
