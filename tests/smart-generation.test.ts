import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { PrismaSmartRunRepository } from "../src/adapters/db/prisma-smart-run-repository.js";
import { smartRunSchema, runnableSmartStatuses, type SmartGenerationRun } from "../src/domain/smart-generation.js";
import { renderSmartGenerationPage, renderBatchGenerationPanel } from "../src/web/smart-generation-ui.js";
import { MemorySmartRuns, FixtureProduction, smartOptions } from "./smart-test-support.js";
import { H, ISO } from "./fixtures.js";
import {
  assetPaidScopeSchema,
  productionAssetSetSchema,
  productionStrategyRef,
  productionStrategySchema
} from "../src/domain/production-strategy.js";
import { hashValue } from "../src/domain/hashing.js";

async function drain(service: SmartGenerationService, run: SmartGenerationRun) {
  for (let n = 0; n < 40 && runnableSmartStatuses.includes(run.status); n++) run = await service.advance(run.projectId, run.id);
  return run;
}
function rig() { const repo = new MemorySmartRuns(), production = new FixtureProduction(); return { repo, production, service: new SmartGenerationService(repo, production) }; }

test("smart AUTO planning stops at an exact paid gate and cannot synthesize approval", async () => {
  const { repo, production, service } = rig();
  let run = await service.create("project-1", "key-1", smartOptions);
  assert.equal((await service.create("project-1", "key-1", smartOptions)).id, run.id);
  await assert.rejects(service.create("project-1", "key-1", { ...smartOptions, requestText: "changed" }), /changed/);
  run = await drain(service, run);
  assert.equal(run.status, "READY_FOR_PAID_CONFIRM");
  assert.equal(production.counts.approvals, 0); assert.equal(production.counts.generate, 0);
  assert.ok(repo.history.some(r => r.pendingInstall === "DIRECTOR"));
  await assert.rejects(service.confirmPaid(run.projectId, run.id, { scopeHash: H.a, confirmPaidGeneration: true, acceptedUnknownCostRisk: true }), /范围/);
  await assert.rejects(service.confirmPaid(run.projectId, run.id, { scopeHash: run.paidScope!.hash, confirmPaidGeneration: false, acceptedUnknownCostRisk: true }), /明确/);
  await assert.rejects(service.confirmPaid(run.projectId, run.id, { scopeHash: run.paidScope!.hash, confirmPaidGeneration: true, acceptedUnknownCostRisk: false }), /成本未知/);
  const consent = { scopeHash: run.paidScope!.hash, confirmPaidGeneration: true, acceptedUnknownCostRisk: true };
  run = await service.confirmPaid(run.projectId, run.id, consent);
  const again = await service.confirmPaid(run.projectId, run.id, consent);
  assert.equal(again.revision, run.revision); assert.equal(production.counts.generate, 0);
  const restarted = new SmartGenerationService(repo, production);
  run = await drain(restarted, run);
  assert.equal(run.status, "REVIEW_READY"); assert.equal(production.counts.approvals, 1); assert.equal(production.counts.generate, 1);
  await assert.rejects(restarted.confirmFinal(run.projectId, run.id), /成片页/);
  production.finalAccepted = true;
  run = await restarted.confirmFinal(run.projectId, run.id);
  assert.equal(run.status, "COMPLETED"); assert.equal((await restarted.advance(run.projectId, run.id)).revision, run.revision);
});

test("V2 always asks the user to choose a creative, then auto-plans production assets and skips unnecessary asset spend", async () => {
  const { production, service } = rig();
  let run = await drain(
    service,
    await service.create("project-1", "v2", smartOptions, 2)
  );
  assert.equal(run.workflowVersion, 2);
  assert.equal(run.status, "WAITING_FOR_CREATIVE_REVIEW");
  assert.equal(production.counts.planner, 0);
  run = await service.review(run.projectId, run.id, {
    action: "SELECT_CREATIVE",
    expectedRevision: run.revision,
    creativeId: "creative-1"
  });
  run = await drain(service, run);
  assert.equal(production.counts.planner, 1);
  assert.equal(production.counts.assets, 1);
  assert.equal(run.productionStrategy?.contentType, "PRODUCT_DEMO");
  assert.equal(run.productionAssetSet?.status, "READY");
  assert.equal(run.assetPaidScope, undefined);
  assert.equal(run.status, "READY_FOR_PAID_CONFIRM");
  assert.ok(run.script);
  assert.ok(run.productionPlan);
});

