import test from "node:test";
import assert from "node:assert/strict";
import type { TaskCenterItem } from "../src/domain/task-center.js";
import { renderTaskCenterPage } from "../src/web/task-center-ui.js";
import { ISO } from "./fixtures.js";

function item(input: Partial<TaskCenterItem> & Pick<TaskCenterItem, "id" | "status" | "title">): TaskCenterItem {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectName: input.projectName ?? "项目一",
    sourceType: input.sourceType ?? "GENERATION",
    sourceId: input.sourceId ?? input.id,
    title: input.title,
    phase: input.phase ?? "GENERATION",
    status: input.status,
    progressText: input.progressText ?? "状态说明",
    paidState: input.paidState ?? "UNKNOWN",
    updatedAt: input.updatedAt ?? ISO,
    safeActions: input.safeActions ?? [
      { label: "查看任务", href: "/projects/project-1/generate", kind: "OPEN" }
    ],
    detailHref: input.detailHref ?? "/projects/project-1/generate",
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.costText ? { costText: input.costText } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.technical ? { technical: input.technical } : {})
  };
}

test("Task Center renders counts, safe actions and no generic retry control", () => {
  const html = renderTaskCenterPage({
    items: [
      item({
        id: "run-1",
        status: "RUNNING",
        title: "一键成片",
        sourceType: "SMART_RUN",
        paidState: "PAID_OR_EXTERNAL",
        costText: "成本未知"
      }),
      item({
        id: "blocked-1",
        status: "NEEDS_USER",
        title: "深度联网研究",
        sourceType: "RESEARCH",
        blocker: {
          code: "LOGIN_REQUIRED",
          message: "需要登录",
          requiredAction: "登录后继续"
        },
        safeActions: [
          {
            label: "继续研究",
            href: "/projects/project-1/research",
            kind: "RESUME"
          }
        ]
      }),
      item({
        id: "failed-1",
        status: "FAILED",
        title: "最终视频渲染",
        sourceType: "RENDER"
      })
    ]
  });

  assert.match(html, /<h1>任务中心<\/h1>/);
  assert.match(html, /运行中<\/b><p>1<\/p>/);
  assert.match(html, /需要处理<\/b><p>1<\/p>/);
  assert.match(html, /失败<\/b><p>1<\/p>/);
  assert.match(html, /成本未知/);
  assert.match(html, /继续研究/);
  assert.match(html, /LOGIN_REQUIRED/);
  assert.doesNotMatch(html, />重试</);
  assert.doesNotMatch(html, /自动重试/);
});

test("Task Center status filter only renders matching cards", () => {
  const html = renderTaskCenterPage({
    status: "NEEDS_USER",
    items: [
      item({ id: "a", status: "RUNNING", title: "运行任务" }),
      item({ id: "b", status: "NEEDS_USER", title: "需要处理任务" })
    ]
  });
  assert.match(html, /需要处理任务/);
  assert.doesNotMatch(html, /<h3>运行任务<\/h3>/);
  assert.match(html, /status=NEEDS_USER/);
});
