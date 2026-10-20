import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/domain/schemas.js";
import {
  inspectFinalAccess,
  inspectTimelineAccess
} from "../src/application/services/workflow-step-access.js";
import { resolveWorkflowNavigation } from "../src/application/services/workflow-navigation.js";
import { renderBlockedStepPage, renderSafeRequestErrorPage } from "../src/web/blocked-step-ui.js";

const ISO = "2026-10-04T00:00:00.000Z";

function project(): Project {
  return {
    id: "project-blocked",
    name: "Blocked fixture",
    status: "READY_TO_GENERATE",
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
}

test("timeline access converts missing accepted video into productized guidance", async () => {
  const access = await inspectTimelineAccess(
    {
      readiness: async () => ({
        allowed: false as const,
        reasonCode: "TIMELINE_DECISION_INCOMPLETE" as const,
        message: "当前还没有已采用的视频可进入剪辑。",
        requiredAction:
          "回到视频生成页，至少采用 1 个生成结果；不需要的镜头可以明确跳过。",
        actionHref: "/projects/project-blocked/generate",
        acceptedCount: 0,
        skippedCount: 1,
        unresolvedCount: 2,
        existingTimeline: false as const
      }),
      latestTimeline: async () => null
    } as never,
    "project-blocked"
  );

  assert.equal(access.allowed, false);
  if (access.allowed) return;
  assert.equal(access.reasonCode, "TIMELINE_DECISION_INCOMPLETE");
  assert.equal(access.actionHref, "/projects/project-blocked/generate");
  assert.match(access.requiredAction, /至少采用 1 个生成结果/);
  assert.match(access.technicalDetail ?? "", /accepted=0/);
  assert.match(access.technicalDetail ?? "", /unresolved=2/);
});

test("timeline access allows an existing current timeline without rebuilding it", async () => {
  const access = await inspectTimelineAccess(
    {
      readiness: async () => ({
        allowed: true as const,
        acceptedCount: 1,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: true
      }),
      latestTimeline: async () => null
    } as never,
    "project-blocked"
  );

  assert.deepEqual(access, { allowed: true });
});

test("final access requires a confirmed non-stale timeline", async () => {
  const upstreamBlocked = await inspectFinalAccess(
    {
      readiness: async () => ({
        allowed: false as const,
        reasonCode: "TIMELINE_DECISION_INCOMPLETE" as const,
        message: "当前还没有已采用的视频可进入剪辑。",
        requiredAction: "回到视频生成页，至少采用 1 个生成结果。",
        actionHref: "/projects/project-blocked/generate",
        acceptedCount: 0,
        skippedCount: 0,
        unresolvedCount: 2,
        existingTimeline: false as const
      }),
      latestTimeline: async () => ({ id: "old-timeline", status: "DRAFT" })
    } as never,
    "project-blocked"
  );
  assert.equal(upstreamBlocked.allowed, false);
  if (!upstreamBlocked.allowed) {
    assert.equal(upstreamBlocked.actionHref, "/projects/project-blocked/generate");
    assert.match(upstreamBlocked.requiredAction, /视频生成/);
    assert.match(upstreamBlocked.technicalDetail ?? "", /TIMELINE_DECISION_INCOMPLETE/);
  }

  const missing = await inspectFinalAccess(
    {
      readiness: async () => ({
        allowed: true as const,
        acceptedCount: 1,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: false
      }),
      latestTimeline: async () => null
    } as never,
    "project-blocked"
  );
  assert.equal(missing.allowed, false);
  if (!missing.allowed) {
    assert.equal(missing.reasonCode, "FINAL_TIMELINE_MISSING");
    assert.equal(missing.actionHref, "/projects/project-blocked/timeline");
  }

  const draft = await inspectFinalAccess(
    {
      readiness: async () => ({
        allowed: true as const,
        acceptedCount: 1,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: true
      }),
      latestTimeline: async () => ({ id: "timeline-1", status: "DRAFT" })
    } as never,
    "project-blocked"
  );
  assert.equal(draft.allowed, false);
  if (!draft.allowed) {
    assert.equal(draft.reasonCode, "FINAL_TIMELINE_NOT_CONFIRMED");
  }

  const confirmed = await inspectFinalAccess(
    {
      readiness: async () => ({
        allowed: true as const,
        acceptedCount: 1,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: true
      }),
      latestTimeline: async () => ({ id: "timeline-1", status: "CONFIRMED" })
    } as never,
    "project-blocked"
  );
  assert.deepEqual(confirmed, { allowed: true });
});

test("blocked step page is Chinese, actionable and keeps technical detail collapsed", () => {
  const p = project();
  const navigation = resolveWorkflowNavigation({
    project: p,
    currentPage: "timeline"
  });
  const html = renderBlockedStepPage({
    pageTitle: "视频剪辑",
    project: p,
    navigation,
    access: {
      allowed: false,
      reasonCode: "TIMELINE_NO_ACCEPTED_VIDEO",
      title: "视频剪辑暂时不能打开",
      message: "当前镜头都没有被采用，暂时不能建立视频剪辑。",
      requiredAction: "回到视频生成页，至少采用 1 个镜头后再进入视频剪辑。",
      actionHref: "/projects/project-blocked/generate",
      technicalDetail: "accepted=0 · skipped=3 · unresolved=0"
    }
  });

  assert.match(html, /视频剪辑暂时不能打开/);
  assert.match(html, /返回正确步骤/);
  assert.match(html, /href="\/projects\/project-blocked\/generate"/);
  assert.match(html, /<details class="technical">/);
  assert.match(html, /TIMELINE_NO_ACCEPTED_VIDEO/);
  assert.doesNotMatch(html, /VALIDATION_ERROR/);
});

test("safe browser error page never exposes raw JSON response framing", () => {
  const html = renderSafeRequestErrorPage({
    status: 400,
    technicalDetail: "internal validation message",
    backHref: "/projects/project-blocked/product"
  });

  assert.match(html, /当前页面暂时无法打开/);
  assert.match(html, /返回项目/);
  assert.match(html, /HTTP 400/);
  assert.match(html, /internal validation message/);
  assert.doesNotMatch(html, /"error"\s*:/);
  assert.doesNotMatch(html, /VALIDATION_ERROR/);
});