test("V2 waits for confirmation of every generated production asset after independent assets finish", async () => {
  class MultiAssetProduction extends FixtureProduction {
    assetAdvance = 0;
    override async planProduction(run: SmartGenerationRun) {
      const base = {
        id: "strategy-multi",
        projectId: run.projectId,
        version: 1,
        selectedCreativeId: run.selectedCreativeId!,
        contentType: "SHORT_DRAMA" as const,
        summary: "固定两个制作资产",
        rationale: ["跨镜头连续性"],
        assetRequirements: [
          {
            key: "PRODUCT_MAIN", kind: "PRODUCT" as const, label: "产品",
            description: "产品主图", purpose: "身份", required: true,
            reuseScope: "RUN" as const, generationMode: "REUSE_PRODUCT_REFERENCE" as const,
            referenceAssetIds: ["product-main"], confidence: "HIGH" as const, needsReview: false
          },
          {
            key: "CHARACTER_A", kind: "CHARACTER" as const, label: "女主",
            description: "固定女主", purpose: "连续性", required: true,
            reuseScope: "MULTI_CLIP" as const, generationMode: "GENERATE_IMAGE" as const,
            generationPrompt: "女主参考", referenceAssetIds: [], confidence: "HIGH" as const, needsReview: false
          },
          {
            key: "SET_A", kind: "SET" as const, label: "卧室",
            description: "固定卧室", purpose: "连续性", required: true,
            reuseScope: "MULTI_CLIP" as const, generationMode: "GENERATE_IMAGE" as const,
            generationPrompt: "卧室参考", referenceAssetIds: [], confidence: "HIGH" as const, needsReview: false
          }
        ],
        plannerVersion: "fixture",
        createdAt: ISO
      };
      return productionStrategySchema.parse({ ...base, contentHash: hashValue(base) });
    }
    private set(run: SmartGenerationRun, first: "PLANNED" | "NEEDS_REVIEW" | "READY", second: "PLANNED" | "NEEDS_REVIEW" | "READY") {
      const strategy = run.productionStrategy!;
      const base = {
        id: "asset-set-multi", projectId: run.projectId, version: 1,
        strategyRef: productionStrategyRef(strategy), selectedCreativeId: run.selectedCreativeId!,
        status: first === "NEEDS_REVIEW" || second === "NEEDS_REVIEW" ? "NEEDS_REVIEW" as const : first === "READY" && second === "READY" ? "READY" as const : "PLANNED" as const,
        entries: [
          {
            key: "PRODUCT_MAIN", referenceAssetId: "product-main", kind: "PRODUCT" as const, label: "产品",
            description: "产品主图", purpose: "身份", required: true, reuseScope: "RUN" as const,
            source: "PRODUCT_INPUT" as const, status: "READY" as const, artifactIds: ["artifact-product"],
            sourceReferenceAssetIds: ["product-main"], identityLock: ["产品"], confidence: "HIGH" as const
          },
          {
            key: "CHARACTER_A", referenceAssetId: "production-asset:character", kind: "CHARACTER" as const, label: "女主",
            description: "固定女主", purpose: "连续性", required: true, reuseScope: "MULTI_CLIP" as const,
            source: "DREAMINA_GENERATED" as const, status: first, artifactIds: first === "PLANNED" ? [] : ["production-asset:character"],
            sourceReferenceAssetIds: [], identityLock: ["女主"], generationPrompt: "女主参考", generationRequestHash: H.b,
            ...(first !== "PLANNED" ? { confidence: first === "READY" ? "HIGH" as const : "MEDIUM" as const } : {})
          },
          {
            key: "SET_A", referenceAssetId: "production-asset:set", kind: "SET" as const, label: "卧室",
            description: "固定卧室", purpose: "连续性", required: true, reuseScope: "MULTI_CLIP" as const,
            source: "DREAMINA_GENERATED" as const, status: second, artifactIds: second === "PLANNED" ? [] : ["production-asset:set"],
            sourceReferenceAssetIds: [], identityLock: ["卧室"], generationPrompt: "卧室参考", generationRequestHash: H.c,
            ...(second !== "PLANNED" ? { confidence: second === "READY" ? "HIGH" as const : "MEDIUM" as const } : {})
          }
        ],
        createdAt: ISO, updatedAt: ISO
      };
      return productionAssetSetSchema.parse({ ...base, contentHash: hashValue(base) });
    }
    override async prepareProductionAssets(run: SmartGenerationRun) {
      const set = this.set(run, "PLANNED", "PLANNED");
      const raw = {
        strategyHash: run.productionStrategy!.contentHash,
        assets: [
          { key: "CHARACTER_A", requestHash: H.b, costStatus: "UNKNOWN" as const },
          { key: "SET_A", requestHash: H.c, costStatus: "UNKNOWN" as const }
        ],
        preparedAt: ISO
      };
      return {
        set,
        paidScope: assetPaidScopeSchema.parse({
          ...raw,
          hash: hashValue({ strategyHash: raw.strategyHash, assets: raw.assets })
        })
      };
    }
    async validateAssetPaidScope() {}
    override async advanceProductionAssets(run: SmartGenerationRun) {
      this.assetAdvance += 1;
      return this.set(run, "NEEDS_REVIEW", "NEEDS_REVIEW");
    }
    override async acceptProductionAsset(run: SmartGenerationRun, key?: string) {
      const current = run.productionAssetSet!;
      const firstCurrent = current.entries.find(item => item.key === "CHARACTER_A")?.status;
      const secondCurrent = current.entries.find(item => item.key === "SET_A")?.status;
      const first = key === "CHARACTER_A" || firstCurrent === "READY" ? "READY" as const : "NEEDS_REVIEW" as const;
      const second = key === "SET_A" || secondCurrent === "READY" ? "READY" as const : "NEEDS_REVIEW" as const;
      return this.set(run, first, second);
    }
  }
  const repo = new MemorySmartRuns();
  const production = new MultiAssetProduction();
  const service = new SmartGenerationService(repo, production);
  let run = await drain(service, await service.create("project-1", "v2-multi", smartOptions, 2));
  run = await service.review(run.projectId, run.id, {
    action: "SELECT_CREATIVE", expectedRevision: run.revision, creativeId: "creative-1"
  });
  run = await drain(service, run);
  assert.equal(run.status, "READY_FOR_ASSET_PAID_CONFIRM");
  run = await service.confirmAssetPaid(run.projectId, run.id, {
    scopeHash: run.assetPaidScope!.hash,
    confirmPaidAssetGeneration: true,
    acceptedUnknownCostRisk: true
  });
  run = await drain(service, run);
  assert.equal(run.status, "WAITING_FOR_ASSET_REVIEW");
  run = await service.review(run.projectId, run.id, {
    action: "CONFIRM_ASSET", expectedRevision: run.revision, assetKey: "CHARACTER_A"
  });
  assert.equal(run.status, "WAITING_FOR_ASSET_REVIEW");
  run = await service.review(run.projectId, run.id, {
    action: "CONFIRM_ASSET", expectedRevision: run.revision, assetKey: "SET_A"
  });
  assert.equal(run.status, "PLANNING");
  run = await drain(service, run);
  assert.equal(run.status, "READY_FOR_PAID_CONFIRM");
  assert.equal(production.assetAdvance, 1);
});

