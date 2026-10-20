import type { PrismaClient } from "@prisma/client";
import type { RenderExecution } from "../../domain/render-execution.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { TimelineRepository } from "../../application/ports/timeline-repository.js";
import {
  renderConfigSchema,
  renderJobSchema,
  timelineSchema,
  type RenderJob,
  type Timeline
} from "../../domain/schemas.js";

type TimelineRow = {
  id: string;
  projectId: string;
  version: number;
  status: string;
  productionPlanHash: string;
  contentHash: string;
  dataJson: string;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
};

type RenderJobRow = {
  id: string;
  projectId: string;
  timelineId: string;
  timelineHash: string;
  status: string;
  inputArtifactIdsJson: string;
  inputArtifactHashesJson: string;
  renderConfigJson: string;
  outputArtifactId: string | null;
  outputArtifactHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

function timelineToDomain(row: TimelineRow): Timeline {
  const parsed = timelineSchema.parse(JSON.parse(row.dataJson));
  return timelineSchema.parse({
    ...parsed,
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    status: row.status,
    productionPlanHash: row.productionPlanHash,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.confirmedAt
      ? { confirmedAt: row.confirmedAt.toISOString() }
      : { confirmedAt: undefined })
  });
}

function renderJobToDomain(row: RenderJobRow): RenderJob {
  return renderJobSchema.parse({
    id: row.id,
    projectId: row.projectId,
    timelineId: row.timelineId,
    timelineHash: row.timelineHash,
    status: row.status,
    inputArtifactIds: JSON.parse(row.inputArtifactIdsJson),
    inputArtifactHashes: JSON.parse(row.inputArtifactHashesJson),
    renderConfig: renderConfigSchema.parse(JSON.parse(row.renderConfigJson)),
    ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}),
    ...(row.outputArtifactHash ? { outputArtifactHash: row.outputArtifactHash } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {})
  });
}

export class PrismaTimelineRepository implements TimelineRepository {
  constructor(private readonly db: PrismaClient) {}

