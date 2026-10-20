import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { v8DirectorRecordSchema, v8PromptRecordSchema } from "../../domain/v8-production.js";
import type { SmartGenerationRun } from "../../domain/smart-generation.js";
import { buildV8DirectorDecision } from "./v8-director-decision.js";
import { assertV8DirectorConformance } from "./v8-director-conformance.js";
import { directorClipBounds, assertDirectorSettingsMatch, assertDirectorPlanTarget } from "./director-generation-target.js";

export function assertV8DecisionBinding(run: SmartGenerationRun): void {
  const record = v8DirectorRecordSchema.parse(run.v8Director);
  if (run.v8Screenplay?.status !== "CONFIRMED" || run.script?.status !== "CONFIRMED") {
    throw new DomainValidationError("请先人工确认当前 V8 完整剧本");
  }
  assertContentHash(run.script, "V8 源剧本");
  assertDirectorSettingsMatch(record.generationTarget, run.options.generationSettings);
  const bounds = directorClipBounds(record.generationTarget);
  const rebuilt = buildV8DirectorDecision({ script: run.script, screenplay: run.v8Screenplay.screenplay,
    modelMinSeconds: bounds.minSeconds, modelMaxSeconds: bounds.maxSeconds });
  const { contentHash: _hash, ...actual } = record.decision;
  const { contentHash: _rebuilt, ...expected } = rebuilt;
  const stripped = { ...actual, clips: actual.clips.map(clip => ({ ...clip,
    shots: clip.shots.map(({ visualGuidance: _visual, ...shot }) => shot) })) };
  if (hashValue(stripped) !== hashValue(expected)) {
    throw new DomainValidationError("V8 镜头与已确认剧本不一致：不得增删台词、动作、镜头或提前揭晓；请返回剧本修改后重新审核");
  }
}

export function assertV8PlanBinding(run: SmartGenerationRun): void {
  assertV8DecisionBinding(run);
  if (run.v8Director?.status !== "CONFIRMED" || !run.productionPlan) {
    throw new DomainValidationError("请先明确采用当前 V8 导演决策，再审核正式分镜");
  }
  assertContentHash(run.productionPlan, "V8 正式分镜");
  if (run.productionPlan.v8Source?.screenplayHash !== run.v8Screenplay?.screenplayHash ||
      run.productionPlan.v8Source?.directorDecisionHash !== run.v8Director.decision.contentHash ||
      run.productionPlan.v8Source?.directorRecordHash !== run.v8Director.contentHash) {
    throw new DomainValidationError("V8 正式分镜缺少当前导演/剧本来源元数据，请重新生成并审核");
  }
  for (const clip of run.productionPlan.scenes.flatMap(s=>s.clips)) {
    assertContentHash(clip, "V8 视频编号 " + clip.order);
  }
  assertDirectorPlanTarget(run.productionPlan, run.v8Director.generationTarget);
  assertV8DirectorConformance(run.v8Director.decision, run.productionPlan);
}

function assertContentHash(value: { contentHash: string }, label: string): void {
  const copy = structuredClone(value) as unknown as Record<string, unknown>;
  delete copy.contentHash;
  delete copy.confirmedAt;
  if (value.contentHash !== hashValue(copy)) throw new DomainValidationError(label+"内容与哈希不一致，请重新保存并审核");
}

export function assertV8PromptBinding(run: SmartGenerationRun, requireConfirmed = true): void {
  assertV8PlanBinding(run);
  const record = v8PromptRecordSchema.parse(run.v8Prompts);
  if (run.productionPlan?.status !== "CONFIRMED" || !run.productionAssetSet ||
      record.assetSetHash !== run.productionAssetSet.contentHash ||
      record.screenplayHash !== run.v8Screenplay?.screenplayHash ||
      record.directorRecordHash !== run.v8Director?.contentHash ||
      (requireConfirmed && record.status !== "CONFIRMED")) {
    throw new DomainValidationError("V8 剧本、导演、资产或 PromptPackage 采用版本已失效，请重新审核；旧付费确认不能复用");
  }
  const clips = run.productionPlan.scenes.flatMap(scene => scene.clips);
  if (clips.length !== record.packages.length || record.packages.some((p, i) =>
      p.clipId !== clips[i]?.id || p.productionPlanHash !== run.productionPlan?.contentHash ||
      p.directorHash !== run.v8Director?.decision.contentHash || p.scriptHash !== run.script?.contentHash)) {
    throw new DomainValidationError("V8 PromptPackage 没有精确覆盖最新正式分镜，必须重新编译和人工采用");
  }
}
