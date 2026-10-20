import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { H, makeApproval, makePreflight, makeRequest } from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";


test("markRequestChainStale only invalidates the edited Agent request chain", async () => {
  const db = new PrismaClient();
  const projectId = `request-scope-${randomUUID()}`;
  const generation = new PrismaGenerationRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Request scoped stale",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 30000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const requestA = {
      ...makeRequest(),
      id: `request-a-${randomUUID()}`,
      projectId,
      clipId: `clip-a-${randomUUID()}`,
      compiledPromptId: `prompt-a-${randomUUID()}`,
      requestHash: H.d
    };
    const requestB = {
      ...makeRequest(),
      id: `request-b-${randomUUID()}`,
      projectId,
      clipId: `clip-b-${randomUUID()}`,
      compiledPromptId: `prompt-b-${randomUUID()}`,
      compiledPromptHash: H.two,
      requestHash: H.three
    };
    const preflightA = {
      ...makePreflight(),
      id: `preflight-a-${randomUUID()}`,
      projectId,
      generationRequestId: requestA.id,
      requestHash: requestA.requestHash,
      reportHash: H.e
    };
    const preflightB = {
      ...makePreflight(),
      id: `preflight-b-${randomUUID()}`,
      projectId,
      generationRequestId: requestB.id,
      requestHash: requestB.requestHash,
      reportHash: H.f
    };
    const approvalA = {
      ...makeApproval(),
      id: `approval-a-${randomUUID()}`,
      projectId,
      generationRequestId: requestA.id,
      requestHash: requestA.requestHash,
      preflightReportId: preflightA.id,
      preflightHash: preflightA.reportHash,
      approvalHash: H.one
    };
    const approvalB = {
      ...makeApproval(),
      id: `approval-b-${randomUUID()}`,
      projectId,
      generationRequestId: requestB.id,
      requestHash: requestB.requestHash,
      preflightReportId: preflightB.id,
      preflightHash: preflightB.reportHash,
      approvalHash: H.zero
    };

    await generation.createGenerationRequest(requestA);
    await generation.createGenerationRequest(requestB);
    await generation.createPreflightReport(preflightA);
    await generation.createPreflightReport(preflightB);
    await generation.createUserApproval(approvalA);
    await generation.createUserApproval(approvalB);

    await generation.markRequestChainStale(
      requestA.id,
      new Date().toISOString()
    );

    const current = await generation.listCurrentGenerationRequests(projectId);
    assert.deepEqual(current.map((item) => item.id), [requestB.id]);

    const reports = await generation.listPreflightReports(projectId);
    assert.equal(
      reports.find((item) => item.id === preflightA.id)?.status,
      "STALE"
    );
    assert.equal(
      reports.find((item) => item.id === preflightB.id)?.status,
      "PASS"
    );

    const approvals = await generation.listUserApprovals(projectId);
    assert.equal(
      approvals.find((item) => item.id === approvalA.id)?.status,
      "STALE"
    );
    assert.equal(
      approvals.find((item) => item.id === approvalB.id)?.status,
      "ACTIVE"
    );
  } finally {
    await db.generationAttemptRecord.deleteMany({ where: { projectId } });
    await db.userApprovalRecord.deleteMany({ where: { projectId } });
    await db.preflightReportRecord.deleteMany({ where: { projectId } });
    await db.generationRequestRecord.deleteMany({ where: { projectId } });
    await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
    await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
    await db.providerIdentityRecord.deleteMany({ where: { projectId } });
    await db.artifactRecord.deleteMany({ where: { projectId } });
    await db.versionedEntity.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  }
});
