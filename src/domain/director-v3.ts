import { z } from "zod";
import {
  entityIdSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  sha256Schema,
  versionRefSchema
} from "./schemas.js";

export const DIRECTOR_V3_VERSION = "director-v3-1" as const;
export const SEEDANCE_PROMPT_V3_VERSION = "seedance-prompt-v3-1" as const;

export const scriptFeasibilityIssueCodeSchema = z.enum([
  "TOO_MANY_BEATS",
  "ACTION_DENSITY_HIGH",
  "SCENE_DENSITY_HIGH",
  "PRODUCT_STATE_DENSITY_HIGH",
  "EDITING_INSTRUCTION_IN_STORY",
  "BURNED_TEXT_INSTRUCTION",
  "AUDIO_INTENT_MISSING",
  "DURATION_OVERLOAD",
  "BEAT_DURATION_UNIFORM",
  "BEAT_SPEECH_OVERLOAD",
  "BEAT_ACTION_OVERLOAD",
  "BEAT_DURATION_IDLE",
  "NARRATIVE_DESCRIPTION_THIN",
  "NARRATIVE_TRANSITION_UNCLEAR",
  "NARRATIVE_DUPLICATE_BEAT"
]);

export const scriptFeasibilityIssueSchema = z.object({
  code: scriptFeasibilityIssueCodeSchema,
  severity: z.enum(["REVISE", "WARN"]),
  beatIds: z.array(entityIdSchema).default([]),
  message: nonEmptyStringSchema,
  suggestion: nonEmptyStringSchema
}).strict();

export const scriptFeasibilityReportSchema = z.object({
  version: z.literal(DIRECTOR_V3_VERSION),
  projectId: entityIdSchema,
  scriptRef: versionRefSchema,
  status: z.enum(["PASS", "REVISE"]),
  metrics: z.object({
    beatCount: z.number().int().nonnegative(),
    estimatedTotalMs: z.number().int().nonnegative(),
    detectedActionCount: z.number().int().nonnegative(),
    detectedSceneTransitionCount: z.number().int().nonnegative(),
    detectedProductStateChangeCount: z.number().int().nonnegative(),
    editingDirectiveCount: z.number().int().nonnegative(),
    burnedTextDirectiveCount: z.number().int().nonnegative()
  }).strict(),
  timingAudit: z.array(z.object({
    beatId: entityIdSchema,
    order: z.number().int().nonnegative(),
    assignedMs: z.number().int().positive(),
    estimatedSpeechMs: z.number().int().nonnegative(),
    estimatedActionMs: z.number().int().nonnegative(),
    minimumPlausibleMs: z.number().int().nonnegative(),
    sceneChanged: z.boolean()
  }).strict()).optional(),
  issues: z.array(scriptFeasibilityIssueSchema),
  createdAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict();

export const directorV3AudioIntentSchema = z.object({
  mode: z.enum(["NATIVE", "SILENT"]).default("NATIVE"),
  dialogueOrOs: z.array(z.object({
    kind: z.enum(["DIALOGUE", "OS"]),
    text: nonEmptyStringSchema
  }).strict()).default([]),
  ambience: z.array(nonEmptyStringSchema).default([]),
  sfx: z.array(nonEmptyStringSchema).default([]),
  bgm: z.literal(false)
}).strict();

export const directorV3TimedActionSchema = z.object({
  order: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  description: nonEmptyStringSchema,
  productState: z.string().trim().min(1).optional()
}).strict().superRefine((value, ctx) => {
  if (value.endMs <= value.startMs) {
    ctx.addIssue({
      code: "custom",
      path: ["endMs"],
      message: "endMs must be greater than startMs"
    });
  }
});

export const directorV3ClipContractSchema = z.object({
  id: entityIdSchema,
  order: z.number().int().positive(),
  sourceBeatIds: z.array(entityIdSchema).min(1),
  purpose: nonEmptyStringSchema,
  location: nonEmptyStringSchema,
  durationMs: z.number().int().min(1000).max(120000),
  openingState: nonEmptyStringSchema,
  closingState: nonEmptyStringSchema,
  actions: z.array(directorV3TimedActionSchema).min(1).max(5),
  camera: z.object({
    shotSize: nonEmptyStringSchema,
    position: nonEmptyStringSchema,
    angle: nonEmptyStringSchema,
    movement: nonEmptyStringSchema
  }).strict(),
  referenceAssetIds: z.array(nonEmptyStringSchema).default([]),
  productStateChanges: z.array(nonEmptyStringSchema).max(3).default([]),
  audio: directorV3AudioIntentSchema,
  globalConstraints: z.object({
    preserveProductIdentity: z.boolean().default(true),
    noReadableText: z.boolean().default(true),
    noBgm: z.literal(true),
    extra: z.array(nonEmptyStringSchema).default([])
  }).strict()
}).strict().superRefine((clip, ctx) => {
  const sorted = [...clip.actions].sort((a, b) => a.order - b.order);
  if (sorted[0]?.startMs !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["actions", 0, "startMs"],
      message: "clip actions must start at 0"
    });
  }
  if (sorted.at(-1)?.endMs !== clip.durationMs) {
    ctx.addIssue({
      code: "custom",
      path: ["actions"],
      message: "clip actions must end at durationMs"
    });
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1]!.endMs !== sorted[i]!.startMs) {
      ctx.addIssue({
        code: "custom",
        path: ["actions", i],
        message: "clip actions must be contiguous"
      });
      break;
    }
  }
});

export const directorV3PlanSchema = z.object({
  version: z.literal(DIRECTOR_V3_VERSION),
  projectId: entityIdSchema,
  scriptRef: versionRefSchema,
  targetDurationMs: z.number().int().min(10000).max(120000),
  clipContracts: z.array(directorV3ClipContractSchema).min(1),
  createdAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict().superRefine((plan, ctx) => {
  const total = plan.clipContracts.reduce(
    (sum, clip) => sum + clip.durationMs,
    0
  );
  if (total !== plan.targetDurationMs) {
    ctx.addIssue({
      code: "custom",
      path: ["clipContracts"],
      message: "clip contract durations must equal targetDurationMs"
    });
  }
});

export const seedancePromptV3DraftSchema = z.object({
  version: z.literal(SEEDANCE_PROMPT_V3_VERSION),
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  sourceContractHash: sha256Schema,
  status: z.enum(["DRAFT", "CONFIRMED"]),
  promptText: nonEmptyStringSchema,
  originalPromptText: nonEmptyStringSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict();

export type ScriptFeasibilityIssue = z.infer<
  typeof scriptFeasibilityIssueSchema
>;
export type ScriptFeasibilityReport = z.infer<
  typeof scriptFeasibilityReportSchema
>;
export type DirectorV3AudioIntent = z.infer<
  typeof directorV3AudioIntentSchema
>;
export type DirectorV3ClipContract = z.infer<
  typeof directorV3ClipContractSchema
>;
export type DirectorV3Plan = z.infer<
  typeof directorV3PlanSchema
>;
export type SeedancePromptV3Draft = z.infer<
  typeof seedancePromptV3DraftSchema
>;
