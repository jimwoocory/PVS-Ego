import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import type { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinOpsDashboardService, type DouyinOpsProjectView } from "../src/application/services/douyin-ops-dashboard-service.js";
import { DouyinCommentClassificationService } from "../src/application/services/douyin-comment-classification-service.js";
import { DouyinRetrospectiveService } from "../src/application/services/douyin-retrospective-service.js";
import type { StructuredAiRequest, StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import { douyinCommentSchema, douyinWorkBindingSchema } from "../src/domain/douyin-ops.js";
import { renderDouyinOpsProjectPage } from "../src/web/douyin-ops-ui.js";
import { handleDouyinOpsHttp } from "../src/web/douyin-ops-http.js";
import type { DouyinCollectionRun } from "../src/domain/douyin-collection.js";

const now = "2026-10-16T00:00:00.000Z";
const aweme = "7900000000000000010";
const binding = douyinWorkBindingSchema.parse({ id: "bound", projectId: "p", packageId: "published",
  awemeId: aweme, source: "USER_CONFIRMED", confidence: "USER_CONFIRMED", status: "BOUND",
  boundAt: now, createdAt: now, updatedAt: now });
const comments = Array.from({ length: 601 }, (_, i) => {
  const date = new Date(Date.parse(now) + i * 1000).toISOString();
  return douyinCommentSchema.parse({ id: "c" + i, projectId: "p", bindingId: binding.id,
    awemeId: aweme, cid: String(1000 + i), nickname: "用户", text: "评论 " + i,
    diggCount: 0, replyCount: 0, platformCreatedAt: date, syncedAt: date,
    rawJson: "{}", contentHash: "a".repeat(64), createdAt: date, updatedAt: date });
});

function repository() {
  const queries: Array<Record<string, unknown>> = [];
  const db = {
    douyinCommentRecord: { async findMany(query: { orderBy: Array<{ platformCreatedAt?: string }>; skip?: number; take?: number }) {
      queries.push(query as unknown as Record<string, unknown>);
      const source = query.orderBy[0]?.platformCreatedAt === "desc" ? [...comments].reverse() : comments;
      return source.slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? source.length)).map(c => ({ ...c,
        platformCreatedAt: new Date(c.platformCreatedAt!), syncedAt: new Date(c.syncedAt),
        createdAt: new Date(c.createdAt), updatedAt: new Date(c.updatedAt) }));
    } },
    douyinWorkBindingRecord: { async findFirst(query: { where: { status?: string } }) {
      const value = query.where.status === "BOUND" ? binding : { ...binding, id: "pending", status: "PENDING_DISCOVERY", awemeId: null };
      return { ...value, createdAt: new Date(now), updatedAt: new Date(now), boundAt: new Date(now) };
    } }
  } as unknown as PrismaClient;
  const repo = new PrismaDouyinOpsRepository(db);
  return { repo, queries };
}

function dashboard(repo: object, publish: object = {}) {
  const runtime = { async probe() { return { ready: false, status: "OFFLINE" }; } };
  return new DouyinOpsDashboardService(
    { async getWorkspace() { return { project: { id: "p", name: "测试" } }; } } as never,
    publish as never, repo as never, runtime as never,
    { async inspect() { return { status: "UNKNOWN", ops: { available: false } }; } } as never,
    {} as never, { async history() { return []; }, async persistBinding() { throw new Error("must not create pending binding"); } } as never,
    { async listComments() { return []; } } as never, {} as never,
    { async latestForWork() { return []; } } as never, {} as never,
    { async latest() { return null; } } as never, { async active() { return []; } } as never
  );
}

test("BOUND preference is explicit and default latest-binding behavior is preserved", async () => {
  const { repo } = repository();
  assert.equal((await repo.latestWorkBinding("p"))?.status, "PENDING_DISCOVERY");
  assert.equal((await repo.latestWorkBinding("p", { preferBound: true }))?.id, "bound");
});

test("a new unpublished package does not replace the work being monitored", async () => {
  const repo = {
    async findWorkBindingByPackage() { return null; },
    async latestWorkBinding(projectId: string, options: { preferBound?: boolean }) {
      assert.equal(projectId, "p"); assert.equal(options.preferBound, true); return binding;
    }
  };
  const view = await dashboard(repo, {
    async latestPackage() { return { id: "draft", projectId: "p", status: "PACKAGE_READY" }; },
    async listReceiptsForPackage() { return []; }
  }).project("p");
  assert.equal(view.binding?.id, binding.id);
  assert.equal(view.publishPackage?.id, "draft", "keep draft visible separately from the operational binding");
});

