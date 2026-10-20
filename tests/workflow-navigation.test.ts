import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/domain/schemas.js";
import {
  resolveWorkflowNavigation,
  workflowPageTaskText
} from "../src/application/services/workflow-navigation.js";

const ISO = "2026-10-04T00:00:00.000Z";

function project(status: Project["status"]): Project {
  return {
    id: "project-nav",
    name: "Navigation fixture",
    status,
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
}

function step(
  state: ReturnType<typeof resolveWorkflowNavigation>,
  key: ReturnType<typeof resolveWorkflowNavigation>["steps"][number]["key"]
) {
  return state.steps.find((item) => item.key === key)!;
}

test("historical product page keeps local task while project resume stays on generation", () => {
  const state = resolveWorkflowNavigation({
    project: project("READY_TO_GENERATE"),
    currentPage: "product"
  });

  assert.equal(state.pageTaskText, "检查或更新产品资料");
  assert.equal(state.globalResumeStep, "generate");
  assert.equal(state.globalResumeHref, "/projects/project-nav/generate");
  assert.equal(step(state, "product").state, "CURRENT");
  assert.equal(step(state, "generate").state, "RESUME");
  assert.equal(step(state, "truth").state, "COMPLETE");
  assert.equal(step(state, "research").state, "OPTIONAL");
});

test("current resume page is CURRENT instead of a duplicate RESUME badge", () => {
  const state = resolveWorkflowNavigation({
    project: project("READY_TO_GENERATE"),
    currentPage: "generate"
  });

  assert.equal(state.globalResumeStep, "generate");
  assert.equal(step(state, "generate").state, "CURRENT");
  assert.equal(
    state.steps.filter((item) => item.state === "CURRENT").length,
    1
  );
  assert.equal(
    state.steps.filter((item) => item.state === "RESUME").length,
    0
  );
});

test("research page is a real current page while main resume position remains independent", () => {
  const state = resolveWorkflowNavigation({
    project: project("GENERATION_REVIEW"),
    currentPage: "research"
  });

  assert.equal(state.pageTaskText, "补充公开证据并筛选可用研究结果");
  assert.equal(step(state, "research").state, "CURRENT");
  assert.equal(step(state, "generate").state, "RESUME");
  assert.equal(state.globalResumeText, "审片并决定采用、重做或跳过");
});

test("final page task reflects confirmed output ready for publishing", () => {
  const p = project("READY_TO_PUBLISH");
  const state = resolveWorkflowNavigation({
    project: p,
    currentPage: "final"
  });

  assert.equal(
    workflowPageTaskText("final", p),
    "选择可用发布方式并核对发布状态"
  );
  assert.equal(state.globalResumeStep, "final");
  assert.equal(step(state, "final").state, "CURRENT");
  assert.equal(state.globalResumeText, "选择可用发布方式并核对发布状态");
});

test("timeline becomes the global resume step only after generation decisions are complete", () => {
  const state = resolveWorkflowNavigation({
    project: project("READY_TO_ASSEMBLE"),
    currentPage: "script"
  });

  assert.equal(state.globalResumeStep, "timeline");
  assert.equal(step(state, "script").state, "CURRENT");
  assert.equal(step(state, "timeline").state, "RESUME");
  assert.equal(state.globalResumeText, "调整并确认视频剪辑方案");
});

test("confirmed timeline overrides a stale project status and resumes at final", () => {
  const state = resolveWorkflowNavigation({
    project: project("GENERATION_REVIEW"),
    currentPage: "timeline",
    timeline: { status: "CONFIRMED" }
  });

  assert.equal(state.progressIndex, 9);
  assert.equal(state.globalResumeStep, "final");
  assert.equal(step(state, "timeline").state, "CURRENT");
  assert.equal(step(state, "final").state, "RESUME");
  assert.equal(step(state, "generate").state, "COMPLETE");
  assert.equal(state.globalResumeText, "渲染并确认最终成片");
});

test("auxiliary tools do not pretend to be a main workflow step", () => {
  const state = resolveWorkflowNavigation({
    project: project("SCRIPT_REVIEW"),
    currentPage: null
  });

  assert.equal(
    state.pageTaskText,
    "使用辅助工具；主流程恢复位置保持不变"
  );
  assert.equal(state.globalResumeStep, "script");
  assert.equal(step(state, "script").state, "RESUME");
  assert.equal(
    state.steps.filter((item) => item.state === "CURRENT").length,
    0
  );
});
