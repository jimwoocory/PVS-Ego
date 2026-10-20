import test from "node:test";
import assert from "node:assert/strict";
import type {
  AccountStatus,
  CostEstimateResult,
  DownloadedAsset,
  GenerationHandle,
  GenerationStatusResult,
  ProviderProbeResult,
  ReconcileResult,
  SubmitResult,
  VideoProvider
} from "../src/application/ports/video-provider.js";
import type { GenerationRequest } from "../src/domain/schemas.js";
import { assertSubmissionGate, DomainValidationError } from "../src/domain/validation.js";
import { submitAttemptOnce, SubmissionOutcomeUnknownError } from "../src/application/services/submission-service.js";
import { makeApproval, makeAttempt, makePreflight, makeRequest, H } from "./fixtures.js";

class FakeProvider implements VideoProvider {
  readonly id = "domestic-jimeng-cli" as const;
  submitCalls = 0;
  constructor(private readonly mode: "FAIL" | "UNKNOWN" | "SUCCESS") {}

  async probe(): Promise<ProviderProbeResult> {
    return { code: "DREAMINA_NOT_FOUND", cliFound: false, providerIdentityHash: H.b, capabilityFingerprint: H.a, rawStdout: "", rawStderr: "" };
  }
  async accountStatus(): Promise<AccountStatus> { return { status: "UNKNOWN" }; }
  async estimate(_requests: GenerationRequest[]): Promise<CostEstimateResult> { return { status: "UNKNOWN" }; }
  async submit(_request: GenerationRequest): Promise<SubmitResult> {
    this.submitCalls += 1;
    if (this.mode === "UNKNOWN") throw new SubmissionOutcomeUnknownError("remote outcome unknown");
    if (this.mode === "FAIL") throw new Error("submit failed");
    return { externalTaskId: "task-1" };
  }
  async status(_handle: GenerationHandle): Promise<GenerationStatusResult> { return { status: "UNKNOWN" }; }
  async download(_handle: GenerationHandle, _outputPath: string): Promise<DownloadedAsset> {
    throw new Error("not used");
  }
  async reconcileSubmission(_input: { requestHash: string; submissionFingerprint: string; knownHandle?: GenerationHandle }): Promise<ReconcileResult> {
    return { outcome: "INCONCLUSIVE", reason: "not used" };
  }
}

test("requestHash mismatch blocks submit gate", () => {
  const request = makeRequest();
  const approval = makeApproval();
  approval.requestHash = H.zero;
  assert.throws(
    () => assertSubmissionGate({ request, preflight: makePreflight(), approval, artifacts: [] }),
    (error: unknown) => error instanceof DomainValidationError && /requestHash mismatch/.test(error.message)
  );
});

test("STALE preflight blocks submit gate", () => {
  const preflight = makePreflight();
  preflight.status = "STALE";
  preflight.staleAt = "2026-09-27T05:01:00.000Z";
  assert.throws(
    () => assertSubmissionGate({ request: makeRequest(), preflight, approval: makeApproval(), artifacts: [] }),
    (error: unknown) => error instanceof DomainValidationError && /Preflight must be PASS/.test(error.message)
  );
});

test("submit service never auto-retries failed submit", async () => {
  const provider = new FakeProvider("FAIL");
  const result = await submitAttemptOnce({
    provider,
    attempt: makeAttempt(),
    request: makeRequest(),
    preflight: makePreflight(),
    approval: makeApproval(),
    artifacts: []
  });
  assert.equal(provider.submitCalls, 1);
  assert.equal(result.status, "FAILED");
});

test("unknown submit outcome is preserved without retry", async () => {
  const provider = new FakeProvider("UNKNOWN");
  const result = await submitAttemptOnce({
    provider,
    attempt: makeAttempt(),
    request: makeRequest(),
    preflight: makePreflight(),
    approval: makeApproval(),
    artifacts: []
  });
  assert.equal(provider.submitCalls, 1);
  assert.equal(result.status, "SUBMISSION_OUTCOME_UNKNOWN");
});

test("GenerationAttempt approvalHash mismatch blocks before provider submit", async () => {
  const provider = new FakeProvider("SUCCESS");
  const attempt = makeAttempt();
  attempt.approvalHash = H.zero;

  await assert.rejects(
    submitAttemptOnce({
      provider,
      attempt,
      request: makeRequest(),
      preflight: makePreflight(),
      approval: makeApproval(),
      artifacts: []
    }),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /GenerationAttempt approvalHash mismatch/.test(error.message)
  );
  assert.equal(provider.submitCalls, 0);
});
