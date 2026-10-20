import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PvsAgentCapabilities, type PvsAgentCapabilityDependencies } from "../src/application/services/pvs-agent-capabilities.js";
import { businessStages } from "../src/domain/agent-cycle.js";
import type { AgentCapabilityContext } from "../src/application/ports/agent-capability.js";
import type { ArtifactRecord } from "../src/domain/schemas.js";
import { makeProductTruth } from "./fixtures.js";
import { readSavedProductionPlanning } from "../src/application/services/production-continuation.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { hashValue, sha256Bytes } from "../src/domain/hashing.js";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import type { SmartRunRepository } from "../src/application/ports/smart-run-repository.js";
import type { SmartProduction } from "../src/application/ports/smart-production.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import type { ProductionPlan, ScriptDraft } from "../src/domain/schemas.js";
import { ProductionQuoteService, buildProductionQuoteRequest, assertCurrentQuote } from "../src/application/services/production-quote-service.js";
import { ConfiguredGenerationQuoteProvider, validateQuoteEndpoint } from "../src/adapters/video/configured-generation-quote-provider.js";
import { buildVerifiedDreaminaRuntime } from "../src/adapters/video/verified-dreamina-runtime-loader.js";
import type { GenerationQuoteProvider } from "../src/application/ports/generation-quote-provider.js";
import type { ProviderQuote, QuoteItem } from "../src/domain/generation-quote.js";
import { renderProductionQuote } from "../src/web/agent-cycle-ui.js";

