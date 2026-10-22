import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ReferenceVideoProfile } from "../../domain/schemas.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { generateStructuredJson, type StructuredAiRuntime } from "../ports/structured-ai-runtime.js";

export type ReferenceVideoEvidenceVerifier = (profile: ReferenceVideoProfile, projectId: string) => Promise<void>;

export function evidenceDenied(): never {
  throw new DomainValidationError("参考视频证据或当前版本已失效，停止复用；不自动修复、重新分析或切换模型");
}

/** Verify persisted bytes, including aliases and metadata, without repairing them. */
export async function readReferenceEvidence(repo: ArtifactRepository, projectsRoot: string,
  projectId: string, id: string, sha256: string, mimeTypes: string[], maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  try {
    const root = path.resolve(projectsRoot), project = path.resolve(root, projectId);
    if (path.dirname(project) !== root || project === root) evidenceDenied();
    const artifact = await repo.findById(id);
    if (!artifact || artifact.projectId !== projectId || artifact.integrityStatus !== "READY" ||
        artifact.sha256 !== sha256 || !artifact.immutable || !mimeTypes.includes(artifact.mimeType ?? "") ||
        !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes! <= 0 || artifact.sizeBytes! > maxBytes ||
        path.isAbsolute(artifact.relativePath)) evidenceDenied();
    const file = path.resolve(project, artifact.relativePath), rel = path.relative(project, file);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) evidenceDenied();
    // Reject junctions/symlinks even if their present destination happens to be inside the project.
    for (let cursor = file; cursor !== root; cursor = path.dirname(cursor)) {
      if ((await fs.lstat(cursor)).isSymbolicLink()) evidenceDenied();
    }
    if (await fs.realpath(project) !== project || await fs.realpath(file) !== file) evidenceDenied();
    const before = await fs.stat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size !== artifact.sizeBytes) evidenceDenied();
    const bytes = await fs.readFile(file), after = await fs.stat(file);
    if (!after.isFile() || after.nlink !== 1 || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || bytes.length !== artifact.sizeBytes || sha256Bytes(bytes) !== sha256) evidenceDenied();
    if (artifact.mimeType === "image/jpeg" && !(bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217)) evidenceDenied();
    if (artifact.mimeType?.startsWith("video/") && bytes.subarray(4, 8).toString() !== "ftyp") evidenceDenied();
    return bytes;
  } catch { return evidenceDenied(); }
}

export function samplingManifest(projectId: string, source: {artifactId: string; sha256: string},
  media: ReferenceVideoProfile["media"], frames: NonNullable<ReferenceVideoProfile["observation"]>["frames"]) {
  return {version: "reference-sampling-manifest-v1", projectId, source, media, frames,
    timing: {status: "DECODED_FRAME_PTS", origin: "FIRST_VIDEO_FRAME", precisionMs: 1},
    audio: {status: media.hasAudio ? "NOT_OBSERVED" : "NO_TRACK"}, samplingIsPartial: true};
}

/** Every initial/correction request and its response must still have current file-backed evidence. */
export function referenceVideoEvidenceRuntime(runtime: StructuredAiRuntime, profile: ReferenceVideoProfile | null | undefined,
  projectId: string, verify?: ReferenceVideoEvidenceVerifier): StructuredAiRuntime {
  if (!profile) return runtime;
  const check = () => assertCurrentReferenceVideoEvidence(profile,projectId,verify);
  const generate: StructuredAiRuntime["generateJsonWithMetadata"] = async request => {
    await check();
    const result = await generateStructuredJson(runtime, request);
    await check();
    return result;
  };
  return {id: runtime.id, version: runtime.version, generateJsonWithMetadata: generate,
    async generateJson(request) { return (await generate(request)).data; }};
}

export async function assertCurrentReferenceVideoEvidence(profile:ReferenceVideoProfile|null|undefined,projectId:string,verify?:ReferenceVideoEvidenceVerifier):Promise<void>{
  if(!profile)return;
  if(profile.status!=="ACTIVE"||profile.projectId!==projectId||profile.observation?.version!=="reference-observation-v3"||!profile.observation.samplingManifest||!verify)evidenceDenied();
  await verify(profile,projectId);
}

export function sameEvidence(a: unknown, b: unknown): boolean { return hashValue(a) === hashValue(b); }
