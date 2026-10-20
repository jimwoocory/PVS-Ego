import type { HealthCheckItem, HealthReport, HealthSeverity } from "../domain/health.js";
import type { Project } from "../domain/schemas.js";
import { layout } from "./workbench-ui.js";

const severityLabel: Record<HealthSeverity, string> = {
  READY: "正常",
  WARN: "警告",
  BLOCKED: "需要处理",
  UNKNOWN: "未知"
};

const groupLabel: Record<HealthCheckItem["group"], string> = {
  AI: "大模型",
  DREAMINA: "Dreamina / Seedance",
  MEDIA: "媒体工具",
  DATABASE: "数据库",
  RESEARCH: "联网研究",
  PUBLISH: "发布"
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function healthCard(item: HealthCheckItem): string {
  const actions = item.actions
    .map(
      (action) =>
        `<a class="secondary" href="${esc(action.href)}">${esc(action.label)}</a>`
    )
    .join(" ");
  const technical = item.technical
    ? `<details class="technical"><summary>高级信息</summary><pre>${esc(JSON.stringify(item.technical, null, 2))}</pre></details>`
    : "";
  return `<article class="card health-card" data-health-severity="${esc(item.severity)}" data-health-group="${esc(item.group)}">
    <div class="head">
      <div>
        <h3>${esc(item.title)}</h3>
        <p class="muted">${esc(groupLabel[item.group])}</p>
      </div>
      <span class="status">${esc(severityLabel[item.severity])}</span>
    </div>
    <p><b>${esc(item.summary)}</b></p>
    ${item.detail ? `<p class="muted">${esc(item.detail)}</p>` : ""}
    <p class="muted">检查时间：${esc(item.checkedAt)}</p>
    ${actions ? `<p>${actions}</p>` : ""}
    ${technical}
  </article>`;
}

export function renderHealthCenterPage(input: {
  report: HealthReport;
  projects: Project[];
}): string {
  const { report, projects } = input;
  const selector = projects.length
    ? `<form method="GET" action="/health-center" class="row">
        <label class="field">发布授权检查项目
          <select name="projectId">
            ${projects
              .map(
                (project) =>
                  `<option value="${esc(project.id)}" ${project.id === report.projectId ? "selected" : ""}>${esc(project.name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <div class="field" style="justify-content:flex-end"><button class="secondary" type="submit">切换项目并重新检查</button></div>
      </form>`
    : '<p class="muted">当前没有项目；发布授权将只显示系统级说明。</p>';

  const order: HealthCheckItem["group"][] = [
    "AI",
    "DREAMINA",
    "MEDIA",
    "DATABASE",
    "RESEARCH",
    "PUBLISH"
  ];
  const sections = order
    .map((group) => {
      const items = report.items.filter((item) => item.group === group);
      if (!items.length) return "";
      return `<section>
        <h2>${esc(groupLabel[group])}</h2>
        <div class="grid">${items.map(healthCard).join("")}</div>
      </section>`;
    })
    .join("");

  const body = `
    <div class="head">
      <div>
        <h1>系统诊断中心</h1>
        <p class="muted">只做只读诊断，不生成视频、不抓取研究内容、不发布，也不会消耗 Dreamina 积分。</p>
      </div>
      <span class="status">总体：${esc(severityLabel[report.overall])}</span>
    </div>

    <section class="grid">
      <div class="card"><b>正常</b><p>${report.counts.READY}</p></div>
      <div class="card"><b>警告</b><p>${report.counts.WARN}</p></div>
      <div class="card"><b>需要处理</b><p>${report.counts.BLOCKED}</p></div>
      <div class="card"><b>未知</b><p>${report.counts.UNKNOWN}</p></div>
    </section>

    <section class="card">
      <h3>检查范围</h3>
      <p class="muted">AI Provider、Dreamina CLI / 登录、FFmpeg / FFprobe、数据库、浏览器研究 Provider、发布 Provider。</p>
      ${selector}
      <p><a class="primary" href="/health-center${report.projectId ? `?projectId=${encodeURIComponent(report.projectId)}` : ""}">重新检查</a></p>
    </section>

    ${sections}
  `;

  return layout("系统诊断中心", body);
}
