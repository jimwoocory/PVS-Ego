import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectWorkspace } from "../src/application/services/product-flow.js";
import type {
  ArtifactRecord,
  Project,
  RenderJob,
  Timeline
} from "../src/domain/schemas.js";
import type { FinalAssembly } from "../src/application/ports/final-output-repository.js";
import { renderTimelineEditor } from "../src/web/timeline-ui.js";
import { renderProjectPage } from "../src/web/workbench-ui.js";
import { H, ISO } from "./fixtures.js";

function workspace(status: Project["status"] = "READY_TO_ASSEMBLE"): ProjectWorkspace {
  return {
    project: {
      id: "project-timeline-ui",
      name: "Timeline UI",
      status,
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      currentProductionPlanRef: {
        entityType: "ProductionPlan",
        entityId: "plan-ui",
        version: 1,
        hash: H.a
      },
      createdAt: ISO,
      updatedAt: ISO
    }
  };
}

function timeline(status: Timeline["status"] = "DRAFT"): Timeline {
  return {
    id: "timeline-ui",
    projectId: "project-timeline-ui",
    version: 1,
    status,
    productionPlanHash: H.a,
    tracks: [
      {
        id: "track-video",
        kind: "VIDEO",
        order: 0,
        label: "主视频",
        locked: false,
        muted: false
      },
      {
        id: "track-audio",
        kind: "AUDIO",
        order: 1,
        label: "BGM",
        locked: false,
        muted: false
      },
      {
        id: "track-text",
        kind: "TEXT",
        order: 2,
        label: "字幕 / CTA",
        locked: false,
        muted: false
      }
    ],
    clips: [
      {
        id: "edit-a",
        sourceClipId: "clip-a",
        sourceArtifactId: "artifact-a",
        sourceArtifactHash: H.b,
        sourceDurationMs: 2000,
        inMs: 100,
        outMs: 1800,
        trackId: "track-video",
        order: 0,
        deleted: false,
        transition: { type: "CROSSFADE", durationMs: 300 },
        audio: { muted: false, volume: 0.8, keyframes: [] },
        captions: []
      },
      {
        id: "edit-b",
        sourceClipId: "clip-b",
        sourceArtifactId: "artifact-b",
        sourceArtifactHash: H.c,
        sourceDurationMs: 2000,
        inMs: 0,
        outMs: 1900,
        trackId: "track-video",
        order: 1,
        deleted: false,
        transition: { type: "CUT", durationMs: 0 },
        audio: { muted: false, volume: 1, keyframes: [] },
        captions: []
      }
    ],
    audioItems: [],
    repairMasks: [],
    textItems: [
      {
        id: "text-one",
        kind: "CTA",
        text: "立即了解",
        startMs: 500,
        endMs: 1500,
        trackId: "track-text",
        order: 0,
        position: "CENTER",
        fontScale: 1.1,
        deleted: false
      }
    ],
    contentHash: H.d,
    createdAt: ISO,
    updatedAt: ISO,
    ...(status === "CONFIRMED" ? { confirmedAt: ISO } : {})
  };
}

function job(): RenderJob {
  return {
    id: "render-job-ui",
    projectId: "project-timeline-ui",
    timelineId: "timeline-ui",
    timelineHash: H.d,
    status: "QUEUED",
    inputArtifactIds: ["artifact-a", "artifact-b"],
    inputArtifactHashes: [H.b, H.c],
    renderConfig: {
      width: 720,
      height: 1280,
      fps: 30,
      videoCodec: "libx264",
      audioCodec: "aac",
      format: "mp4"
    },
    createdAt: ISO
  };
}

