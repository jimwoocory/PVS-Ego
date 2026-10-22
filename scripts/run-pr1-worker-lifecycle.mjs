// One targeted native-Go + guarded-worker regression; only local inert fixtures.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {root,isolatedEnvironment} from './isolation-policy.mjs';
if(process.argv.length!==4||process.argv[2]!=='--go'||!path.isAbsolute(process.argv[3]))throw Error('EXPLICIT_LOCAL_GO_REQUIRED');
const go=fs.realpathSync(process.argv[3]);
const session=path.join(root,'.runtime/isolation-sessions','pr1-worker-'+randomUUID());
for(const dir of ['evidence','tmp','home','projects','go-cache','go-path'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/pr1-worker-active.json'),JSON.stringify({session},null,2));
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+path.join(session,'blank.db').replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const goEnv={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[key])goEnv[key]=process.env[key];
Object.assign(goEnv,{PATH:path.dirname(go),HOME:path.join(session,'home'),USERPROFILE:path.join(session,'home'),LOCALAPPDATA:path.join(session,'home'),TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',GOPROXY:'off',GOSUMDB:'off',GOCACHE:path.join(session,'go-cache'),GOPATH:path.join(session,'go-path'),PVS_GO_LIFECYCLE_SESSION:session});
const children=[];
async function run(exe,args,label,childEnv,cwd=root){
 return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b;if(label!=='native-go')process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
  child.once('error',reject);child.once('close',(code,signal)=>{
   const receipt={label,pid:child.pid,closed:true,code,signal};children.push(receipt);
   fs.writeFileSync(path.join(session,'evidence',label+'.json'),JSON.stringify({...receipt,stdout,stderr},null,2));
   code===0?resolve(stdout):reject(Error(label+'_FAILED_'+code));
  });
 });
}
try{
 const native=await run(go,['test','-json','-count=1','-timeout=90s','-run','^TestBridge(Protocol|InheritedPipes)$','.'],'native-go',goEnv,path.join(root,'execution/go-ego-bridge'));
 const worker=await run(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,'--test','--test-concurrency=1',path.join(root,'dist/tests/pr1-worker-lifecycle.test.js')],'guarded-worker',env);
 const nativeEvents=native.trim().split(/\r?\n/).map(line=>JSON.parse(line));
 if(nativeEvents.some(e=>e.Action==='skip'||e.Action==='fail'))throw Error('NATIVE_TEST_SKIPPED_OR_FAILED');
 const nativePass=nativeEvents.filter(e=>e.Action==='pass'&&e.Test).length;
 const directWorkers=nativeEvents.flatMap(e=>{const match=/direct worker pid=(\d+) reaped=true terminal=(\w+)/.exec(e.Output??'');return match?[{pid:Number(match[1]),reaped:true,terminal:match[2]}]:[];});
 const pipeHolders=nativeEvents.flatMap(e=>{const match=/pipe holder pid=(\d+) exited=0/.exec(e.Output??'');return match?[{pid:Number(match[1]),closed:true,code:0}]:[];});
 const workerPass=Number(/# pass (\d+)/.exec(worker)?.[1]);
 if(nativePass!==25||workerPass!==9||directWorkers.length!==23||pipeHolders.length!==5||!/# fail 0\b/.test(worker))throw Error('EXPECTED_ASSERTIONS_OR_EXITS_MISSING');
 const files=['execution/go-ego-bridge/main.go','execution/go-ego-bridge/main_test.go','execution/go-ego-bridge/worker.mjs','src/application/services/smart-generation-worker.ts','tests/pr1-worker-lifecycle.test.ts','scripts/run-pr1-worker-lifecycle.mjs','scripts/isolation-guard.mjs'];
 const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({status:'PASS_NATIVE_GO_AND_GUARDED_WORKER_FIXTURES',pass:nativePass+workerPass,fail:0,nativePass,workerPass,children,directWorkers,pipeHolders,sourceHashes,nativeProcessLifecycle:true,fixturePng:'SIGNATURE_BYTES_ONLY',database:'NO_APPLICATION_DB_QUERIES',egoHostCalls:0,realBrowserCalls:0,modelCalls:0,remoteRollbackProven:false},null,2),{flag:'wx'});
 process.stdout.write(`Native Go ${nativePass} PASS; guarded worker ${workerPass} PASS; ${directWorkers.length} direct workers reaped; ${pipeHolders.length} pipe holders exited; suite PASS.\n`);
}catch(error){fs.writeFileSync(path.join(session,'evidence/failure.json'),JSON.stringify({status:'FAIL',message:error.message,children},null,2),{flag:'wx'});throw error;}
