import { assertDirectorPlanTarget } from "./director-generation-target.js";
import { hashValue } from "../../domain/hashing.js";
import type { CreativeReferenceGuard } from "./creative-reference-binding.js";
import {
  creativeBatchSchema,
  productTruthSchema,
  productionPlanSchema,
  scriptDraftSchema,
  type CreativeBatch,
  type ProductTruth,
  type ProductionPlan,
  type Project,
  type ScriptDraft
} from "../../domain/schemas.js";
import {
  assertFactReferences,
  assertPlanTraceability,
  DomainValidationError,
  invalidationMatrix
} from "../../domain/validation.js";
import type {
  ProductFlowRepository,
  VersionedEntityType
} from "../ports/product-flow-repository.js";

function sameRef(
  actual: Project["currentProductTruthRef"] | Project["currentCreativeBatchRef"] | Project["currentScriptRef"] | undefined,
  expected: { entityType: string; entityId: string; version: number; hash: string }
): boolean {
  return Boolean(
    actual &&
      actual.entityType === expected.entityType &&
      actual.entityId === expected.entityId &&
      actual.version === expected.version &&
      actual.hash === expected.hash
  );
}

function versionRef(entityType: string, entityId: string, version: number, hash: string) {
  return { entityType, entityId, version, hash };
}

function downstream(source: keyof typeof invalidationMatrix): readonly VersionedEntityType[] {
  return invalidationMatrix[source] as readonly VersionedEntityType[];
}

function assertHardForbiddenChangesPreserved(truth: ProductTruth, plan: ProductionPlan): void {
  const planById = new Map(
    plan.continuityLock.product.forbiddenChanges.map((item) => [item.id, item])
  );
  for (const required of truth.forbiddenChanges.filter((item) => item.severity === "HARD")) {
    const actual = planById.get(required.id);
    if (!actual) {
      throw new DomainValidationError(`ProductionPlan dropped HARD ForbiddenChange: ${required.id}`);
    }
    if (
      actual.severity !== "HARD" ||
      actual.field !== required.field ||
      actual.description !== required.description
    ) {
      throw new DomainValidationError(`ProductionPlan changed HARD ForbiddenChange: ${required.id}`);
    }
  }
}

async function requireProject(repo: ProductFlowRepository, projectId: string): Promise<Project> {
  const project = await repo.getProject(projectId);
  if (!project) throw new DomainValidationError(`Project not found: ${projectId}`);
  return project;
}

export type ProjectWorkspace = {
  project: Project;
  productTruth?: ProductTruth;
  creativeBatch?: CreativeBatch;
  script?: ScriptDraft;
  productionPlan?: ProductionPlan;
};

export class ProductFlowService {
  constructor(private readonly repo: ProductFlowRepository, private readonly references?: Pick<CreativeReferenceGuard,"assertExpected">) {}

  async createProject(project: Project): Promise<Project> {
    return this.repo.createProject(project);
  }

  async listProjects(): Promise<Project[]> {
    return this.repo.listProjects();
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.repo.getProject(projectId);
  }

  async setProjectStatus(
    projectId: string,
    status: Project["status"]
  ): Promise<Project> {
    return this.repo.commitProjectUpdate(projectId, [], { status });
  }

  async nextVersion(
    projectId: string,
    entityType: VersionedEntityType,
    entityKey: string
  ): Promise<number> {
    return this.repo.nextVersion(projectId, entityType, entityKey);
  }

  async getWorkspace(projectId: string): Promise<ProjectWorkspace | null> {
    const project = await this.repo.getProject(projectId);
    if (!project) return null;

    const productTruth = project.currentProductTruthRef
      ? await this.repo.getVersion<ProductTruth>(
          projectId,
          "ProductTruth",
          project.currentProductTruthRef.entityId,
          project.currentProductTruthRef.version
        )
      : undefined;
    const creativeBatch = project.currentCreativeBatchRef
      ? await this.repo.getVersion<CreativeBatch>(
          projectId,
          "CreativeBatch",
          project.currentCreativeBatchRef.entityId,
          project.currentCreativeBatchRef.version
        )
      : undefined;
    const script = project.currentScriptRef
      ? await this.repo.getVersion<ScriptDraft>(
          projectId,
          "ScriptDraft",
          project.currentScriptRef.entityId,
          project.currentScriptRef.version
        )
      : undefined;
    const productionPlan = project.currentProductionPlanRef
      ? await this.repo.getVersion<ProductionPlan>(
          projectId,
          "ProductionPlan",
          project.currentProductionPlanRef.entityId,
          project.currentProductionPlanRef.version
        )
      : undefined;

    return {
      project,
      ...(productTruth ? { productTruth } : {}),
      ...(creativeBatch ? { creativeBatch } : {}),
      ...(script ? { script } : {}),
      ...(productionPlan ? { productionPlan } : {})
    };
  }

