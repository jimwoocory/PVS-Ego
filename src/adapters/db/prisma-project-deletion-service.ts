import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DomainValidationError } from "../../domain/validation.js";

const ACTIVE_GENERATION_STATUSES = [
  "SUBMITTING",
  "SUBMITTED",
  "PROCESSING",
  "SUBMISSION_OUTCOME_UNKNOWN",
  "RECONCILING"
] as const;
const ACTIVE_RENDER_STATUSES = ["QUEUED", "RENDERING"] as const;
const ACTIVE_PUBLISH_ATTEMPT_STATUSES = ["UPLOADING", "PUBLISHING"] as const;
const ACTIVE_PUBLISH_PACKAGE_STATUSES = [
  "DIRECT_PUBLISHING",
  "SUBMISSION_UNKNOWN"
] as const;
const ACTIVE_SMART_STATUSES = [
  "PLANNING",
  "ASSET_PREPARING",
  "APPROVING",
  "GENERATING",
  "AUTO_EDITING",
  "RENDERING"
] as const;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function contained(root: string, child: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(child);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new DomainValidationError("项目目录路径异常，已阻止删除");
  }
  return resolved;
}

export type ProjectDeletionResult = {
  projectId: string;
  projectName: string;
  fileCleanupPending: boolean;
};

export class PrismaProjectDeletionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly projectsRoot: string
  ) {}

  async deleteProject(input: {
    projectId: string;
    confirmName: string;
  }): Promise<ProjectDeletionResult> {
    const project = await this.db.project.findUnique({
      where: { id: input.projectId }
    });
    if (!project) throw new DomainValidationError("项目不存在或已被删除");
    if (input.confirmName.trim() !== project.name) {
      throw new DomainValidationError("项目名称确认不匹配，未执行删除");
    }

    const newActivities = await this.db.$queryRaw<Array<{count:bigint|number}>>`SELECT (
      (SELECT COUNT(*) FROM "AgentCycleRecord" WHERE "projectId"=${project.id} AND ("status" NOT IN ('COMPLETED','CANCELLED') OR "leaseOwner" IS NOT NULL)) +
      (SELECT COUNT(*) FROM "DouyinOperationsScheduleRecord" WHERE "projectId"=${project.id} AND ("status" IN ('SCHEDULED','RUNNING') OR "leaseOwner" IS NOT NULL)) +
      (SELECT COUNT(*) FROM "DouyinCollectionRunRecord" WHERE "projectId"=${project.id} AND "leaseOwner" IS NOT NULL)
    ) AS "count"`;
    if(Number(newActivities[0]?.count??0)>0)throw new DomainValidationError("项目仍有业务Agent、运营计划或评论采集在执行。请先停止原任务和运营计划，再删除项目。");

    const [
      activeGeneration,
      activeRender,
      activePublishAttempt,
      activePublishPackage,
      activeSmart
    ] = await Promise.all([
      this.db.generationAttemptRecord.count({
        where: {
          projectId: project.id,
          status: { in: [...ACTIVE_GENERATION_STATUSES] }
        }
      }),
      this.db.renderJobRecord.count({
        where: {
          projectId: project.id,
          status: { in: [...ACTIVE_RENDER_STATUSES] }
        }
      }),
      this.db.publishAttemptRecord.count({
        where: {
          projectId: project.id,
          status: { in: [...ACTIVE_PUBLISH_ATTEMPT_STATUSES] }
        }
      }),
      this.db.publishPackageRecord.count({
        where: {
          projectId: project.id,
          status: { in: [...ACTIVE_PUBLISH_PACKAGE_STATUSES] }
        }
      }),
      this.db.smartGenerationRunRecord.count({
        where: {
          projectId: project.id,
          OR: [
            { status: { in: [...ACTIVE_SMART_STATUSES] } },
            { leaseOwner: { not: null } }
          ]
        }
      })
    ]);
    if (
      activeGeneration ||
      activeRender ||
      activePublishAttempt ||
      activePublishPackage ||
      activeSmart
    ) {
      throw new DomainValidationError(
        "项目仍有正在执行或结果未知的生成、渲染或发布任务。请先停止/处理这些任务后再删除，避免丢失远端任务状态。"
      );
    }

    const root = path.resolve(this.projectsRoot);
    const projectDir = contained(root, path.join(root, project.id));
    const stagingRoot = contained(root, path.join(root, ".delete-staging"));
    let stagedDir: string | undefined;
    if (await exists(projectDir)) {
      await fs.mkdir(stagingRoot, { recursive: true });
      stagedDir = contained(
        root,
        path.join(stagingRoot, project.id + "-" + randomUUID())
      );
      await fs.rename(projectDir, stagedDir);
    }

    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "AgentCycleRecord" WHERE "projectId"=${project.id}`;
        await tx.$executeRaw`DELETE FROM "DouyinOperationsScheduleRecord" WHERE "projectId"=${project.id}`;
        await tx.$executeRaw`DELETE FROM "DouyinCollectionRunRecord" WHERE "projectId"=${project.id}`;
        await tx.$executeRaw`DELETE FROM "RenderExecutionRecord" WHERE "projectId"=${project.id}`;
        const runIds = (
          await tx.smartGenerationRunRecord.findMany({
            where: { projectId: project.id },
            select: { id: true }
          })
        ).map((item) => item.id);

        if (runIds.length) {
          await tx.smartGenerationCheckpointRecord.deleteMany({
            where: { runId: { in: runIds } }
          });
        }
        await tx.smartGenerationRunRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.researchMediaCandidateRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.researchEvidenceRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.researchBriefRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.researchRunRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.referencePoolHead.deleteMany({
          where: { projectId: project.id }
        });
        await tx.referenceReviewRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.creativeReferenceSetRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.referenceVideoProfileRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.commandAttemptRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.reviewDecisionRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.generationAttemptRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.userApprovalRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.preflightReportRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.generationRequestRecord.deleteMany({
          where: { projectId: project.id }
        });

        const ownedProviderIdentities =
          await tx.providerIdentityRecord.findMany({
            where: { projectId: project.id },
            select: { id: true }
          });
        for (const identity of ownedProviderIdentities) {
          const survivingReference =
            await tx.providerCapabilityRecord.findFirst({
              where: {
                providerIdentityId: identity.id,
                projectId: { not: project.id }
              },
              select: { projectId: true },
              orderBy: { createdAt: "asc" }
            });
          if (survivingReference) {
            await tx.providerIdentityRecord.update({
              where: { id: identity.id },
              data: {
                projectId: survivingReference.projectId
              }
            });
          }
        }

        await tx.providerCapabilityRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.providerIdentityRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.publishReceiptRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.publishPackageRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.publishPreferenceRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.publishAttemptRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.finalAssemblyRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.renderJobRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.timelineRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.agentTaskRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.aiExecutionRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.stepModelOverrideRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.projectAiPreferenceRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.workflowBlockerRecord.deleteMany({
          where: { projectId: project.id }
        });
        await tx.versionedEntity.deleteMany({
          where: { projectId: project.id }
        });
        await tx.artifactRecord.deleteMany({
          where: { projectId: project.id }
        });

        await tx.project.delete({ where: { id: project.id } });
      });
    } catch (error) {
      if (stagedDir && (await exists(stagedDir))) {
        await fs.rename(stagedDir, projectDir).catch(() => undefined);
      }
      throw error;
    }

    let fileCleanupPending = false;
    if (stagedDir) {
      try {
        await fs.rm(stagedDir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        fileCleanupPending = true;
      }
    }

    return {
      projectId: project.id,
      projectName: project.name,
      fileCleanupPending
    };
  }
}
