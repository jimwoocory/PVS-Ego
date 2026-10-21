import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {PrismaClient} from '@prisma/client';
import {PrismaResearchRepository} from '../src/adapters/db/prisma-research-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {PrismaProductFlowRepository} from '../src/adapters/db/prisma-product-flow-repository.js';
import {ProductFlowService} from '../src/application/services/product-flow.js';
import {ResearchEvidenceReader} from '../src/application/services/research-evidence-reader.js';
import {EgoBrowserResearchProvider} from '../src/adapters/research/ego-browser-research-provider.js';
import {LocalArtifactStore} from '../src/adapters/store/local-artifact-store.js';
import {createAppServer} from '../src/web/server.js';
import {sha256Bytes,hashValue} from '../src/domain/hashing.js';
import type {ResearchSourceCapture} from '../src/application/ports/research-provider.js';
import {EgoResearchError} from '../src/application/ports/ego-research-runtime.js';
import {BrowserResearchBlockedError} from '../src/application/ports/research-provider.js';

const db=new PrismaClient(),repo=new PrismaResearchRepository(db),artifacts=new PrismaArtifactRepository(db),root=process.env.PROJECTS_ROOT!,session=process.env.PVS_ISOLATION_SESSION!,projectId='pr1-cache-synthetic';
await db.project.create({data:{id:projectId,name:'合成缓存审查',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'}});
let runtimeReads=0,captures=0;
const cases=new Map<string,Awaited<ReturnType<typeof seed>>>();
async function seed(name:string){
 const runId='cache-'+randomUUID(),url='http://127.0.0.1:19991/bridge-fixture/'+randomUUID(),now=new Date().toISOString();
 await repo.createRun({id:runId,projectId,mode:'BASIC',status:'RUNNING',goal:'合成证据审阅',sourceUrls:[{url,sourceType:'USER_URL'}],queries:[],createdAt:now,updatedAt:now});
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('INERT_SYNTHETIC_SIGNATURE_ONLY_NOT_A_SCREENSHOT')]);
 let seeded=false;
 const runtime={identity:'FIXED_LOCAL_CACHE_REVIEW',ownedSourceUrl:url,async open(spaceName:string){return {instanceId:'synthetic-instance',spaceId:1,spaceName,profileId:'Default' as const,targetId:'synthetic-target'};},async read(_binding:unknown,input:{url?:string;screenshotPath?:string}){
  runtimeReads++;if(seeded&&name==='ownership')throw new EgoResearchError('BROWSER_SESSION_EXPIRED');if(input.screenshotPath){captures++;await fs.writeFile(input.screenshotPath,png,{flag:'wx'});}
  return {sourceUrl:url,finalUrl:url,title:'合成缓存正文',text:name==='long-document'?'保存的合成长正文。'.repeat(25000):'保存的合成正文只用于核验，不包含账号或平台数据。'.repeat(8),fetchedAt:now,truncated:false,links:[]};
 }};
 const provider=new EgoBrowserResearchProvider(runtime,artifacts,root,{searchUrlTemplate:'http://127.0.0.1:19991/search?q={query}',allowPrivateNetwork:true});
 const source={url,sourceType:'USER_URL' as const},context={projectId,runId},doc=await provider.fetchOwnedSource(source,context),proof=doc.sourceCapture!;
 seeded=true;
 const evidenceId='cache-evidence-'+randomUUID();await repo.createEvidence({id:evidenceId,projectId,runId,sourceUrl:doc.finalUrl,title:doc.title,fetchedAt:doc.fetchedAt,sourceType:'USER_URL',excerpt:doc.excerpt,summary:'合成摘要标签，未调用模型',contentHash:doc.contentHash,sourceCapture:proof,confidence:'LOW',relatedClaims:[],status:'ACTIVE',createdAt:now});
 const artifact=(await artifacts.findById(proof.documentArtifactId))!,file=path.join(root,projectId,artifact.relativePath),sessionFile=path.join(root,projectId,'research/ego',runId,'session.json');
 return {provider,source,context,evidenceId,proof,file,sessionFile,artifact};
}
async function updateProof(f:Awaited<ReturnType<typeof seed>>,patch:Partial<ResearchSourceCapture>,removeDigests=false){
 const saved=JSON.parse(await fs.readFile(f.sessionFile,'utf8'));Object.assign(saved.captures[f.source.url],patch);
 if(removeDigests){delete saved.captures[f.source.url].documentSha256;delete saved.captures[f.source.url].screenshotSha256;}
 await fs.writeFile(f.sessionFile,JSON.stringify(saved));
}
async function prepare(name:string){
 const f=await seed(name);cases.set(name,f);let expected=200;
 if(['title','final-url','time','excerpt','content-hash','json'].includes(name)){
  const doc=JSON.parse(await fs.readFile(f.file,'utf8'));
  if(name==='title')doc.title='changed title';if(name==='final-url')doc.finalUrl='https://example.invalid/other';if(name==='time')doc.fetchedAt=new Date(Date.parse(doc.fetchedAt)+60000).toISOString();if(name==='excerpt')doc.excerpt='changed excerpt';if(name==='content-hash')doc.contentHash='0'.repeat(64);
  const bytes=Buffer.from(name==='json'?'INVALID_JSON':JSON.stringify(doc)),digest=sha256Bytes(bytes);await fs.writeFile(f.file,bytes);await db.artifactRecord.update({where:{id:f.artifact.id},data:{sha256:digest,sizeBytes:bytes.length}});
  // Keep the original complete-file receipt for title; exercise semantic
  // binding separately for the other mutated fields, even with a new digest.
  if(name!=='title')await updateProof(f,{documentSha256:digest});expected=409;
 }else if(name==='other-run-document'||name==='other-run-image'){
  const image=name==='other-run-image',old=(await artifacts.findById(image?f.proof.screenshotArtifactId!:f.artifact.id))!,bytes=await fs.readFile(path.join(root,projectId,old.relativePath));
  const saved=await new LocalArtifactStore(path.join(root,projectId),artifacts).writeImmutable({id:'other-run-'+randomUUID(),projectId,kind:'OTHER',immutable:true,mimeType:image?'image/png':'application/json',relativePath:`research/ego/other-${randomUUID()}/copy.${image?'png':'json'}`,bytes});
  await updateProof(f,image?{screenshotArtifactId:saved.id,screenshotSha256:saved.sha256}:{documentArtifactId:saved.id,documentSha256:saved.sha256});
 }else if(['immutable','mime','kind','size','oversized'].includes(name)){
  await db.artifactRecord.update({where:{id:f.artifact.id},data:name==='immutable'?{immutable:false}:name==='mime'?{mimeType:'text/plain'}:name==='kind'?{kind:'STRUCTURED_SNAPSHOT'}:name==='size'?{sizeBytes:f.artifact.sizeBytes!+1}:{sizeBytes:2_000_001}});expected=409;
 }else if(name==='image-mime'){
  await db.artifactRecord.update({where:{id:f.proof.screenshotArtifactId!},data:{mimeType:'application/json'}});
 }else if(name==='missing'){await fs.unlink(f.file);expected=409;
 }else if(name==='legacy-proof'){
  await updateProof(f,{},true);
  const legacy={...f.proof};delete legacy.documentSha256;delete legacy.screenshotSha256;
  const row=(await db.researchEvidenceRecord.findUnique({where:{id:f.evidenceId}}))!;
  const media=row.mediaContextJson?JSON.parse(row.mediaContextJson):{};
  await db.researchEvidenceRecord.update({where:{id:f.evidenceId},data:{mediaContextJson:JSON.stringify({...media,sourceCapture:legacy})}});
 }
 return {file:f.file,sessionFile:f.sessionFile,page:`/projects/${projectId}/research/runs/${f.context.runId}/evidence/${f.evidenceId}`,api:`/api/projects/${projectId}/research/runs/${f.context.runId}/evidence/${f.evidenceId}`,expected};
}
const state=async()=>hashValue({artifacts:await db.artifactRecord.findMany({orderBy:{id:'asc'}}),evidence:await db.researchEvidenceRecord.findMany({orderBy:{id:'asc'}}),runs:await db.researchRunRecord.findMany({orderBy:{id:'asc'}})});
const reader=new ResearchEvidenceReader(repo,artifacts,root),flow=new ProductFlowService(new PrismaProductFlowRepository(db));
const app=createAppServer({productFlow:flow,researchEvidence:reader} as any);await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const address=app.address();assert.ok(address&&typeof address==='object');
const emit=(v:unknown)=>console.log(JSON.stringify(v));emit({ready:{origin:'http://127.0.0.1:'+address.port}});
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);void(async()=>{
 if(m.op==='prepare')return prepare(m.name);
 if(m.op==='state')return {digest:await state(),runtimeReads,captures};
 if(m.op==='cache'){
  const f=cases.get(m.name)!,before=await state(),oldCaptures=captures,oldReads=runtimeReads;
  if(['valid','long-document'].includes(m.name)){const doc=await f.provider.fetchOwnedSource(f.source,f.context);assert.equal(doc.contentHash,f.proof.contentHash);assert.ok(doc.sourceCapture!.documentSha256);assert.equal(runtimeReads,oldReads+1);}
  else {await assert.rejects(f.provider.fetchOwnedSource(f.source,f.context),error=>m.name!=='legacy-proof'||error instanceof BrowserResearchBlockedError&&error.result.requiredUserAction.includes('历史缓存缺少完整文件摘要'));assert.equal(runtimeReads,oldReads+(m.name==='ownership'?1:0));}
  assert.equal(captures,oldCaptures);assert.equal(await state(),before);return {capturesUnchanged:true,databaseUnchanged:true};
 }
 if(m.op==='close'){app.close();app.closeAllConnections();await fs.writeFile(path.join(session,'evidence/fixture-final.json'),JSON.stringify({runtimeReads,captures,realBrowserCalls:0,modelCalls:0,fixtureOnly:true}));await db.$disconnect();return true;}
 throw Error('COMMAND_DENIED');
 })().then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error instanceof Error?error.stack:String(error)}));});
