import type { ArtifactRecord } from "../domain/schemas.js";

function isMediaMime(mimeType?: string): boolean {
  return Boolean(
    mimeType &&
      (mimeType.startsWith("image/") ||
        mimeType.startsWith("video/") ||
        mimeType.startsWith("audio/"))
  );
}

/**
 * Public media route policy. Structured snapshots, logs, prompts and arbitrary
 * OTHER binary files stay non-public; OTHER is allowed only when it is an
 * explicitly typed image/video/audio artifact such as research-reference media
 * or post-production audio.
 */
export function canServeArtifactContent(
  artifact: Pick<ArtifactRecord, "kind" | "mimeType" | "integrityStatus">
): boolean {
  if (artifact.integrityStatus !== "READY") return false;
  if (
    artifact.kind === "GENERATED_VIDEO" ||
    artifact.kind === "FINAL_VIDEO"
  ) {
    return true;
  }
  if (
    artifact.kind === "USER_INPUT" ||
    artifact.kind === "OTHER"
  ) {
    return isMediaMime(artifact.mimeType);
  }
  return false;
}
