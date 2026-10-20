import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import type { ProductFlowService } from "./product-flow.js";
import type { ProjectSnapshotService } from "./project-snapshot.js";
import type { RenderRecoveryResult } from "../../domain/render-execution.js";

export type RecoveryProjectResult = {
  projectId: string;
  artifactRecovery: Awaited<ReturnType<LocalArtifactStore["reconcileProject"]>>;
  unknownAttempts: string[];
  blockerIds: string[];
  orphanAuditArtifactId?: string;
  projectJson: string;
  renderRecovery?: RenderRecoveryResult[];
  artifactRecoveryDeferred?: boolean;
};

export class RecoveryService {
  constructor(
    private readonly projectsRoot: string,
    private readonly productFlow: ProductFlowService,
    private readonly artifacts: ArtifactRepository,
    private readonly workflow: WorkflowRepository,
    private readonly snapshots: ProjectSnapshotService,
    private readonly renders?: { recoverAbandoned(projectId?: string): Promise<RenderRecoveryResult[]> }
  ) {}

  async recoverProject(projectId: string): Promise<RecoveryProjectResult> {
    const store = new LocalArtifactStore(
      path.join(this.projectsRoot, projectId),
      this.artifacts
    );
    // Inspect render ownership first. Generic reconciliation removes unknown
    // .tmp files and must not touch a live or unowned historical render.
    const renderRecovery = await this.renders?.recoverAbandoned(projectId);
    const artifactRecoveryDeferred = renderRecovery?.some(result => result.outcome === "LIVE_OWNER" || result.outcome === "OWNER_UNKNOWN" || result.outcome === "LEASE_CHANGED") ?? false;
    const artifactRecovery = artifactRecoveryDeferred ? {
      ready: [], missing: [], corrupt: [], orphanPaths: [], orphanQuarantined: [], tempRemoved: [], redundantRemoved: []
    } : await store.reconcileProject(projectId);
    const unknownAttempts: string[] = [];
    const blockerIds: string[] = [];
    let orphanAuditArtifactId: string | undefined;

    if (artifactRecovery.orphanQuarantined.length) {
      const audit = await store.writeImmutable({
        id: randomUUID(),
        projectId,
        kind: "OTHER",
        relativePath:
          "recovery/orphan-quarantine-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          randomUUID() +
          ".json",
        immutable: true,
        bytes: Buffer.from(
          JSON.stringify(
            {
              projectId,
              recoveredAt: new Date().toISOString(),
              quarantined: artifactRecovery.orphanQuarantined
            },
            null,
            2
          ) + "\n",
          "utf8"
        ),
        mimeType: "application/json"
      });
      orphanAuditArtifactId = audit.id;

      const open = await this.workflow.listOpenBlockers(projectId);
      const exists = open.some(
        (item) =>
          item.reasonCode === "ORPHAN_ARTIFACT_QUARANTINED" &&
          !item.resolvedAt
      );
      if (!exists) {
        const blocker = await this.workflow.createBlocker({
          id: randomUUID(),
          projectId,
          scope: "PROJECT",
          relatedEntityId: audit.id,
          reasonCode: "ORPHAN_ARTIFACT_QUARANTINED",
          message:
            "恢复检查发现未登记文件，已隔离到 .recovery/orphans/ 并生成审计 Artifact。",
          requiredUserAction:
            "检查隔离文件和恢复审计记录；确认其来源后手工删除、重新导入或恢复为受管 Artifact。",
          resumeCheckpoint: "recovery.orphans",
          createdAt: new Date().toISOString()
        });
        blockerIds.push(blocker.id);
      }
    }

    const attempts = await this.workflow.listGenerationAttempts(projectId);
    for (const attempt of attempts) {
      if (attempt.status === "SUBMITTING") {
        await this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "SUBMISSION_OUTCOME_UNKNOWN",
          errorCode: "RECOVERED_SUBMITTING_AFTER_RESTART",
          errorMessage:
            "Application restarted while submit was in progress; reconciliation is required."
        });
        unknownAttempts.push(attempt.id);
      }
    }

    const refreshedAttempts = await this.workflow.listGenerationAttempts(projectId);
    const open = await this.workflow.listOpenBlockers(projectId);
    for (const attempt of refreshedAttempts) {
      if (attempt.status !== "SUBMISSION_OUTCOME_UNKNOWN") continue;
      const exists = open.some(
        (item) =>
          item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED" &&
          item.relatedEntityId === attempt.id &&
          !item.resolvedAt
      );
      if (exists) continue;
      const blocker = await this.workflow.createBlocker({
        id: randomUUID(),
        projectId,
        scope: "GENERATION_ATTEMPT",
        relatedEntityId: attempt.id,
        reasonCode: "SUBMISSION_RECONCILIATION_REQUIRED",
        message:
          "提交结果未知，任务可能已经创建并产生费用，禁止自动重提。",
        requiredUserAction:
          "执行提交结果调和；若仍无结论，只有明确接受可能重复扣费后才能新建重做流程。",
        resumeCheckpoint: "generation.reconcile",
        createdAt: new Date().toISOString()
      });
      blockerIds.push(blocker.id);
    }

    if (artifactRecovery.missing.length || artifactRecovery.corrupt.length) {
      const current = await this.workflow.listOpenBlockers(projectId);
      const exists = current.some(
        (item) =>
          item.reasonCode === "ARTIFACT_INTEGRITY_FAILURE" &&
          !item.resolvedAt
      );
      if (!exists) {
        const blocker = await this.workflow.createBlocker({
          id: randomUUID(),
          projectId,
          scope: "PROJECT",
          reasonCode: "ARTIFACT_INTEGRITY_FAILURE",
          message:
            "恢复检查发现 Artifact 缺失或 hash 不一致。",
          requiredUserAction:
            "检查项目目录和 Artifact 记录，恢复或重新上传受影响的输入/输出。",
          resumeCheckpoint: "recovery.artifacts",
          createdAt: new Date().toISOString()
        });
        blockerIds.push(blocker.id);
      }
    }

    const projectJson = await this.snapshots.refresh(projectId);
    return {
      projectId,
      artifactRecovery,
      unknownAttempts,
      blockerIds,
      ...(orphanAuditArtifactId ? { orphanAuditArtifactId } : {}),
      ...(renderRecovery ? { renderRecovery, artifactRecoveryDeferred } : {}),
      projectJson
    };
  }

  async recoverAll(): Promise<RecoveryProjectResult[]> {
    const projects = await this.productFlow.listProjects();
    const results: RecoveryProjectResult[] = [];
    for (const project of projects) {
      results.push(await this.recoverProject(project.id));
    }
    return results;
  }
}
