import type { PrismaClient } from "@prisma/client";
import type { DouyinOperationsScheduleRepository } from "../../application/ports/douyin-operations-schedule-repository.js";
import { operationsScheduleSchema, type DouyinOperationsSchedule } from "../../domain/douyin-operations-schedule.js";
import { DomainValidationError } from "../../domain/validation.js";

type Row = { dataJson: string };
const parse = (row: Row) => operationsScheduleSchema.parse(JSON.parse(row.dataJson));

export class PrismaDouyinOperationsScheduleRepository implements DouyinOperationsScheduleRepository {
  constructor(private readonly db: PrismaClient) {}
  async create(raw: DouyinOperationsSchedule) {
    const run = operationsScheduleSchema.parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "DouyinOperationsScheduleRecord"
        ("id","projectId","requestKey","inputHash","status","revision","nextAt","dataJson","createdAt","updatedAt")
        VALUES (${run.id},${run.input.projectId},${run.input.requestKey},${run.inputHash},${run.status},${run.revision},${new Date(run.nextAt)},${JSON.stringify(run)},${new Date(run.createdAt)},${new Date(run.updatedAt)})
        ON CONFLICT("projectId","requestKey") DO NOTHING`;
      const rows = await tx.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord"
        WHERE "projectId"=${run.input.projectId} AND "requestKey"=${run.input.requestKey}`;
      const stored = rows[0] ? parse(rows[0]) : null;
      if (!stored || stored.inputHash !== run.inputHash) throw new DomainValidationError("同一调度请求不能更换账号、作品或采集计划");
      return stored;
    });
  }
  async get(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
    return rows[0] ? parse(rows[0]) : null;
  }
  async list(projectId: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord" WHERE "projectId"=${projectId} ORDER BY "createdAt" DESC LIMIT 100`;
    return rows.map(parse);
  }
  async due(now: string, limit: number) {
    const count = Math.max(1, Math.min(10, Math.trunc(limit)));
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord"
      WHERE "status" IN ('SCHEDULED','RUNNING') AND "nextAt"<=${new Date(now)}
      AND ("leaseOwner" IS NULL OR "leaseExpiresAt"<=${new Date(now)}) ORDER BY "nextAt" ASC LIMIT ${count}`;
    return rows.map(parse);
  }
  async claim(projectId: string, id: string, revision: number, owner: string, now: string, until: string) {
    return this.db.$transaction(async tx => {
      const changed = await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "leaseOwner"=${owner}, "leaseExpiresAt"=${new Date(until)}
        WHERE "id"=${id} AND "projectId"=${projectId} AND "revision"=${revision} AND "status" IN ('SCHEDULED','RUNNING')
        AND "nextAt"<=${new Date(now)} AND ("leaseOwner" IS NULL OR "leaseExpiresAt"<=${new Date(now)})`;
      if (changed !== 1) return null;
      const rows = await tx.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id}`;
      const run = operationsScheduleSchema.parse({ ...parse(rows[0]!), revision: revision + 1, status: "RUNNING", updatedAt: now });
      await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "revision"=${run.revision}, "status"='RUNNING', "dataJson"=${JSON.stringify(run)}, "updatedAt"=${new Date(now)} WHERE "id"=${id} AND "leaseOwner"=${owner}`;
      return run;
    });
  }
  async save(input: DouyinOperationsSchedule, owner: string, until: string) {
    const run = operationsScheduleSchema.parse({ ...input, revision: input.revision + 1 });
    const changed = await this.db.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "revision"=${run.revision}, "status"=${run.status},
      "dataJson"=${JSON.stringify(run)}, "nextAt"=${new Date(run.nextAt)}, "updatedAt"=${new Date(run.updatedAt)}, "leaseExpiresAt"=${new Date(until)}
      WHERE "id"=${run.id} AND "projectId"=${run.input.projectId} AND "revision"=${input.revision} AND "leaseOwner"=${owner} AND "leaseExpiresAt">${new Date(run.updatedAt)}`;
    if (changed !== 1) throw new DomainValidationError("运营调度执行权已变化，旧执行器停止写入");
    return run;
  }
  async pause(projectId: string, id: string, expectedRevision: number, now: string) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Row[]>`SELECT "dataJson" FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
      if (!rows[0]) return null;
      const old = parse(rows[0]);
      if (old.revision !== expectedRevision) return null;
      const run = operationsScheduleSchema.parse({ ...old, revision: old.revision + 1, status: "PAUSED", updatedAt: now });
      const changed = await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "revision"=${run.revision}, "status"='PAUSED', "dataJson"=${JSON.stringify(run)},
        "updatedAt"=${new Date(now)}, "leaseOwner"=NULL, "leaseExpiresAt"=NULL WHERE "id"=${id} AND "projectId"=${projectId} AND "revision"=${expectedRevision}`;
      return changed === 1 ? run : null;
    });
  }
  async release(projectId: string, id: string, owner: string) {
    await this.db.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "leaseOwner"=NULL, "leaseExpiresAt"=NULL WHERE "id"=${id} AND "projectId"=${projectId} AND "leaseOwner"=${owner}`;
  }
}
