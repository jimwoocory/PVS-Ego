import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../src/application/ports/artifact-repository.js";
import type {
  ArtifactRecord,
  AssetRef
} from "../src/domain/schemas.js";
import {
  P0_MIN_REFERENCE_IMAGE_EDGE_PX,
  validateReferenceImagesForPreflight
} from "../src/adapters/media/reference-image-validator.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import { ISO } from "./fixtures.js";

class MemoryArtifactRepository implements ArtifactRepository {
  constructor(private readonly record: ArtifactRecord) {}
  async createPending(_input: PendingArtifactInput): Promise<ArtifactRecord> {
    throw new Error("not used");
  }
  async markReady(): Promise<ArtifactRecord> {
    throw new Error("not used");
  }
  async markMissing(): Promise<ArtifactRecord> {
    throw new Error("not used");
  }
  async markCorrupt(): Promise<ArtifactRecord> {
    throw new Error("not used");
  }
  async findById(id: string): Promise<ArtifactRecord | null> {
    return id === this.record.id ? this.record : null;
  }
  async listByProject(): Promise<ArtifactRecord[]> {
    return [this.record];
  }
  async listPending(): Promise<ArtifactRecord[]> {
    return [];
  }
}

test("1x1 placeholder PNG is blocked before paid Preflight", async () => {
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-image-validator-")
  );
  const projectId = "project-image-validator";
  const relativePath = "input/assets/placeholder.png";
  const absolutePath = path.join(projectsRoot, projectId, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVJYAAAAASUVORK5CYII=",
    "base64"
  );
  await fs.writeFile(absolutePath, bytes);
  const sha256 = sha256Bytes(bytes);

  const asset: AssetRef = {
    id: "asset-placeholder",
    artifactId: "artifact-placeholder",
    type: "image",
    source: "user_upload",
    originalFilename: "placeholder.png",
    sha256,
    mimeType: "image/png",
    sizeBytes: bytes.length,
    provenance: "test",
    createdAt: ISO
  };
  const artifact: ArtifactRecord = {
    id: "artifact-placeholder",
    projectId,
    kind: "USER_INPUT",
    relativePath,
    sha256,
    sizeBytes: bytes.length,
    mimeType: "image/png",
    integrityStatus: "READY",
    immutable: true,
    createdAt: ISO
  };

  try {
    const result = await validateReferenceImagesForPreflight({
      projectsRoot,
      projectId,
      snapshot: {
        id: "input-1",
        projectId,
        version: 1,
        productName: "Placeholder product",
        featureDescription: "test",
        assets: [asset],
        forbiddenChanges: [],
        contentHash: "a".repeat(64),
        createdAt: ISO
      },
      artifacts: new MemoryArtifactRepository(artifact),
      requiredAssetIds: [asset.id]
    });

    assert.equal(P0_MIN_REFERENCE_IMAGE_EDGE_PX, 64);
    assert.deepEqual(result.validations[0] && {
      width: result.validations[0].width,
      height: result.validations[0].height
    }, { width: 1, height: 1 });
    assert.equal(result.blockers.length, 1);
    assert.match(
      result.blockers[0]!,
      /^REFERENCE_IMAGE_TOO_SMALL:asset-placeholder:1x1$/
    );
  } finally {
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
