import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256Bytes } from "../src/domain/hashing.js";
import { DouyinOpsDashboardService } from "../src/application/services/douyin-ops-dashboard-service.js";
import { DouyinMetricService } from "../src/application/services/douyin-metric-service.js";
import { DouyinCommentService } from "../src/application/services/douyin-comment-service.js";
import { DouyinRetrospectiveService } from "../src/application/services/douyin-retrospective-service.js";
import { douyinWorkBindingSchema } from "../src/domain/douyin-ops.js";
import { PvsAgentCapabilities } from "../src/application/services/pvs-agent-capabilities.js";

function fixture() {
  const now = "2026-10-17T03:00:00.000Z";
  const work = { awemeId: "7900000000000000009", description: "天庭打工人", publishedAt: now,
    author: { uid: "owner-1", nickname: "作者", secUid: "", uniqueId: "" }, externalUrl: "https://www.douyin.com/video/7900000000000000009",
    metrics: { plays: 20, likes: 2, comments: 1, shares: 0 }, durationMs: 15000, coverUrl: "" };
  let uid = "owner-1", current: any = null, reads = 0;
  const runtime: any = { async identity() { return { uid, nickname: "作者" }; }, async listMyWorks() { return [work, { ...work, awemeId: "123456789", author: { ...work.author, uid: "other" } }]; },
    async getWork() { reads++; return work; }, async getComments() { reads++; return { comments: [], cursor: "0", hasMore: false }; } };
  const repo: any = { async latestWorkBinding() { return current; }, async upsertWorkBinding(v: any) { current = v; return v; },
    async findWorkBindingById() { return current; }, async createMetricSnapshot(v: any) { return v; } };
  const flow: any = { async getWorkspace() { return { project: { id: "project" }, productTruth: { status: "CONFIRMED", contentHash: "a".repeat(64), confirmedFeatures: [], sellingPoints: [] } }; } };
  const args: any[] = [flow, {}, repo, runtime, {}, {}, {}, {}, {}, {}, {}, {}];
  const dashboard = new (DouyinOpsDashboardService as any)(...args) as DouyinOpsDashboardService;
  return { work, runtime, repo, flow, dashboard, setUid(v: string) { uid = v; }, setBinding(v: any) { current = v; }, get reads() { return reads; } };
}

test("historical observation verifies ownership and stable content without creating a publication package", async () => {
  const f = fixture(), preview = await f.dashboard.existingWorks();
  assert.equal(preview.works.length, 1);
  const input = { projectId: "project", awemeId: f.work.awemeId, expectedAccountUid: "owner-1", expectedWorkHash: preview.works[0]!.workHash };
  const binding = await f.dashboard.observeExistingWork(input);
  assert.equal(binding.source, "HISTORICAL_WORK"); assert.equal(binding.packageId, undefined); assert.equal(binding.publishReceiptId, undefined);
  assert.equal(binding.opsAccountUid, "owner-1");
  assert.equal((await f.dashboard.observeExistingWork(input)).id, binding.id);
  f.setUid("other"); await assert.rejects(f.dashboard.observeExistingWork(input), /账号已变化/);
  f.setUid("owner-1"); await assert.rejects(f.dashboard.observeExistingWork({ ...input, expectedWorkHash: "b".repeat(64) }), /内容已变化/);
  f.setBinding({ ...binding, source: "USER_CONFIRMED", packageId: "real-package" });
  await assert.rejects(f.dashboard.observeExistingWork(input), /不能静默替换/);
});

test("historical binding cannot fabricate a package, receipt or omit ownership", async () => {
  const f = fixture(), preview = await f.dashboard.existingWorks();
  const binding = await f.dashboard.observeExistingWork({ projectId: "project", awemeId: f.work.awemeId, expectedAccountUid: "owner-1", expectedWorkHash: preview.works[0]!.workHash });
  for (const patch of [{ packageId: "fake-package" }, { publishReceiptId: "fake-receipt" }, { opsAccountUid: undefined }])
    assert.equal(douyinWorkBindingSchema.safeParse({ ...binding, ...patch }).success, false);
  const before = f.reads; f.setUid("other");
  await assert.rejects(new DouyinMetricService(f.repo, f.runtime).refresh({ projectId: "project" }), /账号已改变/);
  await assert.rejects(new DouyinCommentService(f.repo, f.runtime).syncComments({ projectId: "project" }), /账号已改变/);
  assert.equal(f.reads, before);
});

test("historical retrospective carries scope and parent comment identity into the actual model request", async () => {
  const f = fixture(), preview = await f.dashboard.existingWorks();
  const binding = await f.dashboard.observeExistingWork({ projectId: "project", awemeId: f.work.awemeId, expectedAccountUid: "owner-1", expectedWorkHash: preview.works[0]!.workHash });
  let request: any;
  const repo: any = { ...f.repo, async listMetricSnapshots() { return [{ id: "snapshot", capturedAt: binding.createdAt, plays: 20, likes: 2, comments: 1, shares: 0 }]; },
    async listComments() { return [{ id: "comment", cid: "1234", parentCid: "1233", text: "想看下一集", diggCount: 1, replyCount: 0 }]; }, async createInsight(v: any) { return v; } };
  const runtime: any = { id: "test", version: "1", async generateJson(r: any) { request = r; return { summary: "历史作品样本观察", strengths: [], weaknesses: [], audienceQuestions: [], nextCreativeActions: [{ text: "下一轮明确续集钩子", evidenceRefs: ["comment:comment"] }] }; } };
  const insight = await new DouyinRetrospectiveService(repo, f.flow, runtime).generate({ projectId: "project" });
  assert.equal(request.input.work.source, "HISTORICAL_WORK"); assert.equal(request.input.work.currentProductionPublished, false);
  assert.equal(request.input.commentEvidence[0].parentCid, "1233"); assert.match(request.instructions, /不得把历史作品评论当成本产品需求/);
  assert.equal(insight.bindingId, binding.id); assert.equal(insight.nextCreativeActions[0]!.evidenceRefs[0], "comment:comment");
});