test("stale production image requires an explicit retry setup and fresh asset-paid confirmation", async () => {
  class StaleAssetProduction extends FixtureProduction {
    override async planProduction(run: SmartGenerationRun) {
      const base = {
        id: "strategy-stale-ui", projectId: run.projectId, version: 1,
        selectedCreativeId: run.selectedCreativeId!, contentType: "SHORT_DRAMA" as const,
        summary: "使用 canonical 参考并生成固定人物资产", rationale: ["跨镜头连续性"],
        assetRequirements: [
          {
            key: "PRODUCT_MAIN", kind: "PRODUCT" as const, label: "产品", description: "产品主图", purpose: "身份", required: true,
            reuseScope: "RUN" as const, generationMode: "REUSE_PRODUCT_REFERENCE" as const, referenceAssetIds: ["product-main"], confidence: "HIGH" as const, needsReview: false
          },
          {
            key: "CHARACTER_A", kind: "CHARACTER" as const, label: "女主", description: "固定女主", purpose: "连续性", required: true,
            reuseScope: "MULTI_CLIP" as const, generationMode: "GENERATE_IMAGE" as const, generationPrompt: "女主参考", referenceAssetIds: [], confidence: "HIGH" as const, needsReview: false
          }
        ],
        plannerVersion: "fixture", createdAt: ISO
      };
      return productionStrategySchema.parse({ ...base, contentHash: hashValue(base) });
    }
    private set(run: SmartGenerationRun, stale: boolean) {
      const strategy = run.productionStrategy!;
      const base = {
        id: "asset-set-stale-ui", projectId: run.projectId, version: 1,
        strategyRef: productionStrategyRef(strategy), selectedCreativeId: run.selectedCreativeId!,
        status: stale ? "FAILED" as const : "PLANNED" as const,
        entries: [
          {
            key: "PRODUCT_MAIN", referenceAssetId: "product-main", kind: "PRODUCT" as const, label: "产品", description: "产品主图", purpose: "身份", required: true,
            reuseScope: "RUN" as const, source: "PRODUCT_INPUT" as const, status: "READY" as const, artifactIds: ["artifact-product"], sourceReferenceAssetIds: ["product-main"], identityLock: ["产品"], confidence: "HIGH" as const
          },
          {
            key: "CHARACTER_A", referenceAssetId: "production-asset:stale-ui:CHARACTER_A", kind: "CHARACTER" as const, label: "女主", description: "固定女主", purpose: "连续性", required: true,
            reuseScope: "MULTI_CLIP" as const, source: "DREAMINA_GENERATED" as const,
            status: stale ? "SUBMISSION_UNKNOWN" as const : "PLANNED" as const, artifactIds: [], sourceReferenceAssetIds: [], identityLock: ["女主"],
            generationPrompt: "女主参考", generationRequestHash: H.b,
            ...(stale ? { submitId: "submit-stale-ui", errorCode: "ASSET_REMOTE_RESULT_STALE", errorMessage: "即梦队列已结束但长时间没有返回图片产物" } : {})
          }
        ],
        createdAt: ISO, updatedAt: ISO
      };
      return productionAssetSetSchema.parse({ ...base, contentHash: hashValue(base) });
    }
    override async prepareProductionAssets(run: SmartGenerationRun) {
      const set = this.set(run, false);
      const raw = {
        strategyHash: run.productionStrategy!.contentHash,
        assets: [{ key: "CHARACTER_A", requestHash: H.b, costStatus: "UNKNOWN" as const }],
        preparedAt: ISO
      };
      return { set, paidScope: assetPaidScopeSchema.parse({ ...raw, hash: hashValue({ strategyHash: raw.strategyHash, assets: raw.assets }) }) };
    }
    async validateAssetPaidScope() {}
    override async advanceProductionAssets(run: SmartGenerationRun) {
      return this.set(run, true);
    }
    async retryProductionAsset(run: SmartGenerationRun, key: string) {
      assert.equal(key, "CHARACTER_A");
      const set = this.set(run, false);
      const raw = {
        strategyHash: run.productionStrategy!.contentHash,
        authorizationNonce: "retry-stale-ui",
        assets: [{ key: "CHARACTER_A", requestHash: H.b, costStatus: "UNKNOWN" as const }],
        preparedAt: ISO
      };
      return { set, paidScope: assetPaidScopeSchema.parse({ ...raw, hash: hashValue({ strategyHash: raw.strategyHash, assets: raw.assets, authorizationNonce: raw.authorizationNonce }) }) };
    }
  }
  const repo = new MemorySmartRuns();
  const production = new StaleAssetProduction();
  const service = new SmartGenerationService(repo, production);
  let run = await drain(service, await service.create("project-1", "stale-asset", smartOptions, 2));
  run = await service.review(run.projectId, run.id, { action: "SELECT_CREATIVE", expectedRevision: run.revision, creativeId: "creative-1" });
  run = await drain(service, run);
  assert.equal(run.status, "READY_FOR_ASSET_PAID_CONFIRM");
  run = await service.confirmAssetPaid(run.projectId, run.id, {
    scopeHash: run.assetPaidScope!.hash,
    confirmPaidAssetGeneration: true,
    acceptedUnknownCostRisk: true
  });
  run = await drain(service, run);
  assert.equal(run.status, "BLOCKED");
  assert.equal(run.blocker?.code, "ASSET_REMOTE_RESULT_STALE");
  const workspace = { project: { id: "project-1", name: "产品", status: "DRAFT" as const, targetPlatform: "douyin" as const, targetDurationMs: 15000, aspectRatio: "16:9", createdAt: ISO, updatedAt: ISO } };
  const blockedHtml = renderSmartGenerationPage(workspace, [run]);
  assert.match(blockedHtml, /重新准备此资产/);
  assert.match(blockedHtml, /retry-asset/);
  assert.match(blockedHtml, /使用 产品主参考图并生成固定人物资产/);
  assert.match(blockedHtml, /平台长时间没有返回图片结果/);
  assert.match(blockedHtml, /技术信息（排查用）/);
  assert.match(blockedHtml, /任务编号：submit-stale-ui/);
  assert.doesNotMatch(
    blockedHtml,
    /<p class="error">[^<]*(canonical|querying|submit_id)/i
  );
  assert.doesNotMatch(
    blockedHtml,
    /<p class="muted">2026-09-27T05:00:00\.000Z/
  );

  run = await service.retryAsset(run.projectId, run.id, { expectedRevision: run.revision, assetKey: "CHARACTER_A" });
  assert.equal(run.status, "READY_FOR_ASSET_PAID_CONFIRM");
  assert.equal(run.assetConsent, undefined);
  assert.ok(run.assetPaidScope?.authorizationNonce);
});

