import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { LocalProductInputStore } from "../src/adapters/store/local-product-input-store.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { ProjectSnapshotService } from "../src/application/services/project-snapshot.js";
import { RecoveryService } from "../src/application/services/recovery-service.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import {
  H,
  makeApproval,
  makeAttempt,
  makePreflight,
  makeRequest
} from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

test("restart recovery preserves attempt/blocker and rebuilds project.json", async () => {
  const db = new PrismaClient();
  const projectId = `recovery-${randomUUID()}`;
  const clipId = `clip-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-recovery-")
  );
  const projectRoot = path.join(projectsRoot, projectId);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  const review = new PrismaReviewRepository(db);
  const productInput = new LocalProductInputStore(projectsRoot, artifacts);
  const snapshots = new ProjectSnapshotService(
    projectsRoot,
    productFlow,
    productInput,
    artifacts,
    generation,
    workflow,
    review,
    providerAudit
  );
  const recovery = new RecoveryService(
    projectsRoot,
    productFlow,
    artifacts,
    workflow,
    snapshots
  );

  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Recovery Project",
      status: "GENERATING",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const request = {
      ...makeRequest(),
      id: `request-${randomUUID()}`,
      projectId,
      clipId,
      compiledPromptId: `prompt-${randomUUID()}`
    };
    const preflight = {
      ...makePreflight(),
      id: `preflight-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash
    };
    const approval = {
      ...makeApproval(),
      id: `approval-${randomUUID()}`,
      projectId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      preflightHash: preflight.reportHash
    };
    await generation.createGenerationRequest(request);
    await generation.createPreflightReport(preflight);
    await generation.createUserApproval(approval);

    const attempt = {
      ...makeAttempt(),
      id: `attempt-${randomUUID()}`,
      projectId,
      clipId,
      generationRequestId: request.id,
      requestHash: request.requestHash,
      preflightReportId: preflight.id,
      userApprovalId: approval.id,
      approvalHash: approval.approvalHash,
      status: "SUBMITTING" as const
    };
    await workflow.createGenerationAttempt(attempt);

    const pendingId = `artifact-${randomUUID()}`;
    await artifacts.createPending({
      id: pendingId,
      projectId,
      kind: "STRUCTURED_SNAPSHOT",
      relativePath: "snapshots/recovery.json",
      immutable: true,
      mimeType: "application/json"
    });
    await fs.mkdir(path.join(projectRoot, "snapshots"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "snapshots", "recovery.json"),
      JSON.stringify({ recovery: true }),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectRoot, "orphan.txt"),
      "orphan",
      "utf8"
    );
    await fs.writeFile(
      path.join(projectRoot, "interrupted.tmp"),
      "temporary",
      "utf8"
    );

    const generatedBytes = Buffer.from("registered-generated-video", "utf8");
    const generatedHash = sha256Bytes(generatedBytes);
    const generatedArtifactId = `video-${randomUUID()}`;
    await artifacts.createPending({
      id: generatedArtifactId,
      projectId,
      kind: "GENERATED_VIDEO",
      relativePath: "outputs/current.mp4",
      immutable: true,
      mimeType: "video/mp4"
    });
    await fs.mkdir(path.join(projectRoot, "outputs"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "outputs", "current.mp4"),
      generatedBytes
    );
    await artifacts.markReady(generatedArtifactId, {
      sha256: generatedHash,
      sizeBytes: generatedBytes.length,
      mimeType: "video/mp4"
    });

    await fs.mkdir(path.join(projectRoot, ".tmp"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".tmp", "provider-residue.mp4"),
      "transient-provider-residue",
      "utf8"
    );
    const duplicateRelative = "generated/clip-1/attempt-1/provider-copy.mp4";
    await fs.mkdir(
      path.dirname(path.join(projectRoot, duplicateRelative)),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(projectRoot, duplicateRelative),
      generatedBytes
    );

    const result = await recovery.recoverProject(projectId);
    assert.deepEqual(result.unknownAttempts, [attempt.id]);
    assert.ok(result.blockerIds.length >= 1);
    assert.ok(
      result.artifactRecovery.ready.includes(pendingId)
    );
    assert.ok(
      result.artifactRecovery.orphanPaths.includes("orphan.txt")
    );
    const quarantined = result.artifactRecovery.orphanQuarantined.find(
      (item) => item.from === "orphan.txt"
    );
    assert.ok(quarantined);
    assert.equal(
      await fs
        .access(path.join(projectRoot, "orphan.txt"))
        .then(() => true)
        .catch(() => false),
      false
    );
    assert.equal(
      await fs
        .access(path.join(projectRoot, quarantined!.to))
        .then(() => true)
        .catch(() => false),
      true
    );
    assert.ok(result.orphanAuditArtifactId);
    assert.ok(
      result.artifactRecovery.tempRemoved.includes("interrupted.tmp")
    );
    assert.ok(
      result.artifactRecovery.tempRemoved.includes(
        ".tmp/provider-residue.mp4"
      )
    );
    assert.ok(
      result.artifactRecovery.redundantRemoved.includes(duplicateRelative)
    );
    assert.equal(
      result.artifactRecovery.orphanPaths.includes(duplicateRelative),
      false
    );

    const recoveredAttempt =
      await workflow.getGenerationAttempt(attempt.id);
    assert.equal(
      recoveredAttempt?.status,
      "SUBMISSION_OUTCOME_UNKNOWN"
    );
    const blockers = await workflow.listOpenBlockers(projectId);
    assert.ok(
      blockers.some(
        (item) =>
          item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED" &&
          item.relatedEntityId === attempt.id
      )
    );
    assert.ok(
      blockers.some(
        (item) =>
          item.reasonCode === "ORPHAN_ARTIFACT_QUARANTINED" &&
          item.relatedEntityId === result.orphanAuditArtifactId
      )
    );

    const readyArtifact = await artifacts.findById(pendingId);
    assert.equal(readyArtifact?.integrityStatus, "READY");
    assert.ok(readyArtifact?.sha256);

    const projectJson = JSON.parse(
      await fs.readFile(result.projectJson, "utf8")
    ) as {
      derived: boolean;
      project: { id: string };
      workflow: {
        attempts: Array<{ id: string; status: string }>;
        blockers: Array<{ reasonCode: string }>;
      };
    };
    assert.equal(projectJson.derived, true);
    assert.equal(projectJson.project.id, projectId);
    assert.equal(
      projectJson.workflow.attempts.find(
        (item) => item.id === attempt.id
      )?.status,
      "SUBMISSION_OUTCOME_UNKNOWN"
    );
    assert.ok(
      projectJson.workflow.blockers.some(
        (item) =>
          item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED"
      )
    );
    assert.ok(
      projectJson.workflow.blockers.some(
        (item) =>
          item.reasonCode === "ORPHAN_ARTIFACT_QUARANTINED"
      )
    );

    const secondRecovery = await recovery.recoverProject(projectId);
    assert.deepEqual(secondRecovery.artifactRecovery.orphanPaths, []);
    assert.deepEqual(
      secondRecovery.artifactRecovery.orphanQuarantined,
      []
    );
    assert.equal(secondRecovery.orphanAuditArtifactId, undefined);
    const secondBlockers = await workflow.listOpenBlockers(projectId);
    assert.equal(
      secondBlockers.filter(
        (item) =>
          item.reasonCode === "ORPHAN_ARTIFACT_QUARANTINED"
      ).length,
      1
    );

    await db.$disconnect();

    const restartedDb = new PrismaClient();
    try {
      const restartedWorkflow =
        new PrismaWorkflowRepository(restartedDb);
      const restartedAttempt =
        await restartedWorkflow.getGenerationAttempt(attempt.id);
      assert.equal(
        restartedAttempt?.status,
        "SUBMISSION_OUTCOME_UNKNOWN"
      );
      const restartedBlockers =
        await restartedWorkflow.listOpenBlockers(projectId);
      assert.ok(
        restartedBlockers.some(
          (item) =>
            item.reasonCode ===
            "SUBMISSION_RECONCILIATION_REQUIRED"
        )
      );
      assert.ok(
        restartedBlockers.some(
          (item) =>
            item.reasonCode ===
            "ORPHAN_ARTIFACT_QUARANTINED"
        )
      );
    } finally {
      await restartedDb.commandAttemptRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.reviewDecisionRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.generationAttemptRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.userApprovalRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.preflightReportRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.generationRequestRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.workflowBlockerRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.providerCapabilityRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.providerIdentityRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.artifactRecord.deleteMany({
        where: { projectId }
      });
      await restartedDb.versionedEntity.deleteMany({
        where: { projectId }
      });
      await restartedDb.project.deleteMany({
        where: { id: projectId }
      });
      await restartedDb.$disconnect();
    }
  } finally {
    await db.$disconnect().catch(() => undefined);
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
