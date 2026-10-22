import { randomUUID } from "node:crypto";
import type { DouyinCollectionRepository } from "../ports/douyin-collection-repository.js";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import { DouyinCommentService, DouyinCommentCursorError } from "./douyin-comment-service.js";
import { douyinCollectionStartSchema, douyinCollectionRunSchema, type DouyinCollectionRun, type DouyinCollectionStart } from "../../domain/douyin-collection.js";
import { DomainValidationError } from "../../domain/validation.js";
import { hashValue } from "../../domain/hashing.js";
import {DouyinOpsRuntimeError} from "../ports/douyin-ops-runtime.js";

const leaseUntil = () => new Date(Date.now() + 180_000).toISOString();

/** Explicit bounded read jobs. Each completed page has a durable cursor; retries never create extra comment records. */
export class DouyinCollectionService {
  constructor(private readonly runs: DouyinCollectionRepository,
    private readonly ops: DouyinOpsRepository, private readonly comments: DouyinCommentService) {}

  private async scope(run: Pick<DouyinCollectionRun, "projectId" | "bindingId" | "awemeId" | "parentCid">) {
    const binding = await this.ops.findWorkBindingById(run.bindingId);
    if (!binding || binding.projectId !== run.projectId || binding.status !== "BOUND" || binding.awemeId !== run.awemeId) {
      throw new DomainValidationError("采集绑定已变化或不属于当前项目，不能继续原采集任务");
    }
    if (run.parentCid) {
      const parent = await this.ops.findComment({ awemeId: run.awemeId, cid: run.parentCid });
      if (!parent || parent.projectId !== run.projectId || parent.bindingId !== run.bindingId || parent.parentCid) {
        throw new DomainValidationError("楼中楼采集必须使用当前项目、作品绑定下已保存的顶层评论");
      }
    }
    return binding;
  }

  async start(raw: DouyinCollectionStart, beforeReadOrPersist?:()=>Promise<void>,writeFence?:import("../ports/operations-write-fence.js").OperationsWriteFence): Promise<DouyinCollectionRun> {
    const input = douyinCollectionStartSchema.parse(raw);
    const binding = input.bindingId ? await this.ops.findWorkBindingById(input.bindingId)
      : await this.ops.latestWorkBinding(input.projectId, { preferBound: true });
    if (!binding?.awemeId || binding.projectId !== input.projectId || binding.status !== "BOUND" ||
        (input.awemeId && input.awemeId !== binding.awemeId)) {
      throw new DomainValidationError("请先确认当前项目的抖音作品绑定");
    }
    const opsAccountUid=await this.comments.accountForBinding(binding);
    const options = { projectId: input.projectId, bindingId: binding.id, awemeId: binding.awemeId,opsAccountUid,
      kind: input.kind, ...(input.parentCid ? { parentCid: input.parentCid } : {}),
      pageSize: input.pageSize, batchPages: input.batchPages };
    await this.scope(options);
    const now = new Date().toISOString();
    const created = await this.runs.create(douyinCollectionRunSchema.parse({ ...options,
      id: randomUUID(), requestKey: input.requestKey, inputHash: hashValue(options),
      status: "QUEUED", cursor: "0", pages: 0, syncedCount: 0, hasMore: true,
      partial: false, truncated: false, revision: 1, visitedCursors: ["0"], retryable: true,
      createdAt: now, updatedAt: now }));
    // A repeated request key returns its checkpoint, never schedules a second batch.
    return created.created ? this.advance({ projectId: input.projectId, runId: created.run.id,beforeReadOrPersist,writeFence }) : created.run;
  }

  async get(projectId: string, runId: string) { return this.runs.get(projectId, runId); }
  async list(projectId: string) { return this.runs.list(projectId); }
  async findByRequestKey(projectId:string,key:string){
    if(!this.runs.findByRequestKey)throw new DomainValidationError("缺少原采集请求查询能力，不自动重建任务");
    return this.runs.findByRequestKey(projectId,key);
  }
  async resumeAfterHuman(input:{projectId:string;runId:string;expectedRevision:number;opsAccountUid:string}){
    const run=await this.runs.get(input.projectId,input.runId);
    if(!run||run.revision!==input.expectedRevision||run.opsAccountUid!==input.opsAccountUid)throw new DomainValidationError("原采集范围或版本已变化");
    const binding=await this.scope(run);
    if(await this.comments.accountForBinding(binding)!==input.opsAccountUid||!this.runs.resumeAfterHuman)throw new DomainValidationError("原采集账号或续接能力不可核验");
    const result=await this.runs.resumeAfterHuman(input.projectId,run.id,run.revision,new Date().toISOString());
    if(!result)throw new DomainValidationError("原采集暂不可续接，请重新核对最新版本");
    return result;
  }

