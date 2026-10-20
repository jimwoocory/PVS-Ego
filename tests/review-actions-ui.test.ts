import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import {
  assertCanonicalProductArtifactReady,
  reviseProductionPlanDraft,
  reviseScriptDraft
} from "../src/application/services/review-actions.js";
import { renderProjectPage, renderProjectsPage } from "../src/web/workbench-ui.js";
import type {
  ArtifactRecord,
  AssetRef,
  ProductionPlan,
  Project,
  ReviewDecision,
  ScriptDraft
} from "../src/domain/schemas.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

function makeAsset(): AssetRef {
  return {
    id: "asset-1",
    artifactId: "artifact-canonical",
    type: "image",
    source: "user_upload",
    originalFilename: "product.png",
    sha256: H.a,
    mimeType: "image/png",
    sizeBytes: 12,
    provenance: "Product Input",
    createdAt: ISO
  };
}

function makeArtifact(
  integrityStatus: ArtifactRecord["integrityStatus"] = "READY",
  sha256 = H.a
): ArtifactRecord {
  return {
    id: "artifact-canonical",
    projectId: "project-1",
    kind: "USER_INPUT",
    relativePath: "input/product.png",
    sha256,
    sizeBytes: 12,
    mimeType: "image/png",
    integrityStatus,
    immutable: true,
    createdAt: ISO
  };
}

function makeScript(): ScriptDraft {
  return {
    id: "script-review",
    projectId: "project-1",
    version: 2,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-1",
      version: 1,
      hash: H.a
    },
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: "batch-1",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 60000,
    beats: [
      {
        id: "beat-1",
        order: 1,
        purpose: "FEATURE",
        text: "Feature one",
        estimatedDurationMs: 60000,
        requiredFactIds: ["fact-1"]
      }
    ],
    contentHash: H.c,
    confirmedAt: ISO
  };
}

