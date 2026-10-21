// Trusted, no-download Go build and one fixed integration suite.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--go'||args[2]!=='--ego-root'||!path.isAbsolute(args[1])||!path.isAbsolute(args[3]))throw Error('EXPLICIT_LOCAL_GO_AND_EGO_REQUIRED');
const session=path.join(root,'.runtime','go-bridge-research-'+randomUUID()),businessSession=path.join(root,'.runtime/isolation-sessions','go-research-'+randomUUID());
for(const base of [session,businessSession])for(const dir of ['evidence','projects','tmp','home/local','home/roaming'])fs.mkdirSync(path.join(base,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/go-research-active.json'),JSON.stringify({session,businessSession},null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
const cached=JSON.parse(fs.readFileSync(path.join(root,'.runtime/go-bridge-location.json'),'utf8')).session;
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),GOTELEMETRY:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GOENV:'off',GOCACHE:path.join(cached,'go-cache'),GOPATH:path.join(session,'go-path'),PVS_GO_RESEARCH_SESSION:session,PVS_GO_RESEARCH_BUSINESS:businessSession,PVS_GO_RESEARCH_EGO_ROOT:fs.realpathSync(args[3])});
async function run(executable,argv,name,cwd=root){await new Promise((resolve,reject)=>{
 const log=fs.createWriteStream(path.join(session,'evidence',name+'.log'),{flags:'wx'});let p;
 try{p=spawn(executable,argv,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){log.end(error.message);reject(error);return;}
 p.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});p.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});p.once('error',reject);p.once('close',(code,signal)=>{log.end();fs.writeFileSync(path.join(session,'evidence',name+'-exit.json'),JSON.stringify({pid:p.pid,code,signal}));code===0?resolve():reject(Error(name+'_FAILED_'+code));});
 });}
try{
 await run(args[1],['build','-trimpath','-buildvcs=false','-o',path.join(session,'go-ego-bridge.exe'),'.'],'go-build',path.join(root,'execution/go-ego-bridge'));
 await run(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/go-research-isolated.test.mjs')],'go-research-suite');
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
 if(!result.children.every(c=>c.closed&&c.code===0))throw Error('UNCLEAN_CHILD');
 const sourceHashes=Object.fromEntries(['src/application/services/agent-cycle-service.ts','src/application/services/research-service.ts','src/adapters/research/go-local-research-provider.ts','execution/go-ego-bridge/main.go','execution/go-ego-bridge/worker.mjs','tests/go-research-chain-fixture.ts','tests/go-research-isolated.test.mjs','scripts/isolation-guard.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_GO_OWNED_DYNAMIC_DOCUMENT_TO_RESEARCH_EVIDENCE',suiteExitCode:0,sourceHashes},null,2),{flag:'wx'});
}catch(error){fs.writeFileSync(path.join(session,'evidence/attempt-failed.json'),JSON.stringify({code:error.code??'RUNNER_FAILED',reason:error.message},null,2),{flag:'wx'});throw error;}
