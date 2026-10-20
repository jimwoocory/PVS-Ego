import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CreativeReferenceRepository, ReferenceDecision, ReferencePoolState } from "../../application/ports/creative-reference-repository.js";
import { researchMediaCandidateSchema, creativeReferenceSetSchema, referenceReviewInputSchema, candidateBlockers,
  type ResearchMediaCandidate, type CreativeReferenceSet, type ReferenceReviewInput } from "../../domain/creative-reference.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

type Row = { dataJson: string; contentHash: string };
function checked<T extends {contentHash: string}>(value: T, storedHash?: string): T {
  const {contentHash, ...body} = value;
  if (hashValue(body) !== contentHash || (storedHash !== undefined && contentHash !== storedHash)) throw new DomainValidationError("参考素材记录完整性校验失败");
  return value;
}
function decodeCandidate(row: Row) { return checked(researchMediaCandidateSchema.parse(JSON.parse(row.dataJson)), row.contentHash); }
function decodeSet(row: Row) { return checked(creativeReferenceSetSchema.parse(JSON.parse(row.dataJson)), row.contentHash); }
async function state(db: Prisma.TransactionClient, projectId: string): Promise<ReferencePoolState> {
  const heads = await db.$queryRaw<Array<{revision: number | bigint; setId: string | null}>>`SELECT "revision","setId" FROM "ReferencePoolHead" WHERE "projectId"=${projectId}`;
  const head = heads[0];
  if (!head) return {revision: 0, set: null};
  if (!head.setId) return {revision: Number(head.revision), set: null};
  const sets = await db.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "CreativeReferenceSetRecord" WHERE "id"=${head.setId} AND "projectId"=${projectId}`;
  if (!sets[0]) throw new DomainValidationError("当前参考集合缺失，禁止使用旧指针");
  return {revision: Number(head.revision), set: decodeSet(sets[0])};
}
async function invalidate(tx: Prisma.TransactionClient, projectId: string) {
  const staleAt = new Date();
  const requests=await tx.generationRequestRecord.findMany({where:{projectId},select:{id:true,dataJson:true}});
  const requestIds=requests.filter(r=>!JSON.parse(r.dataJson).agentTaskId).map(r=>r.id);
  await tx.versionedEntity.updateMany({where: {projectId, entityType: {in: ["CreativeBatch","ScriptDraft","ProductionPlan","CompiledPrompt"]}, status: {not:"STALE"}}, data: {status:"STALE"}});
  await tx.generationRequestRecord.updateMany({where:{projectId,id:{in:requestIds},status:"CURRENT"},data:{status:"STALE"}});
  await tx.preflightReportRecord.updateMany({where:{projectId,generationRequestId:{in:requestIds},status:{not:"STALE"}},data:{status:"STALE",staleAt}});
  await tx.userApprovalRecord.updateMany({where:{projectId,generationRequestId:{in:requestIds},status:"ACTIVE"},data:{status:"STALE"}});
  await tx.timelineRecord.updateMany({where:{projectId,status:{not:"STALE"}},data:{status:"STALE"}});
  await tx.finalAssemblyRecord.updateMany({where:{projectId,status:{not:"STALE"}},data:{status:"STALE"}});
  await tx.project.update({where:{id:projectId},data:{status:"CREATIVE_REVIEW",currentCreativeBatchId:null,currentCreativeBatchVersion:null,currentCreativeBatchHash:null,selectedCreativeId:null,currentScriptId:null,currentScriptVersion:null,currentScriptHash:null,currentProductionPlanId:null,currentProductionPlanVersion:null,currentProductionPlanHash:null}});
}

/** Immutable candidates/sets; parameterized SQL avoids regenerating an in-use Windows Prisma engine. */
export class PrismaCreativeReferenceRepository implements CreativeReferenceRepository {
  constructor(private readonly db: PrismaClient) {}
  async candidate(projectId: string, id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "ResearchMediaCandidateRecord" WHERE "projectId"=${projectId} AND "id"=${id}`;
    return rows[0] ? decodeCandidate(rows[0]) : null;
  }
  async findCapture(projectId: string, key: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "ResearchMediaCandidateRecord" WHERE "projectId"=${projectId} AND "captureKey"=${key}`;
    return rows[0] ? decodeCandidate(rows[0]) : null;
  }
  async candidates(projectId: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "ResearchMediaCandidateRecord" WHERE "projectId"=${projectId} ORDER BY "createdAt" DESC,"id" ASC LIMIT 2000`;
    return rows.map(decodeCandidate);
  }
  async addCandidate(raw: ResearchMediaCandidate) {
    const c = checked(researchMediaCandidateSchema.parse(raw));
    const run = await this.db.researchRunRecord.findFirst({where: {id: c.runId, projectId: c.projectId}});
    if (!run) throw new DomainValidationError("素材候选必须属于本项目已有研究任务");
    await this.db.$executeRaw`INSERT INTO "ResearchMediaCandidateRecord" ("id","projectId","runId","captureKey","contentHash","dataJson","createdAt")
      VALUES (${c.id},${c.projectId},${c.runId},${c.captureKey},${c.contentHash},${JSON.stringify(c)},${c.createdAt}) ON CONFLICT("projectId","captureKey") DO NOTHING`;
    return (await this.findCapture(c.projectId, c.captureKey))!;
  }
  state(projectId: string) { return state(this.db, projectId); }
  async decisions(projectId: string): Promise<ReferenceDecision[]> {
    const rows = await this.db.$queryRaw<Array<{revision: number | bigint; dataJson: string}>>`SELECT "revision","dataJson" FROM "ReferenceReviewRecord" WHERE "projectId"=${projectId} ORDER BY "revision" ASC`;
    return rows.flatMap(row => referenceReviewInputSchema.parse(JSON.parse(row.dataJson)).changes.map(c => ({candidateId: c.candidateId, decision: c.decision, version: Number(row.revision)})));
  }
  async confirm(projectId: string, rawSet: CreativeReferenceSet | null, rawInput: ReferenceReviewInput): Promise<ReferencePoolState> {
    const input = referenceReviewInputSchema.parse(rawInput);
    const nextSet = rawSet ? checked(creativeReferenceSetSchema.parse(rawSet)) : null;
    if (new Set(input.changes.map(c => c.candidateId)).size !== input.changes.length) throw new DomainValidationError("一次审核不能包含重复候选");
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "ReferencePoolHead" ("projectId","revision","setId") VALUES (${projectId},0,NULL) ON CONFLICT("projectId") DO NOTHING`;
      const previous = await state(tx, projectId);
      if (previous.revision !== input.expectedRevision) throw new DomainValidationError("素材池已被更新，请刷新后重新审核");
      const project = await tx.project.findUnique({where: {id: projectId}});
      if (!project || project.currentProductTruthHash !== input.expectedTruthHash) throw new DomainValidationError("产品事实已变化，审核没有生效");
      const truth = await tx.versionedEntity.findFirst({where: {projectId, id: project.currentProductTruthId ?? "", entityType: "ProductTruth", status: "CONFIRMED"}});
      if (!truth) throw new DomainValidationError("产品事实尚未确认");
      const expected = new Map((previous.set?.entries ?? []).map(e => [e.candidateId, {hash: e.candidateHash, role: e.role}]));
      for (const change of input.changes) {
        const rows = await tx.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "ResearchMediaCandidateRecord" WHERE "projectId"=${projectId} AND "id"=${change.candidateId}`;
        const candidate = rows[0] ? decodeCandidate(rows[0]) : null;
        if (!candidate || candidate.contentHash !== change.candidateHash) throw new DomainValidationError("审核候选不存在、已变化或属于其他项目");
        if (change.decision === "INCLUDE") {
          if (!change.role || !input.acknowledgeRights || candidate.status !== "REVIEWABLE" || candidate.truthRef?.hash !== input.expectedTruthHash || candidateBlockers(candidate, change.role).length) throw new DomainValidationError("未通过身份、使用规则或使用权检查的候选不能加入参考");
          expected.set(change.candidateId, {hash: change.candidateHash, role: change.role});
        } else expected.delete(change.candidateId);
      }
      if (expected.size !== (nextSet?.entries.length ?? 0) || nextSet?.entries.some(e => expected.get(e.candidateId)?.hash !== e.candidateHash || expected.get(e.candidateId)?.role !== e.role)) throw new DomainValidationError("确认集合不符合本次明确审核范围");
      const setChanged = (nextSet?.contentHash ?? null) !== (previous.set?.contentHash ?? null);
      if (setChanged) {
        if (!nextSet || nextSet.projectId !== projectId || nextSet.truthRef.hash !== input.expectedTruthHash || nextSet.truthRef.entityId !== project.currentProductTruthId ||
            nextSet.version !== (previous.set?.version ?? 0) + 1 || nextSet.previousHash !== (previous.set?.contentHash ?? null)) throw new DomainValidationError("参考集合版本或上游绑定不一致");
        for (const e of nextSet.entries) {
          const rows = await tx.$queryRaw<Row[]>`SELECT "dataJson","contentHash" FROM "ResearchMediaCandidateRecord" WHERE "id"=${e.candidateId} AND "projectId"=${projectId}`;
          const c = rows[0] ? decodeCandidate(rows[0]) : null;
          if (!c || c.status !== "REVIEWABLE" || c.contentHash !== e.candidateHash || c.artifactId !== e.artifactId || c.artifactHash !== e.artifactHash ||
              c.sourceArtifactId !== e.sourceArtifactId || c.sourceArtifactHash !== e.sourceArtifactHash || c.sourceUrl !== e.sourceUrl || c.mediaUrl !== e.mediaUrl || c.timestampMs !== e.timestampMs ||
              c.canonicalImageHash !== nextSet.canonicalImageHash || c.truthRef?.hash !== nextSet.truthRef.hash || candidateBlockers(c,e.role).length) throw new DomainValidationError("参考集合包含失效或不匹配的候选；旧候选需要明确移出或重新分析");
        }
        await tx.$executeRaw`INSERT INTO "CreativeReferenceSetRecord" ("id","projectId","version","contentHash","dataJson","createdAt")
          VALUES (${nextSet.id},${projectId},${nextSet.version},${nextSet.contentHash},${JSON.stringify(nextSet)},${nextSet.createdAt})`;
        await invalidate(tx, projectId);
      }
      const changed = await tx.$executeRaw`UPDATE "ReferencePoolHead" SET "revision"=${previous.revision+1}, "setId"=${nextSet?.id ?? null} WHERE "projectId"=${projectId} AND "revision"=${previous.revision}`;
      if (changed !== 1) throw new DomainValidationError("素材池审核并发冲突，未覆盖其他审核结果");
      await tx.$executeRaw`INSERT INTO "ReferenceReviewRecord" ("id","projectId","revision","dataJson","createdAt") VALUES (${randomUUID()},${projectId},${previous.revision+1},${JSON.stringify(input)},${new Date().toISOString()})`;
      return {revision: previous.revision+1, set: nextSet};
    }, {timeout: 15000});
  }
}
