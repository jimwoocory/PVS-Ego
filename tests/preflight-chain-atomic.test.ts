import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { H, ISO, makeApproval, makePreflight, makeRequest } from "./fixtures.js";
import type { CompiledPrompt } from "../src/domain/schemas.js";

process.env.DATABASE_URL ??= "file:./dev.db";
const linked = (entityType:string,entityId:string,hash=H.a) => ({entityType,entityId,version:1,hash});

test("single-clip preflight replacement is transactionally scoped and rolls back on failure", async ()=>{
 const db=new PrismaClient();
 const projectId="preflight-atomic-"+randomUUID();
 const repo=new PrismaGenerationRepository(db);
 const flow=new ProductFlowService(new PrismaProductFlowRepository(db));
 try {
  const now=new Date().toISOString();
  await flow.createProject({id:projectId,name:"Isolated Preflight Test",status:"READY_TO_GENERATE",
   targetPlatform:"douyin",targetDurationMs:30000,aspectRatio:"9:16",createdAt:now,updatedAt:now});
  const clipA="clip-atomic-a",clipB="clip-atomic-b";
  const oldA={...makeRequest(),id:"request-old-a-"+randomUUID(),projectId,clipId:clipA,compiledPromptId:"prompt-old-a-"+randomUUID(),requestHash:H.d};
  const oldB={...makeRequest(),id:"request-old-b-"+randomUUID(),projectId,clipId:clipB,compiledPromptId:"prompt-old-b-"+randomUUID(),requestHash:H.e};
  const reportA={...makePreflight(),id:"report-old-a-"+randomUUID(),projectId,generationRequestId:oldA.id,requestHash:oldA.requestHash,reportHash:H.f};
  const reportB={...makePreflight(),id:"report-old-b-"+randomUUID(),projectId,generationRequestId:oldB.id,requestHash:oldB.requestHash,reportHash:H.one};
  const approvalA={...makeApproval(),id:"approval-old-a-"+randomUUID(),projectId,generationRequestId:oldA.id,requestHash:oldA.requestHash,preflightReportId:reportA.id,preflightHash:reportA.reportHash};
  const approvalB={...makeApproval(),id:"approval-old-b-"+randomUUID(),projectId,generationRequestId:oldB.id,requestHash:oldB.requestHash,preflightReportId:reportB.id,preflightHash:reportB.reportHash};
  for (const item of [oldA,oldB])await repo.createGenerationRequest(item);
  for (const item of [reportA,reportB])await repo.createPreflightReport(item);
  for (const item of [approvalA,approvalB])await repo.createUserApproval(item);
  const newId="compiled-new-"+randomUUID();
  const prompt: CompiledPrompt={
    id:newId,projectId,clipId:clipA,version:1,status:"CURRENT",provider:"domestic-jimeng-cli",
    model:"seedance-2.0",
    productTruthRef:linked("ProductTruth","truth-1"),
    creativeBatchRef:linked("CreativeBatch","creative-1"),
    selectedCreativeId:"creative-1",
    scriptRef:linked("ScriptDraft","script-1"),
    productionPlanRef:linked("ProductionPlan","plan-1"),
    clipHash:H.c,segmentHashes:{},compilerTemplateVersion:"test-preflight-atomic",
    promptText:"Validated no-cost prompt",inputAssetManifest:[],factMapping:[],
    segmentMapping:[],constraintMapping:[],generationParams:{durationMs:8000,aspectRatio:"9:16",generateAudio:false},
    compiledPromptHash:H.two,createdAt:ISO
  };
  const replacement={...makeRequest(),id:"request-new-"+randomUUID(),projectId,clipId:clipA,compiledPromptId:newId,
    compiledPromptHash:prompt.compiledPromptHash,requestHash:H.three};
  const report={...makePreflight(),id:"report-new-"+randomUUID(),projectId,generationRequestId:replacement.id,
    requestHash:replacement.requestHash,reportHash:H.five};

  // Duplicate an existing request ID: a failure late in the transaction
  // must restore every earlier row and must not save the new compiled prompt.
  await assert.rejects(repo.replacePreflightChain({
    projectId,clipIds:[clipA],staleAt:now,compiledPrompts:[prompt],
    requests:[{...replacement,id:oldB.id}],reports:[{...report,generationRequestId:oldB.id}]
  }));
  assert.deepEqual((await repo.listCurrentGenerationRequests(projectId)).map(item=>item.id).sort(),
    [oldA.id,oldB.id].sort());
  assert.equal((await repo.listUserApprovals(projectId)).find(item=>item.id===approvalA.id)?.status,"ACTIVE");
  assert.equal((await repo.listCompiledPrompts(projectId)).length,0);

  await repo.replacePreflightChain({
    projectId,clipIds:[clipA],staleAt:now,compiledPrompts:[prompt],requests:[replacement],reports:[report]
  });
  const current=await repo.listCurrentGenerationRequests(projectId);
  assert.deepEqual(current.map(item=>item.id).sort(),[oldB.id,replacement.id].sort());
  const afterReports=await repo.listPreflightReports(projectId);
  assert.equal(afterReports.find(item=>item.id===reportA.id)?.status,"STALE");
  assert.equal(afterReports.find(item=>item.id===reportB.id)?.status,"PASS");
  assert.equal(afterReports.find(item=>item.id===report.id)?.status,"PASS");
  const approvals=await repo.listUserApprovals(projectId);
  assert.equal(approvals.find(item=>item.id===approvalA.id)?.status,"STALE");
  assert.equal(approvals.find(item=>item.id===approvalB.id)?.status,"ACTIVE");
  assert.equal((await repo.listCompiledPrompts(projectId)).length,1);
 } finally {
  await db.generationAttemptRecord.deleteMany({where:{projectId}});
  await db.userApprovalRecord.deleteMany({where:{projectId}});
  await db.preflightReportRecord.deleteMany({where:{projectId}});
  await db.generationRequestRecord.deleteMany({where:{projectId}});
  await db.versionedEntity.deleteMany({where:{projectId}});
  await db.workflowBlockerRecord.deleteMany({where:{projectId}});
  await db.artifactRecord.deleteMany({where:{projectId}});
  await db.project.deleteMany({where:{id:projectId}});
  await db.$disconnect();
 }
});
