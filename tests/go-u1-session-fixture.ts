// Original Agent and Research/Ego provider chain, actual blank Prisma. The
// trusted parent relays only fixed Go events; this child cannot spawn or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {PrismaAgentCycleRepository} from '../src/adapters/db/prisma-agent-cycle-repository.js';
import {PrismaResearchRepository} from '../src/adapters/db/prisma-research-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import {ResearchService} from '../src/application/services/research-service.js';
import {EgoBrowserResearchProvider} from '../src/adapters/research/ego-browser-research-provider.js';
import {GoOwnedEgoResearchRuntime,type GoOwnedResearchRequest} from '../src/adapters/research/go-owned-ego-research-runtime.js';
import {BrowserResearchBlockedError} from '../src/application/ports/research-provider.js';
import type {AgentCapability,AgentCapabilityCatalog,AgentCapabilityContext} from '../src/application/ports/agent-capability.js';
import type {ProductFlowService} from '../src/application/services/product-flow.js';
import {hashValue,sha256Bytes} from '../src/domain/hashing.js';

const db=new PrismaClient(),repo=new PrismaAgentCycleRepository(db),researchRepo=new PrismaResearchRepository(db),artifacts=new PrismaArtifactRepository(db),root=process.env.PROJECTS_ROOT!;
const projectId='go-session-project',foreign='go-session-foreign',capabilityId='research.go-owned-session';
let sourceUrl='',fingerprint='',bridgeCalls=0,modelCalls=0,discoveryCalls=0;
const emit=(v:unknown)=>console.log(JSON.stringify(v)),pending=new Map<string,{events:unknown[];resolve:(v:unknown[])=>void;reject:(e:Error)=>void;cleanup:()=>void}>();
const providers=new Map<string,EgoBrowserResearchProvider>();
const runtime={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
const flow={async getProject(p:string){return db.project.findUnique({where:{id:p}});},async getWorkspace(p:string){const project=await db.project.findUnique({where:{id:p}});return project?{project}:null;}} as unknown as ProductFlowService;
function provider(runId:string,scope:{projectId:string;cycleId:string;actionId:string;contextHash:string},ctx?:AgentCapabilityContext){
 const executor=new GoOwnedEgoResearchRuntime({projectId,runId,sourceUrl,scope,executorFingerprint:fingerprint,projectsRoot:root},async(request:GoOwnedResearchRequest)=>{
  bridgeCalls++;
  return new Promise<unknown[]>((resolve,reject)=>{
   const cancel=()=>emit({bridgeCancel:{op:'cancel',id:request.id}});
   const cleanup=()=>ctx?.localExecution?.signal.removeEventListener('abort',cancel);
   if(ctx?.localExecution?.signal.aborted){reject(Error('ACTION_CANCELLED'));return;}
   ctx?.localExecution?.signal.addEventListener('abort',cancel,{once:true});
   pending.set(request.id,{events:[],resolve,reject,cleanup});emit({bridgeRequest:request});
  });
 });
 const result=new EgoBrowserResearchProvider(executor,artifacts,root,{searchUrlTemplate:sourceUrl,allowPrivateNetwork:true});providers.set(runId,result);return result;
}
const research=(web:{fetchSource:EgoBrowserResearchProvider['fetchSource']})=>new ResearchService(researchRepo,web,{id:'FORBIDDEN_DISCOVERY',async discover(){discoveryCalls++;throw Error('DISCOVERY_FORBIDDEN');}},runtime,flow);
const cap:AgentCapability={id:capabilityId,title:'自有网页会话与证据',description:'仅固定本机页面，复用原研究会话，不搜索或调用模型',stage:'RESEARCH',effect:'HUMAN_DECISION',inputSchema:z.object({label:z.string()}).strict(),async run(ctx){
 assert.equal(ctx.confirmed,true);assert.ok(ctx.localExecution);
 const cycle=(await repo.get(ctx.projectId,ctx.cycleId))!,action=cycle.actions.find(a=>a.id===ctx.actionId)!;
 const scope={projectId:ctx.projectId,cycleId:ctx.cycleId,actionId:ctx.actionId,contextHash:action.contextHash};
 ctx.localExecution.report({phase:'CONNECTED',samples:0,workerExited:false});
 const result=await research({async fetchSource(source,context){assert.ok(context);return provider(context.runId,scope,ctx).fetchOwnedSource(source,context);}}).startRun({projectId,mode:'BASIC',collectOnly:true,goal:'只采集自有会话证据',sourceUrls:[{url:sourceUrl,sourceType:'USER_URL'}],queries:[]});
 ctx.localExecution.report({phase:result.evidence.length?'SUCCEEDED':'FAILED',samples:0,workerExited:true});
 return {status:'BLOCKED',summary:result.run.blockerMessage??'等待明确继续',data:result,evidence:result.evidence.map(e=>({stage:'RESEARCH',kind:'RESEARCH_EVIDENCE',id:e.id}))};
}};
const catalog:AgentCapabilityCatalog={list:()=>[cap],get:id=>{assert.equal(id,capabilityId);return cap;},async snapshot(){return {};},async fingerprint(){return hashValue({sourceUrl,fingerprint});},async validateCompletion(){return ['摘要未授权'];}};
const cycles=new AgentCycleService(repo,catalog,runtime,undefined,new Set([capabilityId]));
async function command(m:any):Promise<unknown>{
 if(m.op==='initialize'){
  sourceUrl=m.sourceUrl;fingerprint=m.fingerprint;
  for(const id of [projectId,foreign])await db.project.upsert({where:{id},create:{id,name:'自有会话合成项目',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'},update:{}});return true;
 }
 if(m.op==='prepare'){
  let c=await cycles.create(projectId,{goal:'仅自有网页 '+m.label,requestKey:randomUUID(),stages:['RESEARCH']});c=await cycles.invoke(projectId,c.id,{capabilityId,arguments:{label:m.label},requestKey:randomUUID()});c=await cycles.advance(projectId,c.id);assert.equal(c.status,'WAITING_CONFIRMATION');return c;
 }
 if(m.op==='confirm')return cycles.confirm(projectId,m.cycleId,m.input);
 if(m.op==='advance')return cycles.advance(projectId,m.cycleId);
 if(m.op==='info'){
  const c=(await cycles.get(projectId,m.cycleId))!,data=c.actions[0]!.result!.data as Awaited<ReturnType<ResearchService['startRun']>>,runId=data.run.id;
  const state=JSON.parse(await fs.readFile(path.join(root,projectId,'research/ego',runId,'session.json'),'utf8'));
  return {cycle:c,run:await researchRepo.findRun(runId),evidence:await researchRepo.listEvidence(runId),session:state,bridgeCalls,modelCalls,discoveryCalls};
 }
 if(m.op==='reopen'){
  const c=(await repo.get(projectId,m.cycleId))!,a=c.actions[0]!,data=a.result!.data as Awaited<ReturnType<ResearchService['startRun']>>;
  provider(data.run.id,{projectId,cycleId:c.id,actionId:a.id,contextHash:a.contextHash});return data.run.id;
 }
 if(m.op==='resume'){
  const p=providers.get(m.runId);assert.ok(p);const before=bridgeCalls;
  try{const doc=await p.fetchOwnedSource({url:m.sourceUrl??sourceUrl,sourceType:'USER_URL',...(m.handle?{browserResumeHandle:m.handle}:{})},{projectId:m.projectId??projectId,runId:m.runId});return {status:'READY',document:doc,requests:bridgeCalls-before};}
  catch(error){const e=error as {result?:unknown};return {status:'BLOCKED',result:e.result??{message:(error as Error).message},requests:bridgeCalls-before};}
 }
 if(m.op==='resume-service'){
  const p=providers.get(m.runId);assert.ok(p);
  return research({fetchSource:(source,context)=>{assert.ok(context);return p.fetchOwnedSource(source,context);}}).resumeCollectionOnly(m.projectId??projectId,m.runId);
 }
 if(m.op==='verify'){
  const items=await researchRepo.listEvidence(m.runId);assert.equal(items.length,1);const e=items[0]!,proof=e.sourceCapture!;assert.equal(proof.provider,'ego-browser-research');assert.ok(proof.screenshotArtifactId);
  const records=await Promise.all([proof.documentArtifactId,proof.screenshotArtifactId!].map(id=>artifacts.findById(id)));
  for(const a of records){assert.ok(a);const bytes=await fs.readFile(path.join(root,projectId,a.relativePath));assert.equal(sha256Bytes(bytes),a.sha256);assert.equal(a.integrityStatus,'READY');}
  const png=await fs.readFile(path.join(root,projectId,records[1]!.relativePath));assert.ok(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.equal((await artifacts.listByProject(foreign)).length,0);return {evidenceId:e.id,artifactIds:records.map(a=>a!.id),pngBytes:png.length,modelCalls,discoveryCalls};
 }
 if(m.op==='stats')return {bridgeCalls,modelCalls,discoveryCalls};
 if(m.op==='partial-collection'){
  const a='http://127.0.0.1:19991/bridge-fixture/partial-first',b='http://127.0.0.1:19991/bridge-fixture/partial-second';let returned=false,fetches=0;
  const text='固定替身来源正文，不是实际页面采集。';
  const service=research({async fetchSource(source){fetches++;if(source.url===b&&!returned)throw new BrowserResearchBlockedError({status:'BLOCKED',blockerCode:'LOGIN_REQUIRED',message:'合成登录阻断',requiredUserAction:'只在合成场景模拟归还',browserState:{provider:'inert-partial-fixture',resumeToken:'opaque-partial-handle'}});return {sourceUrl:source.url,finalUrl:source.url,title:'合成部分来源',text,excerpt:text,fetchedAt:new Date().toISOString(),contentHash:sha256Bytes(Buffer.from(text)),sourceType:source.sourceType};}});
  const started=await service.startRun({projectId,mode:'BASIC',collectOnly:true,goal:'合成部分采集',sourceUrls:[{url:a,sourceType:'USER_URL'},{url:b,sourceType:'USER_URL'}],queries:[]});
  assert.equal(started.evidence.length,1);assert.equal(started.run.blockerCode,'LOGIN_REQUIRED');assert.equal(started.run.browserState?.collectionOnly,true);assert.equal(modelCalls,0);
  returned=true;const resumed=await service.resumeCollectionOnly(projectId,started.run.id);assert.equal(resumed.run.id,started.run.id);assert.equal(resumed.evidence.length,2);assert.equal(resumed.run.blockerCode,'BRIEF_GENERATION_NOT_AUTHORIZED');assert.equal(fetches,3);assert.equal(modelCalls,0);
  await assert.rejects(service.resumeCollectionOnly(projectId,started.run.id));return {evidence:resumed.evidence.length,fetches,modelCalls,runId:resumed.run.id,acquisition:'FIXED_INERT_PARTIAL_SOURCE_FIXTURE'};
 }
 if(m.op==='close'){assert.equal(pending.size,0);await db.$disconnect();return true;}
 throw Error('FIXTURE_COMMAND_DENIED');
}
const lines=createInterface({input:process.stdin});lines.on('line',line=>{
 const m=JSON.parse(line);
 if(m.bridgeEvent){const e=m.bridgeEvent,p=pending.get(e.id);if(p){p.events.push(e);if(['succeeded','failed','timed_out','cancelled','rejected'].includes(e.type)){pending.delete(e.id);p.cleanup();p.resolve(p.events);}}return;}
 void command(m).then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error.message}));
});emit({ready:true});
