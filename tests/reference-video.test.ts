import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  ArtifactRecord,
  ReferenceVideoProfile
} from "../src/domain/schemas.js";
import type { AgentTask } from "../src/application/ports/agent-task-repository.js";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../src/application/ports/artifact-repository.js";
import type { ReferenceVideoRepository } from "../src/application/ports/reference-video-repository.js";
import type {
  StructuredAiRequest,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { referenceVideoNeedsBrowserPreview } from "../src/adapters/media/reference-video-media.js";
import { ReferenceVideoAnalysisService } from "../src/application/services/reference-video-analysis.js";
import { AiGenerationService } from "../src/application/services/ai-generation.js";
import { makeProductTruth } from "./fixtures.js";
import {
  renderAgentProjectPage,
  renderReferenceVideoPage
} from "../src/web/workbench-ui.js";

class MemoryArtifacts implements ArtifactRepository {
  readonly rows = new Map<string, ArtifactRecord>();

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    const row: ArtifactRecord = {
      ...input,
      integrityStatus: "PENDING",
      immutable: true,
      createdAt: new Date().toISOString()
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async markReady(
    id: string,
    fields: { sha256: string; sizeBytes: number; mimeType?: string }
  ): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...row,
      ...fields,
      integrityStatus: "READY"
    };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next = { ...row, integrityStatus: "MISSING" as const };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next = { ...row, integrityStatus: "CORRUPT" as const };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async listByProject(
    projectId: string,
    kind?: ArtifactRecord["kind"]
  ): Promise<ArtifactRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === projectId && (!kind || row.kind === kind)
      )
      .map((row) => structuredClone(row));
  }

  async listPending(): Promise<ArtifactRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.integrityStatus === "PENDING")
      .map((row) => structuredClone(row));
  }
}

class MemoryReferenceVideos implements ReferenceVideoRepository {
  readonly profiles: ReferenceVideoProfile[] = [];

  async nextVersion(projectId: string): Promise<number> {
    return (
      Math.max(
        0,
        ...this.profiles
          .filter((item) => item.projectId === projectId)
          .map((item) => item.version)
      ) + 1
    );
  }

  async saveProfile(
    profile: ReferenceVideoProfile
  ): Promise<ReferenceVideoProfile> {
    for (const current of this.profiles) {
      if (
        current.projectId === profile.projectId &&
        current.status === "ACTIVE"
      ) {
        current.status = "STALE";
      }
    }
    this.profiles.push(structuredClone(profile));
    return structuredClone(profile);
  }

  async latestActive(
    projectId: string
  ): Promise<ReferenceVideoProfile | null> {
    return (
      this.profiles
        .filter(
          (item) =>
            item.projectId === projectId && item.status === "ACTIVE"
        )
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }

  async listProfiles(projectId: string): Promise<ReferenceVideoProfile[]> {
    return this.profiles
      .filter((item) => item.projectId === projectId)
      .map((item) => structuredClone(item));
  }

  async markActiveProfilesStale(projectId: string): Promise<void> {
    for (const item of this.profiles) {
      if (item.projectId === projectId && item.status === "ACTIVE") {
        item.status = "STALE";
      }
    }
  }
}

class ReferenceAnalysisRuntime implements StructuredAiRuntime {
  readonly id = "reference-test";
  readonly version = "1";
  request?: StructuredAiRequest;

  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    this.request = request;
    return this.result();
  }

  async generateJsonWithMetadata(request: StructuredAiRequest) {
    this.request = request;
    return {
      data: this.result(),
      metadata: {
        executionId: "reference-execution",
        providerId: "vision-provider",
        modelId: "vision-model",
        configVersion: 3
      }
    };
  }

