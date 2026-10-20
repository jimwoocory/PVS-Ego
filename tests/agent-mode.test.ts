import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  AgentModeService,
  selectAgentOperation
} from "../src/application/services/agent-mode-service.js";
import {
  DreaminaAgentCapabilityService,
  type DreaminaCapabilityRegistry
} from "../src/application/services/dreamina-agent-capability.js";
import type {
  AgentMaterial,
  AgentTask,
  AgentTaskRepository,
  AgentTaskUpdate
} from "../src/application/ports/agent-task-repository.js";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import { ApprovalService } from "../src/application/services/approval-service.js";
import type { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import type { DomesticJimengCliProvider } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import {
  buildVerifiedDreaminaRuntime
} from "../src/adapters/video/verified-dreamina-runtime-loader.js";
import type { GenerationRequest } from "../src/domain/schemas.js";
import type {
  ArtifactRecord,
  GenerationAttempt,
  PreflightReport,
  UserApproval
} from "../src/domain/schemas.js";
import { makeApproval } from "./fixtures.js";

function material(
  type: AgentMaterial["type"],
  priority: number
): AgentMaterial {
  return {
    artifactId: "artifact-" + priority,
    type,
    originalFilename: "file-" + priority,
    mimeType:
      type === "video"
        ? "video/mp4"
        : type === "audio"
          ? "audio/mpeg"
          : "image/png",
    sizeBytes: 100,
    sha256: String(priority + 1).repeat(64).slice(0, 64),
    priority
  };
}

function testCapabilityRegistry(): DreaminaCapabilityRegistry {
  const commonModel = {
    modelVersion: "seedance2.0mini",
    supportedResolutions: ["720p"],
    durationMinSeconds: 4,
    durationMaxSeconds: 15,
    explicitRatioAllowed: true,
    vipOnly: false
  };
  return {
    source: "DREAMINA_SKILL_AND_CLI_HELP",
    skillPath: "C:\\Dreamina\\SKILL.md",
    skillSha256: "d".repeat(64),
    rootHelpSha256: "e".repeat(64),
    cliVersion: "test",
    providerIdentityHash: "b".repeat(64),
    providerCapabilityFingerprint: "c".repeat(64),
    registryFingerprint: "9".repeat(64),
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: ["seedance2.0mini"],
    ratios: ["9:16"],
    nativeAudioOutputSupported: false,
    operations: [
      {
        operation: "text2video", operationLabel: "文生视频",
        helpSha256: "1".repeat(64), modelConfigurable: true, fixedModel: false,
        supportedModels: ["seedance2.0mini"], supportedRatios: ["9:16"],
        models: [{ ...commonModel }], fixedResolutions: [],
        supportsImages: false, supportsVideos: false,
        supportsReferenceAudio: false, supportsNativeAudioOutput: false
      },
      {
        operation: "image2video", operationLabel: "图生视频",
        helpSha256: "2".repeat(64), modelConfigurable: true, fixedModel: false,
        supportedModels: ["seedance2.0mini"], supportedRatios: ["9:16"],
        models: [{ ...commonModel, maxImages: 1 }], fixedResolutions: [],
        supportsImages: true, supportsVideos: false,
        supportsReferenceAudio: false, supportsNativeAudioOutput: false,
        maxImages: 1
      },
      {
        operation: "frames2video", operationLabel: "首尾帧视频",
        helpSha256: "3".repeat(64), modelConfigurable: true, fixedModel: false,
        supportedModels: ["seedance2.0mini"], supportedRatios: ["9:16"],
        models: [{ ...commonModel, maxImages: 2 }], fixedResolutions: [],
        supportsImages: true, supportsVideos: false,
        supportsReferenceAudio: false, supportsNativeAudioOutput: false,
        maxImages: 2
      },
      {
        operation: "multiframe2video", operationLabel: "多图故事视频（固定模型）",
        helpSha256: "4".repeat(64), modelConfigurable: false, fixedModel: true,
        fixedModelLabel: "Dreamina 固定模型（当前 CLI/后端决定）",
        supportedModels: [], supportedRatios: [], models: [],
        fixedResolutions: ["720p"], transitionMinSeconds: 1, transitionMaxSeconds: 8,
        supportsImages: true, supportsVideos: false,
        supportsReferenceAudio: false, supportsNativeAudioOutput: false,
        minImages: 2, maxImages: 20
      },
      {
        operation: "multimodal2video", operationLabel: "全能参考视频",
        helpSha256: "5".repeat(64), modelConfigurable: true, fixedModel: false,
        supportedModels: ["seedance2.0mini"], supportedRatios: ["9:16"],
        models: [{
          ...commonModel, maxImages: 9, maxVideos: 3, maxAudio: 3,
          maxTotalInputs: 12, inputMediaMinSeconds: 2, inputMediaMaxSeconds: 15
        }],
        fixedResolutions: [], supportsImages: true, supportsVideos: true,
        supportsReferenceAudio: true, supportsNativeAudioOutput: false,
        maxImages: 9, maxVideos: 3, maxAudio: 3, maxTotalInputs: 12,
        inputMediaMinSeconds: 2, inputMediaMaxSeconds: 15
      }
    ]
  };
}
test("Agent smart selection chooses Dreamina mode from materials and request semantics", () => {
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "做一个视频",
      materials: []
    }).operation,
    "text2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "让产品动起来",
      materials: [material("image", 0)]
    }).operation,
    "image2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "第一张首帧，第二张尾帧",
      materials: [material("image", 0), material("image", 1)]
    }).operation,
    "frames2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "按顺序做故事",
      materials: [
        material("image", 0),
        material("image", 1),
        material("image", 2)
      ]
    }).operation,
    "multiframe2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "参考这个视频",
      materials: [material("video", 0)]
    }).operation,
    "multimodal2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "用这张产品图生成有声广告",
      materials: [material("image", 0)],
      nativeAudioOutputRequested: true
    }).operation,
    "multimodal2video"
  );
  assert.equal(
    selectAgentOperation({
      requestedMethod: "AUTO",
      requestText: "按顺序做一个有声故事",
      materials: [
        material("image", 0),
        material("image", 1),
        material("image", 2)
      ],
      nativeAudioOutputRequested: true
    }).operation,
    "multimodal2video"
  );
});

