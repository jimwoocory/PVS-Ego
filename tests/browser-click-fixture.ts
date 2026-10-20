// Isolated native-browser click fixture; no external providers or account data.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {PrismaProductFlowRepository} from "../src/adapters/db/prisma-product-flow-repository.js";
import {PrismaArtifactRepository} from "../src/adapters/db/prisma-artifact-repository.js";
import {PrismaFinalOutputRepository} from "../src/adapters/db/prisma-final-output-repository.js";
import {PrismaPublishRepository} from "../src/adapters/db/prisma-publish-repository.js";
import {PrismaBrowserPublishCheckpoints} from "../src/adapters/db/prisma-browser-publish-checkpoints.js";
import {PrismaReferenceVideoRepository} from "../src/adapters/db/prisma-reference-video-repository.js";
import {PrismaAiSettingsRepository} from "../src/adapters/db/prisma-ai-settings-repository.js";
import {PrismaWorkflowRepository} from "../src/adapters/db/prisma-workflow-repository.js";
import {PrismaGenerationRepository} from "../src/adapters/db/prisma-generation-repository.js";
import {PrismaReviewRepository} from "../src/adapters/db/prisma-review-repository.js";
import {PrismaProviderAuditRepository} from "../src/adapters/db/prisma-provider-audit-repository.js";
import {PrismaDouyinOpsRepository} from "../src/adapters/db/prisma-douyin-ops-repository.js";
import {PrismaDouyinCollectionRepository} from "../src/adapters/db/prisma-douyin-collection-repository.js";
import {PrismaDouyinOperationsScheduleRepository} from "../src/adapters/db/prisma-douyin-operations-schedule-repository.js";
import {PrismaAgentCycleRepository} from "../src/adapters/db/prisma-agent-cycle-repository.js";
import {ProductFlowService} from "../src/application/services/product-flow.js";
import {ReferenceVideoAnalysisService} from "../src/application/services/reference-video-analysis.js";
import {AiSettingsService} from "../src/application/services/ai-settings-service.js";
import {AiRuntimeRouter} from "../src/adapters/ai/ai-runtime-router.js";
import {AiGenerationService} from "../src/application/services/ai-generation.js";
import {HermesProductDirectorGenerator} from "../src/adapters/ai/hermes-product-director-generator.js";
import {PublishBridgeService} from "../src/application/services/publish-bridge-service.js";
import {PublishProviderRegistry} from "../src/application/services/publish-provider-registry.js";
import {DouyinBrowserAutomationProvider} from "../src/adapters/publish/douyin-browser-automation-provider.js";
import {DouyinMetricService} from "../src/application/services/douyin-metric-service.js";
import {DouyinCommentService} from "../src/application/services/douyin-comment-service.js";
import {DouyinCollectionService} from "../src/application/services/douyin-collection-service.js";
import {DouyinOperationsScheduleService} from "../src/application/services/douyin-operations-schedule-service.js";
import {DouyinRetrospectiveService} from "../src/application/services/douyin-retrospective-service.js";
import {DouyinCreativeFeedbackService} from "../src/application/services/douyin-creative-feedback-service.js";
import {DouyinOpsDashboardService} from "../src/application/services/douyin-ops-dashboard-service.js";
import {DouyinAccountBindingService} from "../src/application/services/douyin-account-binding-service.js";
import {DouyinWorkBindingService} from "../src/application/services/douyin-work-binding-service.js";
import {PvsAgentCapabilities} from "../src/application/services/pvs-agent-capabilities.js";
import {AgentCycleService} from "../src/application/services/agent-cycle-service.js";
import {LocalArtifactStore} from "../src/adapters/store/local-artifact-store.js";
import {hashValue,sha256Text} from "../src/domain/hashing.js";
import {LocalBrowserPublishRuntime} from "./fixtures/browser-publish-runtime.js";
import {directorCase} from "./model-aware-fixtures.js";
import {confirmScriptDraft} from "../src/application/services/review-actions.js";
import {ProductDirectorService} from "../src/application/services/product-director.js";
import {observationsForDouyinPage} from "../src/application/services/douyin-read-evidence-audit.js";
import {sha256Bytes} from "../src/domain/hashing.js";

