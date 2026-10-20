import type { Project, Timeline, WorkflowBlocker } from "../../domain/schemas.js";
import type { WorkflowReadModel } from "./workflow-read-model.js";

export type WorkflowPageKind =
  | "product"
  | "research"
  | "truth"
  | "creative"
  | "script"
  | "director"
  | "generate"
  | "timeline"
  | "final";

export type WorkflowStepState =
  | "LOCKED"
  | "AVAILABLE"
  | "CURRENT"
  | "COMPLETE"
  | "OPTIONAL"
  | "RESUME";

export type WorkflowNavigationStep = {
  key: WorkflowPageKind;
  index: number;
  title: string;
  href: string;
  optional: boolean;
  state: WorkflowStepState;
  badge?: string;
};

export type WorkflowNavigationState = {
  currentPage: WorkflowPageKind | null;
  pageTaskText: string;
  globalResumeStep: WorkflowPageKind;
  globalResumeHref: string;
  globalResumeText: string;
  progressIndex: number;
  steps: WorkflowNavigationStep[];
  /** UX-R1: sole user-facing next action, calculated from existing task truth. */
  workflow?: WorkflowReadModel;
};

type ResolveWorkflowNavigationInput = {
  project: Project;
  currentPage: WorkflowPageKind | null;
  blockers?: WorkflowBlocker[];
  timeline?: Pick<Timeline, "status">;
  finalAssemblyStatus?: "READY" | "ACCEPTED" | "STALE";
  workflow?: WorkflowReadModel;
};

const stepDefinitions: Array<{
  key: WorkflowPageKind;
  index: number;
  title: string;
  optional?: boolean;
}> = [
  { key: "product", index: 1, title: "产品输入" },
  { key: "research", index: 2, title: "联网研究", optional: true },
  { key: "truth", index: 3, title: "产品事实" },
  { key: "creative", index: 4, title: "创意方案" },
  { key: "script", index: 5, title: "脚本" },
  { key: "director", index: 6, title: "导演分镜" },
  { key: "generate", index: 7, title: "视频生成" },
  { key: "timeline", index: 8, title: "视频剪辑" },
  { key: "final", index: 9, title: "成片与发布" }
];

function progressIndex(
  project: Project,
  timeline?: Pick<Timeline, "status">,
  finalAssemblyStatus?: "READY" | "ACCEPTED" | "STALE"
): number {
  if (finalAssemblyStatus && finalAssemblyStatus !== "STALE") return 9;
  if (timeline?.status === "CONFIRMED") return 9;
  if (timeline?.status === "DRAFT") return 8;
  const byStatus: Record<Project["status"], number> = {
    DRAFT: 1,
    PRODUCT_TRUTH_REVIEW: 3,
    CREATIVE_REVIEW: 4,
    SCRIPT_REVIEW: 5,
    DIRECTOR_REVIEW: 6,
    READY_TO_GENERATE: 7,
    GENERATING: 7,
    GENERATION_REVIEW: 7,
    READY_TO_ASSEMBLE: 8,
    FINAL_REVIEW: 9,
    READY_TO_PUBLISH: 9,
    PUBLISHING: 9,
    PUBLISHED: 9,
    COMPLETED: 9,
    FAILED: 1
  };
  return byStatus[project.status];
}

function resumePage(
  project: Project,
  timeline?: Pick<Timeline, "status">,
  finalAssemblyStatus?: "READY" | "ACCEPTED" | "STALE"
): WorkflowPageKind {
  if (finalAssemblyStatus && finalAssemblyStatus !== "STALE") return "final";
  if (timeline?.status === "CONFIRMED") return "final";
  if (timeline?.status === "DRAFT") return "timeline";
  if (project.status === "DRAFT") return "product";
  if (project.status === "PRODUCT_TRUTH_REVIEW") return "truth";
  if (project.status === "CREATIVE_REVIEW") return "creative";
  if (project.status === "SCRIPT_REVIEW") return "script";
  if (project.status === "DIRECTOR_REVIEW") return "director";
  if (project.status === "READY_TO_ASSEMBLE") return "timeline";
  if (
    project.status === "FINAL_REVIEW" ||
    project.status === "READY_TO_PUBLISH" ||
    project.status === "PUBLISHING" ||
    project.status === "PUBLISHED" ||
    project.status === "COMPLETED"
  ) {
    return "final";
  }
  return "generate";
}

