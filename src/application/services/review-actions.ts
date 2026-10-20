import { randomUUID } from "node:crypto";
import {
  productTruthSchema,
  productionPlanSchema,
  scriptDraftSchema,
  type ArtifactRecord,
  type AssetRef,
  type ProductTruth,
  type ProductionPlan,
  type ScriptDraft
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

function hashWithoutRuntimeFields(value: Record<string, unknown>): string {
  const copy = structuredClone(value);
  delete copy.contentHash;
  delete copy.confirmedAt;
  return hashValue(copy);
}

export type ClaimDisposition = "KEEP_UNVERIFIED" | "REJECT" | "PROMOTE";
export type UsageRuleDisposition =
  | "KEEP_UNVERIFIED"
  | "REJECT"
  | "CONFIRM";

export function assertCanonicalProductArtifactReady(
  truthInput: ProductTruth,
  assets: AssetRef[],
  artifacts: ArtifactRecord[]
): void {
  const truth = productTruthSchema.parse(truthInput);
  if (!truth.referenceImageIds.includes(truth.canonicalImageId)) {
    throw new DomainValidationError(
      "canonicalImageId must be included in ProductTruth referenceImageIds"
    );
  }
  const asset = assets.find((item) => item.id === truth.canonicalImageId);
  if (!asset || asset.type !== "image") {
    throw new DomainValidationError(
      "Canonical Product Truth image AssetRef is missing"
    );
  }
  const artifact = artifacts.find((item) => item.id === asset.artifactId);
  if (!artifact) {
    throw new DomainValidationError(
      "Canonical Product Truth image Artifact is missing"
    );
  }
  if (
    artifact.integrityStatus !== "READY" ||
    !artifact.sha256 ||
    artifact.sha256 !== asset.sha256
  ) {
    throw new DomainValidationError(
      "Canonical Product Truth image Artifact must be READY with matching hash"
    );
  }
}

export type ScriptBeatRevision = {
  id?: string;
  purpose: ScriptDraft["beats"][number]["purpose"];
  text: string;
  estimatedDurationMs: number;
  requiredFactIds: string[];
  videoIntent?: ScriptDraft["beats"][number]["videoIntent"];
};

export function reviseScriptDraft(
  currentInput: ScriptDraft,
  beats: ScriptBeatRevision[]
): ScriptDraft {
  const current = scriptDraftSchema.parse(currentInput);
  const base = {
    ...current,
    id: randomUUID(),
    version: current.version + 1,
    status: "DRAFT" as const,
    beats: beats.map((beat, index) => ({
      id: beat.id?.trim() || randomUUID(),
      order: index + 1,
      purpose: beat.purpose,
      text: beat.text,
      estimatedDurationMs: beat.estimatedDurationMs,
      requiredFactIds: beat.requiredFactIds,
      ...(beat.videoIntent
        ? { videoIntent: beat.videoIntent }
        : {})
    }))
  } as Record<string, unknown>;
  delete base.confirmedAt;
  return scriptDraftSchema.parse({
    ...base,
    contentHash: hashWithoutRuntimeFields(base)
  });
}

export type ProductionPlanSegmentRevision = {
  id: string;
  startMs?: number;
  endMs?: number;
  shotSize?: string;
  cameraPosition?: string;
  cameraAngle?: string;
  cameraMovement?: string;
  composition?: string;
  subjectAction?: string;
  productState?: string;
  dialogueOrNarration?: ProductionPlan["scenes"][number]["clips"][number]["segments"][number]["dialogueOrNarration"];
  ambientSound?: ProductionPlan["scenes"][number]["clips"][number]["segments"][number]["ambientSound"];
  lighting?: string;
  continuityIn?: {
    description: string;
    productState: string;
    environmentState: string;
  };
  continuityOut?: {
    description: string;
    productState: string;
    environmentState: string;
  };
};

export type ProductionPlanClipRevision = {
  id: string;
  durationMs?: number;
};

function stateWithHash(input: {
  description: string;
  productState: string;
  environmentState: string;
}) {
  return {
    ...input,
    stateHash: hashValue(input)
  };
}

export function reviseProductionPlanDraft(
  currentInput: ProductionPlan,
  input: {
    visualDirection?: string;
    soundDirection?: string;
    productShowcaseRules?: string[];
    clips?: ProductionPlanClipRevision[];
    segments: ProductionPlanSegmentRevision[];
  }
): ProductionPlan {
  const current = productionPlanSchema.parse(currentInput);
  const next = structuredClone(current);
  next.id = randomUUID();
  next.version = current.version + 1;
  next.status = "DRAFT";
  delete next.confirmedAt;
  if (input.visualDirection !== undefined) {
    next.visualDirection = input.visualDirection;
  }
  if (input.soundDirection !== undefined) {
    next.soundDirection = input.soundDirection;
  }
  if (input.productShowcaseRules !== undefined) {
    next.productShowcaseRules = [...input.productShowcaseRules];
  }

  const patchById = new Map(input.segments.map((item) => [item.id, item]));
  const clipPatchById = new Map((input.clips ?? []).map((item) => [item.id, item]));
  for (const scene of next.scenes) {
    for (const clip of scene.clips) {
      const clipPatch = clipPatchById.get(clip.id);
      if (clipPatch?.durationMs !== undefined) {
        clip.durationMs = clipPatch.durationMs;
      }
      for (const segment of clip.segments) {
        const patch = patchById.get(segment.id);
        if (!patch) continue;
        if (patch.startMs !== undefined) segment.startMs = patch.startMs;
        if (patch.endMs !== undefined) segment.endMs = patch.endMs;
        if (patch.shotSize !== undefined) segment.shotSize = patch.shotSize;
        if (patch.cameraPosition !== undefined) segment.cameraPosition = patch.cameraPosition;
        if (patch.cameraAngle !== undefined) segment.cameraAngle = patch.cameraAngle;
        if (patch.cameraMovement !== undefined) segment.cameraMovement = patch.cameraMovement;
        if (patch.composition !== undefined) segment.composition = patch.composition;
        if (patch.subjectAction !== undefined) segment.subjectAction = patch.subjectAction;
        if (patch.productState !== undefined) segment.productState = patch.productState;
        if (patch.dialogueOrNarration !== undefined) {
          segment.dialogueOrNarration = patch.dialogueOrNarration;
        }
        if (patch.ambientSound !== undefined) {
          segment.ambientSound = patch.ambientSound;
        }
        if (patch.lighting !== undefined) segment.lighting = patch.lighting;
        if (patch.continuityIn !== undefined) {
          segment.continuityIn = stateWithHash(patch.continuityIn);
        }
        if (patch.continuityOut !== undefined) {
          segment.continuityOut = stateWithHash(patch.continuityOut);
        }
      }
      if (clipPatch?.durationMs !== undefined && clip.segments.length) {
        const last = clip.segments[clip.segments.length - 1]!;
        if (!patchById.get(last.id)?.endMs) {
          last.endMs = clip.durationMs;
        }
      }
      if (clip.segments.length) {
        clip.openingState = structuredClone(clip.segments[0]!.continuityIn);
        clip.closingState = structuredClone(
          clip.segments[clip.segments.length - 1]!.continuityOut
        );
      }
      const clipForHash = structuredClone(clip) as Record<string, unknown>;
      delete clipForHash.contentHash;
      clip.contentHash = hashValue(clipForHash);
    }
  }

  const planForHash = structuredClone(next) as unknown as Record<string, unknown>;
  delete planForHash.contentHash;
  return productionPlanSchema.parse({
    ...next,
    contentHash: hashWithoutRuntimeFields(planForHash)
  });
}

export function confirmProductTruthDraft(
  draftInput: ProductTruth,
  dispositions: Record<string, ClaimDisposition>,
  now = new Date(),
  usageRuleDispositions: Record<string, UsageRuleDisposition> = {}
): ProductTruth {
  const draft = productTruthSchema.parse(draftInput);
  if (draft.status !== "DRAFT") {
    throw new DomainValidationError("Only DRAFT ProductTruth can be confirmed");
  }
  const createdAt = now.toISOString();
  const promotedFacts: ProductTruth["confirmedFeatures"] = [];
  const uncertainClaims = draft.uncertainClaims.map((claim) => {
    // A new Product Truth DRAFT can be created from an already-confirmed
    // version when Research candidates are appended. Claims that were
    // disposed in an earlier review are immutable history and must not be
    // re-disposed; in particular, a PROMOTED claim must retain its
    // promotedFactId and matching ProductFact relationship.
    if (claim.dispositionConfirmedByUser) {
      return claim;
    }
    const disposition = dispositions[claim.id];
    if (!disposition) {
      throw new DomainValidationError(
        `Missing user disposition for UncertainClaim: ${claim.id}`
      );
    }
    if (disposition === "KEEP_UNVERIFIED") {
      return {
        ...claim,
        status: "UNVERIFIED" as const,
        dispositionConfirmedByUser: true
      };
    }
    if (disposition === "REJECT") {
      return {
        ...claim,
        status: "REJECTED" as const,
        dispositionConfirmedByUser: true
      };
    }
    const factId = randomUUID();
    const evidenceRef =
      claim.sourceType === "research" && claim.evidenceRefs?.length
        ? claim.evidenceRefs[0]
        : `user-confirmed-promotion:${claim.id}`;
    promotedFacts.push({
      id: factId,
      statement: claim.statement,
      sourceType:
        claim.sourceType === "research"
          ? ("external" as const)
          : ("user" as const),
      evidenceRef,
      createdAt
    });
    return {
      ...claim,
      status: "PROMOTED" as const,
      dispositionConfirmedByUser: true,
      promotedFactId: factId
    };
  });

  const usageRules = (draft.usageRules ?? []).map((rule) => {
    if (rule.dispositionConfirmedByUser) return rule;
    const disposition = usageRuleDispositions[rule.id];
    if (!disposition) {
      throw new DomainValidationError(
        `Missing user disposition for ProductUsageRule: ${rule.id}`
      );
    }
    if (disposition === "CONFIRM") {
      return {
        ...rule,
        status: "CONFIRMED" as const,
        dispositionConfirmedByUser: true
      };
    }
    if (disposition === "REJECT") {
      return {
        ...rule,
        status: "REJECTED" as const,
        dispositionConfirmedByUser: true
      };
    }
    return {
      ...rule,
      status: "UNVERIFIED" as const,
      dispositionConfirmedByUser: true
    };
  });

  const base = {
    ...draft,
    id: randomUUID(),
    version: draft.version + 1,
    status: "CONFIRMED" as const,
    confirmedFeatures: [...draft.confirmedFeatures, ...promotedFacts],
    uncertainClaims,
    usageRules,
    confirmedAt: createdAt
  };
  return productTruthSchema.parse({
    ...base,
    contentHash: hashWithoutRuntimeFields(base as unknown as Record<string, unknown>)
  });
}

export function confirmScriptDraft(
  draftInput: ScriptDraft,
  now = new Date()
): ScriptDraft {
  const draft = scriptDraftSchema.parse(draftInput);
  if (draft.status !== "DRAFT") {
    throw new DomainValidationError("Only DRAFT ScriptDraft can be confirmed");
  }
  const base = {
    ...draft,
    id: randomUUID(),
    version: draft.version + 1,
    status: "CONFIRMED" as const,
    confirmedAt: now.toISOString()
  };
  return scriptDraftSchema.parse({
    ...base,
    contentHash: hashWithoutRuntimeFields(base as unknown as Record<string, unknown>)
  });
}

export function confirmProductionPlanDraft(
  draftInput: ProductionPlan,
  now = new Date()
): ProductionPlan {
  const draft = productionPlanSchema.parse(draftInput);
  if (draft.status !== "DRAFT") {
    throw new DomainValidationError("Only DRAFT ProductionPlan can be confirmed");
  }
  const base = {
    ...draft,
    id: randomUUID(),
    version: draft.version + 1,
    status: "CONFIRMED" as const,
    confirmedAt: now.toISOString()
  };
  return productionPlanSchema.parse({
    ...base,
    contentHash: hashWithoutRuntimeFields(base as unknown as Record<string, unknown>)
  });
}
