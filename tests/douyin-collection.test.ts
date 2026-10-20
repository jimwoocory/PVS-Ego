import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { PrismaDouyinCollectionRepository } from "../src/adapters/db/prisma-douyin-collection-repository.js";
import { DouyinCommentService } from "../src/application/services/douyin-comment-service.js";
import { DouyinCollectionService } from "../src/application/services/douyin-collection-service.js";
import type { DouyinOpsRuntime, DouyinOpsCommentPage, DouyinOpsComment } from "../src/application/ports/douyin-ops-runtime.js";

const database = process.env.DATABASE_URL?.startsWith("file:")
  ? decodeURIComponent(process.env.DATABASE_URL.slice(5).split("?")[0]!) : "";
if (!path.isAbsolute(database) || !realpathSync.native(database).toLowerCase().startsWith(realpathSync.native(os.tmpdir()).toLowerCase() + path.sep)) {
  throw new Error("douyin-collection tests require an explicitly migrated isolated OS TEMP database");
}

class FakeRuntime implements DouyinOpsRuntime {
  calls: string[] = [];
  failCursor?: string;
  stuck = false;
  wait?: () => Promise<void>;
  async probe() { return { ok: true, ready: true, status: "READY" }; }
  async identity() { return { nickname: "测试", uid: "u", secUid: "s", uniqueId: "1", shortId: "1" }; }
  async listMyWorks() { return []; }
  async searchWorks() { return []; }
  async getWork(): Promise<never> { throw new Error("not used"); }
  async getDownloadMetadata(): Promise<never> { throw new Error("not used"); }
  private comment(awemeId: string, cid: string, parentCid = ""): DouyinOpsComment {
    return { awemeId, cid, parentCid, uid: "u", secUid: "s", nickname: "用户", text: "真实格式的合成评论",
      diggCount: 0, replyCount: parentCid ? 0 : 2, createdAt: null, avatarUrl: "" };
  }
  async getComments(input: { awemeId: string; cursor?: string }): Promise<DouyinOpsCommentPage> {
    const cursor = input.cursor ?? "0";
    this.calls.push("comments:" + cursor);
    if (this.wait) await this.wait();
    if (this.failCursor === cursor) throw new Error("synthetic connection interrupted");
    return { comments: cursor === "0" ? [this.comment(input.awemeId, "1001")]
      : [this.comment(input.awemeId, "1001"), this.comment(input.awemeId, "1002")],
      cursor: this.stuck ? cursor : cursor === "0" ? "1" : "2", hasMore: this.stuck || cursor === "0" };
  }
  async getReplies(input: { awemeId: string; cid: string; cursor?: string }): Promise<DouyinOpsCommentPage> {
    const cursor = input.cursor ?? "0";
    this.calls.push("replies:" + input.cid + ":" + cursor);
    return { comments: [this.comment(input.awemeId, cursor === "0" ? "2001" : "2002", input.cid)],
      cursor: cursor === "0" ? "1" : "2", hasMore: cursor === "0" };
  }
}

async function fixture() {
  const db = new PrismaClient();
  const projectId = "collection-" + randomUUID();
  const awemeId = "76" + (BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 14)) % 10000000000000000n).toString().padStart(16, "0");
  await db.project.create({ data: { id: projectId, name: "合成采集测试", status: "PUBLISHED", targetDurationMs: 15000, aspectRatio: "9:16" } });
  const ops = new PrismaDouyinOpsRepository(db);
  const now = new Date().toISOString();
  const binding = await ops.upsertWorkBinding({ id: "binding-" + randomUUID(), projectId,
    packageId: "package-" + randomUUID(), awemeId, source: "USER_CONFIRMED", confidence: "USER_CONFIRMED",
    status: "BOUND", boundAt: now, externalUrl: "https://www.douyin.com/video/" + awemeId, createdAt: now, updatedAt: now });
  const runtime = new FakeRuntime();
  const comments = new DouyinCommentService(ops, runtime);
  const repo = new PrismaDouyinCollectionRepository(db);
  const service = new DouyinCollectionService(repo, ops, comments);
  return { db, projectId, awemeId, binding, runtime, ops, comments, repo, service,
    input: { projectId, bindingId: binding.id, awemeId, requestKey: "request-" + randomUUID(), kind: "COMMENTS" as const, batchPages: 1 },
    async dispose() { await db.project.delete({ where: { id: projectId } }); await db.$disconnect(); } };
}

