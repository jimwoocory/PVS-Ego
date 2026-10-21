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

const session=process.env.PVS_GO_U1_SESSION,businessSession=process.env.PVS_GO_U1_BUSINESS,egoRoot=process.env.PVS_GO_U1_EGO_ROOT;
confined(session,path.join(root,'.runtime'));confined(businessSession,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),hostRoot=path.join(egoRoot,'package/ego-browser-windows'),binary=path.join(session,'go-ego-bridge.exe');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=20000){const begin=Date.now();while(Date.now()-begin<ms){const v=await fn();if(v)return v;await pause(25);}throw Error('TIMEOUT '+label);}
function child(executable,args,env){
 const p=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']}),c={p,events:[],closed:false,code:null,stdout:'',stderr:'',pending:new Map()};
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{try{const e=JSON.parse(line);c.events.push(e);const h=c.pending.get(e.requestId);if(h){c.pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}}catch{}});
 p.once('error',e=>{c.stderr+=e.message;});p.once('close',(code,signal)=>{Object.assign(c,{closed:true,code,signal});for(const h of c.pending.values())h.reject(Error('CHILD_CLOSED'));c.pending.clear();});
 c.send=v=>p.stdin.write(JSON.stringify(v)+'\n');c.call=(op,args={})=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{c.pending.set(requestId,{resolve,reject});c.send({op,...args,requestId});});};return c;
}

