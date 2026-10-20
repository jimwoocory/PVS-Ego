import type { Project } from "../domain/schemas.js";
import type { WorkflowNavigationState } from "../application/services/workflow-navigation.js";
import type { StepAccessBlocked } from "../application/services/workflow-step-access.js";
import { layout } from "./workbench-ui.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderBlockedStepPage(input: {
  pageTitle: string;
  project: Project;
  navigation: WorkflowNavigationState;
  access: StepAccessBlocked;
}): string {
  const body = `
    <div class="head">
      <div>
        <h1>${esc(input.pageTitle)}</h1>
        <p><b>当前状态：</b>${esc(input.access.title)}</p>
        <p class="muted">${esc(input.project.name)} · 目标 ${input.project.targetDurationMs / 1000} 秒</p>
      </div>
      <span class="status">需要处理</span>
    </div>
    <section class="card blocker">
      <h3>${esc(input.access.message)}</h3>
      <p>${esc(input.access.requiredAction)}</p>
      <p><a class="primary" href="${esc(input.access.actionHref)}">返回正确步骤</a></p>
      <details class="technical">
        <summary>高级信息</summary>
        <p><code>${esc(input.access.reasonCode)}</code></p>
        ${input.access.technicalDetail ? `<p><code>${esc(input.access.technicalDetail)}</code></p>` : ""}
      </details>
    </section>
  `;
  return layout(
    input.pageTitle,
    body,
    input.project,
    [],
    input.navigation
  );
}

export function renderSafeRequestErrorPage(input: {
  status: number;
  title?: string;
  message?: string;
  technicalDetail?: string;
  backHref?: string;
}): string {
  const title = input.title ?? "当前页面暂时无法打开";
  const message =
    input.message ?? "当前步骤条件未满足，或页面数据已经发生变化。请返回项目后继续操作。";
  const backHref = input.backHref ?? "/projects";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Product Video Studio</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#171717;background:#f5f5f3}
body{margin:0}.wrap{max-width:760px;margin:64px auto;padding:24px}.card{background:#fff;border:1px solid #deded8;border-radius:12px;padding:22px}.muted{color:#707070}.primary{display:inline-block;background:#171717;color:#fff;text-decoration:none;border-radius:9px;padding:11px 16px;font-weight:700}.technical{margin-top:18px;color:#666}code{word-break:break-all}
${pvsGlobalStyles}
</style>
</head>
<body>${renderPvsGlobalHeader("projects")}<main class="wrap"><section class="card">
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
<p><a class="primary" href="${esc(backHref)}">返回项目</a></p>
<details class="technical"><summary>高级信息</summary>
<p><code>HTTP ${input.status}</code></p>
${input.technicalDetail ? `<p><code>${esc(input.technicalDetail)}</code></p>` : ""}
</details>
</section></main></body></html>`;
}
