import type {
  Clip,
  GenerationAttempt,
  GenerationRequest,
  PreflightReport,
  ProductTruth,
  UserApproval
} from "../src/domain/schemas.js";

export const H = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
  zero: "0".repeat(64),
  one: "1".repeat(64),
  two: "2".repeat(64),
  three: "3".repeat(64),
  four: "4".repeat(64),
  five: "5".repeat(64)
} as const;

export const ISO = "2026-09-27T05:00:00.000Z";

function state(stateHash: string, label: string) {
  return {
    description: label,
    productState: label,
    environmentState: "studio",
    stateHash
  };
}

export function makeValidClip(): Clip {
  return {
    id: "clip-1",
    sceneId: "scene-1",
    order: 1,
    durationMs: 8000,
    purpose: "show product",
    openingState: state(H.a, "open"),
    closingState: state(H.c, "close"),
    referenceAssets: [],
    productVisibility: "HERO",
    strictProductIdentity: true,
    strictProductIdentityScope: ["logo", "shape"],
    riskAssessment: {
      level: "LOW",
      reasonCodes: [],
      mitigations: [],
      source: "PRODUCT_DIRECTOR"
    },
    sourceBeatIds: ["beat-1"],
    requiredFactIds: ["fact-1"],
    segments: [
      {
        id: "seg-1",
        order: 1,
        startMs: 0,
        endMs: 4000,
        shotSize: "medium",
        cameraPosition: "front",
        cameraAngle: "eye-level",
        cameraMovement: "push-in",
        composition: "centered",
        subjectAction: "present product",
        productState: "closed",
        dialogueOrNarration: { kind: "NONE" },
        ambientSound: { kind: "NONE" },
        postProductionText: [],
        lighting: "soft",
        continuityIn: state(H.a, "open"),
        continuityOut: state(H.b, "middle"),
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"]
      },
      {
        id: "seg-2",
        order: 2,
        startMs: 4000,
        endMs: 8000,
        shotSize: "close-up",
        cameraPosition: "front",
        cameraAngle: "eye-level",
        cameraMovement: "static",
        composition: "product hero",
        subjectAction: "reveal logo",
        productState: "hero",
        dialogueOrNarration: {
          kind: "NARRATION",
          text: "核心卖点",
          estimatedDurationMs: 1500,
          estimatorVersion: "p0-v1"
        },
        ambientSound: { kind: "AMBIENT", description: "quiet studio" },
        postProductionText: [],
        lighting: "hero light",
        continuityIn: state(H.b, "middle"),
        continuityOut: state(H.c, "close"),
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"]
      }
    ],
    aggregateStatus: "READY",
    contentHash: H.d
  };
}

export function makeProductTruth(): ProductTruth {
  return {
    id: "truth-1",
    projectId: "project-1",
    version: 1,
    status: "CONFIRMED",
    productName: "Test Product",
    referenceImageIds: ["asset-1"],
    canonicalImageId: "asset-1",
    standardColors: ["black"],
    confirmedFeatures: [{
      id: "fact-1",
      statement: "Feature one",
      sourceType: "user",
      createdAt: ISO
    }],
    sellingPoints: [],
    forbiddenChanges: [{
      id: "forbid-1",
      field: "logo",
      description: "Do not change logo",
      severity: "HARD"
    }],
    uncertainClaims: [{
      id: "claim-1",
      statement: "Unverified claim",
      reason: "No evidence",
      status: "UNVERIFIED",
      dispositionConfirmedByUser: true
    }],
    evidenceRefs: [],
    inputRefs: [],
    contentHash: H.a,
    confirmedAt: ISO
  };
}

export function makeRequest(): GenerationRequest {
  return {
    id: "request-1",
    projectId: "project-1",
    clipId: "clip-1",
    compiledPromptId: "prompt-1",
    compiledPromptHash: H.a,
    provider: "domestic-jimeng-cli",
    providerIdentityHash: H.b,
    capabilityFingerprint: H.c,
    model: "seedance-2.0",
    promptText: "deterministic prompt",
    assetManifest: [],
    durationMs: 8000,
    aspectRatio: "9:16",
    generateAudio: true,
    inputVersionRefs: [],
    createdAt: ISO,
    requestHash: H.d
  };
}

export function makePreflight(): PreflightReport {
  return {
    id: "preflight-1",
    projectId: "project-1",
    generationRequestId: "request-1",
    requestHash: H.d,
    status: "PASS",
    providerIdentityHash: H.b,
    capabilityFingerprint: H.c,
    clipCount: 1,
    totalGeneratedMs: 8000,
    highRiskClipIds: [],
    costEstimate: { status: "UNKNOWN", observedAt: ISO },
    blockers: [],
    warnings: ["cost unknown"],
    reportHash: H.e,
    createdAt: ISO
  };
}

export function makeApproval(): UserApproval {
  return {
    id: "approval-1",
    projectId: "project-1",
    generationRequestId: "request-1",
    requestHash: H.d,
    preflightReportId: "preflight-1",
    preflightHash: H.e,
    providerIdentityHash: H.b,
    capabilityFingerprint: H.c,
    costSnapshot: { status: "UNKNOWN", observedAt: ISO },
    acceptedUnknownCostRisk: true,
    acceptedDuplicateSubmissionRisk: false,
    status: "ACTIVE",
    approvedAt: ISO,
    approvalHash: H.f
  };
}

export function makeAttempt(): GenerationAttempt {
  return {
    id: "attempt-1",
    projectId: "project-1",
    clipId: "clip-1",
    attemptNumber: 1,
    generationRequestId: "request-1",
    requestHash: H.d,
    preflightReportId: "preflight-1",
    userApprovalId: "approval-1",
    approvalHash: H.f,
    submissionFingerprint: H.one,
    status: "CREATED",
    commandAttempts: [],
    createdAt: ISO
  };
}
