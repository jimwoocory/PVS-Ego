// One focused HTTP/data/permission regression. Browser acceptance is recorded separately.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {root,confined} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=confined(path.join(root,'.runtime/isolation-sessions','pr1-local-ui-'+randomUUID()));
for(const dir of ['evidence','projects','home','home/local','home/roaming','tmp'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(confined(path.join(root,'.runtime/pr1-local-ui-active.json')),JSON.stringify({session}));
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:path.join(session,'home'),USERPROFILE:path.join(session,'home'),TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_PR1_LOCAL_UI_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/pr1-local-ui-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{log.end();process.exitCode=1;fs.writeFileSync(path.join(session,'evidence/runner-error.json'),JSON.stringify({code:error.code,message:error.message}));});
child.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));
 if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
 if(!result.results.length||!result.results.every(r=>r.passed)||!result.child.closed||result.child.code!==0)throw Error('INCOMPLETE_ASSERTIONS_OR_CHILD_EXIT');
 const sourceHashes=Object.fromEntries(['src/web/server.ts','src/web/workbench-ui.ts','src/application/services/pvs-agent-capabilities.ts','scripts/isolation-guard.mjs','scripts/run-pr1-local-ui.mjs','tests/pr1-local-ui-fixture.mjs','tests/pr1-local-ui-isolated.test.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_LOCAL_INPUT_PRISMA_HTTP_PERMISSION_GATES',suiteExitCode:0,sourceHashes},null,2),{flag:'wx'});
});
