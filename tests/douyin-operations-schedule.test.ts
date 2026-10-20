import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOperationsScheduleRepository } from "../src/adapters/db/prisma-douyin-operations-schedule-repository.js";
import { DouyinOperationsScheduleService, type OperationsScheduleDependencies } from "../src/application/services/douyin-operations-schedule-service.js";
import { operationsScheduleInputSchema } from "../src/domain/douyin-operations-schedule.js";
import { douyinCollectionRunSchema, douyinCollectionStartSchema, type DouyinCollectionRun } from "../src/domain/douyin-collection.js";
import type { DouyinWorkBinding } from "../src/domain/douyin-ops.js";

async function fixture() {
  const db = new PrismaClient(), repo = new PrismaDouyinOperationsScheduleRepository(db);
  const projectId = "schedule-" + randomUUID(), bindingId = randomUUID(), awemeId = "7900000000000000002";
  let now = new Date("2026-10-16T08:00:00.000Z"), uid = "operations-uid-1", metricsFail = false, topPartial = false, repliesPartial = false;
  let identityWait: (() => Promise<void>) | undefined, metricWait: (() => Promise<void>) | undefined;
  const binding = { id: bindingId, projectId, packageId: randomUUID(), awemeId, status: "BOUND" } as DouyinWorkBinding;
  const calls: Array<{ operation: string; key?: string; id?: string; kind?: string; parent?: string }> = [];
  const collections = new Map<string, DouyinCollectionRun>();
  let parents: Array<{ cid: string; replyCount: number; bindingId: string }> = [];
  const deps: OperationsScheduleDependencies = {
    identity: async () => { calls.push({ operation: "identity" }); await identityWait?.(); return { uid }; },
    ops: {
      findWorkBindingById: async id => id === bindingId ? { ...binding } : null,
      listComments: async () => parents.map(parent => ({ ...parent, projectId, awemeId })) as Awaited<ReturnType<OperationsScheduleDependencies["ops"]["listComments"]>>
    },
    metrics: { refresh: async input => {
      calls.push({ operation: "metrics", key: input.captureKey }); await metricWait?.();
      if (metricsFail) throw new Error("temporary read failure");
      return { id: "snapshot-" + input.captureKey } as Awaited<ReturnType<OperationsScheduleDependencies["metrics"]["refresh"]>>;
    } },
    collections: {
      start: async raw => {
        const input = douyinCollectionStartSchema.parse(raw);
        calls.push({ operation: "start", key: input.requestKey, kind: input.kind, parent: input.parentCid });
        const prior = [...collections.values()].find(run => run.requestKey === input.requestKey);
        if (prior) return structuredClone(prior);
        const partial = input.kind === "COMMENTS" ? topPartial : repliesPartial;
        const run = douyinCollectionRunSchema.parse({ ...input, id: randomUUID(), bindingId, awemeId,
          inputHash: input.requestKey, status: partial ? "PARTIAL" : "COMPLETED", cursor: partial ? "page-2" : "end",
          pages: 1, syncedCount: 1, hasMore: partial, partial, truncated: partial, revision: 1,
          visitedCursors: ["0"], retryable: true, createdAt: now.toISOString(), updatedAt: now.toISOString() });
        collections.set(run.id, run); return structuredClone(run);
      },
      get: async (scope, id) => { const run = collections.get(id); return run?.projectId === scope ? structuredClone(run) : null; },
      advance: async input => {
        const old = collections.get(input.runId)!;
        calls.push({ operation: "advance", id: old.id, kind: old.kind, parent: old.parentCid });
        const run: DouyinCollectionRun = { ...old, status: "COMPLETED", cursor: "end", pages: old.pages + 1,
          hasMore: false, partial: false, truncated: false, revision: old.revision + 1 };
        collections.set(run.id, run); return structuredClone(run);
      }
    }
  };
  const clock = () => new Date(now);
  const service = new DouyinOperationsScheduleService(repo, deps, clock);
  const input = { projectId, requestKey: "schedule-request", bindingId, awemeId, opsAccountUid: uid,
    startAt: now.toISOString(), intervalSeconds: 60, maxCaptures: 2, maxReplyParents: 2, pageSize: 20 };
  return { db, repo, service, deps, clock, calls, input, binding, collections,
    setNow: (value: string) => { now = new Date(value); },
    setUid: (value: string) => { uid = value; },
    failMetrics: () => { metricsFail = true; },
    partialTop: () => { topPartial = true; }, partialReplies: () => { repliesPartial = true; },
    setParents: (cids: string[]) => { parents = cids.map(cid => ({ cid, replyCount: 3, bindingId })); },
    waitIdentity: (wait?: () => Promise<void>) => { identityWait = wait; },
    waitMetrics: (wait?: () => Promise<void>) => { metricWait = wait; },
    cleanup: async () => { await db.$executeRaw`DELETE FROM "DouyinOperationsScheduleRecord" WHERE "projectId"=${projectId}`; await db.$disconnect(); }
  };
}

