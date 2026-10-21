import type { Prisma, PrismaClient, Project as PrismaProject } from "@prisma/client";
import { projectSchema, type Project } from "../../domain/schemas.js";
import {hashValue} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import type {
  CommitVersionInput,
  ProductFlowRepository,
  ProjectPointerPatch,
  VersionedEntityType
} from "../../application/ports/product-flow-repository.js";

function refFrom(
  entityType: string,
  id: string | null,
  version: number | null,
  hash: string | null
) {
  if (!id || !version || !hash) return undefined;
  return { entityType, entityId: id, version, hash };
}

function toDomain(row: PrismaProject): Project {
  return projectSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    targetPlatform: row.targetPlatform,
    targetDurationMs: row.targetDurationMs,
    aspectRatio: row.aspectRatio,
    currentProductTruthRef: refFrom(
      "ProductTruth",
      row.currentProductTruthId,
      row.currentProductTruthVersion,
      row.currentProductTruthHash
    ),
    currentCreativeBatchRef: refFrom(
      "CreativeBatch",
      row.currentCreativeBatchId,
      row.currentCreativeBatchVersion,
      row.currentCreativeBatchHash
    ),
    ...(row.selectedCreativeId ? { selectedCreativeId: row.selectedCreativeId } : {}),
    currentScriptRef: refFrom(
      "ScriptDraft",
      row.currentScriptId,
      row.currentScriptVersion,
      row.currentScriptHash
    ),
    currentProductionPlanRef: refFrom(
      "ProductionPlan",
      row.currentProductionPlanId,
      row.currentProductionPlanVersion,
      row.currentProductionPlanHash
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function patchData(patch: ProjectPointerPatch): Prisma.ProjectUpdateInput {
  return {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.currentProductTruthRef !== undefined
      ? patch.currentProductTruthRef
        ? {
            currentProductTruthId: patch.currentProductTruthRef.entityId,
            currentProductTruthVersion: patch.currentProductTruthRef.version,
            currentProductTruthHash: patch.currentProductTruthRef.hash
          }
        : {
            currentProductTruthId: null,
            currentProductTruthVersion: null,
            currentProductTruthHash: null
          }
      : {}),
    ...(patch.currentCreativeBatchRef !== undefined
      ? patch.currentCreativeBatchRef
        ? {
            currentCreativeBatchId: patch.currentCreativeBatchRef.entityId,
            currentCreativeBatchVersion: patch.currentCreativeBatchRef.version,
            currentCreativeBatchHash: patch.currentCreativeBatchRef.hash
          }
        : {
            currentCreativeBatchId: null,
            currentCreativeBatchVersion: null,
            currentCreativeBatchHash: null
          }
      : {}),
    ...(patch.selectedCreativeId !== undefined
      ? { selectedCreativeId: patch.selectedCreativeId }
      : {}),
    ...(patch.currentScriptRef !== undefined
      ? patch.currentScriptRef
        ? {
            currentScriptId: patch.currentScriptRef.entityId,
            currentScriptVersion: patch.currentScriptRef.version,
            currentScriptHash: patch.currentScriptRef.hash
          }
        : {
            currentScriptId: null,
            currentScriptVersion: null,
            currentScriptHash: null
          }
      : {}),
    ...(patch.currentProductionPlanRef !== undefined
      ? patch.currentProductionPlanRef
        ? {
            currentProductionPlanId: patch.currentProductionPlanRef.entityId,
            currentProductionPlanVersion: patch.currentProductionPlanRef.version,
            currentProductionPlanHash: patch.currentProductionPlanRef.hash
          }
        : {
            currentProductionPlanId: null,
            currentProductionPlanVersion: null,
            currentProductionPlanHash: null
          }
      : {})
  };
}

export class PrismaProductFlowRepository implements ProductFlowRepository {
  constructor(private readonly db: PrismaClient) {}

  async createProject(projectInput: Project): Promise<Project> {
    const project = projectSchema.parse(projectInput);
    const row = await this.db.project.create({
      data: {
        id: project.id,
        name: project.name,
        status: project.status,
        targetPlatform: project.targetPlatform,
        targetDurationMs: project.targetDurationMs,
        aspectRatio: project.aspectRatio
      }
    });
    return toDomain(row);
  }

  async listProjects(): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      orderBy: { updatedAt: "desc" }
    });
    return rows.map(toDomain);
  }

  async getProject(projectId: string): Promise<Project | null> {
    const row = await this.db.project.findUnique({ where: { id: projectId } });
    return row ? toDomain(row) : null;
  }

  async nextVersion(
    projectId: string,
    entityType: VersionedEntityType,
    entityKey: string
  ): Promise<number> {
    const latest = await this.db.versionedEntity.findFirst({
      where: { projectId, entityType, entityKey },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    return (latest?.version ?? 0) + 1;
  }

  async getVersion<T>(
    projectId: string,
    entityType: VersionedEntityType,
    id: string,
    version: number
  ): Promise<T | null> {
    const row = await this.db.versionedEntity.findFirst({
      where: { projectId, entityType, id, version }
    });
    return row ? (JSON.parse(row.dataJson) as T) : null;
  }

  async getVerifiedVersion<T>(projectId:string,entityType:VersionedEntityType,id:string,version:number):Promise<T|null>{
    const row=await this.db.versionedEntity.findFirst({where:{projectId,entityType,id,version}});if(!row)return null;
    const data=JSON.parse(row.dataJson),{contentHash,...body}=data;
    if(data.id!==row.id||data.projectId!==row.projectId||data.version!==row.version||contentHash!==row.contentHash||hashValue(body)!==row.contentHash)throw new DomainValidationError("保存版本的数据库记录与内容哈希不一致");
    return data as T;
  }

  async commitVersion(input: CommitVersionInput): Promise<Project> {
    return this.db.$transaction(async (tx) => {
      if (input.staleEntityTypes.length) {
        await tx.versionedEntity.updateMany({
          where: {
            projectId: input.version.projectId,
            entityType: { in: [...input.staleEntityTypes] },
            status: { not: "STALE" }
          },
          data: { status: "STALE" }
        });
      }

      await tx.versionedEntity.create({
        data: {
          id: input.version.id,
          projectId: input.version.projectId,
          entityType: input.version.entityType,
          entityKey: input.version.entityKey,
          version: input.version.version,
          status: input.version.status,
          contentHash: input.version.contentHash,
          dataJson: JSON.stringify(input.version.data)
        }
      });

      const row = await tx.project.update({
        where: { id: input.version.projectId },
        data: patchData(input.projectPatch)
      });
      return toDomain(row);
    });
  }

  async commitProjectUpdate(
    projectId: string,
    staleEntityTypes: readonly VersionedEntityType[],
    patch: ProjectPointerPatch
  ): Promise<Project> {
    return this.db.$transaction(async (tx) => {
      if (staleEntityTypes.length) {
        await tx.versionedEntity.updateMany({
          where: {
            projectId,
            entityType: { in: [...staleEntityTypes] },
            status: { not: "STALE" }
          },
          data: { status: "STALE" }
        });
      }
      const row = await tx.project.update({
        where: { id: projectId },
        data: patchData(patch)
      });
      return toDomain(row);
    });
  }
}