test("Timeline editor exposes non-destructive MVP and plus controls", () => {
  const html = renderTimelineEditor(workspace(), timeline());
  assert.match(html, /剪辑方案 v1/);
  assert.match(html, /非破坏式/);
  assert.match(html, /拖动镜头卡片重排/);
  assert.match(html, /入点（秒）/);
  assert.match(html, /出点（秒）/);
  assert.match(html, /原声音量 0–2/);
  assert.match(html, /交叉淡化/);
  assert.match(html, /背景音乐/);
  assert.match(html, /花字 \/ 行动引导/);
  assert.match(html, /确认剪辑方案并创建渲染任务/);
  assert.match(html, /\/timeline'\+path/);
  assert.match(html, /api\('\/reorder'/);
  assert.match(html, /api\('\/clips\//);
  assert.match(html, /api\('\/bgm/);
  assert.match(html, /api\('\/text/);
  assert.match(html, /\/api\/artifacts\/artifact-a\/content/);
});

test("confirmed Timeline exposes a real final-render CTA with error handling", () => {
  const html = renderTimelineEditor(workspace(), timeline("CONFIRMED"), job());
  assert.match(html, /进入最终渲染/);
  assert.match(html, /id="tl-render-final"/);
  assert.match(html, /\/final\/render/);
  assert.match(html, /正在进行最终渲染/);
  assert.match(html, /最终渲染失败/);
  assert.doesNotMatch(html, /进入后续检查/);
});

test("Final page requires confirmed Timeline and surfaces RenderJob audit", () => {
  const confirmed = timeline("CONFIRMED");
  const renderJob = job();
  const output: ArtifactRecord = {
    id: "final-artifact",
    projectId: "project-timeline-ui",
    kind: "FINAL_VIDEO",
    relativePath: "final/result.mp4",
    sha256: H.e,
    sizeBytes: 1234,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: ISO
  };
  const assembly: FinalAssembly = {
    id: "assembly-ui",
    projectId: "project-timeline-ui",
    productionPlanHash: H.a,
    selectedClipIds: ["clip-a", "clip-b"],
    inputArtifactIds: ["artifact-a", "artifact-b"],
    inputArtifactHashes: [H.b, H.c],
    outputArtifactId: output.id,
    outputArtifactHash: H.e,
    timelineId: confirmed.id,
    timelineHash: confirmed.contentHash,
    renderJobId: renderJob.id,
    renderConfig: renderJob.renderConfig,
    status: "READY",
    createdAt: ISO
  };

  const html = renderProjectPage({
    kind: "final",
    workspace: workspace("FINAL_REVIEW"),
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [output],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: confirmed,
    renderJob,
    finalAssembly: assembly,
    publishAttempts: []
  });

  assert.match(html, /视频剪辑方案进行非破坏式渲染/);
  assert.match(html, new RegExp("timeline_sha256=" + H.d));
  assert.match(html, /render_job=render-job-ui/);
  assert.match(html, /720×1280 · 30fps · libx264\/aac/);
  assert.doesNotMatch(html, /完整时间线剪辑将在 P1-06 接入/);
});

test("confirmed standard Timeline can render even when an old project status still says GENERATION_REVIEW", () => {
  const staleWorkspace = workspace("GENERATION_REVIEW");
  // This UI-only fixture only needs a truthy productionPlan to exercise the
  // standard-timeline branch; domain validation is covered by production-plan tests.
  (staleWorkspace as unknown as { productionPlan: unknown }).productionPlan = {
    scenes: [{ clips: [] }]
  };
  const html = renderProjectPage({
    kind: "final",
    workspace: staleWorkspace,
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: timeline("CONFIRMED"),
    renderJob: job(),
    publishAttempts: []
  });
  assert.match(html, /当前要做：<\/b>渲染并确认最终成片/);
  assert.match(html, /当前位置：成片与发布 · 本页任务：渲染并确认最终成片/);
  assert.match(html, /当前任务下一步：<a href="\/projects\/project-timeline-ui\/final">渲染并确认最终成片<\/a>/);
  assert.match(html, /id="render-final"/);
  assert.doesNotMatch(html, /id="render-final" disabled/);
});

test("Timeline page uses page-specific next-step guidance instead of stale generation-review guidance", () => {
  const html = renderProjectPage({
    kind: "timeline",
    workspace: workspace("GENERATION_REVIEW"),
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: timeline("CONFIRMED"),
    renderJob: job()
  });
  assert.match(html, /当前要做：<\/b>调整并确认视频剪辑方案/);
  assert.match(html, /当前位置：视频剪辑 · 本页任务：调整并确认视频剪辑方案/);
  assert.match(html, /当前任务下一步：<a href="\/projects\/project-timeline-ui\/final">渲染并确认最终成片<\/a>/);
});
