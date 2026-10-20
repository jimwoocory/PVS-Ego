import { hashValue } from "../src/domain/hashing.js";
import { smartRunSchema, closedSmartStatuses, type SmartGenerationRun, type SmartRunStatus, type WorkspaceBinding } from "../src/domain/smart-generation.js";
import type { SmartRunRepository } from "../src/application/ports/smart-run-repository.js";
import { SmartFlowPause, type SmartProduction } from "../src/application/ports/smart-production.js";
import { confirmScriptDraft, confirmProductionPlanDraft } from "../src/application/services/review-actions.js";
import { HermesProductDirectorGenerator } from "../src/adapters/ai/hermes-product-director-generator.js";
import { directorCase } from "./model-aware-fixtures.js";
import { H, ISO } from "./fixtures.js";
import {
  productionAssetSetSchema,
  productionStrategyRef,
  productionStrategySchema
} from "../src/domain/production-strategy.js";

export class MemorySmartRuns implements SmartRunRepository {
  runs = new Map<string, SmartGenerationRun>();
  locks = new Map<string, { owner: string; pid: number }>();
  history: SmartGenerationRun[] = [];
  async create(run: SmartGenerationRun) {
    const old = await this.findByRequestKey(run.projectId, run.requestKey);
    if (old) { if (old.inputHash !== run.inputHash) throw new Error("changed input"); return old; }
    if ([...this.runs.values()].some(r => r.projectId === run.projectId && !closedSmartStatuses.includes(r.status))) throw new Error("active run");
    this.runs.set(run.id, structuredClone(run)); this.history.push(structuredClone(run)); return structuredClone(run);
  }
  async get(pid: string, id: string) { const r = this.runs.get(id); return r?.projectId === pid ? structuredClone(r) : null; }
  async findByRequestKey(pid: string, key: string) { return structuredClone([...this.runs.values()].find(r => r.projectId === pid && r.requestKey === key) ?? null); }
  async list(pid?: string, statuses?: SmartRunStatus[]) { return structuredClone([...this.runs.values()].filter(r => (!pid || r.projectId === pid) && (!statuses || statuses.includes(r.status)))); }
  async save(raw: SmartGenerationRun, expected: number, owner: string) {
    if (this.runs.get(raw.id)?.revision !== expected || this.locks.get(raw.id)?.owner !== owner) throw new Error("revision/lease conflict");
    const run = smartRunSchema.parse({ ...raw, revision: expected + 1, updatedAt: new Date().toISOString() });
    this.runs.set(run.id, structuredClone(run)); this.history.push(structuredClone(run)); return structuredClone(run);
  }
  async acquire(pid: string, id: string, owner: string, osPid: number) { if (!await this.get(pid, id) || this.locks.has(id)) return false; this.locks.set(id, { owner, pid: osPid }); return true; }
  async release(_pid: string, id: string, owner: string) { if (this.locks.get(id)?.owner === owner) this.locks.delete(id); }
  async lease(_pid: string, id: string) { return this.locks.get(id) ?? null; }
  async releaseAbandoned(pid: string, id: string, previous: string) { await this.release(pid, id, previous); }
}

