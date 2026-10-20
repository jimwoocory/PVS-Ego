import type {
  CommandAttemptRecord as PrismaCommandAttemptRow,
  PrismaClient
} from "@prisma/client";
import type {
  PersistedCommandAttempt,
  ProviderAuditRepository
} from "../../application/ports/provider-audit-repository.js";
import {
  commandAttemptRecordSchema,
  providerCapabilitySchema,
  providerIdentitySchema,
  type ProviderCapability,
  type ProviderIdentity
} from "../../domain/schemas.js";

function commandToDomain(
  row: PrismaCommandAttemptRow
): PersistedCommandAttempt {
  return {
    ...commandAttemptRecordSchema.parse({
      id: row.id,
      operation: row.operation,
      attemptNumber: row.attemptNumber,
      startedAt: row.startedAt.toISOString(),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
      ...(row.signal ? { signal: row.signal } : {}),
      timedOut: row.timedOut,
      ...(row.stdoutArtifactId ? { stdoutArtifactId: row.stdoutArtifactId } : {}),
      ...(row.stderrArtifactId ? { stderrArtifactId: row.stderrArtifactId } : {}),
      redactionRulesVersion: row.redactionRulesVersion,
      parserVersion: row.parserVersion,
      ...(row.errorCode ? { errorCode: row.errorCode } : {})
    }),
    projectId: row.projectId,
    ...(row.generationAttemptId
      ? { generationAttemptId: row.generationAttemptId }
      : {}),
    argvRedacted: JSON.parse(row.argvRedactedJson)
  };
}

export class PrismaProviderAuditRepository implements ProviderAuditRepository {
  constructor(private readonly db: PrismaClient) {}

  async saveIdentity(
    projectId: string,
    input: ProviderIdentity
  ): Promise<ProviderIdentity> {
    const identity = providerIdentitySchema.parse(input);
    await this.db.providerIdentityRecord.upsert({
      where: { id: identity.id },
      update: {
        officialSourceUrl: identity.officialSourceUrl,
        publisher: identity.publisher,
        packageName: identity.packageName,
        executablePath: identity.executablePath,
        executableSha256: identity.executableSha256,
        signatureInfo: identity.signatureInfo,
        cliVersion: identity.cliVersion,
        rawVersionArtifactId: identity.rawVersionArtifactId,
        rawHelpArtifactId: identity.rawHelpArtifactId,
        officialLoginOriginsJson: JSON.stringify(identity.officialLoginOrigins),
        capabilityFingerprint: identity.capabilityFingerprint,
        verificationStatus: identity.verificationStatus,
        verifiedAt: identity.verifiedAt ? new Date(identity.verifiedAt) : null
      },
      create: {
        id: identity.id,
        projectId,
        provider: identity.provider,
        officialSourceUrl: identity.officialSourceUrl,
        publisher: identity.publisher,
        packageName: identity.packageName,
        executablePath: identity.executablePath,
        executableSha256: identity.executableSha256,
        signatureInfo: identity.signatureInfo,
        cliVersion: identity.cliVersion,
        rawVersionArtifactId: identity.rawVersionArtifactId,
        rawHelpArtifactId: identity.rawHelpArtifactId,
        officialLoginOriginsJson: JSON.stringify(identity.officialLoginOrigins),
        capabilityFingerprint: identity.capabilityFingerprint,
        verificationStatus: identity.verificationStatus,
        verifiedAt: identity.verifiedAt ? new Date(identity.verifiedAt) : null
      }
    });
    return identity;
  }

  async saveCapability(
    projectId: string,
    input: ProviderCapability
  ): Promise<ProviderCapability> {
    const capability = providerCapabilitySchema.parse(input);
    await this.db.providerCapabilityRecord.create({
      data: {
        id: crypto.randomUUID(),
        projectId,
        provider: capability.provider,
        providerIdentityId: capability.providerIdentityId,
        cliFound: capability.cliFound,
        authenticated: String(capability.authenticated),
        supportedOperationsJson: JSON.stringify(capability.supportedOperations),
        supportedModelsJson: JSON.stringify(capability.supportedModels),
        supportedDurationsMsJson: capability.supportedDurationsMs
          ? JSON.stringify(capability.supportedDurationsMs)
          : null,
        rawProbeArtifactId: capability.rawProbeArtifactId,
        capabilityFingerprint: capability.capabilityFingerprint,
        probedAt: new Date(capability.probedAt)
      }
    });
    return capability;
  }

  async createCommandAttempt(
    input: PersistedCommandAttempt
  ): Promise<PersistedCommandAttempt> {
    const record = commandAttemptRecordSchema.parse(input);
    await this.db.commandAttemptRecord.create({
      data: {
        id: record.id,
        projectId: input.projectId,
        generationAttemptId: input.generationAttemptId,
        operation: record.operation,
        attemptNumber: record.attemptNumber,
        startedAt: new Date(record.startedAt),
        completedAt: record.completedAt ? new Date(record.completedAt) : null,
        exitCode: record.exitCode,
        signal: record.signal,
        timedOut: record.timedOut,
        stdoutArtifactId: record.stdoutArtifactId,
        stderrArtifactId: record.stderrArtifactId,
        redactionRulesVersion: record.redactionRulesVersion,
        parserVersion: record.parserVersion,
        errorCode: record.errorCode,
        argvRedactedJson: JSON.stringify(input.argvRedacted)
      }
    });
    return {
      ...record,
      projectId: input.projectId,
      ...(input.generationAttemptId
        ? { generationAttemptId: input.generationAttemptId }
        : {}),
      argvRedacted: [...input.argvRedacted]
    };
  }

  async updateCommandAttempt(
    id: string,
    update: Parameters<ProviderAuditRepository["updateCommandAttempt"]>[1]
  ): Promise<PersistedCommandAttempt> {
    const row = await this.db.commandAttemptRecord.update({
      where: { id },
      data: {
        ...(update.completedAt !== undefined
          ? { completedAt: new Date(update.completedAt) }
          : {}),
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
        ...(update.signal !== undefined ? { signal: update.signal } : {}),
        ...(update.timedOut !== undefined ? { timedOut: update.timedOut } : {}),
        ...(update.stdoutArtifactId !== undefined
          ? { stdoutArtifactId: update.stdoutArtifactId }
          : {}),
        ...(update.stderrArtifactId !== undefined
          ? { stderrArtifactId: update.stderrArtifactId }
          : {}),
        ...(update.errorCode !== undefined ? { errorCode: update.errorCode } : {}),
        ...(update.argvRedacted !== undefined
          ? { argvRedactedJson: JSON.stringify(update.argvRedacted) }
          : {})
      }
    });
    return commandToDomain(row);
  }

  async listCommandAttempts(projectId: string): Promise<PersistedCommandAttempt[]> {
    const rows = await this.db.commandAttemptRecord.findMany({
      where: { projectId },
      orderBy: { startedAt: "asc" }
    });
    return rows.map(commandToDomain);
  }
}
