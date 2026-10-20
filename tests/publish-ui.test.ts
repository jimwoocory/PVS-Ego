import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectWorkspace } from "../src/application/services/product-flow.js";
import type { PublishProviderProbe } from "../src/application/ports/publish-provider.js";
import type { PublicPublishPackage } from "../src/application/services/publish-bridge-service.js";
import type {
  PublishPreference,
  PublishReceipt
} from "../src/domain/publish.js";
import type {
  ArtifactRecord,
  Project,
  RenderJob,
  Timeline
} from "../src/domain/schemas.js";
import type { FinalAssembly } from "../src/application/ports/final-output-repository.js";
import type { FinalQcReport } from "../src/domain/final-qc.js";
import {
  renderMobilePublishPage,
  renderPublishCenter,
  renderPublishSettingsPage
} from "../src/web/publish-ui.js";
import { qrCodeSvg } from "../src/web/qr-code.js";
import { renderProjectPage } from "../src/web/workbench-ui.js";
import { H, ISO } from "./fixtures.js";

function workspace(status: Project["status"] = "READY_TO_PUBLISH"): ProjectWorkspace {
  return {
    project: {
      id: "project-publish-ui",
      name: "Publish UI",
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

function probes(): PublishProviderProbe[] {
  return [
    {
      providerType: "DOUYIN_BROWSER_AUTOMATION",
      displayName: "抖音浏览器辅助发布（人机协作）",
      mode: "DIRECT",
      code: "AUTH_REQUIRED",
      reason: "抖音账号尚未登录或登录状态已经失效。",
      accountDisplayName: "WC",
      platformUserId: "50805615998",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    },
    {
      providerType: "DOUYIN_SDK_HANDOFF",
      displayName: "抖音 Open SDK 唤起发布",
      mode: "HANDOFF",
      code: "DISABLED",
      reason: "管理员尚未启用移动端抖音 SDK Handoff。",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: true
    },
    {
      providerType: "DOUYIN_H5_HANDOFF",
      displayName: "抖音 H5 扫码投稿",
      mode: "HANDOFF",
      code: "DISABLED",
      reason: "尚未启用",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: true
    },
    {
      providerType: "DOUYIN_OPENAPI_DIRECT",
      displayName: "抖音 OpenAPI 直发",
      mode: "DIRECT",
      code: "DISABLED",
      reason: "OpenAPI 直发默认关闭",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    },
    {
      providerType: "MANUAL_EXPORT",
      displayName: "下载 MP4 / 手动发布",
      mode: "MANUAL",
      code: "READY",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: false
    }
  ];
}

const preference: PublishPreference = {
  projectId: "project-publish-ui",
  providerType: "DOUYIN_SDK_HANDOFF",
  updatedAt: ISO
};

function timeline(): Timeline {
  return {
    id: "timeline-publish-ui",
    projectId: "project-publish-ui",
    version: 1,
    status: "CONFIRMED",
    productionPlanHash: H.a,
    tracks: [
      {
        id: "track-video",
        kind: "VIDEO",
        order: 0,
        label: "V1",
        locked: false,
        muted: false
      }
    ],
    clips: [],
    audioItems: [],
    textItems: [],
    repairMasks: [],
    contentHash: H.b,
    createdAt: ISO,
    updatedAt: ISO,
    confirmedAt: ISO
  };
}

function renderJob(): RenderJob {
  return {
    id: "render-job-publish-ui",
    projectId: "project-publish-ui",
    timelineId: "timeline-publish-ui",
    timelineHash: H.b,
    status: "SUCCEEDED",
    inputArtifactIds: [],
    inputArtifactHashes: [],
    renderConfig: {
      width: 720,
      height: 1280,
      fps: 30,
      videoCodec: "libx264",
      audioCodec: "aac",
      format: "mp4"
    },
    outputArtifactId: "final-artifact",
    outputArtifactHash: H.c,
    createdAt: ISO,
    startedAt: ISO,
    completedAt: ISO
  };
}

function assembly(): FinalAssembly {
  return {
    id: "assembly-publish-ui",
    projectId: "project-publish-ui",
    productionPlanHash: H.a,
    selectedClipIds: [],
    inputArtifactIds: [],
    inputArtifactHashes: [],
    outputArtifactId: "final-artifact",
    outputArtifactHash: H.c,
    timelineId: "timeline-publish-ui",
    timelineHash: H.b,
    renderJobId: "render-job-publish-ui",
    renderConfig: renderJob().renderConfig,
    status: "ACCEPTED",
    createdAt: ISO,
    acceptedAt: ISO
  };
}

const finalArtifact: ArtifactRecord = {
  id: "final-artifact",
  projectId: "project-publish-ui",
  kind: "FINAL_VIDEO",
  relativePath: "final/final.mp4",
  sha256: H.c,
  sizeBytes: 1000,
  mimeType: "video/mp4",
  integrityStatus: "READY",
  immutable: true,
  createdAt: ISO
};

function finalQc(overall: FinalQcReport["overall"] = "WARN"): FinalQcReport {
  return {
    id: "final-qc-publish-ui",
    projectId: "project-publish-ui",
    assemblyId: "assembly-publish-ui",
    artifactId: "final-artifact",
    artifactHash: H.c,
    timelineId: "timeline-publish-ui",
    timelineHash: H.b,
    evaluatorVersion: "final-qc-v1",
    overall,
    checks: [
      {
        code: "VISUAL_PRODUCT_IDENTITY",
        severity: overall,
        label: "产品视觉一致性",
        message:
          overall === "BLOCK"
            ? "产品身份检查阻止发布"
            : "缺少部分视觉审片证据，请人工确认"
      }
    ],
    createdAt: ISO,
    contentHash: H.d
  };
}

test("publish settings explains capability gating and always exposes Manual Export", () => {
  const html = renderPublishSettingsPage({
    workspace: workspace(),
    preference,
    probes: probes()
  });
  assert.match(html, /发布方式/);
  assert.match(html, /发布能力状态/);
  assert.match(html, /当前可用：1\/5/);
  assert.match(html, /外部发布通道可用 0 个/);
  assert.match(html, /当前主发布路径为“抖音浏览器辅助发布（人机协作）”/);
  assert.match(html, /登录抖音/);
  assert.match(html, /账号：WC/);
  assert.match(html, /抖音号：50805615998/);
  assert.match(html, /下载 MP4 \/ 手动发布/);
  assert.match(html, /作品管理页再次确认到本次作品/);
  assert.match(html, /OpenAPI 直发默认关闭/);
});

test("browser publisher READY uses explicit direct-publish confirmation", () => {
  const readyProbes = probes().map((probe) =>
    probe.providerType === "DOUYIN_BROWSER_AUTOMATION"
      ? {
          ...probe,
          code: "READY" as const,
          reason: undefined
        }
      : probe
  );
  const html = renderPublishCenter({
    projectId: "project-publish-ui",
    projectName: "Publish UI",
    acceptedFinal: true,
    preference: {
      projectId: "project-publish-ui",
      providerType: "DOUYIN_BROWSER_AUTOMATION",
      updatedAt: ISO
    },
    probes: readyProbes,
    packages: [],
    receipts: []
  });
  assert.match(html, /抖音浏览器辅助发布（人机协作）/);
  assert.match(html, /抖音账号：<\/b>WC/);
  assert.match(html, /抖音号：50805615998/);
  assert.match(html, /创建抖音发布任务/);
  assert.match(html, /我明确确认本次发布到抖音/);
  assert.match(html, /确认本次辅助发布/);
  assert.match(html, /作品管理页核实/);
  assert.match(html, /publish\/packages\/.*\/direct/);
  assert.match(html, /expectedAccountId="50805615998"/);
  assert.match(html, /JSON.stringify\(\{confirmed:true,expectedAccountId\}\)/);
});

test("direct publish without a concrete platform account ID stays locked", () => {
  const html = renderPublishCenter({
    projectId: "project-publish-ui", projectName: "Publish UI", acceptedFinal: true,
    preference: { projectId: "project-publish-ui", providerType: "DOUYIN_BROWSER_AUTOMATION", updatedAt: ISO },
    probes: probes().map(probe => probe.providerType === "DOUYIN_BROWSER_AUTOMATION"
      ? { ...probe, code: "READY", platformUserId: undefined } : probe),
    packages: [], receipts: []
  });
  assert.match(html, /尚未取得，请重新登录或授权并刷新状态/);
  assert.match(html, /id="p1-create" disabled/);
});

test("publish center never equates handoff completion with published", () => {
  const packages: PublicPublishPackage[] = [
    {
      id: "package-one",
      projectId: "project-publish-ui",
      finalAssemblyId: "assembly-publish-ui",
      finalArtifactId: "final-artifact",
      finalArtifactHash: H.c,
      providerType: "DOUYIN_SDK_HANDOFF",
      titleDraft: "Package",
      expiresAt: ISO,
      status: "HANDOFF_COMPLETED",
      createdAt: ISO,
      claimedAt: ISO,
      tokenConsumedAt: ISO,
      handoffStartedAt: ISO,
      completedAt: ISO
    }
  ];
  const receipts: PublishReceipt[] = [
    {
      id: "receipt-one",
      projectId: "project-publish-ui",
      packageId: "package-one",
      providerType: "DOUYIN_SDK_HANDOFF",
      kind: "HANDOFF_COMPLETED",
      trusted: false,
      createdAt: ISO
    }
  ];
  const html = renderPublishCenter({
    projectId: "project-publish-ui",
    projectName: "Publish UI",
    acceptedFinal: true,
    preference,
    probes: probes(),
    packages,
    receipts
  });
  assert.match(html, /交接完成，未确认最终发布/);
  assert.match(html, /只有可信平台回执才会把项目标记为已发布/);
  assert.doesNotMatch(html, />已发布</);
  assert.match(html, /发布设置 \/ 切换发布方式/);
  assert.match(html, /切换到下载 MP4 \/ 手动发布/);
  assert.match(html, /providerType:'MANUAL_EXPORT'/);
  assert.match(html, /当前选择的外部发布方式暂不可用，但不会阻断成片交付/);
});

test("manual export stays fully usable without platform credentials", () => {
  const html = renderPublishCenter({
    projectId: "project-publish-ui",
    projectName: "Publish UI",
    acceptedFinal: true,
    preference: {
      projectId: "project-publish-ui",
      providerType: "MANUAL_EXPORT",
      updatedAt: ISO
    },
    probes: probes(),
    packages: [],
    receipts: []
  });
  assert.match(html, /手动发布不需要平台 API/);
  assert.match(html, /创建手机领取包（可选）/);
  assert.doesNotMatch(html, /id="p1-create" disabled/);
});

test("mobile publish page claims token from URL fragment and has no manual published-confirm button", () => {
  const html = renderMobilePublishPage("package-mobile");
  assert.match(html, /location\.hash\.slice\(1\)/);
  assert.match(html, /\/claim/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /我已完成交接（不代表已发布）/);
  assert.doesNotMatch(html, /标记已发布/);
  assert.doesNotMatch(html, /\?token=/);
});

test("QR generator creates standalone SVG for fragment claim link", () => {
  const svg = qrCodeSvg(
    "https://studio.example.test/publish/mobile/pkg#token=secret-once"
  );
  assert.match(svg, /<svg\b/);
  assert.match(svg, /viewBox|width=/);
  assert.doesNotMatch(svg, /secret-once/);
});

test("final page uses P1 Publish Center and keeps manual MP4 download", () => {
  const html = renderProjectPage({
    kind: "final",
    workspace: workspace(),
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [finalArtifact],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: timeline(),
    renderJob: renderJob(),
    finalAssembly: assembly(),
    finalQc: finalQc("WARN"),
    publishAttempts: [],
    publishBridge: {
      preference,
      probes: probes(),
      packages: [],
      receipts: []
    }
  });
  assert.match(html, /发布中心/);
  assert.match(html, /最终交付状态/);
  assert.match(html, /最终 MP4：<b>可下载<\/b>/);
  assert.match(html, /成片确认：<b>已确认<\/b>/);
  assert.match(html, /发布前 QC：<b>有警告<\/b>/);
  assert.match(html, /发布前质检/);
  assert.match(html, /产品视觉一致性/);
  assert.match(html, /外部发布资质或授权缺失不会阻断最终成片交付/);
  assert.match(html, /下载成片 MP4/);
  assert.match(html, /发布设置 \/ 切换发布方式/);
  assert.doesNotMatch(html, /OAuth \+ video\.create 发布链路/);
  assert.doesNotMatch(html, /id="publish-douyin"/);
});

test("accepted final without QC keeps publishing locked until QC runs", () => {
  const html = renderProjectPage({
    kind: "final",
    workspace: workspace(),
    blockers: [],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [finalArtifact],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: timeline(),
    renderJob: renderJob(),
    finalAssembly: assembly(),
    publishAttempts: [],
    publishBridge: {
      preference,
      probes: probes(),
      packages: [],
      receipts: []
    }
  });
  assert.match(html, /发布前 QC：<b>尚未运行<\/b>/);
  assert.match(html, /运行发布前质检/);
  assert.match(html, /先生成或恢复一个可校验、可下载，并已确认的最终 MP4/);
  assert.doesNotMatch(html, /发布设置 \/ 切换发布方式/);
});

test("accepted assembly with a missing final Artifact cannot create a publish package", () => {
  const html = renderProjectPage({
    kind: "final",
    workspace: workspace(),
    blockers: [
      {
        id: "legacy-publish-blocker",
        projectId: "project-publish-ui",
        scope: "PROVIDER",
        reasonCode: "OTHER",
        message: "旧式抖音 OAuth 阻塞",
        requiredUserAction: "配置旧式直发",
        resumeCheckpoint: "publish.douyin.oauth",
        createdAt: ISO
      },
      {
        id: "artifact-blocker",
        projectId: "project-publish-ui",
        scope: "PROJECT",
        reasonCode: "ARTIFACT_INTEGRITY_FAILURE",
        message: "最终文件缺失",
        requiredUserAction: "恢复最终文件",
        resumeCheckpoint: "recovery.artifact",
        createdAt: ISO
      }
    ],
    attempts: [],
    generationRequests: [],
    preflights: [],
    approvals: [],
    compiledPrompts: [],
    artifacts: [],
    reviewDecisions: [],
    commandAttempts: [],
    timeline: timeline(),
    renderJob: renderJob(),
    finalAssembly: assembly(),
    publishAttempts: [],
    publishBridge: {
      preference,
      probes: probes(),
      packages: [],
      receipts: []
    }
  });
  assert.match(html, /最终 MP4：<b>尚未就绪<\/b>/);
  assert.match(html, /当前最终 MP4 文件不可用或校验未通过/);
  assert.match(html, /先生成或恢复一个可校验、可下载，并已确认的最终 MP4/);
  assert.doesNotMatch(html, /id="p1-create"/);
  assert.doesNotMatch(html, /下载 MP4 \/ 手动发布兜底可用/);
  assert.doesNotMatch(html, /旧式抖音 OAuth 阻塞/);
  assert.match(html, /最终文件缺失/);
});
