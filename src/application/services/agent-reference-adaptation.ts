import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { AgentMaterial, AgentReferenceAdaptation } from "../ports/agent-task-repository.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { probeReferenceVideo } from "../../adapters/media/reference-video-media.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

const exec = promisify(execFile);
export const AGENT_REFERENCE_ADAPTER_VERSION = "p1f04-keyframe-adapter-v1";

export type AgentReferenceLimits = {
  inputMediaMaxSeconds?: number;
  maxImages?: number;
  maxVideos?: number;
  maxAudio?: number;
  maxTotalInputs?: number;
};

function materialCounts(materials: AgentMaterial[]) {
  return {
    images: materials.filter((item) => item.type === "image").length,
    videos: materials.filter((item) => item.type === "video").length,
    audios: materials.filter((item) => item.type === "audio").length,
    logos: materials.filter((item) => item.type === "logo").length
  };
}

function representativeTargets(
  durationMs: number,
  count: number,
  sceneCuts: readonly number[]
): number[] {
  // Keep the last seek far enough from EOF for low-frame-rate reference clips.
  const usableEnd = Math.max(0, durationMs - Math.min(1000, Math.round(durationMs / 4)));
  if (count <= 1) return [Math.round(usableEnd / 2)];
  const candidates = [0, ...sceneCuts, usableEnd]
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= usableEnd)
    .sort((a, b) => a - b);
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = Math.round((usableEnd * index) / count);
    const right = Math.round((usableEnd * (index + 1)) / count);
    const center = Math.round((left + right) / 2);
    const inWindow = candidates.filter((value) => value >= left && value <= right);
    const chosen = (inWindow.length ? inWindow : candidates)
      .slice()
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center))[0] ?? center;
    result.push(chosen);
  }
  const unique = [...new Set(result)].sort((a, b) => a - b);
  if (unique.length === count) return unique;
  for (let index = 0; unique.length < count && index < count * 3; index += 1) {
    const fallback = Math.round((usableEnd * (index + 1)) / (count + 1));
    if (!unique.includes(fallback)) unique.push(fallback);
  }
  return unique.sort((a, b) => a - b).slice(0, count);
}

async function extractFrame(
  source: string,
  target: string,
  timestampMs: number
): Promise<void> {
  await exec(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      (timestampMs / 1000).toFixed(3),
      "-i",
      source,
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-threads",
      "1",
      "-y",
      target
    ],
    { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
  );
}

