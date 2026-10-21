// Fixed saved records and files only; the runner installs the unchanged guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {OperationsEvidenceReader} from '../src/application/services/operations-evidence-reader.js';
import {DouyinOperationsScheduleService} from '../src/application/services/douyin-operations-schedule-service.js';
import {DouyinRetrospectiveService} from '../src/application/services/douyin-retrospective-service.js';
import {GoLocalResearchProvider} from '../src/adapters/research/go-local-research-provider.js';
import {hashValue,sha256Text} from '../src/domain/hashing.js';
import {operationsScheduleInputSchema,operationsScheduleSchema} from '../src/domain/douyin-operations-schedule.js';
import {makeProductTruth} from './fixtures.js';
import type {DouyinMetricSnapshot} from '../src/domain/douyin-ops.js';
import type {ArtifactRepository} from '../src/application/ports/artifact-repository.js';
import type {ResearchRepository} from '../src/application/ports/research-repository.js';
const now='2026-10-21T00:00:00.000Z',projectId='project-1',awemeId='7900000000000000001',uid='synthetic-uid';
const binding={id:'binding',projectId,awemeId,opsAccountUid:uid,status:'BOUND'};
function snapshot(mutation:string):DouyinMetricSnapshot{
 const raw:any={awemeId,metrics:{likes:0},metricAvailability:{plays:'NOT_VISIBLE',likes:'OBSERVED',comments:'NOT_PROVIDED',shares:'NOT_PROVIDED',collects:'NOT_PROVIDED'},opsAccountUid:uid,authorUid:uid,durationMs:15000};
 const value:any={id:'snapshot',projectId,bindingId:'binding',awemeId,captureKey:'schedule:plan:1:metrics',capturedAt:now,likes:0,metricAvailability:structuredClone(raw.metricAvailability),durationMs:15000,createdAt:now};
 if(mutation==='value')value.likes=700;
 if(mutation==='availability')value.metricAvailability.plays='NOT_PROVIDED';
 if(mutation==='account')raw.opsAccountUid='different-uid';
 if(mutation==='author')raw.authorUid='different-uid';
 if(mutation==='work')raw.awemeId='7900000000000000099';
 if(mutation==='binding')value.bindingId='another-binding';
 if(mutation==='capture-key')value.captureKey='schedule:another-plan:1:metrics';
 if(mutation==='duration')value.durationMs=99999;
 if(mutation==='negative')value.likes=-1;
 value.rawJson=mutation==='malformed'?'null':JSON.stringify(raw);value.contentHash=sha256Text(value.rawJson);
 if(mutation==='hash')value.contentHash='f'.repeat(64);
 return value;
}
function plan(){
 const input=operationsScheduleInputSchema.parse({projectId,requestKey:'fixture',bindingId:binding.id,awemeId,opsAccountUid:uid,startAt:now,intervalSeconds:60,maxCaptures:3,maxReplyParents:1,pageSize:2});
 return operationsScheduleSchema.parse({id:'plan',input,inputHash:hashValue(input),revision:1,status:'PAUSED',executionProtocol:'operations-read-intent-v1',completedCaptures:0,nextAt:now,consecutiveFailures:0,history:[],checkpoint:{index:1,startedAt:now,metricsSnapshotId:'snapshot',replyRuns:{},parentLimitReached:false},createdAt:now,updatedAt:now});
}
for(const mutation of ['valid','value','availability','account','author','work','binding','capture-key','duration','negative','malformed','hash'])test('saved metric inspection: '+mutation,async()=>{
 const saved=snapshot(mutation),run=plan();let writes=0;
 const schedules:any={get:async()=>structuredClone(run),inspectLease:async()=>({revision:run.revision,state:'FREE'})};
 const ops:any={findWorkBindingById:async()=>binding,findMetricSnapshotByCaptureKey:async()=>saved,createMetricSnapshot:async()=>{writes++;throw Error('WRITE_FORBIDDEN');}};
 const reader=new OperationsEvidenceReader(schedules,{} as any,ops,{} as any,{} as any,process.env.PROJECTS_ROOT!,()=>new Date(now));
 const before=JSON.stringify({saved,run}),result=await reader.schedule(projectId,run.id);
 if(mutation==='valid'){assert.equal(result?.status,'VERIFIED');if(result?.status==='VERIFIED'){assert.equal(result.metrics[0]!.likes,0);assert.equal(result.metrics[0]!.plays,undefined);assert.equal(result.metrics[0]!.metricAvailability?.plays,'NOT_VISIBLE');}}
 else {assert.deepEqual(result,{status:'UNVERIFIABLE',code:'SCHEDULE_METRICS_CHANGED'});}
 assert.equal(JSON.stringify({saved,run}),before);assert.equal(writes,0);
});
for(const mode of ['pending-recovery','fresh-result'])test('invalid metrics cannot advance original plan: '+mode,async()=>{
 let run=plan();run.status='SCHEDULED';run.checkpoint!.metricsSnapshotId=undefined;
 if(mode==='pending-recovery')run.checkpoint!.pendingRead={kind:'METRICS',requestKey:'schedule:plan:1:metrics',startedAt:now};
 let refreshes=0,commentReads=0;
 const repo:any={get:async()=>structuredClone(run),claim:async()=>run={...run,status:'RUNNING',revision:run.revision+1},assertLease:async()=>{},save:async(next:any)=>run=structuredClone({...next,revision:next.revision+1}),release:async()=>{}};
 const service=new DouyinOperationsScheduleService(repo,{ops:{findWorkBindingById:async()=>binding,findMetricSnapshotByCaptureKey:async()=>snapshot('value'),listComments:async()=>{commentReads++;return [];}} as any,metrics:{refresh:async()=>{refreshes++;return snapshot('value');}},collections:{start:async()=>{commentReads++;throw Error('READ_FORBIDDEN');}} as any,identity:async()=>({uid})},()=>new Date(now));
 const result=await service.tick(projectId,'plan');assert.equal(result.status,'BLOCKED');assert.equal(result.errorCode,'READ_OUTCOME_UNKNOWN');assert.ok(result.checkpoint?.pendingRead);assert.equal(result.checkpoint?.metricsSnapshotId,undefined);assert.equal(result.history.length,0);assert.equal(commentReads,0);assert.equal(refreshes,mode==='pending-recovery'?0:1);
});
for(const mutation of ['availability','account','author'])test('retrospective rejects changed saved provenance before model: '+mutation,async()=>{
 let modelCalls=0,saves=0;const truth=makeProductTruth();
 const service=new DouyinRetrospectiveService({latestWorkBinding:async()=>binding,listMetricSnapshots:async()=>[snapshot(mutation)],listComments:async()=>[],createInsight:async()=>{saves++;throw Error('SAVE_FORBIDDEN');}} as any,{getWorkspace:async()=>({project:{currentProductTruthRef:{hash:truth.contentHash}},productTruth:truth})} as any,{id:'FORBIDDEN',version:'1',generateJson:async()=>{modelCalls++;throw Error('MODEL_FORBIDDEN');}});
 await assert.rejects(service.generate({projectId}),/指标/);assert.equal(modelCalls,0);assert.equal(saves,0);
});
const cases=JSON.parse(await fs.readFile(path.join(process.env.PVS_ISOLATION_SESSION!,'fixtures.json'),'utf8'));
for(const fixture of cases)test('Go local '+fixture.mode+': '+fixture.mutation,async()=>{
 let captures=0,marks=0;const record=structuredClone(fixture.record);
 const artifacts={findById:async()=>structuredClone(record),markReady:async(_id:string,fields:unknown)=>{marks++;Object.assign(record,fields,{integrityStatus:'READY'});return record;}} as unknown as ArtifactRepository;
 const repo={findRun:async()=>({id:fixture.runId,projectId:fixture.projectId,mode:'BASIC',status:'BLOCKED'})} as unknown as ResearchRepository;
 const provider=new GoLocalResearchProvider({projectId:fixture.projectId,sourceUrl:fixture.sourceUrl},repo,artifacts,process.env.PROJECTS_ROOT!,async()=>{captures++;throw Error('ACQUISITION_FORBIDDEN');});
 const before=JSON.stringify(record),source={url:fixture.sourceUrl,sourceType:'USER_URL' as const},scope={projectId:fixture.projectId,runId:fixture.runId};
 const action=()=>fixture.mode==='cache'?provider.fetchSource(source,scope):provider.recoverPublishedSource(source,scope);
 if(fixture.mutation==='valid'){const document=await action();assert.match(document.text,/Synthetic saved document/);assert.equal(marks,fixture.mode==='recover'?1:0);}
 else {await assert.rejects(action());assert.equal(JSON.stringify(record),before);assert.equal(marks,0);}
 assert.equal(captures,0);
});
