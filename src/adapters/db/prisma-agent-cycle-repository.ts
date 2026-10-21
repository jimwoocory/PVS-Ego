import {Prisma,type PrismaClient} from "@prisma/client";
import type { AgentCycleRepository } from "../../application/ports/agent-cycle-repository.js";
import type { AgentCycle } from "../../domain/agent-cycle.js";
import { DomainValidationError } from "../../domain/validation.js";

type Row = {id: string; projectId: string; dataJson: string; leaseOwner: string | null; leasePid: number | null};
const decode = (row: Row): AgentCycle => JSON.parse(row.dataJson) as AgentCycle;

/** Parameterized SQL keeps additive tables usable without replacing a live Prisma engine. */
export class PrismaAgentCycleRepository implements AgentCycleRepository {
  constructor(private readonly db: PrismaClient) {}
  async create(cycle: AgentCycle): Promise<AgentCycle> {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`INSERT OR IGNORE INTO "AgentCycleRecord" (id, projectId, requestKey, inputHash, revision, status, dataJson, createdAt, updatedAt)
        VALUES (${cycle.id}, ${cycle.projectId}, ${cycle.input.requestKey}, ${cycle.inputHash}, ${cycle.revision}, ${cycle.status}, ${JSON.stringify(cycle)}, ${cycle.createdAt}, ${cycle.updatedAt})`;
      const rows = await tx.$queryRaw<Array<Row & {inputHash: string}>>`SELECT * FROM "AgentCycleRecord" WHERE projectId=${cycle.projectId} AND requestKey=${cycle.input.requestKey}`;
      const row = rows[0];
      if (!row || row.inputHash !== cycle.inputHash) throw new DomainValidationError("同一请求编号的目标或约束已经改变，请使用新的请求编号");
      return decode(row);
    });
  }
  async get(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM "AgentCycleRecord" WHERE id=${id} AND projectId=${projectId}`;
    return rows[0] ? decode(rows[0]) : null;
  }
  async list(projectId?: string) {
    const rows = projectId
      ? await this.db.$queryRaw<Row[]>`SELECT * FROM "AgentCycleRecord" WHERE projectId=${projectId} ORDER BY createdAt DESC LIMIT 100`
      : await this.db.$queryRaw<Row[]>`SELECT * FROM "AgentCycleRecord" WHERE status IN ('READY','RUNNING') ORDER BY updatedAt ASC LIMIT 30`;
    return rows.map(decode);
  }
  async listWorkerPage(now:string,afterId?:string){
    const after=afterId?Prisma.sql`AND "id">${afterId}`:Prisma.empty;
    const rows=await this.db.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "AgentCycleRecord" WHERE "status" IN ('READY','RUNNING')
      AND (json_extract("dataJson",'$.nextWakeAt') IS NULL OR json_extract("dataJson",'$.nextWakeAt')<=${now}) ${after} ORDER BY "id" ASC LIMIT 30`);
    return {cycles:rows.map(decode),...(rows.length===30?{nextAfterId:rows.at(-1)!.id}:{})};
  }
  async claim(projectId: string, id: string, owner: string) {
    return (await this.db.$executeRaw`UPDATE "AgentCycleRecord" SET leaseOwner=${owner}, leasePid=${process.pid} WHERE id=${id} AND projectId=${projectId} AND leaseOwner IS NULL`) === 1;
  }
  async save(cycle: AgentCycle, expectedRevision: number, owner: string) {
    const changed = await this.db.$executeRaw`UPDATE "AgentCycleRecord" SET revision=${cycle.revision}, status=${cycle.status}, dataJson=${JSON.stringify(cycle)}, updatedAt=${cycle.updatedAt}
      WHERE id=${cycle.id} AND projectId=${cycle.projectId} AND revision=${expectedRevision} AND leaseOwner=${owner}`;
    if (changed !== 1) throw new DomainValidationError("Agent 任务已被其他操作修改，请刷新后继续");
    return cycle;
  }
  async release(id: string, owner: string) {
    await this.db.$executeRaw`UPDATE "AgentCycleRecord" SET leaseOwner=NULL, leasePid=NULL WHERE id=${id} AND leaseOwner=${owner}`;
  }
  async recoverAbandoned(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM "AgentCycleRecord" WHERE id=${id} AND projectId=${projectId}`;
    const row = rows[0];
    if (!row?.leaseOwner || !row.leasePid) return false;
    try { process.kill(row.leasePid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    return (await this.db.$executeRaw`UPDATE "AgentCycleRecord" SET leaseOwner=NULL, leasePid=NULL WHERE id=${id} AND projectId=${projectId} AND leaseOwner=${row.leaseOwner}`) === 1;
  }
}
