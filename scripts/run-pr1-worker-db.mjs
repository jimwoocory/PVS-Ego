// One trusted orchestrator; all application processes retain the original guard.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','pr1-worker-db-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/pr1-worker-db-active.json'),JSON.stringify({session},null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_PR1_WORKER_DB_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/pr1-worker-db-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{log.end();fs.writeFileSync(path.join(session,'evidence/spawn-error.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
  log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));if(code!==0){process.exitCode=code??1;return;}
  const r=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
  if(r.pass!==16||!r.results.every(v=>v.passed)||!r.children.every(c=>c.closed&&c.code===c.expectedCode)||r.duration.observationGapMs<60000||r.duration.naturalLeaseExpiry.waitMs<170000||r.duration.naturalLeaseExpiry.expiredLeaseInjected!==false)throw Error('INCOMPLETE_ASSERTIONS_OR_EXITS');
  const files=['src/application/services/smart-generation-worker.ts','src/application/services/smart-generation-service.ts','src/adapters/db/prisma-smart-run-repository.ts','src/application/services/agent-cycle-service.ts','src/adapters/db/prisma-agent-cycle-repository.ts','src/application/services/douyin-operations-schedule-service.ts','src/adapters/db/prisma-douyin-operations-schedule-repository.ts','src/application/services/douyin-collection-service.ts','src/adapters/db/prisma-douyin-collection-repository.ts','src/adapters/db/operations-write-fence.ts','src/adapters/db/prisma-douyin-ops-repository.ts','scripts/isolation-guard.mjs','scripts/run-pr1-worker-db.mjs','tests/pr1-worker-db-fixture.ts','tests/pr1-worker-db-isolated.test.mjs'];
  const sourceHashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
  fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...r,status:'PASS_BOUNDED_NATIVE_WORKERS_SHARED_PRISMA',suiteExitCode:0,sourceHashes},null,2),{flag:'wx'});
});
