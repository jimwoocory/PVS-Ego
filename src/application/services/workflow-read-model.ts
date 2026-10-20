import type { SmartGenerationRun, SmartStage } from "../../domain/smart-generation.js";
import type { Project, Timeline } from "../../domain/schemas.js";
import type { FinalAssemblyStatus } from "../ports/final-output-repository.js";
import {
  resolveProductionNextAction,
  type WorkflowNextAction,
  type WorkflowNextInput
} from "./workflow-next-action.js";

/**
 * UX-R1: the sole user-facing read model for navigation and resume decisions.
 * Combines the existing SmartRun truth with the legacy Project adapter.
 * This is a projection, NOT another generation state machine. No I/O/writes.
 */
export type WorkflowPhaseKey = "PRODUCT" | "CREATIVE" | "PREPARATION" | "VIDEO" | "ASSEMBLY" | "PUBLISH";
export type WorkflowPhaseView = {
  key: WorkflowPhaseKey;
  label: string;
  status: "DONE" | "CURRENT" | "UPCOMING" | "OPTIONAL";
};
export type WorkflowTaskOption = {
  runId: string;
  stageLabel: string;
  statusLabel: string;
  updatedAt: string;
  selectHref: string;
};
export type WorkflowReadModel = WorkflowNextAction & {
  /** True when no run can safely be picked on the user's behalf. */
  taskSelectionRequired: boolean;
  selectedRunId?: string;
  activeTaskCount: number;
  taskOptions: WorkflowTaskOption[];
  phase: WorkflowPhaseKey;
  phases: WorkflowPhaseView[];
  /** User-facing distinction between confirmed project prerequisites and run progress. */
  phaseNote?: string;
  /** A Project.status marker is not proof of a trusted platform receipt. */
  publication: {
    projectMarkedPublished: boolean;
    label: string;
    receiptVerification: "NOT_CHECKED";
    explanation: string;
  };
};
export type WorkflowReadInput = WorkflowNextInput & {
  /** A project-scoped SmartRun id explicitly chosen by the user. */
  selectedRunId?: string | null;
  /** Actual saved media results can be newer than legacy Project.status. */
  timelineStatus?: Timeline["status"] | null;
  finalAssemblyStatus?: FinalAssemblyStatus | null;
  /** When a current plan exists, never promote an artifact from a different plan. */
  projectPlanHash?: string | null;
  timelinePlanHash?: string | null;
  finalAssemblyPlanHash?: string | null;
};

const phaseDefinitions: ReadonlyArray<{ key: WorkflowPhaseKey; label: string }> = [
  { key: "PRODUCT", label: "产品与事实" },
  { key: "CREATIVE", label: "研究与创意" },
  { key: "PREPARATION", label: "制作准备" },
  { key: "VIDEO", label: "视频与审片" },
  { key: "ASSEMBLY", label: "剪辑与成片" },
  { key: "PUBLISH", label: "发布与运营" }
];

const smartPhase: Record<SmartStage, WorkflowPhaseKey> = {
  SOURCES: "PRODUCT",
  CREATIVE: "CREATIVE",
  PRODUCTION_PLANNING: "PREPARATION",
  ASSET_PREP: "PREPARATION",
  SCRIPT: "PREPARATION",
  DIRECTOR: "PREPARATION",
  PREFLIGHT: "VIDEO",
  APPROVAL: "VIDEO",
  GENERATION: "VIDEO",
  CLIP_REVIEW: "VIDEO",
  AUTO_EDIT: "ASSEMBLY",
  RENDER: "ASSEMBLY",
  FINAL_REVIEW: "ASSEMBLY"
};