export async function adaptAgentReferenceMaterials(input: {
  projectId: string;
  materials: AgentMaterial[];
  artifacts: ArtifactRepository;
  projectsRoot: string;
  limits: AgentReferenceLimits;
}): Promise<{
  materials: AgentMaterial[];
  adaptations: AgentReferenceAdaptation[];
  warnings: string[];
  missingRequirements: string[];
}> {
  const projectRoot = path.resolve(input.projectsRoot, input.projectId);
  const store = new LocalArtifactStore(projectRoot, input.artifacts);
  const artifactById = new Map(
    (await input.artifacts.listByProject(input.projectId)).map((item) => [
      item.id,
      item
    ])
  );
  const normalized: AgentMaterial[] = [];
  const absoluteById = new Map<string, string>();
  const missingRequirements: string[] = [];

  for (const material of input.materials) {
    const artifact = artifactById.get(material.artifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256 ||
      artifact.sha256 !== material.sha256
    ) {
      throw new DomainValidationError(
        "Agent 素材不可用或完整性校验失败：" + material.originalFilename
      );
    }
    if (material.type === "video" || material.type === "audio") {
      const absolute = store.resolveArtifactPath(artifact.relativePath);
      const bytes = await fs.readFile(absolute).catch(() => null);
      if (!bytes || sha256Bytes(bytes) !== material.sha256) {
        throw new DomainValidationError(
          "Agent 素材实际文件缺失或已变化：" + material.originalFilename
        );
      }
      absoluteById.set(material.artifactId, absolute);
      const media = await inspectMedia(absolute);
      if (
        (material.type === "video" && !media.hasVideo) ||
        (material.type === "audio" && !media.hasAudio) ||
        media.durationMs <= 0
      ) {
        throw new DomainValidationError(
          "无法读取参考素材实际时长：" + material.originalFilename
        );
      }
      normalized.push({ ...material, durationMs: media.durationMs });
    } else {
      normalized.push({ ...material });
    }
  }

  const limits = input.limits;
  const maxSeconds = limits.inputMediaMaxSeconds;
  const videos = normalized
    .filter((item) => item.type === "video")
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  const audios = normalized.filter((item) => item.type === "audio");
  const counts = materialCounts(normalized);

  if (limits.maxAudio !== undefined && audios.length > limits.maxAudio) {
    missingRequirements.push(
      "音频数量超过当前模型/命令上限 " + limits.maxAudio + "。"
    );
  }
  if (maxSeconds !== undefined) {
    for (const audio of audios) {
      if ((audio.durationMs ?? 0) > maxSeconds * 1000) {
        missingRequirements.push(
          audio.originalFilename +
            " 为超长参考音频（" +
            ((audio.durationMs ?? 0) / 1000).toFixed(1) +
            " 秒），当前模型输入上限 " +
            maxSeconds +
            " 秒。为避免擅自截断语义，音频不会自动裁掉，请先裁剪或移除。"
        );
      }
    }
    const audioTotal = audios.reduce(
      (sum, item) => sum + (item.durationMs ?? 0),
      0
    );
    if (audioTotal > maxSeconds * 1000) {
      missingRequirements.push(
        "参考音频总时长 " +
          (audioTotal / 1000).toFixed(1) +
          " 秒，已超过当前模型总输入时长 " +
          maxSeconds +
          " 秒；不能自动删除音频内容。"
      );
    }
  }

  const adaptIds = new Set<string>();
  if (maxSeconds !== undefined) {
    for (const video of videos) {
      if ((video.durationMs ?? 0) > maxSeconds * 1000) {
        adaptIds.add(video.artifactId);
      }
    }
  }
  if (limits.maxVideos !== undefined) {
    for (
      let index = limits.maxVideos;
      videos.length - adaptIds.size > limits.maxVideos && index < videos.length;
      index += 1
    ) {
      const candidate = videos.find((item) => !adaptIds.has(item.artifactId));
      if (!candidate) break;
      adaptIds.add(candidate.artifactId);
    }
  }
  if (maxSeconds !== undefined) {
    const audioMs = audios.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    const remainingVideoMs = () =>
      videos
        .filter((item) => !adaptIds.has(item.artifactId))
        .reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    while (
      audioMs + remainingVideoMs() > maxSeconds * 1000 &&
      videos.some((item) => !adaptIds.has(item.artifactId))
    ) {
      const candidate = videos.find((item) => !adaptIds.has(item.artifactId));
      if (!candidate) break;
      adaptIds.add(candidate.artifactId);
    }
  }

  if (!adaptIds.size) {
    return {
      materials: normalized.map((item, priority) => ({ ...item, priority })),
      adaptations: [],
      warnings: [],
      missingRequirements: [...new Set(missingRequirements)]
    };
  }

  const toAdapt = videos.filter((item) => adaptIds.has(item.artifactId));
  const remainingVideos = videos.length - toAdapt.length;
  const existingImages = counts.images + counts.logos;
  const baseInputs = existingImages + audios.length + remainingVideos;
  const imageCapacity =
    limits.maxImages === undefined
      ? 12
      : Math.max(0, limits.maxImages - existingImages);
  const totalCapacity =
    limits.maxTotalInputs === undefined
      ? 12
      : Math.max(0, limits.maxTotalInputs - baseInputs);
  const frameCapacity = Math.min(imageCapacity, totalCapacity);
  if (frameCapacity < toAdapt.length) {
    missingRequirements.push(
      "长参考视频需要转关键帧，但当前模型剩余图片/总输入槽位不足；请减少参考素材。"
    );
    return {
      materials: normalized.map((item, priority) => ({ ...item, priority })),
      adaptations: [],
      warnings: [],
      missingRequirements: [...new Set(missingRequirements)]
    };
  }

  const desired = new Map<string, number>();
  for (const video of toAdapt) {
    const ratio =
      maxSeconds && maxSeconds > 0
        ? Math.ceil((video.durationMs ?? maxSeconds * 1000) / (maxSeconds * 1000))
        : 2;
    desired.set(video.artifactId, Math.max(2, Math.min(6, ratio)));
  }
  const allocations = new Map(toAdapt.map((item) => [item.artifactId, 1]));
  let spare = frameCapacity - toAdapt.length;
  while (spare > 0) {
    const candidate = toAdapt.find(
      (item) =>
        (allocations.get(item.artifactId) ?? 0) <
        (desired.get(item.artifactId) ?? 1)
    );
    if (!candidate) break;
    allocations.set(
      candidate.artifactId,
      (allocations.get(candidate.artifactId) ?? 0) + 1
    );
    spare -= 1;
  }

  const adaptations: AgentReferenceAdaptation[] = [];
  const replacement = new Map<string, AgentMaterial[]>();
  const warnings: string[] = [];
  for (const video of toAdapt) {
    const absolute = absoluteById.get(video.artifactId)!;
    const info = await probeReferenceVideo(absolute);
    const frameCount = allocations.get(video.artifactId) ?? 1;
    const timestamps = representativeTargets(
      info.durationMs,
      frameCount,
      info.sceneCutTimestampsMs
    );
    const derived: AgentReferenceAdaptation["derived"] = [];
    const derivedMaterials: AgentMaterial[] = [];
    const seenFrameHashes = new Set<string>();
    for (const [frameIndex, timestampMs] of timestamps.entries()) {
      const key = hashValue({
        adapterVersion: AGENT_REFERENCE_ADAPTER_VERSION,
        sourceArtifactId: video.artifactId,
        sourceHash: video.sha256,
        timestampMs
      });
      const artifactId = "agent-ref-frame-" + key.slice(0, 40);
      let artifact = await input.artifacts.findById(artifactId);
      if (!artifact) {
        const tempDir = path.join(
          projectRoot,
          ".tmp",
          "agent-reference-adaptation",
          key
        );
        await fs.mkdir(tempDir, { recursive: true });
        const tempFile = path.join(tempDir, "frame.png");
        try {
          await extractFrame(absolute, tempFile, timestampMs);
          const bytes = await fs.readFile(tempFile);
          if (!bytes.length) {
            throw new DomainValidationError("参考视频关键帧抽取为空");
          }
          artifact = await store.writeImmutable({
            id: artifactId,
            projectId: input.projectId,
            kind: "OTHER",
            relativePath:
              "agent/reference-adaptations/" +
              video.sha256.slice(0, 16) +
              "/" +
              key +
              ".png",
            immutable: true,
            bytes,
            mimeType: "image/png"
          });
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(
            () => undefined
          );
        }
      }
      if (
        artifact.projectId !== input.projectId ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256 ||
        artifact.mimeType !== "image/png"
      ) {
        throw new DomainValidationError(
          "已缓存的参考视频关键帧不可用，请先执行项目恢复检查"
        );
      }
      const file = store.resolveArtifactPath(artifact.relativePath);
      const bytes = await fs.readFile(file);
      if (sha256Bytes(bytes) !== artifact.sha256) {
        throw new DomainValidationError(
          "已缓存的参考视频关键帧文件校验失败"
        );
      }
      if (seenFrameHashes.has(artifact.sha256)) {
        continue;
      }
      seenFrameHashes.add(artifact.sha256);
      const material: AgentMaterial = {
        artifactId: artifact.id,
        type: "image",
        originalFilename:
          video.originalFilename +
          " · 参考帧 " +
          (frameIndex + 1) +
          " @ " +
          (timestampMs / 1000).toFixed(2) +
          "s",
        mimeType: "image/png",
        sizeBytes: artifact.sizeBytes ?? bytes.length,
        sha256: artifact.sha256,
        priority: 0
      };
      derivedMaterials.push(material);
      derived.push({
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        timestampMs,
        frameIndex
      });
    }
    replacement.set(video.artifactId, derivedMaterials);
    adaptations.push({
      sourceArtifactId: video.artifactId,
      sourceArtifactHash: video.sha256,
      sourceFilename: video.originalFilename,
      sourceDurationMs: info.durationMs,
      strategy: "KEYFRAMES",
      adapterVersion: AGENT_REFERENCE_ADAPTER_VERSION,
      inputMediaMaxSeconds: maxSeconds,
      reasonCodes: [
        ...((video.durationMs ?? 0) > (maxSeconds ?? Number.POSITIVE_INFINITY) * 1000
          ? (["PER_FILE_DURATION"] as const)
          : []),
        ...(videos.length > (limits.maxVideos ?? Number.POSITIVE_INFINITY)
          ? (["VIDEO_COUNT"] as const)
          : []),
        ...(maxSeconds !== undefined &&
        normalized
          .filter((item) => item.type === "video" || item.type === "audio")
          .reduce((sum, item) => sum + (item.durationMs ?? 0), 0) >
          maxSeconds * 1000
          ? (["TOTAL_MEDIA_DURATION"] as const)
          : [])
      ],
      derived
    });
    warnings.push(
      video.originalFilename +
        "（" +
        (info.durationMs / 1000).toFixed(1) +
        " 秒）已按当前模型输入限制转换为 " +
        derived.length +
        " 张关键帧；原视频不修改。关键帧保留外观/场景参考，但不等同完整动作或原视频音频。"
    );
  }

  const effective: AgentMaterial[] = [];
  for (const material of normalized.sort((a, b) => a.priority - b.priority)) {
    const frames = replacement.get(material.artifactId);
    if (frames) effective.push(...frames);
    else effective.push(material);
  }
  const prioritized = effective.map((item, priority) => ({ ...item, priority }));
  const effectiveCounts = materialCounts(prioritized);
  if (
    limits.maxImages !== undefined &&
    effectiveCounts.images + effectiveCounts.logos > limits.maxImages
  ) {
    missingRequirements.push(
      "自动关键帧化后图片数量仍超过当前模型上限 " +
        limits.maxImages +
        "。"
    );
  }
  if (
    limits.maxTotalInputs !== undefined &&
    prioritized.length > limits.maxTotalInputs
  ) {
    missingRequirements.push(
      "自动关键帧化后总参考素材仍超过当前模型上限 " +
        limits.maxTotalInputs +
        "。"
    );
  }
  if (maxSeconds !== undefined) {
    const mediaSeconds =
      prioritized
        .filter((item) => item.type === "video" || item.type === "audio")
        .reduce((sum, item) => sum + (item.durationMs ?? 0), 0) / 1000;
    if (mediaSeconds > maxSeconds) {
      missingRequirements.push(
        "自动关键帧化后视频/音频参考总时长仍为 " +
          mediaSeconds.toFixed(1) +
          " 秒，超过当前模型 " +
          maxSeconds +
          " 秒上限。"
      );
    }
  }

  return {
    materials: prioritized,
    adaptations,
    warnings,
    missingRequirements: [...new Set(missingRequirements)]
  };
}