  private result() {
    return {
      analysisConfidence: "HIGH",
      hook: {
        firstThreeSecondsPattern:
          "快速建立问题并立即展示产品结果",
        structuralPurpose: "在前三秒建立观看理由"
      },
      pacing: {
        overall: "前快后稳",
        estimatedShotCount: 4,
        averageShotDurationMs: 1000.25
      },
      shotLanguage: {
        shotSizes: ["近景", "特写"],
        cameraPositions: ["正面", "斜侧"],
        cameraMovements: ["缓慢推进"],
        compositionPatterns: ["主体居中"]
      },
      productAppearance: {
        firstAppearanceMs: 500,
        visibilityPattern: "早出现并反复回到主体",
        showcasePattern: "先结果后功能"
      },
      sellingPointPattern: ["问题 → 功能 → 结果"],
      dialogueNarrationStructure: "短句旁白驱动，每个卖点单独成段",
      audioBgMusicStructure: "节奏型 BGM 配合镜头切换",
      ctaPattern: "结尾单一行动引导",
      reusableStylePrinciples: [
        "前三秒给出结果",
        "每个镜头只承担一个信息任务"
      ]
    };
  }
}

function runFile(
  executable: string,
  args: string[]
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { windowsHide: true, timeout: 30_000 },
      (error) => resolve(!error)
    );
  });
}

test("HEVC reference video needs a browser H.264 preview while H.264 does not", () => {
  const base = {
    durationMs: 1000,
    width: 1920,
    height: 1080,
    frameRate: 30,
    hasAudio: true,
    sceneCutTimestampsMs: []
  };
  assert.equal(
    referenceVideoNeedsBrowserPreview({
      ...base,
      videoCodec: "hevc",
      audioCodec: "aac"
    }),
    true
  );
  assert.equal(
    referenceVideoNeedsBrowserPreview({
      ...base,
      videoCodec: "h264",
      audioCodec: "aac"
    }),
    false
  );
});

