import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {GoOwnedEgoResearchRuntime,type GoOwnedResearchBinding,type GoOwnedResearchRequest} from '../src/adapters/research/go-owned-ego-research-runtime.js';
import {EgoResearchError} from '../src/application/ports/ego-research-runtime.js';
import {ResearchService} from '../src/application/services/research-service.js';
import type {ResearchRepository} from '../src/application/ports/research-repository.js';
import type {ProductFlowService} from '../src/application/services/product-flow.js';
import {sha256Text} from '../src/domain/hashing.js';

const root=process.env.PROJECTS_ROOT!,session=process.env.PVS_ISOLATION_SESSION!;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('SYNTHETIC_PROTOCOL_BYTES_NOT_A_SCREENSHOT')]);
const cases=new Map<string,Awaited<ReturnType<typeof prepare>>>(),held=new Map<string,()=>void>();let calls=0;
const emit=(v:unknown)=>console.log(JSON.stringify(v));
async function continuation(name:string){
 const projectId='synthetic-continuation',runId='synthetic-run',source='https://example.invalid/requested',redirect='https://example.invalid/redirected',missing='https://example.invalid/missing',at=new Date().toISOString(),body='合成来源正文，只验证续接不会重新采集已经保存的重定向来源。';
 const first:any={id:'original-evidence',projectId,runId,sourceUrl:redirect,title:'原合成证据',fetchedAt:at,sourceType:'USER_URL',excerpt:body,summary:body,contentHash:sha256Text(body),confidence:'LOW',relatedClaims:[],status:'ACTIVE',createdAt:at,sourceCapture:{provider:'ego-browser-research',documentArtifactId:'original-document',sourceUrl:source,finalUrl:redirect,fetchedAt:at,contentHash:sha256Text(body),truncated:false}};
 if(name==='continuation-mismatch')first.sourceCapture.contentHash='0'.repeat(64);
 if(name==='continuation-foreign')first.projectId='foreign-project';
 const rows:any[]=[structuredClone(first)],fetches:string[]=[];let updates=0,models=0,discoveries=0;
 let run:any={id:runId,projectId,mode:'BASIC',status:'BLOCKED',goal:'只补缺失来源',sourceUrls:[{url:source,sourceType:'USER_URL'},{url:missing,sourceType:'USER_URL'}],queries:[],browserState:{provider:'ego-browser-research',resumeToken:'opaque-local-handle',collectionOnly:true,lastCheckedAt:at},blockerCode:'BROWSER_PROVIDER_ERROR',createdAt:at,updatedAt:at};
 const repo={async findRun(){return structuredClone(run);},async listEvidence(){return structuredClone(rows);},async createEvidence(e:unknown){rows.push(structuredClone(e));return e;},async updateRun(_id:string,patch:unknown){updates++;run={...run,...patch as object};return structuredClone(run);}} as unknown as ResearchRepository;
 const research=new ResearchService(repo,{async fetchSource(s){fetches.push(s.url);return {sourceUrl:s.url,finalUrl:s.url,title:'新缺失来源',text:body,excerpt:body,fetchedAt:at,sourceType:s.sourceType,contentHash:sha256Text(body)};}},{id:'FORBIDDEN_DISCOVERY',async discover(){discoveries++;throw Error('DISCOVERY_FORBIDDEN');}},{id:'FORBIDDEN_MODEL',version:'1',async generateJson(){models++;throw Error('MODEL_FORBIDDEN');}},{} as ProductFlowService);
 if(name==='continuation-redirect'){
  const result=await research.resumeCollectionOnly(projectId,runId);assert.deepEqual(fetches,[missing]);assert.equal(result.evidence.length,2);assert.deepEqual(result.evidence[0],first);assert.equal(result.run.blockerCode,'BRIEF_GENERATION_NOT_AUTHORIZED');assert.equal(updates,1);
 }else {await assert.rejects(research.resumeCollectionOnly(projectId,runId));assert.equal(fetches.length,0);assert.equal(updates,0);assert.deepEqual(rows,[first]);}
 assert.equal(models,0);assert.equal(discoveries,0);return {passed:true,name,fixedFetches:fetches.length,modelCalls:models,realNetworkCalls:0};
}
function stream(req:GoOwnedResearchRequest,b:GoOwnedResearchBinding,url:string,name:string):any[]{
 const data=(type:string,data?:unknown):any=>({id:req.id,type,scope:req.scope,data});
 let events:any[]=[data('started'),data('connected',{kind:'connected',instanceId:b.instanceId}),data('page',{kind:'page',spaceId:b.spaceId,targetId:b.targetId})];
 if(req.mode==='session-open')events.push(data('session',{kind:'session',binding:b}));
 else {
  events.push(data('visibility',{kind:'visibility',visibility:'visible',visibilitySource:'OWNED_HOST_LAYOUT_SNAPSHOT'}),data('document',{kind:'document',document:{sourceUrl:url,finalUrl:url,title:'合成回执',text:'固定正文只核验协议，不连接任何浏览器或平台。',fetchedAt:new Date().toISOString(),truncated:false}}));
  if(req.captureScreenshot)events.push(data('screenshot',{kind:'screenshot',png:png.toString('base64')}));
 }
 events.push(data('done',{kind:'done'}),data('succeeded',{workerStarted:true,workerExited:true}));
 const at=(type:string)=>events.find(e=>e.type===type)!;
 if(name==='short-open')events=[at('session'),at('succeeded')];
 if(name==='short-read')events=[at('document'),at('succeeded')];
 if(name.startsWith('missing-'))events=events.filter(e=>e.type!==name.slice(8));
 if(name==='host-mismatch')at('connected').data.instanceId='foreign-instance';
 if(name==='page-mismatch')at('page').data.targetId='foreign-target';
 if(name==='open-space-mismatch')at('session').data.binding={...b,spaceName:'pvs-research-other-run'};
 if(name==='duplicate-document')events.splice(5,0,{...at('document')});
 if(name==='duplicate-session')events.splice(4,0,{...at('session')});
 if(name==='document-before-page'){const doc=at('document');events=events.filter(e=>e!==doc);events.splice(2,0,doc);}
 if(name==='scope-mismatch')events[2].scope={...req.scope,projectId:'foreign-project'};
 if(name==='id-mismatch')events[2].id='foreign-request';
 if(name==='worker-not-started')at('succeeded').data.workerStarted=false;
 if(name==='worker-not-exited')at('succeeded').data.workerExited=false;
 if(name==='extra-event')events.splice(3,0,data('arbitrary-action',{kind:'arbitrary-action'}));
 if(name==='extra-terminal')events.splice(-1,0,data('failed',{workerExited:true}));
 if(name==='blocked-success')events.splice(-2,0,data('blocked',{kind:'blocked',code:'CONTROL_CHANGED'}));
 if(name==='hidden-shot')at('visibility').data.visibility='hidden';
 if(name==='untrusted-visibility')at('visibility').data.visibilitySource='PAGE_TEXT';
 if(name==='wrong-document-url')at('document').data.document.finalUrl='https://example.invalid/foreign';
 if(name==='oversized-document')at('document').data.document.text='x'.repeat(4001);
 if(name==='bad-base64')at('screenshot').data.png='!!!!';
 if(name==='oversized-base64')at('screenshot').data.png='A'.repeat(1_333_340);
 if(name==='unsolicited-shot')events.splice(-2,0,data('screenshot',{kind:'screenshot',png:png.toString('base64')}));
 if(name==='failed-control')events=[data('started'),data('blocked',{kind:'blocked',code:'CONTROL_CHANGED'}),data('done',{kind:'done'}),{...data('failed',{workerStarted:true,workerExited:true}),code:'CONTROL_CHANGED'}];
 if(name==='event-limit')events.splice(1,0,...Array.from({length:67},()=>data('connected',{kind:'connected',instanceId:b.instanceId})));
 events=events.map((e,i)=>({...e,sequence:i+1}));if(name==='sequence-mismatch')events[2].sequence=events[1].sequence;
 return events;
}
async function prepare(name:string){
 const projectId='go-'+randomUUID(),runId='run-'+randomUUID(),project=path.join(root,projectId),foreign=path.join(root,'foreign-'+randomUUID()),dir=path.join(project,'.tmp','owned'),foreignDir=path.join(foreign,'.tmp','owned');
 await fs.mkdir(dir,{recursive:true});await fs.mkdir(foreignDir,{recursive:true});
 const url='http://127.0.0.1:19991/bridge-fixture/'+randomUUID(),spaceName=`pvs-research-${projectId}-${runId}`;
 const binding:GoOwnedResearchBinding={instanceId:'synthetic-host',spaceId:1,spaceName,profileId:'Default',targetId:'synthetic-target',sessionId:'a'.repeat(32)};
 const file=path.join(dir,'page.png'),options={projectId,runId,sourceUrl:url,scope:{projectId,cycleId:'synthetic-cycle',actionId:'synthetic-action',contextHash:'b'.repeat(64)},executorFingerprint:'c'.repeat(64),projectsRoot:root};
 let localCalls=0;
 const runtime=new GoOwnedEgoResearchRuntime(options,async req=>{
  calls++;localCalls++;assert.equal(Object.isFrozen(req),true);assert.equal(Object.isFrozen(req.scope),true);if(req.binding)assert.equal(Object.isFrozen(req.binding),true);
  if(name==='path-race'){emit({held:name});await new Promise<void>(resolve=>held.set(name,resolve));held.delete(name);}
  return stream(req,binding,url,name);
 });
 const open=['valid-open','short-open','missing-session','duplicate-session','open-space-mismatch'].includes(name);
 const screenshot=['valid-shot','bad-base64','oversized-base64','hidden-shot'].includes(name)||name.startsWith('path-');
 let target=file;
 if(name==='path-existing')await fs.writeFile(file,'ORIGINAL_OWNED_SENTINEL',{flag:'wx'});
 if(name==='path-foreign')target=path.join(foreignDir,'page.png');
 if(name==='path-relative')target=path.relative(process.cwd(),file);
 if(name==='path-extension')target=path.join(dir,'alternate.txt');
 const run=()=>open?runtime.open(spaceName):runtime.read(binding,{...(screenshot?{screenshotPath:target}:{})});
 return {runtime,run,localCalls:()=>localCalls,project,dir,foreign,foreignDir,file,target,open,screenshot,binding,options};
}
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);void(async()=>{
 if(m.op==='prepare'){const f=await prepare(m.name);cases.set(m.name,f);return {project:f.project,dir:f.dir,foreign:f.foreign,foreignDir:f.foreignDir,file:f.file,target:f.target};}
 if(m.op==='continuation')return continuation(m.name);
 if(m.op==='release'){assert.ok(held.has(m.name));held.get(m.name)!();return true;}
 if(m.op==='run'){
  const f=cases.get(m.name)!,before=calls,valid=m.name.startsWith('valid-');
  if(valid){const result=await f.run();if(f.open)assert.deepEqual(result,f.binding);else assert.equal((result as {text:string}).text,'固定正文只核验协议，不连接任何浏览器或平台。');if(f.screenshot)assert.deepEqual(await fs.readFile(f.file),png);}
  else await assert.rejects(f.run(),error=>error instanceof EgoResearchError&&(m.name!=='failed-control'||error.code==='BROWSER_SESSION_EXPIRED'&&error.detailCode==='CONTROL_CHANGED'));
  const preDenied=m.name.startsWith('path-')&&m.name!=='path-race';assert.equal(f.localCalls(),preDenied?0:1);
  if(f.screenshot&&!valid){if(m.name==='path-existing')assert.equal(await fs.readFile(f.file,'utf8'),'ORIGINAL_OWNED_SENTINEL');else await assert.rejects(fs.stat(f.file));}
  return {passed:true,name:m.name,transportCalls:calls-before,realGoCalls:0,realBrowserCalls:0,modelCalls:0};
 }
 if(m.op==='close'){await fs.writeFile(path.join(session,'evidence/fixture-final.json'),JSON.stringify({transportCalls:calls,realGoCalls:0,realBrowserCalls:0,modelCalls:0}));return true;}
 throw Error('COMMAND_DENIED');
 })().then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error instanceof Error?error.stack:String(error)}));});
emit({ready:true});
