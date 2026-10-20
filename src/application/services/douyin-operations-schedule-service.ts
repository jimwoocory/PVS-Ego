import {decideCadence,metricObservation,cadenceStateSchema} from "../../domain/operations-cadence.js";
import { randomUUID } from "node:crypto";
import type { DouyinOperationsScheduleRepository } from "../ports/douyin-operations-schedule-repository.js";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import type { DouyinMetricService } from "./douyin-metric-service.js";
import type { DouyinCollectionService } from "./douyin-collection-service.js";
import { operationsScheduleInputSchema, operationsScheduleSchema, type DouyinOperationsScheduleInput, type DouyinOperationsSchedule } from "../../domain/douyin-operations-schedule.js";
import { DomainValidationError } from "../../domain/validation.js";
import { hashValue } from "../../domain/hashing.js";
import type { DouyinCollectionRun } from "../../domain/douyin-collection.js";
import {DouyinOpsRuntimeError} from "../ports/douyin-ops-runtime.js";

export type OperationsScheduleDependencies = {
  ops: Pick<DouyinOpsRepository, "findWorkBindingById" | "listComments">;
  metrics: Pick<DouyinMetricService, "refresh">;
  collections: Pick<DouyinCollectionService, "start" | "advance" | "get">;
  /** Must return the operations runtime's actual UID, not a nickname or publishing open_id. */
  identity(): Promise<{ uid: string }>;
};

class ScheduleDurationElapsed extends Error {}

