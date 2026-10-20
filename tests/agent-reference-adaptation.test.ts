import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { referenceFixture } from "./creative-reference-fixture.js";
import {
  adaptAgentReferenceMaterials
} from "../src/application/services/agent-reference-adaptation.js";
import { AgentModeService } from "../src/application/services/agent-mode-service.js";
import type {
  AgentMaterial,
  AgentTask,
  AgentTaskRepository,
  AgentTaskUpdate
} from "../src/application/ports/agent-task-repository.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ApprovalService } from "../src/application/services/approval-service.js";
import { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import type { DreaminaCapabilityRegistry, DreaminaAgentCapabilityService } from "../src/application/services/dreamina-agent-capability.js";
import type { DomesticJimengCliProvider } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import type { GenerationRequest, PreflightReport } from "../src/domain/schemas.js";

const exec = promisify(execFile);

class MemoryTasks implements AgentTaskRepository {
  private readonly map = new Map<string, AgentTask>();
  async create(task: AgentTask) { this.map.set(task.id, structuredClone(task)); return structuredClone(task); }
  async update(id: string, update: AgentTaskUpdate) {
    const current = this.map.get(id);
    if (!current) throw new Error("missing task");
    const next = { ...current, ...update, updatedAt: new Date().toISOString() } as AgentTask;
    for (const key of ["selectedOperation","plan","generationRequestId","generationAttemptId","outputArtifactId","acceptedAt"] as const) {
      if (key in update && update[key] === null) delete (next as Record<string, unknown>)[key];
    }
    this.map.set(id, structuredClone(next));
    return structuredClone(next);
  }
  async findById(id: string) { const value = this.map.get(id); return value ? structuredClone(value) : null; }
  async listByProject(projectId: string) { return [...this.map.values()].filter(t => t.projectId === projectId).map(t => structuredClone(t)); }
}

function multimodalRegistry(maxSeconds = 15): DreaminaCapabilityRegistry {
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
    operations: [{
      operation: "multimodal2video",
      operationLabel: "全能参考视频",
      helpSha256: "5".repeat(64),
      modelConfigurable: true,
      fixedModel: false,
      supportedModels: ["seedance2.0mini"],
      supportedRatios: ["9:16"],
      models: [{
        modelVersion: "seedance2.0mini",
        supportedResolutions: ["720p"],
        durationMinSeconds: 4,
        durationMaxSeconds: 15,
        explicitRatioAllowed: true,
        vipOnly: false,
        maxImages: 9,
        maxVideos: 3,
        maxAudio: 3,
        maxTotalInputs: 12,
        inputMediaMinSeconds: 2,
        inputMediaMaxSeconds: maxSeconds
      }],
      fixedResolutions: [],
      supportsImages: true,
      supportsVideos: true,
      supportsReferenceAudio: true,
      supportsNativeAudioOutput: false,
      maxImages: 9,
      maxVideos: 3,
      maxAudio: 3,
      maxTotalInputs: 12,
      inputMediaMinSeconds: 2,
      inputMediaMaxSeconds: maxSeconds
    }]
  };
}

async function videoMaterial(f: Awaited<ReturnType<typeof referenceFixture>>, name: string, seconds: number, color = "red"): Promise<AgentMaterial> {
  const file = path.join(f.root, name + ".mp4");
  const source = color === "testsrc2"
    ? `testsrc2=s=320x180:r=1:d=${seconds}`
    : `color=c=${color}:s=320x180:r=1:d=${seconds}`;
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner","-loglevel","error","-f","lavfi","-i",
    source,
    "-an","-c:v","libx264","-pix_fmt","yuv420p","-y",file
  ], { windowsHide: true, timeout: 90_000 });
  const artifact = await f.store.writeImmutable({
    id: "video-" + name,
    projectId: f.projectId,
    kind: "USER_INPUT",
    immutable: true,
    relativePath: "agent/input/" + name + ".mp4",
    mimeType: "video/mp4",
    bytes: await fs.readFile(file)
  });
  return {
    artifactId: artifact.id,
    type: "video",
    originalFilename: name + ".mp4",
    mimeType: "video/mp4",
    sizeBytes: artifact.sizeBytes!,
    sha256: artifact.sha256!,
    priority: 0,
    durationMs: seconds * 1000
  };
}

