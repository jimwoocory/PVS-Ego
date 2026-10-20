import type { Project } from "../../domain/schemas.js";
import { closedSmartStatuses, type SmartGenerationRun, type SmartRunStatus, type SmartStage } from "../../domain/smart-generation.js";

/**
 * W1 presentation-only workflow decision. Never submit, approve, generate, publish, or
 * mutate existing Project/SmartRun data while deriving a "next action".
 */
export type WorkflowNextAction = {
  projectId: string;
  source: "SMART_RUN" | "PROJECT" | "TASK_SELECTION";
  runId?: string;
  stage?: SmartStage;
  stageLabel: string;
  status: "USER_ACTION" | "IN_PROGRESS" | "BLOCKED" | "COMPLETED";
  statusLabel: string;
  action: {
    kind: "OPEN" | "REVIEW" | "CONFIRM" | "WATCH";
    label: string;
    href: string;
    requiresExplicitConsent: boolean;
  };
  /** Fixed, same-project resume target. Never derived from a user-supplied return URL. */
  returnHref: string;
  explanation: string;
};

export type WorkflowNextInput = {
  project: Pick<Project, "id" | "status">;
  productInputPresent: boolean;
  productImagePresent: boolean;
  productTruthConfirmed: boolean;
  /** False explicitly means saved input exists but review draft is not yet generated. */
  productTruthDraftPresent?: boolean;
  runs: ReadonlyArray<SmartGenerationRun>;
};

const stageLabels: Record<SmartStage, string> = {
  SOURCES: "检查产品资料与参考",
  CREATIVE: "创意策划",
  PRODUCTION_PLANNING: "制作策略规划",
  ASSET_PREP: "角色与场景资产",
  SCRIPT: "剧本创作",
  DIRECTOR: "导演分镜与提示词",
  PREFLIGHT: "生成前检查",
  APPROVAL: "本次生成授权",
  GENERATION: "视频生成",
  CLIP_REVIEW: "镜头审片",
  AUTO_EDIT: "自动剪辑与声音",
  RENDER: "成片渲染",
  FINAL_REVIEW: "成片确认"
};

type ActionRule = {
  status: WorkflowNextAction["status"];
  statusLabel: string;
  kind: WorkflowNextAction["action"]["kind"];
  label: string;
  page: "smart" | "truth" | "creative-references" | "generate" | "final";
  requiresExplicitConsent?: boolean;
  explanation: string;
};