test("uploaded MP4 becomes a structured ReferenceVideoProfile with sampled visual media", async (t) => {
  const ffmpegAvailable = await runFile("ffmpeg", ["-version"]);
  const ffprobeAvailable = await runFile("ffprobe", ["-version"]);
  if (!ffmpegAvailable || !ffprobeAvailable) {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }

  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-reference-video-")
  );
  const projectId = "project-reference-video";
  const projectRoot = path.join(temp, projectId);
  const source = path.join(temp, "reference.mp4");
  try {
    const made = await runFile("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=4:size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      source
    ]);
    assert.equal(made, true);

    const artifactRepo = new MemoryArtifacts();
    const store = new LocalArtifactStore(projectRoot, artifactRepo);
    const artifact = await store.writeImmutable({
      id: "reference-artifact",
      projectId,
      kind: "USER_INPUT",
      relativePath: "reference-video/reference.mp4",
      immutable: true,
      bytes: await fs.readFile(source),
      mimeType: "video/mp4"
    });
    const references = new MemoryReferenceVideos();
    const runtime = new ReferenceAnalysisRuntime();
    const service = new ReferenceVideoAnalysisService(
      references,
      artifactRepo,
      runtime,
      temp
    );
    const profile = await service.analyzeUpload({
      projectId,
      artifactId: artifact.id,
      originalFilename: "reference.mp4"
    });

    assert.equal(profile.status, "ACTIVE");
    assert.equal(profile.videoArtifactId, artifact.id);
    assert.equal(profile.videoArtifactHash, artifact.sha256);
    assert.equal(profile.media.durationMs >= 3900, true);
    assert.equal(profile.media.sampledFrameCount > 0, true);
    assert.equal(profile.media.hasAudio, true);
    assert.equal(profile.copyGuard, "STRUCTURE_AND_METHOD_ONLY");
    assert.deepEqual(profile.aiExecution, {
      executionId: "reference-execution",
      providerId: "vision-provider",
      modelId: "vision-model",
      configVersion: 3
    });
    assert.equal((runtime.request?.media?.length ?? 0) > 0, true);
    assert.match(
      runtime.request?.instructions ?? "",
      /Do not reproduce or quote source dialogue/
    );
    assert.equal(
      (runtime.request?.input as { copyPolicy?: string }).copyPolicy,
      "STRUCTURE_AND_METHOD_ONLY"
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

class QueueRuntime implements StructuredAiRuntime {
  readonly id = "queue";
  readonly version = "1";
  readonly requests: StructuredAiRequest[] = [];
  constructor(private readonly outputs: unknown[]) {}
  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    this.requests.push(request);
    const output = this.outputs.shift();
    if (output === undefined) throw new Error("missing queued output");
    return structuredClone(output);
  }
}

function activeProfile(projectId: string): ReferenceVideoProfile {
  return {
    id: "reference-profile-1",
    projectId,
    version: 1,
    status: "ACTIVE",
    sourceType: "UPLOAD",
    videoArtifactId: "reference-video-artifact",
    videoArtifactHash: "a".repeat(64),
    originalFilename: "reference.mp4",
    media: {
      durationMs: 30000,
      width: 1080,
      height: 1920,
      frameRate: 30,
      hasAudio: true,
      sampledFrameCount: 10,
      sceneCutTimestampsMs: [3000, 6500]
    },
    analysisConfidence: "HIGH",
    hook: {
      firstThreeSecondsPattern: "结果先行",
      structuralPurpose: "快速建立观看理由"
    },
    pacing: {
      overall: "快节奏",
      estimatedShotCount: 8,
      averageShotDurationMs: 3750
    },
    shotLanguage: {
      shotSizes: ["近景"],
      cameraPositions: ["正面"],
      cameraMovements: ["推进"],
      compositionPatterns: ["主体居中"]
    },
    productAppearance: {
      firstAppearanceMs: 800,
      visibilityPattern: "高频露出",
      showcasePattern: "结果后解释"
    },
    sellingPointPattern: ["问题→卖点→结果"],
    dialogueNarrationStructure: "短句旁白",
    audioBgMusicStructure: "节奏型 BGM",
    ctaPattern: "结尾单 CTA",
    reusableStylePrinciples: ["前三秒给结果"],
    copyGuard: "STRUCTURE_AND_METHOD_ONLY",
    contentHash: "b".repeat(64),
    createdAt: "2026-09-28T00:00:00.000Z"
  };
}

test("Creative and Script bind the active ReferenceVideoProfile and only receive structure/method context", async () => {
  const truth = makeProductTruth();
  const profile = activeProfile(truth.projectId);
  const runtime = new QueueRuntime([
    {
      concepts: Array.from({ length: 4 }, (_, index) => ({
        title: "Concept " + index,
        targetAudience: "buyers",
        painPoint: "need",
        hook: "hook",
        coreSellingPoint: "Feature one",
        narrativePattern: "problem-solution",
        expectedDurationMs: 60000,
        productShowcaseStrategy: "hero",
        generationRisk: "LOW",
        requiredFactIds: ["fact-1"]
      }))
    },
    {
      beats: [
        {
          purpose: "PRODUCT",
          text: "Feature one",
          estimatedDurationMs: 60000,
          requiredFactIds: ["fact-1"]
        }
      ]
    }
  ]);
  const service = new AiGenerationService(runtime);
  const batch = await service.generateCreativeBatch(
    truth,
    1,
    60000,
    profile
  );
  assert.deepEqual(batch.referenceVideoProfileRef, {
    entityType: "ReferenceVideoProfile",
    entityId: profile.id,
    version: profile.version,
    hash: profile.contentHash
  });
  const creativeInput = runtime.requests[0]!.input as {
    referenceVideoProfile?: {
      policy?: string;
      hook?: unknown;
    };
  };
  assert.equal(
    creativeInput.referenceVideoProfile?.policy,
    "STRUCTURE_AND_METHOD_ONLY"
  );
  assert.match(
    runtime.requests[0]!.instructions,
    /Do not copy its wording/
  );

  const script = await service.generateScriptDraft({
    truth,
    batch,
    selectedCreativeId: batch.concepts[0]!.id,
    version: 1,
    targetDurationMs: 60000,
    referenceVideoProfile: profile
  });
  assert.deepEqual(script.referenceVideoProfileRef, {
    entityType: "ReferenceVideoProfile",
    entityId: profile.id,
    version: profile.version,
    hash: profile.contentHash
  });
  assert.match(
    runtime.requests[1]!.instructions,
    /Never copy source wording/
  );
});

test("Reference Video UI imports the active analysis into intelligent one-click production", () => {
  const profile = activeProfile("project-ui-reference");
  const workspace = {
    project: {
      id: "project-ui-reference",
      name: "Reference UI",
      status: "DRAFT" as const,
      targetPlatform: "douyin" as const,
      targetDurationMs: 30000,
      aspectRatio: "9:16" as const,
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z"
    }
  };
  const referenceHtml = renderReferenceVideoPage({
    workspace,
    profile,
    history: [profile],
    previewArtifactId: "reference-preview-h264"
  });
  assert.match(referenceHtml, /分析参考/);
  assert.match(referenceHtml, /导入智能生成/);
  assert.match(referenceHtml, /只学习结构、节奏和制作方法/);
  assert.match(referenceHtml, /\/smart\?useReference=1/);
  assert.match(
    referenceHtml,
    /\/api\/artifacts\/reference-preview-h264\/content/
  );
  assert.doesNotMatch(
    referenceHtml,
    new RegExp(
      "/api/artifacts/" + profile.videoArtifactId + "/content"
    )
  );
  assert.match(referenceHtml, /H\.264 兼容预览/);
  assert.doesNotMatch(referenceHtml, /referenceArtifactId=/);

  // The old single-clip renderer remains covered only as a hidden compatibility
  // surface; normal Reference Video / Intelligent Generation navigation no longer
  // routes users into it.
  const agentHtml = renderAgentProjectPage({
    workspace,
    tasks: [],
    prefillReference: {
      artifactId: profile.videoArtifactId,
      originalFilename: "reference.mp4",
      mimeType: "video/mp4"
    }
  });
  assert.match(agentHtml, /已从“参考视频”带入生成直参/);
  assert.match(
    agentHtml,
    new RegExp(
      'name="existingReferenceArtifactId" value="' +
        profile.videoArtifactId +
        '"'
    )
  );
  assert.match(agentHtml, /参考视频分析结果仍是另一条独立链路/);
  assert.match(agentHtml, /可继续追加/);
  assert.match(agentHtml, /id="agent-material-list"/);
  assert.match(agentHtml, /清空全部参考素材/);
  assert.match(agentHtml, /pvsCreateMaterialManager/);
  assert.match(agentHtml, /pvs-move-up/);
  assert.match(agentHtml, /pvs-move-down/);
  assert.match(agentHtml, /pvs-replace/);
  assert.match(agentHtml, /pvs-remove/);
  assert.match(agentHtml, /品牌标志 Logo（独立管理）/);
  assert.match(agentHtml, /替换 Logo/);
  assert.match(agentHtml, /删除 Logo/);
  assert.match(agentHtml, /请先删除或替换不可用素材/);
  assert.match(agentHtml, /文件“'\+file\.name\+'”：/);
  assert.match(agentHtml, /id="agent-operation"/);
  assert.match(agentHtml, /id="agent-model"/);
  assert.match(agentHtml, /id="agent-aspect-ratio"/);
  assert.match(agentHtml, /id="agent-resolution"/);
  assert.match(agentHtml, /id="agent-native-audio"/);
  assert.match(agentHtml, /\/api\/dreamina\/capabilities/);
  assert.match(agentHtml, /nativeAudioOutputRequested:Boolean\(agentNativeAudio\.checked\)/);
  assert.match(agentHtml, /aspectRatio:agentRatioSelect\.value/);
  assert.match(agentHtml, /videoResolution:agentResolutionSelect\.value/);
  assert.doesNotMatch(
    agentHtml,
    /<option value="seedance-2\.0-mini"[^>]*>/
  );
});

test("pre-submit Agent task exposes shared material editor and submitted task locks it", () => {
  const workspace = {
    project: {
      id: "project-agent-material-ui",
      name: "Agent Material UI",
      status: "DRAFT" as const,
      targetPlatform: "douyin" as const,
      targetDurationMs: 30000,
      aspectRatio: "9:16" as const,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z"
    }
  };
  const task: AgentTask = {
    id: "agent-task-editable",
    projectId: workspace.project.id,
    skillId: "dreamina-cli",
    status: "READY_TO_CONFIRM",
    requestText: "用产品图生成广告",
    requestedMethod: "AUTO",
    selectedOperation: "image2video",
    model: "seedance-2.0-mini",
    durationMs: 10000,
    aspectRatio: "9:16",
    videoResolution: "720p",
    nativeAudioOutputRequested: false,
    materials: [
      {
        artifactId: "agent-image-artifact",
        type: "image",
        originalFilename: "product.png",
        mimeType: "image/png",
        sizeBytes: 123,
        sha256: "a".repeat(64),
        priority: 0
      },
      {
        artifactId: "agent-logo-artifact",
        type: "logo",
        originalFilename: "logo.png",
        mimeType: "image/png",
        sizeBytes: 45,
        sha256: "b".repeat(64),
        priority: 1
      }
    ],
    generationRequestId: "old-generation-request",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z"
  };

  const editableHtml = renderAgentProjectPage({
    workspace,
    tasks: [task]
  });
  assert.match(editableHtml, /编辑本任务素材/);
  assert.match(editableHtml, /保存素材并重新检查/);
  assert.match(editableHtml, /旧生成确认失效/);
  assert.match(editableHtml, /agent-task-material-list/);
  assert.match(editableHtml, /orderedMaterials/);
  assert.match(editableHtml, /existingLogoArtifactId/);
  assert.match(editableHtml, /\/materials/);
  assert.match(editableHtml, /agent-image-artifact/);
  assert.match(editableHtml, /agent-logo-artifact/);
  assert.match(editableHtml, /历史素材文件已缺失或完整性异常/);
  assert.match(editableHtml, /历史 Logo 文件已缺失或完整性异常/);
  assert.doesNotMatch(
    editableHtml,
    /\/api\/artifacts\/agent-image-artifact\/content/
  );

  const readyArtifacts: ArtifactRecord[] = [
    {
      id: "agent-image-artifact",
      projectId: workspace.project.id,
      kind: "USER_INPUT",
      relativePath: "agent/input/product.png",
      sha256: "a".repeat(64),
      sizeBytes: 123,
      mimeType: "image/png",
      integrityStatus: "READY",
      immutable: true,
      createdAt: "2026-09-30T00:00:00.000Z"
    },
    {
      id: "agent-logo-artifact",
      projectId: workspace.project.id,
      kind: "USER_INPUT",
      relativePath: "agent/input/logo.png",
      sha256: "b".repeat(64),
      sizeBytes: 45,
      mimeType: "image/png",
      integrityStatus: "READY",
      immutable: true,
      createdAt: "2026-09-30T00:00:00.000Z"
    }
  ];
  const readyHtml = renderAgentProjectPage({
    workspace,
    tasks: [task],
    artifacts: readyArtifacts
  });
  assert.match(
    readyHtml,
    /\/api\/artifacts\/agent-image-artifact\/content/
  );
  assert.match(
    readyHtml,
    /\/api\/artifacts\/agent-logo-artifact\/content/
  );

  const lockedHtml = renderAgentProjectPage({
    workspace,
    tasks: [{ ...task, status: "SUBMITTED" }]
  });
  assert.doesNotMatch(lockedHtml, /<summary><b>编辑本任务素材<\/b><\/summary>/);
});