  async getRenderExecution(renderJobId: string): Promise<RenderExecution | null> {
    const rows = await this.db.$queryRaw<Array<{
      renderJobId: string; projectId: string; ownerToken: string; ownerPid: number | bigint;
      childPid: number | bigint | null; phase: RenderExecution["phase"];
      startedAt: Date | string; updatedAt: Date | string; dataJson: string;
    }>>`SELECT * FROM "RenderExecutionRecord" WHERE "renderJobId"=${renderJobId}`;
    const row = rows[0];
    return row ? {
      renderJobId: row.renderJobId, projectId: row.projectId, ownerToken: row.ownerToken,
      ownerPid: Number(row.ownerPid), ...(row.childPid !== null ? { childPid: Number(row.childPid) } : {}),
      phase: row.phase, startedAt: new Date(row.startedAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
      data: JSON.parse(row.dataJson)
    } : null;
  }

  async claimRenderExecution(value: RenderExecution, previousOwnerToken?: string): Promise<boolean> {
    return this.db.$transaction(async tx => {
      if (previousOwnerToken) {
        const changed = await tx.$executeRaw`UPDATE "RenderExecutionRecord" SET
          "ownerToken"=${value.ownerToken}, "ownerPid"=${value.ownerPid}, "childPid"=NULL,
          "phase"='RECOVERING', "updatedAt"=${new Date(value.updatedAt)}, "dataJson"=${JSON.stringify(value.data)}
          WHERE "renderJobId"=${value.renderJobId} AND "projectId"=${value.projectId}
          AND "ownerToken"=${previousOwnerToken} AND "phase" NOT IN ('COMPLETED','FAILED')
          AND EXISTS (SELECT 1 FROM "RenderJobRecord" WHERE "id"=${value.renderJobId} AND "status"='RENDERING')`;
        return changed === 1;
      }
      const active = await tx.$queryRaw<Array<{ count: number | bigint }>>`SELECT COUNT(*) AS "count" FROM "RenderExecutionRecord"
        WHERE "renderJobId"=${value.renderJobId} AND "phase" NOT IN ('COMPLETED','FAILED')`;
      if (Number(active[0]?.count ?? 0) > 0) return false;
      const changed = await tx.$executeRaw`UPDATE "RenderJobRecord" SET "status"='RENDERING',
        "startedAt"=${new Date(value.startedAt)}, "completedAt"=NULL, "errorCode"=NULL, "errorMessage"=NULL
        WHERE "id"=${value.renderJobId} AND "projectId"=${value.projectId} AND "status" IN ('QUEUED','FAILED')
        AND NOT EXISTS (SELECT 1 FROM "RenderJobRecord" WHERE "projectId"=${value.projectId} AND "status"='RENDERING')`;
      if (changed !== 1) return false;
      await tx.$executeRaw`INSERT INTO "RenderExecutionRecord"
        ("renderJobId","projectId","ownerToken","ownerPid","childPid","phase","startedAt","updatedAt","dataJson")
        VALUES (${value.renderJobId},${value.projectId},${value.ownerToken},${value.ownerPid},NULL,${value.phase},${new Date(value.startedAt)},${new Date(value.updatedAt)},${JSON.stringify(value.data)})
        ON CONFLICT("renderJobId") DO UPDATE SET "ownerToken"=excluded."ownerToken", "ownerPid"=excluded."ownerPid",
        "childPid"=NULL, "phase"=excluded."phase", "startedAt"=excluded."startedAt", "updatedAt"=excluded."updatedAt", "dataJson"=excluded."dataJson"`;
      return true;
    });
  }

  async updateRenderExecution(value: RenderExecution): Promise<boolean> {
    const changed = await this.db.$executeRaw`UPDATE "RenderExecutionRecord" SET
      "childPid"=${value.childPid ?? null}, "phase"=${value.phase}, "updatedAt"=${new Date(value.updatedAt)}, "dataJson"=${JSON.stringify(value.data)}
      WHERE "renderJobId"=${value.renderJobId} AND "ownerToken"=${value.ownerToken}
      AND "phase" NOT IN ('COMPLETED','FAILED')`;
    return changed === 1;
  }

  async finishRenderExecution(renderJobId: string, ownerToken: string, result: {
    status: "SUCCEEDED" | "FAILED"; outputArtifactId?: string; outputArtifactHash?: string;
    errorCode?: string; errorMessage?: string; completedAt: string;
  }): Promise<RenderJob | null> {
    const finished = await this.db.$transaction(async tx => {
      const changed = await tx.$executeRaw`UPDATE "RenderExecutionRecord" SET
        "phase"=${result.status === "SUCCEEDED" ? "COMPLETED" : "FAILED"}, "updatedAt"=${new Date(result.completedAt)}
        WHERE "renderJobId"=${renderJobId} AND "ownerToken"=${ownerToken} AND "phase" NOT IN ('COMPLETED','FAILED')`;
      if (changed !== 1) return false;
      const jobChanged = await tx.$executeRaw`UPDATE "RenderJobRecord" SET "status"=${result.status},
        "outputArtifactId"=${result.outputArtifactId ?? null}, "outputArtifactHash"=${result.outputArtifactHash ?? null},
        "errorCode"=${result.errorCode ?? null}, "errorMessage"=${result.errorMessage ?? null}, "completedAt"=${new Date(result.completedAt)}
        WHERE "id"=${renderJobId} AND "status"='RENDERING'`;
      if (jobChanged !== 1) throw new DomainValidationError("渲染状态已变化，不能写入旧执行结果");
      return true;
    });
    if (!finished) return null;
    const row = await this.db.renderJobRecord.findUnique({ where: { id: renderJobId } });
    return row ? renderJobToDomain(row) : null;
  }

  async installAutoTimeline(input: Timeline, expected: { id: string; hash: string; status: string } | null): Promise<Timeline> {
    const valid = timelineSchema.parse(input);
    return this.db.$transaction(async tx => {
      const project = await tx.project.findUnique({ where: { id: valid.projectId } });
      if (project?.currentProductionPlanHash !== valid.productionPlanHash) {
        throw new DomainValidationError("导演方案已变化，自动剪辑不能覆盖当前时间线");
      }
      const current = await tx.timelineRecord.findFirst({ where: { projectId: valid.projectId }, orderBy: [{ version: "desc" }, { updatedAt: "desc" }] });
      if (current?.id === valid.id && current.contentHash === valid.contentHash && current.status !== "STALE") return timelineToDomain(current);
      if ((current?.id ?? null) !== (expected?.id ?? null) || (current && (current.contentHash !== expected?.hash || current.status !== expected?.status))) {
        throw new DomainValidationError("时间线已被其他操作修改，自动剪辑不会覆盖新编辑");
      }
      if (await tx.renderJobRecord.count({ where: { projectId: valid.projectId, status: "RENDERING" } })) {
        throw new DomainValidationError("本项目正在渲染，不能替换时间线");
      }
      const last = await tx.timelineRecord.findFirst({ where: { projectId: valid.projectId }, orderBy: { version: "desc" } });
      const installed = timelineSchema.parse({ ...valid, version: (last?.version ?? 0) + 1 });
      await tx.timelineRecord.updateMany({ where: { projectId: valid.projectId, status: { not: "STALE" } }, data: { status: "STALE" } });
      const row = await tx.timelineRecord.create({ data: {
        id: installed.id, projectId: installed.projectId, version: installed.version, status: installed.status,
        productionPlanHash: installed.productionPlanHash, contentHash: installed.contentHash, dataJson: JSON.stringify(installed),
        createdAt: new Date(installed.createdAt), updatedAt: new Date(installed.updatedAt), confirmedAt: null
      } });
      return timelineToDomain(row);
    });
  }

  async nextTimelineVersion(projectId: string): Promise<number> {
    const row = await this.db.timelineRecord.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    return (row?.version ?? 0) + 1;
  }

  async saveTimeline(timeline: Timeline): Promise<Timeline> {
    const valid = timelineSchema.parse(timeline);
    const row = await this.db.timelineRecord.upsert({
      where: { id: valid.id },
      create: {
        id: valid.id,
        projectId: valid.projectId,
        version: valid.version,
        status: valid.status,
        productionPlanHash: valid.productionPlanHash,
        contentHash: valid.contentHash,
        dataJson: JSON.stringify(valid),
        createdAt: new Date(valid.createdAt),
        updatedAt: new Date(valid.updatedAt),
        confirmedAt: valid.confirmedAt ? new Date(valid.confirmedAt) : null
      },
      update: {
        status: valid.status,
        productionPlanHash: valid.productionPlanHash,
        contentHash: valid.contentHash,
        dataJson: JSON.stringify(valid),
        updatedAt: new Date(valid.updatedAt),
        confirmedAt: valid.confirmedAt ? new Date(valid.confirmedAt) : null
      }
    });
    return timelineToDomain(row);
  }

  async findTimelineById(id: string): Promise<Timeline | null> {
    const row = await this.db.timelineRecord.findUnique({ where: { id } });
    return row ? timelineToDomain(row) : null;
  }

  async latestTimeline(projectId: string): Promise<Timeline | null> {
    const row = await this.db.timelineRecord.findFirst({
      where: { projectId },
      orderBy: [{ version: "desc" }, { updatedAt: "desc" }]
    });
    return row ? timelineToDomain(row) : null;
  }

  async markTimelinesStale(projectId: string, exceptId?: string): Promise<void> {
    await this.db.timelineRecord.updateMany({
      where: {
        projectId,
        status: { not: "STALE" },
        ...(exceptId ? { id: { not: exceptId } } : {})
      },
      data: { status: "STALE" }
    });
  }

  async createRenderJob(job: RenderJob): Promise<RenderJob> {
    const valid = renderJobSchema.parse(job);
    const row = await this.db.renderJobRecord.create({
      data: {
        id: valid.id,
        projectId: valid.projectId,
        timelineId: valid.timelineId,
        timelineHash: valid.timelineHash,
        status: valid.status,
        inputArtifactIdsJson: JSON.stringify(valid.inputArtifactIds),
        inputArtifactHashesJson: JSON.stringify(valid.inputArtifactHashes),
        renderConfigJson: JSON.stringify(valid.renderConfig),
        outputArtifactId: valid.outputArtifactId,
        outputArtifactHash: valid.outputArtifactHash,
        errorCode: valid.errorCode,
        errorMessage: valid.errorMessage,
        createdAt: new Date(valid.createdAt),
        startedAt: valid.startedAt ? new Date(valid.startedAt) : null,
        completedAt: valid.completedAt ? new Date(valid.completedAt) : null
      }
    });
    return renderJobToDomain(row);
  }

  async updateRenderJob(
    id: string,
    update: Partial<
      Pick<
        RenderJob,
        | "status"
        | "outputArtifactId"
        | "outputArtifactHash"
        | "errorCode"
        | "errorMessage"
        | "startedAt"
        | "completedAt"
      >
    >
  ): Promise<RenderJob> {
    const row = await this.db.renderJobRecord.update({
      where: { id },
      data: {
        ...(update.status ? { status: update.status } : {}),
        ...(update.outputArtifactId !== undefined
          ? { outputArtifactId: update.outputArtifactId }
          : {}),
        ...(update.outputArtifactHash !== undefined
          ? { outputArtifactHash: update.outputArtifactHash }
          : {}),
        ...(update.status === "RENDERING" || update.status === "SUCCEEDED"
          ? { errorCode: null, errorMessage: null }
          : {
              ...(update.errorCode !== undefined
                ? { errorCode: update.errorCode }
                : {}),
              ...(update.errorMessage !== undefined
                ? { errorMessage: update.errorMessage }
                : {})
            }),
        ...(update.startedAt !== undefined
          ? { startedAt: update.startedAt ? new Date(update.startedAt) : null }
          : {}),
        ...(update.completedAt !== undefined
          ? { completedAt: update.completedAt ? new Date(update.completedAt) : null }
          : {})
      }
    });
    return renderJobToDomain(row);
  }

  async latestRenderJob(projectId: string): Promise<RenderJob | null> {
    const row = await this.db.renderJobRecord.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return row ? renderJobToDomain(row) : null;
  }

  async listRenderJobs(projectId: string): Promise<RenderJob[]> {
    const rows = await this.db.renderJobRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(renderJobToDomain);
  }
}
