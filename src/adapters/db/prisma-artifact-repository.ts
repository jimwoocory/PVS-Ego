import type { PrismaClient } from "@prisma/client";
import type { ArtifactRepository, PendingArtifactInput } from "../../application/ports/artifact-repository.js";
import type { ArtifactRecord } from "../../domain/schemas.js";

function toDomain(row: {
  id: string;
  projectId: string;
  kind: string;
  relativePath: string;
  sha256: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  integrityStatus: string;
  immutable: boolean;
  createdAt: Date;
}): ArtifactRecord {
  if (!row.immutable) throw new Error("Artifact record is not immutable");
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as ArtifactRecord["kind"],
    relativePath: row.relativePath,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    integrityStatus: row.integrityStatus as ArtifactRecord["integrityStatus"],
    immutable: true,
    createdAt: row.createdAt.toISOString()
  };
}

export class PrismaArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: PrismaClient) {}

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    const row = await this.db.artifactRecord.create({
      data: {
        id: input.id,
        projectId: input.projectId,
        kind: input.kind,
        relativePath: input.relativePath,
        mimeType: input.mimeType,
        integrityStatus: "PENDING",
        immutable: true
      }
    });
    return toDomain(row);
  }

  async markReady(id: string, fields: { sha256: string; sizeBytes: number; mimeType?: string }): Promise<ArtifactRecord> {
    const row = await this.db.artifactRecord.update({
      where: { id },
      data: {
        sha256: fields.sha256,
        sizeBytes: fields.sizeBytes,
        ...(fields.mimeType ? { mimeType: fields.mimeType } : {}),
        integrityStatus: "READY"
      }
    });
    return toDomain(row);
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const row = await this.db.artifactRecord.update({
      where: { id },
      data: { integrityStatus: "MISSING" }
    });
    return toDomain(row);
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const row = await this.db.artifactRecord.update({
      where: { id },
      data: { integrityStatus: "CORRUPT" }
    });
    return toDomain(row);
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const row = await this.db.artifactRecord.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByProject(
    projectId: string,
    kind?: ArtifactRecord["kind"]
  ): Promise<ArtifactRecord[]> {
    const rows = await this.db.artifactRecord.findMany({
      where: {
        projectId,
        ...(kind ? { kind } : {})
      },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(toDomain);
  }

  async listPending(): Promise<ArtifactRecord[]> {
    const rows = await this.db.artifactRecord.findMany({ where: { integrityStatus: "PENDING" } });
    return rows.map(toDomain);
  }
}
