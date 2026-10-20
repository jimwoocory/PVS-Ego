import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ArtifactRecord, GenerationAttempt } from "../../domain/schemas.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { actualClipObservationSchema, type ActualClipObservation } from "./clip-continuity-engine.js";

const run = promisify(execFile);

/**
 * Real last-frame evidence: a newly created immutable image from the actual
 * MP4, not the model's expected closing frame or a user-supplied replacement.
 * Creation never marks the video as visually approved.
 */
export async function captureActualClipTailFrame(input: {
  projectId: string;
  projectsRoot: string;
  attempt: Pick<GenerationAttempt, "id" | "clipId" | "projectId" | "outputArtifactId">;
  videoArtifact: Pick<ArtifactRecord, "id" | "projectId" | "relativePath" | "sha256" | "integrityStatus">;
  artifacts: ArtifactRepository;
  ffmpeg?: string;
}): Promise<{ observation: ActualClipObservation; evidenceArtifactId: string }> {
  const { projectId, attempt, videoArtifact, projectsRoot, artifacts } = input;
  if (attempt.projectId !== projectId || videoArtifact.projectId !== projectId ||
      attempt.outputArtifactId !== videoArtifact.id ||
      videoArtifact.integrityStatus !== "READY" || !videoArtifact.sha256) {
    throw new DomainValidationError("实际尾帧必须来自同一项目已下载并验证的正式视频产物。");
  }
  const root = path.resolve(projectsRoot, projectId);
  const imageRel = `continuity/${encodeURIComponent(attempt.clipId)}/${encodeURIComponent(attempt.id)}-last.png`;
  const evidenceRel = `continuity/${encodeURIComponent(attempt.clipId)}/${encodeURIComponent(attempt.id)}-observation.json`;
  const store = new LocalArtifactStore(root, artifacts);
  const ready = await artifacts.listByProject(projectId);
  const existingImage = ready.find(a => a.relativePath.replaceAll("\\", "/") === imageRel && a.integrityStatus === "READY");
  const existingEvidence = ready.find(a => a.relativePath.replaceAll("\\", "/") === evidenceRel && a.integrityStatus === "READY");
  if (existingEvidence) {
    const sourcePath = path.resolve(root, videoArtifact.relativePath);
    if (!sourcePath.startsWith(root + path.sep) ||
        sha256Bytes(await fs.readFile(sourcePath)) !== videoArtifact.sha256) {
      throw new DomainValidationError("原视频已更改，不能复用旧尾帧证据。");
    }
    const evidenceFile = path.resolve(root, evidenceRel);
    const evidenceBytes = await fs.readFile(evidenceFile);
    if (sha256Bytes(evidenceBytes) !== existingEvidence.sha256) {
      throw new DomainValidationError("尾帧状态证据哈希与不可变记录不一致。");
    }
    if (!existingImage?.sha256 ||
        sha256Bytes(await fs.readFile(path.resolve(root,imageRel))) !== existingImage.sha256) {
      throw new DomainValidationError("尾帧图片文件与不可变记录哈希不一致。");
    }
    const loaded = actualClipObservationSchema.parse(JSON.parse(evidenceBytes.toString("utf8")));
    if (loaded.clipId !== attempt.clipId || loaded.generationAttemptId !== attempt.id ||
        loaded.mediaSha256 !== videoArtifact.sha256 ||
        loaded.tailFrameArtifactId !== existingImage?.id ||
        loaded.tailFrameSha256 !== existingImage.sha256) {
      throw new DomainValidationError("旧尾帧记录与当前已生成视频不匹配，禁止继承。");
    }
    return { observation: loaded, evidenceArtifactId: existingEvidence.id };
  }
  const videoPath = path.resolve(root, videoArtifact.relativePath);
  if (!videoPath.startsWith(root + path.sep)) {
    throw new DomainValidationError("实际视频路径超出当前项目根目录。");
  }
  const bytes = await fs.readFile(videoPath);
  if (sha256Bytes(bytes) !== videoArtifact.sha256) {
    throw new DomainValidationError("实际视频内容哈希与已登记产物不一致。");
  }
  const media = await inspectMedia(videoPath);
  if (!media.hasVideo || media.durationMs <= 0) {
    throw new DomainValidationError("实际视频缺少可提取尾帧的视频轨。");
  }
  const timestampMs = Math.max(0, media.durationMs - Math.min(120, Math.round(media.durationMs / 10)));
  let image = existingImage;
  if (!image) {
    const temporary = path.join(root, ".tmp", "tail-" + randomUUID() + ".png");
    await fs.mkdir(path.dirname(temporary), { recursive: true });
    try {
      await run(input.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", videoPath,
        "-ss", (timestampMs / 1000).toFixed(3),
        "-frames:v", "1", "-c:v", "png", "-threads", "1", "-y", temporary
      ], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const png = await fs.readFile(temporary);
      if (!png.length) throw new DomainValidationError("视频尾帧提取结果为空。");
      image = await store.writeImmutable({ id: randomUUID(), projectId,
        kind: "OTHER", relativePath: imageRel, immutable: true, bytes: png,
        mimeType: "image/png" });
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  if (!image.sha256) throw new DomainValidationError("尾帧图片缺少完整性哈希。");
  if (existingImage &&
      sha256Bytes(await fs.readFile(path.resolve(root,imageRel))) !== image.sha256) {
    throw new DomainValidationError("旧尾帧图片内容已更改，禁止继承。");
  }
  const observation = actualClipObservationSchema.parse({
    version: "actual-clip-observation-1",
    clipId: attempt.clipId,
    generationAttemptId: attempt.id,
    mediaSha256: videoArtifact.sha256,
    tailFrameArtifactId: image.id,
    tailFrameSha256: image.sha256,
    tailFrameTimestampMs: timestampMs,
    analysisStatus: "PENDING",
    actorObservations: [],
    propObservations: []
  });
  const evidence = await store.writeImmutable({ id: randomUUID(), projectId,
    kind: "STRUCTURED_SNAPSHOT", relativePath: evidenceRel, immutable: true,
    bytes: Buffer.from(JSON.stringify(observation), "utf8"),
    mimeType: "application/json" });
  return { observation, evidenceArtifactId: evidence.id };
}