test("Agent missing direct-reference Artifact fails closed before any paid submit", async () => {
  const tasks = new MemoryAgentTaskRepository();
  const capability = {
    async registry() { return testCapabilityRegistry(); }
  } as unknown as DreaminaAgentCapabilityService;
  const service = new AgentModeService(
    tasks,
    {} as never,
    {} as never,
    { listByProject: async () => [] } as unknown as ArtifactRepository,
    {} as never,
    {} as never,
    {} as never,
    capability,
    {} as never,
    {} as never,
    os.tmpdir()
  );
  const task = await service.createTask({
    projectId: "project-media-limit",
    skillId: "dreamina-cli",
    requestText: "参考这个视频生成一个广告",
    requestedMethod: "AUTO",
    model: "seedance-2.0-mini",
    durationMs: 10000,
    materials: [
      {
        ...material("video", 0),
        durationMs: 16000
      }
    ]
  });
  await assert.rejects(
    service.planTask(task.id),
    /素材不可用或完整性校验失败/
  );
  assert.equal(task.generationRequestId, undefined);
});

test("Dreamina Agent capability reads official Skill and current subcommand help", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-agent-skill-"));
  const skillPath = path.join(temp, "SKILL.md");
  await fs.writeFile(
    skillPath,
    [
      "name: dreamina-cli",
      "Choosing the right command",
      "dreamina <subcommand> -h",
      "Warn the user before running commands that may consume credits."
    ].join("\n"),
    "utf8"
  );
  const rootHelp =
    "Generator Commands: text2video image2video frames2video multiframe2video multimodal2video";
  const multimodalHelp = [
    "dreamina multimodal2video",
    "--image stringArray",
    "--video stringArray",
    "--audio stringArray",
    "--prompt string",
    "--duration int seedance2.0 family/seedance2.0mini -> 4-15",
    "--ratio string",
    "--video_resolution string required; all other seedance2.0 models -> 720p",
    "--model_version string seedance2.0, seedance2.0fast, seedance2.0_vip, seedance2.0fast_vip, seedance2.0mini, seedance2.5",
    "seedance2.0 family/seedance2.0mini -> image<=9, video<=3, audio<=3, total inputs<=12; each and total video/audio duration 2-15s"
  ].join("\n");
  const provider = {
    async probe() {
      return {
        code: "READY",
        cliFound: true,
        identityVerified: true,
        executablePath: "C:\\dreamina.exe",
        executableSha256: "a".repeat(64),
        cliVersion: "test",
        providerIdentityHash: "b".repeat(64),
        supportedOperations: ["submit", "status", "download"],
        supportedModels: ["seedance-2.0-mini"],
        supportedDurationsMs: [10000],
        capabilityFingerprint: "c".repeat(64),
        rawStdout: "",
        rawStderr: ""
      } as const;
    },
    async inspectCommandHelp(command: string) {
      return {
        command,
        stdout: command === "__root__" ? rootHelp : multimodalHelp,
        stderr: "",
        executablePath: "C:\\dreamina.exe",
        executableSha256: "a".repeat(64)
      };
    }
  } as unknown as DomesticJimengCliProvider;
  try {
    const capabilityService = new DreaminaAgentCapabilityService(
      provider,
      skillPath
    );
    const snapshot = await capabilityService.inspect(
      "multimodal2video",
      "seedance2.0mini"
    );
    assert.equal(snapshot.command.maxImages, 9);
    assert.equal(snapshot.command.maxVideos, 3);
    assert.equal(snapshot.command.maxAudio, 3);
    assert.equal(snapshot.command.maxTotalInputs, 12);
    assert.equal(snapshot.command.inputMediaMinSeconds, 2);
    assert.equal(snapshot.command.inputMediaMaxSeconds, 15);
    assert.equal(snapshot.command.durationMaxSeconds, 15);
    assert.equal(snapshot.command.supportedModels.includes("seedance2.0mini"), true);
    assert.equal(
      snapshot.command.supportedModels.includes("seedance2.0fast_vip"),
      true
    );
    assert.equal(snapshot.skillSha256.length, 64);
    assert.equal(snapshot.command.helpSha256.length, 64);
    const registry = await capabilityService.registry();
    assert.equal(
      registry.operations.find(
        (item) => item.operation === "text2video"
      )?.supportsNativeAudioOutput,
      true
    );
    assert.equal(
      registry.operations.find(
        (item) => item.operation === "multimodal2video"
      )?.supportsNativeAudioOutput,
      true
    );
    assert.equal(
      registry.operations.find(
        (item) => item.operation === "multiframe2video"
      )?.supportsNativeAudioOutput,
      false
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

function runtimeConfig() {
  return {
    schemaVersion: "p0-v1",
    identity: {
      id: "agent-test",
      officialSourceUrl: "https://official.example.test/dreamina",
      publisher: "Official",
      executablePath: "C:\\dreamina.exe",
      executableSha256: "a".repeat(64),
      cliVersion: "1",
      officialLoginOrigins: ["https://login.example.test/"],
      verificationStatus: "VERIFIED",
      verifiedAt: "2026-09-28T00:00:00.000Z"
    },
    probe: {
      versionArgs: ["version"],
      helpArgs: ["-h"],
      versionRegex: "1",
      helpRequiredFragments: ["seedance2.0mini"],
      supportedOperations: ["submit", "status", "download"],
      supportedModels: ["seedance-2.0-mini"],
      supportedDurationsMs: [10000]
    },
    account: {
      args: ["user_credit"],
      authenticatedRegex: "credit",
      notAuthenticatedRegex: "login"
    },
    estimate: { argsTemplate: ["user_credit"] },
    submit: {
      argsTemplate: ["legacy-submit"],
      modelVersionMap: {
        "seedance-2.0-mini": "seedance2.0mini"
      },
      taskIdRegex: "submit_id=([^\\s]+)"
    },
    status: {
      argsTemplate: ["query_result", "{externalTaskId}"],
      processingRegex: "processing",
      succeededRegex: "success",
      failedRegex: "fail"
    },
    download: {
      argsTemplate: ["query_result", "{externalTaskId}", "{outputPath}"]
    },
    reconcile: {
      argsTemplate: ["query_result", "{knownExternalTaskId}"],
      foundActiveRegex: "processing",
      foundSucceededRegex: "success",
      foundFailedRegex: "fail",
      notFoundRegex: "not found"
    }
  };
}

function agentRequest(operation: GenerationRequest["dreaminaOperation"]): GenerationRequest {
  const request = {
    id: "request-agent",
    projectId: "project-agent",
    clipId: "agent-task",
    compiledPromptId: "agent-prompt",
    compiledPromptHash: "1".repeat(64),
    provider: "domestic-jimeng-cli" as const,
    providerIdentityHash: "2".repeat(64),
    capabilityFingerprint: "3".repeat(64),
    model: "seedance-2.0-mini" as const,
    promptText: "cinematic product shot",
    assetManifest: [],
    durationMs: 10000,
    aspectRatio: "9:16" as const,
    videoResolution: "720p",
    generateAudio: true,
    dreaminaOperation: operation,
    agentTaskId: "task-agent",
    agentCapabilityHelpHash: "4".repeat(64),
    inputVersionRefs: [],
    createdAt: "2026-09-28T00:00:00.000Z",
    requestHash: "5".repeat(64)
  };
  return request;
}

test("verified Dreamina runtime builds operation-specific Agent commands", () => {
  const runtime = buildVerifiedDreaminaRuntime(runtimeConfig());
  const submit = runtime.submit!;
  const image = {
    assetId: "img",
    absolutePath: "C:\\img.png",
    artifactHash: "6".repeat(64),
    role: "PRIMARY_PRODUCT" as const,
    priority: 0,
    required: true,
    inputType: "image" as const
  };
  const video = {
    assetId: "vid",
    absolutePath: "C:\\ref.mp4",
    artifactHash: "7".repeat(64),
    role: "OTHER" as const,
    priority: 1,
    required: true,
    inputType: "video" as const
  };
  const audio = {
    assetId: "aud",
    absolutePath: "C:\\ref.mp3",
    artifactHash: "8".repeat(64),
    role: "OTHER" as const,
    priority: 2,
    required: true,
    inputType: "audio" as const
  };

  const textArgs = submit.buildArgs(agentRequest("text2video"), []);
  assert.equal(textArgs[0], "text2video");
  assert.equal(textArgs.includes("--image"), false);
  assert.equal(textArgs.includes("seedance2.0mini"), true);

  const imageArgs = submit.buildArgs(
    agentRequest("image2video"),
    [image]
  );
  assert.equal(imageArgs[0], "image2video");
  assert.equal(imageArgs.includes("C:\\img.png"), true);

  const frameArgs = submit.buildArgs(
    agentRequest("frames2video"),
    [image, { ...image, assetId: "img2", absolutePath: "C:\\last.png", priority: 1 }]
  );
  assert.equal(frameArgs[0], "frames2video");
  assert.equal(frameArgs.includes("--first"), true);
  assert.equal(frameArgs.includes("--last"), true);

  const multimodalArgs = submit.buildArgs(
    agentRequest("multimodal2video"),
    [image, video, audio]
  );
  assert.equal(multimodalArgs[0], "multimodal2video");
  assert.equal(multimodalArgs.includes("--video"), true);
  assert.equal(multimodalArgs.includes("--audio"), true);
});

test("GenerationProfile keeps six Seedance 2.x/2.5 model selections identical to CLI model_version", () => {
  const runtime = buildVerifiedDreaminaRuntime(runtimeConfig());
  const submit = runtime.submit!;
  const models = [
    "seedance2.0",
    "seedance2.0fast",
    "seedance2.0_vip",
    "seedance2.0fast_vip",
    "seedance2.0mini",
    "seedance2.5"
  ];
  for (const modelVersion of models) {
    const baseRequest = agentRequest("text2video");
    const request: GenerationRequest = {
      ...baseRequest,
      model: modelVersion,
      aspectRatio: "9:16",
      videoResolution: "720p",
      generationProfile: {
        source: "DREAMINA_CAPABILITY_REGISTRY",
        operation: "text2video",
        modelMode: "EXPLICIT",
        requestedModelVersion: modelVersion,
        modelVersion,
        aspectRatioMode: "EXPLICIT",
        aspectRatio: "9:16",
        videoResolution: "720p",
        durationMs: 10000,
        referenceAudioInputCount: 0,
        nativeAudioOutputRequested: false,
        nativeAudioOutputSupported: false,
        commandHelpSha256: "4".repeat(64),
        registryFingerprint: "9".repeat(64),
        capabilityCheckedAt: "2026-09-30T00:00:00.000Z"
      }
    };
    const args = submit.buildArgs(request, []);
    const modelFlag = args.indexOf("--model_version");
    assert.ok(modelFlag >= 0, `missing --model_version for ${modelVersion}`);
    assert.equal(args[modelFlag + 1], modelVersion);
    assert.equal(request.generationProfile?.requestedModelVersion, modelVersion);
    assert.equal(request.generationProfile?.modelVersion, modelVersion);
  }
});

class MemoryAgentTaskRepository implements AgentTaskRepository {
  readonly tasks = new Map<string, AgentTask>();

  async create(task: AgentTask): Promise<AgentTask> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async update(id: string, update: AgentTaskUpdate): Promise<AgentTask> {
    const current = this.tasks.get(id);
    if (!current) throw new Error("missing AgentTask");
    const next: AgentTask = {
      ...current,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.materials !== undefined
        ? { materials: structuredClone(update.materials) }
        : {}),
      updatedAt: new Date().toISOString()
    };
    for (const key of [
      "selectedOperation",
      "plan",
      "generationRequestId",
      "generationAttemptId",
      "outputArtifactId",
      "acceptedAt"
    ] as const) {
      if (!(key in update)) continue;
      const value = update[key];
      if (value === null || value === undefined) {
        delete next[key];
      } else {
        (next as Record<string, unknown>)[key] = structuredClone(value);
      }
    }
    this.tasks.set(id, next);
    return structuredClone(next);
  }

  async findById(id: string): Promise<AgentTask | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async listByProject(projectId: string): Promise<AgentTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.projectId === projectId)
      .map((task) => structuredClone(task));
  }
}