test("candidate selection previews and adopts only the exact saved batch after human confirmation", async () => {
  const truth = makeProductTruth();
  let candidate: any = { id: "candidate-batch", projectId: ctx.projectId, version: 2, status: "ACTIVE", contentHash: "b".repeat(64),
    productTruthRef: { entityType: "ProductTruth", entityId: truth.id, version: truth.version, hash: truth.contentHash },
    generatorVersion: "test", createdAt: new Date().toISOString(), concepts: Array.from({ length: 4 }, (_, n) => ({ id: "concept-" + n,
      title: "具体创意" + n, targetAudience: "使用者", painPoint: "看清实物", hook: "先看实物", coreSellingPoint: "真实展示", narrativePattern: "整体到细节",
      expectedDurationMs: 60000, productShowcaseStrategy: "实物入画", generationRisk: "LOW", requiredFactIds: [] })) };
  const calls: string[] = [];
  const f = fixture({ productRepo: { async getVersion() { return candidate; } }, productFlow: {
    async getWorkspace() { return { project: { id: ctx.projectId }, productTruth: truth }; },
    async activateCreativeBatch(batch: typeof candidate) { calls.push("activate:" + batch.id); },
    async selectCreative(_project: string, creativeId: string) { calls.push("select:" + creativeId); return {}; }
  } });
  const tool = f.catalog.get("strategy.select"), input = { creativeId: "concept-0", batch: { id: candidate.id, version: 2, contentHash: candidate.contentHash } };
  assert.match(await tool.preview!(ctx.projectId, input), /具体创意0/);
  await assert.rejects(tool.run(ctx, input), /需要用户/); assert.equal(calls.length, 0);
  await tool.run({ ...ctx, confirmed: true }, input);
  assert.deepEqual(calls, ["activate:candidate-batch", "select:concept-0"]);
  for (const changes of [{ projectId: "other-project" }, { contentHash: "c".repeat(64) }, { status: "STALE" },
    { productTruthRef: { ...candidate.productTruthRef, version: 99 } }]) {
    const original = candidate; candidate = { ...candidate, ...changes };
    await assert.rejects(tool.preview!(ctx.projectId, input));
    await assert.rejects(tool.run({ ...ctx, confirmed: true }, input));
    assert.equal(calls.length, 2); candidate = original;
  }
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, { ...input, creativeId: "absent" }));
  assert.equal(calls.length, 2);
  let modelCalls = 0, saved = 0;
  const script = { id: "draft-1", projectId: ctx.projectId, selectedCreativeId: "concept-0", status: "DRAFT" };
  const scriptFixture = fixture({
    productRepo: { async getVersion() { return candidate; } },
    productFlow: { async getWorkspace() { return { project: { id: ctx.projectId, selectedCreativeId: "concept-0", targetDurationMs: 60000 }, productTruth: truth, creativeBatch: candidate }; },
      async nextVersion() { return 2; }, async saveScriptDraft(value: unknown) { assert.equal(value, script); saved++; return {}; } },
    referenceVideo: { async latest() { return { id: "actual-profile" }; } },
    aiGeneration: { async generateScriptDraft(input: any) { modelCalls++; assert.equal(input.batch.id, candidate.id); assert.equal(input.referenceVideoProfile.id, "actual-profile"); assert.equal(input.targetDurationMs, 60000); return script; } }
  });
  const draftTool = scriptFixture.catalog.get("production.draft-script");
  await assert.rejects(draftTool.run(ctx, { creativeId: "unselected", requestText: "继续制作" }), /先采用/);
  assert.equal(modelCalls, 0);
  const result = await draftTool.run(ctx, { creativeId: "concept-0", requestText: "先看实物，再听介绍" });
  assert.equal(result.status, "WAITING_USER"); assert.equal(saved, 1); assert.equal(modelCalls, 1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-script-material-"));
  try {
    await fs.mkdir(path.join(root, ctx.projectId), { recursive: true });
    await fs.writeFile(path.join(root, ctx.projectId, "changed.png"), "corrupt bytes");
    const badMaterial = fixture({ ...scriptFixture.deps, projectsRoot: root,
      productInput: { async latest() { return { assets: [{ id: "asset-1", artifactId: "artifact-1", sha256: sha }] }; } },
      artifacts: { async findById() { return { id: "artifact-1", projectId: ctx.projectId, integrityStatus: "READY", sha256: sha, mimeType: "image/png", relativePath: "changed.png" }; } }
    });
    await assert.rejects(badMaterial.catalog.get("production.draft-script").run(ctx, { creativeId: "concept-0", requestText: "继续制作" }), /图片内容已改变/);
    assert.equal(modelCalls, 1); assert.equal(saved, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const ctx: AgentCapabilityContext = { projectId: "project-1", cycleId: "cycle-1", actionId: "action-1", confirmed: false };
const sha = "a".repeat(64);

function fixture(overrides: Record<string, unknown> = {}) {
  const truth = makeProductTruth();
  let workspace = { project: { id: ctx.projectId, name: "测试产品", targetDurationMs: 15000, selectedCreativeId: undefined as string | undefined }, productTruth: truth };
  const binding = { id: "binding-1", projectId: ctx.projectId, packageId: "package-1", awemeId: "7900000000000000010", status: "BOUND", source: "USER_CONFIRMED" };
  let drafts: unknown[] = [];
  let account = { accountId: "account-1", displayName: "操作账号" };
  let opsUid = "ops-uid-1"; let opsAccountReads = 0;
  let externalCalls = 0;
  let accountReads = 0;
  const calls: unknown[] = [];
  const deps = {
    productFlow: { async getWorkspace() { return workspace; } },
    productRepo: { async getVersion() { return null; } }, productInput: { async latest() { return null; } },
    research: { async pageData() { return { runs: [], evidence: [] }; } }, researchRepo: { async listRuns() { return []; } },
    smartGeneration: { async list() { return []; }, async get(projectId: string, runId: string) { return { id: runId, projectId, status: "READY_FOR_PAID_CONFIRM", stage: "APPROVAL", revision: 1, options: {}, paidScope: { hash: sha, requests: [{ costStatus: "KNOWN", estimatedCredits: 30 }] } }; },
      async confirmPaid(...args: unknown[]) { calls.push(args); return { id: "run-1", projectId: ctx.projectId, status: "APPROVING" }; } },
    finalOutput: { async latestAssembly() { return null; } },
    publishRepo: {
      async getPreference() { return { providerType: "DOUYIN_BROWSER_AUTOMATION" }; }, async listPackages() { return []; }, async listReceipts() { return []; },
      async findPackageById() { return { id: "package-1", projectId: ctx.projectId, status: "PACKAGE_READY", providerType: "DOUYIN_BROWSER_AUTOMATION", titleDraft: "产品发布标题", descriptionDraft: "发布内容正文", finalAssemblyId: "final-1", finalArtifactId: "video-1", finalArtifactHash: sha }; }
    },
    publishBridge: { async getPreference() { return { providerType: "DOUYIN_BROWSER_AUTOMATION" }; }, async directPublish(input: unknown) { calls.push(input); externalCalls++; return { package: { id: "package-1" }, receipt: { id: "receipt-1" } }; } },
    opsRepo: {
      async latestWorkBinding() { return binding; }, async listMetricSnapshots() { return []; }, async listComments() { return []; },
      async listLatestReplyDrafts() { return drafts; }, async latestInsight() { return null; }, async listInsights() { return []; },
      async findReplyDraftById() { return { id: "draft-1", projectId: ctx.projectId, awemeId: binding.awemeId, cid: "1001", revision: 2, currentText: "这是一条经过确认的回复正文" }; },
      async findComment() { return { text: "产品怎么使用？" }; }
    },
    opsDashboard: { async publishReplyDraft(value: unknown) { calls.push(value); return { intent: { id: "intent-1", status: "REPLY_POSTED_CONFIRMED" } }; } },
    feedback: { async context() { return []; }, async active() { return []; } },
    artifacts: { async listByProject() { return []; }, async findById() { return null; } }, projectsRoot: os.tmpdir(), publicBaseUrl: "http://127.0.0.1:3090",
    async readPublishAccount() { accountReads++; return account; },
    async readOpsAccount() { opsAccountReads++; return { uid: opsUid }; },
    ...overrides
  } as unknown as PvsAgentCapabilityDependencies;
  return { catalog: new PvsAgentCapabilities(deps), deps, calls, binding,
    setAccount(value: typeof account) { account = value; }, setDrafts(value: unknown[]) { drafts = value; },
    setOpsUid(value: string) { opsUid = value; },
    changeTruth() { workspace = { ...workspace, productTruth: { ...workspace.productTruth, contentHash: "b".repeat(64) } }; },
    get externalCalls() { return externalCalls; }, get accountReads() { return accountReads; }, get opsAccountReads() { return opsAccountReads; } };
}

test("catalog covers six business stages and input cannot replace project or authorization", async () => {
  const f = fixture();
  for (const stage of businessStages) assert.ok(f.catalog.list().some(c => c.stage === stage), stage);
  for (const name of ["research.start", "research.analyze", "strategy.generate", "production.create", "publication.submit", "operations.metrics", "operations.comments", "operations.replies", "operations.reply-publish", "feedback.promote"])
    assert.ok(f.catalog.get(name));
  await assert.rejects(f.catalog.get("project.inspect").run(ctx, { projectId: "another-project" }));
  await assert.rejects(f.catalog.get("production.confirm-paid").run(ctx, { runId: "run-1", kind: "VIDEO", scopeHash: sha, confirmed: true }));
  await assert.rejects(f.catalog.get("publication.submit").run(ctx, { packageId: "package-1", expectedAccountId: "account-1" }), /需要用户/);
  assert.equal(f.externalCalls, 0);
});

test("paid scope is passed to the real service only after runtime confirmation", async () => {
  const f = fixture(); const tool = f.catalog.get("production.confirm-paid");
  assert.equal(tool.effect, "PAID_GENERATION");
  const input = { runId: "run-1", kind: "VIDEO", scopeHash: sha, acceptedUnknownCostRisk: true };
  await assert.rejects(tool.run(ctx, input), /需要用户/);
  assert.equal(f.calls.length, 0);
  await tool.run({ ...ctx, confirmed: true }, input);
  assert.deepEqual(f.calls[0], [ctx.projectId, "run-1", { scopeHash: sha, confirmPaidGeneration: true, acceptedUnknownCostRisk: true }]);
});

test("production steps require the exact revision and can advance subsequent checkpoints", async () => {
  let revision = 1; let advanced = 0; let resumed = 0;
  const f = fixture({ smartGeneration: {
    async get(projectId: string, runId: string) { return { id: runId, projectId, revision, status: "PLANNING", stage: "SCRIPT" }; },
    async advance() { advanced++; return { id: "run-1", projectId: ctx.projectId, revision: ++revision, status: "PLANNING" }; },
    async resume() { resumed++; return { id: "run-1", projectId: ctx.projectId, revision: ++revision, status: "PLANNING" }; }
  } });
  const advance = f.catalog.get("production.advance"); const resume = f.catalog.get("production.resume");
  assert.equal(advance.effect, "LOCAL");
  await assert.rejects(advance.run(ctx, { runId: "run-1" }));
  await advance.run(ctx, { runId: "run-1", expectedRevision: 1 });
  await assert.rejects(advance.run(ctx, { runId: "run-1", expectedRevision: 1 }), /版本已改变/);
  await advance.run(ctx, { runId: "run-1", expectedRevision: 2 });
  await assert.rejects(resume.run(ctx, { runId: "run-1", expectedRevision: 2 }), /版本已改变/);
  await resume.run(ctx, { runId: "run-1", expectedRevision: 3 });
  assert.equal(advanced, 2); assert.equal(resumed, 1);
});

test("advance reuses the original paid guard without manufacturing a grant or confirming again", async () => {
  let consent = false; let revision = 1; let submits = 0; const calls: unknown[][] = [];
  const f = fixture({ smartGeneration: {
    async get(projectId: string, runId: string) { return { id: runId, projectId, revision }; },
    async advance(...args: unknown[]) { calls.push(args); if (!consent) return { id: "run-1", projectId: ctx.projectId, revision, status: "READY_FOR_PAID_CONFIRM" };
      submits++; return { id: "run-1", projectId: ctx.projectId, revision: ++revision, status: "GENERATING" }; }
  } });
  const tool = f.catalog.get("production.advance");
  await assert.rejects(tool.run(ctx, { runId: "run-1", expectedRevision: 1, autoAdvanceGrant: { source: "USER_CREATED" } }));
  assert.equal(calls.length, 0);
  assert.equal((await tool.run(ctx, { runId: "run-1", expectedRevision: 1 })).status, "WAITING_USER"); assert.equal(submits, 0);
  // Existing service state changes only after its own explicit scope confirmation.
  consent = true; revision = 2;
  assert.equal((await tool.run(ctx, { runId: "run-1", expectedRevision: 2 })).status, "RUNNING"); assert.equal(submits, 1);
  assert.deepEqual(calls, [[ctx.projectId, "run-1"], [ctx.projectId, "run-1"]]);
  const unknown = fixture({ smartGeneration: { async get() { return { id: "run-1", projectId: ctx.projectId, revision: 1 }; }, async advance() { return { id: "run-1", projectId: ctx.projectId, status: "BLOCKED", blocker: { code: "RECONCILE_REQUIRED" } }; } } });
  assert.equal((await unknown.catalog.get("production.advance").run(ctx, { runId: "run-1", expectedRevision: 1 })).status, "OUTCOME_UNKNOWN");
});

test("publication preview contains exact account, text and video and blocks account changes", async () => {
  const f = fixture(); const tool = f.catalog.get("publication.submit");
  const input = { packageId: "package-1", expectedAccountId: "account-1" };
  const preview = await tool.preview!(ctx.projectId, input);
  for (const value of ["account-1", "操作账号", "产品发布标题", "发布内容正文", "video-1", sha]) assert.ok(preview.includes(value));
  for (const label of ["发布账号：", "发布渠道：抖音浏览器自动发布", "标题：", "说明：", "成片版本："]) assert.ok(preview.includes(label));
  assert.ok(!preview.includes('"videoArtifactId"'));
  f.setAccount({ accountId: "account-2", displayName: "已切换账号" });
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, input), /发布账号已改变/);
  assert.equal(f.externalCalls, 0);
  f.setAccount({ accountId: "account-1", displayName: "操作账号" });
  await tool.run({ ...ctx, confirmed: true }, input);
  assert.deepEqual(f.calls[0], { projectId: ctx.projectId, packageId: input.packageId, expectedAccountId: input.expectedAccountId, confirmed: true });
});

test("snapshots and fingerprints read local repositories only and bind exact versions", async () => {
  const f = fixture();
  const first = await f.catalog.fingerprint(ctx.projectId);
  assert.equal(f.accountReads, 0);
  f.changeTruth(); const second = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(second, first);
  f.setDrafts([{ id: "unrelated-draft", revision: 2, currentText: "另一条评论的回复" }]);
  assert.equal(await f.catalog.fingerprint(ctx.projectId), second, "unrelated drafts cannot invalidate another action's authorization");
  assert.equal(f.accountReads, 0); assert.equal(f.externalCalls, 0);
});

test("authorization fingerprints ignore background observations while full snapshots still observe them", async () => {
  const f = fixture(); let observation = 1;
  Object.assign(f.deps.research, { pageData: async () => ({ runs: [{ revision: observation }] }) });
  Object.assign(f.deps.opsRepo, {
    listMetricSnapshots: async () => [{ id: "metric-" + observation }],
    listComments: async () => [{ id: "comment-" + observation, cid: String(observation), text: "新评论", contentHash: String(observation) }],
    listLatestReplyDrafts: async () => [{ id: "unrelated-draft", revision: observation }],
    latestInsight: async () => ({ id: "insight-" + observation })
  });
  Object.assign(f.deps.artifacts, { listByProject: async () => [{ id: "evidence-" + observation, relativePath: "agent-evidence/result.json", sha256: String(observation) }] });
  f.deps.collections = { list: async () => [{ id: "collection-1", cursor: String(observation) }] } as unknown as NonNullable<PvsAgentCapabilityDependencies["collections"]>;
  f.deps.schedules = { list: async () => [{ id: "schedule-1", revision: observation }] } as unknown as NonNullable<PvsAgentCapabilityDependencies["schedules"]>;
  const before = await f.catalog.fingerprint(ctx.projectId, "publication.submit", { packageId: "package-1", expectedAccountId: "account-1" });
  const oldSnapshot = await f.catalog.snapshot(ctx.projectId); observation++;
  assert.notDeepEqual(await f.catalog.snapshot(ctx.projectId), oldSnapshot, "planner sees newly collected evidence");
  assert.equal(await f.catalog.fingerprint(ctx.projectId, "publication.submit", { packageId: "package-1", expectedAccountId: "account-1" }), before);
  // Fingerprints need only the local business reads: observation readers may be unavailable.
  const unavailable = async () => { throw new Error("authorization must not query observation progress"); };
  Object.assign(f.deps.research, { pageData: unavailable }); Object.assign(f.deps.opsRepo, { listMetricSnapshots: unavailable, listComments: unavailable, listLatestReplyDrafts: unavailable, latestInsight: unavailable });
  Object.assign(f.deps.artifacts, { listByProject: unavailable }); Object.assign(f.deps.collections, { list: unavailable }); Object.assign(f.deps.schedules, { list: unavailable });
  assert.equal(await f.catalog.fingerprint(ctx.projectId), before);
  assert.equal(f.accountReads, 0); assert.equal(f.externalCalls, 0);
});

test("authorization fingerprints retain actual truth, production revisions, final, publication binding and active feedback", async () => {
  const f = fixture(); const original = await f.catalog.fingerprint(ctx.projectId);
  f.changeTruth(); const truth = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(truth, original);
  let revision = 1, artifactHash = sha, feedbackVersion = 1;
  Object.assign(f.deps.smartGeneration, { list: async () => [{ id: "run-1", projectId: ctx.projectId, revision }] });
  Object.assign(f.deps.finalOutput, { latestAssembly: async () => ({ id: "final-1", outputArtifactHash: artifactHash, status: "ACCEPTED" }) });
  Object.assign(f.deps.feedback, { active: async () => [{ id: "feedback-1", actionHash: "feedback-" + feedbackVersion, active: true }] });
  const baseline = await f.catalog.fingerprint(ctx.projectId); revision++;
  const production = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(production, baseline);
  artifactHash = "b".repeat(64); const final = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(final, production);
  f.binding.awemeId = "7900000000000000014"; const binding = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(binding, final);
  feedbackVersion++; const feedback = await f.catalog.fingerprint(ctx.projectId); assert.notEqual(feedback, binding);
  Object.assign(f.deps.publishRepo, { getPreference: async () => ({ providerType: "MANUAL_EXPORT" }) });
  assert.notEqual(await f.catalog.fingerprint(ctx.projectId), feedback);
  assert.equal(f.accountReads, 0);
});

test("reply authorization binds only the specified draft and parent comment content, not unrelated observations", async () => {
  const f = fixture(); let draftRevision = 2, text = "原回复正文", parentText = "产品怎么使用？", parentHash = sha, unrelated = 1;
  Object.assign(f.deps.opsRepo, {
    findReplyDraftById: async (draftId: string) => ({ id: draftId, projectId: ctx.projectId, awemeId: f.binding.awemeId, cid: "1001", revision: draftRevision, currentText: text }),
    findComment: async () => ({ id: "comment-1", projectId: ctx.projectId, awemeId: f.binding.awemeId, cid: "1001", parentCid: null, text: parentText, contentHash: parentHash, replyCount: unrelated }),
    listComments: async () => [{ id: "unrelated-" + unrelated }], listLatestReplyDrafts: async () => [{ id: "unrelated-draft", revision: unrelated }]
  });
  const input = { draftId: "draft-1", expectedRevision: 2, expectedAccountId: "account-1" };
  const original = await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input);
  unrelated++; assert.equal(await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input), original);
  draftRevision++; const revised = await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input); assert.notEqual(revised, original);
  text = "修改后回复正文"; const edited = await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input); assert.notEqual(edited, revised);
  parentHash = "c".repeat(64); const hashed = await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input); assert.notEqual(hashed, edited);
  parentText = "更新后的用户留言"; assert.notEqual(await f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input), hashed);
  Object.assign(f.deps.opsRepo, { findReplyDraftById: async () => ({ id: "draft-1", projectId: "another-project" }) });
  await assert.rejects(f.catalog.fingerprint(ctx.projectId, "operations.reply-publish", input), /不属于当前项目/);
  assert.equal(f.accountReads, 0);
});