function makePlan(): ProductionPlan {
  const clip = makeValidClip();
  return {
    id: "plan-review",
    projectId: "project-1",
    version: 3,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-1",
      version: 1,
      hash: H.a
    },
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: "script-review",
      version: 2,
      hash: H.c
    },
    selectedCreativeId: "creative-1",
    visualDirection: "clean",
    soundDirection: "clear",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: []
      },
      characters: [],
      environments: [
        { sceneId: "scene-1", stableElements: ["studio"] }
      ]
    },
    scenes: [
      {
        id: "scene-1",
        order: 1,
        purpose: "product",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [clip]
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

test("canonical Product Truth confirmation requires READY artifact with matching hash", () => {
  const truth = makeProductTruth();
  const asset = makeAsset();
  assert.doesNotThrow(() =>
    assertCanonicalProductArtifactReady(truth, [asset], [makeArtifact()])
  );

  assert.throws(
    () =>
      assertCanonicalProductArtifactReady(
        truth,
        [asset],
        [makeArtifact("MISSING")]
      ),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /must be READY/.test(error.message)
  );

  assert.throws(
    () =>
      assertCanonicalProductArtifactReady(
        truth,
        [asset],
        [makeArtifact("READY", H.b)]
      ),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /matching hash/.test(error.message)
  );
});

test("Script structured revision creates a new DRAFT version and validates beats", () => {
  const current = makeScript();
  const revised = reviseScriptDraft(current, [
    {
      id: "beat-1",
      purpose: "HOOK",
      text: "New hook",
      estimatedDurationMs: 60000,
      requiredFactIds: ["fact-1"]
    }
  ]);
  assert.equal(revised.status, "DRAFT");
  assert.equal(revised.version, current.version + 1);
  assert.notEqual(revised.id, current.id);
  assert.notEqual(revised.contentHash, current.contentHash);
  assert.equal(revised.beats[0]?.purpose, "HOOK");
  assert.equal(revised.confirmedAt, undefined);

  assert.throws(() =>
    reviseScriptDraft(current, [
      {
        purpose: "HOOK",
        text: "",
        estimatedDurationMs: 60000,
        requiredFactIds: []
      }
    ])
  );
});

test("ProductionPlan structured revision creates a new validated version and rejects invalid timeline", () => {
  const current = makePlan();
  const segment = current.scenes[0]!.clips[0]!.segments[0]!;
  const revised = reviseProductionPlanDraft(current, {
    visualDirection: "new visual direction",
    soundDirection: "new sound direction",
    productShowcaseRules: ["hero first"],
    segments: [
      {
        id: segment.id,
        cameraMovement: "slow orbit",
        subjectAction: "rotate product"
      }
    ]
  });

  assert.equal(revised.status, "DRAFT");
  assert.equal(revised.version, current.version + 1);
  assert.notEqual(revised.id, current.id);
  assert.notEqual(revised.contentHash, current.contentHash);
  assert.equal(
    revised.scenes[0]!.clips[0]!.segments[0]!.cameraMovement,
    "slow orbit"
  );
  assert.equal(revised.confirmedAt, undefined);

  assert.throws(() =>
    reviseProductionPlanDraft(current, {
      segments: [{ id: segment.id, endMs: 3000 }]
    })
  );
});

test("old REDO decision does not hide review controls for a new Attempt/output", () => {
  const plan = makePlan();
  const clip = plan.scenes[0]!.clips[0]!;
  const project: Project = {
    id: "project-1",
    name: "UI Review",
    status: "GENERATION_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };

  const artifacts: ArtifactRecord[] = [
    {
      id: "video-old",
      projectId: project.id,
      kind: "GENERATED_VIDEO",
      relativePath: "outputs/old.mp4",
      sha256: H.one,
      sizeBytes: 10,
      mimeType: "video/mp4",
      integrityStatus: "READY",
      immutable: true,
      createdAt: ISO
    },
    {
      id: "video-new",
      projectId: project.id,
      kind: "GENERATED_VIDEO",
      relativePath: "outputs/new.mp4",
      sha256: H.two,
      sizeBytes: 11,
      mimeType: "video/mp4",
      integrityStatus: "READY",
      immutable: true,
      createdAt: ISO
    }
  ];
  const attempts = [
    {
      id: "attempt-old",
      projectId: project.id,
      clipId: clip.id,
      attemptNumber: 1,
      generationRequestId: "request-old",
      requestHash: H.a,
      preflightReportId: "preflight-old",
      userApprovalId: "approval-old",
      approvalHash: H.b,
      submissionFingerprint: H.c,
      status: "SUCCEEDED" as const,
      providerHandle: { externalTaskId: "task-old" },
      commandAttempts: [],
      outputArtifactId: "video-old",
      createdAt: ISO,
      completedAt: ISO
    },
    {
      id: "attempt-new",
      projectId: project.id,
      clipId: clip.id,
      attemptNumber: 2,
      generationRequestId: "request-new",
      requestHash: H.d,
      preflightReportId: "preflight-new",
      userApprovalId: "approval-new",
      approvalHash: H.e,
      submissionFingerprint: H.f,
      status: "SUCCEEDED" as const,
      providerHandle: { externalTaskId: "task-new" },
      commandAttempts: [],
      outputArtifactId: "video-new",
      createdAt: ISO,
      completedAt: ISO
    }
  ];

  const oldRedo: ReviewDecision = {
    id: "review-old",
    projectId: project.id,
    clipId: clip.id,
    clipHash: clip.contentHash,
    generationAttemptId: "attempt-old",
    outputArtifactId: "video-old",
    outputArtifactHash: H.one,
    decision: "REDO",
    decidedAt: ISO
  };

  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts,
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts,
    reviewDecisions: [oldRedo],
    commandAttempts: [],
    probe: {
      code: "DREAMINA_NOT_FOUND",
      cliFound: false,
      providerIdentityHash: H.a,
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: "missing"
    }
  });

  assert.match(
    html,
    /data-attempt="attempt-new" data-clip="clip-1" data-decision="ACCEPT"/
  );
  assert.match(html, /为此镜头重新运行生成前检查/);
});

test("GenerationAttempt cards follow current ProductionPlan clip order and isolate historical attempts", () => {
  const plan = makePlan();
  const first = plan.scenes[0]!.clips[0]!;
  const second = structuredClone(first);
  second.id = "clip-2";
  second.contentHash = H.two;
  plan.scenes[0]!.clips = [first, second];

  const project: Project = {
    id: "project-1",
    name: "UI Attempt Order",
    status: "GENERATION_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };

  const baseAttempt = {
    projectId: project.id,
    attemptNumber: 1,
    generationRequestId: "request",
    requestHash: H.a,
    preflightReportId: "preflight",
    userApprovalId: "approval",
    approvalHash: H.b,
    submissionFingerprint: H.c,
    status: "CREATED" as const,
    commandAttempts: [],
    createdAt: ISO
  };
  const attempts = [
    {
      ...baseAttempt,
      id: "attempt-clip-2",
      clipId: second.id
    },
    {
      ...baseAttempt,
      id: "attempt-history",
      clipId: "clip-old"
    },
    {
      ...baseAttempt,
      id: "attempt-clip-1",
      clipId: first.id
    }
  ];

  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts,
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    probe: {
      code: "DREAMINA_NOT_FOUND",
      cliFound: false,
      providerIdentityHash: H.a,
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: "missing"
    }
  });

  const clip1Index = html.indexOf("Clip 1 · Attempt #1 · CREATED");
  const clip2Index = html.indexOf("Clip 2 · Attempt #1 · CREATED");
  const historyIndex = html.indexOf("历史/旧计划生成任务（1）");
  assert.ok(clip1Index >= 0);
  assert.ok(clip2Index > clip1Index);
  assert.ok(historyIndex > clip2Index);
  assert.match(html, /旧计划 · #1 · CREATED/);
  assert.match(html, /此记录不属于当前导演方案，仅保留为历史记录/);
});

test("generation page exposes AI multi-version comparison only for two ready successful versions of the same current clip", () => {
  const plan = makePlan();
  const clip = plan.scenes[0]!.clips[0]!;
  const project: Project = {
    id: "project-1",
    name: "AI Compare UI",
    status: "GENERATION_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };
  const baseAttempt = {
    projectId: project.id,
    clipId: clip.id,
    generationRequestId: "request-compare",
    requestHash: H.a,
    preflightReportId: "preflight-compare",
    userApprovalId: "approval-compare",
    approvalHash: H.b,
    submissionFingerprint: H.c,
    status: "SUCCEEDED" as const,
    commandAttempts: [],
    createdAt: ISO,
    completedAt: ISO
  };
  const attempts = [
    { ...baseAttempt, id: "attempt-compare-2", attemptNumber: 2, outputArtifactId: "video-compare-2" },
    { ...baseAttempt, id: "attempt-compare-1", attemptNumber: 1, outputArtifactId: "video-compare-1" }
  ];
  const artifacts: ArtifactRecord[] = [1, 2].map(number => ({
    id: `video-compare-${number}`,
    projectId: project.id,
    kind: "GENERATED_VIDEO",
    relativePath: `generated/${number}.mp4`,
    sha256: number === 1 ? H.d : H.e,
    sizeBytes: 100,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: ISO
  }));
  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts,
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts,
    reviewDecisions: [],
    commandAttempts: [],
    probe: {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath: "C:/verified/dreamina.exe",
      executableSha256: H.c,
      cliVersion: "fixture",
      providerIdentityHash: H.a,
      supportedOperations: ["submit", "status", "download"],
      supportedModels: ["seedance-2.0-mini"],
      supportedDurationsMs: [8000],
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: ""
    }
  });
  assert.match(html, /AI 多版本比较/);
  assert.match(html, /比较最近 2 个版本/);
  assert.equal((html.match(/visual-compare-action/g) ?? []).length >= 2, true);
  for (const [index, script] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
    new Script(script[1]!, { filename: "generate-compare-" + index });
  }
});