test("saved replies are paged locally and cannot read a different project's parent", async () => {
  let parentProject = "p";
  const repo = {
    async latestWorkBinding() { return binding; },
    async findComment() { return { ...comments[0], projectId: parentProject }; },
    async listComments(input: { projectId: string; awemeId: string; parentCid: string; offset: number; limit: number }) {
      assert.equal(input.projectId, "p"); assert.equal(input.awemeId, aweme);
      assert.equal(input.parentCid, "1000"); assert.equal(input.offset, 10); assert.equal(input.limit, 3);
      return comments.slice(0, 3).map(c => ({ ...c, parentCid: "1000" }));
    }
  };
  const service = dashboard(repo);
  const page = await service.savedReplies("p", "1000", 10, 2);
  assert.equal(page.items.length, 2); assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 12);
  parentProject = "foreign";
  await assert.rejects(service.savedReplies("p", "1000"), /不属于当前项目/);
});

test("default classification includes new comments beyond the oldest 500", async () => {
  const { repo } = repository();
  Object.assign(repo, { async latestCommentClassification() { return null; }, async saveCommentClassifications() { return []; } });
  let received: Array<{ cid: string }> = [];
  const ai: StructuredAiRuntime = { id: "offline-test", version: "1", async generateJson(request) {
    received = (request.input as { comments: Array<{ cid: string }> }).comments;
    return { items: received.map(c => ({ cid: c.cid, sentiment: "NEUTRAL", category: "GENERAL_INTERACTION", priority: "LOW" })) };
  } };
  const result = await new DouyinCommentClassificationService(repo, ai).classify({ projectId: "p", awemeId: aweme });
  assert.equal(result.classifiedCount, 20);
  assert.equal(received[0]?.cid, "1600");
  assert.ok(received.every(c => Number(c.cid) > 1500));
});

test("retrospective uses a declared latest sample and retains evidence validation", async () => {
  const { repo } = repository();
  Object.assign(repo, {
    async listMetricSnapshots() { return [{ id: "m", capturedAt: now, plays: 1, likes: 0, comments: 601, shares: 0 }]; },
    async createInsight(value: unknown) { return value; }
  });
  let request: StructuredAiRequest | undefined;
  const ai: StructuredAiRuntime = { id: "offline-test", version: "1", async generateJson(value) {
    request = value;
    return { summary: "近期样本", strengths: [], weaknesses: [], audienceQuestions: [], nextCreativeActions: [
      { text: "回应新问题", evidenceRefs: ["comment:c600"] }
    ] };
  } };
  const flow = { async getWorkspace() { return { productTruth: { status: "CONFIRMED", contentHash: "b".repeat(64), confirmedFeatures: [], sellingPoints: [] } }; } };
  const insight = await new DouyinRetrospectiveService(repo, flow as never, ai).generate({ projectId: "p" });
  assert.equal(insight.commentIds.length, 500);
  assert.ok(insight.commentIds.includes("c600")); assert.ok(!insight.commentIds.includes("c0"));
  assert.equal((request!.input as { commentSample: { selection: string } }).commentSample.selection, "LATEST_SAVED");
});

test("local reply route is read-only, paginated and validates request parameters", async () => {
  const calls: unknown[][] = [];
  const service = { async savedReplies(...args: unknown[]) { calls.push(args); return { items: [], hasMore: false, nextOffset: 2 }; } };
  const server = http.createServer((req, res) => { void handleDouyinOpsHttp(req, res, new URL(req.url!, "http://localhost"), { douyinOpsDashboard: service as never }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port + "/api/projects/p/douyin/comments/1000/replies";
    assert.equal((await fetch(url + "?offset=2&limit=20")).status, 200);
    assert.deepEqual(calls, [["p", "1000", 2, 20]]);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal((await fetch(url + "?offset=-1")).status, 400);
    assert.equal(calls.length, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test("UI provides saved-reply viewing, sample coverage and a valid browser script", () => {
  const view = { project: { id: "p", name: "产品" }, runtime: { ready: false }, account: { status: "UNKNOWN" },
    publishPackage: { id: "draft" }, publishReceipt: null, binding, snapshots: [], comments: [comments[0]],
    replyDrafts: [], latestInsight: null, creativeFeedback: [], candidates: [], candidatesStatus: "OFFLINE" } as unknown as DouyinOpsProjectView;
  const collection = { id: "collection-1", projectId: "p", bindingId: binding.id, awemeId: aweme, kind: "COMMENTS", status: "PARTIAL", hasMore: true, partial: true, truncated: true, syncedCount: 100, pages: 5, cursor: "cursor-next", retryable: true, updatedAt: now } as DouyinCollectionRun;
  const html = renderDouyinOpsProjectPage(view, [collection]);
  assert.match(html, /查看已保存的楼中楼回复/); assert.match(html, /尚有后续数据/); assert.match(html, /cursor-next/); assert.match(html, /继续采集/);
  assert.match(html, /最新保存的最多 500/); assert.match(html, /下方采集、分析和回复继续使用上述已绑定作品/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) assert.doesNotThrow(() => new vm.Script(script[1]!));
});
