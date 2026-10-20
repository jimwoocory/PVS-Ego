import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {root,isolatedEnvironment} from '../scripts/isolation-policy.mjs';

const prepared=JSON.parse(fs.readFileSync(path.join(root,'.runtime/browser-click-location.json'),'utf8'));
const session=path.join(root,'.runtime/isolation-sessions','browser-attempt-'+randomUUID()),out=path.join(session,'evidence');
for(const dir of ['evidence','projects','tmp','home/local','home/roaming','media/frames'])fs.mkdirSync(path.join(session,dir),{recursive:true});
const marker=JSON.parse(fs.readFileSync(path.join(root,'.pvs-isolation.json'),'utf8'));
fs.copyFileSync(path.join(marker.defaultSession,'session.db'),path.join(session,'session.db'));
const manifest=JSON.parse(fs.readFileSync(path.join(prepared.session,'media-manifest.json'),'utf8'));
for(const item of [manifest,...manifest.frames]){
  const from=item.file??item.path,bytes=fs.readFileSync(from),to=path.join(session,'media',...(item.file?[]:['frames']),path.basename(from));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256);fs.writeFileSync(to,bytes,{flag:'wx'});if(item.file)item.file=to;else item.path=to;
}
fs.writeFileSync(path.join(session,'media-manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(root,'.runtime/browser-click-active.json'),JSON.stringify({session,outputRoot:out,preparedEvidence:prepared.outputRoot},null,2));
const env=isolatedEnvironment({PVS_ISOLATION_SESSION:session,DATABASE_URL:'file:'+path.join(session,'session.db').replaceAll('\\','/'),PROJECTS_ROOT:path.join(session,'projects')});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const postCount=(state,suffix)=>state.httpLog.filter(x=>x.method==='POST'&&x.url.endsWith(suffix)).length;

test('actual isolated browser clicks, native confirm cancellation and business persistence', {timeout:2100000},async t=>{
  const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/isolation-guard.mjs')).href,path.join(root,'dist/tests/browser-click-fixture.js')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',closed=false,code;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exit=once(child,'exit').then(([c])=>{closed=true;code=c;});
  t.after(async()=>{if(!closed){child.kill();await exit;}fs.writeFileSync(path.join(out,'process.log'),output);fs.writeFileSync(path.join(out,'process-exit.json'),JSON.stringify({pid:child.pid,code,closed}));});
  const started=Date.now();while(!fs.existsSync(path.join(out,'ready.json'))){assert.equal(closed,false,output);assert.ok(Date.now()-started<30000,output);await pause(100);}
  const ready=JSON.parse(fs.readFileSync(path.join(out,'ready.json'),'utf8'));assert.match(ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);console.log('PVS_NATIVE_BROWSER_READY '+ready.origin+'/__diagnostics');
  const browserFile=path.join(out,'browser-done.json'),begin=Date.now();
  while(!fs.existsSync(browserFile)){assert.equal(closed,false,output);assert.ok(Date.now()-begin<2000000,'browser timeout; preserve incomplete acceptance');await pause(500);}
  const browser=JSON.parse(fs.readFileSync(browserFile,'utf8'));assert.equal(browser.status,'PASS');assert.equal(browser.actualBrowserClicks,true);
  const mark=name=>JSON.parse(fs.readFileSync(path.join(out,'mark-'+name+'.json'),'utf8'));
  await t.test('ordinary DOM and fetch clicks work; an open native dialog keeps click pending until handled',()=>{
    assert.equal(browser.dialogDependency.clickPendingWhileDialogOpen,true);assert.equal(browser.dialogDependency.type,'confirm');
    assert.equal(mark('diag-after-cancel').diagnosticCounts.confirm,0);assert.equal(mark('diag-after-accept').diagnosticCounts.confirm,1);assert.equal(mark('diag-after-accept').diagnosticCounts.plain,1);
  });
  await t.test('U5 cancel promotion makes no POST or feedback; accept produces exactly one',()=>{
    const before=mark('promote-before'),cancel=mark('promote-cancel'),accept=mark('promote-accept');
    assert.equal(before.feedback.length,0);assert.equal(cancel.feedback.length,0);assert.equal(postCount(cancel,'/creative-feedback/promote'),postCount(before,'/creative-feedback/promote'));assert.equal(accept.feedback.length,1);assert.equal(postCount(accept,'/creative-feedback/promote'),postCount(before,'/creative-feedback/promote')+1);
  });
  await t.test('Agent action cancellation preserves revision and permission; acceptance creates one bounded schedule',()=>{
    const before=mark('schedule-before'),cancel=mark('schedule-cancel'),accept=mark('schedule-accept'),get=s=>s.cycleStates.find(x=>x.id===s.scheduleCycle);
    assert.equal(get(before).status,'WAITING_CONFIRMATION');assert.equal(get(cancel).revision,get(before).revision);assert.equal(get(cancel).status,'WAITING_CONFIRMATION');assert.equal(cancel.schedules.length,0);assert.equal(get(accept).status,'READY');assert.equal(postCount(accept,'/confirm'),postCount(before,'/confirm')+1);
    const saved=mark('schedule-saved');assert.equal(saved.schedules.length,1);assert.equal(saved.schedules[0].input.maxCaptures,2);assert.equal(saved.schedules[0].input.cadence.minIntervalSeconds,60);
  });
  await t.test('U5 cancel deactivation preserves active input; accept removes it from next actual candidate input',()=>{
    const before=mark('stop-before'),cancel=mark('stop-cancel'),accept=mark('stop-accept');assert.equal(before.feedback.length,1);assert.equal(cancel.feedback.length,1);assert.equal(postCount(cancel,'/deactivate'),postCount(before,'/deactivate'));assert.equal(accept.feedback.length,0);assert.equal(postCount(accept,'/deactivate'),postCount(before,'/deactivate')+1);
    const inputs=mark('candidates-finished').inputs.filter(x=>/Generate 4-6/.test(x.task));assert.ok(inputs.some(x=>x.input.douyinFeedback?.length));assert.equal(inputs.at(-1).input.douyinFeedback?.length??0,0);
  });
  await t.test('U3 checkbox consent, synthetic handoff/resume and unknown submission are driven from original UI',()=>{
    assert.equal(mark('u3-unconfirmed').syntheticPublisher.uploads,0);assert.equal(mark('u3-challenge').checkpoint.phase,'WAITING_PLATFORM_VERIFICATION');assert.equal(mark('u3-handoff').checkpoint.phase,'WAITING_USER_CONTROL');assert.equal(mark('u3-restored').checkpoint.phase,'RESTORED_WAITING_CONTINUE');assert.equal(mark('u3-submit-unconfirmed').syntheticPublisher.submits,0);assert.equal(mark('u3-unknown').checkpoint.phase,'SUBMISSION_UNKNOWN');assert.equal(mark('u3-unknown').syntheticPublisher.submits,1);assert.equal(mark('u3-unknown').syntheticPublisher.legacy,0);
  });
  await t.test('U2/U4 original clicks persist deactivation, pagination and unknown evidence',()=>{
    const state=mark('u2-u4-finished');assert.ok(!state.referenceProfiles.some(p=>p.status==='ACTIVE'));assert.equal(state.collectionRuns.find(r=>r.kind==='COMMENTS').pages,2);assert.equal(state.collectionRuns.find(r=>r.kind==='REPLIES').pages,2);assert.equal(state.collectionRuns[0].coverage.status,'UNKNOWN');assert.equal(state.comments.filter(c=>c.parentCid).length,2);
  });
  const final=await new Promise((resolve,reject)=>{const request=http.request(new URL('/__acceptance/finish',ready.origin),{method:'POST',headers:{'x-pvs-fixture':ready.controlKey}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>{try{assert.equal(res.statusCode,200,body);resolve(JSON.parse(body));}catch(error){reject(error);}});});request.on('error',reject);request.end();});
  await exit;assert.equal(code,0,output);
  await t.test('no real executor or external model; original selections remain and browser evidence is retained',()=>{
    assert.equal(final.forbiddenModelCalls,0);assert.equal(final.realModelCalls,0);assert.equal(final.realUploads,0);assert.equal(final.realPublication,0);assert.equal(final.selectedContentPreserved,true);assert.equal(final.actualHumanAdoption,false);assert.equal(final.u3RealBlock,'PRESERVED');assert.equal(browser.pageErrors.length,0);assert.ok(browser.screenshots.length>=5);assert.ok(browser.mobile.every(x=>x.overflow<=2));
  });
  fs.writeFileSync(path.join(out,'browser-click-acceptance.json'),JSON.stringify({status:'PASS_NATIVE_BROWSER_CLICKS_AND_CANCEL_IN_ISOLATION',browser,u3RealEditor:'BLOCKED_PRESERVED',realModelCalls:0,realUploads:0,materialEgress:0,paidGeneration:0,realPublication:0,commentReplies:0,productionDeployment:false,actualHumanAdoption:false},null,2));
});
