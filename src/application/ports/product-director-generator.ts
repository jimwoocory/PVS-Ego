import type {
  CreativeBatch,
  DirectorGenerationTarget,
  ProductTruth,
  ProductionPlan,
  ReferenceVideoProfile,
  ScriptDraft
} from "../../domain/schemas.js";
import type { CreativeProductionContext } from "../../domain/smart-generation.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { DirectorV3Plan } from "../../domain/director-v3.js";
import type { V8DirectorDecision } from "../services/v8-director-decision.js";

export type ProductDirectorInput = {
  productTruth: ProductTruth;
  creativeBatch: CreativeBatch;
  selectedCreativeId: string;
  script: ScriptDraft;
  referenceVideoProfile?: ReferenceVideoProfile | null;
  projectTargetDurationMs: number;
  generationTarget?: DirectorGenerationTarget;
  creativeContext?: CreativeProductionContext;
  productionAssetSet?: ProductionAssetSet;
  directorV3Plan?: DirectorV3Plan;
  /** Mutually exclusive: V8 makes narrative/shot-time decisions authoritative. */
  v8DirectorDecision?: V8DirectorDecision;
  productionPlanVersion?: number;
};

export interface ProductDirectorGenerator {
  id: string;
  version: string;
  generate(input: ProductDirectorInput): Promise<ProductionPlan>;
}
