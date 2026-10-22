import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','u45-workbench-review-'+randomUUID());for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/u45-workbench-review-active.json'),JSON.stringify({session},null,2));
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_U45_REVIEW_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
let child;try{child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/u45-workbench-review-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));log.end();throw error;}
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));if(!result.children.every(c=>c.closed&&c.code===0))throw Error('UNCLEAN_CHILD');
 const files=['src/application/services/operations-evidence-reader.ts','src/web/operations-evidence-ui.ts','src/web/operations-evidence-http.ts','src/web/agent-cycle-ui.ts','src/web/agent-cycle-http.ts','src/web/server.ts','src/application/services/pvs-agent-capabilities.ts','src/adapters/db/prisma-douyin-operations-schedule-repository.ts','src/application/ports/douyin-operations-schedule-repository.ts','src/adapters/db/prisma-product-flow-repository.ts','src/application/ports/product-flow-repository.ts','scripts/isolation-guard.mjs','scripts/run-u45-workbench-review.mjs','tests/u45-workbench-review-fixture.ts','tests/u45-workbench-review-isolated.test.mjs'];
 const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_U45_ORIGINAL_WORKBENCH_READ_ONLY_REVIEW_AND_SCOPED_RESUME',suiteExitCode:code,sourceHashes},null,2),{flag:'wx'});
});
