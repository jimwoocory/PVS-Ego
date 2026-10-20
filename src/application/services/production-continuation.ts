import fs from "node:fs/promises";
import { z } from "zod";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { versionRefSchema, type ProductionPlan, type ScriptDraft, type ProductTruth } from "../../domain/schemas.js";
import { productionStrategySchema, productionAssetSetSchema, assetPaidScopeSchema } from "../../domain/production-strategy.js";
import { directorV3PlanSchema, DIRECTOR_V3_VERSION } from "../../domain/director-v3.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { buildSeedancePromptV3, createSeedancePromptV3Draft } from "./seedance-model-prompt-v3.js";

const savedPlanningSchema = z.object({
  projectId: z.string(), confirmedScript: versionRefSchema,
  assets: z.object({ strategy: productionStrategySchema, set: productionAssetSetSchema, paidScope: assetPaidScopeSchema.optional(), authorized: z.literal(false) }),
  director: z.object({ planId: z.string(), planHash: z.string() }),
  ending: z.object({ mode: z.string(), durationMs: z.number().int().positive() }).optional()
});

/** Only trusted local records bound to current versions can seed an executable task. */
export async function readSavedProductionPlanning(input: {
  projectId: string; artifactId: string; artifactHash: string; artifacts: ArtifactRepository;
  store: LocalArtifactStore; script: ScriptDraft; plan: ProductionPlan;
}) {
  const fail = () => new DomainValidationError("制作规划资料与当前项目、脚本、分镜或文件校验不一致，未创建任务");
  const artifact = await input.artifacts.findById(input.artifactId);
  if (!artifact || artifact.projectId !== input.projectId || artifact.kind !== "STRUCTURED_SNAPSHOT" ||
      artifact.integrityStatus !== "READY" || artifact.sha256 !== input.artifactHash || !artifact.relativePath.startsWith("production-planning/")) throw fail();
  const bytes = await fs.readFile(input.store.resolveArtifactPath(artifact.relativePath));
  if (sha256Bytes(bytes) !== artifact.sha256) throw fail();
  const result = savedPlanningSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!result.success) throw fail();
  const value = result.data, { strategy, set, paidScope } = value.assets;
  if (value.projectId !== input.projectId || strategy.projectId !== input.projectId || set.projectId !== input.projectId ||
      input.script.status !== "CONFIRMED" || value.confirmedScript.entityType !== "ScriptDraft" ||
      value.confirmedScript.entityId !== input.script.id || value.confirmedScript.version !== input.script.version || value.confirmedScript.hash !== input.script.contentHash ||
      value.director.planId !== input.plan.id || value.director.planHash !== input.plan.contentHash || input.plan.scriptRef.hash !== input.script.contentHash ||
      strategy.selectedCreativeId !== input.script.selectedCreativeId || set.selectedCreativeId !== strategy.selectedCreativeId ||
      set.strategyRef.hash !== strategy.contentHash || input.plan.productionAssetSetRef?.hash !== set.contentHash ||
      set.entries.some(e => e.source === "DREAMINA_GENERATED" && (e.status !== "PLANNED" || e.submitId || e.artifactIds.length))) throw fail();
  for (const item of [strategy, set]) {
    const { contentHash, ...body } = item;
    if (hashValue(body) !== contentHash) throw fail();
  }
  if (paidScope && (paidScope.strategyHash !== strategy.contentHash || paidScope.assets.some(a =>
    !set.entries.some(e => e.key === a.key && e.generationRequestHash === a.requestHash && e.status === "PLANNED")))) throw fail();
  if (set.entries.some(e => e.source === "DREAMINA_GENERATED" && e.status === "PLANNED") && !paidScope) throw fail();
  return value;
}

/** Compile existing shots deterministically; this must not rewrite the approved story. */
export function compileExistingDirector(input: {
  truth: ProductTruth; script: ScriptDraft; plan: ProductionPlan;
  assets: z.infer<typeof productionAssetSetSchema>;
}) {
  if (!input.plan.generationTarget) throw new DomainValidationError("已有分镜缺少模型规格");
  const clips = input.plan.scenes.flatMap(scene => scene.clips.map(clip => ({ scene, clip })));
  const body = {
    version: DIRECTOR_V3_VERSION, projectId: input.plan.projectId, scriptRef: input.plan.scriptRef,
    targetDurationMs: clips.reduce((sum, item) => sum + item.clip.durationMs, 0),
    clipContracts: clips.map(({ scene, clip }) => ({
      id: clip.id, order: clip.order, sourceBeatIds: clip.sourceBeatIds, purpose: clip.purpose,
      location: scene.location, durationMs: clip.durationMs,
      openingState: clip.openingState.description, closingState: clip.closingState.description,
      actions: clip.segments.map(s => ({ order: s.order, startMs: s.startMs, endMs: s.endMs,
        description: `${s.shotSize}，${s.composition}；${s.subjectAction}；${s.cameraMovement}`, productState: s.productState })),
      camera: { shotSize: clip.segments[0]!.shotSize, position: clip.segments[0]!.cameraPosition,
        angle: clip.segments[0]!.cameraAngle, movement: clip.segments[0]!.cameraMovement },
      referenceAssetIds: clip.referenceAssets.map(r => r.assetId), productStateChanges: [],
      audio: { mode: input.plan.generationTarget!.nativeAudioOutputRequested ? "NATIVE" as const : "SILENT" as const,
        dialogueOrOs: clip.segments.flatMap(s => s.dialogueOrNarration.kind === "NONE" || !s.dialogueOrNarration.text ? [] :
          [{ kind: s.dialogueOrNarration.kind === "DIALOGUE" ? "DIALOGUE" as const : "OS" as const, text: s.dialogueOrNarration.text }]),
        ambience: [...new Set(clip.segments.flatMap(s => s.ambientSound.kind === "AMBIENT" ? [s.ambientSound.description] : []))], sfx: [], bgm: false as const },
      globalConstraints: { preserveProductIdentity: true, noReadableText: true, noBgm: true as const,
        extra: [input.plan.visualDirection, ...input.plan.productShowcaseRules] }
    })), createdAt: new Date().toISOString()
  };
  const directorV3Plan = directorV3PlanSchema.parse({ ...body, contentHash: hashValue(body) });
  const target = input.plan.generationTarget;
  const seedancePromptDrafts = clips.map(({ scene, clip }, n) => {
    const contract = directorV3Plan.clipContracts[n]!;
    return createSeedancePromptV3Draft({ projectId: input.plan.projectId, clipId: clip.id, contract,
      promptText: buildSeedancePromptV3({ truth: input.truth, plan: input.plan, scene, clip, contract,
        productionAssetSet: input.assets, model: target.requestedModelVersion, aspectRatio: target.aspectRatio, videoResolution: target.videoResolution }) });
  });
  return { directorV3Plan, seedancePromptDrafts };
}
