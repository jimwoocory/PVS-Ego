// Actual original services, HTTP/UI fragment and blank Prisma. Publisher is an
// inert file-backed fixture: counts are synthetic, never network or video calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {PrismaClient} from '@prisma/client';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {PrismaFinalOutputRepository} from '../src/adapters/db/prisma-final-output-repository.js';
import {PrismaProductFlowRepository} from '../src/adapters/db/prisma-product-flow-repository.js';
import {PrismaPublishRepository} from '../src/adapters/db/prisma-publish-repository.js';
import {PrismaBrowserPublishCheckpoints} from '../src/adapters/db/prisma-browser-publish-checkpoints.js';
import {LocalArtifactStore} from '../src/adapters/store/local-artifact-store.js';
import {ProductFlowService} from '../src/application/services/product-flow.js';
import {PublishBridgeService} from '../src/application/services/publish-bridge-service.js';
import {PublishProviderRegistry} from '../src/application/services/publish-provider-registry.js';
import {DouyinBrowserAutomationProvider} from '../src/adapters/publish/douyin-browser-automation-provider.js';
import type {DouyinBrowserPublisherRuntime} from '../src/application/ports/douyin-browser-publisher-runtime.js';
import type {BrowserPublishScope,BrowserPageBinding,BrowserPageSnapshot,BrowserPublishPreparationRuntime} from '../src/application/ports/browser-publish-preparation.js';
import {renderBrowserPublishPreflightPanel} from '../src/web/browser-publish-preflight-ui.js';
import {createAppServer} from '../src/web/server.js';
import {hashValue,sha256Bytes} from '../src/domain/hashing.js';