export function workflowPageTaskText(
  page: WorkflowPageKind,
  project: Project
): string {
  if (page === "product") return "检查或更新产品资料";
  if (page === "research") return "补充公开证据并筛选可用研究结果";
  if (page === "truth") return "核对并确认产品事实与使用规则";
  if (page === "creative") return "查看、选择或重新生成创意方案";
  if (page === "script") return "检查并确认当前脚本";
  if (page === "director") return "检查并确认导演分镜与生成目标";
  if (page === "timeline") return "调整并确认视频剪辑方案";
  if (page === "final") {
    if (project.status === "FINAL_REVIEW") return "播放并确认最终成片";
    if (
      project.status === "READY_TO_PUBLISH" ||
      project.status === "PUBLISHING" ||
      project.status === "PUBLISHED" ||
      project.status === "COMPLETED"
    ) {
      return "选择可用发布方式并核对发布状态";
    }
    return "渲染并确认最终成片";
  }
  if (project.status === "READY_TO_GENERATE") {
    return "运行生成前检查并确认本次生成";
  }
  if (project.status === "GENERATING") {
    return "等待视频生成完成并查看进度";
  }
  if (project.status === "GENERATION_REVIEW") {
    return "审片并决定采用、重做或跳过";
  }
  if (
    project.status === "READY_TO_ASSEMBLE" ||
    project.status === "FINAL_REVIEW" ||
    project.status === "READY_TO_PUBLISH" ||
    project.status === "PUBLISHING" ||
    project.status === "PUBLISHED" ||
    project.status === "COMPLETED"
  ) {
    return "查看已采用镜头与生成记录";
  }
  return "检查生成设置、生成记录与当前阻塞";
}

function resumeText(
  project: Project,
  blockers: WorkflowBlocker[],
  resume: WorkflowPageKind
): string {
  if (project.status === "FAILED") {
    return blockers[0]?.requiredUserAction ?? "处理失败原因后恢复流程";
  }
  return workflowPageTaskText(resume, project);
}

export function resolveWorkflowNavigation(
  input: ResolveWorkflowNavigationInput
): WorkflowNavigationState {
  const { project, currentPage } = input;
  const blockers = input.blockers ?? [];
  const progress = progressIndex(
    project,
    input.timeline,
    input.finalAssemblyStatus
  );
  const resume = resumePage(
    project,
    input.timeline,
    input.finalAssemblyStatus
  );

  const steps = stepDefinitions.map((step): WorkflowNavigationStep => {
    let state: WorkflowStepState = "AVAILABLE";
    if (step.key === currentPage) {
      state = "CURRENT";
    } else if (step.key === resume) {
      state = "RESUME";
    } else if (step.optional) {
      state = "OPTIONAL";
    } else if (step.index < progress) {
      state = "COMPLETE";
    }

    const badge =
      state === "CURRENT"
        ? "当前"
        : state === "RESUME"
          ? "继续"
          : state === "COMPLETE"
            ? "完成"
            : state === "OPTIONAL"
              ? "可选"
              : undefined;

    return {
      key: step.key,
      index: step.index,
      title: step.title,
      href: `/projects/${project.id}/${step.key}`,
      optional: Boolean(step.optional),
      state,
      ...(badge ? { badge } : {})
    };
  });

  return {
    currentPage,
    pageTaskText: currentPage
      ? workflowPageTaskText(currentPage, project)
      : "使用辅助工具；主流程恢复位置保持不变",
    globalResumeStep: resume,
    globalResumeHref: input.workflow?.action.href ?? `/projects/${project.id}/${resume}`,
    globalResumeText: input.workflow?.action.label ?? resumeText(project, blockers, resume),
    progressIndex: progress,
    steps,
    ...(input.workflow ? { workflow: input.workflow } : {})
  };
}
