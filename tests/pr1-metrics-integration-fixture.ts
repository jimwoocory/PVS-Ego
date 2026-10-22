// Actual blank Prisma and original services/routes. All acquisition is an inert local fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {PrismaClient} from '@prisma/client';
import {PrismaDouyinOpsRepository} from '../src/adapters/db/prisma-douyin-ops-repository.js';
import {PrismaDouyinOperationsScheduleRepository} from '../src/adapters/db/prisma-douyin-operations-schedule-repository.js';
import {PrismaDouyinCollectionRepository} from '../src/adapters/db/prisma-douyin-collection-repository.js';
import {PrismaProductFlowRepository} from '../src/adapters/db/prisma-product-flow-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {PrismaAgentCycleRepository} from '../src/adapters/db/prisma-agent-cycle-repository.js';
import {PrismaPublishRepository} from '../src/adapters/db/prisma-publish-repository.js';
import {PrismaWorkflowRepository} from '../src/adapters/db/prisma-workflow-repository.js';
import {DouyinMetricService} from '../src/application/services/douyin-metric-service.js';
import {DouyinCommentService} from '../src/application/services/douyin-comment-service.js';
import {DouyinCollectionService} from '../src/application/services/douyin-collection-service.js';
import {DouyinOperationsScheduleService} from '../src/application/services/douyin-operations-schedule-service.js';
import {DouyinRetrospectiveService} from '../src/application/services/douyin-retrospective-service.js';
import {ProductFlowService} from '../src/application/services/product-flow.js';
import {OperationsEvidenceReader} from '../src/application/services/operations-evidence-reader.js';
import {PvsAgentCapabilities} from '../src/application/services/pvs-agent-capabilities.js';
import {AgentCycleService} from '../src/application/services/agent-cycle-service.js';
import {createAppServer} from '../src/web/server.js';
import {hashValue,sha256Text} from '../src/domain/hashing.js';
import {makeProductTruth} from './fixtures.js';

