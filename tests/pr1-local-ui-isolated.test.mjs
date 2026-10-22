import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_PR1_LOCAL_UI_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
test('saved product inputs and original Agent permission gates on a fresh guarded application',{timeout:90000},async t=>{
 const database=path.join(session,'blank.db'),db=new DatabaseSync(database),results=[];
 for(const dir of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const sql=path.join(root,'prisma/migrations',dir,'migration.sql');if(fs.existsSync(sql))db.exec(fs.readFileSync(sql,'utf8'));}
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Project').get().n,0);
 const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
 const child=spawn(process.execPath,[path.join(root,'tests/pr1-local-ui-fixture.mjs')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',errors='',ready;child.stdout.on('data',b=>{output+=b;for(const line of output.split(/\r?\n/)){try{const r=JSON.parse(line);if(r.ready)ready=r;}catch{}}});child.stderr.on('data',b=>errors+=b);
 const completion=once(child,'close').then(([code,signal])=>({pid:child.pid,closed:true,code,signal}));let closed;
 const shutdown=async()=>{if(!closed){child.stdin.end('close\n');closed=await Promise.race([completion,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('CHILD_EXIT_TIMEOUT')),10000);timer.unref();})]);}return closed;};
 t.after(async()=>{try{await shutdown();}finally{db.close();fs.writeFileSync(path.join(session,'evidence/child.json'),JSON.stringify({exit:closed,output,errors},null,2));}});
 const started=Date.now();while(!ready){assert.ok(Date.now()-started<15000,errors);await new Promise(resolve=>setTimeout(resolve,20));}
 const request=async(method,url,body)=>{const r=await fetch(ready.origin+url,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const text=await r.text();let value;try{value=JSON.parse(text);}catch{}return {status:r.status,text,value};};
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});assert.ok(passed,name);};
 const png={name:'synthetic-one-pixel.png',mimeType:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
 let project,foreign,current,foreignInput,cycle;
 const fields={productName:'Synthetic local C9',brand:'Synthetic brand',featureDescription:'Synthetic pixels and facts only; no model or platform.',deferTruth:true,forbiddenChanges:[{field:'color',severity:'HARD',description:'Keep synthetic blue'},{field:'shape',severity:'SOFT',description:'Keep synthetic shape'}]};
 const save=(p,body)=>request('POST','/api/projects/'+p.id+'/product-input/generate-truth',body);
 const reuse=()=>({...fields,brand:'Updated local brand',orderedImages:[{existingArtifactId:current.assets[0].artifactId}],existingLogoArtifactId:current.assets.find(a=>a.type==='logo')?.artifactId,expectedInputHash:current.contentHash});
 await check('create and reload project; save only input with image and logo, no truth or model',async()=>{
  project=(await request('POST','/api/projects',{name:'Synthetic C9 HTTP',targetDurationMs:15000})).value.project;
  foreign=(await request('POST','/api/projects',{name:'Synthetic foreign scope',targetDurationMs:15000})).value.project;
  const r=await save(project,{...fields,images:[png],logo:png});assert.equal(r.status,201,r.text);current=r.value.productInput;assert.equal(current.assets.length,2);assert.equal(r.value.pendingTruth,true);
  const list=await request('GET','/api/projects');assert.ok(list.value.projects.some(p=>p.id===project.id));
  foreignInput=(await save(foreign,{...fields,images:[png]})).value.productInput;
 });
 await check('product page rehydrates images, logo, original hash and forbidden-change list',async()=>{
  const page=await request('GET','/projects/'+project.id+'/product');assert.equal(page.status,200);assert.ok(page.text.includes(current.contentHash));for(const asset of current.assets)assert.ok(page.text.includes('/api/artifacts/'+asset.artifactId+'/content'));assert.ok(page.text.includes('Keep synthetic shape'));
 });
 await check('text-only update keeps exact material IDs and avoids duplicate user-input artifacts',async()=>{
  const ids=current.assets.map(a=>a.artifactId),before=db.prepare("SELECT COUNT(*) AS n FROM ArtifactRecord WHERE projectId=? AND kind='USER_INPUT'").get(project.id).n;
  const r=await save(project,reuse());assert.equal(r.status,201,r.text);current=r.value.productInput;assert.equal(current.version,2);assert.deepEqual(current.assets.map(a=>a.artifactId),ids);assert.equal(current.brand,'Updated local brand');assert.equal(current.forbiddenChanges.length,2);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ArtifactRecord WHERE projectId=? AND kind='USER_INPUT'").get(project.id).n,before);
 });
 await check('stale or absent snapshot hash, foreign and duplicate material IDs fail before saving',async()=>{
  const invalid=[{...reuse(),expectedInputHash:'0'.repeat(64)},{...reuse(),expectedInputHash:undefined},{...reuse(),orderedImages:[{existingArtifactId:foreignInput.assets[0].artifactId}]},{...reuse(),orderedImages:[{existingArtifactId:current.assets[0].artifactId},{existingArtifactId:current.assets[0].artifactId}]}];
  const before=db.prepare('SELECT COUNT(*) AS n FROM ArtifactRecord').get().n;for(const input of invalid){const r=await save(project,input);assert.equal(r.status,400,r.text);}assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ArtifactRecord').get().n,before);
 });
 await check('corrupt and missing retained file block reuse without changing latest input',async()=>{
  const row=db.prepare('SELECT relativePath FROM ArtifactRecord WHERE id=?').get(current.assets[0].artifactId),file=path.join(session,'projects',project.id,row.relativePath),bytes=fs.readFileSync(file);
  try{fs.writeFileSync(file,'synthetic corruption');assert.equal((await save(project,reuse())).status,400);}finally{fs.writeFileSync(file,bytes);}
  const missing=file+'.owned-missing';fs.renameSync(file,missing);try{assert.equal((await save(project,reuse())).status,400);}finally{fs.renameSync(missing,file);}
  const r=await save(project,reuse());assert.equal(r.status,201,r.text);current=r.value.productInput;
 });
 await check('mixed replacement and reuse preserves explicit image order and removes omitted logo',async()=>{
  const old=current.assets[0].artifactId;const r=await save(project,{...fields,orderedImages:[{upload:{...png,name:'synthetic-new.png'}},{existingArtifactId:old}],expectedInputHash:current.contentHash});assert.equal(r.status,201,r.text);const removedLogo=current.assets.find(a=>a.type==='logo').artifactId;current=r.value.productInput;assert.equal(current.assets.length,2);assert.equal(current.assets[1].artifactId,old);assert.equal(current.assets.some(a=>a.type==='logo'),false);
  assert.equal((await save(project,{...reuse(),existingLogoArtifactId:removedLogo})).status,400);
 });
 await check('original API queues an exact human decision; stale and cross-project confirmation denied',async()=>{
  cycle=(await request('POST','/api/projects/'+project.id+'/agent-cycles',{goal:'Synthetic confirmation queue only, no execution',requestKey:randomUUID()})).value.result;
  const queued=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+cycle.id+'/invoke',{capabilityId:'project.confirm-truth',arguments:{expectedHash:'0'.repeat(64),dispositions:{},usageRuleDispositions:{}},requestKey:randomUUID()});assert.equal(queued.status,200,queued.text);cycle=queued.value.result;assert.equal(cycle.status,'WAITING_CONFIRMATION');
  const action=cycle.actions[0],body={expectedRevision:cycle.revision,actionId:action.id,inputHash:action.inputHash};
  assert.equal((await request('POST','/api/projects/'+project.id+'/agent-cycles/'+cycle.id+'/confirm',{...body,expectedRevision:cycle.revision+1})).status,400);
  const cross=await request('POST','/api/projects/'+foreign.id+'/agent-cycles/'+cycle.id+'/confirm',body);assert.ok(cross.status>=400);
  const page=await request('GET','/projects/'+project.id+'/agent-cycle');assert.equal(page.status,200);assert.ok(page.text.includes('确认执行上方展示的这一项具体动作'));
 });
 await check('confirm only marks exact proposal; cancel persists and advance cannot run cancelled action',async()=>{
  const a=cycle.actions[0];const confirmed=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+cycle.id+'/confirm',{expectedRevision:cycle.revision,actionId:a.id,inputHash:a.inputHash});assert.equal(confirmed.status,200,confirmed.text);cycle=confirmed.value.result;assert.ok(cycle.actions[0].confirmedAt);assert.equal(cycle.actions[0].status,'PROPOSED');
  const cancelled=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+cycle.id+'/cancel',{expectedRevision:cycle.revision});assert.equal(cancelled.status,200,cancelled.text);assert.equal(cancelled.value.result.status,'CANCELLED');
  const advanced=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+cycle.id+'/advance',{});assert.equal(advanced.value.result.status,'CANCELLED');
 });
 await check('owned local evidence enters the Agent catalog through exact confirmation and an injected synthetic reader',async()=>{
  const created=await request('POST','/api/projects/'+project.id+'/agent-cycles',{goal:'Review an explicitly named synthetic local source only',requestKey:randomUUID(),stages:['RESEARCH']});assert.equal(created.status,200,created.text);
  const researchCycle=created.value.result,sourceUrl='http://127.0.0.1:3097/bridge-fixture/synthetic-local-only';
  const denied=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+researchCycle.id+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal:'Reject external source before confirmation',sourceUrls:[{url:'https://example.org/product',sourceType:'USER_URL'}]},requestKey:randomUUID()});assert.equal(denied.status,400,denied.text);
  const queued=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+researchCycle.id+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal:'Collect only synthetic local source evidence',sourceUrls:[{url:sourceUrl,sourceType:'USER_URL'}]},requestKey:randomUUID()});
  assert.equal(queued.status,200,queued.text);const pending=queued.value.result;assert.equal(pending.status,'WAITING_CONFIRMATION');assert.equal(pending.actions[0].effect,'HUMAN_DECISION');assert.ok(pending.actions[0].preview.includes(sourceUrl));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchRunRecord WHERE projectId=?').get(project.id).n,0);
  const action=pending.actions[0],confirmed=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+researchCycle.id+'/confirm',{expectedRevision:pending.revision,actionId:action.id,inputHash:action.inputHash});assert.equal(confirmed.status,200,confirmed.text);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchRunRecord WHERE projectId=?').get(project.id).n,0);
  const advanced=await request('POST','/api/projects/'+project.id+'/agent-cycles/'+researchCycle.id+'/advance',{});assert.equal(advanced.status,200,advanced.text);assert.equal(advanced.value.result.status,'WAITING_USER');assert.equal(advanced.value.result.actions[0].status,'SUCCEEDED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchRunRecord WHERE projectId=?').get(project.id).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ResearchEvidenceRecord WHERE projectId=?').get(project.id).n,1);
  const page=await request('GET','/projects/'+project.id+'/research');assert.equal(page.status,200);assert.ok(page.text.includes('Synthetic local fixture'));
 });
 for(const table of ['AiProviderConfigRecord','AiExecutionRecord','GenerationAttemptRecord'])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
 const exit=await shutdown();assert.equal(exit.code,0,errors);
 fs.writeFileSync(path.join(session,'evidence/assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,child:exit,modelCalls:0,platformCalls:0,browser:'SYNTHETIC_READER_ONLY',productionWiring:false},null,2));
});
