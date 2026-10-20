import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  videoModelSchema,
  type VideoModel
} from "../../domain/schemas.js";

const generationConfigSchema = z.object({
  schemaVersion: z.literal("p0-v1"),
  model: videoModelSchema,
  videoResolution: z.literal("720p"),
  aspectRatio: z.literal("9:16"),
  updatedAt: z.string().datetime(),
  reason: z.string().trim().min(1)
});

export type GenerationConfig = z.infer<
  typeof generationConfigSchema
>;

export function loadGenerationConfig(
  configPath = path.join(
    process.cwd(),
    "config",
    "p0-generation.json"
  )
): GenerationConfig {
  const resolved = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return generationConfigSchema.parse(raw);
}

export function loadGenerationModel(
  configPath?: string
): VideoModel {
  return loadGenerationConfig(configPath).model;
}