test("arbitrary stage labels and generated MP4 cannot satisfy full-business completion", async () => {
  const f = fixture();
  const errors = await f.catalog.validateCompletion(ctx.projectId, [...businessStages], businessStages.map(stage => ({ stage, kind: "DONE", id: "invented" })));
  assert.ok(errors.some(e => e.includes("行业视频"))); assert.ok(errors.some(e => e.includes("营销策略")));
  assert.ok(errors.some(e => e.includes("最终成片"))); assert.ok(errors.some(e => e.includes("发布作品")));
  assert.ok(errors.some(e => e.includes("指标采集"))); assert.ok(errors.some(e => e.includes("下一轮实际创意输入")));
});

test("reply authorization uses actual operations UID independently of publishing OPEN_ID and preserves deterministic write intents", async () => {
  const f = fixture(); const tool = f.catalog.get("operations.reply-publish");
  f.setAccount({ accountId: "publishing-open-id", displayName: "发布昵称不能作为运营身份" });
  const input = { draftId: "draft-1", expectedRevision: 2, expectedAccountId: "ops-uid-1" };
  const preview = await tool.preview!(ctx.projectId, input);
  assert.ok(preview.includes("产品怎么使用？")); assert.ok(preview.includes("经过确认的回复正文"));
  assert.ok(preview.includes("运营账号 UID：ops-uid-1")); assert.ok(preview.includes("目标评论：1001"));
  assert.ok(preview.includes("回复草稿正文：")); assert.ok(!preview.includes("publishing-open-id")); assert.ok(!preview.includes("发布昵称"));
  const wrong = { ...input, expectedAccountId: "publishing-open-id" };
  await assert.rejects(tool.preview!(ctx.projectId, wrong), /实际运营账号 UID/);
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, wrong), /实际运营账号 UID/);
  f.setOpsUid("changed-after-preview");
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, input), /实际运营账号 UID/);
  assert.equal(f.calls.length, 0); f.setOpsUid("ops-uid-1");
  await tool.run({ ...ctx, confirmed: true }, input);
  const sent = f.calls[0] as { writeIntentId: string; confirmed: boolean; projectId: string; expectedRevision: number };
  assert.match(sent.writeIntentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sent.confirmed, true); assert.equal(sent.projectId, ctx.projectId); assert.equal(sent.expectedRevision, 2);
  assert.equal(f.accountReads, 0, "reply authorization must never inspect publishing OPEN_ID"); assert.ok(f.opsAccountReads > 0);
});

