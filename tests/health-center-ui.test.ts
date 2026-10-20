import test from "node:test";
import assert from "node:assert/strict";
import { renderHealthCenterPage } from "../src/web/health-center-ui.js";
import type { HealthReport } from "../src/domain/health.js";
import type { Project } from "../src/domain/schemas.js";
import { ISO } from "./fixtures.js";

const project: Project = {
  id: "project-1",
  name: "Health Project",
  status: "DRAFT",
  targetPlatform: "douyin",
  targetDurationMs: 30000,
  aspectRatio: "9:16",
  createdAt: ISO,
  updatedAt: ISO
};

const report: HealthReport = {
  checkedAt: ISO,
  projectId: project.id,
  projectName: project.name,
  overall: "BLOCKED",
  counts: { READY: 2, WARN: 1, BLOCKED: 1, UNKNOWN: 0 },
  items: [
    {
      id: "ai:one",
      group: "AI",
      title: "AIHubMix",
      severity: "READY",
      summary: "Provider 已连接",
      checkedAt: ISO,
      actions: [{ label: "打开大模型设置", href: "/settings/ai" }]
    },
    {
      id: "dreamina:provider",
      group: "DREAMINA",
      title: "Dreamina / Seedance",
      severity: "BLOCKED",
      summary: "Dreamina CLI 已安装，但尚未登录",
      checkedAt: ISO,
      actions: [{ label: "打开视频生成", href: "/agent" }],
      technical: { accountStatus: "NOT_AUTHENTICATED" }
    },
    {
      id: "research:browser",
      group: "RESEARCH",
      title: "联网研究 Provider",
      severity: "WARN",
      summary: "外部浏览器 Research Provider 未配置",
      checkedAt: ISO,
      actions: [{ label: "打开联网研究", href: "/projects" }]
    },
    {
      id: "database:sqlite",
      group: "DATABASE",
      title: "项目数据库",
      severity: "READY",
      summary: "SQLite / Prisma 可读写连接正常",
      checkedAt: ISO,
      actions: []
    }
  ]
};

test("Health Center renders grouped diagnosis and read-only notice", () => {
  const html = renderHealthCenterPage({ report, projects: [project] });
  assert.match(html, /<h1>系统诊断中心<\/h1>/);
  assert.match(html, /不会消耗 Dreamina 积分/);
  assert.match(html, /总体：需要处理/);
  assert.match(html, /Dreamina CLI 已安装，但尚未登录/);
  assert.match(html, /外部浏览器 Research Provider 未配置/);
  assert.match(html, /切换项目并重新检查/);
  assert.match(html, /\/settings\/ai/);
  assert.match(html, /<details class="technical">/);
});