async function audioMaterial(f: Awaited<ReturnType<typeof referenceFixture>>, name: string, seconds: number): Promise<AgentMaterial> {
  const file = path.join(f.root, name + ".wav");
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner","-loglevel","error","-f","lavfi","-i",
    `sine=frequency=440:sample_rate=16000:duration=${seconds}`,
    "-c:a","pcm_s16le","-y",file
  ], { windowsHide: true, timeout: 90_000 });
  const artifact = await f.store.writeImmutable({
    id: "audio-" + name,
    projectId: f.projectId,
    kind: "USER_INPUT",
    immutable: true,
    relativePath: "agent/input/" + name + ".wav",
    mimeType: "audio/wav",
    bytes: await fs.readFile(file)
  });
  return {
    artifactId: artifact.id,
    type: "audio",
    originalFilename: name + ".wav",
    mimeType: "audio/wav",
    sizeBytes: artifact.sizeBytes!,
    sha256: artifact.sha256!,
    priority: 0,
    durationMs: seconds * 1000
  };
}

test("45s Dreamina reference video is converted to audited keyframes without changing the original", { timeout: 180_000 }, async () => {
  const f = await referenceFixture();
  try {
    const video = await videoMaterial(f, "long-reference", 45, "testsrc2");
    const sourceArtifact = (await f.artifacts.findById(video.artifactId))!;
    const sourceBytes = await fs.readFile(path.join(f.projectsRoot, f.projectId, sourceArtifact.relativePath));
    const first = await adaptAgentReferenceMaterials({
      projectId: f.projectId,
      materials: [video],
      artifacts: f.artifacts,
      projectsRoot: f.projectsRoot,
      limits: { inputMediaMaxSeconds: 15, maxImages: 9, maxVideos: 3, maxAudio: 3, maxTotalInputs: 12 }
    });
    assert.equal(first.missingRequirements.length, 0);
    assert.equal(first.adaptations.length, 1);
    assert.equal(first.adaptations[0]!.derived.length, 3);
    assert.ok(first.materials.every(item => item.type === "image"));
    assert.deepEqual(first.adaptations[0]!.reasonCodes.includes("PER_FILE_DURATION"), true);
    assert.match(first.warnings[0]!, /原视频不修改/);
    const afterBytes = await fs.readFile(path.join(f.projectsRoot, f.projectId, sourceArtifact.relativePath));
    assert.deepEqual(afterBytes, sourceBytes);

    const beforeArtifactIds = (await f.artifacts.listByProject(f.projectId)).map(a => a.id).sort();
    const repeated = await adaptAgentReferenceMaterials({
      projectId: f.projectId,
      materials: [video],
      artifacts: f.artifacts,
      projectsRoot: f.projectsRoot,
      limits: { inputMediaMaxSeconds: 15, maxImages: 9, maxVideos: 3, maxAudio: 3, maxTotalInputs: 12 }
    });
    assert.deepEqual(repeated.adaptations[0]!.derived.map(x => x.artifactId), first.adaptations[0]!.derived.map(x => x.artifactId));
    assert.deepEqual((await f.artifacts.listByProject(f.projectId)).map(a => a.id).sort(), beforeArtifactIds);
  } finally {
    await f.cleanup();
  }
});

