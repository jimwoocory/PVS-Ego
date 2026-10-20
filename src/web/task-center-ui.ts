import type {
  TaskCenterItem,
  TaskCenterStatus
} from "../domain/task-center.js";
import { layout } from "./workbench-ui.js";

const sourceLabel: Record<TaskCenterItem["sourceType"], string> = {
  RESEARCH: "联网研究",
  AGENT: "Agent 生成",
  SMART_RUN: "一键成片",
  GENERATION: "视频生成",
  RENDER: "最终渲染",
  PUBLISH: "发布"
};

const statusLabel: Record<TaskCenterStatus, string> = {
  WAITING: "等待中",
  RUNNING: "运行中",
  NEEDS_USER: "需要处理",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  UNKNOWN: "状态待核对"
};

const paidLabel: Record<TaskCenterItem["paidState"], string> = {
  FREE: "无付费提交",
  NOT_SUBMITTED: "未提交付费任务",
  AUTHORIZED: "已确认，尚未提交",
  PAID_OR_EXTERNAL: "已进入外部/付费执行",
  UNKNOWN: "成本/付费状态未知"
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function taskCard(item: TaskCenterItem): string {
  const actions = item.safeActions
    .map(
      (itemAction, index) =>
        `<a class="${index === 0 ? "primary" : "secondary"}" href="${esc(itemAction.href)}">${esc(itemAction.label)}</a>`
    )
    .join(" ");
  const blocker = item.blocker
    ? `<section class="blocker">
        <b>需要处理</b>
        <p>${esc(item.blocker.message)}</p>
        ${item.blocker.requiredAction ? `<p><b>建议动作：</b>${esc(item.blocker.requiredAction)}</p>` : ""}
        ${item.blocker.code ? `<p class="technical"><code>${esc(item.blocker.code)}</code></p>` : ""}
      </section>`
    : "";
  const provider = [item.provider, item.model].filter(Boolean).join(" · ");
  const technical = item.technical
    ? `<details class="technical"><summary>高级信息</summary>
        <p>source=${esc(item.sourceType)} · status=${esc(item.technical.sourceStatus)}
        ${item.technical.sourceStage ? " · stage=" + esc(item.technical.sourceStage) : ""}
        ${item.technical.sourceRef ? "<br>ref=" + esc(item.technical.sourceRef) : ""}
        ${item.technical.lastCommandOperation ? "<br>last_command=" + esc(item.technical.lastCommandOperation) : ""}
        ${item.technical.lastCommandAt ? " · " + esc(item.technical.lastCommandAt) : ""}
        ${item.technical.errorCode ? "<br>error=" + esc(item.technical.errorCode) : ""}</p>
      </details>`
    : "";
  return `<article class="card task-card" data-task-status="${esc(item.status)}" data-task-source="${esc(item.sourceType)}" data-project-id="${esc(item.projectId)}">
    <div class="head">
      <div>
        <h3>${esc(item.title)}</h3>
        <p class="muted">${esc(item.projectName)} · ${esc(sourceLabel[item.sourceType])} · ${esc(item.phase)}</p>
      </div>
      <span class="status">${esc(statusLabel[item.status])}</span>
    </div>
    <p><b>当前状态：</b>${esc(item.progressText)}</p>
    ${provider ? `<p class="muted">执行：${esc(provider)}</p>` : ""}
    <p class="muted">付费状态：${esc(paidLabel[item.paidState])}${item.costText ? " · " + esc(item.costText) : ""}</p>
    <p class="muted">更新：${esc(item.updatedAt)}${item.completedAt ? " · 完成：" + esc(item.completedAt) : ""}</p>
    ${blocker}
    <p>${actions}</p>
    ${technical}
  </article>`;
}

export function renderTaskCenterPage(input: {
  items: TaskCenterItem[];
  status?: TaskCenterStatus;
  projectId?: string;
}): string {
  const filtered = input.items.filter(
    (item) =>
      (!input.status || item.status === input.status) &&
      (!input.projectId || item.projectId === input.projectId)
  );
  const counts = {
    RUNNING: input.items.filter((item) => item.status === "RUNNING").length,
    NEEDS_USER: input.items.filter((item) => item.status === "NEEDS_USER").length,
    FAILED: input.items.filter((item) => item.status === "FAILED").length,
    UNKNOWN: input.items.filter((item) => item.status === "UNKNOWN").length
  };
  const projectQuery = input.projectId
    ? `&projectId=${encodeURIComponent(input.projectId)}`
    : "";
  const filters = [
    { label: "全部", value: "" },
    { label: "运行中", value: "RUNNING" },
    { label: "需要处理", value: "NEEDS_USER" },
    { label: "失败", value: "FAILED" },
    { label: "状态待核对", value: "UNKNOWN" },
    { label: "已完成", value: "SUCCEEDED" }
  ]
    .map((filter) => {
      const href = filter.value
        ? `/tasks?status=${filter.value}${projectQuery}`
        : input.projectId
          ? `/tasks?projectId=${encodeURIComponent(input.projectId)}`
          : "/tasks";
      const active =
        (!filter.value && !input.status) || filter.value === input.status;
      return `<a class="tool-link ${active ? "tool-current" : ""}" href="${href}">${esc(filter.label)}</a>`;
    })
    .join("");

  const body = `
    <div class="head">
      <div>
        <h1>任务中心</h1>
        <p class="muted">统一查看联网研究、Agent、一键成片、视频生成、渲染和发布状态。这里只展示已有持久化真值，不创建第二套任务状态。</p>
      </div>
    </div>
    <section class="grid">
      <div class="card"><b>运行中</b><p>${counts.RUNNING}</p></div>
      <div class="card"><b>需要处理</b><p>${counts.NEEDS_USER}</p></div>
      <div class="card"><b>失败</b><p>${counts.FAILED}</p></div>
      <div class="card"><b>状态待核对</b><p>${counts.UNKNOWN}</p></div>
    </section>
    <section class="card">
      <div class="workflow-tools"><span class="muted">筛选</span><nav class="tool-steps">${filters}</nav></div>
      ${input.projectId ? `<p class="muted">当前仅显示项目：<code>${esc(input.projectId)}</code> · <a href="/tasks">查看全部项目</a></p>` : ""}
    </section>
    <section>
      ${filtered.length ? filtered.map(taskCard).join("") : '<div class="card"><p>当前筛选条件下没有任务。</p></div>'}
    </section>
  `;

  return layout("任务中心", body);
}
