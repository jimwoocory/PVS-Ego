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
const session=process.env.PVS_PR1_CACHE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db'),sql=new DatabaseSync(database);
try{for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))sql.exec(fs.readFileSync(file,'utf8'));}const tables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>sql.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({businessRows:0,fromMigrations:true,copiedExistingDatabase:false}));}finally{sql.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
test('PR #1 saved research cache and read-only evidence integrity',{timeout:120000},async t=>{
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-research-cache-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let ready,closed=false,code,stdout='',stderr='';const pending=new Map(),results=[];
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',e=>stderr+=e.message);p.once('close',c=>{closed=true;code=c;for(const h of pending.values())h.reject(Error(stderr||'CHILD_CLOSED'));pending.clear();});
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.ready)ready=e.ready;const h=pending.get(e.requestId);if(h){pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}});
 const until=async fn=>{const start=Date.now();while(!fn()){if(Date.now()-start>20000)throw Error('TIMEOUT '+stderr);await new Promise(r=>setTimeout(r,20));}};
 const call=(op,name)=>new Promise((resolve,reject)=>{const requestId=randomUUID();pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,name,requestId})+'\n');});
 t.after(async()=>{if(!closed){p.stdin.end();await until(()=>closed).catch(()=>p.kill());await until(()=>closed).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child.json'),JSON.stringify({pid:p.pid,closed,code,stdout,stderr},null,2));});
 await until(()=>ready||closed);assert.equal(closed,false,stderr);
 for(const name of ['valid','long-document','title','final-url','time','excerpt','content-hash','json','other-run-document','other-run-image','immutable','mime','kind','size','oversized','image-mime','legacy-proof','hardlink','junction','missing','ownership']){
  let passed=false;await t.test(name,async()=>{
   const f=await call('prepare',name);let expected=f.expected;
   if(name==='hardlink'){confined(f.file,session);fs.linkSync(f.file,f.file+'.alias');expected=409;}
   if(name==='junction'){const dir=path.dirname(f.file);confined(dir,session);const target=dir+'-original';fs.renameSync(dir,target);fs.symlinkSync(target,dir,'junction');expected=409;}
   const before=await call('state');const response=await fetch(ready.origin+f.api),value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));
   if(expected===409){assert.equal(value.result.status,'BLOCKED');assert.equal(value.result.text,undefined);}else {assert.equal(value.result.status,'VERIFIED');assert.equal(value.result.screenshot,'NOT_VERIFIED');}
   const page=await fetch(ready.origin+f.page);assert.equal(page.status,expected);const html=await page.text();assert.ok(html.includes(expected===409?'证据暂不可核验':'正文与文件完整性已核验'));
   await call('cache',name);const after=await call('state');assert.equal(after.digest,before.digest);assert.equal(after.captures,before.captures);passed=true;
  });results.push({name,passed});
 }
 await call('close');p.stdin.end();await until(()=>closed);assert.equal(code,0,stderr);assert.ok(results.every(r=>r.passed));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PASS_PR1_RESEARCH_CACHE_INTEGRITY',pass:results.length+1,fail:0,results,children:[{pid:p.pid,closed,code}],database:'ACTUAL_NEW_SQLITE_PRISMA',http:'ACTUAL_ORIGINAL_READ_ONLY_ROUTES',runtime:'FIXED_INERT_CAPTURE_NOT_A_BROWSER',modelCalls:0},null,2));
});