test("AUTO multi-image planning preserves an explicitly selected model via multimodal2video", async () => {
  const tasks = new MemoryAgentTaskRepository();
  const projectId = "project-agent-auto-model";
  const requests: GenerationRequest[] = [];
  const reports: PreflightReport[] = [];
  const generation = {
    async createGenerationRequest(request: GenerationRequest) {
      requests.push(structuredClone(request));
      return structuredClone(request);
    },
    async createPreflightReport(report: PreflightReport) {
      reports.push(structuredClone(report));
      return structuredClone(report);
    }
  } as unknown as GenerationRepository;
  const materials = [material("image", 0), material("image", 1)];
  const artifactRows: ArtifactRecord[] = materials.map((item, index) => ({
    id: item.artifactId,
    projectId,
    kind: "USER_INPUT",
    relativePath: "agent/input/image-" + index + ".png",
    sha256: item.sha256,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
    integrityStatus: "READY",
    immutable: true,
    createdAt: "2026-09-30T00:00:00.000Z"
  }));
  const artifacts = {
    async listByProject(id: string) {
      return artifactRows.filter((item) => item.projectId === id);
    }
  } as unknown as ArtifactRepository;
  const provider = {
    async accountStatus() {
      return { status: "AUTHENTICATED" as const, availableCredits: 100 };
    },
    async estimate() {
      return { status: "KNOWN" as const, estimatedCredits: 1 };
    }
  } as unknown as DomesticJimengCliProvider;
  const capability = {
    async registry() { return testCapabilityRegistry(); }
  } as unknown as DreaminaAgentCapabilityService;
  const service = new AgentModeService(
    tasks, generation, {} as never, artifacts, provider, {} as never,
    {} as never, capability, {} as never, {} as never, os.tmpdir()
  );
  let task = await service.createTask({
    projectId,
    requestText: "用这两张产品图生成一个广告",
    requestedMethod: "AUTO",
    model: "seedance-2.0-mini",
    durationMs: 10000,
    aspectRatio: "9:16",
    videoResolution: "720p",
    materials
  });
  task = await service.planTask(task.id);
  assert.equal(task.status, "READY_TO_CONFIRM");
  assert.equal(task.selectedOperation, "multimodal2video");
  assert.match(task.plan?.reason ?? "", /明确选择模型/);
  assert.equal(task.plan?.generationProfile?.modelMode, "EXPLICIT");
  assert.equal(task.plan?.generationProfile?.requestedModelVersion, "seedance2.0mini");
  assert.equal(task.plan?.generationProfile?.modelVersion, "seedance2.0mini");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.dreaminaOperation, "multimodal2video");
  assert.equal(requests[0]?.model, "seedance2.0mini");
  assert.equal(requests[0]?.generationProfile?.modelVersion, "seedance2.0mini");
  assert.equal(reports.length, 1);
});
test("editing pre-submit Agent materials rebuilds request hash and stales the old request chain", async () => {
  const tasks = new MemoryAgentTaskRepository();
  const projectId = "project-agent-edit";
  const requests: GenerationRequest[] = [];
  const currentRequestIds = new Set<string>();
  const reports: Array<PreflightReport & { status: PreflightReport["status"] }> = [];
  const approvals: Array<UserApproval & { status: UserApproval["status"] }> = [];
  const staleRequestIds = new Set<string>();
  const generation = {
    async markRequestChainStale(requestId: string) {
      staleRequestIds.add(requestId);
      currentRequestIds.delete(requestId);
      for (const report of reports) {
        if (report.generationRequestId === requestId) {
          report.status = "STALE";
          report.staleAt = new Date().toISOString();
        }
      }
      for (const approval of approvals) {
        if (
          approval.generationRequestId === requestId &&
          approval.status === "ACTIVE"
        ) {
          approval.status = "STALE";
        }
      }
    },
    async createGenerationRequest(request: GenerationRequest) {
      requests.push(structuredClone(request));
      currentRequestIds.add(request.id);
      return structuredClone(request);
    },
    async createPreflightReport(report: PreflightReport) {
      reports.push(structuredClone(report));
      return structuredClone(report);
    }
  } as unknown as GenerationRepository;

  const firstMaterial = material("image", 0);
  const secondMaterial = material("image", 1);
  const artifactRows: ArtifactRecord[] = [
    {
      id: firstMaterial.artifactId,
      projectId,
      kind: "USER_INPUT",
      relativePath: "agent/input/first.png",
      sha256: firstMaterial.sha256,
      sizeBytes: firstMaterial.sizeBytes,
      mimeType: firstMaterial.mimeType,
      integrityStatus: "READY",
      immutable: true,
      createdAt: "2026-09-30T00:00:00.000Z"
    },
    {
      id: secondMaterial.artifactId,
      projectId,
      kind: "USER_INPUT",
      relativePath: "agent/input/second.png",
      sha256: secondMaterial.sha256,
      sizeBytes: secondMaterial.sizeBytes,
      mimeType: secondMaterial.mimeType,
      integrityStatus: "READY",
      immutable: true,
      createdAt: "2026-09-30T00:00:00.000Z"
    }
  ];
  const artifacts = {
    async listByProject(id: string) {
      return artifactRows
        .filter((item) => item.projectId === id)
        .map((item) => structuredClone(item));
    }
  } as unknown as ArtifactRepository;
  const provider = {
    async probe() {
      return {
        code: "READY",
        cliFound: true,
        identityVerified: true,
        executablePath: "C:\\dreamina.exe",
        executableSha256: "a".repeat(64),
        cliVersion: "test",
        providerIdentityHash: "b".repeat(64),
        supportedOperations: ["submit", "status", "download"],
        supportedModels: ["seedance-2.0-mini"],
        supportedDurationsMs: [10000],
        capabilityFingerprint: "c".repeat(64),
        rawStdout: "",
        rawStderr: ""
      } as const;
    },
    async accountStatus() {
      return { status: "AUTHENTICATED" as const };
    },
    async estimate() {
      return {
        status: "KNOWN" as const,
        estimatedCredits: 1,
        estimatedCostText: "1 credit"
      };
    }
  } as unknown as DomesticJimengCliProvider;
  const capability = {
    async registry() { return testCapabilityRegistry(); },
    async inspect(operation: string) {
      return {
        skillPath: "C:\\Dreamina\\SKILL.md",
        skillSha256: "d".repeat(64),
        rootHelp: "image2video",
        rootHelpSha256: "e".repeat(64),
        cliVersion: "test",
        providerIdentityHash: "b".repeat(64),
        capabilityFingerprint: "c".repeat(64),
        checkedAt: "2026-09-30T00:00:00.000Z",
        command: {
          operation,
          helpText: "image2video",
          helpSha256: "f".repeat(64),
          supportedModels: ["seedance2.0mini"],
          durationMinSeconds: 4,
          durationMaxSeconds: 15,
          supportsImages: true,
          supportsVideos: false,
          supportsAudio: false,
          maxImages: 1,
          videoResolutionRequired: true
        }
      };
    }
  } as unknown as DreaminaAgentCapabilityService;
  const service = new AgentModeService(
    tasks,
    generation,
    {} as never,
    artifacts,
    provider,
    {} as never,
    {} as never,
    capability,
    {} as never,
    {} as never,
    os.tmpdir()
  );

  let task = await service.createTask({
    projectId,
    requestText: "让产品动起来",
    requestedMethod: "AUTO",
    model: "seedance-2.0-mini",
    durationMs: 10000,
    materials: [firstMaterial]
  });
  task = await service.planTask(task.id);
  assert.equal(task.status, "READY_TO_CONFIRM");
  const oldRequestId = task.generationRequestId!;
  const oldRequest = requests.find((item) => item.id === oldRequestId)!;
  approvals.push({
    ...makeApproval(),
    id: "old-agent-approval",
    projectId,
    generationRequestId: oldRequestId,
    requestHash: oldRequest.requestHash,
    status: "ACTIVE"
  });

  task = await service.replaceTaskMaterials({
    taskId: task.id,
    materials: [secondMaterial]
  });
  assert.equal(task.status, "READY_TO_CONFIRM");
  assert.notEqual(task.generationRequestId, oldRequestId);
  const newRequest = requests.find(
    (item) => item.id === task.generationRequestId
  )!;
  assert.notEqual(newRequest.requestHash, oldRequest.requestHash);
  assert.deepEqual(newRequest.assetManifest.map((item) => item.assetId), [
    secondMaterial.artifactId
  ]);
  assert.equal(staleRequestIds.has(oldRequestId), true);
  assert.equal(currentRequestIds.has(oldRequestId), false);
  assert.equal(currentRequestIds.has(newRequest.id), true);
  assert.equal(
    reports.find((item) => item.generationRequestId === oldRequestId)?.status,
    "STALE"
  );
  assert.equal(approvals[0]?.status, "STALE");

  await tasks.update(task.id, { status: "SUBMITTED" });
  await assert.rejects(
    service.replaceTaskMaterials({
      taskId: task.id,
      materials: [firstMaterial]
    }),
    (error: unknown) =>
      error instanceof Error &&
      /不能再修改素材/.test(error.message)
  );
});

