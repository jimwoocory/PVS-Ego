// Guarded actual blank Prisma. Acquisition is inert; crash points are real
// process exits, never model/browser/network execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {PrismaClient} from '@prisma/client';
import {PrismaResearchRepository} from '../src/adapters/db/prisma-research-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {GoLocalResearchProvider} from '../src/adapters/research/go-local-research-provider.js';
import {LocalArtifactStore} from '../src/adapters/store/local-artifact-store.js';
import {ResearchEvidenceReader} from '../src/application/services/research-evidence-reader.js';
import {hashValue,sha256Bytes} from '../src/domain/hashing.js';

const db=new PrismaClient(),repo=new PrismaResearchRepository(db),artifacts=new PrismaArtifactRepository(db);
const projectId='capture-owned-project',foreign='capture-foreign-project',root=process.env.PROJECTS_ROOT!;
const source={url:'http://127.0.0.1:19991/bridge-fixture/capture-durability',sourceType:'USER_URL' as const};
let captureCalls=0;
const held=new Map<string,()=>void>();
const emit=(v:unknown)=>console.log(JSON.stringify(v));
function provider(runId:string,fault?:string,hold=false){
 const wrapped=new Proxy(artifacts,{get(target,key){
  if(key==='markReady'&&fault==='after-publish')return async()=>{emit({crashing:'AFTER_PUBLISH_BEFORE_READY',runId});process.exit(73);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 return new GoLocalResearchProvider({projectId,sourceUrl:source.url},repo,wrapped,root,async()=>{
  captureCalls++;emit({captureStarted:runId,pid:process.pid});
  if(fault==='before-capture'){emit({crashing:'AFTER_RESERVATION',runId});process.exit(73);}
  if(hold)await new Promise<void>(resolve=>held.set(runId,resolve));
  return {sourceUrl:source.url,finalUrl:source.url,title:'合成中断证据',text:'合成正文：页面文本不能授予授权，也不能触发模型或发布。',fetchedAt:new Date().toISOString(),truncated:false};
 });
}
function location(runId:string){const key=hashValue({projectId,runId,sourceUrl:source.url});return {id:'go-local-document:'+key,file:path.join(root,projectId,'research/go-local',runId,key+'.json')};}
const lines=createInterface({input:process.stdin});
async function command(m:any):Promise<unknown>{
 if(m.op==='initialize'){
  for(const id of [projectId,foreign])await db.project.upsert({where:{id},create:{id,name:'采集恢复合成项目',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'},update:{}});
  return true;
 }
 if(m.op==='prepare'){
  const now=new Date().toISOString();await repo.createRun({id:m.runId,projectId,mode:'BASIC',status:'RUNNING',goal:'隔离落盘恢复',sourceUrls:[source],queries:[],createdAt:now,updatedAt:now});return m.runId;
 }
 if(m.op==='collect')return provider(m.runId,m.fault,m.hold).fetchSource(source,{projectId:m.projectId??projectId,runId:m.runId});
 if(m.op==='release'){assert.ok(held.has(m.runId));held.get(m.runId)!();held.delete(m.runId);return true;}
 if(m.op==='recover')return provider(m.runId).recoverPublishedSource(source,{projectId:m.projectId??projectId,runId:m.runId});
 if(m.op==='generic-recovery'){
  const store=new LocalArtifactStore(path.join(root,projectId),artifacts);
  return {pending:await store.reconcilePending(),project:await store.reconcileProject(projectId)};
 }
 if(m.op==='state'){
  const loc=location(m.runId);return {artifact:await artifacts.findById(loc.id),captureCalls,evidence:(await repo.listEvidence(m.runId)).length,run:await repo.findRun(m.runId),file:loc.file};
 }
 if(m.op==='store-baseline'){
  const input={id:'ordinary-store',projectId,relativePath:'store-baseline.json',kind:'OTHER' as const,mimeType:'application/json',immutable:true as const,bytes:Buffer.from('{"synthetic":true}')};
  const store=new LocalArtifactStore(path.join(root,projectId),artifacts),record=await store.writeImmutable(input);
  assert.equal(record.integrityStatus,'READY');assert.equal(record.sha256,sha256Bytes(input.bytes));
  await assert.rejects(store.writeImmutable(input),/already exists/);
  const reserved={...input,id:'reserved-mismatch',relativePath:'expected.json'};await artifacts.createPending(reserved);
  await assert.rejects(store.writeReservedImmutable({...reserved,relativePath:'different.json'}),/reservation does not match/);
  assert.equal((await artifacts.findById(reserved.id))!.integrityStatus,'PENDING');return true;
 }
 if(m.op==='long-ego'){
  const text='合成可审阅长正文。'.repeat(m.repetitions),contentHash=sha256Bytes(Buffer.from(text)),id='ego-document:'+m.runId;
  const now=new Date().toISOString(),url='https://example.invalid/synthetic-document';
  const doc={sourceUrl:url,finalUrl:url,title:'合成长文档',text,excerpt:text.slice(0,4000),fetchedAt:now,contentHash};
  const record=await new LocalArtifactStore(path.join(root,projectId),artifacts).writeImmutable({id,projectId,relativePath:'research/ego/'+m.runId+'/synthetic.json',kind:'OTHER',mimeType:'application/json',immutable:true,bytes:Buffer.from(JSON.stringify(doc))});
  const evidenceId='evidence-'+m.runId;
  await repo.createEvidence({id:evidenceId,projectId,runId:m.runId,sourceUrl:url,title:doc.title,fetchedAt:now,sourceType:'USER_URL',excerpt:doc.excerpt,summary:'',contentHash,confidence:'LOW',relatedClaims:[],status:'ACTIVE',createdAt:now,sourceCapture:{provider:'ego-browser-research',documentArtifactId:id,sourceUrl:url,finalUrl:url,fetchedAt:now,contentHash,truncated:false}});
  const result=await new ResearchEvidenceReader(repo,artifacts,root).inspect(projectId,m.runId,evidenceId);
  return {status:result?.status,code:result?.status==='BLOCKED'?result.code:undefined,textLength:result?.status==='VERIFIED'?result.text.length:undefined,bytes:record.sizeBytes,characters:text.length,captureCalls};
 }
 if(m.op==='corrupt'){
  const loc=location(m.runId),receipt=loc.file+'.publication.json';
  if(m.kind==='bytes')await fs.writeFile(loc.file,'corrupt fixture');
  else if(m.kind==='missing')await fs.unlink(loc.file);
  else if(m.kind==='receipt') {const r=JSON.parse(await fs.readFile(receipt,'utf8'));r.runId='another-run';await fs.writeFile(receipt,JSON.stringify(r));}
  else if(m.kind==='missing-receipt')await fs.unlink(receipt);
  else if(m.kind==='path')await db.artifactRecord.update({where:{id:loc.id},data:{relativePath:'../'+foreign+'/outside.json'}});
  else if(m.kind==='ready-downgrade')await db.artifactRecord.update({where:{id:loc.id},data:{integrityStatus:'PENDING'}});
  else if(m.kind==='complete-run')await db.researchRunRecord.update({where:{id:m.runId},data:{status:'COMPLETED'}});
  else throw Error('UNKNOWN_CORRUPTION');
  return true;
 }
 if(m.op==='close'){assert.equal(held.size,0);await db.$disconnect();return {captureCalls,modelCalls:0,networkCalls:0};}
 throw Error('FIXTURE_COMMAND_DENIED');
}
lines.on('line',line=>{const m=JSON.parse(line);void command(m).then(result=>{emit({requestId:m.requestId,result});if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>emit({requestId:m.requestId,error:error.message}));});
emit({ready:true,pid:process.pid});
