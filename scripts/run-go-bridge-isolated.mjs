// Explicit trusted test orchestrator. Does not import application code or weaken its guard.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--go'||args[2]!=='--ego-root'||!path.isAbsolute(args[1])||!path.isAbsolute(args[3]))throw Error('EXPLICIT_GO_AND_EGO_ROOT_REQUIRED');
const location={session:confined(path.join(root,'.runtime','go-bridge-attempt-'+randomUUID()))};
for(const dir of ['evidence','home/local','home/roaming','go-cache'])fs.mkdirSync(path.join(location.session,dir),{recursive:true});
fs.writeFileSync(confined(path.join(root,'.runtime/go-bridge-latest-attempt.json')),JSON.stringify(location,null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:location.session,USERPROFILE:location.session,TEMP:location.session,TMP:location.session,GOTELEMETRY:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GOENV:'off',GOCACHE:path.join(location.session,'go-cache'),GOPATH:path.join(location.session,'go-path'),PVS_GO_TEST_SESSION:location.session,PVS_GO_TEST_EGO_ROOT:fs.realpathSync(args[3]),PVS_GO_TEST_BINARY:path.join(location.session,'go-ego-bridge.exe')});
async function run(executable,argv,label,cwd=root){return new Promise((resolve,reject)=>{const log=fs.createWriteStream(path.join(location.session,'evidence',label+'.log'),{flags:'wx'});const c=spawn(executable,argv,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});c.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});c.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});c.once('error',reject);c.once('close',(code,signal)=>{log.end();fs.writeFileSync(path.join(location.session,'evidence',label+'-exit.json'),JSON.stringify({pid:c.pid,code,signal}));code===0?resolve():reject(Error(label+'_FAILED_'+code));});});}
const digest=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
let sourceHashes={};
try {
 sourceHashes=Object.fromEntries(['execution/go-ego-bridge/main.go','execution/go-ego-bridge/worker.mjs','execution/go-ego-bridge/lifetime_windows.go','execution/go-ego-bridge/lifetime_other.go','src/application/services/agent-cycle-service.ts','src/web/agent-cycle-http.ts','src/web/agent-cycle-ui.ts','tests/go-bridge-business-fixture.ts','tests/go-bridge-lifecycle-fixture.ts','tests/go-ego-bridge-isolated.test.mjs','scripts/run-go-bridge-isolated.mjs','scripts/isolation-guard.mjs'].map(file=>[file,digest(file)]));
 fs.writeFileSync(path.join(location.session,'evidence/source-manifest.json'),JSON.stringify({sourceHashes},null,2),{flag:'wx'});
 await run(args[1],['build','-trimpath','-buildvcs=false','-o',env.PVS_GO_TEST_BINARY,'.'],'go-build',path.join(root,'execution/go-ego-bridge'));
 await run(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/go-ego-bridge-isolated.test.mjs')],'go-bridge-suite');
 const receipt=JSON.parse(fs.readFileSync(path.join(location.session,'evidence/assertion-result.json'),'utf8'));
 for(const name of ['host','bridge','business','lifecycle']){const exit=JSON.parse(fs.readFileSync(path.join(location.session,'evidence',name+'-exit.json'),'utf8'));if(!exit.closed||exit.code!==0)throw Error('UNCLEAN_'+name);}
 for(const [file,sha] of Object.entries(sourceHashes))if(digest(file)!==sha)throw Error('SOURCE_CHANGED_DURING_GO_BRIDGE_SUITE');
 fs.writeFileSync(path.join(location.session,'evidence/final-acceptance.json'),JSON.stringify({...receipt,status:'PASS_LOCAL_GO_EGO_TRANSPORT_AND_BUSINESS_GATE',suiteExitCode:0,sourceHashes},null,2),{flag:'wx'});
} catch(error) {
 fs.writeFileSync(path.join(location.session,'evidence/attempt-failed.json'),JSON.stringify({status:'FAIL',code:error.code??'ORCHESTRATOR_FAILED',reason:error.message,sourceHashes},null,2),{flag:'wx'});
 throw error;
}
