import { z } from "zod";
import {
  aiExecutionRefSchema,
  entityIdSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  riskLevelSchema,
  sha256Schema,
  versionRefSchema
} from "./schemas.js";

export const productionContentTypeSchema = z.enum([
  "SHORT_DRAMA",
  "PRODUCT_DEMO",
  "HOST",
  "UGC",
  "CG",
  "MIXED"
]);

export const productionAssetKindSchema = z.enum([
  "CHARACTER",
  "SET",
  "PROP",
  "PRODUCT",
  "PRODUCT_STATE",
  "STYLE"
]);

export const productionAssetReuseScopeSchema = z.enum([
  "RUN",
  "MULTI_CLIP",
  "SINGLE_CLIP"
]);

export const productionAssetGenerationModeSchema = z.enum([
  "REUSE_PRODUCT_REFERENCE",
  "REUSE_EXISTING_REFERENCE",
  "GENERATE_IMAGE"
]);

export const productionAssetRequirementSchema = z.object({
  key: nonEmptyStringSchema,
  kind: productionAssetKindSchema,
  label: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  purpose: nonEmptyStringSchema,
  required: z.boolean(),
  reuseScope: productionAssetReuseScopeSchema,
  generationMode: productionAssetGenerationModeSchema,
  generationPrompt: nonEmptyStringSchema.optional(),
  referenceAssetIds: z.array(entityIdSchema).max(12).default([]),
  dependsOnAssetKeys: z.array(nonEmptyStringSchema).max(12).default([]),
  clipCountHint: z.number().int().positive().optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  needsReview: z.boolean()
}).strict();

export const productionStrategySchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  selectedCreativeId: entityIdSchema,
  contentType: productionContentTypeSchema,
  summary: nonEmptyStringSchema,
  rationale: z.array(nonEmptyStringSchema).min(1).max(12),
  assetRequirements: z.array(productionAssetRequirementSchema).min(1).max(24),
  plannerVersion: nonEmptyStringSchema,
  aiExecution: aiExecutionRefSchema.optional(),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema
}).superRefine((strategy, ctx) => {
  const keys = strategy.assetRequirements.map(item => item.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: "custom",
      path: ["assetRequirements"],
      message: "Production asset requirement keys must be unique"
    });
  }
  if (!strategy.assetRequirements.some(item => item.kind === "PRODUCT")) {
    ctx.addIssue({
      code: "custom",
      path: ["assetRequirements"],
      message: "Production strategy must include the product reference"
    });
  }
  const byKey = new Map(strategy.assetRequirements.map(item => [item.key, item]));
  for (const [index, item] of strategy.assetRequirements.entries()) {
    for (const dependencyKey of item.dependsOnAssetKeys) {
      if (dependencyKey === item.key) {
        ctx.addIssue({
          code: "custom",
          path: ["assetRequirements", index, "dependsOnAssetKeys"],
          message: "Production asset cannot depend on itself"
        });
      } else if (!byKey.has(dependencyKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["assetRequirements", index, "dependsOnAssetKeys"],
          message: "Production asset dependency must reference another asset key"
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependencyKey of byKey.get(key)?.dependsOnAssetKeys ?? []) {
      if (hasCycle(dependencyKey)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if (strategy.assetRequirements.some(item => hasCycle(item.key))) {
    ctx.addIssue({
      code: "custom",
      path: ["assetRequirements"],
      message: "Production asset dependencies must be acyclic"
    });
  }
});

export const productionAssetStatusSchema = z.enum([
  "PLANNED",
  "SUBMISSION_UNKNOWN",
  "SUBMITTED",
  "PROCESSING",
  "READY",
  "NEEDS_REVIEW",
  "FAILED"
]);

export const productionAssetSourceSchema = z.enum([
  "PRODUCT_INPUT",
  "CREATIVE_REFERENCE",
  "DREAMINA_GENERATED"
]);

export const productionAssetEntrySchema = z.object({
  key: nonEmptyStringSchema,
  referenceAssetId: entityIdSchema,
  kind: productionAssetKindSchema,
  label: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  purpose: nonEmptyStringSchema,
  required: z.boolean(),
  reuseScope: productionAssetReuseScopeSchema,
  source: productionAssetSourceSchema,
  status: productionAssetStatusSchema,
  artifactIds: z.array(entityIdSchema).max(12).default([]),
  sourceReferenceAssetIds: z.array(entityIdSchema).max(12).default([]),
  dependsOnAssetKeys: z.array(nonEmptyStringSchema).max(12).default([]),
  identityLock: z.array(nonEmptyStringSchema).max(20).default([]),
  generationPrompt: nonEmptyStringSchema.optional(),
  generationRequestHash: sha256Schema.optional(),
  submitId: nonEmptyStringSchema.optional(),
  submittedAt: isoDateTimeSchema.optional(),
  queueFinishedAt: isoDateTimeSchema.optional(),
  resultReceiveFailures: z.number().int().nonnegative().optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  reviewSummary: nonEmptyStringSchema.optional(),
  humanConfirmedAt: isoDateTimeSchema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  errorMessage: nonEmptyStringSchema.optional()
}).strict().superRefine((entry, ctx) => {
  if (entry.status === "READY" && entry.artifactIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["artifactIds"],
      message: "READY production asset requires at least one artifact"
    });
  }
});

export const productionAssetSetStatusSchema = z.enum([
  "PLANNED",
  "PREPARING",
  "READY",
  "NEEDS_REVIEW",
  "FAILED"
]);

export const productionAssetSetSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  version: z.number().int().positive(),
  strategyRef: versionRefSchema,
  selectedCreativeId: entityIdSchema,
  status: productionAssetSetStatusSchema,
  entries: z.array(productionAssetEntrySchema).min(1).max(24),
  contentHash: sha256Schema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).superRefine((set, ctx) => {
  const keys = set.entries.map(item => item.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: "custom",
      path: ["entries"],
      message: "Production asset keys must be unique"
    });
  }
  if (set.status === "READY" && set.entries.some(item => item.required && item.status !== "READY")) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "READY production asset set requires every required asset to be READY"
    });
  }
});

