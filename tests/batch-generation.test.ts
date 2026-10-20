import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationAttempt, GenerationRequest, ReviewDecision, ProductionPlan } from "../src/domain/schemas.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { ReviewRepository } from "../src/application/ports/review-repository.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import { BatchGenerationService } from "../src/application/services/batch-generation-service.js";
import { makeAttempt, makeRequest, makeValidClip, makeApproval, makePreflight, H, ISO } from "./fixtures.js";

function fixture(count = 3) {
  const clips = Array.from({ length: count }, (_, i) => ({ ...makeValidClip(), id: "clip-" + i, order: i }));
  const plan = { id: "plan-1", version: 1, contentHash: H.a, status: "CONFIRMED", scenes: [{ clips }] } as unknown as ProductionPlan;
  const requests: GenerationRequest[] = clips.map((clip, i) => ({ ...makeRequest(), id: "request-" + i, clipId: clip.id,
    inputVersionRefs: [{ entityType: "ProductionPlan", entityId: plan.id, version: plan.version, hash: plan.contentHash }] }));
  const attempts: GenerationAttempt[] = requests.map((r, i) => ({ ...makeAttempt(), id: "attempt-" + i, clipId: r.clipId,
    generationRequestId: r.id, requestHash: r.requestHash, status: "CREATED", userApprovalId: "approval-" + i }));
  const decisions: ReviewDecision[] = [];
  const reports = attempts.map(a => ({ ...makePreflight(), id: a.preflightReportId, generationRequestId: a.generationRequestId, requestHash: a.requestHash }));
  attempts.forEach((a,i) => { a.preflightReportId = 'report-' + i; reports[i]!.id = a.preflightReportId; });
  const approvals = attempts.map((a,i) => ({ ...makeApproval(), id: a.userApprovalId, generationRequestId: a.generationRequestId,
    requestHash: a.requestHash, preflightReportId: a.preflightReportId, preflightHash: reports[i]!.reportHash, approvalHash: a.approvalHash }));
  const audit = { active: 0, maximum: 0, submitted: [] as string[], failure: "", unknown: "", changePlanAfterFirst: false };
  const batch = new BatchGenerationService(
    { getWorkspace: async () => ({ project: { id: "project-1", name: "Batch fixture", status: "READY_TO_GENERATE" as const, targetPlatform: "douyin" as const, targetDurationMs: 30000, aspectRatio: "16:9", createdAt: ISO, updatedAt: ISO }, productionPlan: plan }) },
    { listCurrentGenerationRequests: async () => requests, listPreflightReports: async () => reports, listUserApprovals: async () => approvals } as unknown as GenerationRepository,
    { listGenerationAttempts: async () => attempts, getGenerationAttempt: async (id: string) => attempts.find(a => a.id === id) ?? null } as unknown as WorkflowRepository,
    { listDecisions: async () => decisions } as unknown as ReviewRepository,
    { submitAttempt: async (id: string) => {
      audit.active++; audit.maximum = Math.max(audit.maximum, audit.active);
      try {
        const a = attempts.find(a => a.id === id)!;
        assert.equal(a.status, "CREATED"); a.status = "SUBMITTING";
        await new Promise(r => setTimeout(r, 3)); audit.submitted.push(id);
        a.status = id === audit.failure ? "FAILED" : id === audit.unknown ? "SUBMISSION_OUTCOME_UNKNOWN" : "SUBMITTED";
        if (audit.changePlanAfterFirst) plan.contentHash = H.b;
        return structuredClone(a);
      } finally { audit.active--; }
    } }
  );
  return { batch, audit, attempts, requests, decisions, plan, clips, approvals, reports };
}

