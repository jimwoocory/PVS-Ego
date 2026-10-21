import type { PrismaClient } from "@prisma/client";
import type { ReferenceVideoRepository } from "../../application/ports/reference-video-repository.js";
import {
  referenceVideoProfileSchema,
  type ReferenceVideoProfile
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

function readRow(row: {id:string;projectId:string;version:number;status:string;videoArtifactId:string;videoArtifactHash:string;contentHash:string;dataJson:string}):ReferenceVideoProfile {
  const parsed=referenceVideoProfileSchema.parse(JSON.parse(row.dataJson));
  if(row.id!==parsed.id||row.projectId!==parsed.projectId||row.version!==parsed.version||row.videoArtifactId!==parsed.videoArtifactId||row.videoArtifactHash!==parsed.videoArtifactHash||row.contentHash!==parsed.contentHash||row.status==="ACTIVE"&&parsed.status!=="ACTIVE")throw new DomainValidationError("参考视频数据库记录与分析内容绑定不一致");
  if(row.status==="ACTIVE"&&parsed.observation?.version==="reference-observation-v3"){
    const {contentHash,...body}=parsed;
    if(hashValue(body)!==contentHash)throw new DomainValidationError("参考视频数据库分析哈希已失效");
  }
  return row.status==="STALE"?{...parsed,status:"STALE"}:parsed;
}

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
    return row ? readRow(row) : null;
  }

  async listProfiles(projectId: string): Promise<ReferenceVideoProfile[]> {
    const rows = await this.prisma.referenceVideoProfileRecord.findMany({
      where: { projectId },
      orderBy: { version: "desc" }
    });
    return rows.map(readRow);
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
