import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { GenerationAttempt } from "../../domain/schemas.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import type { GenerationExecutionService } from "./generation-execution.js";
import { withSerialOperation } from "./serial-operation.js";

export type BatchTarget = {
  attemptId: string;
  clipId: string;
  order: number;
  requestId: string;
  requestHash: string;
  approvalId: string;
  approvalHash: string;
  status: GenerationAttempt["status"];
  eligible: boolean;
  reason?: string;
};
export type BatchSelection = {
  projectId: string;
  productionPlanHash: string;
  scopeHash: string;
  targets: BatchTarget[];
};
export type BatchSubmissionResult = {
  projectId: string;
  scopeHash: string;
  results: Array<{ attemptId: string; clipId: string; outcome: "SUBMITTED" | "SKIPPED" | "FAILED" | "RECONCILE_REQUIRED"; status: string; message: string }>;
};

/** A batch only orchestrates existing per-request approvals; it never creates or widens consent. */
export class BatchGenerationService {
  constructor(
    private readonly productFlow: Pick<ProductFlowService, "getWorkspace">,
    private readonly generation: GenerationRepository,
    private readonly workflow: WorkflowRepository,
    private readonly review: ReviewRepository,
    private readonly execution: Pick<GenerationExecutionService, "submitAttempt">
  ) {}

  async preview(projectId: string, attemptIds?: string[]): Promise<BatchSelection> {
    if (attemptIds && (attemptIds.length > 120 || new Set(attemptIds).size !== attemptIds.length)) {
      throw new DomainValidationError("批量镜头数量无效或包含重复记录");
    }
    const workspace = await this.productFlow.getWorkspace(projectId);
    const plan = workspace?.productionPlan;
    if (!plan || plan.status !== "CONFIRMED") throw new DomainValidationError("批量提交需要已确认的当前导演计划");
    const [attempts, requests, decisions, reports, approvals] = await Promise.all([
      this.workflow.listGenerationAttempts(projectId),
      this.generation.listCurrentGenerationRequests(projectId),
      this.review.listDecisions(projectId),
      this.generation.listPreflightReports(projectId),
      this.generation.listUserApprovals(projectId)
    ]);
    const clips = plan.scenes.flatMap((scene) => scene.clips);
    const order = new Map(clips.map((clip, index) => [clip.id, index]));
    const requestById = new Map(requests.map((request) => [request.id, request]));
    const candidates = attemptIds
      ? attemptIds.map((id) => {
          const attempt = attempts.find((item) => item.id === id && item.projectId === projectId);
          if (!attempt) throw new DomainValidationError("批量提交包含不存在或其他项目的生成记录");
          return attempt;
        })
      : attempts.filter((attempt) => attempt.status === "CREATED" && order.has(attempt.clipId));
    const targets = candidates.map((attempt): BatchTarget => {
      const clip = clips.find((item) => item.id === attempt.clipId);
      const request = requestById.get(attempt.generationRequestId);
      const report = reports.find((r) => r.id === attempt.preflightReportId);
      const approval = approvals.find((a) => a.id === attempt.userApprovalId);
      const approvalValid = report?.status === "PASS" && approval?.status === "ACTIVE" &&
        report.generationRequestId === request?.id && report.requestHash === request?.requestHash &&
        approval.generationRequestId === request?.id && approval.requestHash === request?.requestHash &&
        approval.preflightReportId === report.id && approval.preflightHash === report.reportHash &&
        approval.approvalHash === attempt.approvalHash &&
        (!approval.expiresAt || Date.parse(approval.expiresAt) > Date.now()) &&
        (!report.costEstimate.expiresAt || Date.parse(report.costEstimate.expiresAt) > Date.now());
      const latestUsage = decisions.filter((item) => item.clipId === clip?.id && item.clipHash === clip.contentHash &&
        (item.decision === "SKIP" || item.decision === "USE")).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      const newer = attempts.some((item) => item.clipId === attempt.clipId && item.attemptNumber > attempt.attemptNumber);
      const matchesPlan = request?.inputVersionRefs.some((ref) => ref.entityType === "ProductionPlan" &&
        ref.entityId === plan.id && ref.version === plan.version && ref.hash === plan.contentHash);
      const reason = !clip ? "不属于当前导演计划"
        : newer ? "已被该镜头更新的生成记录替代"
        : latestUsage?.decision === "SKIP" ? "镜头已明确跳过"
        : !request || request.requestHash !== attempt.requestHash || !matchesPlan ? "生成请求已失效或不属于当前计划"
        : !approvalValid ? "独立审批、生成前检查或费用快照已失效"
        : attempt.status !== "CREATED" ? "已领取、已提交或已结束，不会重复提交"
        : undefined;
      return { attemptId: attempt.id, clipId: attempt.clipId, order: order.get(attempt.clipId) ?? Number.MAX_SAFE_INTEGER,
        requestId: attempt.generationRequestId, requestHash: attempt.requestHash,
        approvalId: attempt.userApprovalId, approvalHash: attempt.approvalHash,
        status: attempt.status, eligible: !reason, ...(reason ? { reason } : {}) };
    }).filter((target) => attemptIds !== undefined || target.eligible)
      .sort((a, b) => a.order - b.order || a.attemptId.localeCompare(b.attemptId));
    const scopeHash = hashValue({ projectId, productionPlanHash: plan.contentHash,
      targets: targets.map(({ attemptId, clipId, requestId, requestHash, approvalId, approvalHash }) =>
        ({ attemptId, clipId, requestId, requestHash, approvalId, approvalHash })) });
    return { projectId, productionPlanHash: plan.contentHash, scopeHash, targets };
  }

