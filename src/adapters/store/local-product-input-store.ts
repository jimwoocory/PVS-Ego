import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactRepository } from "../../application/ports/artifact-repository.js";
import type {
  ProductInputSnapshot,
  ProductInputStore
} from "../../application/ports/product-input-store.js";
import { LocalArtifactStore } from "./local-artifact-store.js";
import {
  assetRefSchema,
  forbiddenChangeSchema,
  isoDateTimeSchema,
  sha256Schema
} from "../../domain/schemas.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";

const productInputSnapshotSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  version: z.number().int().positive(),
  productName: z.string().trim().min(1),
  featureDescription: z.string().trim().min(1),
  brand: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  assets: z.array(assetRefSchema).min(1),
  forbiddenChanges: z.array(forbiddenChangeSchema),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
});

export class LocalProductInputStore implements ProductInputStore {
  constructor(
    private readonly projectsRoot: string,
    private readonly artifacts: ArtifactRepository
  ) {}

  private projectRoot(projectId: string): string {
    return path.join(this.projectsRoot, projectId);
  }

  async save(
    input: Omit<ProductInputSnapshot, "id" | "version" | "contentHash" | "createdAt">
  ): Promise<ProductInputSnapshot> {
    if (!input.assets.some((asset) => asset.type === "image")) {
      throw new Error("Product Input requires at least one image AssetRef");
    }
    const previous = await this.latest(input.projectId);
    const id = randomUUID();
    const version = (previous?.version ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const base = {
      id,
      projectId: input.projectId,
      version,
      productName: input.productName.trim(),
      featureDescription: input.featureDescription.trim(),
      ...(input.brand?.trim() ? { brand: input.brand.trim() } : {}),
      ...(input.category?.trim() ? { category: input.category.trim() } : {}),
      assets: input.assets,
      forbiddenChanges: input.forbiddenChanges,
      createdAt
    };
    const snapshot = productInputSnapshotSchema.parse({
      ...base,
      contentHash: hashValue(base)
    });

    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    const artifactStore = new LocalArtifactStore(
      this.projectRoot(input.projectId),
      this.artifacts
    );
    await artifactStore.writeImmutable({
      id: randomUUID(),
      projectId: input.projectId,
      kind: "STRUCTURED_SNAPSHOT",
      relativePath: `input/product-input-v${String(version).padStart(3, "0")}-${snapshot.contentHash.slice(0, 12)}.json`,
      immutable: true,
      bytes,
      mimeType: "application/json"
    });
    return snapshot;
  }

  async latest(projectId: string): Promise<ProductInputSnapshot | null> {
    const records = (await this.artifacts.listByProject(projectId, "STRUCTURED_SNAPSHOT"))
      .filter(
        (item) =>
          item.integrityStatus === "READY" &&
          /^input\/product-input-v\d+-[a-f0-9]+\.json$/i.test(item.relativePath)
      );
    if (!records.length) return null;
    const record = records[records.length - 1]!;
    const absolute = path.join(this.projectRoot(projectId), record.relativePath);
    const bytes = await fs.readFile(absolute);
    if (record.sha256 && sha256Bytes(bytes) !== record.sha256) {
      throw new Error("Product Input snapshot integrity mismatch");
    }
    return productInputSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
  }
}
