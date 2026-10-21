// Trusted test runner. Application children keep the original deny-execution guard.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','u4-schedule-durable-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/u4-schedule-durable-active.json'),JSON.stringify({session},null,2));
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_U4_DURABLE_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
let child;try{child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/u4-schedule-durability-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));log.end();throw error;}
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));
 if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
 if(!result.children.every(c=>c.closed&&(c.code===0||c.code===73)))throw Error('UNCLEAN_CHILD');
 const files=['src/application/services/douyin-operations-schedule-service.ts','src/adapters/db/prisma-douyin-operations-schedule-repository.ts','src/application/ports/douyin-operations-schedule-repository.ts','src/domain/douyin-operations-schedule.ts','src/application/services/douyin-metric-service.ts','src/application/services/douyin-comment-service.ts','src/application/services/douyin-collection-service.ts','src/adapters/db/prisma-douyin-collection-repository.ts','src/application/ports/douyin-collection-repository.ts','src/application/ports/douyin-ops-repository.ts','src/adapters/db/prisma-douyin-ops-repository.ts','src/application/ports/operations-write-fence.ts','src/adapters/db/operations-write-fence.ts','src/application/services/pvs-agent-capabilities.ts','src/application/services/douyin-retrospective-service.ts','src/domain/douyin-feedback-validation.ts','tests/u4-schedule-durability-fixture.ts','tests/u4-schedule-durability-isolated.test.mjs','scripts/run-u4-schedule-durability.mjs','scripts/isolation-guard.mjs'];
 const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_U4_DURABLE_BOUNDED_SCHEDULE_AND_U5_FROZEN_CHAIN',suiteExitCode:code,sourceHashes},null,2),{flag:'wx'});
});
