// Trusted test runner; all application code executes under the unchanged guard.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','go-capture-durable-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/go-capture-durable-active.json'),JSON.stringify({session},null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_CAPTURE_DURABLE_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
let p;try{p=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/go-capture-durability-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));log.end();throw error;}
p.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});p.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
p.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
p.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:p.pid,code,signal}));
 if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
 if(!result.children.every(c=>c.closed&&(c.code===0||c.code===result.expectedCrashExit)))throw Error('UNCLEAN_CHILD');
 const sourceHashes=Object.fromEntries(['src/adapters/research/go-local-research-provider.ts','src/adapters/store/local-artifact-store.ts','src/application/services/research-evidence-reader.ts','tests/go-capture-durability-fixture.ts','tests/go-capture-durability-isolated.test.mjs','scripts/run-go-capture-durability.mjs','scripts/isolation-guard.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_OWNED_CAPTURE_RESERVATION_AND_PUBLISHED_RECOVERY',suiteExitCode:code,sourceHashes},null,2),{flag:'wx'});
});