  async submit(input: { projectId: string; attemptIds: string[]; scopeHash: string }): Promise<BatchSubmissionResult> {
    if (!input.attemptIds.length) throw new DomainValidationError("没有选择待提交镜头");
    return withSerialOperation("batch:" + input.projectId, async () => {
      const selection = await this.preview(input.projectId, input.attemptIds);
      if (selection.scopeHash !== input.scopeHash) throw new DomainValidationError("批量范围或导演计划已变化，请刷新并重新确认；不会替换为新的镜头");
      const result: BatchSubmissionResult = { projectId: input.projectId, scopeHash: input.scopeHash, results: [] };
      for (const selected of selection.targets) {
        try {
          // Re-check each target immediately before dispatch, never cache CREATED for the entire batch.
          const fresh = await this.preview(input.projectId, [selected.attemptId]);
          const target = fresh.targets[0]!;
          if (fresh.productionPlanHash !== selection.productionPlanHash || !target.eligible) {
            result.results.push({ attemptId: target.attemptId, clipId: target.clipId, outcome: "SKIPPED", status: target.status,
              message: fresh.productionPlanHash !== selection.productionPlanHash ? "导演计划已变化，剩余镜头不提交" : target.reason! });
            continue;
          }
          const attempt = await this.execution.submitAttempt(target.attemptId);
          const unknown = attempt.status === "SUBMISSION_OUTCOME_UNKNOWN" || attempt.status === "RECONCILING";
          result.results.push({ attemptId: attempt.id, clipId: attempt.clipId,
            outcome: unknown ? "RECONCILE_REQUIRED" : attempt.status === "SUBMITTED" ? "SUBMITTED" : "FAILED",
            status: attempt.status, message: unknown ? "提交结果未知，保留记录等待调和，禁止自动重提"
              : attempt.status === "SUBMITTED" ? "已提交，即梦后台异步生成" : attempt.errorMessage ?? "提交未成功" });
        } catch (error) {
          const attempt = await this.workflow.getGenerationAttempt(selected.attemptId);
          result.results.push({ attemptId: selected.attemptId, clipId: selected.clipId, outcome: "FAILED",
            status: attempt?.status ?? "MISSING", message: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    });
  }
}
