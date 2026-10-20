import test from "node:test";
import assert from "node:assert/strict";
import type { Project, GenerationAttempt, RenderJob } from "../src/domain/schemas.js";
import type { AgentTask } from "../src/application/ports/agent-task-repository.js";
import type { ResearchRun } from "../src/application/ports/research-repository.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import type { PublicPublishPackage } from "../src/application/services/publish-bridge-service.js";
import {
  taskFromAgentTask,
  taskFromGenerationAttempt,
  taskFromPublishPackage,
  taskFromRenderJob,
  taskFromResearchRun,
  taskFromSmartRun
} from "../src/application/services/task-center-service.js";
import { H, ISO } from "./fixtures.js";

function project(): Project {
  return {
    id: "task-project",
    name: "Task Center Fixture",
    status: "GENERATION_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
}

test("blocked research becomes NEEDS_USER with a safe resume link", () => {
  const run: ResearchRun = {
    id: "research-1",
    projectId: "task-project",
    mode: "DEEP",
    status: "BLOCKED",
    goal: "核实公开资料",
    sourceUrls: [],
    queries: ["product manual"],
    blockerCode: "LOGIN_REQUIRED",
    blockerMessage: "需要浏览器登录",
    requiredUserAction: "完成登录后继续",
    createdAt: ISO,
    updatedAt: ISO
  };
  const item = taskFromResearchRun(project(), run);
  assert.equal(item.status, "NEEDS_USER");
  assert.equal(item.paidState, "FREE");
  assert.equal(item.safeActions[0]?.kind, "RESUME");
  assert.equal(item.safeActions[0]?.href, "/projects/task-project/research");
});

test("Agent review task needs user review and never exposes generic retry", () => {
  const task: AgentTask = {
    id: "agent-1",
    projectId: "task-project",
    skillId: "dreamina-cli",
    status: "REVIEW_READY",
    requestText: "生成产品视频",
    requestedMethod: "AUTO",
    selectedOperation: "text2video",
    model: "seedance2.0mini",
    durationMs: 10000,
    aspectRatio: "9:16",
    videoResolution: "720p",
    nativeAudioOutputRequested: true,
    materials: [],
    generationAttemptId: "attempt-agent",
    createdAt: ISO,
    updatedAt: ISO
  };
  const item = taskFromAgentTask(project(), task);
  assert.equal(item.status, "NEEDS_USER");
  assert.equal(item.paidState, "PAID_OR_EXTERNAL");
  assert.equal(item.safeActions[0]?.label, "进入审片");
  assert.ok(item.safeActions.every((action) => !/重试|retry/i.test(action.label)));
});

test("Smart Run generating is RUNNING and paid scope remains explicit", () => {
  const run = {
    id: "smart-1",
    projectId: "task-project",
    requestKey: "req-1",
    inputHash: H.a,
    revision: 1,
    status: "GENERATING",
    stage: "GENERATION",
    targetDurationMs: 30000,
    options: {
      requestText: "一键成片",
      generationSettings: {
        requestedModelVersion: "seedance2.0mini",
        aspectRatio: "9:16",
        videoResolution: "720p",
        nativeAudioOutputRequested: true
      },
      reviewMode: "MANUAL",
      autoSelectLowRiskClips: false,
      useExistingResearch: false,
      useResearchReferences: false,
      allowSilentOutput: false
    },
    expectedWorkspace: {},
    paidScope: {
      hash: H.b,
      planRef: {
        entityType: "ProductionPlan",
        entityId: "plan-1",
        version: 1,
        hash: H.c
      },
      requests: [
        {
          requestId: "request-1",
          requestHash: H.d,
          preflightId: "pf-1",
          preflightHash: H.e,
          costStatus: "UNKNOWN"
        }
      ],
      preparedAt: ISO
    },
    consent: {
      scopeHash: H.b,
      approvedAt: ISO,
      acceptedUnknownCostRisk: true,
      source: "EXPLICIT_SMART_RUN_PAID_CONFIRMATION"
    },
    attemptIds: ["attempt-1"],
    notes: [],
    createdAt: ISO,
    updatedAt: ISO
  } as SmartGenerationRun;
  const item = taskFromSmartRun(project(), run);
  assert.equal(item.status, "RUNNING");
  assert.equal(item.paidState, "PAID_OR_EXTERNAL");
  assert.equal(item.costText, "成本未知");
});

test("unknown generation attempt is UNKNOWN and only offers reconcile/open actions", () => {
  const attempt: GenerationAttempt = {
    id: "attempt-unknown",
    projectId: "task-project",
    clipId: "clip-1",
    attemptNumber: 1,
    generationRequestId: "request-1",
    requestHash: H.a,
    preflightReportId: "pf-1",
    userApprovalId: "approval-1",
    approvalHash: H.b,
    submissionFingerprint: H.c,
    status: "SUBMISSION_OUTCOME_UNKNOWN",
    commandAttempts: [],
    createdAt: ISO
  };
  const item = taskFromGenerationAttempt(
    {
      project: project(),
      blockers: [],
      requests: [],
      preflights: [],
      decisions: []
    },
    attempt
  );
  assert.equal(item.status, "UNKNOWN");
  assert.equal(item.safeActions[0]?.kind, "RECONCILE");
  assert.equal(item.safeActions[0]?.label, "核对生成状态");
  assert.ok(item.safeActions.every((action) => !/重试|retry/i.test(action.label)));
});

test("successful render maps to completed and links to final output", () => {
  const job: RenderJob = {
    id: "render-1",
    projectId: "task-project",
    timelineId: "timeline-1",
    timelineHash: H.a,
    status: "SUCCEEDED",
    inputArtifactIds: ["video-1"],
    inputArtifactHashes: [H.b],
    renderConfig: {
      width: 720,
      height: 1280,
      fps: 30,
      videoCodec: "libx264",
      audioCodec: "aac",
      format: "mp4"
    },
    outputArtifactId: "final-1",
    outputArtifactHash: H.c,
    createdAt: ISO,
    startedAt: ISO,
    completedAt: ISO
  };
  const item = taskFromRenderJob(project(), job);
  assert.equal(item.status, "SUCCEEDED");
  assert.equal(item.safeActions[0]?.href, "/projects/task-project/final");
});

test("handoff completed is not treated as published success", () => {
  const pkg: PublicPublishPackage = {
    id: "package-1",
    projectId: "task-project",
    finalAssemblyId: "assembly-1",
    finalArtifactId: "final-1",
    finalArtifactHash: H.a,
    providerType: "DOUYIN_H5_HANDOFF",
    titleDraft: "测试发布",
    expiresAt: "2026-10-05T02:30:00.000Z",
    status: "HANDOFF_COMPLETED",
    createdAt: ISO,
    completedAt: ISO
  };
  const item = taskFromPublishPackage(project(), pkg);
  assert.equal(item.status, "NEEDS_USER");
  assert.match(item.progressText, /尚未获得可信发布回执/);
  assert.notEqual(item.status, "SUCCEEDED");
  assert.equal(item.completedAt, undefined);
});
