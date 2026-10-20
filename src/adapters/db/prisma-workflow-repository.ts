import type { PrismaClient } from "@prisma/client";
import type { WorkflowRepository } from "../../application/ports/workflow-repository.js";
import {
  generationAttemptSchema,
  workflowBlockerSchema,
  type GenerationAttempt,
  type WorkflowBlocker
} from "../../domain/schemas.js";

function blockerToDomain(row: {
  id: string;
  projectId: string;
  scope: string;
  relatedEntityId: string | null;
  reasonCode: string;
  message: string;
  requiredUserAction: string;
  resumeCheckpoint: string;
  createdAt: Date;
  resolvedAt: Date | null;
}): WorkflowBlocker {
  return workflowBlockerSchema.parse({
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    ...(row.relatedEntityId ? { relatedEntityId: row.relatedEntityId } : {}),
    reasonCode: row.reasonCode,
    message: row.message,
    requiredUserAction: row.requiredUserAction,
    resumeCheckpoint: row.resumeCheckpoint,
    createdAt: row.createdAt.toISOString(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {})
  });
}

function attemptToDomain(row: {
  id: string;
  projectId: string;
  clipId: string;
  attemptNumber: number;
  generationRequestId: string;
  requestHash: string;
  preflightReportId: string;
  userApprovalId: string;
  approvalHash: string;
  submissionFingerprint: string;
  status: string;
  providerHandleJson: string | null;
  commandAttemptsJson: string;
  outputArtifactId: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}): GenerationAttempt {
  return generationAttemptSchema.parse({
    id: row.id,
    projectId: row.projectId,
    clipId: row.clipId,
    attemptNumber: row.attemptNumber,
    generationRequestId: row.generationRequestId,
    requestHash: row.requestHash,
    preflightReportId: row.preflightReportId,
    userApprovalId: row.userApprovalId,
    approvalHash: row.approvalHash,
    submissionFingerprint: row.submissionFingerprint,
    status: row.status,
    ...(row.providerHandleJson ? { providerHandle: JSON.parse(row.providerHandleJson) } : {}),
    commandAttempts: JSON.parse(row.commandAttemptsJson),
    ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {})
  });
}

export class PrismaWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: PrismaClient) {}

  async claimCreatedAttempt(id: string): Promise<GenerationAttempt | null> {
    const claimed = await this.db.generationAttemptRecord.updateMany({
      where: { id, status: "CREATED" },
      data: { status: "SUBMITTING" }
    });
    return claimed.count === 1 ? this.getGenerationAttempt(id) : null;
  }

  async createBlocker(blockerInput: WorkflowBlocker): Promise<WorkflowBlocker> {
    const blocker = workflowBlockerSchema.parse(blockerInput);
    const row = await this.db.workflowBlockerRecord.create({
      data: {
        id: blocker.id,
        projectId: blocker.projectId,
        scope: blocker.scope,
        relatedEntityId: blocker.relatedEntityId,
        reasonCode: blocker.reasonCode,
        message: blocker.message,
        requiredUserAction: blocker.requiredUserAction,
        resumeCheckpoint: blocker.resumeCheckpoint,
        createdAt: new Date(blocker.createdAt),
        resolvedAt: blocker.resolvedAt ? new Date(blocker.resolvedAt) : null
      }
    });
    return blockerToDomain(row);
  }

  async listOpenBlockers(projectId: string): Promise<WorkflowBlocker[]> {
    const rows = await this.db.workflowBlockerRecord.findMany({
      where: { projectId, resolvedAt: null },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(blockerToDomain);
  }

  async resolveBlocker(id: string, resolvedAt: string): Promise<WorkflowBlocker> {
    const row = await this.db.workflowBlockerRecord.update({
      where: { id },
      data: { resolvedAt: new Date(resolvedAt) }
    });
    return blockerToDomain(row);
  }

  async createGenerationAttempt(attemptInput: GenerationAttempt): Promise<GenerationAttempt> {
    const attempt = generationAttemptSchema.parse(attemptInput);
    const row = await this.db.generationAttemptRecord.create({
      data: {
        id: attempt.id,
        projectId: attempt.projectId,
        clipId: attempt.clipId,
        attemptNumber: attempt.attemptNumber,
        generationRequestId: attempt.generationRequestId,
        requestHash: attempt.requestHash,
        preflightReportId: attempt.preflightReportId,
        userApprovalId: attempt.userApprovalId,
        approvalHash: attempt.approvalHash,
        submissionFingerprint: attempt.submissionFingerprint,
        status: attempt.status,
        providerHandleJson: attempt.providerHandle ? JSON.stringify(attempt.providerHandle) : null,
        commandAttemptsJson: JSON.stringify(attempt.commandAttempts),
        outputArtifactId: attempt.outputArtifactId,
        createdAt: new Date(attempt.createdAt),
        submittedAt: attempt.submittedAt ? new Date(attempt.submittedAt) : null,
        completedAt: attempt.completedAt ? new Date(attempt.completedAt) : null,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage
      }
    });
    return attemptToDomain(row);
  }

  async getGenerationAttempt(id: string): Promise<GenerationAttempt | null> {
    const row = await this.db.generationAttemptRecord.findUnique({ where: { id } });
    return row ? attemptToDomain(row) : null;
  }

  async nextAttemptNumber(clipId: string): Promise<number> {
    const latest = await this.db.generationAttemptRecord.findFirst({
      where: { clipId },
      orderBy: { attemptNumber: "desc" },
      select: { attemptNumber: true }
    });
    return (latest?.attemptNumber ?? 0) + 1;
  }

  async listGenerationAttempts(projectId: string): Promise<GenerationAttempt[]> {
    const rows = await this.db.generationAttemptRecord.findMany({
      where: { projectId },
      orderBy: [{ clipId: "asc" }, { attemptNumber: "asc" }]
    });
    return rows.map(attemptToDomain);
  }

  async updateGenerationAttemptStatus(
    id: string,
    update: Pick<GenerationAttempt, "status"> &
      Partial<Pick<GenerationAttempt, "providerHandle" | "submittedAt" | "completedAt" | "errorCode" | "errorMessage" | "outputArtifactId" | "commandAttempts">>
  ): Promise<GenerationAttempt> {
    const row = await this.db.generationAttemptRecord.update({
      where: { id },
      data: {
        status: update.status,
        ...(update.providerHandle !== undefined ? { providerHandleJson: JSON.stringify(update.providerHandle) } : {}),
        ...(update.commandAttempts !== undefined ? { commandAttemptsJson: JSON.stringify(update.commandAttempts) } : {}),
        ...(update.outputArtifactId !== undefined ? { outputArtifactId: update.outputArtifactId } : {}),
        ...(update.submittedAt !== undefined ? { submittedAt: new Date(update.submittedAt) } : {}),
        ...(update.completedAt !== undefined ? { completedAt: new Date(update.completedAt) } : {}),
        ...(update.errorCode !== undefined ? { errorCode: update.errorCode } : {}),
        ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {})
      }
    });
    return attemptToDomain(row);
  }
}
