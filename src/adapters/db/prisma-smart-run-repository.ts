import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { SmartRunRepository, SmartWorkerPageQuery } from "../../application/ports/smart-run-repository.js";
import { closedSmartStatuses, runnableSmartStatuses, smartRunSchema, type SmartGenerationRun, type SmartRunStatus } from "../../domain/smart-generation.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

type DataRow = { dataJson: string };
function decode(row: DataRow): SmartGenerationRun { return smartRunSchema.parse(JSON.parse(row.dataJson)); }

/** Parameterized SQL keeps the additive store usable without replacing a running Windows Prisma engine. */
export class PrismaSmartRunRepository implements SmartRunRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(projectId: string, runId: string): Promise<SmartGenerationRun | null> {
    const rows = await this.db.$queryRaw<DataRow[]>`SELECT "dataJson" FROM "SmartGenerationRunRecord" WHERE "id"=${runId} AND "projectId"=${projectId}`;
    return rows[0] ? decode(rows[0]) : null;
  }
  async findByRequestKey(projectId: string, requestKey: string): Promise<SmartGenerationRun | null> {
    const rows = await this.db.$queryRaw<DataRow[]>`SELECT "dataJson" FROM "SmartGenerationRunRecord" WHERE "projectId"=${projectId} AND "requestKey"=${requestKey}`;
    return rows[0] ? decode(rows[0]) : null;
  }
  async list(projectId?: string, statuses?: SmartRunStatus[]): Promise<SmartGenerationRun[]> {
    if (statuses?.length === 0) return [];
    const where = [Prisma.sql`1=1`];
    if (projectId !== undefined) where.push(Prisma.sql`"projectId"=${projectId}`);
    if (statuses) where.push(Prisma.sql`"status" IN (${Prisma.join(statuses)})`);
    const rows = await this.db.$queryRaw<DataRow[]>(Prisma.sql`SELECT "dataJson" FROM "SmartGenerationRunRecord" WHERE ${Prisma.join(where, " AND ")} ORDER BY "createdAt" DESC LIMIT 200`);
    return rows.map(decode);
  }

  /** Worker index: eligibility precedes the bound; stable keyset rotation avoids starvation. */
  async listWorkerPage(query:SmartWorkerPageQuery){
    // A process may die after saving a human-wait status but before releasing
    // its lease. Keep that recovery candidate without advancing the human gate.
    const where=[Prisma.sql`("status" IN (${Prisma.join(runnableSmartStatuses)}) OR "leaseOwner" IS NOT NULL)`];
    if(query.afterId)where.push(Prisma.sql`"id">${query.afterId}`);
    if(query.mode==="MANAGED"){
      const granted=Prisma.sql`(json_extract("dataJson",'$.autoAdvanceGrant.projectId')="projectId" AND json_extract("dataJson",'$.autoAdvanceGrant.runId')="id")`;
      where.push(query.legacyScope?Prisma.sql`(${granted} OR ("projectId"=${query.legacyScope.projectId} AND "id"=${query.legacyScope.runId}))`:granted);
    }
    const rows=await this.db.$queryRaw<Array<DataRow&{id:string}>>(Prisma.sql`SELECT "id","dataJson" FROM "SmartGenerationRunRecord" WHERE ${Prisma.join(where," AND ")} ORDER BY "id" ASC LIMIT 30`);
    return {runs:rows.map(decode),...(rows.length===30?{nextAfterId:rows.at(-1)!.id}:{})};
  }

  async create(raw: SmartGenerationRun): Promise<SmartGenerationRun> {
    const run = smartRunSchema.parse(raw);
    const existing = await this.findByRequestKey(run.projectId, run.requestKey);
    if (existing) {
      if (existing.inputHash !== run.inputHash) throw new DomainValidationError("同一创建请求不能更换输入；请使用新的任务请求编号");
      return existing;
    }
    const json = JSON.stringify(run);
    const active = closedSmartStatuses.includes(run.status) ? null : run.projectId;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "SmartGenerationRunRecord"
          ("id","projectId","requestKey","activeProjectKey","status","revision","inputHash","dataJson","createdAt","updatedAt")
          VALUES (${run.id},${run.projectId},${run.requestKey},${active},${run.status},${run.revision},${run.inputHash},${json},${run.createdAt},${run.updatedAt})`;
        await tx.$executeRaw`INSERT INTO "SmartGenerationCheckpointRecord" ("id","runId","revision","contentHash","dataJson","createdAt")
          VALUES (${randomUUID()},${run.id},${run.revision},${hashValue(run)},${json},${run.updatedAt})`;
      });
      return run;
    } catch (error) {
      const raced = await this.findByRequestKey(run.projectId, run.requestKey);
      if (raced && raced.inputHash === run.inputHash) return raced;
      const activeRuns = (await this.list(run.projectId)).filter((item) => !closedSmartStatuses.includes(item.status));
      if (activeRuns.length) throw new DomainValidationError("本项目已有未结束的一键成片任务，请继续原任务或明确取消后再创建");
      throw error;
    }
  }

  async save(raw: SmartGenerationRun, expectedRevision: number, leaseOwner: string): Promise<SmartGenerationRun> {
    const run = smartRunSchema.parse({ ...raw, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
    const dataJson = JSON.stringify(run);
    const active = closedSmartStatuses.includes(run.status) ? null : run.projectId;
    await this.db.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "SmartGenerationRunRecord" SET
        "status"=${run.status}, "revision"=${run.revision}, "dataJson"=${dataJson}, "updatedAt"=${run.updatedAt}, "activeProjectKey"=${active}
        WHERE "id"=${run.id} AND "projectId"=${run.projectId} AND "revision"=${expectedRevision}
        AND "inputHash"=${run.inputHash} AND "leaseOwner"=${leaseOwner}`;
      if (changed !== 1) throw new DomainValidationError("任务已被更新或执行锁失效，旧检查点不得覆盖新进度");
      await tx.$executeRaw`INSERT INTO "SmartGenerationCheckpointRecord" ("id","runId","revision","contentHash","dataJson","createdAt")
        VALUES (${randomUUID()},${run.id},${run.revision},${hashValue(run)},${dataJson},${run.updatedAt})`;
    });
    return run;
  }

  async acquire(projectId: string, runId: string, owner: string, pid: number): Promise<boolean> {
    const count = await this.db.$executeRaw`UPDATE "SmartGenerationRunRecord" SET "leaseOwner"=${owner}, "leasePid"=${pid}
      WHERE "id"=${runId} AND "projectId"=${projectId} AND "leaseOwner" IS NULL`;
    return count === 1;
  }
  async release(projectId: string, runId: string, owner: string): Promise<void> {
    await this.db.$executeRaw`UPDATE "SmartGenerationRunRecord" SET "leaseOwner"=NULL, "leasePid"=NULL
      WHERE "id"=${runId} AND "projectId"=${projectId} AND "leaseOwner"=${owner}`;
  }
  async lease(projectId: string, runId: string): Promise<{ owner: string; pid: number } | null> {
    const rows = await this.db.$queryRaw<Array<{ leaseOwner: string | null; leasePid: number | bigint | null }>>`
      SELECT "leaseOwner","leasePid" FROM "SmartGenerationRunRecord" WHERE "id"=${runId} AND "projectId"=${projectId}`;
    const row = rows[0];
    return row?.leaseOwner && row.leasePid !== null ? { owner: row.leaseOwner, pid: Number(row.leasePid) } : null;
  }
  async releaseAbandoned(projectId: string, runId: string, previousOwner: string): Promise<void> {
    // Caller must establish that the owning OS process is gone; no TTL-based lock stealing.
    await this.release(projectId, runId, previousOwner);
  }
}
