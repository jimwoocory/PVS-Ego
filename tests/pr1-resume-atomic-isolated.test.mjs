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
const session=process.env.PVS_PR1_ATOMIC_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),database=path.join(session,'blank.db');
const db=new DatabaseSync(database);
try{for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const file=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(file))db.exec(fs.readFileSync(file,'utf8'));}
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>db.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({businessRows:0,fromMigrations:true,copiedExistingDatabase:false}));
}finally{db.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
test('PR #1 atomic original schedule and child resume regression',{timeout:90000},async t=>{
 const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/pr1-resume-atomic-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',closed=false,code,signal,ready=false;const pending=new Map(),results=[];
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.ready)ready=true;const h=pending.get(e.requestId);if(h){pending.delete(e.requestId);e.error?h.reject(Error(e.error)):h.resolve(e.result);}}catch(error){stderr+=String(error);}});
 child.once('error',error=>{stderr+=error.message;});child.once('close',(c,s)=>{closed=true;code=c;signal=s;for(const h of pending.values())h.reject(Error(stderr||'CHILD_CLOSED'));pending.clear();});
 const until=async fn=>{const started=Date.now();while(!fn()){if(Date.now()-started>15000)throw Error('TIMEOUT '+stderr);await new Promise(r=>setTimeout(r,20));}};
 const call=(op,name)=>new Promise((resolve,reject)=>{const requestId=randomUUID();pending.set(requestId,{resolve,reject});child.stdin.write(JSON.stringify({op,name,requestId})+'\n');});
 t.after(async()=>{if(!closed){child.stdin.end();await until(()=>closed).catch(()=>child.kill());await until(()=>closed).catch(()=>{});}fs.writeFileSync(path.join(evidence,'child.json'),JSON.stringify({pid:child.pid,closed,code,signal,stdout,stderr},null,2));});
 await until(()=>ready||closed);assert.equal(closed,false,stderr);
 for(const name of ['success','parent-race','child-race','write-failure','parent-lease','child-lease','missing-child','scope-work','scope-account','scope-parent','scope-pages','scope-size','scope-binding','stale-consent','parent-budget','cadence-missing','cadence-expanded','unknown-intent']){
  let passed=false;await t.test(name,async()=>{const result=await call('case',name);assert.equal(result.passed,true);passed=true;});results.push({name,passed});
 }
 await call('close');child.stdin.end();await until(()=>closed);assert.equal(code,0,stderr);assert.ok(results.every(r=>r.passed));
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PASS_PR1_ATOMIC_RESUME',pass:results.length+1,fail:0,results,children:[{pid:child.pid,closed,code}],runtime:'ACTUAL_NEW_SQLITE_PRISMA_FIXED_IDENTITY_NO_COLLECTION',modelCalls:0},null,2));
});
