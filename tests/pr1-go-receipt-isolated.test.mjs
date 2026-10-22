import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {root,isolatedEnvironment,confined} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_PR1_GO_RECEIPT_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),sql=new DatabaseSync(database);
try{assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({newBlankDatabase:true,copiedExistingDatabase:false,applicationDatabaseQueries:0}));}finally{sql.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
test('PR #1 Go-owned receipt validation and screenshot destination boundaries',{timeout:120000},async t=>{
 const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-go-receipt-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let ready=false,closed=false,code,stdout='',stderr='';const pending=new Map(),holds=new Set(),results=[];
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',error=>stderr+=error.message);child.once('close',c=>{closed=true;code=c;for(const h of pending.values())h.reject(Error(stderr||'CHILD_CLOSED'));pending.clear();});
 createInterface({input:child.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.ready)ready=true;if(e.held)holds.add(e.held);const h=pending.get(e.requestId);if(h){pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 const until=async fn=>{const start=Date.now();while(!fn()){if(Date.now()-start>20000)throw Error('TIMEOUT '+stderr);await new Promise(r=>setTimeout(r,20));}};
 const call=(op,name)=>new Promise((resolve,reject)=>{const requestId=randomUUID();pending.set(requestId,{resolve,reject});child.stdin.write(JSON.stringify({op,name,requestId})+'\n');});
 t.after(async()=>{if(!closed){child.stdin.end();await until(()=>closed).catch(()=>child.kill());await until(()=>closed).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child.json'),JSON.stringify({pid:child.pid,closed,code,stdout,stderr},null,2));});
 await until(()=>ready||closed);assert.equal(closed,false,stderr);
 const names=['valid-open','valid-read','valid-shot','short-open','short-read','missing-started','missing-connected','missing-page','missing-session','missing-visibility','missing-done','host-mismatch','page-mismatch','open-space-mismatch','duplicate-document','duplicate-session','document-before-page','scope-mismatch','id-mismatch','sequence-mismatch','worker-not-started','worker-not-exited','extra-event','extra-terminal','blocked-success','hidden-shot','untrusted-visibility','wrong-document-url','oversized-document','bad-base64','oversized-base64','unsolicited-shot','failed-control','event-limit','path-existing','path-foreign','path-relative','path-extension','path-project-junction','path-dir-junction','path-race'];
 for(const name of names){let passed=false;await t.test(name,async()=>{
  const f=await call('prepare',name);
  if(name==='path-project-junction'){confined(f.project,session);confined(f.foreign,session);fs.renameSync(f.project,f.project+'-original');fs.symlinkSync(f.foreign,f.project,'junction');}
  if(name==='path-dir-junction'){confined(f.dir,session);confined(f.foreignDir,session);fs.renameSync(f.dir,f.dir+'-original');fs.symlinkSync(f.foreignDir,f.dir,'junction');}
  const run=call('run',name);run.catch(()=>{});
  if(name==='path-race'){await until(()=>holds.has(name));confined(f.dir,session);confined(f.foreignDir,session);fs.renameSync(f.dir,f.dir+'-original');fs.symlinkSync(f.foreignDir,f.dir,'junction');await call('release',name);}
  const result=await run;assert.equal(result.passed,true);
  if(name.startsWith('path-'))assert.equal(fs.existsSync(path.join(f.foreignDir,'page.png')),false);
  passed=true;
 });results.push({name,passed});}
 for(const name of ['continuation-redirect','continuation-mismatch','continuation-foreign']){let passed=false;await t.test(name,async()=>{assert.equal((await call('continuation',name)).passed,true);passed=true;});results.push({name,passed});}
 await call('close');child.stdin.end();await until(()=>closed);assert.equal(code,0,stderr);assert.ok(results.every(r=>r.passed));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PASS_PR1_GO_RECEIPT_AND_PATH_BOUNDARIES',pass:results.length+1,fail:0,results,children:[{pid:child.pid,closed,code}],transport:'FIXED_SYNTHETIC_JSONL_RECEIPTS',database:'NEW_BLANK_NO_APPLICATION_DB_QUERIES',realGoCalls:0,realBrowserCalls:0,modelCalls:0},null,2));
});
