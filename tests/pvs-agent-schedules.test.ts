import test from "node:test";
import assert from "node:assert/strict";
import { PvsAgentCapabilities, type PvsAgentCapabilityDependencies } from "../src/application/services/pvs-agent-capabilities.js";
import { DouyinOperationsScheduleService } from "../src/application/services/douyin-operations-schedule-service.js";
import type { DouyinOperationsScheduleRepository } from "../src/application/ports/douyin-operations-schedule-repository.js";
import type { DouyinOperationsSchedule } from "../src/domain/douyin-operations-schedule.js";
import type { AgentCapabilityContext } from "../src/application/ports/agent-capability.js";
import type { DouyinWorkBinding } from "../src/domain/douyin-ops.js";

const ctx: AgentCapabilityContext = { projectId: "schedule-project", cycleId: "cycle-1", actionId: "action-1", confirmed: false };
const input = { bindingId: "binding-1", awemeId: "7900000000000000002", expectedAccountId: "real-operations-uid",
  startAt: "2099-01-01T08:00:00.000Z", intervalSeconds: 600, maxCaptures: 2, maxReplyParents: 3, pageSize: 10 };

class MemorySchedules implements DouyinOperationsScheduleRepository {
  readonly rows = new Map<string, DouyinOperationsSchedule>();
  async create(run: DouyinOperationsSchedule) {
    const prior = [...this.rows.values()].find(row => row.input.projectId === run.input.projectId && row.input.requestKey === run.input.requestKey);
    if (prior) { if (prior.inputHash !== run.inputHash) throw new Error("同一调度请求的范围已变化"); return structuredClone(prior); }
    this.rows.set(run.id, structuredClone(run)); return structuredClone(run);
  }
  async get(projectId: string, id: string) { const row = this.rows.get(id); return row?.input.projectId === projectId ? structuredClone(row) : null; }
  async list(projectId: string) { return [...this.rows.values()].filter(row => row.input.projectId === projectId).map(row => structuredClone(row)); }
  async due() { return []; }
  async claim(): Promise<DouyinOperationsSchedule | null> { throw new Error("Agent 不得直接推进计划"); }
  async save(): Promise<DouyinOperationsSchedule> { throw new Error("Agent 不得直接保存采集状态"); }
  async pause(projectId: string, id: string, revision: number, now: string) {
    const run = await this.get(projectId, id); if (!run || run.revision !== revision) return null;
    const row = { ...run, status: "PAUSED" as const, revision: run.revision + 1, updatedAt: now };
    this.rows.set(id, row); return structuredClone(row);
  }
  async release() {}
}
function fixture(options: { schedules?: boolean; account?: boolean } = {}) {
  const repo = new MemorySchedules(); let uid = input.expectedAccountId, accountReads = 0, publishReads = 0, platformReads = 0;
  const binding = { id: input.bindingId, projectId: ctx.projectId, packageId: "package-1", awemeId: input.awemeId, status: "BOUND" } as DouyinWorkBinding;
  const service = new DouyinOperationsScheduleService(repo, {
    identity: async () => { accountReads++; return { uid }; },
    ops: { findWorkBindingById: async id => id === binding.id ? binding : null, listComments: async () => [] },
    metrics: { refresh: async () => { platformReads++; throw new Error("不应采集"); } },
    collections: { start: async () => { platformReads++; throw new Error("不应采集"); }, advance: async () => { throw new Error("不应推进"); }, get: async () => null }
  });
  const deps = {
    productFlow: { getWorkspace: async () => ({ project: { id: ctx.projectId, name: "测试" } }) },
    research: { pageData: async () => ({ runs: [] }) }, researchRepo: { listRuns: async () => [] },
    smartGeneration: { list: async () => [] }, finalOutput: { latestAssembly: async () => null },
    publishRepo: { getPreference: async () => null, listPackages: async () => [], listReceipts: async () => [] },
    opsRepo: { latestWorkBinding: async () => binding, findWorkBindingById: async (id: string) => id === binding.id ? binding : null,
      listMetricSnapshots: async () => [], listComments: async () => [], listLatestReplyDrafts: async () => [], latestInsight: async () => null },
    feedback: { context: async () => [], active: async () => [] }, artifacts: { listByProject: async () => [], findById: async () => null },
    readPublishAccount: async () => { publishReads++; throw new Error("不得用发布身份替代运营 UID"); },
    ...(options.schedules === false ? {} : { schedules: service }),
    ...(options.account === false ? {} : { readOpsAccount: async () => { accountReads++; return { uid }; } })
  } as unknown as PvsAgentCapabilityDependencies;
  return { catalog: new PvsAgentCapabilities(deps), repo, service, binding, setUid: (value: string) => { uid = value; },
    get accountReads() { return accountReads; }, get publishReads() { return publishReads; }, get platformReads() { return platformReads; } };
}

