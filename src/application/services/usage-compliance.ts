import { z } from "zod";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../ports/structured-ai-runtime.js";
import {
  productTruthSchema,
  productionPlanSchema,
  scriptDraftSchema,
  type ProductTruth,
  type ProductionPlan,
  type ScriptDraft
} from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";

const complianceSchema = z.object({
  violations: z.array(
    z.object({
      ruleId: z.string().trim().min(1),
      description: z.string().trim().min(1),
      evidence: z.string().trim().min(1)
    })
  ).max(30)
});

function confirmedRules(truth: ProductTruth) {
  return (truth.usageRules ?? []).filter(
    (rule) => rule.status === "CONFIRMED"
  );
}

export class UsageComplianceService {
  constructor(private readonly runtime: StructuredAiRuntime) {}

  private async assertCompliant(input: {
    projectId: string;
    stage: "SCRIPT" | "DIRECTOR";
    stageLabel: string;
    truth: ProductTruth;
    content: unknown;
  }): Promise<void> {
    const truth = productTruthSchema.parse(input.truth);
    const rules = confirmedRules(truth);
    if (!rules.length) return;

    const generation = await generateStructuredJson(this.runtime, {
      task:
        "Check whether product-video content conflicts with confirmed product usage rules.",
      instructions: [
        "This is a fail-closed compliance check, not a creative rewrite.",
        "Only cite ruleId values from the supplied confirmedRules.",
        "Flag a violation when the content shows, instructs, implies, or claims product usage that contradicts a confirmed rule.",
        "Pay special attention to wearing/install position, operating method, prohibited actions, waterproof/charging/environment limits, function effect, valid usage scenarios and product state.",
        "Do not flag a conflict merely because a rule is not mentioned.",
        "For CONTEXT rules, flag only when the content places the product outside the stated applicability boundary.",
        "Return an empty violations array when no concrete conflict exists."
      ].join(" "),
      input: {
        confirmedRules: rules.map((rule) => ({
          id: rule.id,
          category: rule.category,
          polarity: rule.polarity,
          statement: rule.statement,
          confidence: rule.confidence
        })),
        content: input.content
      },
      outputContract: {
        violations: [
          {
            ruleId: "confirmed-rule-id",
            description: "string",
            evidence: "specific conflicting script/shot content"
          }
        ]
      },
      context: {
        projectId: input.projectId,
        step: input.stage
      }
    });

    const result = complianceSchema.parse(generation.data);
    const allowedRuleIds = new Set(rules.map((rule) => rule.id));
    for (const violation of result.violations) {
      if (!allowedRuleIds.has(violation.ruleId)) {
        throw new DomainValidationError(
          `${input.stageLabel}使用规则校验返回了未知规则：${violation.ruleId}`
        );
      }
    }
    if (result.violations.length) {
      const detail = result.violations
        .map(
          (item) =>
            `${item.description}（冲突内容：${item.evidence}）`
        )
        .join("；");
      throw new DomainValidationError(
        `${input.stageLabel}与已确认的产品使用规则冲突：${detail}`
      );
    }
  }

  async assertScript(
    truthInput: ProductTruth,
    scriptInput: ScriptDraft
  ): Promise<void> {
    const truth = productTruthSchema.parse(truthInput);
    const script = scriptDraftSchema.parse(scriptInput);
    await this.assertCompliant({
      projectId: truth.projectId,
      stage: "SCRIPT",
      stageLabel: "脚本",
      truth,
      content: {
        beats: script.beats.map((beat) => ({
          purpose: beat.purpose,
          text: beat.text,
          requiredFactIds: beat.requiredFactIds
        }))
      }
    });
  }

  async assertPlan(
    truthInput: ProductTruth,
    planInput: ProductionPlan
  ): Promise<void> {
    const truth = productTruthSchema.parse(truthInput);
    const plan = productionPlanSchema.parse(planInput);
    await this.assertCompliant({
      projectId: truth.projectId,
      stage: "DIRECTOR",
      stageLabel: "导演分镜",
      truth,
      content: {
        visualDirection: plan.visualDirection,
        productShowcaseRules: plan.productShowcaseRules,
        scenes: plan.scenes.map((scene) => ({
          purpose: scene.purpose,
          location: scene.location,
          visualState: scene.visualState,
          clips: scene.clips.map((clip) => ({
            purpose: clip.purpose,
            openingProductState: clip.openingState.productState,
            closingProductState: clip.closingState.productState,
            segments: clip.segments.map((segment) => ({
              subjectAction: segment.subjectAction,
              productState: segment.productState,
              composition: segment.composition
            }))
          }))
        }))
      }
    });
  }
}
