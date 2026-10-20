import type { AgentTask } from "../ports/agent-task-repository.js";
import type { FinalOutputRepository, PublishAttempt } from "../ports/final-output-repository.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type {
  GenerationAttempt,
  GenerationRequest,
  PreflightReport,
  Project,
  RenderJob,
  ReviewDecision,
  WorkflowBlocker
} from "../../domain/schemas.js";
import type { SmartGenerationRun } from "../../domain/smart-generation.js";
import type { PublicPublishPackage, PublishBridgeService } from "./publish-bridge-service.js";
import type { ProductFlowService } from "./product-flow.js";
import type { ResearchService } from "./research-service.js";
import type { AgentModeService } from "./agent-mode-service.js";
import type { SmartGenerationService } from "./smart-generation-service.js";
import type { TimelineService } from "./timeline-service.js";
import type {
  ResearchRun
} from "../ports/research-repository.js";
import type {
  TaskCenterAction,
  TaskCenterItem,
  TaskCenterPaidState,
  TaskCenterStatus
} from "../../domain/task-center.js";

type TaskCenterDependencies = {
  productFlow: Pick<ProductFlowService, "listProjects" | "getProject">;
  research: Pick<ResearchService, "pageData">;
  agentMode: Pick<AgentModeService, "listTasks">;
  smartGeneration?: Pick<SmartGenerationService, "list">;
  workflow: Pick<WorkflowRepository, "listGenerationAttempts" | "listOpenBlockers">;
  generation: Pick<
    GenerationRepository,
    "listGenerationRequests" | "listPreflightReports"
  >;
  review: Pick<ReviewRepository, "listDecisions">;
  timeline: Pick<TimelineService, "listRenderJobs">;
  finalOutput: Pick<FinalOutputRepository, "listPublishAttempts">;
  publishBridge: Pick<PublishBridgeService, "audit">;
};

type MapContext = {
  project: Project;
  blockers: WorkflowBlocker[];
  requests: GenerationRequest[];
  preflights: PreflightReport[];
  decisions: ReviewDecision[];
};

function action(
  label: string,
  href: string,
  kind: TaskCenterAction["kind"] = "OPEN"
): TaskCenterAction {
  return { label, href, kind };
}