test("manual mode preserves three human creative review gates and rejects stale revisions", async () => {
  const { service } = rig();
  let run = await drain(service, await service.create("project-1", "manual", { ...smartOptions, reviewMode: "MANUAL" }));
  assert.equal(run.status, "WAITING_FOR_CREATIVE_REVIEW");
  await assert.rejects(service.review(run.projectId, run.id, { action: "SELECT_CREATIVE", expectedRevision: 1, creativeId: "creative-1" }), /版本/);
  run = await service.review(run.projectId, run.id, { action: "SELECT_CREATIVE", expectedRevision: run.revision, creativeId: "creative-1" });
  run = await drain(service, run); assert.equal(run.status, "WAITING_FOR_SCRIPT_REVIEW");
  run = await service.review(run.projectId, run.id, { action: "CONFIRM_SCRIPT", expectedRevision: run.revision });
  run = await drain(service, run); assert.equal(run.status, "WAITING_FOR_PLAN_REVIEW");
  run = await service.review(run.projectId, run.id, { action: "CONFIRM_PLAN", expectedRevision: run.revision });
  run = await drain(service, run); assert.equal(run.status, "READY_FOR_PAID_CONFIRM");
});

test("truth pause resumes in place; source drift later blocks without paid effects", async () => {
  const { production, service } = rig(); production.truthReady = false;
  let run = await drain(service, await service.create("project-1", "truth", smartOptions));
  assert.equal(run.status, "WAITING_FOR_TRUTH_REVIEW"); assert.equal(production.counts.creative, 0);
  production.truthReady = true;
  run = await service.resume(run.projectId, run.id); run = await service.advance(run.projectId, run.id);
  production.sourcesChanged = true;
  run = await service.advance(run.projectId, run.id);
  assert.equal(run.blocker?.code, "SOURCE_CHANGED"); assert.equal(production.counts.creative, 0);
  await assert.rejects(service.resume(run.projectId, run.id), /来源/);
});

