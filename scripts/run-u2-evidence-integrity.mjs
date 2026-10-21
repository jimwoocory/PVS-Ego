// Trusted runner: only newly generated lavfi media and blank SQLite. No app spawn allowance added.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root} from './isolation-policy.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--ffmpeg'||args[2]!=='--ffprobe')throw Error('PINNED_LOCAL_FFMPEG_AND_FFPROBE_REQUIRED');
const binaries=[args[1],args[3]].map((file,i)=>{
 if(!path.isAbsolute(file))throw Error('ABSOLUTE_EXECUTABLE_REQUIRED');
 const real=fs.realpathSync.native(file);
 if(path.basename(real).toLowerCase()!==['ffmpeg.exe','ffprobe.exe'][i]||!fs.statSync(real).isFile())throw Error('LOCAL_EXECUTABLE_REQUIRED');return real;
});
const session=path.join(root,'.runtime/isolation-sessions','u2-evidence-integrity-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects','media','media/frames'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(session,'tools.json'),JSON.stringify(binaries));
fs.writeFileSync(path.join(root,'.runtime/u2-evidence-integrity-active.json'),JSON.stringify({session},null,2));
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp'),PVS_U2_EVIDENCE_SESSION:session});
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
let child;try{child=spawn(process.execPath,['--test','--test-concurrency=1',path.join(root,'tests/u2-evidence-integrity-isolated.test.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));log.end();throw error;}
child.stdout.on('data',b=>{log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;});
child.once('close',(code,signal)=>{
 log.end();fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify({pid:child.pid,code,signal}));
 if(code!==0){process.exitCode=code??1;return;}
 const result=JSON.parse(fs.readFileSync(path.join(session,'evidence/assertion-result.json'),'utf8'));
 if(!result.children.every(c=>c.closed&&c.code===0))throw Error('UNCLEAN_CHILD');
 const sourceHashes=Object.fromEntries(['src/application/services/reference-video-analysis.ts','src/application/services/reference-video-evidence.ts','src/application/services/ai-generation.ts','src/application/services/product-director.ts','src/adapters/ai/hermes-product-director-generator.ts','src/adapters/db/prisma-reference-video-repository.ts','src/adapters/db/prisma-artifact-repository.ts','src/domain/schemas.ts','src/application/services/douyin-read-evidence-audit.ts','src/domain/douyin-feedback-validation.ts','src/web/server.ts','tests/u2-evidence-integrity-fixture.ts','tests/u2-evidence-integrity-isolated.test.mjs','scripts/run-u2-evidence-integrity.mjs','scripts/isolation-guard.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({...result,status:'PASS_U2_MEDIA_INTEGRITY_WITH_U4_U5_EVIDENCE_GATES',suiteExitCode:code,sourceHashes},null,2),{flag:'wx'});
});
