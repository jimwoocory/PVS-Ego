import type { GenerationAttempt, WorkflowBlocker } from "../../domain/schemas.js";

export interface WorkflowRepository {
  /** Durable compare-and-set; real database adapters implement this. Test adapters may use the process queue. */
  claimCreatedAttempt?(id: string): Promise<GenerationAttempt | null>;
  createBlocker(blocker: WorkflowBlocker): Promise<WorkflowBlocker>;
  listOpenBlockers(projectId: string): Promise<WorkflowBlocker[]>;
  resolveBlocker(id: string, resolvedAt: string): Promise<WorkflowBlocker>;
  createGenerationAttempt(attempt: GenerationAttempt): Promise<GenerationAttempt>;
  getGenerationAttempt(id: string): Promise<GenerationAttempt | null>;
  nextAttemptNumber(clipId: string): Promise<number>;
  listGenerationAttempts(projectId: string): Promise<GenerationAttempt[]>;
  updateGenerationAttemptStatus(
    id: string,
    update: Pick<GenerationAttempt, "status"> &
      Partial<Pick<GenerationAttempt, "providerHandle" | "submittedAt" | "completedAt" | "errorCode" | "errorMessage" | "outputArtifactId" | "commandAttempts">>
  ): Promise<GenerationAttempt>;
}
