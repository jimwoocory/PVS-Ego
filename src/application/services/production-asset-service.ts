import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ProductInputSnapshot } from "../ports/product-input-store.js";
import type { ProductionImageProvider } from "../ports/production-image-provider.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../ports/structured-ai-runtime.js";
import type { AssetRef, ProductTruth } from "../../domain/schemas.js";
import type { CreativeReferenceSet } from "../../domain/creative-reference.js";
import {
  assetPaidScopeSchema,
  productionAssetSetSchema,
  productionStrategyRef,
  type AssetPaidScope,
  type ProductionAssetEntry,
  type ProductionAssetSet,
  type ProductionStrategy
} from "../../domain/production-strategy.js";
import { hashValue } from "../../domain/hashing.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { CreativeReferenceService } from "./creative-reference-service.js";
import { ProductionImageSubmissionUnknownError } from "../../adapters/image/domestic-jimeng-image-provider.js";

const generatedAssetAssessmentSchema = z.object({
  status: z.enum(["PASS", "UNCERTAIN", "FAIL"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  summary: z.string().trim().min(1),
  identityLock: z.array(z.string().trim().min(1)).max(20)
}).strict();

const ASSET_SET_VERSION = 1;
const ASSET_REVIEW_VERSION = "production-asset-review-v2-1";
const REMOTE_QUEUE_FINISHED_GRACE_MS = 2 * 60 * 1000;
const LEGACY_REMOTE_STALE_AGE_MS = 10 * 60 * 1000;
import { PRODUCTION_IMAGE_PROFILE as IMAGE_GENERATION_PROFILE } from "../../domain/production-image-spec.js";

function setHash(value: Omit<ProductionAssetSet, "contentHash">): string {
  return hashValue(value);
}

function scopeHash(scope: Omit<AssetPaidScope, "hash">): string {
  const base = {
    strategyHash: scope.strategyHash,
    assets: scope.assets
  };
  return hashValue(
    scope.authorizationNonce
      ? { ...base, authorizationNonce: scope.authorizationNonce }
      : base
  );
}

function paidScopeForPlanned(
  strategy: ProductionStrategy,
  set: ProductionAssetSet
): AssetPaidScope {
  const planned = set.entries.filter(
    item =>
      item.source === "DREAMINA_GENERATED" &&
      item.status === "PLANNED"
  );
  if (!planned.length) {
    throw new Error("没有需要授权生成的制作资产");
  }
  const withoutHash: Omit<AssetPaidScope, "hash"> = {
    strategyHash: strategy.contentHash,
    authorizationNonce: randomUUID(),
    assets: planned.map(item => ({
      key: item.key,
      requestHash: item.generationRequestHash!,
      costStatus: "UNKNOWN" as const,
      costText: "即梦图片生成积分成本当前无法在提交前精确估计"
    })),
    preparedAt: new Date().toISOString()
  };
  return assetPaidScopeSchema.parse({
    ...withoutHash,
    hash: scopeHash(withoutHash)
  });
}

function statusForEntries(
  entries: ProductionAssetEntry[]
): ProductionAssetSet["status"] {
  if (entries.some(item => item.status === "FAILED" || item.status === "SUBMISSION_UNKNOWN")) {
    return "FAILED";
  }
  if (entries.some(item => item.status === "NEEDS_REVIEW")) {
    return "NEEDS_REVIEW";
  }
  if (entries.every(item => !item.required || item.status === "READY")) {
    return "READY";
  }
  if (entries.some(item => ["SUBMITTED", "PROCESSING"].includes(item.status))) {
    return "PREPARING";
  }
  return "PLANNED";
}

function withEntries(
  set: ProductionAssetSet,
  entries: ProductionAssetEntry[]
): ProductionAssetSet {
  const withoutHash = {
    ...set,
    status: statusForEntries(entries),
    entries,
    updatedAt: new Date().toISOString()
  };
  const { contentHash: _oldHash, ...hashable } = withoutHash;
  return productionAssetSetSchema.parse({
    ...withoutHash,
    contentHash: setHash(hashable)
  });
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function referenceAssetId(setId: string, key: string): string {
  return "production-asset:" + setId + ":" + key;
}

export type ProductionAssetPreparation = {
  set: ProductionAssetSet;
  paidScope?: AssetPaidScope;
};

export class ProductionAssetService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly imageProvider: ProductionImageProvider,
    private readonly reviewRuntime: StructuredAiRuntime,
    private readonly projectsRoot: string
  ) {}

  withImageProvider(provider:ProductionImageProvider){
    return new ProductionAssetService(this.artifacts,provider,this.reviewRuntime,this.projectsRoot);
  }

  async prepare(input: {
    strategy: ProductionStrategy;
    truth: ProductTruth;
    productInput: ProductInputSnapshot;
    creativeReferences?: CreativeReferenceSet | null;
  }): Promise<ProductionAssetPreparation> {
    const setId = randomUUID();
    const knownAssets = new Map<string, AssetRef>([
      ...input.productInput.assets.map(item => [item.id, item] as const),
      ...CreativeReferenceService.assets(input.creativeReferences ?? null)
        .map(item => [item.id, item] as const)
    ]);

    const entries: ProductionAssetEntry[] = input.strategy.assetRequirements.map(
      requirement => {
        if (requirement.generationMode === "REUSE_PRODUCT_REFERENCE") {
          const sourceId =
            requirement.referenceAssetIds[0] ?? input.truth.canonicalImageId;
          const source = knownAssets.get(sourceId);
          if (!source) {
            return {
              key: requirement.key,
              referenceAssetId: sourceId,
              kind: requirement.kind,
              label: requirement.label,
              description: requirement.description,
              purpose: requirement.purpose,
              required: requirement.required,
              reuseScope: requirement.reuseScope,
              source: "PRODUCT_INPUT" as const,
              status: "FAILED" as const,
              artifactIds: [],
              sourceReferenceAssetIds: [sourceId],
              dependsOnAssetKeys: requirement.dependsOnAssetKeys,
              identityLock: [],
              confidence: "LOW" as const,
              errorCode: "PRODUCT_REFERENCE_MISSING",
              errorMessage: "产品主参考图不存在或未准备"
            };
          }
          return {
            key: requirement.key,
            referenceAssetId: sourceId,
            kind: requirement.kind,
            label: requirement.label,
            description: requirement.description,
            purpose: requirement.purpose,
            required: requirement.required,
            reuseScope: requirement.reuseScope,
            source: "PRODUCT_INPUT" as const,
            status: "READY" as const,
            artifactIds: [source.artifactId],
            sourceReferenceAssetIds: [sourceId],
            dependsOnAssetKeys: requirement.dependsOnAssetKeys,
            identityLock: [
              "严格保持当前确认产品的形状、颜色、图案、材质和品牌身份",
              ...input.truth.forbiddenChanges.map(item => item.description)
            ],
            confidence: "HIGH" as const,
            reviewSummary: "复用已确认产品主参考图"
          };
        }

        if (requirement.generationMode === "REUSE_EXISTING_REFERENCE") {
          const resolved = requirement.referenceAssetIds
            .map(id => knownAssets.get(id))
            .filter((item): item is AssetRef => Boolean(item));
          if (!resolved.length) {
            return {
              key: requirement.key,
              referenceAssetId: referenceAssetId(setId, requirement.key),
              kind: requirement.kind,
              label: requirement.label,
              description: requirement.description,
              purpose: requirement.purpose,
              required: requirement.required,
              reuseScope: requirement.reuseScope,
              source: "CREATIVE_REFERENCE" as const,
              status: "FAILED" as const,
              artifactIds: [],
              sourceReferenceAssetIds: requirement.referenceAssetIds,
              dependsOnAssetKeys: requirement.dependsOnAssetKeys,
              identityLock: [],
              confidence: "LOW" as const,
              errorCode: "REFERENCE_ASSET_MISSING",
              errorMessage: "Planner 指定的现有参考素材不存在"
            };
          }
          return {
            key: requirement.key,
            referenceAssetId: requirement.referenceAssetIds[0] ?? resolved[0]!.id,
            kind: requirement.kind,
            label: requirement.label,
            description: requirement.description,
            purpose: requirement.purpose,
            required: requirement.required,
            reuseScope: requirement.reuseScope,
            source: "CREATIVE_REFERENCE" as const,
            status: requirement.needsReview ? "NEEDS_REVIEW" as const : "READY" as const,
            artifactIds: resolved.map(item => item.artifactId),
            sourceReferenceAssetIds: resolved.map(item => item.id),
            dependsOnAssetKeys: requirement.dependsOnAssetKeys,
            identityLock: [requirement.description],
            confidence: requirement.confidence,
            reviewSummary: requirement.needsReview
              ? "现有参考素材需要确认是否适合作为本轮固定制作资产"
              : "复用已确认创作参考素材"
          };
        }

        const requestHash = hashValue({
          strategyHash: input.strategy.contentHash,
          key: requirement.key,
          kind: requirement.kind,
          prompt: requirement.generationPrompt,
          sourceReferenceAssetIds: requirement.referenceAssetIds,
          dependsOnAssetKeys: requirement.dependsOnAssetKeys,
          profile: IMAGE_GENERATION_PROFILE
        });
        return {
          key: requirement.key,
          referenceAssetId: referenceAssetId(setId, requirement.key),
          kind: requirement.kind,
          label: requirement.label,
          description: requirement.description,
          purpose: requirement.purpose,
          required: requirement.required,
          reuseScope: requirement.reuseScope,
          source: "DREAMINA_GENERATED" as const,
          status: "PLANNED" as const,
          artifactIds: [],
          sourceReferenceAssetIds: requirement.referenceAssetIds,
          dependsOnAssetKeys: requirement.dependsOnAssetKeys,
          identityLock: [requirement.description],
          generationPrompt: requirement.generationPrompt,
          generationRequestHash: requestHash
        };
      }
    );

    const now = new Date().toISOString();
    const raw = {
      id: setId,
      projectId: input.strategy.projectId,
      version: ASSET_SET_VERSION,
      strategyRef: productionStrategyRef(input.strategy),
      selectedCreativeId: input.strategy.selectedCreativeId,
      status: statusForEntries(entries),
      entries,
      createdAt: now,
      updatedAt: now
    };
    const set = productionAssetSetSchema.parse({
      ...raw,
      contentHash: setHash(raw)
    });

    const generated = set.entries.filter(
      item => item.source === "DREAMINA_GENERATED" && item.status === "PLANNED"
    );
    if (!generated.length) return { set };

    const withoutHash = {
      strategyHash: input.strategy.contentHash,
      assets: generated.map(item => ({
        key: item.key,
        requestHash: item.generationRequestHash!,
        costStatus: "UNKNOWN" as const,
        costText: "即梦图片生成积分成本当前无法在提交前精确估计"
      })),
      preparedAt: now
    };
    const paidScope = assetPaidScopeSchema.parse({
      ...withoutHash,
      hash: scopeHash(withoutHash)
    });
    return { set, paidScope };
  }

  async validatePaidScope(input: {
    strategy: ProductionStrategy;
    set: ProductionAssetSet;
    scope: AssetPaidScope;
  }): Promise<void> {
    if (input.scope.strategyHash !== input.strategy.contentHash) {
      throw new Error("制作资产付费范围已失效：策略发生变化");
    }
    if (scopeHash({
      strategyHash: input.scope.strategyHash,
      assets: input.scope.assets,
      preparedAt: input.scope.preparedAt,
      ...(input.scope.authorizationNonce
        ? { authorizationNonce: input.scope.authorizationNonce }
        : {})
    }) !== input.scope.hash) {
      throw new Error("制作资产付费范围哈希不匹配");
    }
    const planned = input.set.entries
      .filter(item => item.source === "DREAMINA_GENERATED" && item.status === "PLANNED")
      .map(item => ({ key: item.key, requestHash: item.generationRequestHash! }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const scoped = input.scope.assets
      .map(item => ({ key: item.key, requestHash: item.requestHash }))
      .sort((a, b) => a.key.localeCompare(b.key));
    if (hashValue(planned) !== hashValue(scoped)) {
      throw new Error("制作资产付费范围没有精确覆盖当前待生成资产");
    }
    const probe = await this.imageProvider.probe();
    if (!probe.ready) {
      throw new Error(
        "即梦图片生成能力当前不可用：" + (probe.reason ?? "未知原因")
      );
    }
  }

  async advance(input: {
    concurrency?:number;
    set: ProductionAssetSet;
    strategy: ProductionStrategy;
    productInput: ProductInputSnapshot;
    creativeReferences?: CreativeReferenceSet | null;
  }): Promise<ProductionAssetSet> {
    const set = input.set;
    const byKey = new Map(set.entries.map(item => [item.key, item] as const));
    const dependenciesReady = (entry: ProductionAssetEntry) =>
      entry.dependsOnAssetKeys.every(
        key => byKey.get(key)?.status === "READY"
      );

    const dependencyReferencePaths = async (
      entry: ProductionAssetEntry
    ): Promise<string[]> => {
      const paths: string[] = [];
      for (const key of entry.dependsOnAssetKeys) {
        const dependency = byKey.get(key);
        const artifactId = dependency?.artifactIds[0];
        if (!dependency || dependency.status !== "READY" || !artifactId) {
          throw new Error(
            "制作资产依赖尚未确认：" + (dependency?.label ?? key)
          );
        }
        const artifact = await this.artifacts.findById(artifactId);
        if (
          !artifact ||
          artifact.projectId !== set.projectId ||
          artifact.integrityStatus !== "READY" ||
          !artifact.mimeType?.startsWith("image/")
        ) {
          throw new Error(
            "制作资产依赖图片不可用：" + dependency.label
          );
        }
        paths.push(
          path.resolve(this.projectsRoot, set.projectId, artifact.relativePath)
        );
      }
      return paths;
    };

    const advanceOne = async (
      entry: ProductionAssetEntry
    ): Promise<ProductionAssetEntry> => {
      if (entry.status === "PLANNED") {
        try {
          const references = [
            ...await this.resolveReferencePaths(
              entry.sourceReferenceAssetIds,
              input.productInput,
              input.creativeReferences
            ),
            ...await dependencyReferencePaths(entry)
          ];
          const submitted = await this.imageProvider.submit({
            projectId: set.projectId,
            businessKey: entry.key,
            requestHash: entry.generationRequestHash!,
            kind: entry.kind === "PRODUCT"
              ? "PRODUCT_STATE"
              : entry.kind as "CHARACTER" | "SET" | "PROP" | "PRODUCT_STATE" | "STYLE",
            prompt: entry.generationPrompt!,
            ...(references.length
              ? { referenceImagePaths: [...new Set(references)] }
              : {})
          });
          return {
            ...entry,
            status: "SUBMITTED",
            submitId: submitted.submitId,
            submittedAt: new Date().toISOString(),
            queueFinishedAt: undefined,
            errorCode: undefined,
            errorMessage: undefined
          };
        } catch (error) {
          return {
            ...entry,
            status:
              error instanceof ProductionImageSubmissionUnknownError
                ? "SUBMISSION_UNKNOWN"
                : "FAILED",
            errorCode:
              error instanceof ProductionImageSubmissionUnknownError
                ? "ASSET_SUBMISSION_OUTCOME_UNKNOWN"
                : "ASSET_SUBMIT_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error)
          };
        }
      }

      if (!entry.submitId) {
        return {
          ...entry,
          status: "FAILED",
          errorCode: "ASSET_SUBMIT_ID_MISSING",
          errorMessage: "制作资产缺少可恢复的任务编号"
        };
      }

      const remote = await this.imageProvider.status(entry.submitId);
      if (remote.status === "SUBMITTED" || remote.status === "PROCESSING") {
        const now = new Date();
        const nowIso = now.toISOString();
        if (
          remote.status === "PROCESSING" &&
          remote.observation === "QUEUE_FINISHED_WITHOUT_RESULT"
        ) {
          const queueFinishedAt = entry.queueFinishedAt ?? nowIso;
          const queueFinishedMs = Date.parse(queueFinishedAt);
          const legacySetCreatedMs = Date.parse(set.createdAt);
          const legacyAlreadyStale =
            !entry.queueFinishedAt &&
            !entry.submittedAt &&
            Number.isFinite(legacySetCreatedMs) &&
            now.getTime() - legacySetCreatedMs >=
              LEGACY_REMOTE_STALE_AGE_MS;
          if (
            legacyAlreadyStale ||
            (Number.isFinite(queueFinishedMs) &&
              now.getTime() - queueFinishedMs >=
                REMOTE_QUEUE_FINISHED_GRACE_MS)
          ) {
            return {
              ...entry,
              status: "SUBMISSION_UNKNOWN",
              queueFinishedAt,
              errorCode: "ASSET_REMOTE_RESULT_STALE",
              errorMessage:
                "即梦队列已经结束，但平台长时间仍显示处理中，而且没有返回图片产物。" +
                "原任务记录已保留，系统不会自动重提；如确认这次任务没有产物，需要重新授权生成此资产。"
            };
          }
          return {
            ...entry,
            status: "PROCESSING",
            queueFinishedAt,
            errorCode: undefined,
            errorMessage: undefined
          };
        }
        return {
          ...entry,
          status: remote.status,
          queueFinishedAt: undefined,
          errorCode: undefined,
          errorMessage: undefined
        };
      }
      if (remote.status === "FAILED") {
        return {
          ...entry,
          status: "FAILED",
          errorCode: "ASSET_REMOTE_FAILED",
          errorMessage: remote.reason ?? "即梦制作资产生成失败"
        };
      }
      if (remote.status === "UNKNOWN" || remote.status !== "SUCCEEDED") {
        return entry;
      }

      const projectRoot = path.resolve(this.projectsRoot, set.projectId);
      const tempDir = path.join(
        projectRoot,
        ".tmp",
        "production-asset-" + set.id + "-" + entry.key
      );
      try {
        await fs.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, "result.jpg");
        const downloaded = await this.imageProvider.download(remote.imageUrl, tempPath);
        const bytes = await fs.readFile(downloaded.path);
        const artifactId = entry.referenceAssetId;
        let artifact = await this.artifacts.findById(artifactId);
        if (!artifact) {
          artifact = await new LocalArtifactStore(
            projectRoot,
            this.artifacts
          ).writeImmutable({
            id: artifactId,
            projectId: set.projectId,
            kind: "OTHER",
            immutable: true,
            relativePath:
              "production-assets/" +
              set.id +
              "/" +
              entry.key +
              "/reference-" +
              hashValue(artifactId).slice(0, 16) +
              extensionFor(downloaded.mimeType),
            bytes,
            mimeType: downloaded.mimeType
          });
        }
        if (
          artifact.projectId !== set.projectId ||
          artifact.integrityStatus !== "READY"
        ) {
          throw new Error("制作资产文件状态异常：" + entry.label);
        }
        let assessment: {
          confidence: "HIGH" | "MEDIUM" | "LOW";
          identityLock: string[];
          summary: string;
        };
        let reviewUnavailable = false;
        try {
          assessment = await this.reviewGeneratedAsset({
            projectId: set.projectId,
            entry,
            generated: {
              mimeType: downloaded.mimeType,
              bytes
            },
            productInput: input.productInput,
            creativeReferences: input.creativeReferences,
            productionAssetSet: set
          });
        } catch {
          // The image has already been saved. An optional AI assessment must
          // never hide it or cause a second paid image generation request.
          reviewUnavailable = true;
          assessment = {
            confidence: "LOW",
            identityLock: entry.identityLock,
            summary: "原任务图片已保存；自动视觉检查暂时不可用，请展开图片人工核实后确认。"
          };
        }
        return {
          ...entry,
          status: "NEEDS_REVIEW",
          artifactIds: [artifact.id],
          confidence: assessment.confidence,
          identityLock:
            assessment.identityLock.length
              ? assessment.identityLock
              : entry.identityLock,
          reviewSummary: assessment.summary,
          humanConfirmedAt: undefined,
          resultReceiveFailures: undefined,
          errorCode: reviewUnavailable ? "ASSET_VISUAL_REVIEW_UNAVAILABLE" : undefined,
          errorMessage: reviewUnavailable ? "视觉检查暂时不可用，原图片已保留，需要人工确认" : undefined
        };
      } catch (error) {
        const resultReceiveFailures = (entry.resultReceiveFailures ?? 0) + 1;
        // Requery the original submit ID on the next tick. No paid submit is involved.
        const exhausted = resultReceiveFailures >= 3;
        return {
          ...entry,
          status: exhausted ? "FAILED" : "PROCESSING",
          resultReceiveFailures,
          errorCode: exhausted
            ? "ASSET_RESULT_PROCESSING_FAILED"
            : "ASSET_RESULT_RECEIVE_RETRY",
          errorMessage:
            "原即梦图片结果接收中断（已尝试 " + resultReceiveFailures +
            "/3 轮，未重新生图）："
            + (error instanceof Error ? error.message : String(error))
        };
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    const active = set.entries.filter(
      item =>
        item.source === "DREAMINA_GENERATED" &&
        ["PLANNED", "SUBMITTED", "PROCESSING"].includes(item.status) &&
        (item.status !== "PLANNED" || dependenciesReady(item))
    );
    if (!active.length) return set;

    const updated = new Map<string, ProductionAssetEntry>();
    const maxParallel = Math.max(1,Math.min(4,input.concurrency??4));
    for (let index = 0; index < active.length; index += maxParallel) {
      const batch = active.slice(index, index + maxParallel);
      const results = await Promise.all(batch.map(item => advanceOne(item)));
      for (const item of results) updated.set(item.key, item);
    }
    return withEntries(
      set,
      set.entries.map(item => updated.get(item.key) ?? item)
    );
  }

  /** Reopen ONLY a failed local result-processing step, preserving submitId and credit consent. */
  recoverResultProcessing(set: ProductionAssetSet): ProductionAssetSet {
    const entries = set.entries.map(entry => {
      if (
        entry.source !== "DREAMINA_GENERATED" ||
        entry.status !== "FAILED" ||
        entry.errorCode !== "ASSET_RESULT_PROCESSING_FAILED" ||
        !entry.submitId
      ) return entry;
      return {
        ...entry,
        status: "PROCESSING" as const,
        resultReceiveFailures: 0,
        errorCode: undefined,
        errorMessage: undefined
      };
    });
    return entries.some((entry, i) => entry !== set.entries[i])
      ? withEntries(set, entries)
      : set;
  }

  acceptReview(set: ProductionAssetSet, key: string): ProductionAssetSet {
    const entries = set.entries.map(item => {
      if (item.key !== key) return item;
      if (item.status !== "NEEDS_REVIEW" || item.artifactIds.length === 0) {
        throw new Error("当前制作资产不处于可确认状态");
      }
      return {
        ...item,
        status: "READY" as const,
        humanConfirmedAt: new Date().toISOString(),
        reviewSummary:
          (item.reviewSummary ? item.reviewSummary + "；" : "") +
          "用户已明确确认用于本轮生产"
      };
    });
    return withEntries(set, entries);
  }

  reconcileHumanReview(set: ProductionAssetSet): ProductionAssetSet {
    let changed = false;
    const entries = set.entries.map(item => {
      if (
        item.source !== "DREAMINA_GENERATED" ||
        item.status !== "READY" ||
        item.artifactIds.length === 0 ||
        item.humanConfirmedAt
      ) {
        return item;
      }
      changed = true;
      if (item.reviewSummary?.includes("用户已明确确认用于本轮生产")) {
        return {
          ...item,
          humanConfirmedAt: set.updatedAt
        };
      }
      return {
        ...item,
        status: "NEEDS_REVIEW" as const,
        reviewSummary:
          item.reviewSummary ??
          "旧任务中的生成资产尚未记录用户确认，需要重新看图确认。"
      };
    });
    return changed ? withEntries(set, entries) : set;
  }

  updatePrompt(
    set: ProductionAssetSet,
    strategy: ProductionStrategy,
    key: string,
    prompt: string
  ): { set: ProductionAssetSet; paidScope: AssetPaidScope } {
    if (set.strategyRef.hash !== strategy.contentHash) {
      throw new Error("制作资产策略已变化，不能修改旧提示词");
    }
    const normalized = prompt.trim();
    if (!normalized) throw new Error("制作资产提示词不能为空");
    if (normalized.length > 12000) throw new Error("制作资产提示词过长");
    const target = set.entries.find(item => item.key === key);
    if (
      !target ||
      target.source !== "DREAMINA_GENERATED" ||
      target.status !== "PLANNED"
    ) {
      throw new Error("当前制作资产不处于可修改提示词状态");
    }
    const requestHash = hashValue({
      strategyHash: strategy.contentHash,
      key: target.key,
      kind: target.kind,
      prompt: normalized,
      sourceReferenceAssetIds: target.sourceReferenceAssetIds,
      dependsOnAssetKeys: target.dependsOnAssetKeys,
      profile: IMAGE_GENERATION_PROFILE
    });
    const updated = withEntries(
      set,
      set.entries.map(item =>
        item.key === key
          ? {
              ...item,
              generationPrompt: normalized,
              generationRequestHash: requestHash
            }
          : item
      )
    );
    return { set: updated, paidScope: paidScopeForPlanned(strategy, updated) };
  }

  regenerateReview(
    set: ProductionAssetSet,
    strategy: ProductionStrategy,
    key: string,
    prompt?: string
  ): { set: ProductionAssetSet; paidScope: AssetPaidScope } {
    if (set.strategyRef.hash !== strategy.contentHash) {
      throw new Error("制作资产策略已变化，不能沿用旧的重新生成请求");
    }
    const target = set.entries.find(item => item.key === key);
    if (
      !target ||
      target.source !== "DREAMINA_GENERATED" ||
      !["NEEDS_REVIEW", "READY"].includes(target.status) ||
      target.artifactIds.length === 0
    ) {
      throw new Error("当前制作资产不处于可重新生成状态");
    }
    const normalized = (prompt ?? target.generationPrompt ?? "").trim();
    if (!normalized) throw new Error("制作资产提示词不能为空");
    if (normalized.length > 12000) throw new Error("制作资产提示词过长");
    const requestHash = hashValue({
      strategyHash: strategy.contentHash,
      key: target.key,
      kind: target.kind,
      prompt: normalized,
      sourceReferenceAssetIds: target.sourceReferenceAssetIds,
      dependsOnAssetKeys: target.dependsOnAssetKeys,
      profile: IMAGE_GENERATION_PROFILE
    });
    const reset = withEntries(
      set,
      set.entries.map(item =>
        item.key !== key
          ? item
          : {
              ...item,
              referenceAssetId:
                referenceAssetId(set.id, item.key) + ":regen:" + randomUUID(),
              status: "PLANNED" as const,
              artifactIds: [],
              generationPrompt: normalized,
              generationRequestHash: requestHash,
              submitId: undefined,
              submittedAt: undefined,
              queueFinishedAt: undefined,
              confidence: undefined,
              reviewSummary: undefined,
              humanConfirmedAt: undefined,
              errorCode: undefined,
              errorMessage: undefined
            }
      )
    );
    return { set: reset, paidScope: paidScopeForPlanned(strategy, reset) };
  }

  retryUnknown(
    set: ProductionAssetSet,
    strategy: ProductionStrategy,
    key: string,
    prompt?: string
  ): { set: ProductionAssetSet; paidScope: AssetPaidScope } {
    if (set.strategyRef.hash !== strategy.contentHash) {
      throw new Error("制作资产策略已变化，不能沿用旧的重试请求");
    }
    const target = set.entries.find(item => item.key === key);
    if (
      !target ||
      target.source !== "DREAMINA_GENERATED" ||
      target.status !== "SUBMISSION_UNKNOWN" ||
      target.errorCode !== "ASSET_REMOTE_RESULT_STALE"
    ) {
      throw new Error("当前制作资产不是可重新准备的悬挂任务");
    }

    const normalized = (prompt ?? target.generationPrompt ?? "").trim();
    if (!normalized) throw new Error("制作资产提示词不能为空");
    if (normalized.length > 12000) throw new Error("制作资产提示词过长");
    const requestHash = hashValue({
      strategyHash: strategy.contentHash,
      key: target.key,
      kind: target.kind,
      prompt: normalized,
      sourceReferenceAssetIds: target.sourceReferenceAssetIds,
      dependsOnAssetKeys: target.dependsOnAssetKeys,
      profile: IMAGE_GENERATION_PROFILE
    });
    const entries = set.entries.map(item =>
      item.key !== key
        ? item
        : {
            ...item,
            status: "PLANNED" as const,
            generationPrompt: normalized,
            generationRequestHash: requestHash,
            submitId: undefined,
            submittedAt: undefined,
            queueFinishedAt: undefined,
            errorCode: undefined,
            errorMessage: undefined
          }
    );
    const reset = withEntries(set, entries);
    return { set: reset, paidScope: paidScopeForPlanned(strategy, reset) };
  }

  async toAssetRefs(
    set: ProductionAssetSet,
    requiredReferenceIds?: ReadonlySet<string>
  ): Promise<AssetRef[]> {
    const refs: AssetRef[] = [];
    for (const entry of set.entries) {
      if (
        entry.source !== "DREAMINA_GENERATED" ||
        entry.status !== "READY" ||
        (requiredReferenceIds !== undefined &&
          !requiredReferenceIds.has(entry.referenceAssetId)) ||
        !entry.artifactIds[0]
      ) continue;
      const artifact = await this.artifacts.findById(entry.artifactIds[0]);
      if (
        !artifact ||
        artifact.projectId !== set.projectId ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256 ||
        artifact.sizeBytes === undefined ||
        !artifact.mimeType?.startsWith("image/")
      ) {
        throw new Error("制作资产文件不可用：" + entry.label);
      }
      refs.push({
        id: entry.referenceAssetId,
        artifactId: artifact.id,
        type: "image",
        source: "generated",
        originalFilename: entry.label + extensionFor(artifact.mimeType),
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        provenance: "ProductionAssetSet " + set.id + " / " + entry.key,
        createdAt: artifact.createdAt
      });
    }
    return refs;
  }

  private async resolveReferencePaths(
    ids: string[],
    productInput: ProductInputSnapshot,
    creativeReferences?: CreativeReferenceSet | null
  ): Promise<string[]> {
    const known = new Map<string, AssetRef>([
      ...productInput.assets.map(item => [item.id, item] as const),
      ...CreativeReferenceService.assets(creativeReferences ?? null)
        .map(item => [item.id, item] as const)
    ]);
    const paths: string[] = [];
    for (const id of ids) {
      const asset = known.get(id);
      if (!asset) continue;
      const artifact = await this.artifacts.findById(asset.artifactId);
      if (
        !artifact ||
        artifact.integrityStatus !== "READY" ||
        !artifact.mimeType?.startsWith("image/")
      ) continue;
      paths.push(
        path.resolve(this.projectsRoot, productInput.projectId, artifact.relativePath)
      );
    }
    return paths;
  }

  private async reviewGeneratedAsset(input: {
    projectId: string;
    entry: ProductionAssetEntry;
    generated: {
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      bytes: Buffer;
    };
    productInput: ProductInputSnapshot;
    creativeReferences?: CreativeReferenceSet | null;
    productionAssetSet?: ProductionAssetSet;
  }) {
    const media: Array<{
      type: "image";
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      dataBase64: string;
      label?: string;
    }> = [
      {
        type: "image",
        mimeType: input.generated.mimeType,
        dataBase64: input.generated.bytes.toString("base64"),
        label: "generated-production-asset"
      }
    ];

    const sourcePaths = await this.resolveReferencePaths(
      input.entry.sourceReferenceAssetIds.slice(0, 2),
      input.productInput,
      input.creativeReferences
    );
    if (input.productionAssetSet) {
      for (const dependencyKey of input.entry.dependsOnAssetKeys) {
        const dependency = input.productionAssetSet.entries.find(
          item => item.key === dependencyKey
        );
        const artifactId = dependency?.artifactIds[0];
        if (!dependency || dependency.status !== "READY" || !artifactId) continue;
        const artifact = await this.artifacts.findById(artifactId);
        if (
          artifact &&
          artifact.projectId === input.projectId &&
          artifact.integrityStatus === "READY" &&
          artifact.mimeType?.startsWith("image/")
        ) {
          sourcePaths.push(
            path.resolve(this.projectsRoot, input.projectId, artifact.relativePath)
          );
        }
      }
    }
    for (let i = 0; i < sourcePaths.length; i++) {
      const bytes = await fs.readFile(sourcePaths[i]!);
      const ext = path.extname(sourcePaths[i]!).toLowerCase();
      media.push({
        type: "image",
        mimeType:
          ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : "image/jpeg",
        dataBase64: bytes.toString("base64"),
        label: "source-reference-" + (i + 1)
      });
    }

    const result = await generateStructuredJson(this.reviewRuntime, {
      task: "Assess whether a generated reusable production asset is safe to lock for downstream multi-clip video generation.",
      instructions: [
        "所有 summary 和 identityLock 文本必须使用简体中文；不可避免的品牌名或型号除外。",
        "Judge only visible identity, usability and consistency against the supplied requirement.",
        "For CHARACTER: require one coherent adult identity, stable face/hair/body/wardrobe cues, no duplicate person alternatives, no readable text.",
        "For SET: require one coherent reusable space with readable spatial layout, no unexplained duplicate layouts, no readable text.",
        "For PROP/STYLE: require one coherent reusable design and no readable text unless explicitly requested.",
        "For PRODUCT_STATE: compare against supplied source product reference; reject or mark uncertain if shape, color, pattern, brand identity or physical structure drifts.",
        "Use HIGH confidence only when the asset is clear enough to bind downstream video identity.",
        "Do not infer hidden product facts."
      ].join(" "),
      input: {
        kind: input.entry.kind,
        label: input.entry.label,
        description: input.entry.description,
        purpose: input.entry.purpose,
        expectedIdentityLock: input.entry.identityLock,
        reviewVersion: ASSET_REVIEW_VERSION
      },
      outputContract: {
        status: "PASS|UNCERTAIN|FAIL",
        confidence: "HIGH|MEDIUM|LOW",
        summary: "简短中文检查结论",
        identityLock: ["中文可见稳定特征"]
      },
      media,
      context: {
        projectId: input.projectId,
        step: "AUTO_EDIT_VISUAL"
      }
    });
    return generatedAssetAssessmentSchema.parse(result.data);
  }
}