test("persisted pending installation resumes without generating the creative again", async () => {
  const { production, repo, service } = rig();
  let run = await service.create("project-1", "wal", smartOptions);
  run = await service.advance(run.projectId, run.id); run = await service.advance(run.projectId, run.id);
  assert.equal(run.pendingInstall, "CREATIVE");
  await production.install(run); // Crash after business commit, before orchestrator save.
  const restarted = new SmartGenerationService(repo, production);
  run = await restarted.advance(run.projectId, run.id);
  assert.equal(production.counts.creative, 1); assert.equal(production.counts.installs, 1); assert.equal(run.pendingInstall, undefined);
});

test("unknown generation never becomes a successful preview and cancellation is idempotent", async () => {
  const { production, service } = rig();
  let run = await drain(service, await service.create("project-1", "unknown", smartOptions));
  run = await service.confirmPaid(run.projectId, run.id, { scopeHash: run.paidScope!.hash, confirmPaidGeneration: true, acceptedUnknownCostRisk: true });
  production.unknownGeneration = true;
  run = await drain(service, run);
  assert.equal(run.status, "BLOCKED"); assert.equal(run.blocker?.code, "RECONCILE_REQUIRED"); assert.equal(run.finalOutput, undefined);
  run = await service.cancel(run.projectId, run.id); const revision = run.revision;
  assert.equal((await service.cancel(run.projectId, run.id)).revision, revision);
  assert.equal((await service.resume(run.projectId, run.id)).status, "CANCELLED"); assert.equal(production.counts.cancelled, 1);
});

