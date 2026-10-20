import type { ProductionPlan } from "../../domain/schemas.js";
import type { SmartGenerationRun } from "../../domain/smart-generation.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import { DomainValidationError } from "../../domain/validation.js";

/** Only an exact saved run for the current plan can provide ProductionAssetSet bindings. */
export function findProductionRunForPlan(
  projectId: string,
  plan: Pick<ProductionPlan, "id" | "contentHash">,
  runs: ReadonlyArray<SmartGenerationRun>
): SmartGenerationRun | null {
  return [...runs]
    .filter(run =>
      run.projectId === projectId &&
      run.productionPlan?.id === plan.id &&
      run.productionPlan?.contentHash === plan.contentHash &&
      run.productionAssetSet?.projectId === projectId
    )
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** A saved asset set may not be used as a shortcut around human confirmation. */
export function assertProductionAssetBinding(
  projectId: string,
  set: ProductionAssetSet | undefined,
  requiredReferenceIds: ReadonlyArray<string>
): void {
  const referencedGeneratedIds = [...new Set(
    requiredReferenceIds.filter(id => id.startsWith("production-asset:"))
  )];
  if (!referencedGeneratedIds.length) return;
  if (!set || set.projectId !== projectId || set.status !== "READY") {
    throw new DomainValidationError(
      "当前镜头的角色或场景制作资产未准备好。请返回原智能生成任务查看实际图片并确认后再重新检查。"
    );
  }
  for (const id of referencedGeneratedIds) {
    const item = set.entries.find(entry => entry.referenceAssetId === id);
    if (!item || item.status !== "READY" || !item.artifactIds[0]) {
      throw new DomainValidationError(
        "当前镜头缺少已准备好的角色或场景参考图，请回到制作资产审核处查看。"
      );
    }
    if (item.source === "DREAMINA_GENERATED" && !item.humanConfirmedAt) {
      throw new DomainValidationError(
        "当前镜头使用的 AI 角色或场景图片尚未得到人工确认，请先看图并确认。"
      );
    }
  }
}

/** Requests only use the exact asset-set version/hash bound in approval. */
export function findProductionSetForRequest(
  projectId: string,
  versionRef: {entityId:string;hash:string} | undefined,
  runs: ReadonlyArray<SmartGenerationRun>
): ProductionAssetSet | null {
  if (!versionRef) return null;
  return runs
    .filter(run =>
      run.projectId === projectId &&
      run.productionAssetSet?.projectId === projectId &&
      run.productionAssetSet.id === versionRef.entityId &&
      run.productionAssetSet.contentHash === versionRef.hash
    )
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]?.productionAssetSet ?? null;
}
