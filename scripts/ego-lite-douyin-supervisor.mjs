import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {confined,root} from './isolation-policy.mjs';
import {loadInstallation,digest} from './ego-lite-installation.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,ms){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await delay(25);}throw Error('EGO_OPS_PROCESS_TIMEOUT');}
export function createDouyinReadSupervisor({env,installation,origin,nonce,fixture}){
 const dir=confined(path.join(env.PVS_ISOLATION_SESSION,'go-bridge-douyin'));
 const children=[],cancelled=new Set();let host,binding,active,heartbeat,closed=false,spaceName,chain;
 const source=fixture?'LOCAL_FIXTURE_ONLY':'LIVE_DOUYIN';
 function child(exe,args,role){const p=spawn(exe,args,{cwd:root,env:hostEnv(),windowsHide:role!=='ops-host',stdio:['pipe','pipe','pipe']});const state={p,role,closed:false,code:null,signal:null,stdout:'',stderr:''};children.push(state);
  p.stdin.on('error',()=>{});p.stdout.on('data',b=>{state.stdout+=b;if(state.stdout.length>600000){state.forced=true;p.kill();}});p.stderr.on('data',b=>state.stderr=(state.stderr+b).slice(-3000));p.on('error',()=>{});
  state.exit=new Promise(resolve=>p.once('close',(code,signal)=>{Object.assign(state,{closed:true,code,signal});resolve(state);}));return state;}
 function hostEnv(){const result={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(env[k])result[k]=env[k];return {...result,EGO_WINDOWS_DATA_DIR:path.join(dir,'host'),PATH:path.dirname(process.execPath),HOME:dir,USERPROFILE:dir,LOCALAPPDATA:path.join(dir,'home/local'),APPDATA:path.join(dir,'home/roaming'),TEMP:dir,TMP:dir};}
 async function open(){
  if(host&&!host.closed)throw Error('EGO_OPS_SESSION_ALREADY_OPEN');
  binding=undefined;chain=undefined;spaceName='pvs-ops-'+randomUUID();
  for(const d of ['host','home/local','home/roaming','evidence'])fs.mkdirSync(path.join(dir,d),{recursive:true});
  const heartbeatFile=path.join(dir,'heartbeat'),stop=path.join(dir,'stop'),entry=path.join(dir,'host.mjs');
  if(fs.existsSync(stop))fs.unlinkSync(stop);
  fs.writeFileSync(heartbeatFile,String(process.pid));heartbeat=setInterval(()=>{try{fs.writeFileSync(heartbeatFile,String(process.pid));}catch{}},500);
  const policy=pathToFileURL(path.join(root,'scripts/ego-lite-douyin-policy.mjs')).href;
  fs.writeFileSync(entry,`import {app} from 'electron';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {allowsDouyinReadRequest} from ${JSON.stringify(policy)};app.on('browser-window-created',(_event,w)=>{w.once('ready-to-show',()=>setImmediate(()=>{if(w.isDestroyed()||w.webContents.getURL()!==${JSON.stringify(pathToFileURL(path.join(path.dirname(installation.hostMain),'shell.html')).href)})return;if(w.isMinimized())w.restore();w.show();w.focus();if(w.isVisible()&&!w.isMinimized())console.log('PVS_EGO_OPS_WINDOW_VISIBLE');}));});app.on('session-created',s=>{s.webRequest.onBeforeRequest((d,cb)=>{let allow=false;try{if(d.url.startsWith('file:')){const r=path.relative(${JSON.stringify(path.dirname(installation.hostMain))},fileURLToPath(d.url));allow=r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);}else allow=allowsDouyinReadRequest(d,${JSON.stringify(fixture??null)});}catch{}cb({cancel:!allow});});s.on('will-download',(event,item)=>{event.preventDefault();item.cancel();});});const timer=setInterval(()=>{let reason;try{process.kill(${process.pid},0);if(Date.now()-fs.statSync(${JSON.stringify(heartbeatFile)}).mtimeMs>=5000)reason='HEARTBEAT_STALE';}catch{reason='PARENT_OR_HEARTBEAT_MISSING';}if(fs.existsSync(${JSON.stringify(stop)}))reason='STOP_REQUESTED';if(reason){console.log('PVS_EGO_OPS_STOP '+reason);clearInterval(timer);app.quit();}},100);await import(${JSON.stringify(pathToFileURL(installation.hostMain).href)});`);
  host=child(installation.electron,[entry,'--disable-background-networking','--disable-component-update','--disable-sync'],'ops-host');
  host.p.once('close',()=>{binding=undefined;chain=undefined;if(heartbeat)clearInterval(heartbeat);if(active&&!active.proc.closed)active.proc.p.stdin.end();});
  await until(()=>(host.stdout.includes('EGO_WINDOWS_HOST_READY')&&host.stdout.includes('PVS_EGO_OPS_WINDOW_VISIBLE'))||host.closed,30000);if(host.closed)throw Error('EGO_OPS_HOST_CLOSED');
 }
 async function execute(r){
  if(closed||active)throw Error('EGO_OPS_BUSY_OR_CLOSED');
  if(cancelled.has(r.id))return {workerExited:true,terminal:'CANCELLED'};
  if(JSON.stringify(loadInstallation())!==JSON.stringify(installation))throw Error('EGO_LITE_PIN_CHANGED');
  if(r.operation==='open')await open();
  if(cancelled.has(r.id))return {workerExited:true,terminal:'CANCELLED'};
  if(!host||host.closed||(r.operation!=='open'&&!binding))throw Error('EGO_OPS_SESSION_EXPIRED');
  const previous=chain;
  if(r.operation==='works'){if(!/^(0|[1-9]\d{0,19})$/.test(r.cursor)||r.cursor==='0'&&r.expectedPageToken!==undefined)throw Error('EGO_OPS_PAGE_SCOPE_DENIED');if(r.cursor!=='0'&&(!previous||previous.projectId!==r.scope.projectId||previous.uid!==r.expectedAccountUid||previous.count!==r.count||previous.token!==r.expectedPageToken||!previous.nextAllowed||previous.nextCursor!==r.cursor||Date.now()-previous.checkedAt>120000))throw Error('EGO_OPS_PAGE_SCOPE_DENIED');}
  chain=undefined;
  const info=JSON.parse(fs.readFileSync(path.join(dir,'host/host-instance.json'),'utf8'));
  const pin=file=>installation.pins.find(p=>p.file===file).sha256;
  const base={contract:'pvs-go-ego-local-v1',session:dir,node:installation.node,nodeSha256:pin(installation.node),cli:installation.cli,cliSha256:pin(installation.cli),sdk:installation.sdk,sdkSha256:pin(installation.sdk),dataDir:path.join(dir,'host'),instanceId:'windows-host:'+info.instanceId,origin:fixture?.origin??origin,nonce:fixture?.nonce??nonce};
  const config={base,operation:r.operation,source,spaceName,scope:r.scope,...(r.operation==='open'?{}:{binding}),...(r.operation==='works'?{count:r.count,expectedAccountUid:r.expectedAccountUid,cursor:r.cursor,...(r.cursor!=='0'?{lastWorkId:previous.lastWorkId}:{})}:{})};
  const file=path.join(dir,'action-'+r.id+'.json');fs.writeFileSync(file,JSON.stringify(config),{flag:'wx'});
  const proc=child(installation.bridge,['--ops-config',file],'ops-go');active={id:r.id,proc};
  try{
   await until(()=>proc.closed,24000).catch(async()=>{proc.p.stdin.end();await until(()=>proc.closed,3000).catch(()=>{proc.forced=true;proc.p.kill();});await until(()=>proc.closed,3000);});
   if(proc.code!==0||proc.forced)throw Error('EGO_OPS_WORKER_EXIT_UNCONFIRMED');
   const result=JSON.parse(proc.stdout.trim());
   if(result.contract!=='pvs-ego-douyin-read-v1'||result.operation!==r.operation||JSON.stringify(result.scope)!==JSON.stringify(r.scope)||result.workerExited!==true)throw Error('EGO_OPS_RECEIPT_DENIED');
   proc.workerPid=result.workerPid;
   if(r.operation==='open'&&result.result?.binding){const b=result.result.binding;if(b.instanceId!==base.instanceId||b.spaceName!==spaceName||b.profileId!=='Default'||b.sessionId!==base.nonce||!Number.isSafeInteger(b.spaceId)||typeof b.targetId!=='string')throw Error('EGO_OPS_BINDING_DENIED');binding=b;delete result.result.binding;}
   if(r.operation==='works'&&result.terminal==='SUCCEEDED'&&result.result?.status==='READY'){
    const value=result.result,p=value.pagination,prior=r.cursor==='0'?null:previous,index=(prior?.index??0)+1,seenCursors=prior?.seenCursors??[],seenIds=prior?.seenIds??[];
    if(!p||p.requestCursor!==r.cursor||typeof p.hasMore!=='boolean'||p.hasMore&&(!/^[1-9]\d{0,19}$/.test(p.nextCursor)||p.nextCursor===r.cursor||seenCursors.includes(p.nextCursor))||!p.hasMore&&p.nextCursor!==null||index>5||!Array.isArray(value.works)||value.works.length>r.count||p.hasMore&&!value.works.length||value.works.some(w=>w.author?.uid!==r.expectedAccountUid||seenIds.includes(w.awemeId))||new Set(value.works.map(w=>w.awemeId)).size!==value.works.length)throw Error('EGO_OPS_PAGE_RECEIPT_DENIED');
    const token=randomBytes(32).toString('hex'),nextAllowed=p.hasMore&&index<5;value.pagination={...p,projectId:r.scope.projectId,pageIndex:index,maxPages:5,readToken:token,nextAllowed,stopReason:!p.hasMore?'END':index===5?'PAGE_LIMIT':null};
    chain={projectId:r.scope.projectId,uid:r.expectedAccountUid,count:r.count,token,nextAllowed,nextCursor:p.nextCursor,index,seenCursors:[...seenCursors,r.cursor],seenIds:[...seenIds,...value.works.map(w=>w.awemeId)],lastWorkId:value.works.at(-1)?.awemeId,checkedAt:Date.now()};
   }
   return {workerExited:true,terminal:result.terminal,...(result.result?{result:result.result}:{})};
  }finally{active=undefined;}
 }
 function cancel(id){if(cancelled.size<256)cancelled.add(id);if(active?.id===id&&!active.proc.closed)active.proc.p.stdin.end();}
 async function stop(){closed=true;if(active)cancel(active.id);await until(()=>!active||active.proc.closed,5000).catch(()=>{if(active){active.proc.forced=true;active.proc.p.kill();}});
  if(heartbeat)clearInterval(heartbeat);if(host&&!host.closed){fs.writeFileSync(path.join(dir,'stop'),'own host only');await until(()=>host.closed,10000).catch(()=>{host.forced=true;host.p.kill();});await until(()=>host.closed,3000).catch(()=>{});}return children.map(c=>({pid:c.p.pid,workerPid:c.workerPid,role:c.role,closed:c.closed,code:c.code,signal:c.signal,forced:Boolean(c.forced),...(c.role==='ops-host'?{hostStopReason:c.stdout.match(/PVS_EGO_OPS_STOP (HEARTBEAT_STALE|PARENT_OR_HEARTBEAT_MISSING|STOP_REQUESTED)/)?.[1]??'HOST_CLOSED_WITHOUT_WATCHDOG_REASON'}:{})}));}
 return {execute,cancel,stop,source,children,snapshot:()=>({source,open:Boolean(host&&!host.closed),bound:Boolean(binding),windowShown:Boolean(host&&!host.closed&&host.stdout.includes('PVS_EGO_OPS_WINDOW_VISIBLE')),children:children.map(c=>({pid:c.p.pid,role:c.role,closed:c.closed,code:c.code}))})};
}