  async saveProductTruthDraft(input: ProductTruth): Promise<Project> {
    const truth = productTruthSchema.parse(input);
    if (truth.status !== "DRAFT") {
      throw new DomainValidationError("saveProductTruthDraft requires DRAFT ProductTruth");
    }
    await requireProject(this.repo, truth.projectId);
    return this.repo.commitVersion({
      version: {
        id: truth.id,
        projectId: truth.projectId,
        entityType: "ProductTruth",
        entityKey: "product-truth",
        version: truth.version,
        status: truth.status,
        contentHash: truth.contentHash,
        data: truth
      },
      staleEntityTypes: downstream("PRODUCT_INPUT"),
      projectPatch: {
        status: "PRODUCT_TRUTH_REVIEW",
        currentProductTruthRef: versionRef(
          "ProductTruth",
          truth.id,
          truth.version,
          truth.contentHash
        ),
        currentCreativeBatchRef: null,
        selectedCreativeId: null,
        currentScriptRef: null,
        currentProductionPlanRef: null
      }
    });
  }

  async saveScriptDraft(input: ScriptDraft): Promise<Project> {
    const script = scriptDraftSchema.parse(input);
    await this.references?.assertExpected(script.projectId,script.creativeReferenceSetRef);
    if (script.status !== "DRAFT") {
      throw new DomainValidationError("saveScriptDraft requires DRAFT ScriptDraft");
    }
    const project = await requireProject(this.repo, script.projectId);
    if (!sameRef(project.currentProductTruthRef, script.productTruthRef)) {
      throw new DomainValidationError("Script ProductTruth ref is not current");
    }
    if (!sameRef(project.currentCreativeBatchRef, script.creativeBatchRef)) {
      throw new DomainValidationError("Script CreativeBatch ref is not current");
    }
    if (!project.selectedCreativeId || project.selectedCreativeId !== script.selectedCreativeId) {
      throw new DomainValidationError("Script selectedCreativeId is not current");
    }
    const truth = await this.repo.getVersion<ProductTruth>(
      script.projectId,
      "ProductTruth",
      script.productTruthRef.entityId,
      script.productTruthRef.version
    );
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ProductTruth is not confirmed");
    }
    for (const beat of script.beats) {
      assertFactReferences(truth, beat.requiredFactIds);
    }
    return this.repo.commitVersion({
      version: {
        id: script.id,
        projectId: script.projectId,
        entityType: "ScriptDraft",
        entityKey: "script",
        version: script.version,
        status: script.status,
        contentHash: script.contentHash,
        data: script
      },
      staleEntityTypes: downstream("SCRIPT"),
      projectPatch: {
        status: "SCRIPT_REVIEW",
        currentScriptRef: versionRef(
          "ScriptDraft",
          script.id,
          script.version,
          script.contentHash
        ),
        currentProductionPlanRef: null
      }
    });
  }

  async saveProductionPlanDraft(input: ProductionPlan): Promise<Project> {
    const plan = productionPlanSchema.parse(input);
    await this.references?.assertExpected(plan.projectId,plan.creativeReferenceSetRef);
    assertDirectorPlanTarget(plan);
    if (plan.status !== "DRAFT") {
      throw new DomainValidationError("saveProductionPlanDraft requires DRAFT ProductionPlan");
    }
    const project = await requireProject(this.repo, plan.projectId);
    if (!sameRef(project.currentProductTruthRef, plan.productTruthRef)) {
      throw new DomainValidationError("ProductionPlan ProductTruth ref is not current");
    }
    if (!sameRef(project.currentScriptRef, plan.scriptRef)) {
      throw new DomainValidationError("ProductionPlan Script ref is not current");
    }
    if (!project.selectedCreativeId || project.selectedCreativeId !== plan.selectedCreativeId) {
      throw new DomainValidationError("ProductionPlan selectedCreativeId is not current");
    }
    const truth = await this.repo.getVersion<ProductTruth>(
      plan.projectId,
      "ProductTruth",
      plan.productTruthRef.entityId,
      plan.productTruthRef.version
    );
    const script = await this.repo.getVersion<ScriptDraft>(
      plan.projectId,
      "ScriptDraft",
      plan.scriptRef.entityId,
      plan.scriptRef.version
    );
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ProductTruth is not confirmed");
    }
    if (!script || script.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ScriptDraft is not confirmed");
    }
    assertPlanTraceability(truth, script, plan);
    assertHardForbiddenChangesPreserved(truth, plan);
    return this.repo.commitVersion({
      version: {
        id: plan.id,
        projectId: plan.projectId,
        entityType: "ProductionPlan",
        entityKey: "production-plan",
        version: plan.version,
        status: plan.status,
        contentHash: plan.contentHash,
        data: plan
      },
      staleEntityTypes: downstream("PRODUCTION_PLAN"),
      projectPatch: {
        status: "DIRECTOR_REVIEW",
        currentProductionPlanRef: versionRef(
          "ProductionPlan",
          plan.id,
          plan.version,
          plan.contentHash
        )
      }
    });
  }

  async confirmProductTruth(input: ProductTruth): Promise<Project> {
    const truth = productTruthSchema.parse(input);
    if (truth.status !== "CONFIRMED") {
      throw new DomainValidationError("ProductTruth must be CONFIRMED before Creative");
    }
    await requireProject(this.repo, truth.projectId);

    return this.repo.commitVersion({
      version: {
        id: truth.id,
        projectId: truth.projectId,
        entityType: "ProductTruth",
        entityKey: "product-truth",
        version: truth.version,
        status: truth.status,
        contentHash: truth.contentHash,
        data: truth
      },
      staleEntityTypes: downstream("PRODUCT_TRUTH"),
      projectPatch: {
        status: "CREATIVE_REVIEW",
        currentProductTruthRef: versionRef(
          "ProductTruth",
          truth.id,
          truth.version,
          truth.contentHash
        ),
        currentCreativeBatchRef: null,
        selectedCreativeId: null,
        currentScriptRef: null,
        currentProductionPlanRef: null
      }
    });
  }

  async activateCreativeBatch(input: CreativeBatch): Promise<Project> {
    const batch = creativeBatchSchema.parse(input);
    await this.references?.assertExpected(batch.projectId,batch.creativeReferenceSetRef);
    if (batch.status !== "ACTIVE") {
      throw new DomainValidationError("CreativeBatch must be ACTIVE");
    }
    const project = await requireProject(this.repo, batch.projectId);
    if (!sameRef(project.currentProductTruthRef, batch.productTruthRef)) {
      throw new DomainValidationError("CreativeBatch ProductTruth ref is not current");
    }
    const truth = await this.repo.getVersion<ProductTruth>(
      batch.projectId,
      "ProductTruth",
      batch.productTruthRef.entityId,
      batch.productTruthRef.version
    );
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ProductTruth is not confirmed");
    }
    for (const concept of batch.concepts) {
      assertFactReferences(truth, concept.requiredFactIds);
    }

    // Candidate-only generation already persisted this immutable version.
    // Adopting it changes pointers; it must not try to insert the same id again.
    const saved = await this.repo.getVersion<CreativeBatch>(batch.projectId, "CreativeBatch", batch.id, batch.version);
    if (saved) {
      if (hashValue(saved) !== hashValue(batch)) throw new DomainValidationError("已保存的创意批次内容与采用版本不一致");
      return this.repo.commitProjectUpdate(batch.projectId, downstream("CREATIVE_SELECTION"), {
        status: "CREATIVE_REVIEW", currentCreativeBatchRef: versionRef("CreativeBatch", batch.id, batch.version, batch.contentHash),
        selectedCreativeId: null, currentScriptRef: null, currentProductionPlanRef: null
      });
    }

    return this.repo.commitVersion({
      version: {
        id: batch.id,
        projectId: batch.projectId,
        entityType: "CreativeBatch",
        entityKey: "creative-batch",
        version: batch.version,
        status: batch.status,
        contentHash: batch.contentHash,
        data: batch
      },
      staleEntityTypes: downstream("CREATIVE_SELECTION"),
      projectPatch: {
        status: "CREATIVE_REVIEW",
        currentCreativeBatchRef: versionRef(
          "CreativeBatch",
          batch.id,
          batch.version,
          batch.contentHash
        ),
        selectedCreativeId: null,
        currentScriptRef: null,
        currentProductionPlanRef: null
      }
    });
  }

  async selectCreative(projectId: string, creativeId: string): Promise<Project> {
    const project = await requireProject(this.repo, projectId);
    const batchRef = project.currentCreativeBatchRef;
    if (!batchRef) throw new DomainValidationError("No current CreativeBatch");
    const batch = await this.repo.getVersion<CreativeBatch>(
      projectId,
      "CreativeBatch",
      batchRef.entityId,
      batchRef.version
    );
    if (!batch || batch.status !== "ACTIVE") {
      throw new DomainValidationError("Current CreativeBatch is missing or stale");
    }
    if (!batch.concepts.some((concept) => concept.id === creativeId)) {
      throw new DomainValidationError("Selected creative does not belong to current batch");
    }

    return this.repo.commitProjectUpdate(
      projectId,
      downstream("CREATIVE_SELECTION"),
      {
        status: "SCRIPT_REVIEW",
        selectedCreativeId: creativeId,
        currentScriptRef: null,
        currentProductionPlanRef: null
      }
    );
  }

  async confirmScript(input: ScriptDraft): Promise<Project> {
    const script = scriptDraftSchema.parse(input);
    await this.references?.assertExpected(script.projectId,script.creativeReferenceSetRef);
    if (script.status !== "CONFIRMED") {
      throw new DomainValidationError("ScriptDraft must be CONFIRMED before Director");
    }
    const project = await requireProject(this.repo, script.projectId);
    if (!sameRef(project.currentProductTruthRef, script.productTruthRef)) {
      throw new DomainValidationError("Script ProductTruth ref is not current");
    }
    if (!sameRef(project.currentCreativeBatchRef, script.creativeBatchRef)) {
      throw new DomainValidationError("Script CreativeBatch ref is not current");
    }
    if (!project.selectedCreativeId || project.selectedCreativeId !== script.selectedCreativeId) {
      throw new DomainValidationError("Script selectedCreativeId is not current");
    }
    const truth = await this.repo.getVersion<ProductTruth>(
      script.projectId,
      "ProductTruth",
      script.productTruthRef.entityId,
      script.productTruthRef.version
    );
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ProductTruth is not confirmed");
    }
    for (const beat of script.beats) {
      assertFactReferences(truth, beat.requiredFactIds);
    }

    return this.repo.commitVersion({
      version: {
        id: script.id,
        projectId: script.projectId,
        entityType: "ScriptDraft",
        entityKey: "script",
        version: script.version,
        status: script.status,
        contentHash: script.contentHash,
        data: script
      },
      staleEntityTypes: downstream("SCRIPT"),
      projectPatch: {
        status: "DIRECTOR_REVIEW",
        currentScriptRef: versionRef(
          "ScriptDraft",
          script.id,
          script.version,
          script.contentHash
        ),
        currentProductionPlanRef: null
      }
    });
  }

  async confirmProductionPlan(input: ProductionPlan): Promise<Project> {
    const plan = productionPlanSchema.parse(input);
    await this.references?.assertExpected(plan.projectId,plan.creativeReferenceSetRef);
    assertDirectorPlanTarget(plan);
    if (plan.status !== "CONFIRMED") {
      throw new DomainValidationError("ProductionPlan must be CONFIRMED before Preflight");
    }
    const project = await requireProject(this.repo, plan.projectId);
    if (!sameRef(project.currentProductTruthRef, plan.productTruthRef)) {
      throw new DomainValidationError("ProductionPlan ProductTruth ref is not current");
    }
    if (!sameRef(project.currentScriptRef, plan.scriptRef)) {
      throw new DomainValidationError("ProductionPlan Script ref is not current");
    }
    if (!project.selectedCreativeId || project.selectedCreativeId !== plan.selectedCreativeId) {
      throw new DomainValidationError("ProductionPlan selectedCreativeId is not current");
    }

    const truth = await this.repo.getVersion<ProductTruth>(
      plan.projectId,
      "ProductTruth",
      plan.productTruthRef.entityId,
      plan.productTruthRef.version
    );
    const script = await this.repo.getVersion<ScriptDraft>(
      plan.projectId,
      "ScriptDraft",
      plan.scriptRef.entityId,
      plan.scriptRef.version
    );
    if (!truth || truth.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ProductTruth is not confirmed");
    }
    if (!script || script.status !== "CONFIRMED") {
      throw new DomainValidationError("Current ScriptDraft is not confirmed");
    }

    assertPlanTraceability(truth, script, plan);
    assertHardForbiddenChangesPreserved(truth, plan);

    return this.repo.commitVersion({
      version: {
        id: plan.id,
        projectId: plan.projectId,
        entityType: "ProductionPlan",
        entityKey: "production-plan",
        version: plan.version,
        status: plan.status,
        contentHash: plan.contentHash,
        data: plan
      },
      staleEntityTypes: downstream("PRODUCTION_PLAN"),
      projectPatch: {
        status: "READY_TO_GENERATE",
        currentProductionPlanRef: versionRef(
          "ProductionPlan",
          plan.id,
          plan.version,
          plan.contentHash
        )
      }
    });
  }
}