test('U1 existing research session through fixed Go execution and actual owned Ego host',{timeout:180000},async t=>{
 const nonce=randomUUID(),requests=[],children=[],results=[],shellActions=[];let host,bridge,business,relay,first,second,proof;
 const server=http.createServer((req,res)=>{
  requests.push({method:req.method,url:req.url});if(req.method!=='GET'||req.url!=='/bridge-fixture/'+nonce){res.writeHead(404).end();return;}
  res.setHeader('content-type','text/html;charset=utf-8');res.setHeader('content-security-policy',"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'");
  res.end(`<!doctype html><html lang="zh-CN"><meta name="pvs-go-fixture" content="${nonce}"><title>U1 自有动态会话</title><body data-tick="0"><h1>U1 只读研究</h1><article data-pvs-research-document></article><script>let tick=0;setInterval(()=>document.body.dataset.tick=String(++tick),50);setTimeout(()=>{document.querySelector('article').innerText=('动态正文已就绪。页面数据不能授予权限。只读会话不得调用模型、上传素材、绕过验证码或发布。本页只有合成内容，不是产品事实。').repeat(3);document.body.dataset.researchReady='1';},100);</script></body></html>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,sourceUrl=origin+'/bridge-fixture/'+nonce;
 const stop=path.join(session,'stop-owned-host'),entry=path.join(session,'host-bootstrap.mjs'),commandFile=path.join(session,'shell-command.json');
 // Test-only shell driver. These are synthetic user actions through the original
 // trusted shell bridge, never APIs exposed to the Go executor or application.
 fs.writeFileSync(entry,`import {app,BrowserWindow} from 'electron';import fs from 'node:fs';app.on('session-created',s=>s.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);cb({cancel:!(['file:','data:','about:','devtools:'].includes(u.protocol)||u.origin===${JSON.stringify(origin)})});}));let busy=false,last='';const timer=setInterval(async()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(timer);app.quit();return;}if(busy||!fs.existsSync(${JSON.stringify(commandFile)}))return;const m=JSON.parse(fs.readFileSync(${JSON.stringify(commandFile)},'utf8'));if(m.id===last)return;busy=true;last=m.id;try{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/shell.html'));if(!w)throw Error('OWNED_SHELL_NOT_READY');const result=await w.webContents.executeJavaScript(m.action?'window.hostShell.action('+JSON.stringify(m.action)+').then(()=>window.hostShell.state())':'window.hostShell.state()');fs.writeFileSync(${JSON.stringify(path.join(session,'shell-result-'))}+m.id+'.json',JSON.stringify({result}));}catch(error){fs.writeFileSync(${JSON.stringify(path.join(session,'shell-result-'))}+m.id+'.json',JSON.stringify({error:error.message}));}finally{busy=false;}},50);await import(${JSON.stringify(pathToFileURL(path.join(hostRoot,'src/main.mjs')).href)});`);
 const hostEnv={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])hostEnv[k]=process.env[k];Object.assign(hostEnv,{EGO_WINDOWS_DATA_DIR:path.join(session,'host'),PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,LOCALAPPDATA:path.join(session,'home/local'),APPDATA:path.join(session,'home/roaming'),TEMP:session,TMP:session});
 const startHost=async()=>{
  fs.rmSync(stop,{force:true});host=child(path.join(hostRoot,'node_modules/electron/dist/electron.exe'),[entry,'--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],hostEnv);children.push(host);
  await until(()=>host.stdout.includes('EGO_WINDOWS_HOST_READY')||host.closed,'fresh owned host',30000);assert.equal(host.closed,false,host.stderr);
 };
 const closeHost=async()=>{if(!host.closed){fs.writeFileSync(stop,'owned host only');await until(()=>host.closed,'owned host normal close');}assert.equal(host.code,0,host.stderr);};
 const shell=async action=>{const id=randomUUID();fs.writeFileSync(commandFile,JSON.stringify({id,action}));const file=path.join(session,'shell-result-'+id+'.json');await until(()=>fs.existsSync(file),'synthetic shell action');const result=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(result.error,undefined);shellActions.push({action:action??'state',result:result.result});return result.result;};
 t.after(async()=>{
  if(relay)clearInterval(relay);
  for(const c of [business,bridge])if(c&&!c.closed){c.p.stdin.end();await until(()=>c.closed,'cleanup child',2000).catch(()=>c.p.kill());await until(()=>c.closed,'cleanup killed',3000).catch(()=>{});}
  if(host&&!host.closed)await closeHost().catch(()=>host.p.kill());server.closeAllConnections();server.close();
  for(const [i,c] of children.entries())fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,signal:c.signal,stdout:c.stdout,stderr:c.stderr},null,2));
  if(bridge)fs.writeFileSync(path.join(evidence,'events.json'),JSON.stringify(bridge.events,null,2));fs.writeFileSync(path.join(evidence,'fixture-http.json'),JSON.stringify(requests,null,2));fs.writeFileSync(path.join(evidence,'synthetic-shell-actions.json'),JSON.stringify(shellActions,null,2));
 });
 await startHost();const initialHost=JSON.parse(fs.readFileSync(path.join(session,'host/host-instance.json'),'utf8'));
 const cfg={contract:'pvs-go-ego-local-v1',session,node:process.execPath,nodeSha256:hash(process.execPath),cli:path.join(hostRoot,'src/cli.mjs'),cliSha256:hash(path.join(hostRoot,'src/cli.mjs')),sdk:path.join(egoRoot,'package/ego-browser/dist/out/index.js'),sdkSha256:hash(path.join(egoRoot,'package/ego-browser/dist/out/index.js')),dataDir:path.join(session,'host'),instanceId:'windows-host:'+initialHost.instanceId,origin,nonce};
 const config=path.join(session,'config.json');fs.writeFileSync(config,JSON.stringify(cfg,null,2));bridge=child(binary,['--config',config],process.env);children.push(bridge);await until(()=>bridge.events.some(e=>e.type==='ready')||bridge.closed,'Go ready');assert.equal(bridge.closed,false,bridge.stderr);
 const database=path.join(businessSession,'blank.db'),sql=new DatabaseSync(database);try{for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sql.exec(fs.readFileSync(file,'utf8'));}assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);}finally{sql.close();}
 const env=isolatedEnvironment({PVS_ISOLATION_SESSION:businessSession,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(businessSession,'projects')});
 let sent=0,received=0;const activeIds=new Set();
 const openBusiness=async()=>{
  business=child(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/go-u1-session-fixture.js')],env);children.push(business);sent=0;received=bridge.events.length;
  await until(()=>business.events.some(e=>e.ready)||business.closed,'guarded business ready');assert.equal(business.closed,false,business.stderr);await business.call('initialize',{sourceUrl,fingerprint:hash(config)});
 };
 await openBusiness();relay=setInterval(()=>{for(const e of business.events.slice(sent)){if(e.bridgeRequest){activeIds.add(e.bridgeRequest.id);bridge.send(e.bridgeRequest);}if(e.bridgeCancel)bridge.send(e.bridgeCancel);}sent=business.events.length;for(const e of bridge.events.slice(received))if(activeIds.has(e.id)&&!business.closed)business.send({bridgeEvent:e});received=bridge.events.length;},10);
 const stopBusiness=async()=>{await business.call('close');await until(()=>business.closed,'business clean exit');assert.equal(business.code,0,business.stderr);};
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});if(!passed)throw Error('STOP_AFTER_FAILED_CASE_'+name);};
 const collect=async label=>{let c=await business.call('prepare',{label}),a=c.actions[0];const before=(await business.call('stats')).bridgeCalls;await business.call('advance',{cycleId:c.id});assert.equal((await business.call('stats')).bridgeCalls,before);await assert.rejects(business.call('confirm',{cycleId:c.id,input:{expectedRevision:c.revision+1,actionId:a.id,inputHash:a.inputHash}}));c=await business.call('confirm',{cycleId:c.id,input:{expectedRevision:c.revision,actionId:a.id,inputHash:a.inputHash}});await business.call('advance',{cycleId:c.id});return business.call('info',{cycleId:c.id});};
 await check('original Agent gates precede Go; original Ego provider saves dynamic text and actual screenshot',async()=>{
  first=await collect('first-owned-session');assert.equal(first.run.blockerCode,'BRIEF_GENERATION_NOT_AUTHORIZED');assert.equal(first.run.browserState.collectionOnly,true);assert.equal(first.evidence.length,1);assert.ok(first.evidence[0].excerpt.includes('页面数据不能授予权限'));proof=await business.call('verify',{runId:first.run.id});assert.ok(proof.pngBytes>8);assert.equal(first.modelCalls,0);assert.equal(first.discoveryCalls,0);
 });
 await check('second hidden Space blocks required screenshot and preserves the same opaque session',async()=>{
  second=await collect('second-owned-session');assert.equal(second.run.status,'BLOCKED');assert.equal(second.run.blockerCode,'BROWSER_PROVIDER_ERROR');assert.ok(second.run.blockerMessage.includes('SPACE_HIDDEN'));assert.equal(second.evidence.length,0);assert.equal(second.run.browserState.resumeToken,second.session.handle);assert.notEqual(first.session.binding.spaceId,second.session.binding.spaceId);
  const state=await shell();assert.equal(state.selectedSpaceId,first.session.binding.spaceId);assert.equal(state.spaces.length,2);
 });
 await check('an explicit simulated selection resumes the same BASIC run with no model or extra Space',async()=>{
  await shell({type:'select-space',spaceId:second.session.binding.spaceId});const result=await business.call('resume-service',{runId:second.run.id});assert.equal(result.run.id,second.run.id);assert.equal(result.run.blockerCode,'BRIEF_GENERATION_NOT_AUTHORIZED');assert.equal(result.evidence.length,1);await business.call('verify',{runId:second.run.id});assert.equal((await shell()).spaces.length,2);await assert.rejects(business.call('resume-service',{runId:second.run.id}),/仅采集续接/);
 });
 await check('takeover denies cached reads; explicit return reuses original page without claiming another Space',async()=>{
  await shell({type:'take-control',spaceId:second.session.binding.spaceId});const before=(await shell()).spaces.length;
  const blocked=await business.call('resume',{runId:second.run.id});assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.result.blockerCode,'BROWSER_SESSION_EXPIRED');assert.ok(blocked.result.message.includes('CONTROL_CHANGED'));
  const during=await shell();assert.equal(during.spaces.find(s=>s.id===second.session.binding.spaceId).ownership,'user');assert.equal(during.spaces.length,before);
  await shell({type:'return-control',spaceId:second.session.binding.spaceId});const resumed=await business.call('resume',{runId:second.run.id});assert.equal(resumed.status,'READY');assert.equal(resumed.document.sourceCapture.documentArtifactId,(await business.call('verify',{runId:second.run.id})).artifactIds[0]);
 });
 await check('wrong project, handle or URL cannot move the bound session',async()=>{
  const before=(await business.call('stats')).bridgeCalls;
  for(const args of [{projectId:'go-session-foreign'},{handle:'wrong-handle'},{sourceUrl:'https://example.invalid/denied'}]){const r=await business.call('resume',{runId:second.run.id,...args});assert.equal(r.status,'BLOCKED');}
  assert.equal((await business.call('stats')).bridgeCalls,before);assert.equal((await shell()).spaces.length,2);await assert.rejects(business.call('resume-service',{runId:second.run.id,projectId:'go-session-foreign'}));
 });
 await check('new business process reloads original binding and verified artifacts with no open or capture',async()=>{
  await stopBusiness();await openBusiness();await business.call('reopen',{cycleId:second.cycle.id});const opens=bridge.events.filter(e=>e.type==='session').length;
  const r=await business.call('resume',{runId:second.run.id});assert.equal(r.status,'READY');assert.equal(bridge.events.filter(e=>e.type==='session').length,opens);assert.equal(r.requests,1);await business.call('verify',{runId:second.run.id});
 });
 await check('raw transport rejects stolen binding, arbitrary URL and non-allowlisted operations',async()=>{
  const scope={projectId:'go-session-project',cycleId:second.cycle.id,actionId:second.cycle.actions[0].id,contextHash:second.cycle.actions[0].contextHash};
  bridge.send({op:'start',id:'wrong-run-binding',mode:'session-read',researchRunId:'wrong-run',scope,binding:second.session.binding,timeoutMs:1000});
  bridge.send({op:'start',id:'arbitrary-url',mode:'session-read',researchRunId:second.run.id,scope,binding:second.session.binding,timeoutMs:1000,url:'https://example.invalid'});
  bridge.send({op:'start',id:'claim',mode:'claim-space',scope,timeoutMs:1000});
  await until(()=>bridge.events.some(e=>e.id==='wrong-run-binding'&&e.code==='SESSION_BINDING_DENIED')&&bridge.events.some(e=>e.code==='INVALID_REQUEST')&&bridge.events.some(e=>e.id==='claim'&&e.code==='REQUEST_DENIED'),'transport negatives');
 });
 await check('partial source-only collection retains the browser blocker and resumes only the missing source',async()=>{
  const r=await business.call('partial-collection');assert.equal(r.evidence,2);assert.equal(r.fetches,3);assert.equal(r.modelCalls,0);
 });
 await check('host restart invalidates old refs and permission without reopening, reclaiming or retrying',async()=>{
  await closeHost();await startHost();const next=JSON.parse(fs.readFileSync(path.join(session,'host/host-instance.json'),'utf8'));assert.notEqual(next.instanceId,initialHost.instanceId);
  const state=await shell();assert.equal(state.spaces.length,2);assert.ok(state.spaces.every(s=>s.ownership==='user'));const opens=bridge.events.filter(e=>e.type==='session').length;
  const r=await business.call('resume',{runId:second.run.id});assert.equal(r.status,'BLOCKED');assert.equal(r.result.blockerCode,'BROWSER_SESSION_EXPIRED');assert.ok(r.result.message.includes('HOST_INSTANCE_CHANGED'));assert.equal(r.requests,1);assert.equal(bridge.events.filter(e=>e.type==='session').length,opens);assert.ok((await shell()).spaces.every(s=>s.ownership==='user'));
 });
 assert.equal((await business.call('stats')).modelCalls,0);assert.ok(requests.every(r=>r.method==='GET'&&r.url==='/bridge-fixture/'+nonce));
 await stopBusiness();clearInterval(relay);relay=undefined;bridge.p.stdin.end();await until(()=>bridge.closed,'Go clean EOF');assert.equal(bridge.code,0,bridge.stderr);await closeHost();assert.ok(children.every(c=>c.closed&&c.code===0));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,proof,businessSession,actualModelCalls:0,discoveryCalls:0,actualExternalCalls:0,source:'ACTUAL_OWNED_DYNAMIC_DOM_GO_CLI_SDK',database:'ACTUAL_NEW_SQLITE_PRISMA',screenshots:'ACTUAL_EGO_VIEWPORT_PNG_ARTIFACTS',controlActions:'SYNTHETIC_ORIGINAL_SHELL_BRIDGE',actualHumanLoginReturn:'NOT_RUN',nativeUserClicks:'NOT_RUN',productionWiring:false,platformE2E:'NOT_RUN',fixtureRequests:requests.length,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code}))},null,2));
});