test("Agent creates the real bounded schedule with exact scope, deterministic request key and no immediate collection", async () => {
  const f = fixture(), tool = f.catalog.get("operations.schedule-create");
  assert.equal(tool.effect, "HUMAN_DECISION");
  const preview = await tool.preview!(ctx.projectId, input);
  for (const value of [input.expectedAccountId, input.awemeId, input.bindingId, input.startAt, "600", "2", "3", "10"]) assert.ok(preview.includes(value));
  const result = await tool.run({ ...ctx, confirmed: true }, input), saved = result.data as DouyinOperationsSchedule;
  assert.equal(result.status, "PARTIAL"); assert.equal(saved.status, "SCHEDULED");
  const { expectedAccountId, ...settings } = input;
  assert.deepEqual(saved.input, { ...settings, projectId: ctx.projectId, opsAccountUid: expectedAccountId, requestKey: saved.input.requestKey });
  assert.equal(saved.input.projectId, ctx.projectId); assert.equal(saved.input.bindingId, input.bindingId); assert.equal(saved.input.awemeId, input.awemeId);
  assert.equal(saved.input.opsAccountUid, input.expectedAccountId); assert.equal(saved.input.startAt, input.startAt);
  assert.equal(saved.input.maxCaptures, 2); assert.equal(saved.input.maxReplyParents, 3); assert.equal(saved.input.intervalSeconds, 600); assert.equal(saved.input.pageSize, 10);
  assert.ok(!("expectedAccountId" in saved.input)); assert.ok(saved.input.requestKey.startsWith("agent-"));
  const replay = await tool.run({ ...ctx, confirmed: true }, input);
  assert.equal((replay.data as DouyinOperationsSchedule).id, saved.id); assert.equal(f.repo.rows.size, 1);
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, { ...input, intervalSeconds: 1200 }), /范围已变化/);
  assert.equal(f.platformReads, 0); assert.equal(f.publishReads, 0);
});

test("model cannot forge confirmation, project, request key or runtime time and cannot invoke tick", async () => {
  const f = fixture(), tool = f.catalog.get("operations.schedule-create");
  await assert.rejects(tool.run(ctx, input), /需要用户/);
  for (const extra of [{ confirmed: true }, { projectId: "other" }, { requestKey: "model-key" }, { now: input.startAt }, { clock: input.startAt }, { currentTime: input.startAt }])
    await assert.rejects(tool.run({ ...ctx, confirmed: true }, { ...input, ...extra }));
  assert.throws(() => f.catalog.get("operations.schedule-tick"), /未知/);
  assert.equal(f.repo.rows.size, 0); assert.equal(f.accountReads, 0); assert.equal(f.platformReads, 0);
});