  async advance(input: { projectId: string; runId: string; beforeReadOrPersist?:()=>Promise<void>;writeFence?:import("../ports/operations-write-fence.js").OperationsWriteFence }): Promise<DouyinCollectionRun> {
    let run = await this.runs.get(input.projectId, input.runId);
    if (!run) throw new DomainValidationError("当前项目中找不到采集任务");
    if (run.status === "COMPLETED" || (run.status === "BLOCKED" && !run.retryable)) return run;
    const owner = randomUUID();
    const claimed = await this.runs.claim({ projectId: run.projectId, id: run.id, revision: run.revision,
      owner, now: new Date().toISOString(), until: leaseUntil() });
    if (!claimed) {
      const current = await this.runs.get(run.projectId, run.id);
      if (!current) throw new DomainValidationError("采集任务已移除");
      return current;
    }
    run = claimed;
    try {
      for (let page = 0; page < run.batchPages && run.hasMore; page++) {
        await input.beforeReadOrPersist?.();
        const binding=await this.scope(run);
        if(!run.opsAccountUid||binding.opsAccountUid!==run.opsAccountUid)throw new DomainValidationError("采集任务缺少原账号 UID 或绑定已变化；保留游标，不自动重绑");
        const request = { projectId: run.projectId, bindingId: run.bindingId, awemeId: run.awemeId,
          cursor: run.cursor, maxPages: 1, pageSize: run.pageSize,writeFence:input.writeFence,beforePersist:async()=>{await input.beforeReadOrPersist?.();const latest=await this.runs.get(run!.projectId,run!.id);if(!latest||latest.revision!==run!.revision||Date.parse(latest.leaseExpiresAt??"")<=Date.now())throw new DomainValidationError("采集租约或版本已变化，旧执行器不得写入评论");} };
        const result = run.parentCid ? await this.comments.syncReplies({ ...request, cid: run.parentCid })
          : await this.comments.syncComments(request);
        const cyclic = result.hasMore && run.visitedCursors.includes(result.cursor);
        const ranks={VISIBLE:0,UNKNOWN:1,PARTIAL:2,NOT_VISIBLE:3},currentCoverage=run.coverage??{status:"VISIBLE" as const,truncated:false},pageCoverage=result.coverage??{status:"UNKNOWN" as const,truncated:false};
        const coverage={...(ranks[pageCoverage.status]>=ranks[currentCoverage.status]?pageCoverage:currentCoverage),truncated:currentCoverage.truncated||pageCoverage.truncated};
        run = await this.runs.checkpoint({ ...run, cursor: cyclic ? run.cursor : result.cursor,
          pages: run.pages + result.pages, syncedCount: await this.runs.countSaved(run), hasMore: result.hasMore,
          status: cyclic ? "BLOCKED" : result.hasMore ? "PARTIAL" : "COMPLETED",
          partial:result.hasMore||coverage.status!=="VISIBLE"||coverage.truncated, truncated: result.hasMore||coverage.truncated, retryable: !cyclic,
          coverage,observedAt:result.observedAt,
          errorCode: cyclic ? "CURSOR_STALLED" : undefined,
          errorMessage: cyclic ? "平台游标重复或循环，已停止；请核对后新建采集任务" : undefined,
          visitedCursors: cyclic ? run.visitedCursors : [...run.visitedCursors, result.cursor].slice(-1000)
        }, owner, leaseUntil());
        if (cyclic) break;
      }
      return run;
    } catch (error) {
      const cursorError = error instanceof DouyinCommentCursorError;
      run = await this.runs.checkpoint({ ...run, status: "BLOCKED", retryable: !(error instanceof DomainValidationError)&&!(error instanceof DouyinOpsRuntimeError&&["AUTH_REQUIRED","RISK_CONTROL"].includes(error.code)),
        pages: run.pages + (cursorError ? error.result.pages : 0),
        syncedCount: await this.runs.countSaved(run), partial: true, truncated: run.hasMore,
        errorCode: cursorError ? "CURSOR_STALLED" : error instanceof DouyinOpsRuntimeError?error.code:error instanceof DomainValidationError ? "SCOPE_OR_DATA_INVALID" : "READ_FAILED",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "采集暂时中断，可从已保存游标继续"
      }, owner, leaseUntil());
      return run;
    } finally { await this.runs.release(run.projectId, run.id, owner); }
  }
}