test("schedule bounds are explicit and duplicate request keys cannot change account or work", async () => {
  const f = await fixture();
  try {
    assert.equal(operationsScheduleInputSchema.safeParse({ ...f.input, intervalSeconds: 59 }).success, false);
    assert.equal(operationsScheduleInputSchema.safeParse({ ...f.input, maxCaptures: 31 }).success, false);
    const first = await f.service.create(f.input), second = await f.service.create(f.input);
    assert.equal(second.id, first.id); assert.equal((await f.service.list(f.input.projectId)).length, 1);
    await assert.rejects(f.service.create({ ...f.input, intervalSeconds: 120 }), /同一调度请求/);
    assert.equal(f.calls.filter(call => call.operation === "metrics").length, 0);
  } finally { await f.cleanup(); }
});

test("due observations stop at maxCaptures, use stable capture keys and never execute early", async () => {
  const f = await fixture();
  try {
    let run = await f.service.create(f.input);
    run = await f.service.tick(f.input.projectId, run.id);
    assert.equal(run.completedCaptures, 1); assert.equal(run.status, "SCHEDULED");
    assert.equal(run.history[0]?.coverage, "COMPLETED_SCAN"); assert.match(run.history[0]!.detail, /不代表持续全量/);
    const calls = f.calls.length;
    await f.service.tick(f.input.projectId, run.id); assert.equal(f.calls.length, calls);
    f.setNow(run.nextAt);
    run = await f.service.tick(f.input.projectId, run.id);
    assert.equal(run.completedCaptures, 2); assert.equal(run.status, "COMPLETED");
    assert.equal(new Set(f.calls.filter(call => call.operation === "metrics").map(call => call.key)).size, 2);
    assert.equal((await f.service.due()).length, 0);
    await f.service.tick(f.input.projectId, run.id); assert.equal(f.calls.filter(call => call.operation === "metrics").length, 2);
  } finally { await f.cleanup(); }
});

test("partial comments resume the same persisted collection after service restart rather than starting at zero", async () => {
  const f = await fixture(); f.partialTop();
  try {
    let run = await f.service.create({ ...f.input, maxCaptures: 2 });
    run = await f.service.tick(f.input.projectId, run.id);
    const originalCollection = run.checkpoint!.commentsRunId;
    assert.equal(run.completedCaptures, 1); assert.equal(run.status, "SCHEDULED"); assert.equal(run.history[0]?.coverage, "PARTIAL");
    const restarted = new DouyinOperationsScheduleService(new PrismaDouyinOperationsScheduleRepository(f.db), f.deps, f.clock);
    f.setNow(run.nextAt); run = await restarted.tick(f.input.projectId, run.id);
    assert.equal(run.status, "COMPLETED"); assert.equal(run.history[1]?.commentsRunId, originalCollection);
    assert.equal(f.calls.filter(call => call.operation === "start").length, 1);
    assert.equal(f.calls.filter(call => call.operation === "advance")[0]?.id, originalCollection);
    assert.equal(f.calls.filter(call => call.operation === "metrics").length, 2);
  } finally { await f.cleanup(); }
});

test("reply pages are bounded per tick, retain parent IDs, and parent sampling limits remain PARTIAL", async () => {
  const f = await fixture(); f.setParents(["101", "102", "103"]); f.partialReplies();
  try {
    let run = await f.service.create({ ...f.input, maxCaptures: 2, maxReplyParents: 1 });
    run = await f.service.tick(f.input.projectId, run.id);
    assert.deepEqual(run.checkpoint?.parents, ["101"]); assert.equal(run.completedCaptures, 1);
    assert.equal(f.calls.filter(call => call.kind === "REPLIES").length, 1);
    f.setNow(run.nextAt); run = await f.service.tick(f.input.projectId, run.id);
    assert.equal(run.status, "COMPLETED"); assert.equal(run.history[0]?.coverage, "PARTIAL");
    assert.equal(f.calls.filter(call => call.operation === "start" && call.kind === "REPLIES").length, 1);
    assert.equal(f.calls.filter(call => call.operation === "advance" && call.kind === "REPLIES").length, 1);
    assert.ok(f.calls.filter(call => call.kind === "REPLIES").every(call => call.parent === "101"));
  } finally { await f.cleanup(); }
});

test("account or work-binding changes block the fixed schedule before further collection", async () => {
  for (const change of ["account", "binding"] as const) {
    const f = await fixture();
    try {
      let run = await f.service.create(f.input);
      if (change === "account") f.setUid("different-uid"); else f.binding.awemeId = "7900000000000000013";
      run = await f.service.tick(f.input.projectId, run.id);
      assert.equal(run.status, "BLOCKED"); assert.equal(run.errorCode, "SCOPE_OR_DATA_CHANGED");
      assert.equal(f.calls.filter(call => call.operation === "metrics" || call.operation === "start").length, 0);
    } finally { await f.cleanup(); }
  }
});

