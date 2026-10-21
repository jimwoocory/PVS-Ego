import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','evidence-review-'+randomUUID());for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/evidence-review-attempt.json'),JSON.stringify({session},null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_EVIDENCE_REVIEW_SESSION:session});
try{
 await new Promise((resolve,reject)=>{const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});let p;try{p=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/research-evidence-review-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){log.end();reject(error);return;}
 p.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});p.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});p.once('error',reject);p.once('close',(code,signal)=>{log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:p.pid,code,signal}));code===0?resolve():reject(Error('SUITE_FAILED_'+code));});});
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));if(!result.child.closed||result.child.code!==0)throw Error('UNCLEAN_FIXTURE');
 const sourceHashes=Object.fromEntries(['src/application/services/research-evidence-reader.ts','src/web/research-evidence-http.ts','src/web/workbench-ui.ts','src/web/server.ts','scripts/isolation-guard.mjs','tests/research-evidence-review-fixture.ts','tests/research-evidence-review-isolated.test.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_READ_ONLY_EVIDENCE_REVIEW_HTTP_AND_BROWSER',suiteExitCode:0,sourceHashes},null,2),{flag:'wx'});
}catch(error){fs.writeFileSync(path.join(session,'evidence/attempt-failed.json'),JSON.stringify({reason:error.message,code:error.code??'RUNNER_FAILED'},null,2),{flag:'wx'});throw error;}
