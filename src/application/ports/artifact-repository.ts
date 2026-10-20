import type { ArtifactRecord } from "../../domain/schemas.js";

export type PendingArtifactInput = Omit<
  ArtifactRecord,
  "sha256" | "sizeBytes" | "mimeType" | "integrityStatus" | "createdAt"
> & {
  mimeType?: string;
};

export interface ArtifactRepository {
  createPending(input: PendingArtifactInput): Promise<ArtifactRecord>;
  markReady(
    id: string,
    fields: { sha256: string; sizeBytes: number; mimeType?: string }
  ): Promise<ArtifactRecord>;
  markMissing(id: string): Promise<ArtifactRecord>;
  markCorrupt(id: string): Promise<ArtifactRecord>;
  findById(id: string): Promise<ArtifactRecord | null>;
  listByProject(projectId: string, kind?: ArtifactRecord["kind"]): Promise<ArtifactRecord[]>;
  listPending(): Promise<ArtifactRecord[]>;
}
