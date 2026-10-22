import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';
import {loadInstallation,digest} from './ego-lite-installation.mjs';
if(process.argv.length!==2||process.platform!=='win32')throw Error('WINDOWS_LOCAL_LIFECYCLE_ONLY');loadInstallation();
const session=confined(path.join(root,'.runtime/isolation-sessions','ego-lite-lifecycle-'+randomUUID()));fs.mkdirSync(path.join(session,'evidence'),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/ego-lite-lifecycle-active.json'),JSON.stringify({session}));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:session,TMP:session,PVS_LIFECYCLE_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/ego-lite-lifecycle-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-error.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
  log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({code,signal}));if(code!==0){process.exitCode=code??1;return;}
  const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
  if(!result.results.every(r=>r.passed)||!result.cases.every(c=>c.ownedGone&&c.expectedExitsVerified))throw Error('FAULT_OR_EXIT_ASSERTIONS_INCOMPLETE');
  const files=['src/application/services/agent-cycle-service.ts','src/application/services/pvs-agent-capabilities.ts','src/application/services/research-service.ts','src/adapters/research/go-owned-ego-research-runtime.ts','src/adapters/research/ego-browser-research-provider.ts','src/web/douyin-ops-http.ts','src/web/douyin-ops-ui.ts','scripts/ego-lite-supervisor.mjs','scripts/serve-ego-lite-child.mjs','scripts/start-isolated.mjs','scripts/run-ego-lite-lifecycle.mjs','tests/ego-lite-lifecycle-isolated.test.mjs','tests/support/ego-lite-lifecycle-supervisor.mjs','tests/support/ego-lite-owned-fault.ps1','execution/go-ego-bridge/main.go','execution/go-ego-bridge/worker.mjs','execution/go-ego-bridge/lifetime_windows.go','execution/go-ego-bridge/lifetime_other.go','scripts/isolation-guard.mjs'];
  files.push('scripts/ego-lite-host-watchdog.mjs','scripts/ego-lite-installation.mjs');
  fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_ACTUAL_LOCAL_EGO_LIFECYCLE_FAULTS',suiteExitCode:0,sourceHashes:Object.fromEntries(files.map(p=>[p,digest(path.join(root,p))]))},null,2),{flag:'wx'});
});
