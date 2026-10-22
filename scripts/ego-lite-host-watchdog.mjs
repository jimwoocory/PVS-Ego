// Owned-host lease: wall-clock changes and file timestamps are not liveness.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
export function writeHostHeartbeat(file,parentPid,leaseId,sequence){
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temporary,JSON.stringify({version:1,parentPid,leaseId,sequence}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}
}
export function installHostWatchdog({app,parentPid,leaseId,heartbeatFile,stopFile}){
 let sequence=-1,lastProgress=performance.now(),reason,phase='RUNNING',exitCode;
 const receiptFile=path.join(path.dirname(heartbeatFile),'host-lifecycle-'+leaseId+'.json');
 const record=()=>{try{fs.writeFileSync(receiptFile,JSON.stringify({contract:'pvs-owned-host-lifecycle-v1',hostPid:process.pid,parentPid,reason:reason??'APP_QUIT_WITHOUT_WATCHDOG',phase,sequence,...(exitCode===undefined?{}:{exitCode}),gapMs:Math.max(0,Math.round(performance.now()-lastProgress))}));}catch{}};
 const quit=value=>{if(reason)return;reason=value;phase='STOP_REQUESTED';record();console.log('PVS_EGO_OPS_STOP '+reason);clearInterval(timer);app.quit();};
 const timer=setInterval(()=>{
  if(fs.existsSync(stopFile)){quit('STOP_REQUESTED');return;}
  try{process.kill(parentPid,0);}catch{quit('PARENT_GONE');return;}
  let value;try{const stat=fs.statSync(heartbeatFile);if(!stat.isFile()||stat.size>256)throw Error();value=JSON.parse(fs.readFileSync(heartbeatFile,'utf8'));}catch{quit('HEARTBEAT_INVALID');return;}
  if(value.version!==1||value.parentPid!==parentPid||value.leaseId!==leaseId||!Number.isSafeInteger(value.sequence)||value.sequence<0||value.sequence<sequence){quit('HEARTBEAT_INVALID');return;}
  if(value.sequence>sequence){sequence=value.sequence;lastProgress=performance.now();}
  if(performance.now()-lastProgress>=5000)quit('HEARTBEAT_STALE');
 },100);
 app.on('before-quit',()=>{phase='BEFORE_QUIT';record();});
 app.on('quit',(_event,code)=>{exitCode=code;clearInterval(timer);phase='QUIT';record();console.log('PVS_EGO_OPS_EXIT '+(reason??'APP_QUIT_WITHOUT_WATCHDOG'));});
 process.on('uncaughtExceptionMonitor',()=>{reason??='UNCAUGHT_EXCEPTION';phase='UNCAUGHT_EXCEPTION';record();});
 return ()=>clearInterval(timer);
}
