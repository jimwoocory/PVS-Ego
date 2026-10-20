import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalService } from "../src/application/services/approval-service.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { GenerationAttempt, UserApproval } from "../src/domain/schemas.js";
import { makeRequest, makePreflight } from "./fixtures.js";

function fixture(count = 1) {
  const requests = Array.from({ length: count }, (_, i) => ({ ...makeRequest(), id: "request-" + i, clipId: "clip-" + i }));
  const reports = requests.map((r, i) => ({ ...makePreflight(), id: "preflight-" + i, generationRequestId: r.id, requestHash: r.requestHash }));
  const approvals: UserApproval[] = [], attempts: GenerationAttempt[] = [];
  const fault = { attemptOnce: false };
  const generation = {
    listCurrentGenerationRequests: async () => requests, listPreflightReports: async () => reports,
    listUserApprovals: async () => approvals,
    createUserApproval: async (approval: UserApproval) => { approvals.push(approval); return approval; }
  } as unknown as GenerationRepository;
  const workflow = {
    listGenerationAttempts: async () => attempts, nextAttemptNumber: async () => attempts.length + 1,
    createGenerationAttempt: async (attempt: GenerationAttempt) => {
      if (fault.attemptOnce) { fault.attemptOnce = false; throw new Error("simulated crash after approval"); }
      attempts.push(attempt); return attempt;
    }
  } as unknown as WorkflowRepository;
  return { requests, reports, approvals, attempts, fault, service: new ApprovalService(generation, workflow) };
}
const consent = { projectId: "project-1", acceptedUnknownCostRisk: true, acceptedDuplicateSubmissionRisk: false };

test("approval recovery reuses the exact durable approval and never creates a second attempt", async () => {
  const f = fixture(); f.fault.attemptOnce = true;
  await assert.rejects(f.service.approveCurrentRequests(consent), /simulated crash/);
  assert.equal(f.approvals.length, 1); assert.equal(f.attempts.length, 0); const id = f.approvals[0]!.id;
  const recovered = await f.service.approveCurrentRequests({ ...consent, generationRequestIds: [f.requests[0]!.id], reuseMatchingApprovals: true });
  assert.equal(recovered.approvals[0]!.id, id); assert.equal(f.approvals.length, 1); assert.equal(f.attempts.length, 1);
  const again = await f.service.approveCurrentRequests({ ...consent, reuseMatchingApprovals: true });
  assert.equal(again.attempts[0]!.id, recovered.attempts[0]!.id); assert.equal(f.attempts.length, 1);
});

test("approval prevalidates the complete request set before writing any prefix", async () => {
  const f = fixture(2); f.reports[1]!.status = "BLOCKED";
  await assert.rejects(f.service.approveCurrentRequests(consent), /Preflight must be PASS/);
  assert.equal(f.approvals.length, 0); assert.equal(f.attempts.length, 0);
});

test("recovered approval cannot change cost consent or reuse a different preflight", async () => {
  const f = fixture(); await f.service.approveCurrentRequests(consent);
  await assert.rejects(f.service.approveCurrentRequests({ ...consent, acceptedUnknownCostRisk: false, reuseMatchingApprovals: true }), /一致|Unknown cost/);
  f.reports[0]!.id = "different-report";
  await assert.rejects(f.service.approveCurrentRequests({ ...consent, reuseMatchingApprovals: true }), /一致/);
  assert.equal(f.approvals.length, 1); assert.equal(f.attempts.length, 1);
});
