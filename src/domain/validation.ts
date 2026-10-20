import type {
  GenerationRequest,
  PreflightReport,
  ProductTruth,
  ProductionPlan,
  ScriptDraft,
  UserApproval
} from "./schemas.js";
import {
  generationRequestSchema,
  preflightReportSchema,
  productTruthSchema,
  productionPlanSchema,
  scriptDraftSchema,
  userApprovalSchema
} from "./schemas.js";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export function productFactIds(truthInput: ProductTruth): Set<string> {
  const truth = productTruthSchema.parse(truthInput);
  return new Set([...truth.confirmedFeatures, ...truth.sellingPoints].map((fact) => fact.id));
}

export function assertFactReferences(truthInput: ProductTruth, requiredFactIds: Iterable<string>): void {
  const truth = productTruthSchema.parse(truthInput);
  const facts = productFactIds(truth);
  const claims = new Set(truth.uncertainClaims.map((claim) => claim.id));
  for (const id of requiredFactIds) {
    if (claims.has(id)) throw new DomainValidationError(`UncertainClaim ${id} cannot be used as a ProductFact reference`);
    if (!facts.has(id)) throw new DomainValidationError(`Unknown ProductFact reference: ${id}`);
  }
}

export function assertPlanTraceability(
  truthInput: ProductTruth,
  scriptInput: ScriptDraft,
  planInput: ProductionPlan
): void {
  const truth = productTruthSchema.parse(truthInput);
  const script = scriptDraftSchema.parse(scriptInput);
  const plan = productionPlanSchema.parse(planInput);
  const beatIds = new Set(script.beats.map((beat) => beat.id));

  for (const beat of script.beats) assertFactReferences(truth, beat.requiredFactIds);
  for (const scene of plan.scenes) {
    for (const beatId of scene.sourceBeatIds) {
      if (!beatIds.has(beatId)) throw new DomainValidationError(`Scene references unknown ScriptBeat: ${beatId}`);
    }
    assertFactReferences(truth, scene.requiredFactIds);
    for (const clip of scene.clips) {
      for (const beatId of clip.sourceBeatIds) {
        if (!beatIds.has(beatId)) throw new DomainValidationError(`Clip references unknown ScriptBeat: ${beatId}`);
      }
      assertFactReferences(truth, clip.requiredFactIds);
      for (const segment of clip.segments) {
        for (const beatId of segment.sourceBeatIds) {
          if (!beatIds.has(beatId)) throw new DomainValidationError(`Segment references unknown ScriptBeat: ${beatId}`);
        }
        assertFactReferences(truth, segment.requiredFactIds);
      }
    }
  }
}

export type ArtifactGateInput = {
  artifactId: string;
  integrityStatus: "PENDING" | "READY" | "MISSING" | "CORRUPT";
};

export function assertSubmissionGate(input: {
  request: GenerationRequest;
  preflight: PreflightReport;
  approval: UserApproval;
  artifacts: ArtifactGateInput[];
  now?: Date;
}): void {
  const request = generationRequestSchema.parse(input.request);
  const preflight = preflightReportSchema.parse(input.preflight);
  const approval = userApprovalSchema.parse(input.approval);
  const now = input.now ?? new Date();

  if (preflight.status !== "PASS") throw new DomainValidationError(`Preflight must be PASS, got ${preflight.status}`);
  if (approval.status !== "ACTIVE") throw new DomainValidationError(`UserApproval must be ACTIVE, got ${approval.status}`);
  if (preflight.generationRequestId !== request.id || approval.generationRequestId !== request.id) {
    throw new DomainValidationError("GenerationRequest id mismatch in approval chain");
  }
  if (preflight.requestHash !== request.requestHash || approval.requestHash !== request.requestHash) {
    throw new DomainValidationError("requestHash mismatch in approval chain");
  }
  if (approval.preflightReportId !== preflight.id || approval.preflightHash !== preflight.reportHash) {
    throw new DomainValidationError("preflightHash mismatch in approval chain");
  }
  if (
    preflight.providerIdentityHash !== request.providerIdentityHash ||
    approval.providerIdentityHash !== request.providerIdentityHash
  ) {
    throw new DomainValidationError("providerIdentityHash mismatch in approval chain");
  }
  if (
    preflight.capabilityFingerprint !== request.capabilityFingerprint ||
    approval.capabilityFingerprint !== request.capabilityFingerprint
  ) {
    throw new DomainValidationError("capabilityFingerprint mismatch in approval chain");
  }
  if (approval.expiresAt && new Date(approval.expiresAt) <= now) {
    throw new DomainValidationError("UserApproval has expired");
  }
  if (preflight.costEstimate.status === "UNKNOWN" && !approval.acceptedUnknownCostRisk) {
    throw new DomainValidationError("Unknown cost requires explicit risk acceptance");
  }
  const notReady = input.artifacts.filter((artifact) => artifact.integrityStatus !== "READY");
  if (notReady.length) throw new DomainValidationError(`Artifacts are not READY: ${notReady.map((a) => a.artifactId).join(", ")}`);
}

export const invalidationMatrix = {
  PRODUCT_INPUT: ["ProductTruth", "CreativeBatch", "ScriptDraft", "ProductionPlan", "CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  PRODUCT_TRUTH: ["CreativeBatch", "ScriptDraft", "ProductionPlan", "CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  CREATIVE_SELECTION: ["ScriptDraft", "ProductionPlan", "CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  SCRIPT: ["ProductionPlan", "CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  PRODUCTION_PLAN: ["CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  COMPILER_TEMPLATE: ["CompiledPrompt", "GenerationRequest", "PreflightReport", "UserApproval"],
  PROVIDER_CAPABILITY: ["GenerationRequest", "PreflightReport", "UserApproval"],
  COST_SNAPSHOT: ["UserApproval"]
} as const;

export type InvalidationSource = keyof typeof invalidationMatrix;
