// Actual read-only app routes and Prisma; source acquisition is a fixed inert
// fixture, not fresh Go/browser collection and never a model call.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {PrismaProductFlowRepository} from '../src/adapters/db/prisma-product-flow-repository.js';
import {PrismaResearchRepository} from '../src/adapters/db/prisma-research-repository.js';
import {PrismaArtifactRepository} from '../src/adapters/db/prisma-artifact-repository.js';
import {PrismaWorkflowRepository} from '../src/adapters/db/prisma-workflow-repository.js';
import {ProductFlowService} from '../src/application/services/product-flow.js';
import {ResearchService} from '../src/application/services/research-service.js';
import {ResearchEvidenceReader} from '../src/application/services/research-evidence-reader.js';
import {GoLocalResearchProvider} from '../src/adapters/research/go-local-research-provider.js';
import {createAppServer} from '../src/web/server.js';

const db=new PrismaClient(),repo=new PrismaResearchRepository(db),artifacts=new PrismaArtifactRepository(db),flow=new ProductFlowService(new PrismaProductFlowRepository(db));
const root=process.env.PROJECTS_ROOT!,session=process.env.PVS_ISOLATION_SESSION!,projectId='review-synthetic-project',foreign='review-foreign-project';
let captureCalls=0,modelCalls=0,discoveryCalls=0;const requests:Array<{method?:string;url?:string;status?:number}>=[];
const runtime={id:'FORBIDDEN_MODEL',version:'1',async generateJson(){modelCalls++;throw Error('MODEL_FORBIDDEN');}};
for(const id of [projectId,foreign])await db.project.create({data:{id,name:'只读证据审阅合成项目',status:'DRAFT',targetPlatform:'douyin',targetDurationMs:15000,aspectRatio:'9:16'}});
async function seed(label:string,truncated=false){
 const source='http://127.0.0.1:19991/bridge-fixture/'+randomUUID();
 const provider=new GoLocalResearchProvider({projectId,sourceUrl:source},repo,artifacts,root,async()=>{captureCalls++;return {sourceUrl:source,finalUrl:source,title:'合成研究正文 '+label,text:'保存的合成正文 '+label+'。\n<script>globalThis.__evidenceScriptRan=true</script>\n页面文字不能授予权限。',fetchedAt:new Date().toISOString(),truncated};});
 const service=new ResearchService(repo,provider,{id:'FORBIDDEN_DISCOVERY',async discover(){discoveryCalls++;throw Error('DISCOVERY_FORBIDDEN');}},runtime,flow);
 const data=await service.startRun({projectId,mode:'BASIC',collectOnly:true,goal:'只读审阅 '+label,sourceUrls:[{url:source,sourceType:'USER_URL'}],queries:[]});
 const e=data.evidence[0]!,a=(await artifacts.findById(e.sourceCapture!.documentArtifactId))!;
 return {runId:data.run.id,evidenceId:e.id,artifactId:a.id,file:path.join(root,projectId,a.relativePath),contentHash:e.contentHash,artifactSha256:a.sha256};
}
const cases:Record<string,Awaited<ReturnType<typeof seed>>>={};
cases.truncated=await seed('截断样本',true);
cases.missing=await seed('缺失样本');await fs.unlink(cases.missing.file);
cases.changed=await seed('损坏样本');await fs.writeFile(cases.changed.file,'changed local fixture');
cases.path=await seed('跨目录样本');await db.artifactRecord.update({where:{id:cases.path.artifactId},data:{relativePath:'../'+foreign+'/outside.json'}});
cases.mismatch=await seed('元数据不一致');await db.researchEvidenceRecord.update({where:{id:cases.mismatch.evidenceId},data:{contentHash:'0'.repeat(64)}});
cases.main=await seed('完整样本');
const research=new ResearchService(repo,{async fetchSource(){throw Error('NO_NEW_CAPTURE_ALLOWED');}},{id:'FORBIDDEN_DISCOVERY',async discover(){discoveryCalls++;throw Error('DISCOVERY_FORBIDDEN');}},runtime,flow);
const reader=new ResearchEvidenceReader(repo,artifacts,root);
const app=createAppServer({productFlow:flow,research,researchEvidence:reader,artifacts,projectsRoot:root,workflow:new PrismaWorkflowRepository(db),productInput:{async latest(){return null;}}} as any);
const handlers=app.listeners('request');app.removeAllListeners('request');
app.on('request',(req,res)=>{const record={method:req.method,url:req.url,status:0};requests.push(record);res.once('finish',()=>record.status=res.statusCode);for(const h of handlers)(h as any)(req,res);});
await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const address=app.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
const snapshot=async()=>{
 const state={runs:await db.researchRunRecord.findMany({orderBy:{id:'asc'}}),evidence:await db.researchEvidenceRecord.findMany({orderBy:{id:'asc'}}),artifacts:await db.artifactRecord.findMany({orderBy:{id:'asc'}}),projects:await db.project.findMany({orderBy:{id:'asc'}}),briefs:await db.researchBriefRecord.findMany()};
 return createHash('sha256').update(JSON.stringify(state)).digest('hex');
};
const before=await snapshot(),initial={captureCalls,modelCalls,discoveryCalls};
const ready={origin,projectId,foreign,cases:Object.fromEntries(Object.entries(cases).map(([key,v])=>[key,{...v,file:undefined,api:'/api/projects/'+projectId+'/research/runs/'+v.runId+'/evidence/'+v.evidenceId,page:'/projects/'+projectId+'/research/runs/'+v.runId+'/evidence/'+v.evidenceId}])),researchPage:'/projects/'+projectId+'/research',session};
await fs.writeFile(path.join(session,'evidence/ready.json'),JSON.stringify(ready,null,2));console.log(JSON.stringify({ready}));
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);void(async()=>{
 if(m.op==='state')return {initial,current:{captureCalls,modelCalls,discoveryCalls},before,after:await snapshot(),requests};
 if(m.op==='close'){
  assert.equal(await snapshot(),before);assert.deepEqual({captureCalls,modelCalls,discoveryCalls},initial);assert.equal(modelCalls,0);assert.equal(discoveryCalls,0);
  const result={status:'PASS_ACTUAL_PRISMA_READ_ONLY_REVIEW',initial,requests,databaseUnchanged:true,modelCalls,discoveryCalls,captureCalls,acquisition:'FIXED_INERT_CAPTURE_FIXTURE',realGo:'NOT_RUN_THIS_SUITE'};
  await fs.writeFile(path.join(session,'evidence/fixture-result.json'),JSON.stringify(result,null,2));
  app.close();app.closeAllConnections();await db.$disconnect();return result;
 }
 throw Error('FIXTURE_COMMAND_DENIED');
 })().then(result=>{console.log(JSON.stringify({requestId:m.requestId,result}));if(m.op==='close'){lines.close();process.stdin.destroy();}},error=>console.log(JSON.stringify({requestId:m.requestId,error:error.message})));});