function blockerFor(
  blockers: WorkflowBlocker[],
  sourceId: string
): WorkflowBlocker | undefined {
  return blockers
    .filter(
      (item) =>
        !item.resolvedAt &&
        (item.relatedEntityId === sourceId || item.scope === "PROJECT")
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function costTextFromPreflight(
  requestId: string,
  preflights: PreflightReport[]
): string | undefined {
  const report = preflights
    .filter(
      (item) =>
        item.generationRequestId === requestId && item.status !== "STALE"
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!report) return undefined;
  if (report.costEstimate.status === "UNKNOWN") return "成本未知（已按确认链处理）";
  return (
    report.costEstimate.estimatedCostText ??
    (report.costEstimate.estimatedCredits !== undefined
      ? `${report.costEstimate.estimatedCredits} credits`
      : "成本已知")
  );
}

function lastCommand(attempt: GenerationAttempt) {
  return [...attempt.commandAttempts].sort((a, b) =>
    (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt)
  )[0];
}

export function taskFromResearchRun(
  project: Project,
  run: ResearchRun
): TaskCenterItem {
  const status: TaskCenterStatus =
    run.status === "RUNNING"
      ? "RUNNING"
      : run.status === "BLOCKED" || run.status === "READY"
        ? "NEEDS_USER"
        : run.status === "FAILED"
          ? "FAILED"
          : "SUCCEEDED";
  const detailHref = `/projects/${project.id}/research`;
  return {
    id: `research:${run.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "RESEARCH",
    sourceId: run.id,
    title: run.mode === "DEEP" ? "深度联网研究" : "联网研究",
    phase: "RESEARCH",
    status,
    progressText:
      run.status === "RUNNING"
        ? "正在获取和核验公开来源"
        : run.status === "BLOCKED"
          ? "等待人工处理后继续"
          : run.status === "FAILED"
            ? "研究未获得可用结果"
            : run.status === "READY"
              ? "等待处理研究结果"
              : "研究已完成",
    ...(run.browserState?.provider
      ? { provider: run.browserState.provider }
      : {}),
    paidState: "FREE",
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.status === "COMPLETED" || run.status === "FAILED"
      ? { completedAt: run.updatedAt }
      : {}),
    ...(run.blockerMessage
      ? {
          blocker: {
            ...(run.blockerCode ? { code: run.blockerCode } : {}),
            message: run.blockerMessage,
            ...(run.requiredUserAction
              ? { requiredAction: run.requiredUserAction }
              : {})
          }
        }
      : {}),
    safeActions: [
      action(
        run.status === "BLOCKED" ? "继续研究" : "查看研究",
        detailHref,
        run.status === "BLOCKED" ? "RESUME" : "OPEN"
      )
    ],
    detailHref,
    technical: {
      sourceStatus: run.status,
      sourceStage: run.mode,
      sourceRef: run.id
    }
  };
}

export function taskFromAgentTask(
  project: Project,
  task: AgentTask
): TaskCenterItem {
  const status: TaskCenterStatus =
    task.status === "SUBMITTED" || task.status === "PROCESSING"
      ? "RUNNING"
      : task.status === "NEEDS_MATERIAL" ||
          task.status === "READY_TO_CONFIRM" ||
          task.status === "REVIEW_READY" ||
          task.status === "RECONCILE_REQUIRED"
        ? "NEEDS_USER"
        : task.status === "ACCEPTED"
          ? "SUCCEEDED"
          : task.status === "FAILED"
            ? "FAILED"
            : "WAITING";
  const paidState: TaskCenterPaidState =
    task.generationAttemptId
      ? "PAID_OR_EXTERNAL"
      : task.status === "APPROVED"
        ? "AUTHORIZED"
        : "NOT_SUBMITTED";
  const detailHref = `/projects/${project.id}/agent`;
  const costText =
    task.plan?.costEstimateStatus === "UNKNOWN"
      ? "成本未知"
      : task.plan?.estimatedCostText ??
        (task.plan?.estimatedCredits !== undefined
          ? `${task.plan.estimatedCredits} credits`
          : undefined);
  return {
    id: `agent:${task.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "AGENT",
    sourceId: task.id,
    title: "Dreamina Agent 任务",
    phase: task.selectedOperation ?? task.requestedMethod,
    status,
    progressText:
      task.status === "NEEDS_MATERIAL"
        ? "等待补充或修正素材"
        : task.status === "READY_TO_CONFIRM"
          ? "等待确认本次付费生成"
          : task.status === "SUBMITTED" || task.status === "PROCESSING"
            ? "视频生成中"
            : task.status === "REVIEW_READY"
              ? "生成完成，等待审片"
              : task.status === "RECONCILE_REQUIRED"
                ? "提交结果未知，需要核对"
                : task.status === "ACCEPTED"
                  ? "生成结果已采用"
                  : task.status === "FAILED"
                    ? "任务失败"
                    : "等待继续",
    provider: "domestic-jimeng-cli",
    model: task.model,
    paidState,
    ...(costText ? { costText } : {}),
    startedAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.acceptedAt ? { completedAt: task.acceptedAt } : {}),
    safeActions: [
      action(
        task.status === "RECONCILE_REQUIRED"
          ? "核对生成状态"
          : task.status === "REVIEW_READY"
            ? "进入审片"
            : "打开 Agent 任务",
        detailHref,
        task.status === "RECONCILE_REQUIRED"
          ? "RECONCILE"
          : task.status === "REVIEW_READY"
            ? "REVIEW"
            : "OPEN"
      )
    ],
    detailHref,
    technical: {
      sourceStatus: task.status,
      sourceStage: task.selectedOperation ?? task.requestedMethod,
      sourceRef: task.id
    }
  };
}

function smartStatus(run: SmartGenerationRun): TaskCenterStatus {
  if (
    ["PLANNING", "APPROVING", "GENERATING", "AUTO_EDITING", "RENDERING"].includes(
      run.status
    )
  ) {
    return "RUNNING";
  }
  if (
    [
      "WAITING_FOR_TRUTH_REVIEW",
      "WAITING_FOR_REFERENCE_REVIEW",
      "WAITING_FOR_CREATIVE_REVIEW",
      "WAITING_FOR_SCRIPT_REVIEW",
      "WAITING_FOR_PLAN_REVIEW",
      "READY_FOR_PAID_CONFIRM",
      "WAITING_FOR_CLIP_REVIEW",
      "WAITING_FOR_AUDIO",
      "REVIEW_READY",
      "BLOCKED"
    ].includes(run.status)
  ) {
    return "NEEDS_USER";
  }
  if (run.status === "COMPLETED") return "SUCCEEDED";
  if (run.status === "CANCELLED") return "CANCELLED";
  if (run.status === "FAILED") return "FAILED";
  return "UNKNOWN";
}

export function taskFromSmartRun(
  project: Project,
  run: SmartGenerationRun
): TaskCenterItem {
  const status = smartStatus(run);
  const detailHref = `/projects/${project.id}/smart`;
  const knownCredits = run.paidScope?.requests
    .filter((item) => item.estimatedCredits !== undefined)
    .reduce((sum, item) => sum + (item.estimatedCredits ?? 0), 0);
  const hasUnknownCost = Boolean(
    run.paidScope?.requests.some((item) => item.costStatus === "UNKNOWN")
  );
  const costText = run.paidScope
    ? hasUnknownCost
      ? knownCredits
        ? `已知部分 ${knownCredits} credits；其余未知`
        : "成本未知"
      : knownCredits !== undefined
        ? `${knownCredits} credits`
        : undefined
    : undefined;
  const paidState: TaskCenterPaidState = run.attemptIds.length
    ? "PAID_OR_EXTERNAL"
    : run.consent
      ? "AUTHORIZED"
      : "NOT_SUBMITTED";
  return {
    id: `smart:${run.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "SMART_RUN",
    sourceId: run.id,
    title: "一键成片",
    phase: run.stage,
    status,
    progressText:
      status === "RUNNING"
        ? `正在执行 ${run.stage}`
        : status === "NEEDS_USER"
          ? `等待处理：${run.stage}`
          : status === "SUCCEEDED"
            ? "一键成片已完成"
            : status === "CANCELLED"
              ? "任务已取消"
              : status === "FAILED"
                ? "一键成片失败"
                : "任务状态需要核对",
    paidState,
    ...(costText ? { costText } : {}),
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.status === "COMPLETED" || run.status === "CANCELLED" || run.status === "FAILED"
      ? { completedAt: run.updatedAt }
      : {}),
    ...(run.blocker
      ? {
          blocker: {
            code: run.blocker.code,
            message: run.blocker.message,
            requiredAction: run.blocker.retryable
              ? "打开一键成片任务处理后继续"
              : "打开任务查看失败详情"
          }
        }
      : {}),
    safeActions: [
      action(
        run.status === "BLOCKED" ? "继续一键成片" : "打开一键成片",
        detailHref,
        run.status === "BLOCKED" ? "RESUME" : "OPEN"
      )
    ],
    detailHref,
    technical: {
      sourceStatus: run.status,
      sourceStage: run.stage,
      sourceRef: run.id
    }
  };
}

export function taskFromGenerationAttempt(
  context: MapContext,
  attempt: GenerationAttempt
): TaskCenterItem {
  const request = context.requests.find(
    (item) => item.id === attempt.generationRequestId
  );
  const decision = context.decisions
    .filter((item) => item.generationAttemptId === attempt.id)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  const sourceBlocker = blockerFor(context.blockers, attempt.id);
  let status: TaskCenterStatus;
  if (
    ["SUBMITTING", "SUBMITTED", "PROCESSING", "RECONCILING"].includes(
      attempt.status
    )
  ) {
    status = "RUNNING";
  } else if (attempt.status === "SUBMISSION_OUTCOME_UNKNOWN") {
    status = "UNKNOWN";
  } else if (
    attempt.status === "FAILED" ||
    attempt.status === "RECONCILED_FAILED"
  ) {
    status = "FAILED";
  } else if (
    attempt.status === "SUCCEEDED" ||
    attempt.status === "RECONCILED_SUCCEEDED"
  ) {
    status = decision?.decision === "ACCEPT" ? "SUCCEEDED" : "NEEDS_USER";
  } else {
    status = "WAITING";
  }

  const command = lastCommand(attempt);
  const detailHref = `/projects/${context.project.id}/generate`;
  return {
    id: `generation:${attempt.id}`,
    projectId: context.project.id,
    projectName: context.project.name,
    sourceType: "GENERATION",
    sourceId: attempt.id,
    title: `视频生成 · 镜头 ${attempt.clipId}`,
    phase: attempt.status,
    status,
    progressText:
      attempt.status === "CREATED"
        ? "已确认，等待提交"
        : attempt.status === "SUBMISSION_OUTCOME_UNKNOWN"
          ? "提交结果未知，需要核对"
          : attempt.status === "RECONCILING"
            ? "正在核对提交结果"
            : attempt.status === "SUBMITTED" || attempt.status === "PROCESSING"
              ? "Dreamina 生成中"
              : attempt.status === "SUCCEEDED" ||
                  attempt.status === "RECONCILED_SUCCEEDED"
                ? decision?.decision === "ACCEPT"
                  ? "生成完成并已采用"
                  : decision?.decision === "REDO"
                    ? "生成完成，已要求重做"
                    : "生成完成，等待审片"
                : attempt.status === "FAILED" ||
                    attempt.status === "RECONCILED_FAILED"
                  ? "生成失败"
                  : "正在提交",
    provider: request?.provider ?? "domestic-jimeng-cli",
    ...(request?.model ? { model: request.model } : {}),
    paidState:
      attempt.status === "CREATED" ? "AUTHORIZED" : "PAID_OR_EXTERNAL",
    ...(costTextFromPreflight(attempt.generationRequestId, context.preflights)
      ? {
          costText: costTextFromPreflight(
            attempt.generationRequestId,
            context.preflights
          )
        }
      : {}),
    startedAt: attempt.createdAt,
    updatedAt:
      attempt.completedAt ?? attempt.submittedAt ?? command?.completedAt ??
      command?.startedAt ?? attempt.createdAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(sourceBlocker || attempt.errorMessage
      ? {
          blocker: {
            ...(sourceBlocker?.reasonCode || attempt.errorCode
              ? {
                  code:
                    sourceBlocker?.reasonCode ??
                    attempt.errorCode
                }
              : {}),
            message:
              sourceBlocker?.message ??
              attempt.errorMessage ??
              "生成任务需要处理",
            ...(sourceBlocker?.requiredUserAction
              ? { requiredAction: sourceBlocker.requiredUserAction }
              : {})
          }
        }
      : {}),
    safeActions: [
      action(
        attempt.status === "SUBMISSION_OUTCOME_UNKNOWN"
          ? "核对生成状态"
          : status === "NEEDS_USER"
            ? "进入审片"
            : "查看生成任务",
        detailHref,
        attempt.status === "SUBMISSION_OUTCOME_UNKNOWN"
          ? "RECONCILE"
          : status === "NEEDS_USER"
            ? "REVIEW"
            : "OPEN"
      )
    ],
    detailHref,
    technical: {
      sourceStatus: attempt.status,
      ...(command ? { lastCommandOperation: command.operation } : {}),
      ...(command
        ? { lastCommandAt: command.completedAt ?? command.startedAt }
        : {}),
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      sourceRef: attempt.id
    }
  };
}

export function taskFromRenderJob(
  project: Project,
  job: RenderJob
): TaskCenterItem {
  const status: TaskCenterStatus =
    job.status === "QUEUED"
      ? "WAITING"
      : job.status === "RENDERING"
        ? "RUNNING"
        : job.status === "SUCCEEDED"
          ? "SUCCEEDED"
          : "FAILED";
  const detailHref =
    job.status === "SUCCEEDED"
      ? `/projects/${project.id}/final`
      : `/projects/${project.id}/timeline`;
  return {
    id: `render:${job.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "RENDER",
    sourceId: job.id,
    title: "最终视频渲染",
    phase: "RENDER",
    status,
    progressText:
      job.status === "QUEUED"
        ? "等待最终渲染"
        : job.status === "RENDERING"
          ? "正在渲染最终视频"
          : job.status === "SUCCEEDED"
            ? "最终视频渲染完成"
            : "最终渲染失败",
    paidState: "FREE",
    startedAt: job.startedAt ?? job.createdAt,
    updatedAt: job.completedAt ?? job.startedAt ?? job.createdAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.errorMessage
      ? {
          blocker: {
            ...(job.errorCode ? { code: job.errorCode } : {}),
            message: job.errorMessage,
            requiredAction: "返回视频剪辑检查后重新渲染"
          }
        }
      : {}),
    safeActions: [
      action(
        job.status === "SUCCEEDED" ? "查看成片" : "打开视频剪辑",
        detailHref
      )
    ],
    detailHref,
    technical: {
      sourceStatus: job.status,
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      sourceRef: job.id
    }
  };
}

function publishPackageStatus(
  pkg: PublicPublishPackage
): TaskCenterStatus {
  if (
    pkg.status === "HANDOFF_STARTED" ||
    pkg.status === "DIRECT_PUBLISHING"
  ) {
    return "RUNNING";
  }
  if (pkg.status === "PUBLISHED_CONFIRMED") return "SUCCEEDED";
  if (pkg.status === "FAILED") return "FAILED";
  if (
    pkg.status === "PACKAGE_READY" ||
    pkg.status === "AWAITING_USER_ACTION" ||
    pkg.status === "HANDOFF_COMPLETED" ||
    pkg.status === "EXPIRED"
  ) {
    return "NEEDS_USER";
  }
  return "UNKNOWN";
}

export function taskFromPublishPackage(
  project: Project,
  pkg: PublicPublishPackage
): TaskCenterItem {
  const status = publishPackageStatus(pkg);
  const detailHref = `/projects/${project.id}/final`;
  return {
    id: `publish-package:${pkg.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "PUBLISH",
    sourceId: pkg.id,
    title: "发布交接",
    phase: pkg.providerType,
    status,
    progressText:
      pkg.status === "PACKAGE_READY"
        ? "发布包已准备，等待用户继续"
        : pkg.status === "HANDOFF_STARTED"
          ? "已发起平台交接"
          : pkg.status === "AWAITING_USER_ACTION"
            ? "等待用户在平台完成操作"
            : pkg.status === "HANDOFF_COMPLETED"
              ? "交接完成，但尚未获得可信发布回执"
              : pkg.status === "DIRECT_PUBLISHING"
                ? "平台正在发布"
                : pkg.status === "PUBLISHED_CONFIRMED"
                  ? "已获得可信发布回执"
                  : pkg.status === "EXPIRED"
                    ? "发布包已过期，需要重新创建"
                    : pkg.status === "FAILED"
                      ? "发布流程失败"
                      : "发布状态需要核对",
    provider: pkg.providerType,
    paidState: "UNKNOWN",
    startedAt: pkg.createdAt,
    updatedAt:
      pkg.publishedConfirmedAt ??
      pkg.completedAt ??
      pkg.handoffStartedAt ??
      pkg.claimedAt ??
      pkg.createdAt,
    ...(pkg.status === "PUBLISHED_CONFIRMED" && pkg.publishedConfirmedAt
      ? { completedAt: pkg.publishedConfirmedAt }
      : {}),
    ...(pkg.errorMessage
      ? {
          blocker: {
            ...(pkg.errorCode ? { code: pkg.errorCode } : {}),
            message: pkg.errorMessage,
            requiredAction: "打开发布中心检查当前 Provider 状态"
          }
        }
      : {}),
    safeActions: [action("打开发布中心", detailHref)],
    detailHref,
    technical: {
      sourceStatus: pkg.status,
      sourceStage: pkg.providerType,
      ...(pkg.errorCode ? { errorCode: pkg.errorCode } : {}),
      sourceRef: pkg.id
    }
  };
}

export function taskFromPublishAttempt(
  project: Project,
  attempt: PublishAttempt
): TaskCenterItem {
  const status: TaskCenterStatus =
    attempt.status === "UPLOADING" || attempt.status === "PUBLISHING"
      ? "RUNNING"
      : attempt.status === "PUBLISHED"
        ? "SUCCEEDED"
        : attempt.status === "FAILED"
          ? "FAILED"
          : "NEEDS_USER";
  const detailHref = `/projects/${project.id}/final`;
  return {
    id: `publish-attempt:${attempt.id}`,
    projectId: project.id,
    projectName: project.name,
    sourceType: "PUBLISH",
    sourceId: attempt.id,
    title: "抖音发布任务",
    phase: "DOUYIN_LEGACY",
    status,
    progressText:
      attempt.status === "AUTH_REQUIRED"
        ? "等待抖音授权"
        : attempt.status === "UPLOADING"
          ? "正在上传"
          : attempt.status === "PUBLISHING"
            ? "平台正在发布"
            : attempt.status === "PUBLISHED"
              ? "已发布"
              : attempt.status === "FAILED"
                ? "发布失败"
                : "等待发布确认",
    provider: "douyin",
    paidState: "UNKNOWN",
    startedAt: attempt.createdAt,
    updatedAt:
      attempt.completedAt ?? attempt.confirmedAt ?? attempt.createdAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.errorMessage
      ? {
          blocker: {
            ...(attempt.errorCode ? { code: attempt.errorCode } : {}),
            message: attempt.errorMessage,
            requiredAction: "打开发布中心检查授权或重新处理"
          }
        }
      : {}),
    safeActions: [action("打开发布中心", detailHref)],
    detailHref,
    technical: {
      sourceStatus: attempt.status,
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      sourceRef: attempt.id
    }
  };
}

export class TaskCenterService {
  constructor(private readonly deps: TaskCenterDependencies) {}

  async listProject(projectId: string): Promise<TaskCenterItem[]> {
    const project = await this.deps.productFlow.getProject(projectId);
    if (!project) return [];
    const [
      researchData,
      agentTasks,
      smartRuns,
      attempts,
      blockers,
      requests,
      preflights,
      decisions,
      renderJobs,
      publishAttempts,
      publishAudit
    ] = await Promise.all([
      this.deps.research.pageData(projectId),
      this.deps.agentMode.listTasks(projectId),
      this.deps.smartGeneration?.list(projectId) ?? Promise.resolve([]),
      this.deps.workflow.listGenerationAttempts(projectId),
      this.deps.workflow.listOpenBlockers(projectId),
      this.deps.generation.listGenerationRequests(projectId),
      this.deps.generation.listPreflightReports(projectId),
      this.deps.review.listDecisions(projectId),
      this.deps.timeline.listRenderJobs(projectId),
      this.deps.finalOutput.listPublishAttempts(projectId),
      this.deps.publishBridge.audit(projectId)
    ]);

    const context: MapContext = {
      project,
      blockers,
      requests,
      preflights,
      decisions
    };

    return [
      ...researchData.runs.map((run) => taskFromResearchRun(project, run)),
      ...agentTasks.map((task) => taskFromAgentTask(project, task)),
      ...smartRuns.map((run) => taskFromSmartRun(project, run)),
      ...attempts.map((attempt) =>
        taskFromGenerationAttempt(context, attempt)
      ),
      ...renderJobs.map((job) => taskFromRenderJob(project, job)),
      ...publishAudit.packages.map((pkg) =>
        taskFromPublishPackage(project, pkg)
      ),
      ...publishAttempts.map((attempt) =>
        taskFromPublishAttempt(project, attempt)
      )
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listAll(): Promise<TaskCenterItem[]> {
    const projects = await this.deps.productFlow.listProjects();
    const batches = await Promise.all(
      projects.map((project) => this.listProject(project.id))
    );
    return batches.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
