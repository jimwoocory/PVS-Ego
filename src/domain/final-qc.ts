import { z } from "zod";
import { sha256Schema, isoDateTimeSchema, entityIdSchema } from "./schemas.js";

export const finalQcSeveritySchema = z.enum(["PASS", "WARN", "BLOCK"]);
export type FinalQcSeverity = z.infer<typeof finalQcSeveritySchema>;

export const finalQcCheckCodeSchema = z.enum([
  "ARTIFACT_INTEGRITY",
  "FILE_PLAYABLE",
  "VIDEO_STREAM",
  "DURATION",
  "RESOLUTION",
  "ASPECT_RATIO",
  "AUDIO_STREAM",
  "LONG_SILENCE",
  "BLACK_FRAMES",
  "FREEZE_FRAMES",
  "TEXT_INTEGRITY",
  "TEXT_SAFE_AREA",
  "VISUAL_PRODUCT_IDENTITY"
]);
export type FinalQcCheckCode = z.infer<typeof finalQcCheckCodeSchema>;

export const finalQcCheckSchema = z.object({
  code: finalQcCheckCodeSchema,
  severity: finalQcSeveritySchema,
  label: z.string().min(1),
  message: z.string().min(1),
  technical: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
}).strict();
export type FinalQcCheck = z.infer<typeof finalQcCheckSchema>;

export const finalQcReportSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  assemblyId: entityIdSchema,
  artifactId: entityIdSchema,
  artifactHash: sha256Schema,
  timelineId: entityIdSchema.optional(),
  timelineHash: sha256Schema.optional(),
  evaluatorVersion: z.string().min(1),
  overall: finalQcSeveritySchema,
  checks: z.array(finalQcCheckSchema).min(1),
  createdAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict();
export type FinalQcReport = z.infer<typeof finalQcReportSchema>;
