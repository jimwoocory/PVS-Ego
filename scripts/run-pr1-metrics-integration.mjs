// One trusted Prisma/HTTP/browser regression; business child retains the guard.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','pr1-metrics-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/pr1-metrics-integration-active.json'),JSON.stringify({session},null,2));
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_PR1_METRICS_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/pr1-metrics-integration-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});child.once('error',error=>{log.end();fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({message:error.message,code:error.code}));process.exitCode=1;});
child.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));if(result.pass!==23||!result.results.every(v=>v.passed)||!result.children.every(v=>v.closed&&v.code===0))throw Error('INCOMPLETE_ASSERTIONS_OR_CHILD_EXITS');
 const browser=JSON.parse(fs.readFileSync(path.join(session,'evidence/browser-result.json'),'utf8'));
 const files=['src/adapters/db/prisma-douyin-ops-repository.ts','src/application/services/douyin-read-evidence-audit.ts','src/application/services/douyin-operations-schedule-service.ts','src/application/services/douyin-retrospective-service.ts','src/application/services/operations-evidence-reader.ts','src/application/services/pvs-agent-capabilities.ts','src/web/agent-cycle-ui.ts','src/web/operations-evidence-http.ts','src/web/operations-evidence-ui.ts','scripts/isolation-guard.mjs','scripts/run-pr1-metrics-integration.mjs','tests/pr1-metrics-integration-fixture.ts','tests/pr1-metrics-integration-isolated.test.mjs'];
 const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_CURRENT_METRICS_PRISMA_HTTP_NATIVE_BROWSER',suiteExitCode:0,screenshot:browser.screenshot,sourceHashes},null,2),{flag:'wx'});
});