const session=process.env.PVS_ISOLATION_SESSION!,projects=process.env.PROJECTS_ROOT!,evidence=path.join(session,'evidence');
const manifest=JSON.parse(await fs.readFile(path.join(session,'media-manifest.json'),'utf8'));
assert.equal(manifest.contract,'LOCAL_SYNTHETIC_DECODED_MEDIA_ONLY');
const db=new PrismaClient();assert.equal(await db.project.count(),0);
const id='isolated-business-'+randomUUID(),now=new Date().toISOString(),awemeId='7900000000000000001';
const artifacts=new PrismaArtifactRepository(db),flowRepo=new PrismaProductFlowRepository(db),flow=new ProductFlowService(flowRepo),finals=new PrismaFinalOutputRepository(db),pubRepo=new PrismaPublishRepository(db),ops=new PrismaDouyinOpsRepository(db),runs=new PrismaDouyinCollectionRepository(db),profiles=new PrismaReferenceVideoRepository(db);
const rehash=(v:any)=>{delete v.contentHash;v.contentHash=hashValue(v);return v;};
await flow.createProject({id,name:'仅本地合成 · 浏览器点击与取消验收（无真实上传发布）',status:'READY_TO_PUBLISH',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16',createdAt:now,updatedAt:now});
const c=directorCase(15000),truth=c.input.productTruth;truth.id=randomUUID();truth.projectId=id;rehash(truth);
const batch=c.input.creativeBatch;batch.id=randomUUID();batch.projectId=id;batch.productTruthRef={entityType:'ProductTruth',entityId:truth.id,version:truth.version,hash:truth.contentHash};rehash(batch);
const script=c.input.script;script.id=randomUUID();script.projectId=id;script.productTruthRef=batch.productTruthRef;script.creativeBatchRef={entityType:'CreativeBatch',entityId:batch.id,version:1,hash:batch.contentHash};rehash(script);
const plan=await new HermesProductDirectorGenerator({id:'FIXED_SYNTHETIC_SEED_NO_MODEL',version:'1',async generateJson(){return c.proposal;}}).generate(c.input);
for(const [entityType,entity] of [['ProductTruth',truth],['CreativeBatch',batch],['ScriptDraft',script],['ProductionPlan',plan]] as const)await flowRepo.commitVersion({version:{id:entity.id,projectId:id,entityType,entityKey:entityType==='CreativeBatch'?'creative-batch':entityType,version:entity.version,status:entity.status,contentHash:entity.contentHash,data:entity},staleEntityTypes:[],projectPatch:{}});
await db.project.update({where:{id},data:{currentProductTruthId:truth.id,currentProductTruthVersion:1,currentProductTruthHash:truth.contentHash,currentCreativeBatchId:batch.id,currentCreativeBatchVersion:1,currentCreativeBatchHash:batch.contentHash,selectedCreativeId:batch.selectedCreativeId,currentScriptId:script.id,currentScriptVersion:1,currentScriptHash:script.contentHash,currentProductionPlanId:plan.id,currentProductionPlanVersion:plan.version,currentProductionPlanHash:plan.contentHash}});
const before=await flow.getWorkspace(id),store=new LocalArtifactStore(path.join(projects,id),artifacts);
const referenceArtifact=await store.writeImmutable({id:randomUUID(),projectId:id,kind:'OTHER',relativePath:'reference-video/synthetic-local.mp4',mimeType:'video/mp4',immutable:true,bytes:await fs.readFile(manifest.file)});
await assert.rejects(store.writeImmutable({id:randomUUID(),projectId:id,kind:'OTHER',relativePath:referenceArtifact.relativePath,immutable:true,bytes:Buffer.from('overwrite')}),/already exists/);
assert.equal(sha256Bytes(await fs.readFile(store.resolveArtifactPath(referenceArtifact.relativePath))),manifest.sha256);
assert.equal((await fs.stat(store.resolveArtifactPath(referenceArtifact.relativePath))).nlink,1);
await assert.rejects(async()=>fs.link(manifest.file,path.join(projects,id,'forbidden-link')),/ISOLATION_LINK_CREATION_DENIED/);
await assert.rejects(async()=>(globalThis as any)[Symbol.for('pvs.isolation.boundary.v1')].publishImmutableFile({tempPath:manifest.file,targetPath:path.resolve(projects,'../../../../__pvs_forbidden__/dev.db'),sha256:manifest.sha256}),/ISOLATION_/);
const requests:any[]=[],reads:any[]=[],httpLog:any[]=[];let directorProposal=c.proposal,forbiddenModelCalls=0;
const fixed:any={id:'FIXED_IN_PROCESS_TEST_DOUBLE_NO_MODEL',version:'1',async generateJson(request:any){
 requests.push(structuredClone(request));
 if(request.input.sampledFrames)return {analysisConfidence:'MEDIUM',hook:{firstThreeSecondsPattern:'合成色块文字',structuralPurpose:'本地接线验证'},pacing:{overall:'静态色块',estimatedShotCount:1},shotLanguage:{shotSizes:['全景'],cameraPositions:['正面'],cameraMovements:[],compositionPatterns:['文字']},productAppearance:{firstAppearanceMs:null,visibilityPattern:'无真实产品',showcasePattern:'无'},sellingPointPattern:[],dialogueNarrationStructure:'invented speech must be discarded',audioBgMusicStructure:'invented music must be discarded',ctaPattern:'无',reusableStylePrinciples:['仅结构参考'],frameObservations:request.input.sampledFrames.slice(0,-2).map((f:any,i:number)=>({timestampMs:f.timestampMs,observation:'蓝色合成画面',visibleText:i===1?'L0CAL':'LOCAL',confidence:i===1?'LOW':'HIGH',textStatus:i===1?'UNCERTAIN':'READABLE'}))};
 if(/Generate 4-6 marketing creative concepts/.test(request.task))return {concepts:Array.from({length:4},(_,i)=>({title:'合成接线候选 '+i,targetAudience:'仅本地验收',painPoint:'验证输入引用',hook:'先呈现情境',coreSellingPoint:'Feature one',narrativePattern:'情境再展示',expectedDurationMs:15000,productShowcaseStrategy:'保留原产品',generationRisk:'LOW',requiredFactIds:['fact-1']}))};
 if(request.context?.step==='SCRIPT')return {beats:[{purpose:'PRODUCT',text:'Feature one',estimatedDurationMs:15000,requiredFactIds:['fact-1']}]};
 if(request.context?.step==='DIRECTOR')return directorProposal;
 throw Error('UNEXPECTED_FIXED_TEST_REQUEST:'+request.task);
}};
const media:any={async probeReferenceVideo(file:string){assert.equal(sha256Bytes(await fs.readFile(file)),manifest.sha256);return manifest.info;},async sampleReferenceFrames(input:any){assert.equal(sha256Bytes(await fs.readFile(input.filePath)),manifest.sha256);for(const frame of manifest.frames)assert.equal(sha256Bytes(await fs.readFile(frame.path)),frame.sha256);return manifest.frames.map(({path,timestampMs,mimeType}:any)=>({path,timestampMs,mimeType}));},async createReferenceVideoBrowserPreview(){throw Error('UNEXPECTED_PREVIEW_REQUIRED');}};
const reference=new ReferenceVideoAnalysisService(profiles,artifacts,fixed,projects,media),feedback=new DouyinCreativeFeedbackService(ops,flow),ai=new AiGenerationService(fixed,undefined,p=>feedback.context(p));
const profile=await reference.analyzeUpload({projectId:id,artifactId:referenceArtifact.id,originalFilename:'local-fixture-no-upload.mp4'});
assert.equal(profile.observation!.audio.status,'NOT_OBSERVED');assert.equal(profile.observation!.frameObservations[1]!.textStatus,'UNCERTAIN');assert.equal(profile.observation!.frameObservations.length,8);assert.doesNotMatch(profile.dialogueNarrationStructure,/invented/);
assert.deepEqual(profile.observation!.frames.map(f=>f.timestampMs),manifest.frames.map((f:any)=>f.timestampMs));
assert.equal((await reference.analyzeUpload({projectId:id,artifactId:referenceArtifact.id})).id,profile.id);assert.equal(requests.length,1);
const newBatch=await ai.generateCreativeBatch(truth,2,15000,profile);
const newScript=confirmScriptDraft(await ai.generateScriptDraft({truth,batch:newBatch,selectedCreativeId:newBatch.concepts[0]!.id,version:2,targetDurationMs:15000,referenceVideoProfile:profile}));
directorProposal=structuredClone(c.proposal);directorProposal.scenes[0]!.sourceBeatIds=[newScript.beats[0]!.id];for(const clip of directorProposal.scenes.flatMap(s=>s.clips)){clip.sourceBeatIds=[newScript.beats[0]!.id];for(const segment of clip.segments)segment.sourceBeatIds=[newScript.beats[0]!.id];}
const newPlan=await new ProductDirectorService(new HermesProductDirectorGenerator(fixed)).generate({productTruth:truth,creativeBatch:newBatch,selectedCreativeId:newBatch.concepts[0]!.id,script:newScript,projectTargetDurationMs:15000,referenceVideoProfile:profile});
for(const request of requests.slice(1,4)){assert.deepEqual(request.input.referenceVideoProfile.observation,profile.observation);assert.match(request.instructions,/audio NOT_OBSERVED/);assert.ok(!request.media?.length);}
for(const candidate of [newBatch,newScript,newPlan])assert.equal(candidate.referenceVideoProfileRef!.hash,profile.contentHash);
const tampered=structuredClone(profile);tampered.observation!.frameObservations[0]!.visibleText='tampered';await assert.rejects(ai.generateCreativeBatch(truth,3,15000,tampered),/哈希/);assert.equal(requests.length,4);
const finalArtifact=await store.writeImmutable({id:randomUUID(),projectId:id,kind:'FINAL_VIDEO',relativePath:'final/synthetic.mp4',mimeType:'video/mp4',immutable:true,bytes:await fs.readFile(manifest.file)});
const assembly=await finals.createAssembly({id:randomUUID(),projectId:id,productionPlanHash:plan.contentHash,selectedClipIds:['synthetic'],inputArtifactIds:[finalArtifact.id],inputArtifactHashes:[finalArtifact.sha256!],outputArtifactId:finalArtifact.id,outputArtifactHash:finalArtifact.sha256!,status:'ACCEPTED',createdAt:now,acceptedAt:now});
const publisher=new LocalBrowserPublishRuntime(),checkpoints=new PrismaBrowserPublishCheckpoints(db),bridge=new PublishBridgeService(flow,artifacts,finals,pubRepo,new PublishProviderRegistry([new DouyinBrowserAutomationProvider(publisher)]),projects,{runtime:publisher,checkpoints});
const pkg=(await bridge.createPackage({projectId:id,title:'本地合成预检',description:'仅合成状态机，不是真实上传发布',publicBaseUrl:'http://127.0.0.1'})).package;
const binding=await ops.upsertWorkBinding({id:randomUUID(),projectId:id,awemeId,source:'HISTORICAL_WORK',opsAccountUid:'synthetic-uid',status:'BOUND',confidence:'USER_CONFIRMED',workDescription:'合成历史样本，不代表已审核成片已发布',boundAt:now,createdAt:now,updatedAt:now});
function page(kind:'COMMENTS'|'REPLIES',cursor:string,count:number,parentCid?:string):any{
 const second=cursor!=='0',child=kind==='REPLIES',cid=child?(second?'2002':'2001'):(second?'1002':'1001'),hasMore=!second;
 const rawComment:any={cid,aweme_id:awemeId,reply_id:parentCid??'0',root_comment_id:parentCid??cid,reply_to_reply_id:child&&second?'2001':'0',...(!child?{digg_count:0,reply_comment_total:second?0:2}:{})};
 const normalized:any={cid,awemeId,uid:'local-viewer',nickname:'合成评论',text:child?'合成回复：情境说明':'合成问题：使用情境是什么？',diggCount:0,replyCount:child?0:second?0:2,parentCid:parentCid??'',platformCreatedAt:'2026-10-19T00:00:00.000Z'};
 return {comments:[normalized],cursor:second?'2':'1',hasMore,coverage:{status:'UNKNOWN',truncated:!child,reason:'合成分页夹具；平台覆盖未知'},readEvidence:{version:'douyin-read-page-v1',kind,awemeId,parentCid:parentCid??null,requestCursor:cursor,count,observedAt:new Date().toISOString(),raw:{status_code:0,cursor:second?2:1,has_more:hasMore?1:0,total:2,comments:[rawComment]}}};
}
const checkPage=page('REPLIES','0',20,'1001');const audit=observationsForDouyinPage(checkPage,{awemeId,parentCid:'1001',requestCursor:'0',count:20});assert.equal(audit.observations.get('2001')!.counts.diggCount.status,'UNKNOWN');
const wrong=structuredClone(checkPage);wrong.readEvidence.raw.comments[0].reply_id='999';assert.throws(()=>observationsForDouyinPage(wrong,{awemeId,parentCid:'1001',requestCursor:'0',count:20}),/对照失败/);
const runtime:any={async probe(){return {ready:true,status:'READY',engine:'LOCAL_SYNTHETIC',message:'仅本地固定替身'};},async identity(){return {available:true,runtimeStatus:'READY',uid:'synthetic-uid',uniqueId:publisher.accountId,nickname:'仅合成账号',secUid:'local-sec'};},async listMyWorks(){return [];},async getWork(){reads.push({kind:'metrics'});return {awemeId,description:'本地合成',author:{uid:'synthetic-uid'},publishedAt:null,durationMs:2000,externalUrl:'',metrics:{likes:0},metricAvailability:{plays:'NOT_VISIBLE',likes:'OBSERVED',comments:'NOT_PROVIDED',shares:'NOT_PROVIDED'}};},async getComments({cursor='0',count=20}:any){reads.push({kind:'comments',cursor});return page('COMMENTS',cursor,count);},async getReplies({cid,cursor='0',count=20}:any){reads.push({kind:'replies',cursor,cid});return page('REPLIES',cursor,count,cid);}};
const metricService=new DouyinMetricService(ops,runtime),commentService=new DouyinCommentService(ops,runtime),collections=new DouyinCollectionService(runs,ops,commentService);let clock=Date.now();
const schedules=new DouyinOperationsScheduleService(new PrismaDouyinOperationsScheduleRepository(db),{ops,metrics:metricService,collections,identity:()=>runtime.identity()},()=>new Date(clock));
const retrospective=new DouyinRetrospectiveService(ops,flow,{id:'FORBIDDEN_MODEL',version:'1',async generateJson(){forbiddenModelCalls++;throw Error('MODEL_FORBIDDEN');}},runs);
const dashboard=new DouyinOpsDashboardService(flow,pubRepo,ops,runtime,new DouyinAccountBindingService(publisher,runtime),new DouyinWorkBindingService(),metricService,commentService,{} as any,{async latestForWork(){return [];}} as any,{} as any,retrospective,feedback,undefined,'LOCAL');
const research={async pageData(){return {};}},productInput={async latest(){return null;}},smart={async list(){return [];}};
const capabilities=new PvsAgentCapabilities({productFlow:flow,productRepo:flowRepo,artifacts,finalOutput:finals,publishRepo:pubRepo,opsRepo:ops,referenceVideo:reference,research,productInput,smartGeneration:smart,feedback,aiGeneration:ai,collections,schedules,metrics:metricService,readOpsAccount:()=>runtime.identity(),projectsRoot:projects,publicBaseUrl:'http://127.0.0.1'} as any);
const cycles=new AgentCycleService(new PrismaAgentCycleRepository(db),capabilities,{id:'FIXED_LOCAL_PLANNER_NO_MODEL',version:'1',async generateJson(){return {action:'ASK_USER',question:'仅隔离验收'};}});
const settings=new AiSettingsService(new PrismaAiSettingsRepository(db),{async get(){return null;},async has(){return false;}} as any);
const timeline={async readiness(){return {allowed:true,existingTimeline:true,acceptedCount:1,skippedCount:0,unresolvedCount:0};},async latestTimeline(){return {id:'synthetic-timeline',projectId:id,status:'CONFIRMED',version:1,contentHash:'a'.repeat(64),productionPlanHash:plan.contentHash,clips:[],subtitles:[],overlays:[]};},async latestRenderJob(){return null;}};
const {createAppServer}=await import('../src/web/server.js');
const app=createAppServer({productFlow:flow,artifacts,finalOutput:finals,workflow:new PrismaWorkflowRepository(db),generation:new PrismaGenerationRepository(db),review:new PrismaReviewRepository(db),providerAudit:new PrismaProviderAuditRepository(db),productInput,referenceVideo:reference,aiSettings:settings,aiGeneration:ai,publishBridge:bridge,douyinBrowserRuntime:publisher,douyinOpsDashboard:dashboard,douyinCollection:collections,douyinSchedules:schedules,agentCycles:cycles,timeline,finalQc:{async latest(){return {overall:'WARN',artifactId:finalArtifact.id,artifactHash:finalArtifact.sha256,checks:[{label:'合成质检前置条件',severity:'WARN',message:'仅本地界面状态验证，不代表真实质检',code:'SYNTHETIC_UI_PRECONDITION'}]};}},snapshots:{async refresh(){}},projectsRoot:projects} as any);
let scheduleCycle='',candidateCycle='';
const seedCandidate=async()=>{const cycle=await cycles.create(id,{goal:'仅固定替身候选点击验证',requestKey:randomUUID(),stages:['STRATEGY']});await cycles.invoke(id,cycle.id,{capabilityId:'strategy.generate',arguments:{requestText:'仅固定替身验收'},requestKey:randomUUID()});return cycle.id;};
const candidateBeforeStop=await seedCandidate(),candidateAfterStop=await seedCandidate();
const seededSchedule=await cycles.create(id,{goal:'仅合成本地有界观察计划',requestKey:randomUUID(),stages:['OPERATIONS']});scheduleCycle=seededSchedule.id;
await cycles.invoke(id,scheduleCycle,{capabilityId:'operations.schedule-create',arguments:{bindingId:binding.id,awemeId,expectedAccountId:'synthetic-uid',startAt:new Date(clock).toISOString(),intervalSeconds:120,maxCaptures:2,maxReplyParents:1,pageSize:2,cadence:{version:'stage-data-v1',minIntervalSeconds:60,maxIntervalSeconds:600,maxDurationSeconds:1200,minAbsoluteGrowth:10,growthThresholdPercent:20}},requestKey:randomUUID()});
const diagnosticCounts={plain:0,confirm:0};

const state=async()=>({projectId:id,packageId:pkg.id,diagnosticCounts,candidateBeforeStop,candidateAfterStop,cycleStates:await Promise.all([scheduleCycle,candidateBeforeStop,candidateAfterStop].map(c=>cycles.get(id,c))),httpLog,referenceProfiles:(await reference.list(id)).map(p=>({id:p.id,status:p.status,frames:p.observation?.frames.length,audio:p.observation?.audio.status})),checkpoint:await checkpoints.latest(id,pkg.id),reads,inputs:requests.map(r=>({task:r.task,input:r.input,instructions:r.instructions,media:r.media?.map((m:any)=>({type:m.type,sha256:sha256Bytes(Buffer.from(m.dataBase64,'base64'))}))})),feedback:await feedback.active(id),insight:await retrospective.latest({projectId:id,awemeId}),collectionRuns:await collections.list(id),comments:await ops.listComments({projectId:id,awemeId,limit:500}),schedules:await schedules.list(id),syntheticPublisher:{uploads:publisher.uploads,submits:publisher.submits,legacy:publisher.legacyPublishes},forbiddenModelCalls,guardCounters:(globalThis as any)[Symbol.for('pvs.isolation.boundary.v1')].counters(),scheduleCycle,candidateCycle});
const controlKey=randomUUID();
const handlers=app.listeners('request');app.removeAllListeners('request');
app.on('request',async(req:any,res:any)=>{const logEntry:any={method:req.method,url:req.url,origin:req.headers.origin??null,secFetchSite:req.headers['sec-fetch-site']??null,at:new Date().toISOString()};httpLog.push(logEntry);res.once('finish',()=>{logEntry.status=res.statusCode;});
 if(req.url==='/__diagnostics'&&req.method==='GET'){
  res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PVS-Ego 本地控制诊断</title><body><main><h1>仅本地合成控制诊断</h1><p>不连接模型、平台或用户数据。</p><button id="dom-click">本地点击计数</button><output id="dom-count">0</output><button id="network-click">本地请求计数</button><button id="confirm-click">打开本地诊断确认框</button><output id="network-count">未读取</output><button id="fixture-complete">模拟本地验证完成（非真实验证码）</button><button id="fixture-pause">准备合成暂停动作</button><output id="fixture-message"></output></main><script>let clicks=0;const key=${JSON.stringify(controlKey)};document.querySelector('#dom-click').onclick=()=>document.querySelector('#dom-count').textContent=String(++clicks);async function hit(kind){const r=await fetch('/__diagnostics/hit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})});document.querySelector('#network-count').textContent=JSON.stringify(await r.json());}document.querySelector('#network-click').onclick=()=>hit('plain');document.querySelector('#confirm-click').onclick=()=>{if(confirm('PVS-Ego：只修改本地诊断计数？'))return hit('confirm');};for(const [selector,action] of [['#fixture-complete','manual-complete'],['#fixture-pause','queue-pause']])document.querySelector(selector).onclick=async()=>{const r=await fetch('/__acceptance/'+action,{method:'POST',headers:{'x-pvs-fixture':key}});document.querySelector('#fixture-message').textContent=r.ok?'本地夹具已准备':'准备失败';};</script></body></html>`);return;
 }
 if(req.url==='/__diagnostics/hit'&&req.method==='POST'){
  try{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);assert.ok(['plain','confirm'].includes(input.kind));diagnosticCounts[input.kind as 'plain'|'confirm']++;res.setHeader('content-type','application/json');res.end(JSON.stringify(diagnosticCounts));}catch(error){res.statusCode=400;res.end(String(error));}return;
 }

 if(!String(req.url).startsWith('/__acceptance/')){for(const handler of handlers)(handler as any).call(app,req,res);return;}
 try{assert.equal(req.headers['x-pvs-fixture'],controlKey);const parsed=new URL(req.url,'http://127.0.0.1'),action=parsed.pathname.slice('/__acceptance/'.length);let result:any;
  if(req.method==='GET'&&action==='state')result=await state();
  else if(req.method==='GET'&&action==='mark'){const name=parsed.searchParams.get('name')??'';assert.match(name,/^[a-z0-9-]{1,80}$/);result=await state();await fs.writeFile(path.join(evidence,'mark-'+name+'.json'),JSON.stringify(result,null,2));}
  else if(req.method==='POST'&&action==='rebind-reference')result=await reference.analyzeUpload({projectId:id,artifactId:referenceArtifact.id});
  else if(req.method==='POST'&&action==='manual-complete'){publisher.manualComplete();result={syntheticOnly:true};}
  else if(req.method==='POST'&&action==='queue-schedule'){const cycle=await cycles.create(id,{goal:'仅创建有界合成观察计划',requestKey:randomUUID(),stages:['OPERATIONS']});scheduleCycle=cycle.id;await cycles.invoke(id,cycle.id,{capabilityId:'operations.schedule-create',arguments:{bindingId:binding.id,awemeId,expectedAccountId:'synthetic-uid',startAt:new Date(clock).toISOString(),intervalSeconds:120,maxCaptures:2,maxReplyParents:1,pageSize:2,cadence:{version:'stage-data-v1',minIntervalSeconds:60,maxIntervalSeconds:600,maxDurationSeconds:1200,minAbsoluteGrowth:10,growthThresholdPercent:20}},requestKey:randomUUID()});result={cycleId:cycle.id};}
  else if(req.method==='POST'&&action==='queue-pause'){const schedule=(await schedules.list(id))[0]!;await cycles.invoke(id,scheduleCycle,{capabilityId:'operations.schedule-pause',arguments:{scheduleId:schedule.id,expectedRevision:schedule.revision},requestKey:randomUUID()});result={cycleId:scheduleCycle};}
  else if(req.method==='POST'&&action==='queue-candidate'){const cycle=await cycles.create(id,{goal:'仅固定替身候选接线，不改变选中内容',requestKey:randomUUID(),stages:['STRATEGY']});candidateCycle=cycle.id;await cycles.invoke(id,cycle.id,{capabilityId:'strategy.generate',arguments:{requestText:'仅固定替身验收'},requestKey:randomUUID()});result={cycleId:cycle.id};}
  else if(req.method==='POST'&&action==='finish'){
   const after=await flow.getWorkspace(id);for(const key of ['productTruth','creativeBatch','script','productionPlan'] as const)assert.deepEqual(after![key],before![key]);assert.equal(after!.project.selectedCreativeId,before!.project.selectedCreativeId);
   assert.equal((await feedback.active(id)).length,0);assert.deepEqual(diagnosticCounts,{plain:1,confirm:1});assert.equal(forbiddenModelCalls,0);assert.equal(await db.aiProviderConfigRecord.count(),0);assert.equal(await db.aiExecutionRecord.count(),0);assert.equal(await db.generationAttemptRecord.count(),0);const receipts=await db.publishReceiptRecord.findMany();assert.equal(receipts.length,1);assert.equal(receipts[0]!.kind,'SUBMISSION_UNKNOWN');assert.equal(receipts[0]!.trusted,false);assert.equal(receipts[0]!.externalReference,null);assert.equal(publisher.legacyPublishes,0);
   result={...(await state()),selectedContentPreserved:true,actualHumanAdoption:false,realModelCalls:0,realUploads:0,realPublication:0,u3RealBlock:'PRESERVED'};await fs.writeFile(path.join(evidence,'business-final.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(evidence,'http-log.json'),JSON.stringify(httpLog,null,2));
   setTimeout(()=>app.close(()=>{void db.$disconnect().then(()=>process.exit(0));}),50);
  }else throw Error('LOCAL_ACCEPTANCE_ACTION_NOT_ALLOWLISTED');
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const address=app.address();assert.ok(address&&typeof address!=='string');
await fs.writeFile(path.join(evidence,'ready.json'),JSON.stringify({candidateBeforeStop,candidateAfterStop,scheduleCycle,projectId:id,origin:'http://127.0.0.1:'+address.port,controlKey,session,backend:{u2ActualDecodedFrames:10,u2FixedInputStages:['REFERENCE_VIDEO_ANALYSIS','CREATIVE','SCRIPT','DIRECTOR'],tamperedProfileRejected:true,u4RawRelationAndUnknownCountValidated:true},syntheticFixture:true,realModelCalls:0,u3RealBlock:'PRESERVED'},null,2));
console.log('PVS_ISOLATED_BUSINESS_READY');

