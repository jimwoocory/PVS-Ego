// Single guarded regression for saved metrics and Go-local cached publications.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {root,isolatedEnvironment} from './isolation-policy.mjs';
if(process.argv.length!==2)throw Error('NO_ARGUMENTS_ALLOWED');
const session=path.join(root,'.runtime/isolation-sessions','pr1-final-'+randomUUID());
for(const dir of ['evidence','home','tmp','projects'])fs.mkdirSync(path.join(session,dir),{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/pr1-final-review-active.json'),JSON.stringify({session},null,2));
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+path.join(session,'blank.db').replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const owned=file=>{const absolute=path.resolve(file),relative=path.relative(session,absolute);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('FIXTURE_PATH_OUTSIDE_SESSION');return absolute;};
const digest=b=>createHash('sha256').update(b).digest('hex'),fixtures=[];
// All links below are newly created fixture paths inside this fresh session.
for(const mode of ['cache','recover'])for(const mutation of ['valid','project-junction','directory-junction','hardlink','oversized']){
 const projectId='case-'+fixtures.length,runId='run',sourceUrl='http://127.0.0.1:19991/bridge-fixture/final-review',key=digest(JSON.stringify({projectId,runId,sourceUrl})),id='go-local-document:'+key;
 const relativePath='research/go-local/'+runId+'/'+key+'.json',project=path.join(session,'projects',projectId),dir=path.join(project,'research/go-local',runId),file=path.join(project,relativePath);
 fs.mkdirSync(dir,{recursive:true});
 const text='Synthetic saved document. No acquisition or model call.',fetchedAt='2026-10-21T00:00:00.000Z';
 const document={sourceUrl,finalUrl:sourceUrl,title:'Synthetic document',text,excerpt:text,fetchedAt,contentHash:digest(text),sourceType:'USER_URL',sourceCapture:{provider:'go-local-owned-fixture',documentArtifactId:id,sourceUrl,finalUrl:sourceUrl,fetchedAt,contentHash:digest(text),truncated:false}};
 const bytes=Buffer.from(JSON.stringify(document)),receipt={version:'go-local-publication-v1',id,projectId,runId,sourceUrl,relativePath,sha256:digest(bytes),sizeBytes:bytes.length};
 fs.writeFileSync(file,bytes,{flag:'wx'});fs.writeFileSync(file+'.publication.json',JSON.stringify(receipt),{flag:'wx'});
 if(mutation==='project-junction'){const other=project+'-owned-target';fs.renameSync(owned(project),owned(other));fs.symlinkSync(owned(other),owned(project),'junction');}
 if(mutation==='directory-junction'){const other=dir+'-owned-target';fs.renameSync(owned(dir),owned(other));fs.symlinkSync(owned(other),owned(dir),'junction');}
 if(mutation==='hardlink')fs.linkSync(file,file+'.alias');
 if(mutation==='oversized')fs.writeFileSync(file,Buffer.alloc(65537,120));
 fixtures.push({mode,mutation,projectId,runId,sourceUrl,record:{id,projectId,kind:'OTHER',relativePath,immutable:true,mimeType:'application/json',integrityStatus:mode==='cache'?'READY':'PENDING',sha256:mode==='cache'?digest(bytes):undefined,sizeBytes:mode==='cache'?bytes.length:undefined,createdAt:fetchedAt}});
}
fs.writeFileSync(path.join(session,'fixtures.json'),JSON.stringify(fixtures,null,2));
const log=fs.createWriteStream(path.join(session,'evidence/suite.log'),{flags:'wx'});
const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,'--test','--test-concurrency=1',path.join(root,'dist/tests/pr1-final-review.test.js')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;log.write(b);process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;log.write(b);process.stderr.write(b);});
child.once('error',error=>{fs.writeFileSync(path.join(session,'evidence/runner-failed.json'),JSON.stringify({message:error.message,code:error.code}));process.exitCode=1;});
child.once('close',(code,signal)=>{
 log.end();const exit={pid:child.pid,closed:true,code,signal};fs.writeFileSync(path.join(session,'evidence/suite-exit.json'),JSON.stringify(exit));
 if(code!==0){process.exitCode=code??1;return;}
 const pass=Number(/# pass (\d+)/.exec(stdout)?.[1]);if(pass!==27||!/# fail 0\b/.test(stdout)||!/# skipped 0\b/.test(stdout))throw Error('INCOMPLETE_ASSERTIONS');
 const files=['src/application/services/douyin-read-evidence-audit.ts','src/application/services/operations-evidence-reader.ts','src/application/services/douyin-operations-schedule-service.ts','src/application/services/douyin-retrospective-service.ts','src/adapters/research/go-local-research-provider.ts','scripts/run-pr1-final-review.mjs','tests/pr1-final-review.test.ts','scripts/isolation-guard.mjs'];
 const sourceHashes=Object.fromEntries(files.map(file=>[file,digest(fs.readFileSync(path.join(root,file)))]));
 fs.writeFileSync(path.join(session,'evidence/final-acceptance.json'),JSON.stringify({status:'PASS_PR1_FINAL_SAVED_EVIDENCE_GAPS',pass,fail:0,exit,sourceHashes,transport:'IN_MEMORY_PORTS_AND_NEW_LOCAL_FILES',applicationDatabaseQueries:0,realGoCalls:0,egoHostCalls:0,realBrowserCalls:0,modelCalls:0,acquisitionCalls:0},null,2),{flag:'wx'});
});
