import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {referenceFixture,goodAssessment} from "./creative-reference-fixture.js";
import {candidateBlockers, type ResearchMediaCandidate} from "../src/domain/creative-reference.js";
import {hashValue} from "../src/domain/hashing.js";
import {PrismaCreativeReferenceRepository} from "../src/adapters/db/prisma-creative-reference-repository.js";
import {CreativeReferenceService} from "../src/application/services/creative-reference-service.js";
import {makeRequest,makePreflight,makeApproval} from "./fixtures.js";
import {PrismaGenerationRepository} from "../src/adapters/db/prisma-generation-repository.js";
const choose=(c:ResearchMediaCandidate,truthHash:string,revision=0)=>({expectedRevision:revision,expectedTruthHash:truthHash,acknowledgeRights:true,changes:[{candidateId:c.id,candidateHash:c.contentHash,decision:"INCLUDE",role:"PRODUCT_ANGLE"}]});

test("reference capture is immutable, separate from facts, canonical-image compared and approval gated",{timeout:90000},async()=>{
 const f=await referenceFixture();try{
  const before=(await f.productInput.latest(f.projectId))!.contentHash;
  await f.service.capture(f.captured);await f.service.capture(f.captured);
  const candidates=await f.repo.candidates(f.projectId);assert.equal(candidates.length,1);const c=candidates[0]!;
  assert.equal(c.status,"REVIEWABLE");assert.equal(c.sourceTrust,"DECLARED_OFFICIAL");assert.equal(f.ai.calls.length,1);assert.equal(f.ai.calls[0]!.media!.length,2);
  assert.equal(await f.service.current(f.projectId),null);assert.equal(await f.db.userApprovalRecord.count(),0);
  await assert.rejects(f.service.review(f.projectId,{...choose(c,f.truth.contentHash),acknowledgeRights:false}),/使用权/);
  await assert.rejects(f.service.review(f.projectId,{...choose(c,f.truth.contentHash),expectedTruthHash:"a".repeat(64)}),/产品事实/);
  const first=await f.service.review(f.projectId,choose(c,f.truth.contentHash));assert.equal(first.revision,1);assert.equal(first.set!.entries.length,1);
  assert.equal((await f.service.current(f.projectId))!.id,first.set!.id);assert.equal(CreativeReferenceService.assets(first.set)[0]!.source,"external");
  assert.equal((await f.productInput.latest(f.projectId))!.contentHash,before);assert.equal((await f.productFlow.getWorkspace(f.projectId))!.productTruth!.contentHash,f.truth.contentHash);
  assert.equal(await f.db.userApprovalRecord.count(),0);assert.equal(await f.db.researchEvidenceRecord.count(),0);
  await assert.rejects(f.service.review(f.projectId,choose(c,f.truth.contentHash)),/已被更新/);
  assert.equal(await f.repo.candidate("wrong-project",c.id),null);
 }finally{await f.cleanup()}
});