test("collection persists partial coverage, resumes through a new service and counts deduplicated records", async () => {
  const f = await fixture();
  try {
    const first = await f.service.start(f.input);
    assert.equal(first.status, "PARTIAL");
    assert.equal(first.cursor, "1");
    assert.equal(first.pages, 1);
    assert.equal(first.partial, true);
    assert.equal(first.truncated, true);
    assert.equal(first.syncedCount, 1);
    const resumed = new DouyinCollectionService(new PrismaDouyinCollectionRepository(f.db), f.ops, f.comments);
    assert.equal((await resumed.get(f.projectId, first.id))?.cursor, "1");
    const done = await resumed.advance({ projectId: f.projectId, runId: first.id });
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.pages, 2);
    assert.equal(done.syncedCount, 2);
    assert.equal(done.hasMore, false);
    assert.equal(done.partial, false);
    assert.equal(done.truncated, false);
    assert.deepEqual(f.runtime.calls, ["comments:0", "comments:1"]);
    assert.equal(await f.db.douyinCommentRecord.count({ where: { projectId: f.projectId } }), 2);
    assert.equal((await resumed.list(f.projectId)).length, 1);
    await resumed.advance({ projectId: f.projectId, runId: first.id });
    assert.equal(f.runtime.calls.length, 2);
  } finally { await f.dispose(); }
});

test("request keys are durable and cannot silently change collection scope or options", async () => {
  const f = await fixture();
  try {
    const run = await f.service.start(f.input);
    const repeat = await new DouyinCollectionService(f.repo, f.ops, f.comments).start(f.input);
    assert.equal(repeat.id, run.id);
    assert.equal(f.runtime.calls.length, 1);
    await assert.rejects(f.service.start({ ...f.input, pageSize: 10 }), /同一采集请求标识/);
    assert.equal(await f.service.get("other-project", run.id), null);
    assert.deepEqual(await f.service.list("other-project"), []);
    await assert.rejects(f.service.advance({ projectId: "other-project", runId: run.id }), /找不到/);
    assert.equal(f.runtime.calls.length, 1);
  } finally { await f.dispose(); }
});

test("a later-page read failure preserves the last cursor and can resume without starting again", async () => {
  const f = await fixture();
  try {
    f.runtime.failCursor = "1";
    const interrupted = await f.service.start({ ...f.input, batchPages: 3 });
    assert.equal(interrupted.status, "BLOCKED");
    assert.equal(interrupted.retryable, true);
    assert.equal(interrupted.cursor, "1");
    assert.equal(interrupted.pages, 1);
    assert.equal(interrupted.syncedCount, 1);
    f.runtime.failCursor = undefined;
    const done = await f.service.advance({ projectId: f.projectId, runId: interrupted.id });
    assert.equal(done.status, "COMPLETED");
    assert.deepEqual(f.runtime.calls, ["comments:0", "comments:1", "comments:1"]);
    assert.equal(done.syncedCount, 2);
  } finally { await f.dispose(); }
});

test("a repeated cursor persists a non-retryable blocker rather than looping or declaring complete", async () => {
  const f = await fixture();
  try {
    f.runtime.stuck = true;
    const run = await f.service.start(f.input);
    assert.equal(run.status, "BLOCKED");
    assert.equal(run.errorCode, "CURSOR_STALLED");
    assert.equal(run.retryable, false);
    assert.equal(run.partial, true);
    assert.equal(run.hasMore, true);
    assert.equal(run.syncedCount, 1);
    await f.service.advance({ projectId: f.projectId, runId: run.id });
    assert.equal(f.runtime.calls.length, 1);
  } finally { await f.dispose(); }
});

test("reply collection pins parent/project/binding and a changed work cannot reuse the cursor", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.start({ ...f.input, kind: "REPLIES", parentCid: "9999" }), /顶层评论/);
    const top = await f.service.start(f.input);
    const replies = await f.service.start({ ...f.input, requestKey: "replies-" + randomUUID(), kind: "REPLIES", parentCid: "1001" });
    assert.equal(replies.status, "PARTIAL");
    const done = await f.service.advance({ projectId: f.projectId, runId: replies.id });
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.syncedCount, 2);
    const saved = await f.ops.listComments({ projectId: f.projectId, awemeId: f.awemeId, parentCid: "1001" });
    assert.equal(saved.length, 2);
    assert.ok(saved.every(row => row.bindingId === f.binding.id));
    await f.db.douyinWorkBindingRecord.update({ where: { id: f.binding.id }, data: { awemeId: "7900000000000000001" } });
    const calls = f.runtime.calls.length;
    const changed = await f.service.advance({ projectId: f.projectId, runId: top.id });
    assert.equal(changed.status, "BLOCKED");
    assert.equal(changed.retryable, false);
    assert.equal(changed.cursor, "1");
    assert.equal(f.runtime.calls.length, calls);
  } finally { await f.dispose(); }
});