test("batch submits in director order with independent existing approvals and no local parallelism", async () => {
  const f = fixture(); f.attempts.reverse();
  const p = await f.batch.preview("project-1");
  assert.deepEqual(p.targets.map(t => t.attemptId), ["attempt-0", "attempt-1", "attempt-2"]);
  assert.equal(new Set(p.targets.map(t => t.approvalId)).size, 3);
  const r = await f.batch.submit({ projectId: "project-1", attemptIds: p.targets.map(t => t.attemptId), scopeHash: p.scopeHash });
  assert.equal(r.results.filter(r => r.outcome === "SUBMITTED").length, 3); assert.equal(f.audit.maximum, 1);
});

test("batch preview filters superseded, stale, skipped and historical attempts", async () => {
  const f = fixture(5);
  f.attempts.push({ ...f.attempts[0]!, id: "newer", attemptNumber: f.attempts[0]!.attemptNumber + 1, status: "FAILED" });
  f.requests.splice(f.requests.findIndex(r => r.clipId === "clip-1"), 1);
  f.decisions.push({ id: "skip", projectId: "project-1", clipId: "clip-2", clipHash: f.clips[2]!.contentHash, decision: "SKIP", decidedAt: ISO });
  f.attempts[3]!.clipId = "historical";
  const p = await f.batch.preview("project-1"); assert.deepEqual(p.targets.map(t => t.attemptId), ["attempt-4"]);
});

test("partial submit failure and unknown outcome do not block other independent scoped clips", async () => {
  const f = fixture(); f.audit.failure = "attempt-0"; f.audit.unknown = "attempt-1";
  const p = await f.batch.preview("project-1");
  const input = { projectId: "project-1", attemptIds: p.targets.map(t => t.attemptId), scopeHash: p.scopeHash };
  const r = await f.batch.submit(input);
  assert.deepEqual(r.results.map(t => t.outcome), ["FAILED", "RECONCILE_REQUIRED", "SUBMITTED"]);
  const repeated = await f.batch.submit(input);
  assert.ok(repeated.results.every(r => r.outcome === "SKIPPED")); assert.equal(f.audit.submitted.length, 3);
});

test("double-click batch calls do not submit a scoped attempt twice", async () => {
  const f = fixture(); const p = await f.batch.preview("project-1");
  const input = { projectId: "project-1", attemptIds: p.targets.map(t => t.attemptId), scopeHash: p.scopeHash };
  const results = await Promise.all([f.batch.submit(input), f.batch.submit(input)]);
  assert.equal(f.audit.submitted.length, 3); assert.equal(f.audit.maximum, 1);
  assert.ok(results[1]!.results.every(r => r.outcome === "SKIPPED"));
});

test("batch rejects changed scope and rechecks plan before each later submission", async () => {
  const f = fixture(); const p = await f.batch.preview("project-1");
  const input = { projectId: "project-1", attemptIds: p.targets.map(t => t.attemptId), scopeHash: H.f };
  await assert.rejects(f.batch.submit(input), /范围/); assert.equal(f.audit.submitted.length, 0);
  f.audit.changePlanAfterFirst = true;
  const r = await f.batch.submit({ ...input, scopeHash: p.scopeHash });
  assert.equal(f.audit.submitted.length, 1); assert.ok(r.results.slice(1).every(r => r.outcome === "SKIPPED"));
});

test("batch forbids cross-project, duplicate and empty target scopes", async () => {
  const f = fixture(); const p = await f.batch.preview("project-1");
  await assert.rejects(f.batch.preview("other", ["attempt-0"]), /其他项目/);
  await assert.rejects(f.batch.preview("project-1", ["attempt-0", "attempt-0"]), /重复/);
  await assert.rejects(f.batch.submit({ projectId: "project-1", attemptIds: [], scopeHash: p.scopeHash }), /没有选择/);
});

test("batch excludes stale, expired or mismatched per-clip authorization", async () => {
  const f = fixture(4);
  f.approvals[0]!.status = "STALE";
  f.approvals[1]!.expiresAt = ISO;
  f.reports[2]!.reportHash = H.f;
  const p = await f.batch.preview("project-1");
  assert.deepEqual(p.targets.map(t => t.attemptId), ["attempt-3"]);
});
