import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CreativeBatch,
  ProductTruth,
  ReferenceVideoProfile
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import {
  productionAssetRequirementSchema,
  productionStrategySchema,
  type ProductionStrategy
} from "../../domain/production-strategy.js";
import type { CreativeProductionContext } from "../../domain/smart-generation.js";
import {
  generateStructuredJson,
  type StructuredAiRuntime
} from "../ports/structured-ai-runtime.js";

const plannerProposalSchema = z.object({
  contentType: z.enum([
    "SHORT_DRAMA",
    "PRODUCT_DEMO",
    "HOST",
    "UGC",
    "CG",
    "MIXED"
  ]),
  summary: z.string().trim().min(1),
  rationale: z.array(z.string().trim().min(1)).min(1).max(12),
  assetRequirements: z.array(productionAssetRequirementSchema).max(24)
}).strict();

const missingAssetPromptsSchema = z.object({
  prompts: z.array(z.object({
    key: z.string().trim().min(1),
    generationPrompt: z.string().trim().min(1)
  }).strict()).min(1).max(24)
}).strict();

/** Reused references have no image generation prompt; models often emit "" anyway. */
function normalizePlannerAssetPrompts(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const proposal = raw as Record<string, unknown>;
  if (!Array.isArray(proposal.assetRequirements)) return raw;
  return {
    ...proposal,
    assetRequirements: proposal.assetRequirements.map((asset: unknown) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return asset;
      const record = asset as Record<string, unknown>;
      if (
        record.generationMode === "GENERATE_IMAGE" &&
        !(typeof record.generationPrompt === "string" && !record.generationPrompt.trim())
      ) return record;
      const { generationPrompt: _unused, ...withoutPrompt } = record;
      return withoutPrompt;
    })
  };
}

function plannerFormatError(error: z.ZodError): Error {
  const field = error.issues[0]?.path.join(".") || "制作策略";
  return new Error(
    "AI 返回的制作策略格式不符合要求（字段：" + field + "），请重试当前步骤。",
    { cause: error }
  );
}

export type ProductionPlannerInput = {
  projectId: string;
  version: number;
  truth: ProductTruth;
  creativeBatch: CreativeBatch;
  selectedCreativeId: string;
  targetDurationMs: number;
  referenceVideoProfile?: ReferenceVideoProfile;
  creativeContext?: CreativeProductionContext;
};

const PLANNER_VERSION = "production-planner-v2-2";

function compactReferenceVideo(profile?: ReferenceVideoProfile) {
  if (!profile || profile.status !== "ACTIVE") return undefined;
  return {
    hookPattern: profile.hook.firstThreeSecondsPattern,
    pacing: profile.pacing.overall,
    reusableStylePrinciples: profile.reusableStylePrinciples,
    copyGuard: profile.copyGuard
  };
}

export class ProductionPlannerService {
  constructor(private readonly runtime: StructuredAiRuntime) {}