test("schema refuses paid/ready states without actual bound consent/output", async () => {
  const { service } = rig(); const run = await service.create("project-1", "schema", smartOptions);
  assert.equal(smartRunSchema.safeParse({ ...run, status: "GENERATING" }).success, false);
  assert.equal(smartRunSchema.safeParse({ ...run, status: "COMPLETED" }).success, false);
});

test("SQLite smart store provides immutable checkpoints, one active run, exact-key idempotency and atomic leases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-smart-repo-"));
  const db = new PrismaClient({ datasources: { db: { url: "file:" + path.join(dir, "state.db").replaceAll("\\", "/") } } });
  try {
    await db.$executeRawUnsafe('CREATE TABLE "Project" ("id" TEXT NOT NULL PRIMARY KEY)');
    const sql = await fs.readFile(path.resolve("prisma/migrations/20260930064000_smart_generation_runs/migration.sql"), "utf8");
    for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    await db.$executeRaw`INSERT INTO "Project" ("id") VALUES (${"project-1"})`;
    const repo = new PrismaSmartRunRepository(db), service = new SmartGenerationService(repo, new FixtureProduction());
    let run = await service.create("project-1", "sqlite", smartOptions);
    assert.equal((await service.create("project-1", "sqlite", smartOptions)).id, run.id);
    await assert.rejects(service.create("project-1", "other", smartOptions), /未结束/);
    assert.equal(await repo.get("other-project", run.id), null);
    const claims = await Promise.all([repo.acquire(run.projectId, run.id, "a", process.pid), repo.acquire(run.projectId, run.id, "b", process.pid)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? "a" : "b";
    await repo.release(run.projectId, run.id, winner);
    assert.equal(await repo.acquire(run.projectId, run.id, "a", process.pid), true);
    await assert.rejects(repo.save(run, run.revision, "wrong"), /执行锁/);
    const stale = run; run = await repo.save({ ...run, status: "WAITING_FOR_TRUTH_REVIEW" }, run.revision, "a");
    await assert.rejects(repo.save(stale, stale.revision, "a"), /旧检查点/);
    const checkpoints = await db.$queryRaw<Array<{ revision: number; dataJson: string }>>`SELECT "revision","dataJson" FROM "SmartGenerationCheckpointRecord" WHERE "runId"=${run.id} ORDER BY "revision"`;
    assert.equal(checkpoints.length, 2); assert.equal(JSON.parse(checkpoints[0]!.dataJson).status, "PLANNING");
    await repo.release(run.projectId, run.id, "wrong"); assert.equal((await repo.lease(run.projectId, run.id))?.owner, "a");
    await repo.release(run.projectId, run.id, "a");
    run = await service.cancel(run.projectId, run.id);
    assert.notEqual((await service.create("project-1", "new", smartOptions)).id, run.id);
  } finally { await db.$disconnect(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("smart/batch pages have valid scripts and escape user creative input", async () => {
  const { service } = rig(); const run = await service.create("project-1", "ui", { ...smartOptions, requestText: "</script><script>bad()</script>" });
  const workspace = { project: { id: "project-1", name: "产品", status: "DRAFT" as const, targetPlatform: "douyin" as const, targetDurationMs: 15000, aspectRatio: "16:9", createdAt: ISO, updatedAt: ISO } };
  const imported = renderSmartGenerationPage(workspace, [], { useResearch: true, fromReference: true });
  assert.match(imported, /智能生成 · 一键成片/);
  assert.match(imported, /最终成片目标 15 秒/);
  assert.match(imported, /已从联网研究页进入/);
  assert.match(imported, /已从参考视频页进入/);
  assert.match(imported, /id="use-research" checked/);
  assert.match(imported, /id="use-research-references"/);
  assert.match(imported, /useResearchReferences/);
  assert.doesNotMatch(imported, /单视频生成/);
  for (const html of [renderSmartGenerationPage(workspace, []), renderSmartGenerationPage(workspace, [run]), imported, renderBatchGenerationPanel("project-1")]) {
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  }
});
