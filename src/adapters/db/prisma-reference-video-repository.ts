import type { PrismaClient } from "@prisma/client";
import type { ReferenceVideoRepository } from "../../application/ports/reference-video-repository.js";
import {
  referenceVideoProfileSchema,
  type ReferenceVideoProfile
} from "../../domain/schemas.js";

export class PrismaReferenceVideoRepository
  implements ReferenceVideoRepository
{
  constructor(private readonly prisma: PrismaClient) {}

  async nextVersion(projectId: string): Promise<number> {
    const latest = await this.prisma.referenceVideoProfileRecord.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    return (latest?.version ?? 0) + 1;
  }

  async saveProfile(
    profile: ReferenceVideoProfile
  ): Promise<ReferenceVideoProfile> {
    const parsed = referenceVideoProfileSchema.parse(profile);
    await this.prisma.$transaction(async (tx) => {
      await tx.referenceVideoProfileRecord.updateMany({
        where: {
          projectId: parsed.projectId,
          status: "ACTIVE"
        },
        data: { status: "STALE" }
      });
      await tx.referenceVideoProfileRecord.create({
        data: {
          id: parsed.id,
          projectId: parsed.projectId,
          version: parsed.version,
          status: parsed.status,
          sourceType: parsed.sourceType,
          sourceUrl: parsed.sourceUrl ?? null,
          videoArtifactId: parsed.videoArtifactId,
          videoArtifactHash: parsed.videoArtifactHash,
          contentHash: parsed.contentHash,
          dataJson: JSON.stringify(parsed),
          createdAt: new Date(parsed.createdAt)
        }
      });
    });
    return parsed;
  }

  async latestActive(
    projectId: string
  ): Promise<ReferenceVideoProfile | null> {
    const row = await this.prisma.referenceVideoProfileRecord.findFirst({
      where: { projectId, status: "ACTIVE" },
      orderBy: { version: "desc" }
    });
    return row
      ? referenceVideoProfileSchema.parse(JSON.parse(row.dataJson))
      : null;
  }

  async listProfiles(projectId: string): Promise<ReferenceVideoProfile[]> {
    const rows = await this.prisma.referenceVideoProfileRecord.findMany({
      where: { projectId },
      orderBy: { version: "desc" }
    });
    return rows.map((row) =>
      referenceVideoProfileSchema.parse(
        JSON.parse(
          row.status === "STALE"
            ? JSON.stringify({
                ...JSON.parse(row.dataJson),
                status: "STALE"
              })
            : row.dataJson
        )
      )
    );
  }

  async markActiveProfilesStale(projectId: string): Promise<void> {
    const active = await this.prisma.referenceVideoProfileRecord.findMany({
      where: { projectId, status: "ACTIVE" }
    });
    await this.prisma.$transaction(
      active.map((row) => {
        const data = JSON.parse(row.dataJson) as Record<string, unknown>;
        return this.prisma.referenceVideoProfileRecord.update({
          where: { id: row.id },
          data: {
            status: "STALE",
            dataJson: JSON.stringify({ ...data, status: "STALE" })
          }
        });
      })
    );
  }
}