  async plan(input: ProductionPlannerInput): Promise<ProductionStrategy> {
    const selected = input.creativeBatch.concepts.find(
      item => item.id === input.selectedCreativeId
    );
    if (!selected) throw new Error("Selected creative concept does not exist");

    const allowedReferenceAssetIds = new Set<string>([
      input.truth.canonicalImageId,
      ...input.truth.referenceImageIds,
      ...(input.creativeContext?.references?.entries.map(item => item.assetId) ?? [])
    ]);

    const generated = await generateStructuredJson(this.runtime, {
      task:
        "Plan the minimum production assets and execution strategy required to turn the selected product creative into consistent multi-clip video.",
      instructions: [
        "All user-visible text fields must be written in Simplified Chinese: summary, rationale, label, description, purpose and generationPrompt. Keep only unavoidable product model names or brand names in their original form. Do not use implementation words such as canonical, asset, reference, prompt or workflow in user-visible prose.",
        "This is a production planning task, not a screenplay and not a video prompt.",
        "Do not invent product facts, claims, identities, brands, certifications or usage rules.",
        "Always minimize asset generation. Do not create characters, sets or props merely to make the workflow look complete.",
        "Create a CHARACTER requirement only when a named or identity-bearing person must remain visually consistent across multiple shots/clips.",
        "Create a SET requirement only when the same environment must remain spatially consistent across multiple shots/clips or the location itself is story-critical.",
        "Create a PROP requirement only for a non-product object that is story-critical and reused.",
        "Create a PRODUCT_STATE requirement only when a stable visual product state is necessary and cannot be represented safely by the canonical product reference alone.",
        "Create a STYLE requirement only when a stable reusable visual style reference is materially needed.",
        "The product itself must be represented by the canonical product reference and must never be redesigned.",
        "For generated CHARACTER/SET/PROP/PRODUCT_STATE/STYLE requirements, provide a concise generationPrompt suitable for generating one reusable reference image or reference board.",
        "Only GENERATE_IMAGE requirements may include generationPrompt. Omit this field entirely for REUSE_PRODUCT_REFERENCE and REUSE_EXISTING_REFERENCE; never put an empty string in it.",
        "If one generated production asset must visually inherit from another production asset, list the other asset business key in dependsOnAssetKeys. Do not add dependencies merely because assets appear in the same story.",
        "Independent production assets must keep dependsOnAssetKeys empty so they can be generated concurrently.",
        "A dependency means generation must wait until the upstream asset is human-confirmed and its image must be supplied as a visual reference.",
        "For CHARACTER generation prompts, request a neutral identity reference with stable age range, hair, wardrobe and full-body/upper-body visibility; no readable text.",
        "For SET generation prompts, request an empty environment identity reference with stable spatial layout and no people/readable text unless people are essential to the set identity.",
        "Reference asset IDs may only come from allowedReferenceAssetIds.",
        "Research and reference-video material may shape structure and visual method but cannot become new product facts.",
        "Mark needsReview=true only when an asset choice has high downstream identity impact and the planner confidence is below HIGH.",
        "Return the minimum sufficient asset list."
      ].join(" "),
      input: {
        targetDurationMs: input.targetDurationMs,
        userRequest: input.creativeContext?.requestText,
        selectedCreative: {
          id: selected.id,
          title: selected.title,
          targetAudience: selected.targetAudience,
          painPoint: selected.painPoint,
          hook: selected.hook,
          narrativePattern: selected.narrativePattern,
          productShowcaseStrategy: selected.productShowcaseStrategy,
          generationRisk: selected.generationRisk
        },
        product: {
          productName: input.truth.productName,
          category: input.truth.category,
          canonicalImageId: input.truth.canonicalImageId,
          referenceImageIds: input.truth.referenceImageIds,
          forbiddenChanges: input.truth.forbiddenChanges,
          confirmedUsageRules: (input.truth.usageRules ?? [])
            .filter(item => item.status === "CONFIRMED")
            .map(item => item.statement)
        },
        allowedReferenceAssetIds: [...allowedReferenceAssetIds],
        referenceVideo: compactReferenceVideo(input.referenceVideoProfile),
        researchStructure: input.creativeContext?.research
          ? {
              contentOpportunities: input.creativeContext.research.contentOpportunities,
              uncertainties: input.creativeContext.research.uncertainties,
              rule: input.creativeContext.research.rule
            }
          : undefined
      },
      outputContract: {
        contentType: "SHORT_DRAMA|PRODUCT_DEMO|HOST|UGC|CG|MIXED",
        summary: "简短中文制作策略摘要",
        rationale: ["中文原因"],
        assetRequirements: [
          {
            key: "stable business key such as CHARACTER_A or SET_A",
            kind: "CHARACTER|SET|PROP|PRODUCT|PRODUCT_STATE|STYLE",
            label: "中文可读名称",
            description: "中文稳定视觉身份说明",
            purpose: "中文说明为什么需要这个资产",
            required: true,
            reuseScope: "RUN|MULTI_CLIP|SINGLE_CLIP",
            generationMode:
              "REUSE_PRODUCT_REFERENCE|REUSE_EXISTING_REFERENCE|GENERATE_IMAGE",
            generationPrompt:
              "仅在 GENERATE_IMAGE 时填写，使用简体中文描述生图要求",
            referenceAssetIds: ["existing asset id only"],
            dependsOnAssetKeys: ["another production asset key only when visually dependent"],
            clipCountHint: 2,
            confidence: "HIGH|MEDIUM|LOW",
            needsReview: false
          }
        ]
      },
      context: {
        projectId: input.projectId,
        step: "CREATIVE"
      }
    });

    const parsedProposal = plannerProposalSchema.safeParse(
      normalizePlannerAssetPrompts(generated.data)
    );
    if (!parsedProposal.success) throw plannerFormatError(parsedProposal.error);
    let proposal = parsedProposal.data;

    for (const requirement of proposal.assetRequirements) {
      for (const assetId of requirement.referenceAssetIds) {
        if (!allowedReferenceAssetIds.has(assetId)) {
          throw new Error(
            "制作策略引用了未登记的图片素材：" + assetId
          );
        }
      }
    }

    const missing = proposal.assetRequirements.filter(
      item => item.generationMode === "GENERATE_IMAGE" && !item.generationPrompt
    );
    if (missing.length) {
      const missingKeys = new Set(missing.map(item => item.key));
      const names = missing.map(item => item.label + "（" + item.key + "）").join("、");
      if (missingKeys.size !== missing.length) {
        throw new Error("制作资产存在重复编号，无法自动补全提示词：" + names);
      }
      try {
        // One bounded repair call; do not regenerate the creative or asset plan.
        const repaired = missingAssetPromptsSchema.parse(
          (await generateStructuredJson(this.runtime, {
            task: "Fill only the missing image-generation prompts in the existing production asset plan.",
            instructions: [
              "Write every generationPrompt in Simplified Chinese.",
              "Return exactly one prompt for every missing asset key; do not add, remove or rename assets.",
              "Write a reusable single-image reference prompt for the specified asset kind.",
              "Keep all confirmed product appearance and usage constraints unchanged; do not invent product features, effects or certification.",
              "Do not include readable text in generated reference images."
            ].join(" "),
            input: {
              product: {
                productName: input.truth.productName,
                category: input.truth.category,
                forbiddenChanges: input.truth.forbiddenChanges,
                confirmedUsageRules: (input.truth.usageRules ?? [])
                  .filter(item => item.status === "CONFIRMED")
                  .map(item => item.statement)
              },
              creative: {
                title: selected.title,
                hook: selected.hook,
                productShowcaseStrategy: selected.productShowcaseStrategy
              },
              missingAssets: missing.map(item => ({
                key: item.key,
                kind: item.kind,
                label: item.label,
                description: item.description,
                purpose: item.purpose,
                referenceAssetIds: item.referenceAssetIds,
                dependsOnAssetKeys: item.dependsOnAssetKeys
              }))
            },
            outputContract: {
              prompts: [{
                key: "与 missingAssets.key 完全一致",
                generationPrompt: "简体中文、完整可执行的单张资产参考图生成要求"
              }]
            },
            context: { projectId: input.projectId, step: "CREATIVE" }
          })).data
        );
        const prompts = new Map(repaired.prompts.map(item => [item.key, item.generationPrompt]));
        if (
          repaired.prompts.length !== missing.length ||
          prompts.size !== missing.length ||
          missing.some(item => !prompts.has(item.key))
        ) {
          throw new Error("AI 补全结果与待修复制作资产不匹配");
        }
        proposal = {
          ...proposal,
          assetRequirements: proposal.assetRequirements.map(item =>
            item.generationMode === "GENERATE_IMAGE" && !item.generationPrompt
              ? { ...item, generationPrompt: prompts.get(item.key)! }
              : item
          )
        };
      } catch (error) {
        throw new Error(
          "制作资产生图提示词缺失：" + names +
            "；已尝试自动补全但未成功。请稍后点击「问题处理后继续原任务」重试。",
          { cause: error }
        );
      }
    }

    const requirements = proposal.assetRequirements.filter(
      item => item.kind !== "PRODUCT"
    );
    requirements.unshift(
      productionAssetRequirementSchema.parse({
        key: "PRODUCT_MAIN",
        kind: "PRODUCT",
        label: input.truth.productName,
        description:
          "当前已确认产品本体；外观、颜色、形状、图案和品牌身份必须以产品主参考图为准。",
        purpose: "所有包含产品的镜头统一绑定产品身份",
        required: true,
        reuseScope: "RUN",
        generationMode: "REUSE_PRODUCT_REFERENCE",
        referenceAssetIds: [input.truth.canonicalImageId],
        confidence: "HIGH",
        needsReview: false
      })
    );

    const now = new Date().toISOString();
    const withoutHash = {
      id: randomUUID(),
      projectId: input.projectId,
      version: input.version,
      selectedCreativeId: input.selectedCreativeId,
      contentType: proposal.contentType,
      summary: proposal.summary,
      rationale: proposal.rationale,
      assetRequirements: requirements,
      plannerVersion: PLANNER_VERSION,
      ...(generated.metadata ? { aiExecution: generated.metadata } : {}),
      createdAt: now
    };
    const validatedStrategy = productionStrategySchema.safeParse({
      ...withoutHash,
      contentHash: hashValue(withoutHash)
    });
    if (!validatedStrategy.success) throw plannerFormatError(validatedStrategy.error);
    return validatedStrategy.data;
  }
}