test("Agent sees older reply parents beyond its short comment preview", async () => {
  const f = fixture(), preview = await f.dashboard.existingWorks();
  const binding = await f.dashboard.observeExistingWork({ projectId: "project", awemeId: f.work.awemeId, expectedAccountUid: "owner-1", expectedWorkHash: preview.works[0]!.workHash });
  const oldParent = { cid: "100000000000", text: "旧父评论", replyCount: 3 };
  const deps: any = { productFlow: f.flow, research: { async pageData() { return { runs: [] }; } }, smartGeneration: { async list() { return []; } },
    finalOutput: { async latestAssembly() { return null; } }, publishRepo: { async getPreference() { return null; }, async listPackages() { return []; }, async listReceipts() { return []; } },
    opsRepo: { ...f.repo, async listMetricSnapshots() { return []; }, async listLatestReplyDrafts() { return []; }, async latestInsight() { return null; },
      async listComments(input: any) { return input.parentCid === null ? [oldParent] : []; } },
    artifacts: { async listByProject() { return []; } }, feedback: { async context() { return []; } } };
  const snapshot: any = await new PvsAgentCapabilities(deps).snapshot("project");
  assert.equal(snapshot.operations.comments.length, 0);
  assert.deepEqual(snapshot.operations.replyParents, [{ cid: oldParent.cid, replyCount: 3 }]);
  assert.equal(snapshot.operations.replyParentIndex.truncated, false);
});

test("feedback generation returns exact missing reply scopes and does not run the model prematurely", async () => {
  let modelCalls = 0, covered = false;
  const deps: any = { opsRepo: { async latestWorkBinding() { return { id: "binding", awemeId: "123456789" }; }, async listComments() { return [{ cid: "old-parent", replyCount: 2 }]; } },
    collections: { async list() { return [{ bindingId: "binding", awemeId: "123456789", kind: "COMMENTS", status: "COMPLETED", hasMore: false, partial: false },
      ...(covered ? [{ bindingId: "binding", awemeId: "123456789", kind: "REPLIES", parentCid: "old-parent", status: "COMPLETED", hasMore: false, partial: false }] : [])]; } },
    retrospective: { async generate() { modelCalls++; return { id: "insight" }; } } };
  const capability = new PvsAgentCapabilities(deps).get("feedback.generate");
  const context = { projectId: "project", cycleId: "cycle", actionId: "action", confirmed: false };
  const partial: any = await capability.run(context, {});
  assert.equal(partial.status, "PARTIAL"); assert.deepEqual(partial.data.missingParentCids, ["old-parent"]); assert.equal(modelCalls, 0);
  covered = true; assert.equal((await capability.run(context, {})).status, "COMPLETE"); assert.equal(modelCalls, 1);
});

test("next strategy receives verified existing product material and preserves settings awaiting review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-material-context-")), f = fixture();
  const bytes = Buffer.from("registered product image fixture"), sha = sha256Bytes(bytes), records = new Map<string, any>();
  await fs.mkdir(path.join(root, "project")); await fs.writeFile(path.join(root, "project", "product.png"), bytes);
  records.set("product-image", { id: "product-image", projectId: "project", relativePath: "product.png", sha256: sha, integrityStatus: "READY" });
  let input: any, activated = false;
  const repo: any = { async findById(id: string) { return records.get(id) ?? null; },
    async createPending(v: any) { records.set(v.id, { ...v, integrityStatus: "PENDING", createdAt: new Date().toISOString() }); return records.get(v.id); },
    async markReady(id: string, fields: any) { const v = { ...records.get(id), ...fields, integrityStatus: "READY" }; records.set(id, v); return v; } };
  const deps: any = { projectsRoot: root, artifacts: repo, productFlow: { ...f.flow, async nextVersion() { return 4; }, async activateCreativeBatch() { activated = true; } },
    productInput: { async latest() { return { assets: [{ type: "image", artifactId: "product-image", sha256: sha }] }; } },
    smartGeneration: { async list() { return [{ productionAssetSet: { entries: [{ key: "DAUGHTER", label: "女儿", source: "DREAMINA_GENERATED", status: "NEEDS_REVIEW", artifactIds: ["setting-image"] }] } }]; } },
    referenceVideo: { async latest() { return null; } }, research: { async pageData() { return {}; } }, feedback: { async context() { return []; } },
    productRepo: { async commitVersion(v: any) { assert.deepEqual(v.projectPatch, {}); } },
    aiGeneration: { async generateCreativeBatch(_truth: any, _version: any, _duration: any, _reference: any, context: any) { input = context; return { id: "next", projectId: "project", version: 4, contentHash: "a".repeat(64), concepts: [] }; } } };
  try {
    await new PvsAgentCapabilities(deps).get("strategy.generate").run({ projectId: "project", cycleId: "cycle", actionId: "action", confirmed: false }, { requestText: "继续下一轮候选", activate: false });
    assert.deepEqual(input.materialInventory.productImages, [{ artifactId: "product-image", fileVerified: true }]);
    assert.equal(input.materialInventory.generatedSettings[0].status, "NEEDS_REVIEW");
    assert.equal(input.materialInventory.rule, "AVAILABLE_DOES_NOT_MEAN_HUMAN_APPROVED"); assert.equal(activated, false);
  } finally { assert.ok(root.startsWith(path.join(os.tmpdir(), "pvs-material-context-"))); await fs.rm(root, { recursive: true, force: true }); }
});
