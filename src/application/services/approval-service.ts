import type { V8PaidRequestGuard } from "./v8-paid-request-guard.js";
import { randomUUID } from "node:crypto";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import {
  generationAttemptSchema,
  userApprovalSchema,
  type GenerationAttempt,
  type UserApproval
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { computeApprovalHash } from "./hash-contracts.js";
import { DomainValidationError } from "../../domain/validation.js";
import { withSerialOperation } from "./serial-operation.js";

export type ApproveCurrentRequestsInput = {
  projectId: string;
  generationRequestIds?: string[];
  acceptedUnknownCostRisk: boolean;
  acceptedDuplicateSubmissionRisk: boolean;
  now?: Date;
  /** Internal recovery only: caller has a durable explicit consent for these exact request hashes. */
  reuseMatchingApprovals?: boolean;
};

export type ApprovalBatchResult = {
  approvals: UserApproval[];
  attempts: GenerationAttempt[];
};

export class ApprovalService {
  constructor(
    private readonly generationRepo: GenerationRepository,
    private readonly workflowRepo: WorkflowRepository,
    private readonly v8Guard?: V8PaidRequestGuard
  ) {}

  async approveCurrentRequests(
    input: ApproveCurrentRequestsInput
  ): Promise<ApprovalBatchResult> {
    return withSerialOperation("approval:" + input.projectId, () => this.approveExclusive(input));
  }

  private async approveExclusive(input: ApproveCurrentRequestsInput): Promise<ApprovalBatchResult> {
    const now = input.now ?? new Date();
    const [
      allRequests,
      reports,
      existingApprovals,
      existingAttempts
    ] = await Promise.all([
      this.generationRepo.listCurrentGenerationRequests(input.projectId),
      this.generationRepo.listPreflightReports(input.projectId),
      this.generationRepo.listUserApprovals(input.projectId),
      this.workflowRepo.listGenerationAttempts(input.projectId)
    ]);
    const requestIdFilter = input.generationRequestIds?.length
      ? new Set(input.generationRequestIds)
      : null;
    const requests = requestIdFilter
      ? allRequests.filter((item) => requestIdFilter.has(item.id))
      : allRequests;

    if (!requests.length) {
      throw new DomainValidationError("No CURRENT GenerationRequest to approve");
    }
    if (requestIdFilter && requests.length !== requestIdFilter.size) {
      throw new DomainValidationError(
        "One or more scoped GenerationRequest ids are missing or stale"
      );
    }

    for (const request of requests) {
      if (request.v8Binding) {
        if (!this.v8Guard) throw new DomainValidationError("V8 付费校验器未配置，禁止直接批准");
        await this.v8Guard(request);
        if (input.reuseMatchingApprovals) throw new DomainValidationError("V8 不允许复用旧付费审批，请核查本轮检查点");
      }
    }
    const hasUnknownSubmission = existingAttempts.some(
      (item) =>
        item.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
        item.status === "RECONCILING"
    );
    if (
      hasUnknownSubmission &&
      input.acceptedDuplicateSubmissionRisk !== true
    ) {
      throw new DomainValidationError(
        "Unresolved submission outcome requires explicit duplicate-submission cost-risk acceptance before approval"
      );
    }

    const currentReports = reports.filter((item) => item.status !== "STALE");
    const reportByRequest = new Map(
      currentReports.map((item) => [item.generationRequestId, item])
    );

    const activeRequestIds = new Set(
      existingApprovals
        .filter((item) => item.status === "ACTIVE")
        .map((item) => item.generationRequestId)
    );

    const approvals: UserApproval[] = [];
    const attempts: GenerationAttempt[] = [];

    for (const request of requests) {
      if (activeRequestIds.has(request.id) && !input.reuseMatchingApprovals) {
        throw new DomainValidationError(
          `GenerationRequest already has ACTIVE UserApproval: ${request.id}`
        );
      }
      const report = reportByRequest.get(request.id);
      if (!report) {
        throw new DomainValidationError(
          `GenerationRequest has no current PreflightReport: ${request.id}`
        );
      }
      if (report.status !== "PASS") {
        throw new DomainValidationError(
          `Preflight must be PASS before approval: ${report.id}`
        );
      }
      if (
        report.costEstimate.status === "UNKNOWN" &&
        !input.acceptedUnknownCostRisk
      ) {
        throw new DomainValidationError(
          "Unknown cost requires explicit user acceptance"
        );
      }
      if (
        report.requestHash !== request.requestHash ||
        report.providerIdentityHash !== request.providerIdentityHash ||
        report.capabilityFingerprint !== request.capabilityFingerprint
      ) {
        throw new DomainValidationError(
          `Preflight binding mismatch for request: ${request.id}`
        );
      }

    }

    // Validate the whole scope above before creating the first approval; partial validation
    // failures must not silently authorize a prefix of the batch.
    for (const request of requests) {
      const report = reportByRequest.get(request.id)!;
      const recoveredApproval = existingApprovals.find((item) => item.generationRequestId === request.id && item.status === "ACTIVE");
      if (recoveredApproval && (
        recoveredApproval.requestHash !== request.requestHash || recoveredApproval.preflightHash !== report.reportHash ||
        recoveredApproval.preflightReportId !== report.id ||
        recoveredApproval.acceptedUnknownCostRisk !== input.acceptedUnknownCostRisk ||
        recoveredApproval.acceptedDuplicateSubmissionRisk !== input.acceptedDuplicateSubmissionRisk
      )) throw new DomainValidationError("恢复授权与本次明确确认的范围不一致，不能复用");

      const approvalWithoutHash = {
        id: randomUUID(),
        projectId: input.projectId,
        generationRequestId: request.id,
        requestHash: request.requestHash,
        preflightReportId: report.id,
        preflightHash: report.reportHash,
        providerIdentityHash: request.providerIdentityHash,
        capabilityFingerprint: request.capabilityFingerprint,
        costSnapshot: report.costEstimate,
        acceptedUnknownCostRisk: input.acceptedUnknownCostRisk,
        acceptedDuplicateSubmissionRisk:
          input.acceptedDuplicateSubmissionRisk,
        status: "ACTIVE" as const,
        approvedAt: now.toISOString()
      };
      const approval = recoveredApproval ?? userApprovalSchema.parse({
        ...approvalWithoutHash,
        approvalHash: computeApprovalHash(approvalWithoutHash)
      });
      if (!recoveredApproval) await this.generationRepo.createUserApproval(approval);

      const recoveredAttempt = existingAttempts.find((item) => item.userApprovalId === approval.id);
      if (recoveredAttempt) {
        if (recoveredAttempt.requestHash !== request.requestHash || recoveredAttempt.approvalHash !== approval.approvalHash) {
          throw new DomainValidationError("恢复生成记录与审批绑定不一致");
        }
        approvals.push(approval);
        attempts.push(recoveredAttempt);
        continue;
      }

      const attemptNumber = await this.workflowRepo.nextAttemptNumber(
        request.clipId
      );
      const attempt = generationAttemptSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        clipId: request.clipId,
        attemptNumber,
        generationRequestId: request.id,
        requestHash: request.requestHash,
        preflightReportId: report.id,
        userApprovalId: approval.id,
        approvalHash: approval.approvalHash,
        submissionFingerprint: hashValue({
          projectId: input.projectId,
          clipId: request.clipId,
          attemptNumber,
          requestHash: request.requestHash,
          approvalHash: approval.approvalHash
        }),
        status: "CREATED",
        commandAttempts: [],
        createdAt: now.toISOString()
      });
      await this.workflowRepo.createGenerationAttempt(attempt);

      approvals.push(approval);
      attempts.push(attempt);
    }

    return { approvals, attempts };
  }
}