export const assetPaidScopeSchema = z.object({
  hash: sha256Schema,
  strategyHash: sha256Schema,
  authorizationNonce: entityIdSchema.optional(),
  assets: z.array(z.object({
    key: nonEmptyStringSchema,
    requestHash: sha256Schema,
    costStatus: z.enum(["KNOWN", "UNKNOWN"]),
    estimatedCredits: z.number().nonnegative().optional(),
    costText: z.string().optional()
  }).strict()).min(1),
  preparedAt: isoDateTimeSchema
}).strict();

export const audioIntentSchema = z.enum([
  "SILENT",
  "DIALOGUE",
  "NARRATION",
  "AMBIENT",
  "MIXED"
]);

export type ProductionStrategy = z.infer<typeof productionStrategySchema>;
export type ProductionAssetRequirement = z.infer<typeof productionAssetRequirementSchema>;
export type ProductionAssetSet = z.infer<typeof productionAssetSetSchema>;
export type ProductionAssetEntry = z.infer<typeof productionAssetEntrySchema>;
export type AssetPaidScope = z.infer<typeof assetPaidScopeSchema>;
export type AudioIntent = z.infer<typeof audioIntentSchema>;

export function productionStrategyRef(strategy: ProductionStrategy) {
  return {
    entityType: "ProductionStrategy",
    entityId: strategy.id,
    version: strategy.version,
    hash: strategy.contentHash
  };
}

export function productionAssetSetRef(set: ProductionAssetSet) {
  return {
    entityType: "ProductionAssetSet",
    entityId: set.id,
    version: set.version,
    hash: set.contentHash
  };
}

export function productionAssetRisk(strategy: ProductionStrategy): "LOW" | "MEDIUM" | "HIGH" {
  if (strategy.assetRequirements.some(item => item.confidence === "LOW")) return "HIGH";
  if (strategy.assetRequirements.some(item => item.confidence === "MEDIUM" || item.needsReview)) return "MEDIUM";
  return "LOW";
}

export function productionAssetRiskSchema() {
  return riskLevelSchema;
}