test("schedule creation verifies actual operations UID and exact project/work binding before persistence", async () => {
  const f = fixture(), tool = f.catalog.get("operations.schedule-create"), confirmed = { ...ctx, confirmed: true };
  await assert.rejects(tool.run(confirmed, { ...input, expectedAccountId: "publishing-open-id" }), /实际运营账号 UID/);
  await assert.rejects(tool.run(confirmed, { ...input, awemeId: "7900000000000000014" }), /关联记录不一致/);
  await assert.rejects(tool.run({ ...confirmed, projectId: "other-project" }, input), /关联记录不一致/);
  await tool.preview!(ctx.projectId, input); f.setUid("new-account-after-preview");
  await assert.rejects(tool.run(confirmed, input), /实际运营账号 UID/);
  assert.equal(f.repo.rows.size, 0); assert.equal(f.publishReads, 0);
});

test("account inspection uses the operations identity and missing dependencies explicitly block", async () => {
  const f = fixture(); assert.deepEqual((await f.catalog.get("operations.account").run(ctx, {})).data, { uid: input.expectedAccountId });
  f.setUid("0"); assert.equal((await f.catalog.get("operations.account").run(ctx, {})).status, "BLOCKED");
  const missing = fixture({ schedules: false, account: false });
  for (const name of ["operations.account", "operations.schedule-list"]) assert.equal((await missing.catalog.get(name).run(ctx, {})).status, "BLOCKED");
  assert.equal((await missing.catalog.get("operations.schedule-create").run({ ...ctx, confirmed: true }, input)).status, "BLOCKED");
  assert.equal((await missing.catalog.get("operations.schedule-pause").run(ctx, { scheduleId: "none", expectedRevision: 1 })).status, "BLOCKED");
  assert.equal((await fixture({ account: false }).catalog.get("operations.schedule-create").run({ ...ctx, confirmed: true }, input)).status, "BLOCKED");
  assert.equal(f.publishReads, 0);
});

test("schedule list and pause call actual local service and preserve exact project/revision", async () => {
  const f = fixture(); const created = await f.catalog.get("operations.schedule-create").run({ ...ctx, confirmed: true }, input), saved = created.data as DouyinOperationsSchedule;
  const listed = await f.catalog.get("operations.schedule-list").run(ctx, {}); assert.equal((listed.data as DouyinOperationsSchedule[])[0]?.id, saved.id);
  const pause = f.catalog.get("operations.schedule-pause"); assert.equal(pause.effect, "LOCAL");
  await assert.rejects(pause.run({ ...ctx, projectId: "other" }, { scheduleId: saved.id, expectedRevision: saved.revision }), /不存在或版本/);
  await assert.rejects(pause.run(ctx, { scheduleId: saved.id, expectedRevision: saved.revision + 1 }), /不存在或版本/);
  const result = await pause.run(ctx, { scheduleId: saved.id, expectedRevision: saved.revision }); assert.equal((result.data as DouyinOperationsSchedule).status, "PAUSED");
  assert.equal(f.platformReads, 0);
});

test("snapshot and fingerprint read stored schedules without account/platform probes and schedules do not satisfy operations completion", async () => {
  const f = fixture(); const created = await f.catalog.get("operations.schedule-create").run({ ...ctx, confirmed: true }, input), reads = f.accountReads;
  const snapshot = await f.catalog.snapshot(ctx.projectId), stored = (snapshot.operations as { schedules: DouyinOperationsSchedule[] }).schedules;
  assert.equal(stored[0]?.id, (created.data as DouyinOperationsSchedule).id);
  const before = await f.catalog.fingerprint(ctx.projectId);
  await f.catalog.get("operations.schedule-pause").run(ctx, { scheduleId: stored[0]!.id, expectedRevision: stored[0]!.revision });
  assert.equal(await f.catalog.fingerprint(ctx.projectId), before, "independent observation schedules cannot invalidate business authorization");
  assert.equal(f.accountReads, reads); assert.equal(f.publishReads, 0); assert.equal(f.platformReads, 0);
  const errors = await f.catalog.validateCompletion(ctx.projectId, ["OPERATIONS"], created.evidence ?? []);
  assert.ok(errors.some(error => error.includes("真实指标"))); assert.ok(errors.some(error => error.includes("评论采集")));
});