test("total media pressure adapts video references but never truncates overlong audio", { timeout: 180_000 }, async () => {
  const f = await referenceFixture();
  try {
    const a = await videoMaterial(f, "short-a", 10, "red");
    const b = await videoMaterial(f, "short-b", 10, "blue");
    b.priority = 1;
    const adapted = await adaptAgentReferenceMaterials({
      projectId: f.projectId,
      materials: [a,b],
      artifacts: f.artifacts,
      projectsRoot: f.projectsRoot,
      limits: { inputMediaMaxSeconds: 15, maxImages: 9, maxVideos: 3, maxAudio: 3, maxTotalInputs: 12 }
    });
    assert.equal(adapted.missingRequirements.length, 0);
    assert.equal(adapted.adaptations.length, 1);
    assert.ok(adapted.adaptations[0]!.reasonCodes.includes("TOTAL_MEDIA_DURATION"));
    assert.equal(adapted.materials.filter(x => x.type === "video").length, 1);
    assert.ok(adapted.materials.filter(x => x.type === "image").length >= 1);

    const audio = await audioMaterial(f, "long-audio", 20);
    const blocked = await adaptAgentReferenceMaterials({
      projectId: f.projectId,
      materials: [audio],
      artifacts: f.artifacts,
      projectsRoot: f.projectsRoot,
      limits: { inputMediaMaxSeconds: 15, maxImages: 9, maxVideos: 3, maxAudio: 3, maxTotalInputs: 12 }
    });
    assert.ok(blocked.missingRequirements.some(x => /不会自动裁掉/.test(x)));
    assert.equal(blocked.adaptations.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("Agent plan/request uses derived keyframes and preserves source provenance before any paid submit", { timeout: 180_000 }, async () => {
  const f = await referenceFixture();
  try {
    const longVideo = await videoMaterial(f, "agent-long", 45, "testsrc2");
    const tasks = new MemoryTasks();
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
    let submitCalls = 0;
    const provider = {
      async accountStatus() {
        return { status: "AUTHENTICATED" as const, availableCredits: 100 };
      },
      async estimate() {
        return { status: "KNOWN" as const, estimatedCredits: 1 };
      },
      async submit() {
        submitCalls += 1;
        throw new Error("paid submit forbidden in adaptation test");
      }
    } as unknown as DomesticJimengCliProvider;
    const capability = {
      async registry() { return multimodalRegistry(15); }
    } as unknown as DreaminaAgentCapabilityService;

    const service = new AgentModeService(
      tasks,
      generation,
      {} as never,
      f.artifacts,
      provider,
      {} as never,
      {} as never,
      capability,
      {} as never,
      {} as never,
      f.projectsRoot
    );
    let task = await service.createTask({
      projectId: f.projectId,
      requestText: "参考这条长视频做一个10秒产品广告",
      requestedMethod: "multimodal2video",
      model: "seedance-2.0-mini",
      durationMs: 10000,
      aspectRatio: "9:16",
      videoResolution: "720p",
      materials: [longVideo]
    });
    task = await service.planTask(task.id);
    assert.equal(task.status, "READY_TO_CONFIRM");
    assert.equal(task.materials.length, 1);
    assert.equal(task.materials[0]!.type, "video");
    assert.equal(task.plan?.referenceAdaptations?.length, 1);
    assert.deepEqual(task.plan?.materialSummary, {images:0,videos:1,audios:0,logos:0});
    assert.deepEqual(task.plan?.effectiveMaterialSummary, {images:3,videos:0,audios:0,logos:0});
    assert.equal(requests.length, 1);
    assert.equal(reports.length, 1);
    assert.equal(submitCalls, 0);
    assert.equal(requests[0]!.assetManifest.length, 3);
    assert.ok(requests[0]!.assetManifest.every(item => item.inputType === "image"));
    assert.ok(requests[0]!.assetManifest.every(item =>
      item.agentReferenceAdaptation?.sourceArtifactId === longVideo.artifactId &&
      item.agentReferenceAdaptation?.sourceArtifactHash === longVideo.sha256
    ));
  } finally {
    await f.cleanup();
  }
});

test("paid submit rechecks the original long-reference bytes, not only cached keyframes", { timeout: 180_000 }, async () => {
  const f = await referenceFixture();
  try {
    const longVideo = await videoMaterial(f, "source-integrity", 45, "testsrc2");
    const tasks = new MemoryTasks();
    const generation = new PrismaGenerationRepository(f.db);
    const workflow = new PrismaWorkflowRepository(f.db);
    let submitCalls = 0;
    const provider = {
      async accountStatus() {
        return { status: "AUTHENTICATED" as const, availableCredits: 100 };
      },
      async estimate() {
        return { status: "KNOWN" as const, estimatedCredits: 1 };
      },
      async submit() {
        submitCalls += 1;
        return { externalTaskId: "SHOULD-NOT-HAPPEN" };
      }
    } as unknown as DomesticJimengCliProvider;
    const capability = {
      async registry() { return multimodalRegistry(15); }
    } as unknown as DreaminaAgentCapabilityService;
    const approval = new ApprovalService(generation, workflow);
    const execution = new GenerationExecutionService(
      generation,
      workflow,
      f.artifacts,
      {} as never,
      provider,
      f.projectsRoot
    );
    const service = new AgentModeService(
      tasks,
      generation,
      workflow,
      f.artifacts,
      provider,
      approval,
      execution,
      capability,
      {} as never,
      {} as never,
      f.projectsRoot
    );
    let task = await service.createTask({
      projectId: f.projectId,
      requestText: "长参考来源完整性测试",
      requestedMethod: "multimodal2video",
      model: "seedance-2.0-mini",
      durationMs: 10000,
      aspectRatio: "9:16",
      videoResolution: "720p",
      materials: [longVideo]
    });
    task = await service.planTask(task.id);
    assert.equal(task.status, "READY_TO_CONFIRM");
    const source = (await f.artifacts.findById(longVideo.artifactId))!;
    await fs.appendFile(
      path.join(f.projectsRoot, f.projectId, source.relativePath),
      "corrupt after approval planning"
    );
    await assert.rejects(
      service.confirmAndSubmit({
        taskId: task.id,
        acceptedUnknownCostRisk: false
      }),
      /来源文件缺失或校验失败/
    );
    assert.equal(submitCalls, 0);
  } finally {
    await f.cleanup();
  }
});
