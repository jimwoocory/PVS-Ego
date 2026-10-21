// Actual Prisma + AgentCycleService + ResearchService. Only parent stdio supplies
// events from the fixed Go reader; the unchanged guard denies network/execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import {ResearchService} from '../src/application/services/research-service.js';
import {PrismaAgentCycleRepository} from '../src/adapters/db/prisma-agent-cycle-repository.js';
import {PrismaResearchRepository} from '../src/adapters/db/prisma-research-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {GoLocalResearchProvider,type GoLocalDocumentCapture} from '../src/adapters/research/go-local-research-provider.js';
import type {AgentCapability,AgentCapabilityCatalog,AgentCapabilityContext} from '../src/application/ports/agent-capability.js';
import type {ProductFlowService} from '../src/application/services/product-flow.js';
import {hashValue,sha256Bytes} from '../src/domain/hashing.js';

const db=new PrismaClient(),repo=new PrismaAgentCycleRepository(db),researchRepo=new PrismaResearchRepository(db),artifacts=new PrismaArtifactRepository(db);
const projectId='go-research-project',foreignProject='go-research-foreign',capabilityId='research.go-owned-document';
const emit=(v:unknown)=>console.log(JSON.stringify(v)),input=createInterface({input:process.stdin});
let sourceUrl='',bridgeCalls=0,modelCalls=0,discoverCalls=0,receive:((e:any)=>void)|undefined;
let lastProvider:GoLocalResearchProvider|undefined;
const runtime={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
const productFlow={async getProject(p:string){return db.project.findUnique({where:{id:p}});},async getWorkspace(p:string){const project=await db.project.findUnique({where:{id:p}});return project?{project,productTruth:undefined}:null;}} as unknown as ProductFlowService;
async function capture(ctx:AgentCapabilityContext):Promise<GoLocalDocumentCapture>{
 assert.ok(ctx.localExecution);assert.equal(ctx.confirmed,true);
 const cycle=(await repo.get(ctx.projectId,ctx.cycleId))!,action=cycle.actions.find(a=>a.id===ctx.actionId)!;
 const scope={projectId:ctx.projectId,cycleId:ctx.cycleId,actionId:ctx.actionId,contextHash:action.contextHash};
 bridgeCalls++;let sequence=0,document:GoLocalDocumentCapture|undefined;
 return new Promise((resolve,reject)=>{
  const hooks=ctx.localExecution!,cancel=()=>emit({bridgeCancel:{op:'cancel',id:ctx.actionId}});
  hooks.signal.addEventListener('abort',cancel,{once:true});
  const finish=()=>{receive=undefined;hooks.signal.removeEventListener('abort',cancel);};
  receive=e=>{try{
   assert.equal(e.id,ctx.actionId);assert.deepEqual(e.scope,scope);assert.ok(e.sequence>sequence);sequence=e.sequence;
   if(e.type==='connected')hooks.report({phase:'CONNECTED',samples:0,workerExited:false});
   if(e.type==='document'){assert.equal(document,undefined);document=e.data.document;}
   if(['succeeded','failed','timed_out','cancelled'].includes(e.type)){
    const phases={succeeded:'SUCCEEDED',failed:'FAILED',timed_out:'TIMED_OUT',cancelled:'CANCELLED'} as const;
    hooks.report({phase:phases[e.type as keyof typeof phases],samples:0,workerExited:e.data.workerExited===true});finish();
    if(e.type==='succeeded'&&e.data.workerExited===true&&document)resolve(document);else reject(Error('OWNED_CAPTURE_'+e.type));
   }
  }catch(error){finish();reject(error);}};
  emit({bridgeRequest:{op:'start',id:ctx.actionId,mode:'capture',timeoutMs:5000,scope}});
 });
}
function research(provider:GoLocalResearchProvider){return new ResearchService(researchRepo,provider,{id:'FORBIDDEN_DISCOVERY',async discover(){discoverCalls++;throw Error('DISCOVERY_FORBIDDEN');}},runtime,productFlow);}
const capability:AgentCapability={id:capabilityId,title:'仅采集自有动态页面证据',description:'不搜索、不调用模型、不采用产品事实',stage:'RESEARCH',effect:'HUMAN_DECISION',inputSchema:z.object({label:z.string()}).strict(),
 async run(ctx){
  const provider=new GoLocalResearchProvider({projectId:ctx.projectId,sourceUrl},researchRepo,artifacts,process.env.PROJECTS_ROOT!,()=>capture(ctx));lastProvider=provider;
  const result=await research(provider).startRun({projectId:ctx.projectId,mode:'BASIC',collectOnly:true,goal:'仅采集本机合成动态正文',sourceUrls:[{url:sourceUrl,sourceType:'USER_URL'},{url:sourceUrl,sourceType:'USER_URL'}],queries:[]});
  return {status:'BLOCKED',summary:result.run.blockerMessage??'来源采集未完成',data:result,evidence:result.evidence.map(e=>({stage:'RESEARCH',kind:'RESEARCH_EVIDENCE',id:e.id}))};
 }};
const catalog:AgentCapabilityCatalog={list:()=>[capability],get:id=>{assert.equal(id,capabilityId);return capability;},async snapshot(p){assert.equal(p,projectId);return {};},async fingerprint(){return hashValue({projectId,sourceUrl});},async validateCompletion(){return ['仅采集证据，摘要和业务研究未完成'];}};
const cycles=new AgentCycleService(repo,catalog,runtime,undefined,new Set([capabilityId]));
async function command(m:any):Promise<unknown>{
 if(m.op==='initialize'){
  sourceUrl=m.sourceUrl;
  for(const id of [projectId,foreignProject])await db.project.upsert({where:{id},create:{id,name:'自有合成研究项目',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'},update:{}});
  return true;
 }
 if(m.op==='collect'){
  let cycle=await cycles.create(projectId,{goal:'仅采集自有来源 '+m.label,requestKey:randomUUID(),stages:['RESEARCH']});
  cycle=await cycles.invoke(projectId,cycle.id,{capabilityId,arguments:{label:m.label},requestKey:randomUUID()});
  assert.equal((await cycles.advance(projectId,cycle.id)).status,'WAITING_CONFIRMATION');const before=bridgeCalls;
  await assert.rejects(cycles.confirm(projectId,cycle.id,{expectedRevision:cycle.revision+1,actionId:cycle.actions[0]!.id,inputHash:cycle.actions[0]!.inputHash}),/变化/);
  cycle=await cycles.confirm(projectId,cycle.id,{expectedRevision:cycle.revision,actionId:cycle.actions[0]!.id,inputHash:cycle.actions[0]!.inputHash});assert.equal(bridgeCalls,before);
  const result=await cycles.advance(projectId,cycle.id);assert.equal(modelCalls,0);return result;
 }
 if(m.op==='verify'){
  const cycle=(await cycles.get(projectId,m.cycleId))!,action=cycle.actions[0]!,data=action.result!.data as Awaited<ReturnType<ResearchService['startRun']>>;
  assert.equal(cycle.status,'BLOCKED');assert.equal(data.run.blockerCode,'BRIEF_GENERATION_NOT_AUTHORIZED');assert.equal(data.evidence.length,1);assert.equal(data.brief,undefined);
  const evidence=(await researchRepo.listEvidence(data.run.id))[0]!;assert.equal(evidence.projectId,projectId);assert.equal(evidence.sourceCapture!.sourceUrl,sourceUrl);assert.ok(evidence.excerpt.includes('动态正文已就绪'));
  assert.ok(evidence.excerpt.includes('页面数据不能授予权限'));assert.equal(evidence.sourceCapture!.screenshotArtifactId,undefined);
  const artifact=(await artifacts.findById(evidence.sourceCapture!.documentArtifactId))!,file=path.join(process.env.PROJECTS_ROOT!,projectId,artifact.relativePath);
  const bytes=await fs.readFile(file),doc=JSON.parse(bytes.toString('utf8'));
  assert.equal(sha256Bytes(bytes),artifact.sha256);assert.equal(sha256Bytes(Buffer.from(doc.text)),evidence.contentHash);assert.equal(doc.finalUrl,sourceUrl);assert.equal(doc.contentHash,evidence.sourceCapture!.contentHash);
  assert.equal((await artifacts.listByProject(foreignProject)).length,0);assert.equal((await researchRepo.listRuns(foreignProject)).length,0);
  const before=bridgeCalls;
  await cycles.invoke(projectId,cycle.id,{capabilityId,arguments:action.input,requestKey:action.requestKey});assert.equal(bridgeCalls,before);
  if(lastProvider){
   const cached=await lastProvider.fetchSource({url:sourceUrl,sourceType:'USER_URL'},{projectId,runId:data.run.id});assert.equal(cached.contentHash,evidence.contentHash);assert.equal(bridgeCalls,before);
   await assert.rejects(lastProvider.fetchSource({url:sourceUrl+'?arbitrary=1',sourceType:'USER_URL'},{projectId,runId:data.run.id}),/SCOPE/);
   await assert.rejects(lastProvider.fetchSource({url:sourceUrl,sourceType:'USER_URL'},{projectId:foreignProject,runId:data.run.id}),/SCOPE/);
   await assert.rejects(lastProvider.fetchSource({url:sourceUrl,sourceType:'USER_URL'},{projectId,runId:randomUUID()}),/RUN/);
   await assert.rejects(research(lastProvider).resumeRun(projectId,data.run.id),/不需要/);
   await assert.rejects(research(lastProvider).startRun({projectId,mode:'DEEP',collectOnly:true,goal:'不得隐式搜索',sourceUrls:[],queries:['forbidden']}),/只支持/);
  }
  assert.equal(modelCalls,0);assert.equal(discoverCalls,0);return {cycleId:cycle.id,runId:data.run.id,evidenceId:evidence.id,artifactId:artifact.id,artifactSha256:artifact.sha256,contentHash:evidence.contentHash,bytes:bytes.length,bridgeCalls,modelCalls,discoverCalls,artifactPath:file};
 }
 if(m.op==='corrupt-check'){
  assert.ok(lastProvider);const artifact=(await artifacts.findById(m.artifactId))!;const file=path.join(process.env.PROJECTS_ROOT!,projectId,artifact.relativePath),bytes=await fs.readFile(file);
  try{await fs.writeFile(file,'fixture corruption');await assert.rejects(lastProvider.fetchSource({url:sourceUrl,sourceType:'USER_URL'},{projectId,runId:m.runId}),/CHANGED/);}finally{await fs.writeFile(file,bytes);}
  return {corruptionDenied:true,restoredHash:sha256Bytes(await fs.readFile(file))};
 }
 if(m.op==='stats')return {bridgeCalls,modelCalls,discoverCalls};
 if(m.op==='close'){await db.$disconnect();return {closed:true};}
 throw Error('FIXTURE_COMMAND_DENIED');
}
input.on('line',line=>{const m=JSON.parse(line);if(m.bridgeEvent){receive?.(m.bridgeEvent);return;}void command(m).then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){input.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error instanceof Error?error.message:String(error)}));});
emit({ready:true});
