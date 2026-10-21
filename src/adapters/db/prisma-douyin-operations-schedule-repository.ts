import type { PrismaClient } from "@prisma/client";
import type { DouyinOperationsScheduleRepository } from "../../application/ports/douyin-operations-schedule-repository.js";
import { operationsScheduleSchema, type DouyinOperationsSchedule } from "../../domain/douyin-operations-schedule.js";
import { DomainValidationError } from "../../domain/validation.js";
import {hashValue} from "../../domain/hashing.js";

type Row = {id:string;projectId:string;requestKey:string;inputHash:string;status:string;revision:number;nextAt:Date;dataJson:string;leaseOwner:string|null;leaseExpiresAt:Date|null};
const parse = (row: Row) => {
  const run=operationsScheduleSchema.parse(JSON.parse(row.dataJson));
  if(row.id!==run.id||row.projectId!==run.input.projectId||row.requestKey!==run.input.requestKey||row.inputHash!==run.inputHash||hashValue(run.input)!==run.inputHash||row.status!==run.status||row.revision!==run.revision||new Date(row.nextAt).toISOString()!==run.nextAt)throw new DomainValidationError("运营计划数据库记录与原范围、版本或时间不一致");
  return run;
};

export class PrismaDouyinOperationsScheduleRepository implements DouyinOperationsScheduleRepository {
  constructor(private readonly db: PrismaClient) {}
  async create(raw: DouyinOperationsSchedule) {
    const run = operationsScheduleSchema.parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "DouyinOperationsScheduleRecord"
        ("id","projectId","requestKey","inputHash","status","revision","nextAt","dataJson","createdAt","updatedAt")
        VALUES (${run.id},${run.input.projectId},${run.input.requestKey},${run.inputHash},${run.status},${run.revision},${new Date(run.nextAt)},${JSON.stringify(run)},${new Date(run.createdAt)},${new Date(run.updatedAt)})
        ON CONFLICT("projectId","requestKey") DO NOTHING`;
      const rows = await tx.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord"
        WHERE "projectId"=${run.input.projectId} AND "requestKey"=${run.input.requestKey}`;
      const stored = rows[0] ? parse(rows[0]) : null;
      if (!stored || stored.inputHash !== run.inputHash) throw new DomainValidationError("同一调度请求不能更换账号、作品或采集计划");
      return stored;
    });
  }
  async get(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
    return rows[0] ? parse(rows[0]) : null;
  }
  async list(projectId: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "projectId"=${projectId} ORDER BY "createdAt" DESC LIMIT 100`;
    return rows.map(parse);
  }
  async due(now: string, limit: number) {
    const count = Math.max(1, Math.min(10, Math.trunc(limit)));
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord"
      WHERE "status" IN ('SCHEDULED','RUNNING') AND "nextAt"<=${new Date(now)}
      AND ("leaseOwner" IS NULL OR "leaseExpiresAt"<=${new Date(now)}) ORDER BY "nextAt" ASC LIMIT ${count}`;
    return rows.map(parse);
  }
  async claim(projectId: string, id: string, revision: number, owner: string, now: string, until: string) {
    return this.db.$transaction(async tx => {
      const before=await tx.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
      if(!before[0]||parse(before[0]).revision!==revision)return null;
      const changed = await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "leaseOwner"=${owner}, "leaseExpiresAt"=${new Date(until)}
        WHERE "id"=${id} AND "projectId"=${projectId} AND "revision"=${revision} AND "status" IN ('SCHEDULED','RUNNING')
        AND "nextAt"<=${new Date(now)} AND ("leaseOwner" IS NULL OR "leaseExpiresAt"<=${new Date(now)})`;
      if (changed !== 1) return null;
      const run = operationsScheduleSchema.parse({ ...parse(before[0]), revision: revision + 1, status: "RUNNING", updatedAt: now });
      await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "revision"=${run.revision}, "status"='RUNNING', "dataJson"=${JSON.stringify(run)}, "updatedAt"=${new Date(now)} WHERE "id"=${id} AND "leaseOwner"=${owner}`;
      return run;
    });
  }
  async save(input: DouyinOperationsSchedule, owner: string, until: string) {
    await this.assertLease(input.input.projectId,input.id,input.revision,owner,input.updatedAt);
    const prior=await this.get(input.input.projectId,input.id);
    if(!prior||prior.inputHash!==input.inputHash||hashValue(input.input)!==prior.inputHash)throw new DomainValidationError("原运营计划范围不可改写");
    const run = operationsScheduleSchema.parse({ ...input, revision: input.revision + 1 });
    const changed = await this.db.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "revision"=${run.revision}, "status"=${run.status},
      "dataJson"=${JSON.stringify(run)}, "nextAt"=${new Date(run.nextAt)}, "updatedAt"=${new Date(run.updatedAt)}, "leaseExpiresAt"=${new Date(until)}
      WHERE "id"=${run.id} AND "projectId"=${run.input.projectId} AND "revision"=${input.revision} AND "leaseOwner"=${owner} AND "leaseExpiresAt">${new Date(run.updatedAt)}`;
    if (changed !== 1) throw new DomainValidationError("运营调度执行权已变化，旧执行器停止写入");
    return run;
  }
  async pause(projectId: string, id: string, expectedRevision: number, now: string) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
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

  async assertLease(projectId:string,id:string,revision:number,owner:string,now:string){
    const rows=await this.db.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
    const row=rows[0];
    if(!row||parse(row).status!=="RUNNING"||row.revision!==revision||row.leaseOwner!==owner||!row.leaseExpiresAt||new Date(row.leaseExpiresAt).getTime()<=Date.parse(now))throw new DomainValidationError("运营计划租约已过期、暂停或执行权改变，旧执行器停止");
  }

  async inspectLease(projectId:string,id:string,now:string){
    const rows=await this.db.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
    if(!rows[0])return null;const row=rows[0],run=parse(row);
    const expiresAt=row.leaseExpiresAt?new Date(row.leaseExpiresAt).toISOString():undefined;
    return {revision:run.revision,state:!row.leaseOwner?"FREE" as const:expiresAt&&Date.parse(expiresAt)>Date.parse(now)?"ACTIVE" as const:"EXPIRED" as const,...(expiresAt?{expiresAt}:{}),checkedAt:now};
  }

  async resume(projectId:string,id:string,revision:number,inputHash:string,now:string){
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Row[]>`SELECT * FROM "DouyinOperationsScheduleRecord" WHERE "id"=${id} AND "projectId"=${projectId}`;
      if(!rows[0])return null;
      const old=parse(rows[0]);
      if(old.revision!==revision||old.inputHash!==inputHash||!["PAUSED","BLOCKED"].includes(old.status))return null;
      const run=operationsScheduleSchema.parse({...old,status:"SCHEDULED",revision:old.revision+1,nextAt:new Date(Math.max(Date.parse(now),Date.parse(old.nextAt))).toISOString(),updatedAt:now,errorCode:undefined,errorMessage:undefined});
      const changed=await tx.$executeRaw`UPDATE "DouyinOperationsScheduleRecord" SET "status"='SCHEDULED',"revision"=${run.revision},"nextAt"=${new Date(run.nextAt)},"updatedAt"=${new Date(now)},"dataJson"=${JSON.stringify(run)},"leaseOwner"=NULL,"leaseExpiresAt"=NULL
        WHERE "id"=${id} AND "projectId"=${projectId} AND "revision"=${revision} AND ("leaseOwner" IS NULL OR "leaseExpiresAt"<=${new Date(now)})`;
      return changed===1?run:null;
    });
  }
}