/** Bounded read-only observations. A completed scan is not a continuous/full-history guarantee. */
export class DouyinOperationsScheduleService {
  constructor(private readonly repo: DouyinOperationsScheduleRepository, private readonly d: OperationsScheduleDependencies,
    private readonly clock: () => Date = () => new Date()) {}
  private now() { return this.clock().toISOString(); }
  private until() { return new Date(this.clock().getTime() + 180000).toISOString(); }
  private async scope(input: DouyinOperationsSchedule["input"]) {
    const binding = await this.d.ops.findWorkBindingById(input.bindingId);
    if (!binding || binding.projectId !== input.projectId || binding.status !== "BOUND" || binding.awemeId !== input.awemeId) {
      throw new DomainValidationError("原运营计划的项目或作品绑定已变化，已停止，不能静默换作品");
    }
    const account = await this.d.identity();
    if (!account.uid || account.uid === "0" || account.uid !== input.opsAccountUid||binding.opsAccountUid!==input.opsAccountUid) {
      throw new DomainValidationError("运营账号 UID 已变化或无法核验，已停止原计划");
    }
    return binding;
  }
  async create(raw: DouyinOperationsScheduleInput) {
    const input = operationsScheduleInputSchema.parse(raw);
    const binding=await this.scope(input);
    const now = this.now();
    const publicationKnown=Boolean(binding.publishedAt&&Date.parse(binding.publishedAt)<=this.clock().getTime());
    const cadenceState=input.cadence?cadenceStateSchema.parse({version:input.cadence.version,deadlineAt:new Date(Date.parse(input.startAt)+input.cadence.maxDurationSeconds*1000).toISOString(),publicationTime:{source:"WORK_BINDING_AT_CREATE",status:publicationKnown?"KNOWN":"UNKNOWN",...(publicationKnown?{publishedAt:binding.publishedAt}:{})}}):undefined;
    return this.repo.create(operationsScheduleSchema.parse({ id: randomUUID(), input, inputHash: hashValue(input), revision: 1,
      status: "SCHEDULED", ...(cadenceState?{cadenceState}:{}),completedCaptures: 0, nextAt: input.startAt, consecutiveFailures: 0, history: [], createdAt: now, updatedAt: now }));
  }
  get(projectId: string, id: string) { return this.repo.get(projectId, id); }
  list(projectId: string) { return this.repo.list(projectId); }
  due() { return this.repo.due(this.now(), 10); }
  async pause(projectId: string, id: string, expectedRevision: number) {
    const existing = await this.repo.get(projectId, id);
    if (!existing || existing.revision !== expectedRevision) throw new DomainValidationError("运营计划不存在或版本已变化");
    if (existing.status === "COMPLETED") return existing;
    const paused = await this.repo.pause(projectId, id, expectedRevision, this.now());
    if (!paused) throw new DomainValidationError("运营计划已变化，请刷新后暂停");
    return paused;
  }
  private checkCollection(run: DouyinCollectionRun) {
    if (run.status !== "BLOCKED") return;
    if(["AUTH_REQUIRED","RISK_CONTROL"].includes(run.errorCode??""))throw new DouyinOpsRuntimeError(run.errorCode!,"原采集等待人工登录或风控处理，调度暂停，不自动重试");
    if (!run.retryable) throw new DomainValidationError(run.errorMessage ?? "原采集已被阻断，需核对原作品与游标");
    throw new Error(run.errorMessage ?? "原采集暂时失败，将有界退避重试");
  }
  async tick(projectId: string, id: string): Promise<DouyinOperationsSchedule> {
    const existing = await this.repo.get(projectId, id);
    if (!existing) throw new DomainValidationError("当前项目中找不到运营计划");
    if (!["SCHEDULED", "RUNNING"].includes(existing.status) || Date.parse(existing.nextAt) > this.clock().getTime()) return existing;
    const owner = randomUUID();
    const claimed = await this.repo.claim(projectId, id, existing.revision, owner, this.now(), this.until());
    if (!claimed) return (await this.repo.get(projectId, id))!;
    let run: DouyinOperationsSchedule = claimed;
    const assertLease=async()=>{const current=await this.repo.get(projectId,id);if(!current||current.status==="PAUSED"||current.revision!==run.revision)throw new DomainValidationError("运营计划已暂停或执行权改变，停止后续读取");};
    const assertWindow=()=>{
      if(!run.input.cadence)return;
      const expected=new Date(Date.parse(run.input.startAt)+run.input.cadence.maxDurationSeconds*1000).toISOString();
      if(!run.cadenceState||run.cadenceState.version!==run.input.cadence.version||run.cadenceState.deadlineAt!==expected)throw new DomainValidationError("调度策略或原观察时间上限缺失/变化，不能自动扩大计划");
      if(this.clock().getTime()>=Date.parse(run.cadenceState.deadlineAt))throw new ScheduleDurationElapsed("观察时间上限已到，停止后续读取");
    };
    const readScope=async()=>{assertWindow();const binding=await this.scope(run.input);assertWindow();return binding;};
    const save = async () => { run.updatedAt = this.now(); run = await this.repo.save(run, owner, this.until()); };
    const later = () => { run.status = "SCHEDULED"; run.nextAt = new Date(this.clock().getTime() + run.input.intervalSeconds * 1000).toISOString(); };
    const finishObservation = async (topComplete: boolean, repliesDone: boolean) => {
      const capture = run.checkpoint!;
      const complete = topComplete && repliesDone;
      const topRun=capture.commentsRunId?await this.d.collections.get(projectId,capture.commentsRunId):null;
      const replyScopes=await Promise.all((capture.parents??[]).map(async cid=>{const id=capture.replyRuns[cid];return {cid,run:id?await this.d.collections.get(projectId,id):null};}));
      const projectScope=(item:DouyinCollectionRun|null,parentCid?:string)=>({...(item?{runId:item.id,cursor:item.cursor,hasMore:item.hasMore}:{}),...(parentCid?{parentCid}:{}),status:item?.status??"NOT_STARTED",partial:item?.partial??true,truncated:item?.truncated??false,visibility:item?.coverage?.status??"UNKNOWN" as const,...(item?.observedAt?{observedAt:item.observedAt}:{})});
      const fullCoverage=complete&&!capture.parentLimitReached&&!capture.metricsPartial&&!topRun?.partial&&topRun?.coverage?.status==="VISIBLE"&&replyScopes.every(item=>item.run&&!item.run.partial&&item.run.coverage?.status==="VISIBLE");
      const decision=run.input.cadence?decideCadence({policy:run.input.cadence,state:run.cadenceState!,baseIntervalSeconds:run.input.intervalSeconds,now:this.now(),current:capture.metricObservation}):undefined;
      run.history.push({ ...(decision?{cadenceDecision:decision}:{}),index: run.completedCaptures + 1, startedAt: capture.metricsCapturedAt ?? capture.startedAt,
        completedAt: this.now(), metricsSnapshotId: capture.metricsSnapshotId!, commentsRunId: capture.commentsRunId!,
        replyRunIds: Object.values(capture.replyRuns), coverage: fullCoverage ? "COMPLETED_SCAN" : "PARTIAL",
        observationCoverage:{topLevel:projectScope(topRun),replies:replyScopes.map(item=>projectScope(item.run,item.cid)),parentLimitReached:capture.parentLimitReached,parentSelection:"LATEST_SAVED_TOP_LEVEL",metricsPartial:capture.metricsPartial??false},
        detail: !complete ? "当次有界观察已保存；分页或楼中楼未结束，下一次沿用原采集检查点，不代表全量。"
          : capture.parentLimitReached ? "当次扫描已结束，但父评论超过本计划上限，楼中楼仅覆盖选定父评论。"
          :!fullCoverage?"当次游标范围已结束，但存在指标缺失、不可见、截断或未核实范围；保留部分状态，不视作全量。"
          : "已走完当次平台分页；数据在观察期间可能变化，不代表持续全量或完整历史。" });
      run.completedCaptures += 1;
      if (complete) run.checkpoint = undefined;
      else { run.checkpoint!.metricsSnapshotId = undefined; run.checkpoint!.metricsCapturedAt = undefined; }
      run.consecutiveFailures = 0; run.errorCode = undefined; run.errorMessage = undefined;
      later();
      if(decision){run.nextAt=decision.nextAt;run.cadenceState!.previous=capture.metricObservation;run.cadenceState!.lastIntervalSeconds=decision.intervalSeconds;}
      if(run.completedCaptures>=run.input.maxCaptures){run.status="COMPLETED";run.terminalReason="MAX_CAPTURES";}
      if(run.input.cadence&&this.clock().getTime()>=Date.parse(run.cadenceState!.deadlineAt)){run.status="COMPLETED";run.terminalReason="MAX_DURATION";}
      await save(); return run;
    };
    try {
      await assertLease();
      if(hashValue(run.input)!==run.inputHash)throw new DomainValidationError("原运营计划输入哈希不一致，停止执行");
      assertWindow();
      const binding = await readScope();
      if (!run.checkpoint) {
        run.checkpoint = { index: run.completedCaptures + 1, startedAt: this.now(), replyRuns: {}, parentLimitReached: false };
        await save();
      }
      const key = "schedule:" + run.id + ":" + run.checkpoint!.index;
      if (!run.checkpoint!.metricsSnapshotId) {
        await assertLease();assertWindow();
        const snapshot = await this.d.metrics.refresh({ projectId, bindingId:binding.id,awemeId:run.input.awemeId,packageId: binding.packageId,
          captureKey: "schedule:" + run.id + ":" + (run.completedCaptures + 1) + ":metrics" });
        await assertLease();
        run.checkpoint!.metricsSnapshotId=snapshot.id;run.checkpoint!.metricsCapturedAt=this.now();
        run.checkpoint!.metricObservation=metricObservation(snapshot);
        run.checkpoint!.metricsPartial=Boolean(snapshot.metricAvailability&&Object.values(snapshot.metricAvailability).some(value=>value!=="OBSERVED"));
        await save();await readScope();
      }
      const previousTop = run.checkpoint!.commentsRunId ? await this.d.collections.get(projectId, run.checkpoint!.commentsRunId) : null;
      await assertLease();assertWindow();
      if (run.checkpoint!.commentsRunId && !previousTop) throw new DomainValidationError("原评论采集检查点缺失，不能悄悄重新从第一页采集");
      const top = previousTop ? previousTop.status === "COMPLETED" ? previousTop : await this.d.collections.advance({ projectId, runId: previousTop.id })
        : await this.d.collections.start({ projectId, requestKey: key + ":comments", bindingId: binding.id, awemeId: run.input.awemeId, kind: "COMMENTS", batchPages: 1, pageSize: run.input.pageSize });
      run.checkpoint!.commentsRunId = top.id; await save(); this.checkCollection(top);
      if (top.status !== "COMPLETED" || top.hasMore) return await finishObservation(false, false);
      if (!run.checkpoint!.parents) {
        const saved = await this.d.ops.listComments({ projectId, awemeId: run.input.awemeId, parentCid: null, limit: 1000, order: "desc" });
        const parents = saved.filter(comment => comment.bindingId === binding.id && ((comment.replyCount===undefined||comment.replyCount > 0)||comment.sourceCoverage?.status!=="VISIBLE"));
        run.checkpoint!.parents = parents.slice(0, run.input.maxReplyParents).map(comment => comment.cid);
        run.checkpoint!.parentLimitReached = parents.length > run.input.maxReplyParents || saved.length >= 1000;
        await save();
      }
      for (const cid of run.checkpoint!.parents!) {
        await assertLease();await readScope();
        const priorId = run.checkpoint!.replyRuns[cid];
        const prior = priorId ? await this.d.collections.get(projectId, priorId) : null;
        if (priorId && !prior) throw new DomainValidationError("原楼中楼采集检查点缺失，未重新采集");
        if (prior?.status === "COMPLETED" && !prior.hasMore) continue;
        await assertLease();assertWindow();
        const reply = prior ? await this.d.collections.advance({ projectId, runId: prior.id }) : await this.d.collections.start({
          projectId, requestKey: key + ":replies:" + cid, bindingId: binding.id, awemeId: run.input.awemeId,
          kind: "REPLIES", parentCid: cid, batchPages: 1, pageSize: run.input.pageSize });
        run.checkpoint!.replyRuns[cid] = reply.id; await save(); this.checkCollection(reply);
        break; // At most one reply page per tick, regardless of parent count.
      }
      let repliesDone = true;
      for (const cid of run.checkpoint!.parents!) {
        const replyId = run.checkpoint!.replyRuns[cid];
        const reply = replyId ? await this.d.collections.get(projectId, replyId) : null;
        if (!reply || reply.status !== "COMPLETED" || reply.hasMore) { repliesDone = false; break; }
      }
      return await finishObservation(true, repliesDone);
    } catch (error) {
      // Pausing invalidates the fence. Never overwrite the user's newer pause or another worker.
      const latest = await this.repo.get(projectId, id);
      if (!latest || latest.status === "PAUSED" || latest.revision !== run.revision) return latest ?? run;
      if(error instanceof ScheduleDurationElapsed){
        run.status="COMPLETED";run.terminalReason="MAX_DURATION";run.errorCode="OBSERVATION_WINDOW_ENDED";run.errorMessage=error.message;await save();return run;
      }
      run.consecutiveFailures = Math.min(3, run.consecutiveFailures + 1);
      const permanent = error instanceof DomainValidationError;
      const humanRequired=error instanceof DouyinOpsRuntimeError&&["AUTH_REQUIRED","RISK_CONTROL"].includes(error.code);
      run.status = humanRequired?"PAUSED":permanent || run.consecutiveFailures >= 3 ? "BLOCKED" : "SCHEDULED";
      run.errorCode = error instanceof DouyinOpsRuntimeError?error.code:permanent ? "SCOPE_OR_DATA_CHANGED" : "READ_FAILED";
      run.errorMessage = error instanceof Error ? error.message.slice(0, 500) : "运营只读采集失败";
      const retrySeconds=run.input.cadence?Math.max(run.input.cadence.minIntervalSeconds,Math.min(run.input.cadence.maxIntervalSeconds,Math.max(run.cadenceState?.lastIntervalSeconds??run.input.intervalSeconds,run.input.intervalSeconds*2**run.consecutiveFailures))):Math.min(86400,run.input.intervalSeconds*2**run.consecutiveFailures);
      run.nextAt=new Date(Math.min(this.clock().getTime()+retrySeconds*1000,run.input.cadence&&run.cadenceState?Date.parse(run.cadenceState.deadlineAt):Infinity)).toISOString();
      await save(); return run;
    } finally { await this.repo.release(projectId, id, owner); }
  }
}

export function startDouyinOperationsScheduleWorker(service: DouyinOperationsScheduleService, onError: (error: unknown) => void = () => {}) {
  let stopped = false, busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { for (const run of await service.due()) { if (stopped) break; try { await service.tick(run.input.projectId, run.id); } catch (error) { onError(error); } } }
    catch (error) { onError(error); } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5000); timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