test("reference review invalidates downstream atomically but ignoring an unused candidate preserves the set",{timeout:90000},async()=>{
 const f=await referenceFixture();try{
  await f.service.capture(f.captured);const c=(await f.repo.candidates(f.projectId))[0]!;
  const gen=new PrismaGenerationRepository(f.db),req={...makeRequest(),projectId:f.projectId};await gen.createGenerationRequest(req);
  const report={...makePreflight(),projectId:f.projectId,generationRequestId:req.id};await gen.createPreflightReport(report);
  await gen.createUserApproval({...makeApproval(),projectId:f.projectId,generationRequestId:req.id,preflightReportId:report.id});
  const agentReq={...req,id:"independent-agent-request",requestHash:"1".repeat(64),agentTaskId:"independent-agent"};await gen.createGenerationRequest(agentReq);
  const agentReport={...report,id:"independent-agent-report",generationRequestId:agentReq.id,requestHash:agentReq.requestHash};await gen.createPreflightReport(agentReport);
  await gen.createUserApproval({...makeApproval(),id:"independent-agent-approval",projectId:f.projectId,generationRequestId:agentReq.id,preflightReportId:agentReport.id,requestHash:agentReq.requestHash});
  const ignore={...choose(c,f.truth.contentHash),changes:[{candidateId:c.id,candidateHash:c.contentHash,decision:"IGNORE"}]};
  const ignored=await f.service.review(f.projectId,ignore);assert.equal(ignored.set,null);assert.equal((await gen.listCurrentGenerationRequests(f.projectId)).length,2);
  const included=await f.service.review(f.projectId,choose(c,f.truth.contentHash,1));assert.equal(included.set!.version,1);
  assert.deepEqual((await gen.listCurrentGenerationRequests(f.projectId)).map(r=>r.id),[agentReq.id]);
  assert.equal((await gen.listUserApprovals(f.projectId)).find(a=>a.generationRequestId===req.id)!.status,"STALE");
  assert.equal((await gen.listUserApprovals(f.projectId)).find(a=>a.generationRequestId===agentReq.id)!.status,"ACTIVE");
  const same=await f.service.review(f.projectId,choose(c,f.truth.contentHash,2));assert.equal(same.set!.id,included.set!.id);
  const removed=await f.service.review(f.projectId,{...ignore,expectedRevision:3});assert.equal(removed.set!.version,2);assert.equal(removed.set!.entries.length,0);
  assert.equal(await f.service.current(f.projectId),null);assert.equal((await f.repo.candidates(f.projectId)).length,1);
  const history=await f.db.$queryRaw<Array<{n:number|bigint}>>`SELECT COUNT(*) AS n FROM "CreativeReferenceSetRecord"`;assert.equal(Number(history[0]!.n),2);
 }finally{await f.cleanup()}
});
test("reference gates reject competitor, ambiguous identity, watermark, blur and unknown usage-rule IDs",{timeout:90000},async()=>{
 const f=await referenceFixture();try{
  for(const change of [{identity:"OTHER_PRODUCT"},{identity:"UNCERTAIN"},{watermark:"PRESENT"},{clarity:"BLURRY"},{usage:"CONFLICT"},{conflictingRuleIds:["invented-rule"]}] as const){
    Object.assign(f.ai.assessment,structuredClone(goodAssessment),change);
    await f.service.capture({...f.captured,mediaUrl:"https://example.com/"+hashValue(change)+".png"});
  }
  assert.ok((await f.repo.candidates(f.projectId)).every(c=>c.status==="BLOCKED"||c.status==="ANALYSIS_FAILED"));assert.equal(await f.service.current(f.projectId),null);
  Object.assign(f.ai.assessment,structuredClone(goodAssessment));f.ai.fail=true;
  await f.service.capture({...f.captured,mediaUrl:"https://example.com/fail.png"});
  assert.ok((await f.repo.candidates(f.projectId)).some(c=>c.status==="ANALYSIS_FAILED"));
 }finally{await f.cleanup()}
});

test("only scene role may use a clear no-product scene; uncertain product is never a scene shortcut",()=>{
 const c={width:640,height:480,truthRef:{entityType:"ProductTruth",entityId:"truth",version:1,hash:"a".repeat(64)},canonicalImageHash:"b".repeat(64),assessment:{...goodAssessment,identity:"NO_PRODUCT" as const,recommendedRoles:["SCENE_REFERENCE" as const]}};
 assert.deepEqual(candidateBlockers(c,"SCENE_REFERENCE"),[]);assert.ok(candidateBlockers(c,"PRODUCT_ANGLE").length);
 assert.ok(candidateBlockers({...c,assessment:{...c.assessment,identity:"UNCERTAIN"}},"SCENE_REFERENCE").length);
});

test("reference CAS prevents stale overwrite and immutable content corruption fails closed",{timeout:90000},async()=>{
 const f=await referenceFixture();try{
  await f.service.capture(f.captured);const c=(await f.repo.candidates(f.projectId))[0]!;
  const result=await f.service.review(f.projectId,choose(c,f.truth.contentHash));const repo2=new PrismaCreativeReferenceRepository(f.db);
  const input={...choose(c,f.truth.contentHash,1),changes:[{candidateId:c.id,candidateHash:c.contentHash,decision:"INCLUDE" as const,role:"PRODUCT_ANGLE" as const}]};
  const racing=await Promise.allSettled([f.repo.confirm(f.projectId,result.set,input),repo2.confirm(f.projectId,result.set,input)]);
  assert.equal(racing.filter(r=>r.status==="fulfilled").length,1);assert.equal((await f.repo.state(f.projectId)).revision,2);
  await assert.rejects(f.service.assertExpected(f.projectId),/参考集合已改变/);
  const a=(await f.artifacts.findById(c.artifactId))!;await fs.appendFile(path.join(f.projectsRoot,f.projectId,a.relativePath),"CORRUPTED_TEST");
  await assert.rejects(f.service.current(f.projectId),/实际文件校验/);
  const broken=JSON.stringify({...c,title:"tampered"});await f.db.$executeRaw`UPDATE "ResearchMediaCandidateRecord" SET "dataJson"=${broken} WHERE "id"=${c.id}`;
  await assert.rejects(f.repo.candidate(f.projectId,c.id),/完整性/);
 }finally{await f.cleanup()}
});
