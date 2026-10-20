import {
  creativeBatchSchema,
  productTruthSchema,
  productionPlanSchema,
  scriptDraftSchema,
  type ProductTruth,
  type ProductionPlan
} from "../../domain/schemas.js";
import {
  assertPlanTraceability,
  DomainValidationError
} from "../../domain/validation.js";
import type {
  ProductDirectorGenerator,
  ProductDirectorInput
} from "../ports/product-director-generator.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { UsageComplianceService } from "./usage-compliance.js";
import { assertDirectorPlanTarget } from "./director-generation-target.js";
import { assertV8DirectorConformance } from "./v8-director-conformance.js";
import {assertReferenceBinding, referenceSetRef, type CreativeReferenceGuard} from "./creative-reference-binding.js";

function assertSameRef(
  actual: { entityType: string; entityId: string; version: number; hash: string },
  expected: { entityType: string; entityId: string; version: number; hash: string },
  label: string
): void {
  if (
    actual.entityType !== expected.entityType ||
    actual.entityId !== expected.entityId ||
    actual.version !== expected.version ||
    actual.hash !== expected.hash
  ) {
    throw new DomainValidationError(`${label} version ref mismatch`);
  }
}

function assertHardForbiddenChangesPreserved(
  truth: ProductDirectorInput["productTruth"],
  plan: ProductionPlan
): void {
  const planById = new Map(
    plan.continuityLock.product.forbiddenChanges.map((item) => [item.id, item])
  );
  for (const required of truth.forbiddenChanges.filter((item) => item.severity === "HARD")) {
    const actual = planById.get(required.id);
    if (
      !actual ||
      actual.severity !== "HARD" ||
      actual.field !== required.field ||
      actual.description !== required.description
    ) {
      throw new DomainValidationError(
        `Product Director failed HARD ForbiddenChange: ${required.id}`
      );
    }
  }
}

export class ProductDirectorService {
  private readonly usageCompliance?: UsageComplianceService;

  constructor(
    private readonly generator: ProductDirectorGenerator,
    usageComplianceRuntime?: StructuredAiRuntime,
    private readonly references?: CreativeReferenceGuard
  ) {
    this.usageCompliance = usageComplianceRuntime
      ? new UsageComplianceService(usageComplianceRuntime)
      : undefined;
  }

  async assertPlanUsageCompliance(
    truth: ProductTruth,
    plan: ProductionPlan
  ): Promise<void> {
    if (!this.usageCompliance) return;
    await this.usageCompliance.assertPlan(truth, plan);
  }

  async generate(inputRaw: ProductDirectorInput): Promise<ProductionPlan> {
    const productTruth = productTruthSchema.parse(inputRaw.productTruth);
    const creativeBatch = creativeBatchSchema.parse(inputRaw.creativeBatch);
    const script = scriptDraftSchema.parse(inputRaw.script);
    const references=this.references ? await this.references.assertExpected(productTruth.projectId,script.creativeReferenceSetRef) : inputRaw.creativeContext?.references;
    assertReferenceBinding(script.creativeReferenceSetRef,references,productTruth);
    assertReferenceBinding(creativeBatch.creativeReferenceSetRef,references,productTruth);
    if(inputRaw.creativeContext?.references)assertReferenceBinding(referenceSetRef(inputRaw.creativeContext.references),references,productTruth);
    if(references)inputRaw={...inputRaw,creativeContext:{requestText:"依据确认参考集合导演",...inputRaw.creativeContext,references}};

    if (productTruth.status !== "CONFIRMED") {
      throw new DomainValidationError("生成导演分镜前需要先确认产品事实");
    }
    if (creativeBatch.status !== "ACTIVE") {
      throw new DomainValidationError("生成导演分镜前需要当前创意方案处于可用状态");
    }
    if (script.status !== "CONFIRMED") {
      throw new DomainValidationError("生成导演分镜前需要先确认脚本");
    }
    if (!creativeBatch.concepts.some((item) => item.id === inputRaw.selectedCreativeId)) {
      throw new DomainValidationError("当前选择的创意不属于创意方案");
    }
    if (script.selectedCreativeId !== inputRaw.selectedCreativeId) {
      throw new DomainValidationError("脚本绑定的创意与当前选择不一致");
    }
    if (inputRaw.v8DirectorDecision && inputRaw.directorV3Plan) {
      throw new DomainValidationError("V8 和 V3 不能同时作为权威导演方案");
    }
    if (inputRaw.v8DirectorDecision &&
      inputRaw.v8DirectorDecision.sourceScriptHash !== script.contentHash) {
      throw new DomainValidationError("V8 导演决策不属于当前已确认剧本版本");
    }
    assertSameRef(creativeBatch.productTruthRef, script.productTruthRef, "ProductTruth");
    assertSameRef(
      script.creativeBatchRef,
      {
        entityType: "CreativeBatch",
        entityId: creativeBatch.id,
        version: creativeBatch.version,
        hash: creativeBatch.contentHash
      },
      "CreativeBatch"
    );

    const generated = productionPlanSchema.parse(
      await this.generator.generate({
        ...inputRaw,
        productTruth,
        creativeBatch,
        script
      })
    );

    if (generated.projectId !== productTruth.projectId) {
      throw new DomainValidationError("生成的导演方案与当前项目不匹配");
    }
    assertSameRef(generated.productTruthRef, script.productTruthRef, "ProductionPlan ProductTruth");
    assertSameRef(
      generated.scriptRef,
      {
        entityType: "ScriptDraft",
        entityId: script.id,
        version: script.version,
        hash: script.contentHash
      },
      "ProductionPlan Script"
    );
    if (generated.selectedCreativeId !== inputRaw.selectedCreativeId) {
      throw new DomainValidationError("生成的导演方案与当前选择的创意不匹配");
    }
    if (inputRaw.referenceVideoProfile?.status === "ACTIVE") {
      if (!generated.referenceVideoProfileRef) {
        throw new DomainValidationError(
          "Generated ProductionPlan dropped active ReferenceVideoProfile"
        );
      }
      assertSameRef(
        generated.referenceVideoProfileRef,
        {
          entityType: "ReferenceVideoProfile",
          entityId: inputRaw.referenceVideoProfile.id,
          version: inputRaw.referenceVideoProfile.version,
          hash: inputRaw.referenceVideoProfile.contentHash
        },
        "ReferenceVideoProfile"
      );
    }

    assertReferenceBinding(generated.creativeReferenceSetRef,references,productTruth);
    assertPlanTraceability(productTruth, script, generated);
    if (inputRaw.v8DirectorDecision) assertV8DirectorConformance(inputRaw.v8DirectorDecision, generated);
    assertDirectorPlanTarget(generated, inputRaw.generationTarget);
    assertHardForbiddenChangesPreserved(productTruth, generated);

    const totalClipMs = generated.scenes
      .flatMap((scene) => scene.clips)
      .reduce((sum, clip) => sum + clip.durationMs, 0);
    const toleranceMs = Math.max(2000, Math.round(inputRaw.projectTargetDurationMs * 0.1));
    if (Math.abs(totalClipMs - inputRaw.projectTargetDurationMs) > toleranceMs) {
      throw new DomainValidationError(
        `ProductionPlan clip duration ${totalClipMs}ms is outside target tolerance`
      );
    }

    await this.assertPlanUsageCompliance(productTruth, generated);

    return generated;
  }
}