function legacyPhase(next: WorkflowNextAction, projectStatus: Project["status"]): WorkflowPhaseKey {
  const path = next.action.href.split("?")[0]!.split("#")[0]!;
  const segment = path.split("/").filter(Boolean).at(-1);
  if (segment === "product" || segment === "truth") return "PRODUCT";
  if (segment === "research" || segment === "creative" || segment === "creative-references") return "CREATIVE";
  if (segment === "script" || segment === "director") return "PREPARATION";
  if (segment === "generate") return "VIDEO";
  if (segment === "timeline" || segment === "auto-edit") return "ASSEMBLY";
  if (segment === "final") return projectStatus === "FINAL_REVIEW" ? "ASSEMBLY" : "PUBLISH";
  return "CREATIVE"; // idle / cancelled project, ready to create a new task
}

function activeRuns(input: WorkflowReadInput): SmartGenerationRun[] {
  return input.runs
    .filter(run => run.projectId === input.project.id && run.status !== "COMPLETED" && run.status !== "CANCELLED")
    .sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
      || b.createdAt.localeCompare(a.createdAt)
      || b.id.localeCompare(a.id)
    );
}

export function resolveWorkflowReadModel(input: WorkflowReadInput): WorkflowReadModel {
  const projectId = input.project.id;
  const available = activeRuns(input);
  const chosen = input.selectedRunId ? available.find(run => run.id === input.selectedRunId) : undefined;
  const explicitlyInvalid = Boolean(input.selectedRunId && !chosen);
  const needsChoice = available.length > 0 && (explicitlyInvalid || (available.length > 1 && !chosen));
  const tasks: WorkflowTaskOption[] = available.map(run => {
    const next = resolveProductionNextAction({
      ...input, runs: [run]
    });
    return {
      runId: run.id,
      stageLabel: next.stageLabel,
      statusLabel: next.statusLabel,
      updatedAt: run.updatedAt,
      selectHref: `/projects/${encodeURIComponent(projectId)}/smart?activeRun=${encodeURIComponent(run.id)}#smart-run-${encodeURIComponent(run.id)}`
    };
  });

  // For a user-selected run, deliberately omit other active runs when invoking the
  // existing resolver; otherwise it would silently choose the newest one again.
  const current = needsChoice
    ? undefined
    : resolveProductionNextAction({
        ...input,
        runs: chosen ? input.runs.filter(run =>
          run.projectId !== projectId
          || run.id === chosen.id
          || run.status === "COMPLETED"
          || run.status === "CANCELLED"
        ) : input.runs
      });

  let result: WorkflowNextAction = current ?? {
    projectId,
    source: "TASK_SELECTION",
    stageLabel: "选择当前任务",
    status: "USER_ACTION",
    statusLabel: explicitlyInvalid ? "指定任务不存在或不可继续" : "多个任务等待选择",
    action: {
      kind: "OPEN",
      label: "选择要继续的任务",
      href: `/projects/${encodeURIComponent(projectId)}/smart#choose-task`,
      requiresExplicitConsent: false
    },
    returnHref: `/projects/${encodeURIComponent(projectId)}/smart#choose-task`,
    explanation: explicitlyInvalid
      ? "指定任务不属于该项目或已经结束。请从本项目的进行中任务里重新选择。"
      : "检测到多个未结束的制作任务。必须由你明确选择，系统不会按照更新时间偷偷切换。"
  };

  // A legacy Project.status is a compatibility hint, not authority to send a
  // user backwards when a real Timeline or FinalAssembly exists. SmartRun always
  // retains priority; only an idle legacy project is adapted here.
  let artifactPhase: WorkflowPhaseKey | undefined;
  const assemblyStatus = !input.projectPlanHash || input.finalAssemblyPlanHash === input.projectPlanHash
    ? input.finalAssemblyStatus : undefined;
  const timelineStatus = !input.projectPlanHash || input.timelinePlanHash === input.projectPlanHash
    ? input.timelineStatus : undefined;
  const artifactStep = assemblyStatus === "ACCEPTED"
    ? { page: "final", stage: "成片已确认", label: "查看已确认成片与发布状态", phase: "PUBLISH" as const }
    : assemblyStatus === "READY"
      ? { page: "final", stage: "成片待确认", label: "检查并确认已渲染成片", phase: "ASSEMBLY" as const }
      : timelineStatus === "CONFIRMED"
        ? { page: "final", stage: "剪辑已确认", label: "渲染并确认最终成片", phase: "ASSEMBLY" as const }
        : timelineStatus === "DRAFT"
          ? { page: "timeline", stage: "剪辑草稿", label: "继续编辑已保存剪辑方案", phase: "ASSEMBLY" as const }
          : undefined;
  if (available.length === 0 && result.source === "PROJECT" && artifactStep) {
    artifactPhase = artifactStep.phase;
    result = {
      ...result,
      stageLabel: artifactStep.stage,
      status: "USER_ACTION",
      statusLabel: "已有结果可以继续",
      action: {
        kind: "OPEN",
        label: artifactStep.label,
        href: `/projects/${encodeURIComponent(projectId)}/${artifactStep.page}`,
        requiresExplicitConsent: false
      },
      explanation: "检测到已保存的真实剪辑或成片版本。旧项目阶段可能滞后，这里优先使用实际可继续的成果；进入发布仍需核对可信平台回执。"
    };
  }

  // A newly created run may still be checking sources even though the project
  // already has confirmed product facts. Do not send the sidebar backwards.
  const confirmedSourceCheck = !needsChoice && result.source === "SMART_RUN" &&
    result.stage === "SOURCES" && input.productTruthConfirmed &&
    input.productInputPresent && input.productImagePresent;
  const phase = needsChoice ? "CREATIVE" : confirmedSourceCheck ? "CREATIVE" : artifactPhase ?? (result.stage && result.source === "SMART_RUN"
    ? smartPhase[result.stage]
    : legacyPhase(result, input.project.status));
  const phaseIndex = phaseDefinitions.findIndex(item => item.key === phase);
  const phases: WorkflowPhaseView[] = phaseDefinitions.map((item, index) => ({
    key: item.key,
    label: item.label,
    status: needsChoice ? item.key === "PUBLISH" ? "OPTIONAL" : "UPCOMING"
      : item.key === "PUBLISH" && phase !== "PUBLISH"
      ? "OPTIONAL"
      : index < phaseIndex ? "DONE" : index === phaseIndex ? "CURRENT" : "UPCOMING"
  }));

  const projectMarkedPublished: boolean = input.project.status === "PUBLISHED";
  // When the user explicitly selects an older run, every return/continue link
  // must preserve that choice. A bare #smart-run fragment loses the selection
  // after a full navigation and would immediately ask the user to choose again.
  const selectedContextHref = chosen && result.source === "SMART_RUN"
    ? `/projects/${encodeURIComponent(projectId)}/smart?activeRun=${encodeURIComponent(chosen.id)}#smart-run-${encodeURIComponent(chosen.id)}`
    : undefined;
  const scopedAction = selectedContextHref && result.action.href === result.returnHref
    ? { ...result.action, href: selectedContextHref }
    : result.action;
  return {
    ...result,
    ...(selectedContextHref ? { returnHref: selectedContextHref, action: scopedAction } : {}),
    taskSelectionRequired: needsChoice,
    ...(chosen ? { selectedRunId: chosen.id } : !needsChoice && available.length === 1
      ? { selectedRunId: available[0]!.id } : {}),
    activeTaskCount: available.length,
    taskOptions: tasks,
    phase,
    phases,
    ...(confirmedSourceCheck ? { phaseNote: "产品事实已确认；本轮仍在检查资料关联，尚未产出创意或剧本。" } : {}),
    publication: {
      projectMarkedPublished,
      label: projectMarkedPublished ? "项目历史状态：已发布" : "尚无项目已发布状态",
      receiptVerification: "NOT_CHECKED",
      explanation: projectMarkedPublished
        ? "此处只反映旧项目状态；实际抖音可信发布回执需要进入成片 / 运营页核对。它不代表本轮新任务已完成。"
        : "项目当前状态不代表已在抖音成功发布；只有可核查的发布回执可以证明。"
    }
  };
}