test("older CREATED attempt for the same current Clip is shown only as superseded history", () => {
  const plan = makePlan();
  const clip = plan.scenes[0]!.clips[0]!;
  const project: Project = {
    id: "project-1",
    name: "UI Superseded Attempt",
    status: "GENERATING",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };
  const baseAttempt = {
    projectId: project.id,
    clipId: clip.id,
    generationRequestId: "request",
    requestHash: H.a,
    preflightReportId: "preflight",
    userApprovalId: "approval",
    approvalHash: H.b,
    submissionFingerprint: H.c,
    status: "CREATED" as const,
    commandAttempts: [],
    createdAt: ISO
  };
  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts: [
      { ...baseAttempt, id: "attempt-old", attemptNumber: 1 },
      { ...baseAttempt, id: "attempt-new", attemptNumber: 2 }
    ],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    probe: {
      code: "DREAMINA_NOT_FOUND",
      cliFound: false,
      providerIdentityHash: H.a,
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: "missing"
    }
  });

  assert.match(
    html,
    /data-attempt="attempt-new" data-action="submit"/
  );
  assert.doesNotMatch(
    html,
    /data-attempt="attempt-old" data-action="submit"/
  );
  assert.match(html, /同镜头已被替代的待提交记录（1）/);
  assert.match(html, /第 1 次 · 已被替代/);
});

