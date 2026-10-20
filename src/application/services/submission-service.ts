import {
  SubmissionOutcomeUnknownError,
  type VideoProvider
} from "../ports/video-provider.js";
import type {
  GenerationAttempt,
  GenerationRequest,
  PreflightReport,
  UserApproval
} from "../../domain/schemas.js";
import { generationAttemptSchema } from "../../domain/schemas.js";
import {
  assertSubmissionGate,
  DomainValidationError,
  type ArtifactGateInput
} from "../../domain/validation.js";

export { SubmissionOutcomeUnknownError } from "../ports/video-provider.js";

export function assertAttemptBinding(input: {
  attempt: GenerationAttempt;
  request: GenerationRequest;
  preflight: PreflightReport;
  approval: UserApproval;
}): void {
  const { attempt, request, preflight, approval } = input;
  if (attempt.projectId !== request.projectId || attempt.projectId !== preflight.projectId || attempt.projectId !== approval.projectId || attempt.clipId !== request.clipId) {
    throw new DomainValidationError("GenerationAttempt project/clip binding mismatch");
  }
  if (attempt.generationRequestId !== request.id) {
    throw new DomainValidationError("GenerationAttempt generationRequestId mismatch");
  }
  if (attempt.requestHash !== request.requestHash) {
    throw new DomainValidationError("GenerationAttempt requestHash mismatch");
  }
  if (attempt.preflightReportId !== preflight.id) {
    throw new DomainValidationError("GenerationAttempt preflightReportId mismatch");
  }
  if (attempt.userApprovalId !== approval.id) {
    throw new DomainValidationError("GenerationAttempt userApprovalId mismatch");
  }
  if (attempt.approvalHash !== approval.approvalHash) {
    throw new DomainValidationError("GenerationAttempt approvalHash mismatch");
  }
}

export async function submitAttemptOnce(input: {
  provider: VideoProvider;
  attempt: GenerationAttempt;
  request: GenerationRequest;
  preflight: PreflightReport;
  approval: UserApproval;
  artifacts: ArtifactGateInput[];
  now?: Date;
}): Promise<GenerationAttempt> {
  if(input.request.provider==="dreamina-canvas")throw new DomainValidationError("Canvas请求禁止通过旧视频提交接口执行");
  const attempt = generationAttemptSchema.parse(input.attempt);
  if (attempt.status !== "CREATED") {
    throw new DomainValidationError(
      `Attempt must be CREATED, got ${attempt.status}`
    );
  }

  assertSubmissionGate({
    request: input.request,
    preflight: input.preflight,
    approval: input.approval,
    artifacts: input.artifacts,
    now: input.now
  });
  assertAttemptBinding({
    attempt,
    request: input.request,
    preflight: input.preflight,
    approval: input.approval
  });

  try {
    const handle = await input.provider.submit(input.request);
    return {
      ...attempt,
      status: "SUBMITTED",
      providerHandle: handle,
      submittedAt: (input.now ?? new Date()).toISOString()
    };
  } catch (error) {
    if (error instanceof SubmissionOutcomeUnknownError) {
      return {
        ...attempt,
        status: "SUBMISSION_OUTCOME_UNKNOWN",
        errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
        errorMessage: error.message
      };
    }
    return {
      ...attempt,
      status: "FAILED",
      errorCode: "SUBMIT_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}