test("reply preview and execution block without a real operations identity source", async () => {
  const f = fixture(); f.deps.readOpsAccount = undefined;
  const tool = f.catalog.get("operations.reply-publish"), input = { draftId: "draft-1", expectedRevision: 2, expectedAccountId: "ops-uid-1" };
  await assert.rejects(tool.preview!(ctx.projectId, input), /未配置运营账号 UID/);
  const result = await tool.run({ ...ctx, confirmed: true }, input);
  assert.equal(result.status, "BLOCKED"); assert.ok(result.summary.includes("不能发送回复"));
  assert.equal(f.calls.length, 0); assert.equal(f.accountReads, 0);
});

test("next-strategy input stores actual adopted feedback without resetting the published project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-agent-capability-"));
  const artifacts = new Map<string, ArtifactRecord>();
  let generatedInput: unknown; let storedVersion: unknown; let activated = false;
  const feedback = [{ feedbackId: "feedback-1", insightId: "insight-1", text: "展示实际佩戴位置", evidenceRefs: ["comment:c1"] }];
  const batch = { id: "next-batch", projectId: ctx.projectId, version: 2, status: "ACTIVE", contentHash: sha, createdAt: new Date().toISOString(), concepts: [] };
  const repo = {
    async listByProject() { return [...artifacts.values()]; }, async findById(value: string) { return artifacts.get(value) ?? null; },
    async createPending(input: ArtifactRecord) { const value = { ...input, integrityStatus: "PENDING", createdAt: new Date().toISOString() } as ArtifactRecord; artifacts.set(input.id, value); return value; },
    async markReady(key: string, fields: object) { const value = { ...artifacts.get(key)!, ...fields, integrityStatus: "READY" } as ArtifactRecord; artifacts.set(key, value); return value; },
    async markCorrupt() { throw new Error("unexpected corrupt artifact"); }
  };
  const truth = makeProductTruth();
  const f = fixture({ projectsRoot: root, artifacts: repo,
    productFlow: { async getWorkspace() { return { project: { id: ctx.projectId, targetDurationMs: 15000 }, productTruth: truth }; }, async nextVersion() { return 2; }, async activateCreativeBatch() { activated = true; } },
    referenceVideo: { async latest() { return null; } }, feedback: { async context() { return feedback; } },
    aiGeneration: { async generateCreativeBatch(_t: unknown, _v: unknown, _d: unknown, _r: unknown, input: unknown) { generatedInput = input; return batch; } },
    productRepo: { async commitVersion(value: unknown) { storedVersion = value; } }
  });
  try {
    const result = await f.catalog.get("strategy.generate").run(ctx, { requestText: "生成下一轮营销方案", activate: false });
    assert.equal(activated, false); assert.ok(JSON.stringify(generatedInput).includes("feedback-1"));
    assert.deepEqual((storedVersion as { projectPatch: unknown }).projectPatch, {});
    const receiptId = result.evidence?.find(e => e.kind === "NEXT_STRATEGY_INPUT")?.id;
    assert.ok(receiptId); const artifact = artifacts.get(receiptId!); assert.ok(artifact?.sha256);
    const body = JSON.parse(await fs.readFile(path.join(root, ctx.projectId, artifact.relativePath), "utf8"));
    assert.equal(body.payload.batchId, batch.id); assert.equal(body.payload.feedback[0].feedbackId, "feedback-1");
    assert.equal(body.projectId, ctx.projectId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("operations continue a durable collection and only completed coverage satisfies the stage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-agent-collection-"));
  const artifacts = new Map<string, ArtifactRecord>(); const starts: unknown[] = [];
  const binding = { id: "binding-1", projectId: ctx.projectId, packageId: "package-1", awemeId: "7900000000000000010", status: "BOUND" };
  let job = { id: "collection-1", projectId: ctx.projectId, bindingId: binding.id, awemeId: binding.awemeId, kind: "COMMENTS", status: "PARTIAL", cursor: "next", pages: 5, syncedCount: 100, hasMore: true, partial: true, truncated: true };
  const repo = { async listByProject() { return [...artifacts.values()]; }, async findById(key: string) { return artifacts.get(key) ?? null; },
    async createPending(input: ArtifactRecord) { const value = { ...input, integrityStatus: "PENDING", createdAt: new Date().toISOString() } as ArtifactRecord; artifacts.set(input.id, value); return value; },
    async markReady(key: string, fields: object) { const value = { ...artifacts.get(key)!, ...fields, integrityStatus: "READY" } as ArtifactRecord; artifacts.set(key, value); return value; } };
  const f = fixture({ projectsRoot: root, artifacts: repo,
    opsRepo: { async latestWorkBinding() { return binding; }, async listMetricSnapshots() { return [{ id: "metric-1" }]; }, async listComments() { return []; } },
    metrics: { async refresh(input: { packageId: string }) { assert.equal(input.packageId, binding.packageId); return { id: "metric-1" }; } },
    collections: { async start(input: unknown) { starts.push(input); return job; }, async list() { return [job]; }, async advance(input: { projectId: string; runId: string }) {
      assert.equal(input.projectId, ctx.projectId); assert.equal(input.runId, job.id); job = { ...job, status: "COMPLETED", pages: 6, cursor: "end", hasMore: false, partial: false, truncated: false }; return job;
    } }
  });
  try {
    const metric = await f.catalog.get("operations.metrics").run({ ...ctx, actionId: "metric" }, {});
    const first = await f.catalog.get("operations.comments").run({ ...ctx, actionId: "comments" }, {});
    assert.equal(first.status, "PARTIAL"); assert.equal((starts[0] as { bindingId: string }).bindingId, binding.id);
    const before = await f.catalog.validateCompletion(ctx.projectId, ["OPERATIONS"], [...metric.evidence!, ...first.evidence!]);
    assert.ok(before.some(message => message.includes("顶层评论采集尚未完整")));
    const completed = await f.catalog.get("operations.collection-advance").run({ ...ctx, actionId: "continue" }, { runId: job.id });
    assert.equal(completed.status, "COMPLETE");
    assert.deepEqual(await f.catalog.validateCompletion(ctx.projectId, ["OPERATIONS"], [...metric.evidence!, ...first.evidence!, ...completed.evidence!]), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unverified media prices cannot be proposed or authorized through the Agent", async () => {
  let paidCalls = 0;
  const f = fixture({ smartGeneration: {
    async get(projectId: string, runId: string) { return { id: runId, projectId, assetPaidScope: { assets: [{ costStatus: "UNKNOWN" }] } }; },
    async confirmAssetPaid() { paidCalls++; }
  } });
  const tool = f.catalog.get("production.confirm-paid");
  const input = { runId: "current", kind: "ASSETS", scopeHash: sha, acceptedUnknownCostRisk: true };
  await assert.rejects(tool.preview!(ctx.projectId, input), /费用尚未核实/);
  await assert.rejects(tool.run({ ...ctx, confirmed: true }, input), /费用尚未核实/);
  assert.equal(paidCalls, 0);
});

test("existing confirmed work cannot accidentally enter fresh ideation", async () => {
  let newCalls = 0;
  const f = fixture({ productFlow: { async getWorkspace() { return { script: { status: "CONFIRMED" }, productionPlan: { id: "current-plan" } }; } },
    smartGeneration: { async create() { newCalls++; } } });
  const options = { requestText: "继续当前漫剧", generationSettings: { requestedModelVersion: "seedance2.0_vip", aspectRatio: "9:16", videoResolution: "720p", nativeAudioOutputRequested: true } };
  await assert.rejects(f.catalog.get("production.create").run(ctx, { options }), /continue-current/);
  assert.equal(newCalls, 0);
});

test("connecting existing work does not stop the Agent before its read-only readiness check", async () => {
  const f = fixture({ smartGeneration: { async list() { return []; }, async continueWorkspace() { return { id: "current", projectId: ctx.projectId, status: "READY_FOR_ASSET_PAID_CONFIRM" }; } } });
  const result = await f.catalog.get("production.continue-current").run(ctx,
    { artifactId: "saved", artifactHash: sha, scriptHash: sha, planHash: sha, requestText: "继续原任务" });
  assert.equal(result.status, "COMPLETE");
  assert.match(result.summary, /production.readiness/);
  assert.equal((result.data as { status: string }).status, "READY_FOR_ASSET_PAID_CONFIRM");
  assert.ok((await f.catalog.validateCompletion(ctx.projectId, ["PRODUCTION"], result.evidence!)).length);
});

test("continuation accepts only intact same-project planning bound to the current script and plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-adopt-plan-"));
  const now = new Date().toISOString();
  const ref = (entityType: string, entityId: string, hash: string) => ({ entityType, entityId, version: 1, hash });
  const strategyBody = { id: "strategy", projectId: ctx.projectId, version: 1, selectedCreativeId: "creative", contentType: "SHORT_DRAMA", summary: "复用已有漫剧", rationale: ["保留剧情"], plannerVersion: "test", createdAt: now,
    assetRequirements: [{ key: "PRODUCT", kind: "PRODUCT", label: "产品", description: "现有产品", purpose: "产品身份", required: true, reuseScope: "RUN", generationMode: "REUSE_PRODUCT_REFERENCE", referenceAssetIds: ["product"], dependsOnAssetKeys: [], confidence: "HIGH", needsReview: false }] };
  const strategy = { ...strategyBody, contentHash: hashValue(strategyBody) };
  const setBody = { id: "set", projectId: ctx.projectId, version: 1, strategyRef: ref("ProductionStrategy", "strategy", strategy.contentHash), selectedCreativeId: "creative", status: "PLANNED", createdAt: now, updatedAt: now,
    entries: [{ key: "ROLE", referenceAssetId: "role", kind: "CHARACTER", label: "角色", description: "当前角色", purpose: "一致性", required: true, reuseScope: "RUN", source: "DREAMINA_GENERATED", status: "PLANNED", artifactIds: [], sourceReferenceAssetIds: [], dependsOnAssetKeys: [], identityLock: [], generationRequestHash: sha }] };
  const set = { ...setBody, contentHash: hashValue(setBody) };
  const script = { id: "script", projectId: ctx.projectId, version: 1, status: "CONFIRMED", selectedCreativeId: "creative", contentHash: sha } as ScriptDraft;
  const plan = { id: "plan", projectId: ctx.projectId, contentHash: sha, scriptRef: ref("ScriptDraft", "script", sha), productionAssetSetRef: ref("ProductionAssetSet", "set", set.contentHash) } as ProductionPlan;
  const saved = { projectId: ctx.projectId, confirmedScript: ref("ScriptDraft", "script", sha), assets: { strategy, set, authorized: false, paidScope: { hash: sha, strategyHash: strategy.contentHash, assets: [{ key: "ROLE", requestHash: sha, costStatus: "UNKNOWN" }], preparedAt: now } }, director: { planId: plan.id, planHash: plan.contentHash } };
  const bytes = Buffer.from(JSON.stringify(saved)), file = path.join(root, "production-planning", "saved.json");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  let artifact = { id: "saved", projectId: ctx.projectId, relativePath: "production-planning/saved.json", sha256: sha256Bytes(bytes), kind: "STRUCTURED_SNAPSHOT", integrityStatus: "READY" };
  const artifacts = { async findById() { return artifact; } } as unknown as PvsAgentCapabilityDependencies["artifacts"];
  const input = { projectId: ctx.projectId, artifactId: "saved", artifactHash: artifact.sha256, artifacts, store: new LocalArtifactStore(root, artifacts), script, plan };
  try {
    const accepted = await readSavedProductionPlanning(input);
    assert.equal(accepted.assets.set.id, set.id); assert.equal(accepted.assets.authorized, false);
    await assert.rejects(readSavedProductionPlanning({ ...input, plan: { ...plan, contentHash: "b".repeat(64) } }));
    artifact = { ...artifact, projectId: "other" }; await assert.rejects(readSavedProductionPlanning(input));
    artifact = { ...artifact, projectId: ctx.projectId };
    await fs.writeFile(file, "changed bytes"); await assert.rejects(readSavedProductionPlanning(input));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("continuation is idempotent, preserves the permission gate and cannot run image generation before confirmation", async () => {
  const rows = new Map<string, SmartGenerationRun>();
  const copy = <T>(x: T): T => structuredClone(x);
  const repo = {
    async findByRequestKey(_p: string, key: string) { return [...rows.values()].find(r => r.requestKey === key) ?? null; },
    async list() { return [...rows.values()].map(copy); },
    async create(r: SmartGenerationRun) { rows.set(r.id, copy(r)); return copy(r); },
    async get(_p: string, id: string) { return rows.has(id) ? copy(rows.get(id)!) : null; },
    async acquire() { return true; }, async release() {},
    async save(r: SmartGenerationRun, revision: number) { const next = { ...r, revision: revision + 1 }; rows.set(r.id, copy(next)); return next; }
  } as unknown as SmartRunRepository;
  let builds = 0, generated = 0;
  const now = new Date().toISOString();
  const production = { async continueWorkspace() { builds++; return {
    options: { requestText: "延续漫剧", generationSettings: { requestedModelVersion: "seedance2.0_vip", aspectRatio: "9:16", videoResolution: "720p", nativeAudioOutputRequested: true }, reviewMode: "MANUAL", autoSelectLowRiskClips: false, useExistingResearch: false, useResearchReferences: false, allowSilentOutput: false },
    targetDurationMs: 60000, expectedWorkspace: {}, assetPaidScope: { hash: sha, strategyHash: sha, assets: [{ key: "ROLE", requestHash: sha, costStatus: "UNKNOWN" }], preparedAt: now },
    workspaceContinuation: { sourceArtifactId: "saved", sourceArtifactHash: sha, scriptRef: { entityType: "ScriptDraft", entityId: "script", version: 1, hash: sha }, planRef: { entityType: "ProductionPlan", entityId: "plan", version: 1, hash: sha }, assetsBound: false, localPostProductionPending: true }
  }; }, async assertCurrent() {}, async validateAssetPaidScope() {}, async advanceProductionAssets() { generated++; } } as unknown as SmartProduction;
  const service = new SmartGenerationService(repo, production);
  const input = { artifactId: "saved", artifactHash: sha, scriptHash: sha, planHash: sha, requestText: "继续当前项目" };
  const run = await service.continueWorkspace(ctx.projectId, "same-request", input);
  assert.equal(run.status, "READY_FOR_ASSET_PAID_CONFIRM");
  assert.equal(run.consent, undefined); assert.equal(run.assetConsent, undefined); assert.equal(run.autoAdvanceGrant, undefined);
  assert.equal((await service.continueWorkspace(ctx.projectId, "same-request", input)).id, run.id); assert.equal(builds, 1);
  await assert.rejects(service.continueWorkspace(ctx.projectId, "same-request", { ...input, planHash: "b".repeat(64) }));
  await assert.rejects(service.continueWorkspace(ctx.projectId, "new-request", input), /已有制作任务/);
  await service.advance(ctx.projectId, run.id); assert.equal(generated, 0);
  await assert.rejects(service.confirmAssetPaid(ctx.projectId, run.id, { scopeHash: sha, confirmPaidAssetGeneration: true, acceptedUnknownCostRisk: true }), /不接受未知费用授权/);
  const readiness = await service.inspectReadiness(ctx.projectId, run.id);
  assert.equal(readiness.providerReady, true); assert.equal(readiness.costStatus, "UNKNOWN"); assert.equal(readiness.canRequestPaidConfirmation, false);
});

function quoteFixture() {
  const entries = ["DAUGHTER", "FATHER", "LIVING_ROOM"].map((key, n) => ({
    key, label: key, kind: n === 2 ? "SET" : "CHARACTER", source: "DREAMINA_GENERATED", status: "PLANNED",
    generationRequestHash: hashValue(key), sourceReferenceAssetIds: []
  }));
  return { id: "original-run", projectId: "original-project", revision: 1, stage: "ASSET_PREP", status: "READY_FOR_ASSET_PAID_CONFIRM",
    script: { contentHash: sha }, productionPlan: { contentHash: sha,
      generationTarget: { requestedModelVersion: "seedance2.0_vip", aspectRatio: "9:16", videoResolution: "720p", nativeAudioOutputRequested: true },
      scenes: [{ clips: [6, 8, 9, 11, 10, 9].map((seconds, n) => ({ id: "C" + (n + 1), order: n + 1, durationMs: seconds * 1000,
        referenceAssets: ["product", "daughter", "father", "room"].map(assetId => ({ assetId })) })) }] },
    productionAssetSet: { contentHash: sha, entries }, attemptIds: [], notes: [], workspaceContinuation: { sourceArtifactHash: sha },
    assetPaidScope: { hash: sha, strategyHash: sha, assets: entries.map(e => ({ key: e.key, requestHash: e.generationRequestHash, costStatus: "UNKNOWN" })) }
  } as unknown as SmartGenerationRun;
}
function validQuoteProvider(credits = 3): GenerationQuoteProvider {
  return { async quote(input) { return { status: "QUOTED", kind: "BINDING_QUOTE", requestHash: input.requestHash,
    providerQuoteId: "upstream-" + input.item.key, accountFingerprint: "verified-account", currency: "CREDITS", credits,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    sourceUrl: "https://example.invalid/official-quote-contract", pricingParametersSufficient: true }; } };
}

test("quote the three images and six exact clips without uploading prompts or switching models", () => {
  const request = buildProductionQuoteRequest(quoteFixture());
  assert.equal(request.items.length, 9);
  assert.deepEqual(request.items.filter(i => i.kind === "IMAGE").map(i => [i.model, i.resolution, i.aspectRatio]),
    [["5.0", "2k", "3:4"], ["5.0", "2k", "3:4"], ["5.0", "2k", "16:9"]]);
  assert.deepEqual(request.items.filter(i => i.kind === "VIDEO").map(i => i.durationMs), [6000, 8000, 9000, 11000, 10000, 9000]);
  assert.ok(request.items.filter(i => i.kind === "VIDEO").every(i => i.model === "seedance2.0_vip" && i.nativeAudio && i.references.images === 4 && i.references.videos === 0));
  assert.doesNotMatch(JSON.stringify(request), /prompt|generationPrompt/);
  const changed = quoteFixture(); changed.productionPlan!.contentHash = "b".repeat(64);
  assert.notEqual(buildProductionQuoteRequest(changed).scopeHash, request.scopeHash);
});

test("missing upstream price interface returns no fabricated zero total and no network request", async () => {
  let network = 0;
  const provider = new ConfiguredGenerationQuoteProvider("", (async () => { network++; throw Error(); }) as typeof fetch);
  const result = await new ProductionQuoteService(provider).quote(buildProductionQuoteRequest(quoteFixture()));
  assert.equal(network, 0); assert.equal(result.status, "UNAVAILABLE"); assert.deepEqual(result.totals, []);
  assert.equal(result.items.length, 9); assert.equal(result.missingInterfaces.length, 2);
  assert.equal(result.missingInterfaces[0]!.code, "QUOTE_INTERFACE_MISSING");
  const html = renderProductionQuote(result); assert.match(html, /总费用：待核实/); assert.doesNotMatch(html, /总费用：0/);
});

for (const scenario of ["BALANCE", "ESTIMATE", "SETTLEMENT", "NEGATIVE", "WRONG_REQUEST", "EXPIRED", "LONG_EXPIRY"]) {
  test(`quotation rejects ${scenario} instead of approving spend`, async () => {
    const source = validQuoteProvider();
    const provider = { async quote(input: { requestHash: string; item: QuoteItem }) {
      const quote = await source.quote(input) as Extract<ProviderQuote, { status: "QUOTED" }>;
      if (scenario === "BALANCE") return { status: "KNOWN", availableCredits: 9011 };
      if (scenario === "ESTIMATE" || scenario === "SETTLEMENT") return { ...quote, kind: scenario };
      if (scenario === "NEGATIVE") return { ...quote, credits: -1 };
      if (scenario === "WRONG_REQUEST") return { ...quote, requestHash: "b".repeat(64) };
      if (scenario === "EXPIRED") return { ...quote, expiresAt: new Date(Date.now() - 1000).toISOString() };
      return { ...quote, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    } } as unknown as GenerationQuoteProvider;
    const result = await new ProductionQuoteService(provider).quote(buildProductionQuoteRequest(quoteFixture()));
    assert.equal(result.status, "UNAVAILABLE"); assert.deepEqual(result.totals, []);
  });
}

test("zero is a valid upstream quote, and partial quotes never present a complete total", async () => {
  const request = buildProductionQuoteRequest(quoteFixture());
  const zero = await new ProductionQuoteService(validQuoteProvider(0)).quote(request);
  assert.equal(zero.status, "QUOTED"); assert.ok(zero.totals.every(t => t.credits === 0));
  const valid = validQuoteProvider(7);
  const partial = await new ProductionQuoteService({ async quote(input) { return input.item.key === "C6"
    ? { status: "UNAVAILABLE", code: "NOT_SUPPORTED", message: "当前规格未提供报价" } : valid.quote(input); } }).quote(request);
  assert.equal(partial.status, "UNAVAILABLE"); assert.deepEqual(partial.totals, []);
});

test("quote refresh stays on the original run with no consent, supports invalidation and revision checks", async () => {
  let current = quoteFixture(), calls = 0;
  const repo = { async acquire() { return true; }, async release() {}, async get() { return structuredClone(current); },
    async save(run: SmartGenerationRun, revision: number) { assert.equal(revision, current.revision); current = { ...run, revision: revision + 1 }; return structuredClone(current); }
  } as unknown as SmartRunRepository;
  const production = { async assertCurrent() {}, async validateAssetPaidScope() {} } as unknown as SmartProduction;
  const source = validQuoteProvider(); let missing = false;
  const service = new SmartGenerationService(repo, production, new ProductionQuoteService({ async quote(input) { calls++;
    return missing ? { status: "UNAVAILABLE", code: "OFFLINE", message: "报价接口暂时不可用" } : source.quote(input); } }));
  await service.quoteCurrent(current.projectId, current.id, 1);
  assert.equal(current.id, "original-run"); assert.equal(current.revision, 2); assert.equal(current.status, "READY_FOR_ASSET_PAID_CONFIRM");
  assert.equal(current.assetConsent, undefined); assert.equal(current.consent, undefined); assert.equal(current.autoAdvanceGrant, undefined);
  assert.equal(current.attemptIds.length, 0); assert.ok(current.assetPaidScope!.assets.every(a => a.costStatus === "KNOWN"));
  assertCurrentQuote(current, "IMAGE");
  await assert.rejects(service.quoteCurrent(current.projectId, current.id, 1), /版本已变化/); assert.equal(calls, 9);
  const expired = structuredClone(current); expired.feeQuote!.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => assertCurrentQuote(expired, "IMAGE"), /缺少有效/);
  const changed = structuredClone(current); changed.productionPlan!.contentHash = "b".repeat(64);
  assert.throws(() => assertCurrentQuote(changed, "IMAGE"), /缺少有效/);
  missing = true; await service.quoteCurrent(current.projectId, current.id, 2);
  assert.ok(current.assetPaidScope!.assets.every(a => a.costStatus === "UNKNOWN"));
  await assert.rejects(service.confirmAssetPaid(current.projectId, current.id, { scopeHash: current.assetPaidScope!.hash,
    confirmPaidAssetGeneration: true, acceptedUnknownCostRisk: true }), /不接受未知费用授权/);
  assert.equal(current.assetConsent, undefined);
});

test("configured quotation transport rejects account mismatch and sends only pricing inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-quote-"));
  const config = path.join(root, "quote.json");
  try {
    await fs.writeFile(config, JSON.stringify({ contract: "pvs-generation-quote-v1", providers: { "domestic-jimeng-image-cli": {
      endpoint: "http://127.0.0.1:54321/quote", readOnly: true, accountFingerprint: "expected-account", sourceUrl: "https://example.invalid/contract" } } }));
    let requested = 0;
    const fetcher = (async (_url: unknown, options: RequestInit) => { requested++;
      assert.equal(options.redirect, "error"); const payload = JSON.parse(String(options.body)); assert.equal(payload.contract, "pvs-generation-quote-v1");
      assert.doesNotMatch(String(options.body), /prompt|assetPath|token/);
      return new Response(JSON.stringify(await validQuoteProvider().quote(payload)), { status: 200 });
    }) as typeof fetch;
    const result = await new ProductionQuoteService(new ConfiguredGenerationQuoteProvider(config, fetcher)).quote(buildProductionQuoteRequest(quoteFixture()));
    assert.equal(requested, 3); assert.equal(result.status, "UNAVAILABLE");
    assert.ok(result.items.slice(0, 3).every(i => i.result.status === "UNAVAILABLE" && i.result.code === "QUOTE_ACCOUNT_OR_SOURCE_MISMATCH"));
    assert.throws(() => validateQuoteEndpoint("http://example.invalid/quote"));
    assert.throws(() => validateQuoteEndpoint("https://example.invalid/submit?token=secret"));
    assert.throws(() => validateQuoteEndpoint("https://name:pass@example.invalid/quote"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Dreamina credit balance cannot be registered as an estimator even with a numeric extractor", async () => {
  const config = JSON.parse(await fs.readFile("config/dreamina-runtime.verified.json", "utf8"));
  config.estimate = { argsTemplate: ["user_credit"], creditsRegex: '"total_credit"\\s*:\\s*(\\d+)' };
  const runtime = buildVerifiedDreaminaRuntime(config);
  assert.equal(runtime.estimate, undefined);
  assert.equal(buildVerifiedDreaminaRuntime({ ...config, estimate: undefined }).estimate, undefined);
  const quote = fixture().catalog.get("production.quote");
  assert.equal(quote.effect, "LOCAL"); assert.equal(quote.stage, "PRODUCTION");
});

test("a read-only production inspection cannot halt the Agent before its quotation query", async () => {
  const run = quoteFixture();
  run.projectId = ctx.projectId;
  const f = fixture({ smartGeneration: { async get(projectId: string, runId: string) {
    assert.equal(projectId, ctx.projectId); assert.equal(runId, run.id); return run;
  } } });
  const result = await f.catalog.get("production.inspect").run(ctx, { runId: run.id });
  assert.equal(result.status, "COMPLETE"); assert.equal(result.data, run);
  assert.equal(run.assetConsent, undefined); assert.equal(run.consent, undefined);
});

test("authoritative credit ceilings are labelled as upper bounds rather than final charges", async () => {
  const source = validQuoteProvider(5);
  const result = await new ProductionQuoteService({ async quote(input) {
    const q = await source.quote(input); return q.status === "QUOTED" ? { ...q, kind: "CREDIT_CEILING" } : q;
  } }).quote(buildProductionQuoteRequest(quoteFixture()));
  assert.equal(result.status, "QUOTED"); assert.ok(result.totals.every(t => t.kind === "CREDIT_CEILING"));
  assert.deepEqual(result.totals.map(t => t.credits), [15, 30]);
  assert.equal(result.grandTotal?.credits, 45); assert.equal(result.grandTotal?.kind, "CREDIT_CEILING");
  const html = renderProductionQuote(result);
  assert.match(html, /不代表最终实际扣费/); assert.match(html, /设定图最高15积分/); assert.match(html, /视频最高30积分/);
});
