import type { PrismaClient } from "@prisma/client";
import type {
  FinalAssembly,
  FinalOutputRepository,
  PublishAttempt
} from "../../application/ports/final-output-repository.js";

function assemblyToDomain(row: {
  id: string;
  projectId: string;
  productionPlanHash: string;
  selectedClipIdsJson: string;
  inputArtifactIdsJson: string;
  inputArtifactHashesJson: string;
  outputArtifactId: string;
  outputArtifactHash: string;
  timelineId: string | null;
  timelineHash: string | null;
  renderJobId: string | null;
  renderConfigJson: string | null;
  status: string;
  createdAt: Date;
  acceptedAt: Date | null;
}): FinalAssembly {
  return {
    id: row.id,
    projectId: row.projectId,
    productionPlanHash: row.productionPlanHash,
    selectedClipIds: JSON.parse(row.selectedClipIdsJson) as string[],
    inputArtifactIds: JSON.parse(row.inputArtifactIdsJson) as string[],
    inputArtifactHashes: JSON.parse(row.inputArtifactHashesJson) as string[],
    outputArtifactId: row.outputArtifactId,
    outputArtifactHash: row.outputArtifactHash,
    ...(row.timelineId ? { timelineId: row.timelineId } : {}),
    ...(row.timelineHash ? { timelineHash: row.timelineHash } : {}),
    ...(row.renderJobId ? { renderJobId: row.renderJobId } : {}),
    ...(row.renderConfigJson
      ? {
          renderConfig: JSON.parse(
            row.renderConfigJson
          ) as NonNullable<FinalAssembly["renderConfig"]>
        }
      : {}),
    status: row.status as FinalAssembly["status"],
    createdAt: row.createdAt.toISOString(),
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.toISOString() } : {})
  };
}

function publishToDomain(row: {
  id: string;
  projectId: string;
  finalAssemblyId: string;
  platform: string;
  status: string;
  title: string;
  description: string | null;
  externalVideoId: string | null;
  externalItemId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
}): PublishAttempt {
  return {
    id: row.id,
    projectId: row.projectId,
    finalAssemblyId: row.finalAssemblyId,
    platform: "douyin",
    status: row.status as PublishAttempt["status"],
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.externalVideoId ? { externalVideoId: row.externalVideoId } : {}),
    ...(row.externalItemId ? { externalItemId: row.externalItemId } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {})
  };
}

export class PrismaFinalOutputRepository implements FinalOutputRepository {
  constructor(private readonly db: PrismaClient) {}

  async createAssembly(assembly: FinalAssembly): Promise<FinalAssembly> {
    const row = await this.db.finalAssemblyRecord.create({
      data: {
        id: assembly.id,
        projectId: assembly.projectId,
        productionPlanHash: assembly.productionPlanHash,
        selectedClipIdsJson: JSON.stringify(assembly.selectedClipIds),
        inputArtifactIdsJson: JSON.stringify(assembly.inputArtifactIds),
        inputArtifactHashesJson: JSON.stringify(assembly.inputArtifactHashes),
        outputArtifactId: assembly.outputArtifactId,
        outputArtifactHash: assembly.outputArtifactHash,
        timelineId: assembly.timelineId,
        timelineHash: assembly.timelineHash,
        renderJobId: assembly.renderJobId,
        renderConfigJson: assembly.renderConfig
          ? JSON.stringify(assembly.renderConfig)
          : undefined,
        status: assembly.status,
        createdAt: new Date(assembly.createdAt),
        acceptedAt: assembly.acceptedAt ? new Date(assembly.acceptedAt) : null
      }
    });
    return assemblyToDomain(row);
  }

  async latestAssembly(projectId: string): Promise<FinalAssembly | null> {
    const row = await this.db.finalAssemblyRecord.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return row ? assemblyToDomain(row) : null;
  }

  async updateAssembly(
    id: string,
    update: Partial<Pick<FinalAssembly, "status" | "acceptedAt">>
  ): Promise<FinalAssembly> {
    const row = await this.db.finalAssemblyRecord.update({
      where: { id },
      data: {
        ...(update.status ? { status: update.status } : {}),
        ...(update.acceptedAt !== undefined
          ? { acceptedAt: update.acceptedAt ? new Date(update.acceptedAt) : null }
          : {})
      }
    });
    return assemblyToDomain(row);
  }

  async markAssembliesStale(projectId: string): Promise<void> {
    await this.db.finalAssemblyRecord.updateMany({
      where: { projectId, status: { not: "STALE" } },
      data: { status: "STALE" }
    });
  }

  async createPublishAttempt(attempt: PublishAttempt): Promise<PublishAttempt> {
    const row = await this.db.publishAttemptRecord.create({
      data: {
        id: attempt.id,
        projectId: attempt.projectId,
        finalAssemblyId: attempt.finalAssemblyId,
        platform: attempt.platform,
        status: attempt.status,
        title: attempt.title,
        description: attempt.description,
        externalVideoId: attempt.externalVideoId,
        externalItemId: attempt.externalItemId,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        createdAt: new Date(attempt.createdAt),
        confirmedAt: attempt.confirmedAt ? new Date(attempt.confirmedAt) : null,
        completedAt: attempt.completedAt ? new Date(attempt.completedAt) : null
      }
    });
    return publishToDomain(row);
  }

  async updatePublishAttempt(
    id: string,
    update: Partial<
      Pick<
        PublishAttempt,
        | "status"
        | "externalVideoId"
        | "externalItemId"
        | "errorCode"
        | "errorMessage"
        | "confirmedAt"
        | "completedAt"
      >
    >
  ): Promise<PublishAttempt> {
    const row = await this.db.publishAttemptRecord.update({
      where: { id },
      data: {
        ...(update.status ? { status: update.status } : {}),
        ...(update.externalVideoId !== undefined
          ? { externalVideoId: update.externalVideoId }
          : {}),
        ...(update.externalItemId !== undefined
          ? { externalItemId: update.externalItemId }
          : {}),
        ...(update.errorCode !== undefined ? { errorCode: update.errorCode } : {}),
        ...(update.errorMessage !== undefined
          ? { errorMessage: update.errorMessage }
          : {}),
        ...(update.confirmedAt !== undefined
          ? {
              confirmedAt: update.confirmedAt
                ? new Date(update.confirmedAt)
                : null
            }
          : {}),
        ...(update.completedAt !== undefined
          ? {
              completedAt: update.completedAt
                ? new Date(update.completedAt)
                : null
            }
          : {})
      }
    });
    return publishToDomain(row);
  }

  async listPublishAttempts(projectId: string): Promise<PublishAttempt[]> {
    const rows = await this.db.publishAttemptRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(publishToDomain);
  }
}
