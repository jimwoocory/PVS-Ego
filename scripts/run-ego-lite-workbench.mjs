// One targeted suite using the actual default workbench launcher and local host.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';
import {loadInstallation,digest} from './ego-lite-installation.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');loadInstallation();
const session=confined(path.join(root,'.runtime/isolation-sessions','ego-lite-workbench-'+randomUUID()));
for(const dir of ['evidence','projects','home/local','home/roaming','tmp'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/ego-lite-workbench-active.json'),JSON.stringify({session}));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_EGO_LITE_TEST_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/ego-lite-workbench-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/spawn-error.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
  log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({code,signal}));if(code!==0){process.exitCode=code??1;return;}
  const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
  if(!result.results.length||!result.results.every(r=>r.passed)||!result.receipts.every(r=>r.children.every(c=>c.closed&&c.code===0)))throw Error('INCOMPLETE_ASSERTIONS_OR_EXITS');
  const files=['scripts/start-isolated.mjs','scripts/ego-lite-supervisor.mjs','scripts/serve-ego-lite-child.mjs','scripts/ego-lite-installation.mjs','src/web/server.ts','src/web/agent-cycle-http.ts','src/web/agent-cycle-ui.ts','src/application/services/pvs-agent-capabilities.ts','scripts/isolation-guard.mjs','tests/ego-lite-workbench-isolated.test.mjs'];
  fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_ACTUAL_LOCAL_EGO_DEFAULT_WORKBENCH',suiteExitCode:0,sourceHashes:Object.fromEntries(files.map(p=>[p,digest(path.join(root,p))]))},null,2),{flag:'wx'});
});