test("the observation budget ends a still-partial scan without claiming complete coverage or losing its cursor handle", async () => {
  const f = await fixture(); f.partialTop();
  try {
    let run = await f.service.create({ ...f.input, maxCaptures: 1 });
    run = await f.service.tick(f.input.projectId, run.id);
    assert.equal(run.status, "COMPLETED"); assert.equal(run.completedCaptures, 1);
    assert.equal(run.history[0]?.coverage, "PARTIAL"); assert.ok(run.checkpoint?.commentsRunId);
    const saved = await f.deps.collections.get(f.input.projectId, run.checkpoint!.commentsRunId!);
    assert.equal(saved?.status, "PARTIAL"); assert.equal(saved?.cursor, "page-2");
    const reads = f.calls.length; f.setNow(run.nextAt);
    await f.service.tick(f.input.projectId, run.id); assert.equal(f.calls.length, reads);
    assert.equal((await f.service.due()).length, 0);
  } finally { await f.cleanup(); }
});

test("transient reads back off and stop after three failures without consuming captures", async () => {
  const f = await fixture(); f.failMetrics();
  try {
    let run = await f.service.create(f.input);
    for (let failure = 1; failure <= 3; failure++) {
      const before = f.clock().getTime(); run = await f.service.tick(f.input.projectId, run.id);
      assert.equal(run.consecutiveFailures, failure); assert.equal(run.completedCaptures, 0);
      assert.equal(Date.parse(run.nextAt) - before, 60 * 2 ** failure * 1000);
      if (failure < 3) { assert.equal(run.status, "SCHEDULED"); f.setNow(run.nextAt); }
    }
    assert.equal(run.status, "BLOCKED"); assert.equal(f.calls.filter(call => call.operation === "metrics").length, 3);
    assert.equal(new Set(f.calls.filter(call => call.operation === "metrics").map(call => call.key)).size, 1);
    assert.equal((await f.service.due()).length, 0);
  } finally { await f.cleanup(); }
});

test("pause is revision-scoped and survives a new service instance", async () => {
  const f = await fixture();
  try {
    const run = await f.service.create(f.input);
    await assert.rejects(f.service.pause(f.input.projectId, run.id, run.revision + 1), /版本已变化/);
    const paused = await f.service.pause(f.input.projectId, run.id, run.revision);
    const restarted = new DouyinOperationsScheduleService(f.repo, f.deps, f.clock);
    assert.equal((await restarted.tick(f.input.projectId, run.id)).status, "PAUSED");
    assert.equal(await restarted.get("other-project", run.id), null);
    await assert.rejects(restarted.tick("other-project", run.id), /找不到/);
    assert.equal(paused.completedCaptures, 0); assert.equal(f.calls.filter(call => call.operation === "metrics").length, 0);
  } finally { await f.cleanup(); }
});

test("independent database clients cannot run the same active observation", async () => {
  const f = await fixture(), otherDb = new PrismaClient();
  let release!: () => void;
  try {
    const run = await f.service.create(f.input);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    f.waitIdentity(async () => { entered(); await hold; });
    const active = f.service.tick(f.input.projectId, run.id); await waiting;
    const second = new DouyinOperationsScheduleService(new PrismaDouyinOperationsScheduleRepository(otherDb), f.deps, f.clock);
    assert.equal((await second.tick(f.input.projectId, run.id)).status, "RUNNING");
    assert.equal(f.calls.filter(call => call.operation === "metrics").length, 0);
    release(); await active;
    assert.equal(f.calls.filter(call => call.operation === "metrics").length, 1);
  } finally { release?.(); await otherDb.$disconnect(); await f.cleanup(); }
});

test("pause during an in-flight read fences subsequent comment collection", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const run = await f.service.create(f.input);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    f.waitMetrics(async () => { entered(); await hold; });
    const active = f.service.tick(f.input.projectId, run.id); await waiting;
    const current = (await f.service.get(f.input.projectId, run.id))!;
    await f.service.pause(f.input.projectId, run.id, current.revision);
    release(); assert.equal((await active).status, "PAUSED");
    assert.equal(f.calls.filter(call => call.operation === "start").length, 0);
  } finally { release?.(); await f.cleanup(); }
});

test("an expired read lease can resume while its old owner's writes remain fenced", async () => {
  const f = await fixture();
  try {
    const run = await f.service.create({ ...f.input, maxCaptures: 1 }), owner = randomUUID();
    const until = new Date(f.clock().getTime() + 1000).toISOString();
    const old = (await f.repo.claim(f.input.projectId, run.id, run.revision, owner, f.clock().toISOString(), until))!;
    f.setNow(new Date(Date.parse(until) + 1).toISOString());
    const completed = await f.service.tick(f.input.projectId, run.id);
    assert.equal(completed.status, "COMPLETED");
    await assert.rejects(f.repo.save({ ...old, updatedAt: f.clock().toISOString() }, owner, until), /执行权已变化/);
    assert.equal(f.calls.filter(call => call.operation === "metrics").length, 1);
  } finally { await f.cleanup(); }
});
