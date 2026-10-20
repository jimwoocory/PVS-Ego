import type { SmartGenerationRun, SmartRunStatus } from "../../domain/smart-generation.js";

export interface SmartRunRepository {
  create(run: SmartGenerationRun): Promise<SmartGenerationRun>;
  get(projectId: string, runId: string): Promise<SmartGenerationRun | null>;
  findByRequestKey(projectId: string, requestKey: string): Promise<SmartGenerationRun | null>;
  list(projectId?: string, statuses?: SmartRunStatus[]): Promise<SmartGenerationRun[]>;
  save(run: SmartGenerationRun, expectedRevision: number, leaseOwner: string): Promise<SmartGenerationRun>;
  acquire(projectId: string, runId: string, owner: string, pid: number): Promise<boolean>;
  release(projectId: string, runId: string, owner: string): Promise<void>;
  lease(projectId: string, runId: string): Promise<{ owner: string; pid: number } | null>;
  releaseAbandoned(projectId: string, runId: string, previousOwner: string): Promise<void>;
}
