import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import type { ArtifactRepository } from "../../application/ports/artifact-repository.js";
import type { ProductInputSnapshot } from "../../application/ports/product-input-store.js";
import { sha256Bytes } from "../../domain/hashing.js";
import type {AssetRef} from "../../domain/schemas.js";

export const P0_MIN_REFERENCE_IMAGE_EDGE_PX = 64;

export type ReferenceImageValidation = {
  assetId: string;
  artifactId?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  blocker?: string;
};

export async function validateReferenceImagesForPreflight(input: {
  projectsRoot: string;
  projectId: string;
  snapshot: ProductInputSnapshot;
  artifacts: ArtifactRepository;
  requiredAssetIds: readonly string[];
  confirmedReferenceAssets?: AssetRef[];
}): Promise<{
  blockers: string[];
  validations: ReferenceImageValidation[];
}> {
  const projectRoot = path.resolve(input.projectsRoot, input.projectId);
  const validations: ReferenceImageValidation[] = [];
  const blockers: string[] = [];

  for (const assetId of [...new Set(input.requiredAssetIds)]) {
    const asset = [...input.snapshot.assets,...(input.confirmedReferenceAssets??[])].find((item) => item.id === assetId);
    if (!asset) {
      const blocker = `REFERENCE_ASSET_MISSING:${assetId}`;
      blockers.push(blocker);
      validations.push({ assetId, blocker });
      continue;
    }
    if (asset.type !== "image") {
      const blocker = `REFERENCE_ASSET_NOT_IMAGE:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: asset.artifactId,
        mimeType: asset.mimeType,
        blocker
      });
      continue;
    }

    const artifact = await input.artifacts.findById(asset.artifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256 ||
      artifact.sha256 !== asset.sha256
    ) {
      const blocker = `REFERENCE_ARTIFACT_NOT_READY:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: asset.artifactId,
        mimeType: asset.mimeType,
        blocker
      });
      continue;
    }

    const absolutePath = path.resolve(projectRoot, artifact.relativePath);
    const prefix = projectRoot.endsWith(path.sep)
      ? projectRoot
      : projectRoot + path.sep;
    if (
      absolutePath !== projectRoot &&
      !absolutePath.startsWith(prefix)
    ) {
      const blocker = `REFERENCE_ARTIFACT_PATH_INVALID:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        blocker
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch {
      const blocker = `REFERENCE_ARTIFACT_MISSING:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        blocker
      });
      continue;
    }
    if (sha256Bytes(bytes) !== artifact.sha256) {
      const blocker = `REFERENCE_ARTIFACT_HASH_MISMATCH:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        blocker
      });
      continue;
    }

    try {
      const size = imageSize(bytes);
      const width = size.width;
      const height = size.height;
      if (
        !width ||
        !height ||
        width < P0_MIN_REFERENCE_IMAGE_EDGE_PX ||
        height < P0_MIN_REFERENCE_IMAGE_EDGE_PX
      ) {
        const blocker =
          `REFERENCE_IMAGE_TOO_SMALL:${assetId}:${width ?? 0}x${height ?? 0}`;
        blockers.push(blocker);
        validations.push({
          assetId,
          artifactId: artifact.id,
          width,
          height,
          mimeType: artifact.mimeType,
          blocker
        });
        continue;
      }
      validations.push({
        assetId,
        artifactId: artifact.id,
        width,
        height,
        mimeType: artifact.mimeType
      });
    } catch {
      const blocker = `REFERENCE_IMAGE_DECODE_FAILED:${assetId}`;
      blockers.push(blocker);
      validations.push({
        assetId,
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        blocker
      });
    }
  }

  return { blockers, validations };
}