const statusRules: Record<SmartRunStatus, ActionRule> = {
  PLANNING: { status: "IN_PROGRESS", statusLabel: "正在规划", kind: "WATCH", label: "查看当前任务进度", page: "smart", explanation: "程序正在推进已允许的非付费规划步骤，无需重复点击。" },
  WAITING_FOR_TRUTH_REVIEW: { status: "USER_ACTION", statusLabel: "等待人工审核", kind: "REVIEW", label: "审核产品事实与使用规则", page: "truth", explanation: "确认真实产品事实后，返回原智能生成任务继续。" },
  WAITING_FOR_REFERENCE_REVIEW: { status: "USER_ACTION", statusLabel: "等待人工审核", kind: "REVIEW", label: "检查并确认创作参考素材", page: "creative-references", explanation: "研究中的图片和视频帧需要明确确认后才能用于生成。" },
  WAITING_FOR_CREATIVE_REVIEW: { status: "USER_ACTION", statusLabel: "等待选择", kind: "REVIEW", label: "选择本轮创意方案", page: "smart", explanation: "选择创意后原任务继续制作策略与固定资产规划。" },
  WAITING_FOR_SCRIPT_REVIEW: { status: "USER_ACTION", statusLabel: "等待确认", kind: "REVIEW", label: "审核本轮剧本", page: "smart", explanation: "本轮剧本需要明确人工确认，修改前检查下游版本影响。" },
  WAITING_FOR_DIRECTOR_REVIEW: { status: "USER_ACTION", statusLabel: "等待导演采用", kind: "REVIEW", label: "审核导演镜头与时长", page: "smart", explanation: "请核对逐镜台词、动作及揭晓顺序后明确采用，尚未付费。" },
  WAITING_FOR_PROMPT_REVIEW: { status: "USER_ACTION", statusLabel: "等待提示词采用", kind: "REVIEW", label: "绑定角色声线并审核逐镜提示词", page: "smart", explanation: "确认完整声音、动作及后期文字后才准备本轮费用范围。" },
  WAITING_FOR_PLAN_REVIEW: { status: "USER_ACTION", statusLabel: "等待确认", kind: "REVIEW", label: "审核导演分镜", page: "smart", explanation: "分镜确认后才执行正式视频生成前检查。" },
  READY_FOR_ASSET_PAID_CONFIRM: { status: "USER_ACTION", statusLabel: "等待费用确认", kind: "CONFIRM", label: "查看制作资产并确认积分范围", page: "smart", requiresExplicitConsent: true, explanation: "这里只打开具体资产与费用确认界面，不会自动向即梦提交生图任务。" },
  ASSET_PREPARING: { status: "IN_PROGRESS", statusLabel: "正在处理", kind: "WATCH", label: "查看固定资产生成进度", page: "smart", explanation: "保留已提交任务及其编号，不会因为刷新而重复提交。" },
  WAITING_FOR_ASSET_REVIEW: { status: "USER_ACTION", statusLabel: "等待看图确认", kind: "REVIEW", label: "逐项查看并确认角色与场景资产", page: "smart", explanation: "仅确认实际图片后继续。需要重做的资产独立处理并重新申请费用授权。" },
  READY_FOR_PAID_CONFIRM: { status: "USER_ACTION", statusLabel: "等待费用确认", kind: "CONFIRM", label: "审核镜头与确认本轮生成费用", page: "smart", requiresExplicitConsent: true, explanation: "明确确认当前镜头和费用范围后才允许生成视频，不包含后续重做。" },
  APPROVING: { status: "IN_PROGRESS", statusLabel: "审批处理中", kind: "WATCH", label: "查看生成审批状态", page: "smart", explanation: "检查本轮已获授权的请求；不能未经同意提交新增镜头。" },
  GENERATING: { status: "IN_PROGRESS", statusLabel: "正在生成", kind: "WATCH", label: "查看视频生成与下载状态", page: "smart", explanation: "任务会查询已提交结果，刷新页面不会作为新付费授权。" },
  WAITING_FOR_CLIP_REVIEW: { status: "USER_ACTION", statusLabel: "等待人工审片", kind: "REVIEW", label: "播放并确认待审镜头", page: "generate", explanation: "逐镜头选择采用、重做或跳过；处理后返回原任务。" },
  AUTO_EDITING: { status: "IN_PROGRESS", statusLabel: "正在剪辑", kind: "WATCH", label: "查看自动剪辑进度", page: "smart", explanation: "根据已采用镜头规划 Timeline，不覆盖已有手工编辑。" },
  WAITING_FOR_AUDIO: { status: "USER_ACTION", statusLabel: "等待音频处理", kind: "REVIEW", label: "补充声音设置并继续剪辑", page: "smart", explanation: "缺少必要的音频时暂停，不以文字推测替代真实试听。" },
  RENDERING: { status: "IN_PROGRESS", statusLabel: "正在渲染", kind: "WATCH", label: "查看成片渲染进度", page: "smart", explanation: "渲染和发布是独立阶段；不会自动向抖音发布。" },
  REVIEW_READY: { status: "USER_ACTION", statusLabel: "等待成片确认", kind: "REVIEW", label: "查看质检并确认最终成片", page: "final", explanation: "先确认最终 MP4，再决定是否进入独立发布流程。" },
  COMPLETED: { status: "COMPLETED", statusLabel: "本轮成片已确认", kind: "OPEN", label: "查看成片与发布状态", page: "final", explanation: "已确认成片不等于已经向抖音发布。" },
  BLOCKED: { status: "BLOCKED", statusLabel: "任务已暂停", kind: "OPEN", label: "查看阻塞原因并恢复原任务", page: "smart", explanation: "仅在原因解决后恢复原任务，未知提交结果不得重复提交。" },
  FAILED: { status: "BLOCKED", statusLabel: "执行失败", kind: "OPEN", label: "查看失败原因与恢复选项", page: "smart", explanation: "保留已完成的资产和生成记录，避免从头重复付费操作。" },
  CANCELLED: { status: "COMPLETED", statusLabel: "本轮已取消", kind: "OPEN", label: "查看历史并决定是否新建任务", page: "smart", explanation: "取消本地编排不代表远端已提交任务必然取消。" }
};