test("Agent confirmation is the only paid-submit gate and then auto poll/download reaches review", async (t) => {
  const tasks = new MemoryAgentTaskRepository();
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-agent-flow-")
  );
  t.after(async () => {
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });
  const requests: GenerationRequest[] = [];
  const reports: PreflightReport[] = [];
  const approvals: UserApproval[] = [];
  const attempts = new Map<string, GenerationAttempt>();
  const outputArtifact: ArtifactRecord = {
    id: "agent-video",
    projectId: "project-agent-flow",
    kind: "GENERATED_VIDEO",
    relativePath: "outputs/agent/agent-video.mp4",
    sha256: "9".repeat(64),
    sizeBytes: 1234,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: "2026-09-28T00:00:00.000Z"
  };
  const sourcePath = path.join(
    projectsRoot,
    outputArtifact.projectId,
    outputArtifact.relativePath
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, Buffer.from("fake-agent-video", "utf8"));

  const generation = {
    async createGenerationRequest(request: GenerationRequest) {
      requests.push(structuredClone(request));
      return structuredClone(request);
    },
    async createPreflightReport(report: PreflightReport) {
      reports.push(structuredClone(report));
      return structuredClone(report);
    },
    async listCurrentGenerationRequests(projectId: string) {
      return requests
        .filter((item) => item.projectId === projectId)
        .map((item) => structuredClone(item));
    },
    async listPreflightReports(projectId: string) {
      return reports
        .filter((item) => item.projectId === projectId)
        .map((item) => structuredClone(item));
    },
    async listUserApprovals(projectId: string) {
      return approvals
        .filter((item) => item.projectId === projectId)
        .map((item) => structuredClone(item));
    },
    async createUserApproval(approval: UserApproval) {
      approvals.push(structuredClone(approval));
      return structuredClone(approval);
    }
  } as unknown as GenerationRepository;

  const workflow = {
    async listGenerationAttempts(projectId: string) {
      return [...attempts.values()]
        .filter((item) => item.projectId === projectId)
        .map((item) => structuredClone(item));
    },
    async nextAttemptNumber() {
      return 1;
    },
    async createGenerationAttempt(attempt: GenerationAttempt) {
      attempts.set(attempt.id, structuredClone(attempt));
      return structuredClone(attempt);
    },
    async getGenerationAttempt(id: string) {
      const attempt = attempts.get(id);
      return attempt ? structuredClone(attempt) : null;
    },
    async updateGenerationAttemptStatus(
      id: string,
      update: Pick<GenerationAttempt, "status"> &
        Partial<GenerationAttempt>
    ) {
      const current = attempts.get(id);
      if (!current) throw new Error("missing attempt");
      const next = { ...current, ...structuredClone(update) };
      attempts.set(id, next);
      return structuredClone(next);
    }
  } as unknown as WorkflowRepository;

  const artifactData = new Map<string, ArtifactRecord>([
    [outputArtifact.id, structuredClone(outputArtifact)]
  ]);
  const artifacts = {
    async createPending(input: PendingArtifactInput) {
      const record: ArtifactRecord = {
        id: input.id,
        projectId: input.projectId,
        kind: input.kind,
        relativePath: input.relativePath,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        integrityStatus: "PENDING",
        immutable: true,
        createdAt: "2026-09-28T00:00:00.000Z"
      };
      artifactData.set(record.id, record);
      return structuredClone(record);
    },
    async markReady(
      id: string,
      fields: { sha256: string; sizeBytes: number; mimeType?: string }
    ) {
      const current = artifactData.get(id);
      if (!current) throw new Error("missing artifact");
      const next: ArtifactRecord = {
        ...current,
        sha256: fields.sha256,
        sizeBytes: fields.sizeBytes,
        ...(fields.mimeType ? { mimeType: fields.mimeType } : {}),
        integrityStatus: "READY"
      };
      artifactData.set(id, next);
      return structuredClone(next);
    },
    async listByProject(projectId: string) {
      return [...artifactData.values()]
        .filter((item) => item.projectId === projectId)
        .map((item) => structuredClone(item));
    },
    async findById(id: string) {
      const item = artifactData.get(id);
      return item ? structuredClone(item) : null;
    }
  } as unknown as ArtifactRepository;

  const provider = {
    async probe() {
      return {
        code: "READY",
        cliFound: true,
        identityVerified: true,
        executablePath: "C:\\dreamina.exe",
        executableSha256: "a".repeat(64),
        cliVersion: "test",
        providerIdentityHash: "b".repeat(64),
        supportedOperations: ["submit", "status", "download"],
        supportedModels: ["seedance-2.0-mini"],
        supportedDurationsMs: [10000],
        capabilityFingerprint: "c".repeat(64),
        rawStdout: "",
        rawStderr: ""
      } as const;
    },
    async accountStatus() {
      return { status: "AUTHENTICATED" as const };
    },
    async estimate() {
      return { status: "UNKNOWN" as const };
    }
  } as unknown as DomesticJimengCliProvider;

  const capability = {
    async registry() { return testCapabilityRegistry(); },
    async inspect(operation: string) {
      return {
        skillPath: "C:\\Dreamina\\SKILL.md",
        skillSha256: "d".repeat(64),
        rootHelp: "text2video",
        rootHelpSha256: "e".repeat(64),
        cliVersion: "test",
        providerIdentityHash: "b".repeat(64),
        capabilityFingerprint: "c".repeat(64),
        checkedAt: "2026-09-28T00:00:00.000Z",
        command: {
          operation,
          helpText: "text2video --prompt --duration --video_resolution",
          helpSha256: "f".repeat(64),
          supportedModels: ["seedance2.0mini"],
          durationMinSeconds: 4,
          durationMaxSeconds: 15,
          supportsImages: false,
          supportsVideos: false,
          supportsAudio: false,
          videoResolutionRequired: true
        }
      };
    }
  } as unknown as DreaminaAgentCapabilityService;

  const approval = new ApprovalService(generation, workflow);
  let submitCalls = 0;
  const execution = {
    async submitAttempt(id: string) {
      submitCalls += 1;
      return workflow.updateGenerationAttemptStatus(id, {
        status: "SUBMITTED",
        providerHandle: { externalTaskId: "external-1" },
        submittedAt: "2026-09-28T00:00:01.000Z"
      });
    },
    async pollAttempt(id: string) {
      return workflow.updateGenerationAttemptStatus(id, {
        status: "SUCCEEDED",
        completedAt: "2026-09-28T00:00:02.000Z"
      });
    },
    async downloadAttempt(id: string) {
      return workflow.updateGenerationAttemptStatus(id, {
        status: "SUCCEEDED",
        outputArtifactId: outputArtifact.id,
        completedAt: "2026-09-28T00:00:03.000Z"
      });
    }
  } as unknown as GenerationExecutionService;

  const assemblies: Array<{
    id: string;
    projectId: string;
    outputArtifactId: string;
    status: string;
  }> = [];
  const finalOutput = {
    async markAssembliesStale() {},
    async createAssembly(assembly: {
      id: string;
      projectId: string;
      outputArtifactId: string;
      status: string;
    }) {
      assemblies.push(structuredClone(assembly));
      return structuredClone(assembly);
    }
  };
  let finalProjectStatus = "";
  const productFlow = {
    async setProjectStatus(_projectId: string, status: string) {
      finalProjectStatus = status;
      return { status };
    }
  };

  const service = new AgentModeService(
    tasks,
    generation,
    workflow,
    artifacts,
    provider,
    approval,
    execution,
    capability,
    finalOutput as never,
    productFlow as never,
    projectsRoot
  );

  let task = await service.createTask({
    projectId: "project-agent-flow",
    skillId: "dreamina-cli",
    requestText: "做一个 10 秒产品广告",
    requestedMethod: "AUTO",
    model: "seedance-2.0-mini",
    durationMs: 10000,
    materials: []
  });
  task = await service.planTask(task.id);
  assert.equal(task.status, "READY_TO_CONFIRM");
  assert.equal(task.selectedOperation, "text2video");
  assert.equal(submitCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(reports.length, 1);

  task = await service.confirmAndSubmit({
    taskId: task.id,
    acceptedUnknownCostRisk: true
  });
  assert.equal(submitCalls, 1);
  assert.equal(task.status, "SUBMITTED");
  assert.equal(approvals.length, 1);

  task = await service.advance(task.id);
  assert.equal(task.status, "REVIEW_READY");
  assert.equal(task.outputArtifactId, outputArtifact.id);

  task = await service.accept(task.id);
  assert.equal(task.status, "ACCEPTED");
  assert.equal(Boolean(task.acceptedAt), true);
  assert.equal(assemblies.length, 1);
  assert.equal(assemblies[0]?.status, "READY");
  assert.equal(finalProjectStatus, "FINAL_REVIEW");
  assert.equal(
    [...artifactData.values()].some(
      (item) =>
        item.kind === "FINAL_VIDEO" &&
        item.integrityStatus === "READY"
    ),
    true
  );
});