test("independent processes cannot advance the same active lease and an expired lease resumes its checkpoint", async () => {
  const f = await fixture();
  const otherDb = new PrismaClient();
  try {
    const run = await f.service.start(f.input);
    const second = new DouyinCollectionService(new PrismaDouyinCollectionRepository(otherDb), f.ops, f.comments);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    f.runtime.wait = async () => { entered(); await hold; };
    const active = f.service.advance({ projectId: f.projectId, runId: run.id });
    try {
      await Promise.race([waiting, active.then(() => { throw new Error("fake read did not enter"); })]);
      assert.equal((await second.advance({ projectId: f.projectId, runId: run.id })).status, "RUNNING");
      assert.equal(f.runtime.calls.length, 2);
    } finally { release(); }
    await active;
    f.runtime.wait = undefined;
    const fresh = await f.service.start({ ...f.input, requestKey: randomUUID() });
    const owner = randomUUID();
    await f.repo.claim({ projectId: f.projectId, id: fresh.id, revision: fresh.revision, owner,
      now: new Date().toISOString(), until: new Date(Date.now() + 180000).toISOString() });
    await f.db.$executeRaw`UPDATE "DouyinCollectionRunRecord" SET "leaseExpiresAt"=${new Date(0)} WHERE "id"=${fresh.id}`;
    const restored = await second.advance({ projectId: f.projectId, runId: fresh.id });
    assert.equal(restored.status, "COMPLETED");
    assert.equal(restored.syncedCount, 2);
    assert.equal(await f.db.douyinCommentRecord.count({ where: { projectId: f.projectId } }), 2);
  } finally { await otherDb.$disconnect(); await f.dispose(); }
});

test("a checkpoint failure repeats only the read page and upserts keep the record count stable", async () => {
  const f = await fixture();
  try {
    const checkpoint = f.repo.checkpoint.bind(f.repo);
    let failOnce = true;
    f.repo.checkpoint = async (...input) => {
      if (failOnce) { failOnce = false; throw new Error("synthetic checkpoint interruption"); }
      return checkpoint(...input);
    };
    const run = await f.service.start(f.input);
    assert.equal(run.status, "BLOCKED");
    assert.equal(run.cursor, "0");
    const resumed = await f.service.advance({ projectId: f.projectId, runId: run.id });
    assert.equal(resumed.cursor, "1");
    assert.equal(resumed.syncedCount, 1);
    assert.deepEqual(f.runtime.calls, ["comments:0", "comments:0"]);
    assert.equal(await f.db.douyinCommentRecord.count({ where: { projectId: f.projectId } }), 1);
  } finally { await f.dispose(); }
});

test("collecting a work in another project never transfers already-owned comment rows", async () => {
  const f = await fixture();
  const otherProject = "other-" + randomUUID();
  try {
    await f.service.start(f.input);
    await f.db.project.create({ data: { id: otherProject, name: "其他项目", status: "PUBLISHED", targetDurationMs: 15000 } });
    // awemeId has a global unique binding constraint. Model historical comments left behind after an
    // explicit work re-association, rather than trying to create two impossible concurrent bindings.
    await f.db.douyinWorkBindingRecord.update({ where: { id: f.binding.id }, data: { awemeId: "7900000000000000001" } });
    const now = new Date().toISOString();
    const binding = await f.ops.upsertWorkBinding({ ...f.binding, id: randomUUID(), projectId: otherProject,
      packageId: randomUUID(), createdAt: now, updatedAt: now });
    const run = await f.service.start({ projectId: otherProject, bindingId: binding.id, awemeId: f.awemeId,
      requestKey: randomUUID(), kind: "COMMENTS" });
    assert.equal(run.status, "BLOCKED");
    assert.equal(run.retryable, false);
    assert.match(run.errorMessage ?? "", /其他项目或作品绑定/);
    assert.equal((await f.ops.findComment({ awemeId: f.awemeId, cid: "1001" }))?.projectId, f.projectId);
    assert.equal(await f.db.douyinCommentRecord.count({ where: { projectId: otherProject } }), 0);
    const owned = (await f.ops.findComment({ awemeId: f.awemeId, cid: "1001" }))!;
    await assert.rejects(f.ops.upsertComments([
      { ...owned, id: randomUUID(), cid: "3001", projectId: otherProject, bindingId: binding.id },
      { ...owned, projectId: otherProject, bindingId: binding.id, text: "must roll back" }
    ]), /整批采集已回滚/);
    assert.equal(await f.db.douyinCommentRecord.count({ where: { projectId: otherProject } }), 0);
    assert.equal((await f.ops.findComment({ awemeId: f.awemeId, cid: "1001" }))?.text, owned.text);
  } finally {
    await f.db.project.deleteMany({ where: { id: otherProject } });
    await f.dispose();
  }
});