function scopedHref(projectId: string, page: string, runId?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/${page}`;
  return runId
    ? `${base}?fromSmartRun=${encodeURIComponent(runId)}`
    : base;
}

export function resolveProductionNextAction(input: WorkflowNextInput): WorkflowNextAction {
  const projectId = input.project.id;
  // Do not permit accidental cross-project linking from stale or corrupted run snapshots.
  const ownRuns = input.runs.filter(run => run.projectId === projectId);
  const byRecent = (a: SmartGenerationRun, b: SmartGenerationRun) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const currentRun = ownRuns.filter(run => !closedSmartStatuses.includes(run.status)).sort(byRecent)[0];

  if (currentRun) {
    const rule = statusRules[currentRun.status];
    const returnHref = `/projects/${encodeURIComponent(projectId)}/smart#smart-run-${encodeURIComponent(currentRun.id)}`;
    const href = rule.page === "smart"
      ? returnHref
      : scopedHref(projectId, rule.page, currentRun.id);
    return {
      projectId, source: "SMART_RUN", runId: currentRun.id,
      stage: currentRun.stage, stageLabel: stageLabels[currentRun.stage],
      status: rule.status, statusLabel: rule.statusLabel,
      action: {
        kind: rule.kind, label: rule.label, href,
        requiresExplicitConsent: rule.requiresExplicitConsent === true
      },
      returnHref,
      explanation: currentRun.blocker?.message ?? rule.explanation
    };
  }

  const latestClosed = ownRuns.sort(byRecent)[0];
  const published = ["FINAL_REVIEW", "READY_TO_PUBLISH", "PUBLISHING", "PUBLISHED", "COMPLETED"].includes(input.project.status);
  let page = "smart";
  let label = "进入智能生成";
  let stageLabel = "准备开始";
  let explanation = "当前项目没有正在执行的一键成片任务。可以继续制作或创建新任务。";
  if (published || latestClosed?.status === "COMPLETED") {
    page = "final";
    label = "查看成片与发布";
    stageLabel = "成片与发布";
    explanation = "查看真实成片和发布回执。已生成的历史任务不会再次提交。";
  } else if (!input.productInputPresent || !input.productImagePresent) {
    page = "product";
    label = "补充产品资料与图片";
    stageLabel = "产品资料";
    explanation = "开始制作前需保存真实的产品基础信息及至少一张产品图片。";
  } else if (!input.productTruthConfirmed) {
    if (input.productTruthDraftPresent === false) {
      page = "research";
      label = "联网研究（可跳过），然后确认产品事实";
      stageLabel = "可选联网研究";
      explanation = "产品资料已保存。研究可以跳过；无论是否研究，随后都必须生成并人工确认产品事实。";
    } else {
      page = "truth";
      label = "确认产品事实";
      stageLabel = "产品事实";
      explanation = "请核对可确定的产品信息和使用规则，不直接采信研究推测。";
    }
  } else if (latestClosed?.status === "CANCELLED") {
    page = "smart";
    label = "查看已取消任务并新建智能生成";
    stageLabel = "准备新任务";
    explanation = "上一轮智能生成已取消；不会沿用旧生成授权，也不会强制跳到旧视频生成页。";
  } else {
    const legacy: Partial<Record<Project["status"], { page: string; label: string; stage: string }>> = {
      CREATIVE_REVIEW: { page: "creative", label: "选择创意方案", stage: "创意方案" },
      SCRIPT_REVIEW: { page: "script", label: "确认剧本", stage: "剧本创作" },
      DIRECTOR_REVIEW: { page: "director", label: "确认导演分镜", stage: "导演分镜" },
      READY_TO_GENERATE: { page: "generate", label: "检查生成设置", stage: "视频生成" },
      GENERATING: { page: "generate", label: "查看生成进度", stage: "视频生成" },
      GENERATION_REVIEW: { page: "generate", label: "审片并决定采用或重做", stage: "镜头审片" },
      READY_TO_ASSEMBLE: { page: "timeline", label: "进入视频剪辑", stage: "视频剪辑" }
    };
    const mapped = legacy[input.project.status];
    if (mapped) {
      page = mapped.page; label = mapped.label; stageLabel = mapped.stage;
      explanation = "当前是兼容的分阶段项目，继续现有步骤，不会新建或提交视频请求。";
    }
  }

  const returnHref = scopedHref(projectId, "smart");
  return {
    projectId, source: "PROJECT", stageLabel,
    status: page === "final" && input.project.status === "PUBLISHED" ? "COMPLETED" : "USER_ACTION",
    statusLabel: page === "final" ? "查看已有结果" : "准备继续",
    action: { kind: "OPEN", label, href: scopedHref(projectId, page), requiresExplicitConsent: false },
    returnHref,
    explanation
  };
}
