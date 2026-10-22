import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {root,confined,isolatedEnvironment} from '../scripts/isolation-policy.mjs';
const session=process.env.PVS_U2_EVIDENCE_SESSION;confined(session,path.join(root,'.runtime/isolation-sessions'));
const evidence=path.join(session,'evidence'),media=path.join(session,'media'),database=path.join(session,'blank.db'),children=[],results=[];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const binaries=JSON.parse(fs.readFileSync(path.join(session,'tools.json'),'utf8')),commands=[];
function run(exe,args){const r=spawnSync(exe,args,{cwd:session,env:process.env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});commands.push({exe,args,exit:r.status});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
// VFR source has real decoded PTS. Frame extraction preserves every source frame; no fps interpolation.
const file=path.join(media,'synthetic.mp4');
run(binaries[0],['-v','error','-nostdin','-protocol_whitelist','file,pipe','-f','lavfi','-i','color=c=blue:s=160x90:r=5:d=2','-f','lavfi','-i','sine=frequency=440:duration=3','-vf',"setpts='if(lt(N,5),N/(5*TB),(1+(N-5)/3)/TB)'",'-fps_mode','vfr','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
const infoRaw=JSON.parse(run(binaries[1],['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file]));
const decoded=JSON.parse(run(binaries[1],['-v','error','-protocol_whitelist','file,pipe','-select_streams','v','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',file]));
const pts=decoded.frames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1000));assert.equal(pts.length,10);assert.ok(new Set(pts.slice(1).map((p,i)=>p-pts[i])).size>1);
run(binaries[0],['-v','error','-nostdin','-protocol_whitelist','file,pipe','-i',file,'-an','-fps_mode','passthrough','-start_number','0',path.join(media,'frames/frame-%02d.jpg')]);
const files=fs.readdirSync(path.join(media,'frames')).sort();assert.equal(files.length,10);
const video=infoRaw.streams.find(s=>s.codec_type==='video'),audio=infoRaw.streams.find(s=>s.codec_type==='audio');
const manifest={contract:'LOCAL_SYNTHETIC_DECODED_MEDIA_ONLY',file,sha256:hash(file),info:{durationMs:Math.round(Number(infoRaw.format.duration)*1000),width:video.width,height:video.height,videoCodec:video.codec_name,audioCodec:audio.codec_name,hasAudio:true,sceneCutTimestampsMs:[]},frames:files.map((name,i)=>{const pathName=path.join(media,'frames',name);return {path:pathName,timestampMs:pts[i]-pts[0],mimeType:'image/jpeg',sha256:hash(pathName)};}),commands,executables:binaries.map(file=>({file,sha256:hash(file)})),note:'Trusted local lavfi/FFmpeg only; guarded app replays verified files. Semantic outputs inert. No OCR/model inference.'};
fs.writeFileSync(path.join(session,'media-manifest.json'),JSON.stringify(manifest,null,2));
const sqlite=new DatabaseSync(database);try{for(const name of fs.readdirSync(path.join(root,'prisma/migrations')).sort()){const p=path.join(root,'prisma/migrations',name,'migration.sql');if(fs.existsSync(p))sqlite.exec(fs.readFileSync(p,'utf8'));}const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();assert.ok(tables.every(({name})=>sqlite.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n===0));fs.writeFileSync(path.join(evidence,'blank-database.json'),JSON.stringify({businessRows:0,copiedExistingDatabase:false,tables:tables.length}));}finally{sqlite.close();}
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+database.replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const begin=Date.now();while(Date.now()-begin<15000){if(fn())return;await pause(25);}throw Error('TIMEOUT');}
async function child(){
 const p=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/u2-evidence-integrity-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const c={p,events:[],stdout:'',stderr:'',closed:false,code:null,pending:new Map()};children.push(c);
 p.stdout.on('data',b=>c.stdout+=b);p.stderr.on('data',b=>c.stderr+=b);
 createInterface({input:p.stdout}).on('line',line=>{const e=JSON.parse(line);c.events.push(e);const handler=c.pending.get(e.requestId);if(handler){c.pending.delete(e.requestId);e.error?handler.reject(Error(e.error)):handler.resolve(e.result);}});
 p.once('error',e=>{c.closed=true;c.stderr+=e.message;});p.once('close',code=>{c.closed=true;c.code=code;for(const h of c.pending.values())h.reject(Error(c.stderr||'CHILD_CLOSED'));c.pending.clear();});
 c.call=(op,args={})=>new Promise((resolve,reject)=>{const requestId=randomUUID();c.pending.set(requestId,{resolve,reject});p.stdin.write(JSON.stringify({op,...args,requestId})+'\n');});
 c.stop=async()=>{await c.call('close');await until(()=>c.closed);assert.equal(c.code,0,c.stderr);};
 await until(()=>c.events.some(e=>e.ready)||c.closed);assert.equal(c.closed,false,c.stderr);return c;
}
test('U2 immutable media evidence and subsequent U4/U5 evidence gates',{timeout:120000},async t=>{
 t.after(async()=>{for(const [i,c] of children.entries()){if(!c.closed){c.p.stdin.end();await until(()=>c.closed).catch(()=>c.p.kill());}fs.writeFileSync(path.join(evidence,'child-'+i+'.json'),JSON.stringify({pid:c.p.pid,closed:c.closed,code:c.code,stdout:c.stdout,stderr:c.stderr}));}});
 const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});results.push({name,passed});};
 let c=await child(),f;
 await check('actual VFR frame bytes, exact decoded PTS and independent manifest are the analysis input',async()=>{
  f=await c.call('seed');const state=await c.call('state'),request=state.requests[0];
  assert.deepEqual(f.profile.observation.frames.map(v=>v.timestampMs),manifest.frames.map(v=>v.timestampMs));
  assert.deepEqual(request.media.map(m=>createHash('sha256').update(Buffer.from(m.dataBase64,'base64')).digest('hex')),f.profile.observation.frames.map(v=>v.sha256));
  assert.deepEqual(request.input.observation.samplingManifest,f.profile.observation.samplingManifest);assert.equal(f.profile.observation.audio.status,'NOT_OBSERVED');assert.equal(f.profile.observation.frameObservations.length,8);assert.equal(f.profile.observation.frameObservations[1].textStatus,'UNCERTAIN');assert.doesNotMatch(f.profile.dialogueNarrationStructure,/invented/);
 });
 await check('actual process restart reuses persisted evidence with zero further inference',async()=>{
  await c.stop();c=await child();assert.deepEqual(await c.call('cache',{projectId:f.projectId,artifactId:f.artifact.id}),f.profile);assert.equal((await c.call('state')).requests.length,0);
 });
 await check('Creative Script Director actual request inputs and output references preserve original evidence limitations',async()=>{const chain=await c.call('chain',{projectId:f.projectId});assert.deepEqual(chain.stages,['CREATIVE','SCRIPT','DIRECTOR']);fs.writeFileSync(path.join(evidence,'downstream-input-proof.json'),JSON.stringify(chain,null,2));});
 for(const kind of ['source','frame','manifest','missing','size','mime','status','mutable','path','row','no-manifest','timing'])await check('invalid cache refuses '+kind+' without automatic reanalysis',async()=>{
  const item=await c.call('seed'),before=(await c.call('state')).requests.length;await c.call('corrupt',{projectId:item.projectId,kind});
  await assert.rejects(c.call('latest',{projectId:item.projectId}));await assert.rejects(c.call('cache',{projectId:item.projectId,artifactId:item.artifact.id}));assert.equal((await c.call('state')).requests.length,before);
 });
 for(const kind of ['frame','stale'])await check('all downstream stages reject memory profiles after '+kind,async()=>{
  const item=await c.call('seed'),before=(await c.call('state')).requests.length;await c.call('corrupt',{projectId:item.projectId,kind});
  for(const stage of ['CREATIVE','SCRIPT','DIRECTOR'])await assert.rejects(c.call('downstream',{projectId:item.projectId,profile:item.profile,stage}));assert.equal((await c.call('state')).requests.length,before);
 });
 await check('uninjected verifier and cross-project profiles cannot call any model stage',async()=>{
  const item=await c.call('seed'),other=await c.call('seed'),before=(await c.call('state')).requests.length;
  for(const stage of ['CREATIVE','SCRIPT','DIRECTOR']){await assert.rejects(c.call('downstream',{projectId:item.projectId,profile:item.profile,stage,noVerifier:true}));await assert.rejects(c.call('downstream',{projectId:other.projectId,profile:item.profile,stage}));}assert.equal((await c.call('state')).requests.length,before);
 });
 for(const kind of ['empty','duplicate'])await check('invalid sample '+kind+' rejected before inference',async()=>{assert.equal(await c.call('invalid-sample',{kind}),true);});
 await check('source mutation during analysis never saves an active profile',async()=>{assert.equal(await c.call('analysis-race'),true);});
 for(const stage of ['CREATIVE','SCRIPT','DIRECTOR'])await check(stage+' response rejected when evidence changes during inference',async()=>{assert.equal(await c.call('downstream-race',{stage}),true);});
 for(const stage of ['SCRIPT','DIRECTOR'])await check(stage+' compliance response also rechecks evidence before returning content',async()=>{assert.equal(await c.call('compliance-race',{stage}),true);});
 await check('custom Director output cannot omit or swap the reference video version',async()=>{assert.equal(await c.call('director-output-ref'),true);});
 await check('U4 raw reply text/parent proof and U5 adopted frozen evidence validation',async()=>{fs.writeFileSync(path.join(evidence,'u4-u5-proof.json'),JSON.stringify(await c.call('operations'),null,2));});
 const final=await c.call('state');assert.equal(final.providerConfigs,0);assert.equal(final.aiExecutions,0);fs.writeFileSync(path.join(evidence,'runtime-inputs.json'),JSON.stringify(final,null,2));
 assert.ok(results.every(r=>r.passed));await c.stop();
 fs.writeFileSync(path.join(evidence,'assertion-result.json'),JSON.stringify({status:'PENDING_OBSERVED_SUITE_EXIT',pass:results.length+1,fail:0,results,children:children.map(c=>({pid:c.p.pid,closed:c.closed,code:c.code})),database:'ACTUAL_NEW_SQLITE_PRISMA',media:'LOCAL_LAVFI_REAL_VFR_DECODED_PTS',runtime:'INERT_FIXED_IN_PROCESS_NO_MODEL',selectedModelPreserved:'aihubmix/deepseek-v4.1-flash',actualModelCalls:0,actualCost:'UNKNOWN',audio:'NOT_OBSERVED',realUpload:0,realPublication:0,realReply:0,realPlatformE2E:'NOT_RUN',realU3Editor:'BLOCKED_PRESERVED',realU5Adoption:'NOT_PERFORMED'},null,2));
});