export const smartOptions = {
  requestText: "展示真实产品的使用方法", generationSettings: { requestedModelVersion: "seedance2.0mini", aspectRatio: "16:9", videoResolution: "720p", nativeAudioOutputRequested: false }, reviewMode: "AUTO" as const
};
export class FixtureProduction implements SmartProduction {
  readonly c = directorCase();
  counts = { creative: 0, planner: 0, assets: 0, script: 0, director: 0, approvals: 0, generate: 0, cancelled: 0, installs: 0, renders: 0 };
  truthReady = true; sourcesChanged = false; clipsReviewed = true; finalAccepted = false; unknownGeneration = false;
  installed = new Set<string>();
  async initial(_pid: string) { return { targetDurationMs: 15000, binding: {} }; }
  async sources(run: SmartGenerationRun) {
    if (!this.truthReady) throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW", "TRUTH", "事实待确认");
    return { truthRef: this.c.input.script.productTruthRef, assetsHash: H.a, creativeContext: { requestText: run.options.requestText }, expectedWorkspace: {} };
  }
  async assertCurrent(_run: SmartGenerationRun) { if (this.sourcesChanged) throw new SmartFlowPause("BLOCKED", "SOURCE_CHANGED", "来源改变", false); }
  async creative(_run: SmartGenerationRun) { this.counts.creative++; return structuredClone(this.c.input.creativeBatch); }
  async planProduction(run: SmartGenerationRun) {
    this.counts.planner++;
    const base = {
      id: "strategy-1",
      projectId: run.projectId,
      version: 1,
      selectedCreativeId: run.selectedCreativeId!,
      contentType: "PRODUCT_DEMO" as const,
      summary: "直接使用已确认产品参考，不需要新增固定角色或场景",
      rationale: ["单镜头产品演示不需要额外身份资产"],
      assetRequirements: [{
        key: "PRODUCT_MAIN",
        kind: "PRODUCT" as const,
        label: "当前产品",
        description: "已确认产品主参考",
        purpose: "保持产品身份",
        required: true,
        reuseScope: "RUN" as const,
        generationMode: "REUSE_PRODUCT_REFERENCE" as const,
        referenceAssetIds: ["product-main"],
        confidence: "HIGH" as const,
        needsReview: false
      }],
      plannerVersion: "fixture-v2",
      createdAt: ISO
    };
    return productionStrategySchema.parse({
      ...base,
      contentHash: hashValue(base)
    });
  }
  async prepareProductionAssets(run: SmartGenerationRun) {
    this.counts.assets++;
    const strategy = run.productionStrategy!;
    const now = ISO;
    const base = {
      id: "production-assets-1",
      projectId: run.projectId,
      version: 1,
      strategyRef: productionStrategyRef(strategy),
      selectedCreativeId: run.selectedCreativeId!,
      status: "READY" as const,
      entries: [{
        key: "PRODUCT_MAIN",
        referenceAssetId: "product-main",
        kind: "PRODUCT" as const,
        label: "当前产品",
        description: "已确认产品主参考",
        purpose: "保持产品身份",
        required: true,
        reuseScope: "RUN" as const,
        source: "PRODUCT_INPUT" as const,
        status: "READY" as const,
        artifactIds: ["artifact-product"],
        sourceReferenceAssetIds: ["product-main"],
        identityLock: ["保持产品身份"],
        confidence: "HIGH" as const,
        reviewSummary: "复用产品图"
      }],
      createdAt: now,
      updatedAt: now
    };
    return {
      set: productionAssetSetSchema.parse({
        ...base,
        contentHash: hashValue(base)
      })
    };
  }
  async advanceProductionAssets(run: SmartGenerationRun) {
    return run.productionAssetSet!;
  }
  async acceptProductionAsset(run: SmartGenerationRun) {
    return run.productionAssetSet!;
  }
  async script(_run: SmartGenerationRun) { this.counts.script++; return { ...structuredClone(this.c.input.script), status: "DRAFT" as const, confirmedAt: undefined }; }
  async director(run: SmartGenerationRun) {
    this.counts.director++;
    return new HermesProductDirectorGenerator({ id: "fixture", version: "1", generateJson: async () => structuredClone(this.c.proposal) }).generate({ ...this.c.input, script: run.script! });
  }
  async confirmScript(run: SmartGenerationRun) { return confirmScriptDraft(run.script!); }
  async confirmPlan(run: SmartGenerationRun) { return confirmProductionPlanDraft(run.productionPlan!); }
  async install(run: SmartGenerationRun): Promise<WorkspaceBinding> {
    const key = run.id + run.pendingInstall;
    if (!this.installed.has(key)) { this.installed.add(key); this.counts.installs++; }
    return {};
  }
  async preparePaidScope(run: SmartGenerationRun) {
    const p = run.productionPlan!;
    const planRef = { entityType: "ProductionPlan", entityId: p.id, version: p.version, hash: p.contentHash };
    const requests = [{ requestId: "request-1", requestHash: H.b, preflightId: "preflight-1", preflightHash: H.c, costStatus: "UNKNOWN" as const }];
    return { hash: hashValue({ planRef, requests }), planRef, requests, preparedAt: ISO };
  }
  async validatePaidScope(run: SmartGenerationRun) { await this.assertCurrent(run); if (!run.paidScope) throw new Error("scope missing"); }
  async approve(run: SmartGenerationRun) { if (!run.consent) throw new Error("no consent"); this.counts.approvals++; return ["attempt-1"]; }
  async generate(_run: SmartGenerationRun) { this.counts.generate++; if (this.unknownGeneration) throw new SmartFlowPause("BLOCKED", "RECONCILE_REQUIRED", "未知提交不能重提"); return { done: true }; }
  async reviewClips(_run: SmartGenerationRun) { if (!this.clipsReviewed) throw new SmartFlowPause("WAITING_FOR_CLIP_REVIEW", "REVIEW", "待审片"); }
  async autoEdit(_run: SmartGenerationRun) { return { timelineRef: { id: "timeline-1", hash: H.d }, autoEditArtifactId: "edit-1" }; }
  async render(_run: SmartGenerationRun) { this.counts.renders++; return { artifactId: "final-1", sha256: H.e, renderJobId: "render-1" }; }
  async cancel(_run: SmartGenerationRun) { this.counts.cancelled++; }
  async finalConfirmed(_run: SmartGenerationRun) { return this.finalAccepted; }
}