const db=new PrismaClient(),artifacts=new PrismaArtifactRepository(db),finals=new PrismaFinalOutputRepository(db),packages=new PrismaPublishRepository(db),checkpoints=new PrismaBrowserPublishCheckpoints(db),flow=new ProductFlowService(new PrismaProductFlowRepository(db));
const root=process.env.PROJECTS_ROOT!,session=process.env.PVS_ISOLATION_SESSION!,emit=(v:unknown)=>console.log(JSON.stringify(v));
const counts={prepares:0,uploads:0,handoffs:0,resumes:0,inspections:0,submits:0,legacy:0};
let gateAccount=false,releaseAccount:(()=>void)|undefined,crashAfterPrepare=false,rollbackCheckpoint=false;
const pageFile=(project:string)=>path.join(root,project,'synthetic-publisher-page.json');
const readPage=(binding:BrowserPageBinding)=>fs.readFile(pageFile(binding.pageId.slice(5)),'utf8').then(raw=>JSON.parse(raw) as BrowserPageSnapshot);
async function savePage(s:BrowserPageSnapshot){await fs.writeFile(pageFile(s.binding.pageId.slice(5)),JSON.stringify(s));}
class InertPublisher implements DouyinBrowserPublisherRuntime,BrowserPublishPreparationRuntime{
 readonly staged=this;readonly identity='u3-durable-inert-runtime';
 async resolveAccountName(){return 'synthetic-profile';}
 async check(account='synthetic-profile'){
  if(gateAccount){emit({accountCheckWaiting:true});await new Promise<void>(resolve=>releaseAccount=resolve);gateAccount=false;}
  return {ok:true,account,valid:true,status:'VALID',platformUserId:'synthetic-account'};
 }
 async probe(){return {ok:true,status:'READY'};}
 async login():Promise<never>{throw Error('REAL_LOGIN_FORBIDDEN');}
 async publish():Promise<never>{counts.legacy++;throw Error('COMBINED_PUBLISH_FORBIDDEN');}
 async prepare(scope:BrowserPublishScope,video:string){
  assert.equal(sha256Bytes(await fs.readFile(video)),scope.videoSha256);counts.prepares++;counts.uploads++;emit({stage:'prepare',projectId:scope.projectId,packageId:scope.packageId});
  const s:BrowserPageSnapshot={binding:{runtimeId:this.identity,instanceId:'synthetic-instance',spaceId:'synthetic-space',pageId:'page:'+scope.projectId,documentId:randomUUID(),accountKey:scope.accountKey},account:scope.account,title:scope.title,description:scope.description,tags:scope.tags,declaration:scope.declaration,videoSha256:scope.videoSha256,uploadComplete:true,challenge:'CAPTCHA',control:'AGENT',connected:true};
  await savePage(s);if(crashAfterPrepare){emit({crashing:'AFTER_SYNTHETIC_PREPARE_BEFORE_CHECKPOINT'});process.exit(73);}return s;
 }
 async inspect(binding:BrowserPageBinding){counts.inspections++;const s=await readPage(binding);if(s.control!=='AGENT')throw Error('USER_OWNS_PAGE');return s;}
 async handoff(binding:BrowserPageBinding){const s=await this.inspect(binding);counts.handoffs++;s.control='USER';await savePage(s);}
 async resume(binding:BrowserPageBinding){counts.resumes++;return this.inspect(binding);}
 async submit(_binding:BrowserPageBinding,_scope:BrowserPublishScope):Promise<never>{counts.submits++;emit({stage:'submit'});throw Error('SYNTHETIC_RESPONSE_LOST_NO_RETRY');}
}
const runtime=new InertPublisher();
const guardedDb=new Proxy(db,{get(target,key){if(key==='$transaction')return async(fn:any)=>target.$transaction(async tx=>fn(new Proxy(tx,{get(t,k){if(k==='versionedEntity')return new Proxy(t.versionedEntity,{get(delegate,method){if(method==='create')return async(args:any)=>{if(rollbackCheckpoint&&args.data.entityType==='BrowserPublishCheckpoint'){rollbackCheckpoint=false;throw Error('INJECTED_TRANSACTION_ROLLBACK');}return delegate.create(args);};const v=Reflect.get(delegate,method);return typeof v==='function'?v.bind(delegate):v;}});return Reflect.get(t,k);}})));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
const rollbackRepo=new PrismaBrowserPublishCheckpoints(guardedDb);
function bridge(useRollback=false){return new PublishBridgeService(flow,artifacts,finals,packages,new PublishProviderRegistry([new DouyinBrowserAutomationProvider(runtime)]),root,{runtime,checkpoints:useRollback?rollbackRepo:checkpoints});}
const service=bridge();
async function createPackage(projectId:string){return (await service.createPackage({projectId,title:'合成预检标题',description:'合成说明 #本地测试',publicBaseUrl:'http://127.0.0.1'})).package;}
async function actor(projectId:string,change:string){
 const file=pageFile(projectId),s=JSON.parse(await fs.readFile(file,'utf8')) as BrowserPageSnapshot;
 if(change==='return'){s.challenge='NONE';s.control='AGENT';}
 else if(change==='account')s.account.id='changed-account';
 else if(change==='document')s.binding.documentId='changed-document';
 else if(change==='title')s.title='changed-title';
 else if(change==='disconnect')s.connected=false;
 else throw Error('ACTOR_ACTION_DENIED');
 await savePage(s);return true;
}
const requests:Array<{method?:string;url?:string;status?:number}>=[];
const app=createAppServer({productFlow:flow,publishBridge:service,artifacts,projectsRoot:root} as any),handlers=app.listeners('request');app.removeAllListeners('request');
app.on('request',(req,res)=>{void(async()=>{
 const record={method:req.method,url:req.url,status:0};requests.push(record);res.once('finish',()=>record.status=res.statusCode);
 const match=req.url?.match(/^\/fixture-panel\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)$/);
 if(req.method==='GET'&&match){
  const pkg=await packages.findPackageById(match[2]!);if(!pkg||pkg.projectId!==match[1]){res.writeHead(404).end();return;}
  const cp=await checkpoints.latest(pkg.projectId,pkg.id),panel=renderBrowserPublishPreflightPanel({projectId:pkg.projectId,accountId:'synthetic-account',packages:[pkg],checkpoints:[cp]});
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><title>U3 隔离预检</title><style>body{font-family:Arial,sans-serif;margin:24px;max-width:900px}label{display:block;margin:16px 0}button{padding:8px;margin:4px}.card{border:1px solid #ccc;padding:16px}</style><h1>U3 隔离预检</h1><p>固定无网络替身，所有上传/提交计数均为模拟。</p>'+panel+(cp?.phase==='WAITING_USER_CONTROL'?'<button id="fixture-return">模拟完成验证并归还</button><script>document.querySelector("#fixture-return").onclick=async()=>{await fetch("/fixture-return/'+pkg.projectId+'",{method:"POST"});location.reload();}</script>':'')+'</html>');return;
 }
 const give=req.url?.match(/^\/fixture-return\/([A-Za-z0-9-]+)$/);
 if(req.method==='POST'&&give){await actor(give[1]!,'return');res.writeHead(200).end('{}');return;}
 for(const handler of handlers)(handler as any)(req,res);
 })().catch(error=>{res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));});});
await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const address=app.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
async function command(m:any):Promise<unknown>{
 if(m.op==='seed'){
  const projectId='u3-'+randomUUID(),now=new Date().toISOString();await flow.createProject({id:projectId,name:'U3 合成预检',status:'READY_TO_PUBLISH',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16',createdAt:now,updatedAt:now});
  const a=await new LocalArtifactStore(path.join(root,projectId),artifacts).writeImmutable({id:'final-'+randomUUID(),projectId,kind:'FINAL_VIDEO',relativePath:'final/synthetic.mp4',bytes:Buffer.from('INERT_NOT_A_PLAYABLE_VIDEO_NO_REAL_UPLOAD'),mimeType:'video/mp4',immutable:true});
  await finals.createAssembly({id:'assembly-'+randomUUID(),projectId,productionPlanHash:'a'.repeat(64),selectedClipIds:['synthetic'],inputArtifactIds:['synthetic'],inputArtifactHashes:['b'.repeat(64)],outputArtifactId:a.id,outputArtifactHash:a.sha256!,status:'ACCEPTED',createdAt:now,acceptedAt:now});return {projectId,package:await createPackage(projectId),origin};
 }
 if(m.op==='create-package')return createPackage(m.projectId);
 if(m.op==='prepare')return bridge(Boolean(m.rollback)).browserPreparation!.prepare({projectId:m.projectId,packageId:m.packageId,expectedAccountId:'synthetic-account',confirmedPreparation:true});
 if(m.op==='gate-account'){gateAccount=true;return true;}
 if(m.op==='release-account'){assert.ok(releaseAccount);releaseAccount();releaseAccount=undefined;return true;}
 if(m.op==='crash-next'){crashAfterPrepare=true;return true;}
 if(m.op==='rollback-next'){rollbackCheckpoint=true;return true;}
 if(m.op==='actor')return actor(m.projectId,m.change);
 if(m.op==='state')return {checkpoint:await checkpoints.latest(m.projectId,m.packageId),package:await packages.findPackageById(m.packageId),counts,receipts:await packages.listReceiptsForPackage(m.packageId),reservations:await db.versionedEntity.findMany({where:{projectId:m.projectId,entityType:'BrowserPublishMediaReservation'}}),requests};
 if(m.op==='corrupt'){
  const row=await db.versionedEntity.findFirst({where:{projectId:m.projectId,entityType:'BrowserPublishCheckpoint',entityKey:m.packageId},orderBy:{version:'desc'}});assert.ok(row);const cp=JSON.parse(row.dataJson);
  if(m.kind==='scopeHash')cp.scopeHash='0'.repeat(64);else if(m.kind==='package')cp.scope.packageId='wrong-package';else if(m.kind==='binding')cp.binding.accountKey='wrong-key';else throw Error('UNKNOWN_CORRUPTION');
  const {contentHash,...body}=cp;cp.contentHash=hashValue(body);await db.versionedEntity.update({where:{id:row.id},data:{dataJson:JSON.stringify(cp),contentHash:cp.contentHash}});return true;
 }
 if(m.op==='expire'){await db.publishPackageRecord.update({where:{id:m.packageId},data:{expiresAt:new Date(0)}});return true;}
 if(m.op==='close'){app.close();app.closeAllConnections();await db.$disconnect();return {counts};}
 throw Error('FIXTURE_COMMAND_DENIED');
}
const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);void command(m).then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error.message}));});emit({ready:true,origin});
