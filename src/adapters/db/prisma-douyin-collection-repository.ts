import { Prisma, type PrismaClient } from "@prisma/client";
import type { DouyinCollectionRepository } from "../../application/ports/douyin-collection-repository.js";
import { douyinCollectionRunSchema, type DouyinCollectionRun } from "../../domain/douyin-collection.js";
import { DomainValidationError } from "../../domain/validation.js";

type Row = { runJson: string };
const parse = (row: Row) => douyinCollectionRunSchema.parse(JSON.parse(row.runJson));

/** Raw SQL lets migrations be applied without replacing the in-use Prisma engine DLL. */
export class PrismaDouyinCollectionRepository implements DouyinCollectionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: DouyinCollectionRun) {
    const run = douyinCollectionRunSchema.parse(input);
    return this.db.$transaction(async tx => {
      const count = await tx.$executeRaw`INSERT INTO "DouyinCollectionRunRecord"
        ("id","projectId","bindingId","awemeId","parentCid","requestKey","inputHash","status","revision","runJson","createdAt","updatedAt")
        VALUES (${run.id},${run.projectId},${run.bindingId},${run.awemeId},${run.parentCid ?? null},${run.requestKey},${run.inputHash},${run.status},${run.revision},${JSON.stringify(run)},${new Date(run.createdAt)},${new Date(run.updatedAt)})
        ON CONFLICT("projectId","requestKey") DO NOTHING`;
      const rows = await tx.$queryRaw<Row[]>`SELECT "runJson" FROM "DouyinCollectionRunRecord"
        WHERE "projectId"=${run.projectId} AND "requestKey"=${run.requestKey}`;
      if (!rows[0]) throw new Error("Collection checkpoint missing after creation");
      const stored = parse(rows[0]);
      if (stored.inputHash !== run.inputHash) throw new DomainValidationError("同一采集请求标识不能用于不同作品、评论或采集设置");
      return { run: stored, created: count === 1 };
    });
  }

  async get(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "runJson" FROM "DouyinCollectionRunRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
    return rows[0] ? parse(rows[0]) : null;
  }

  async list(projectId: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "runJson" FROM "DouyinCollectionRunRecord"
      WHERE "projectId"=${projectId} ORDER BY "createdAt" DESC, "id" DESC LIMIT 100`;
    return rows.map(parse);
  }

  async claim(input: { projectId: string; id: string; revision: number; owner: string; now: string; until: string }) {
    return this.db.$transaction(async tx => {
      const count = await tx.$executeRaw`UPDATE "DouyinCollectionRunRecord"
        SET "leaseOwner"=${input.owner}, "leaseExpiresAt"=${new Date(input.until)}
        WHERE "projectId"=${input.projectId} AND "id"=${input.id} AND "revision"=${input.revision}
        AND "status" IN ('QUEUED','PARTIAL','BLOCKED','RUNNING')
        AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= ${new Date(input.now)})`;
      if (count !== 1) return null;
      const rows = await tx.$queryRaw<Row[]>`SELECT "runJson" FROM "DouyinCollectionRunRecord" WHERE "id"=${input.id}`;
      const run = douyinCollectionRunSchema.parse({ ...parse(rows[0]!), status: "RUNNING", revision: input.revision + 1,
        leaseExpiresAt: input.until, updatedAt: input.now });
      await tx.$executeRaw`UPDATE "DouyinCollectionRunRecord" SET "runJson"=${JSON.stringify(run)}, "status"='RUNNING',
        "revision"=${run.revision}, "updatedAt"=${new Date(input.now)} WHERE "id"=${input.id} AND "leaseOwner"=${input.owner}`;
      return run;
    });
  }

  async checkpoint(input: DouyinCollectionRun, owner: string, until: string) {
    const run = douyinCollectionRunSchema.parse({ ...input, revision: input.revision + 1,
      leaseExpiresAt: until, updatedAt: new Date().toISOString() });
    const count = await this.db.$executeRaw`UPDATE "DouyinCollectionRunRecord"
      SET "runJson"=${JSON.stringify(run)}, "status"=${run.status}, "revision"=${run.revision},
      "leaseExpiresAt"=${new Date(until)}, "updatedAt"=${new Date(run.updatedAt)}
      WHERE "id"=${run.id} AND "projectId"=${run.projectId} AND "revision"=${input.revision}
      AND "leaseOwner"=${owner} AND "leaseExpiresAt">${new Date(run.updatedAt)}`;
    if (count !== 1) throw new DomainValidationError("采集执行权已转移，旧执行器已停止；请读取持久进度后继续");
    return run;
  }

  async release(projectId: string, id: string, owner: string) {
    await this.db.$executeRaw`UPDATE "DouyinCollectionRunRecord" SET "leaseOwner"=NULL, "leaseExpiresAt"=NULL
      WHERE "projectId"=${projectId} AND "id"=${id} AND "leaseOwner"=${owner}`;
  }

  async countSaved(input: { projectId: string; bindingId: string; awemeId: string; parentCid?: string }) {
    const rows = await this.db.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`SELECT COUNT(*) AS "count" FROM "DouyinCommentRecord"
      WHERE "projectId"=${input.projectId} AND "bindingId"=${input.bindingId} AND "awemeId"=${input.awemeId}
      AND ${input.parentCid ? Prisma.sql`"parentCid"=${input.parentCid}` : Prisma.sql`"parentCid" IS NULL`}`);
    return Number(rows[0]?.count ?? 0);
  }
}