test("P1F-01 generation page exposes ordered workflow navigation and video-edit CTA", () => {
  const plan = makePlan();
  const clip = plan.scenes[0]!.clips[0]!;
  const project: Project = {
    id: "project-1",
    name: "P1F UX",
    status: "READY_TO_ASSEMBLE",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };
  const output: ArtifactRecord = {
    id: "video-ready",
    projectId: project.id,
    kind: "GENERATED_VIDEO",
    relativePath: "outputs/ready.mp4",
    sha256: H.one,
    sizeBytes: 12,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: ISO
  };
  const attempt = {
    id: "attempt-ready",
    projectId: project.id,
    clipId: clip.id,
    attemptNumber: 1,
    generationRequestId: "request-ready",
    requestHash: H.a,
    preflightReportId: "preflight-ready",
    userApprovalId: "approval-ready",
    approvalHash: H.b,
    submissionFingerprint: H.c,
    status: "SUCCEEDED" as const,
    providerHandle: { externalTaskId: "task-ready" },
    commandAttempts: [],
    outputArtifactId: output.id,
    createdAt: ISO,
    completedAt: ISO
  };
  const accepted: ReviewDecision = {
    id: "review-ready",
    projectId: project.id,
    clipId: clip.id,
    clipHash: clip.contentHash,
    generationAttemptId: attempt.id,
    outputArtifactId: output.id,
    outputArtifactHash: output.sha256!,
    decision: "ACCEPT",
    decidedAt: ISO
  };
  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts: [attempt],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [output],
    reviewDecisions: [accepted],
    commandAttempts: [],
    probe: {
      code: "DREAMINA_NOT_FOUND",
      cliFound: false,
      providerIdentityHash: H.a,
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: "missing"
    }
  });

  const orderedLabels = [
    "1 产品资料",
    "2 智能生成",
    "3 成片 / 发布"
  ];
  let previous = -1;
  for (const label of orderedLabels) {
    const index = html.indexOf(label);
    assert.ok(index > previous, `导航顺序错误：${label}`);
    previous = index;
  }
  assert.match(html, /辅助工具/);
  assert.match(html, />联网研究<\/a>/);
  assert.match(html, />参考视频<\/a>/);
  assert.match(html, />模型设置<\/a>/);
  assert.match(html, /高级兼容工具/);
  assert.match(html, /旧创意、脚本、导演、生成和时间线页面仅用于历史任务/);
  assert.match(html, /当前位置：视频生成 · 本页任务：查看已采用镜头与生成记录/);
  assert.match(html, /当前任务下一步：<a href="\/projects\/project-1\/timeline">调整并确认视频剪辑方案<\/a>/);
  assert.match(html, /id="enter-timeline" href="\/projects\/project-1\/timeline">进入视频剪辑/);
  assert.match(html, /id="standard-generation-config"/);
  assert.match(html, /id="standard-model"/);
  assert.match(html, /id="standard-ratio"/);
  assert.match(html, /id="standard-resolution"/);
  assert.match(html, /id="standard-native-audio"/);
  assert.match(html, /\/api\/dreamina\/capabilities/);
  assert.match(html, /function currentStandardGenerationSettings\(\)/);
  assert.match(html, /generationSettings:currentStandardGenerationSettings\(\)/);
});
test("P1F-01 manual product input uses managed image and Logo material controls", () => {
  const project: Project = {
    id: "project-manual-materials",
    name: "Manual Materials",
    status: "DRAFT",
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
  const html = renderProjectPage({
    kind: "product",
    workspace: { project },
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: []
  });
  assert.match(html, /id="product-image-list"/);
  assert.match(html, /<button[^>]*id="product-image-pick"[^>]*>选择产品图片<\/button>/);
  assert.match(html, /class="file-picker-input" id="product-image-input"/);
  assert.match(html, /<button[^>]*id="product-logo-pick"[^>]*>选择 Logo<\/button>/);
  assert.match(html, /class="file-picker-input" id="product-logo-input"/);
  assert.match(html, /fileInput\.showPicker\(\)/);
  assert.match(html, /productMaterialManager\.pickFiles\(\)/);
  assert.match(html, /productMaterialManager\.pickLogo\(\)/);
  assert.match(html, /可继续追加/);
  assert.match(html, /清空全部产品图片/);
  assert.match(html, /pvsCreateMaterialManager/);
  assert.match(html, /pvs-move-up/);
  assert.match(html, /pvs-move-down/);
  assert.match(html, /pvs-replace/);
  assert.match(html, /pvs-remove/);
  assert.match(html, /品牌标志 Logo（可选，独立管理）/);
  assert.match(html, /id="product-logo-replace"/);
  assert.match(html, /id="product-logo-remove"/);
  assert.match(html, /请至少选择 1 张产品图片/);
  assert.match(html, /请先删除或替换不可用产品图片/);
});
test("P1 project creation exposes 10-120 second quick and custom duration controls", () => {
  const html = renderProjectsPage([], new Map());
  assert.match(
    html,
    /id="duration-seconds" type="number" min="10" max="120" step="1"/
  );
  for (const seconds of [10, 15, 30, 45, 60, 90, 120]) {
    assert.match(html, new RegExp(`data-seconds="${seconds}"`));
  }
  assert.match(html, /targetDurationMs/);
  assert.match(html, /高级信息/);
});

test("project list exposes safe delete controls and its inline JavaScript parses", () => {
  const project: Project = {
    id: "delete-project-1",
    name: "待删除测试项目",
    status: "DRAFT",
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
  const html = renderProjectsPage([project], new Map());
  assert.match(html, /data-project-id="delete-project-1"/);
  assert.match(html, /data-project-name="待删除测试项目"/);
  assert.match(html, new RegExp(">删除项目<\\/button>"));
  assert.match(html, /第二次确认：请输入完整项目名称后才能删除/);
  assert.match(html, /method:'DELETE'/);
  for (const match of html.matchAll(new RegExp("<script>([\\s\\S]*?)<\\/script>", "g"))) {
    new Script(match[1]!);
  }
});

test("P1 generation page auto-polls submitted attempts and keeps manual fallback", () => {
  const plan = makePlan();
  const clip = plan.scenes[0]!.clips[0]!;
  const project: Project = {
    id: "project-1",
    name: "Auto Poll",
    status: "GENERATING",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    currentProductionPlanRef: {
      entityType: "ProductionPlan",
      entityId: plan.id,
      version: plan.version,
      hash: plan.contentHash
    },
    createdAt: ISO,
    updatedAt: ISO
  };
  const html = renderProjectPage({
    kind: "generate",
    workspace: { project, productionPlan: plan },
    blockers: [],
    attempts: [
      {
        id: "attempt-active",
        projectId: project.id,
        clipId: clip.id,
        attemptNumber: 1,
        generationRequestId: "request-1",
        requestHash: H.a,
        preflightReportId: "preflight-1",
        userApprovalId: "approval-1",
        approvalHash: H.b,
        submissionFingerprint: H.c,
        status: "SUBMITTED",
        providerHandle: { externalTaskId: "task-active" },
        commandAttempts: [],
        createdAt: ISO,
        submittedAt: ISO
      }
    ],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    probe: {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath: "C:\\test\\dreamina.exe",
      executableSha256: H.c,
      providerIdentityHash: H.a,
      capabilityFingerprint: H.b,
      rawStdout: "",
      rawStderr: "",
      cliVersion: "test",
      supportedModels: ["seedance-2.0-mini"],
      supportedOperations: ["submit", "status", "download"]
    }
  });

  assert.equal(html.includes('const autoPollAttemptIds=["attempt-active"]'), true);
  assert.match(html, /系统会自动刷新正在生成的任务/);
  assert.equal(html.includes("setTimeout(autoWatchGeneration,4000)"), true);
  assert.match(
    html,
    /data-attempt="attempt-active" data-action="poll">刷新状态/
  );
  assert.match(html, /视频生成记录/);
});
