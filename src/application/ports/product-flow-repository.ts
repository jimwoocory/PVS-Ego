import type { Project } from "../../domain/schemas.js";

export type VersionedEntityType =
  | "ProductTruth"
  | "CreativeBatch"
  | "ScriptDraft"
  | "ProductionPlan"
  | "CompiledPrompt"
  | "GenerationRequest"
  | "PreflightReport"
  | "UserApproval";

export type StoredVersionInput = {
  id: string;
  projectId: string;
  entityType: VersionedEntityType;
  entityKey: string;
  version: number;
  status: string;
  contentHash: string;
  data: unknown;
};

export type ProjectPointerPatch = {
  status?: Project["status"];
  currentProductTruthRef?: Project["currentProductTruthRef"] | null;
  currentCreativeBatchRef?: Project["currentCreativeBatchRef"] | null;
  selectedCreativeId?: string | null;
  currentScriptRef?: Project["currentScriptRef"] | null;
  currentProductionPlanRef?: Project["currentProductionPlanRef"] | null;
};

export type CommitVersionInput = {
  version: StoredVersionInput;
  staleEntityTypes: readonly VersionedEntityType[];
  projectPatch: ProjectPointerPatch;
};

export interface ProductFlowRepository {
  createProject(project: Project): Promise<Project>;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project | null>;
  nextVersion(projectId: string, entityType: VersionedEntityType, entityKey: string): Promise<number>;
  getVersion<T>(projectId: string, entityType: VersionedEntityType, id: string, version: number): Promise<T | null>;
  commitVersion(input: CommitVersionInput): Promise<Project>;
  commitProjectUpdate(
    projectId: string,
    staleEntityTypes: readonly VersionedEntityType[],
    patch: ProjectPointerPatch
  ): Promise<Project>;
}
