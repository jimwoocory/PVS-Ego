import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { Clip, GenerationAttempt, ReviewDecision } from "../../domain/schemas.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { captureActualClipTailFrame } from "./actual-tail-frame-capture.js";
import { reviewAcceptedActualClipObservation, type ActualClipObservation } from "./clip-continuity-engine.js";

export type ReviewedContinuitySource = {
  observation: ActualClipObservation;
  sourceClipId: string;
  sourceAttemptId: string;
  sourceVideoArtifactId: string;
  sourceVideoSha256: string;
  reviewDecisionId: string;
  reviewDecisionHash: string;
  reviewedEvidenceArtifactId: string;
  reviewedEvidenceHash: string;
};

/** Read-only source approval check, except for creating new immutable derived evidence.
 * Never turns a previous AI acceptance into user consent, and never overwrites media. */
export async function loadReviewedContinuitySource(input: {
  projectId: string;
  projectsRoot: string;
  clip: Pick<Clip, "id" | "contentHash">;
  attempts: readonly GenerationAttempt[];
  runAttemptIds: readonly string[];
  decisions: readonly ReviewDecision[];
  artifacts: ArtifactRepository;
}): Promise<ReviewedContinuitySource> {
  const current = [...input.attempts]
    .filter(a => a.projectId === input.projectId && a.clipId === input.clip.id &&
      ["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(a.status))
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!current?.outputArtifactId || !input.runAttemptIds.includes(current.id)) {
    throw new DomainValidationError("当前任务没有已下载且可继承的上一段成功视频。");
  }
  const artifact = await input.artifacts.findById(current.outputArtifactId);
  if (!artifact || artifact.projectId !== input.projectId ||
      artifact.kind !== "GENERATED_VIDEO" || artifact.integrityStatus !== "READY" ||
      !artifact.sha256) {
    throw new DomainValidationError("上一段视频产物尚未通过完整性检查。");
  }
  const lastDecision = [...input.decisions]
    .filter(d => d.projectId === input.projectId && d.clipId === input.clip.id &&
      d.clipHash === input.clip.contentHash)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  if (!lastDecision || lastDecision.source !== "USER" ||
      lastDecision.decision !== "ACCEPT" ||
      lastDecision.generationAttemptId !== current.id ||
      lastDecision.outputArtifactId !== artifact.id ||
      lastDecision.outputArtifactHash !== artifact.sha256) {
    throw new DomainValidationError("上一段尚无针对最新实际视频的人工采用决定，不能继承尾帧。");
  }
  const extracted = await captureActualClipTailFrame({
    projectId: input.projectId, projectsRoot: input.projectsRoot,
    attempt: current, videoArtifact: artifact, artifacts: input.artifacts
  });
  const observation = reviewAcceptedActualClipObservation({
    observation: extracted.observation,
    sourceAttempt: current, sourceArtifact: artifact,
    currentLatestSuccessfulAttemptId: current.id, expectedClipHash: input.clip.contentHash,
    decisions: input.decisions
  });
  const reviewDecisionHash = hashValue(lastDecision);
  const payload = {
    version: "reviewed-continuity-source-1",
    observation,
    projectId: input.projectId,
    reviewDecisionId: lastDecision.id,
    reviewDecisionHash,
    originalEvidenceArtifactId: extracted.evidenceArtifactId
  };
  const relativePath = `continuity/${encodeURIComponent(input.clip.id)}/${encodeURIComponent(current.id)}-accepted-${encodeURIComponent(lastDecision.id)}.json`;
  const root = path.resolve(input.projectsRoot, input.projectId);
  const target = path.resolve(root, relativePath);
  const existing = (await input.artifacts.listByProject(input.projectId))
    .find(a => a.relativePath.replaceAll("\\\\", "/") === relativePath);
  let reviewed;
  if (existing) {
    if (existing.integrityStatus !== "READY" || !existing.sha256) {
      throw new DomainValidationError("已保存的连续性人工审核凭据状态不完整。");
    }
    const bytes = await fs.readFile(target);
    if (sha256Bytes(bytes) !== existing.sha256 ||
        hashValue(JSON.parse(bytes.toString("utf8"))) !== hashValue(payload)) {
      throw new DomainValidationError("已保存的连续性审核凭据发生变化，禁止重新使用。");
    }
    reviewed = existing;
  } else {
    reviewed = await new LocalArtifactStore(root, input.artifacts).writeImmutable({
      id: randomUUID(), projectId: input.projectId, kind: "STRUCTURED_SNAPSHOT",
      relativePath, immutable: true, bytes: Buffer.from(JSON.stringify(payload)),
      mimeType: "application/json"
    });
  }
  if (!reviewed.sha256) throw new DomainValidationError("连续性审核凭据缺少完整性哈希。");
  return {
    observation,
    sourceClipId: input.clip.id,
    sourceAttemptId: current.id,
    sourceVideoArtifactId: artifact.id,
    sourceVideoSha256: artifact.sha256,
    reviewDecisionId: lastDecision.id,
    reviewDecisionHash,
    reviewedEvidenceArtifactId: reviewed.id,
    reviewedEvidenceHash: reviewed.sha256
  };
}