const db=new PrismaClient(),ops=new PrismaDouyinOpsRepository(db),plans=new PrismaDouyinOperationsScheduleRepository(db),runs=new PrismaDouyinCollectionRepository(db),flowRepo=new PrismaProductFlowRepository(db),flow=new ProductFlowService(flowRepo),artifacts=new PrismaArtifactRepository(db);
const session=process.env.PVS_ISOLATION_SESSION!,evidence=path.join(session,'evidence'),boot=path.join(session,'cases.json'),uid='synthetic-metrics-owner';
let modelCalls=0,identityCalls=0;
const emit=(v:unknown)=>console.log(JSON.stringify(v));
const log=async(kind:string,awemeId:string)=>fs.appendFile(path.join(evidence,'reads.jsonl'),JSON.stringify({kind,awemeId,pid:process.pid})+'\n');
const forms=new Map<string,'partial'|'full'>();
const runtime:any={async identity(){identityCalls++;return {uid};},async getWork(awemeId:string){
 await log('METRICS',awemeId);const full=forms.get(awemeId)==='full';
 return {awemeId,author:{uid},description:'Local fixed metric observation',publishedAt:null,durationMs:15000,externalUrl:'',metrics:full?{plays:0,likes:0,comments:0,shares:0}:{likes:0},metricAvailability:{plays:full?'OBSERVED':'NOT_VISIBLE',likes:'OBSERVED',comments:full?'OBSERVED':'NOT_PROVIDED',shares:full?'OBSERVED':'NOT_PROVIDED',collects:'NOT_PROVIDED'}};
},async getComments(input:any){await log('COMMENTS',input.awemeId);return {comments:[],cursor:'1',hasMore:false,coverage:{status:'UNKNOWN',truncated:false,reason:'Fixed empty page; platform coverage unknown'}};},async getReplies(){throw Error('REPLIES_FORBIDDEN');}};
const metrics=new DouyinMetricService(ops,runtime),comments=new DouyinCommentService(ops,runtime),collections=new DouyinCollectionService(runs,ops,comments);
const schedules=new DouyinOperationsScheduleService(plans,{ops,metrics,collections,identity:()=>runtime.identity()});
const denied={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
const review=new DouyinRetrospectiveService(ops,flow,denied,runs),reader=new OperationsEvidenceReader(plans,runs,ops,flowRepo,artifacts,process.env.PROJECTS_ROOT!);
type Case={projectId:string;bindingId:string;awemeId:string;runId:string;snapshotId?:string;key?:string;form:'partial'|'full';storageDenied?:boolean};
async function seed(name:string,form:'partial'|'full',pending=false):Promise<Case>{
 const projectId='metrics-'+randomUUID(),bindingId=randomUUID(),awemeId=String(7900000000000000000n+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,12))),now=new Date().toISOString();
 forms.set(awemeId,form);
 await db.project.create({data:{id:projectId,name:'仅合成指标 · '+name,status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'}});
 await ops.upsertWorkBinding({id:bindingId,projectId,awemeId,opsAccountUid:uid,source:'HISTORICAL_WORK',status:'BOUND',confidence:'USER_CONFIRMED',boundAt:now,createdAt:now,updatedAt:now});
 const {contentHash,...body}={...makeProductTruth(),id:randomUUID(),projectId},truth={...body,contentHash:hashValue(body)};
 await flowRepo.commitVersion({version:{id:truth.id,projectId,entityType:'ProductTruth',entityKey:'ProductTruth',version:truth.version,status:truth.status,contentHash:truth.contentHash,data:truth},staleEntityTypes:[],projectPatch:{}});
 await db.project.update({where:{id:projectId},data:{currentProductTruthId:truth.id,currentProductTruthVersion:truth.version,currentProductTruthHash:truth.contentHash}});
 const run=await schedules.create({projectId,requestKey:randomUUID(),bindingId,awemeId,opsAccountUid:uid,startAt:now,intervalSeconds:60,maxCaptures:3,maxReplyParents:1,pageSize:2});
 const key='schedule:'+run.id+':1:metrics';
 if(pending){
  const snapshot=await metrics.refresh({projectId,bindingId,awemeId,captureKey:key});
  const changed={...run,checkpoint:{index:1,startedAt:now,replyRuns:{},parentLimitReached:false,pendingRead:{kind:'METRICS',requestKey:key,startedAt:now}}};
  await db.douyinOperationsScheduleRecord.update({where:{id:run.id},data:{dataJson:JSON.stringify(changed)}});
  return {projectId,bindingId,awemeId,runId:run.id,snapshotId:snapshot.id,key,form};
 }
  const completed=await schedules.tick(projectId,run.id);assert.equal(completed.completedCaptures,1,completed.errorMessage??'capture did not finish');await schedules.pause(projectId,run.id,completed.revision);
 const snapshot=(await ops.findMetricSnapshotByCaptureKey(projectId,key))!;assert.ok(snapshot);
 return {projectId,bindingId,awemeId,runId:run.id,snapshotId:snapshot.id,key,form};
}
async function corrupt(c:Case,kind:string){
 if(c.form==='full'){
  const row=(await db.douyinMetricSnapshotRecord.findUnique({where:{id:c.snapshotId!}}))!;
  if(kind==='full-column')await db.douyinMetricSnapshotRecord.update({where:{id:row.id},data:{likes:991}});
  if(kind==='full-hash')await db.douyinMetricSnapshotRecord.update({where:{id:row.id},data:{contentHash:'0'.repeat(64)}});
  if(kind==='full-work'||kind==='full-author'){
   const raw=JSON.parse(row.rawJson);if(kind==='full-work')raw.awemeId='7900000000000000999';else raw.authorUid='other-owner';
   const rawJson=JSON.stringify(raw);await db.douyinMetricSnapshotRecord.update({where:{id:row.id},data:{rawJson,contentHash:sha256Text(rawJson)}});
  }
  return;
 }
 const row=(await db.versionedEntity.findUnique({where:{id:c.snapshotId!}}))!,data=JSON.parse(row.dataJson);
 let hash=row.contentHash,status=row.status;
 if(kind==='partial-outer-hash')hash='f'.repeat(64);
 if(kind==='partial-rehashed-json'){const raw=JSON.parse(data.rawJson);raw.metrics.likes=777;data.likes=777;data.rawJson=JSON.stringify(raw);data.contentHash=sha256Text(data.rawJson);}
 if(kind==='partial-id')data.id=randomUUID();
 if(kind==='partial-key')data.captureKey='foreign-original-key';
 if(kind==='partial-status')status='STALE';
 if(kind==='partial-account'||kind==='partial-legacy'){
  const raw=JSON.parse(data.rawJson);if(kind==='partial-account')raw.opsAccountUid='other-owner';else{delete raw.opsAccountUid;delete raw.authorUid;}
  data.rawJson=JSON.stringify(raw);hash=data.contentHash=sha256Text(data.rawJson);
 }
 await db.versionedEntity.update({where:{id:row.id},data:{dataJson:JSON.stringify(data),contentHash:hash,status}});
}
let cases:Record<string,Case>;
try{cases=JSON.parse(await fs.readFile(boot,'utf8'));for(const c of Object.values(cases))forms.set(c.awemeId,c.form);}catch(error){
 if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await fs.writeFile(path.join(evidence,'reads.jsonl'),'');cases={};
 cases.partial=await seed('不可见与观察到的零','partial');cases.full=await seed('完整零值','full');
 cases.pending=await seed('原意图已有指标保存','partial',true);
 cases.badPending=await seed('原意图指标已损坏','partial',true);await corrupt(cases.badPending,'partial-rehashed-json');
 const kinds=['partial-outer-hash','partial-rehashed-json','partial-id','partial-key','partial-status','full-column','full-hash','full-work','partial-account','partial-legacy','full-author'];
 for(const kind of kinds){const c=await seed(kind,kind.startsWith('full-')?'full':'partial');c.storageDenied=!['partial-account','partial-legacy','full-author'].includes(kind);await corrupt(c,kind);cases[kind]=c;}
 await fs.writeFile(boot,JSON.stringify(cases,null,2));
}
const catalog=new PvsAgentCapabilities({productFlow:flow,productRepo:flowRepo,opsRepo:ops,artifacts,projectsRoot:process.env.PROJECTS_ROOT!,publicBaseUrl:'http://127.0.0.1',schedules,collections,feedback:{async context(){return [];}},research:{async pageData(){return {runs:[],evidence:[],brief:null};}},smartGeneration:{async list(){return [];}},finalOutput:{async latestAssembly(){return null;}},publishRepo:new PrismaPublishRepository(db)} as any);
const cycles=new AgentCycleService(new PrismaAgentCycleRepository(db),catalog,denied);
const app=createAppServer({productFlow:flow,agentCycles:cycles,operationsEvidence:reader,douyinSchedules:schedules,artifacts,projectsRoot:process.env.PROJECTS_ROOT!,workflow:new PrismaWorkflowRepository(db),productInput:{async latest(){return null;}}} as any);
const requests:Array<{method?:string;url?:string;status:number}>=[],handlers=app.listeners('request');app.removeAllListeners('request');
app.on('request',(req,res)=>{const entry={method:req.method,url:req.url,status:0};requests.push(entry);res.once('finish',()=>entry.status=res.statusCode);for(const h of handlers)(h as any).call(app,req,res);});
await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const address=app.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
async function observed(){
 const tables=await Promise.all([db.project.findMany({orderBy:{id:'asc'}}),db.versionedEntity.findMany({orderBy:{id:'asc'}}),db.douyinMetricSnapshotRecord.findMany({orderBy:{id:'asc'}}),db.douyinOperationsScheduleRecord.findMany({orderBy:{id:'asc'}}),db.douyinCollectionRunRecord.findMany({orderBy:{id:'asc'}}),db.douyinInsightRecord.findMany({orderBy:{id:'asc'}}),db.agentCycleRecord.findMany({orderBy:{id:'asc'}})]);
 const reads=(await fs.readFile(path.join(evidence,'reads.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {digest:hashValue(tables),modelCalls,identityCalls,reads,requests,providers:await db.aiProviderConfigRecord.count(),executions:await db.aiExecutionRecord.count(),attempts:await db.generationAttemptRecord.count(),partial:await plans.get(cases.partial!.projectId,cases.partial!.runId),workspace:await flow.getWorkspace(cases.partial!.projectId)};
}
const ready={origin,cases};emit({ready});
const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);void(async()=>{
 const c=cases[m.name??'partial']!;
 if(m.op==='observe')return observed();
 if(m.op==='lookup')return ops.findMetricSnapshotByCaptureKey(c.projectId,c.key!);
 if(m.op==='list')return ops.listMetricSnapshots({projectId:c.projectId,awemeId:c.awemeId});
 if(m.op==='catalog')return catalog.snapshot(c.projectId);
 if(m.op==='tick')return schedules.tick(c.projectId,c.runId);
 if(m.op==='review')return m.local?review.prepareLocalReview({projectId:c.projectId}):review.generate({projectId:c.projectId});
 if(m.op==='storage')return {full:await db.douyinMetricSnapshotRecord.findMany({where:{projectId:c.projectId}}),partial:await db.versionedEntity.findMany({where:{projectId:c.projectId,entityType:'DouyinMetricPartialSnapshot'}})};
 if(m.op==='close'){const result=await observed();await new Promise<void>(resolve=>{app.close(()=>resolve());app.closeAllConnections();});await db.$disconnect();lines.close();process.stdin.destroy();return result;}
 throw Error('COMMAND_DENIED');
 })().then(result=>emit({requestId:m.requestId,result}),error=>emit({requestId:m.requestId,error:String(error)}));});
