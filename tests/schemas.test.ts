import test from "node:test";
import assert from "node:assert/strict";
import {
  clipSchema,
  preflightReportSchema,
  projectSchema,
  productTruthSchema
} from "../src/domain/schemas.js";
import { assertFactReferences, DomainValidationError } from "../src/domain/validation.js";
import { makeProductTruth, makeValidClip } from "./fixtures.js";

test("valid Clip/Segment timeline passes", () => {
  assert.equal(clipSchema.safeParse(makeValidClip()).success, true);
});

test("Project target duration accepts 10-120 seconds and rejects outside range", () => {
  const base = {
    id: "project-duration",
    name: "Duration",
    status: "DRAFT",
    targetPlatform: "douyin",
    aspectRatio: "9:16",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
  assert.equal(projectSchema.safeParse({ ...base, targetDurationMs: 10000 }).success, true);
  assert.equal(projectSchema.safeParse({ ...base, targetDurationMs: 120000 }).success, true);
  assert.equal(projectSchema.safeParse({ ...base, targetDurationMs: 9999 }).success, false);
  assert.equal(projectSchema.safeParse({ ...base, targetDurationMs: 120001 }).success, false);
});

test("Clip duration outside 4-15 seconds is rejected", () => {
  const clip = makeValidClip();
  clip.durationMs = 3999;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("Segment gap is rejected", () => {
  const clip = makeValidClip();
  clip.segments[1]!.startMs = 4100;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("Segment overlap is rejected", () => {
  const clip = makeValidClip();
  clip.segments[1]!.startMs = 3900;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("Clip opening continuity mismatch is rejected", () => {
  const clip = makeValidClip();
  clip.segments[0]!.continuityIn.stateHash = "9".repeat(64);
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("missing explicit audio fields are rejected", () => {
  const clip = structuredClone(makeValidClip()) as unknown as Record<string, unknown>;
  const segments = clip.segments as Array<Record<string, unknown>>;
  delete segments[0]!.ambientSound;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("speech longer than Segment is rejected", () => {
  const clip = makeValidClip();
  clip.segments[1]!.dialogueOrNarration = {
    kind: "NARRATION",
    text: "too long",
    estimatedDurationMs: 5000,
    estimatorVersion: "p0-v1"
  };
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("UncertainClaim cannot be used as ProductFact reference", () => {
  assert.throws(
    () => assertFactReferences(makeProductTruth(), ["claim-1"]),
    (error: unknown) => error instanceof DomainValidationError && /UncertainClaim/.test(error.message)
  );
});

test("PASS preflight cannot carry blockers", () => {
  const report = {
    id: "p",
    projectId: "project-1",
    generationRequestId: "request-1",
    requestHash: "a".repeat(64),
    status: "PASS",
    providerIdentityHash: "b".repeat(64),
    capabilityFingerprint: "c".repeat(64),
    clipCount: 1,
    totalGeneratedMs: 8000,
    highRiskClipIds: [],
    costEstimate: {
      status: "UNKNOWN",
      observedAt: "2026-09-27T05:00:00.000Z"
    },
    blockers: ["identity unknown"],
    warnings: [],
    reportHash: "d".repeat(64),
    createdAt: "2026-09-27T05:00:00.000Z"
  };
  assert.equal(preflightReportSchema.safeParse(report).success, false);
});

test("STALE preflight requires staleAt", () => {
  const report = {
    id: "p",
    projectId: "project-1",
    generationRequestId: "request-1",
    requestHash: "a".repeat(64),
    status: "STALE",
    providerIdentityHash: "b".repeat(64),
    capabilityFingerprint: "c".repeat(64),
    clipCount: 1,
    totalGeneratedMs: 8000,
    highRiskClipIds: [],
    costEstimate: {
      status: "KNOWN",
      estimatedCredits: 1,
      observedAt: "2026-09-27T05:00:00.000Z"
    },
    blockers: [],
    warnings: [],
    reportHash: "d".repeat(64),
    createdAt: "2026-09-27T05:00:00.000Z"
  };
  assert.equal(preflightReportSchema.safeParse(report).success, false);
});

test("Clip duration above 15 seconds is rejected", () => {
  const clip = makeValidClip();
  clip.durationMs = 15001;
  clip.segments[1]!.endMs = 15001;
  clip.closingState = {
    ...clip.closingState,
    stateHash: clip.segments[1]!.continuityOut.stateHash
  };
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("Clip with zero Segments is rejected", () => {
  const clip = makeValidClip();
  clip.segments = [];
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("non-integer Segment milliseconds are rejected", () => {
  const clip = makeValidClip();
  clip.segments[0]!.endMs = 3999.5;
  clip.segments[1]!.startMs = 3999.5;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("first Segment must start at zero", () => {
  const clip = makeValidClip();
  clip.segments[0]!.startMs = 1;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("last Segment must end at Clip duration", () => {
  const clip = makeValidClip();
  clip.segments[1]!.endMs = 7999;
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("zero-length and reversed Segments are rejected", () => {
  const zero = makeValidClip();
  zero.segments[0]!.endMs = zero.segments[0]!.startMs;
  assert.equal(clipSchema.safeParse(zero).success, false);

  const reversed = makeValidClip();
  reversed.segments[0]!.endMs = reversed.segments[0]!.startMs - 1;
  assert.equal(clipSchema.safeParse(reversed).success, false);
});

test("Clip closing continuity mismatch is rejected", () => {
  const clip = makeValidClip();
  clip.segments[clip.segments.length - 1]!.continuityOut.stateHash =
    "8".repeat(64);
  assert.equal(clipSchema.safeParse(clip).success, false);
});

test("null or empty-string audio representations are rejected", () => {
  const nullAudio = structuredClone(makeValidClip()) as unknown as Record<string, unknown>;
  const nullSegments = nullAudio.segments as Array<Record<string, unknown>>;
  nullSegments[0]!.dialogueOrNarration = null;
  assert.equal(clipSchema.safeParse(nullAudio).success, false);

  const emptyAudio = structuredClone(makeValidClip()) as unknown as Record<string, unknown>;
  const emptySegments = emptyAudio.segments as Array<Record<string, unknown>>;
  emptySegments[0]!.ambientSound = "";
  assert.equal(clipSchema.safeParse(emptyAudio).success, false);
});

test("ForbiddenChange cannot degrade to string[]", () => {
  const truth = structuredClone(makeProductTruth()) as unknown as Record<string, unknown>;
  truth.forbiddenChanges = ["do not change logo"];
  assert.equal(productTruthSchema.safeParse(truth).success, false);
});
