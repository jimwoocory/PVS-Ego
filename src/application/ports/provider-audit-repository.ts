import type {
  CommandAttemptRecord,
  ProviderCapability,
  ProviderIdentity
} from "../../domain/schemas.js";

export type PersistedCommandAttempt = CommandAttemptRecord & {
  projectId: string;
  generationAttemptId?: string;
  argvRedacted: string[];
};

export interface ProviderAuditRepository {
  saveIdentity(projectId: string, identity: ProviderIdentity): Promise<ProviderIdentity>;
  saveCapability(projectId: string, capability: ProviderCapability): Promise<ProviderCapability>;
  createCommandAttempt(input: PersistedCommandAttempt): Promise<PersistedCommandAttempt>;
  updateCommandAttempt(
    id: string,
    update: Partial<
      Pick<
        CommandAttemptRecord,
        | "completedAt"
        | "exitCode"
        | "signal"
        | "timedOut"
        | "stdoutArtifactId"
        | "stderrArtifactId"
        | "errorCode"
      >
    > & { argvRedacted?: string[] }
  ): Promise<PersistedCommandAttempt>;
  listCommandAttempts(projectId: string): Promise<PersistedCommandAttempt[]>;
}
