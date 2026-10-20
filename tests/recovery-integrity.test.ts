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

process.env.DATABASE_URL ??= "file:./dev.db";

test("READY missing/corrupt Artifacts become durable integrity blocker and survive restart snapshot", async () => {
  const db = new PrismaClient();
  const projectId = `recovery-integrity-${randomUUID()}`;
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-recovery-integrity-")
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
      name: "Recovery Integrity",
      status: "DRAFT",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const missingId = `artifact-missing-${randomUUID()}`;
    await artifacts.createPending({
      id: missingId,
      projectId,
      kind: "USER_INPUT",
      relativePath: "input/missing.bin",
      immutable: true
    });
    await artifacts.markReady(missingId, {
      sha256: "a".repeat(64),
      sizeBytes: 10
    });

    const corruptId = `artifact-corrupt-${randomUUID()}`;
    const corruptRelative = "input/corrupt.bin";
    const corruptPath = path.join(projectRoot, corruptRelative);
    await fs.mkdir(path.dirname(corruptPath), { recursive: true });
    const original = Buffer.from("original-bytes", "utf8");
    await fs.writeFile(corruptPath, original);
    await artifacts.createPending({
      id: corruptId,
      projectId,
      kind: "USER_INPUT",
      relativePath: corruptRelative,
      immutable: true
    });
    await artifacts.markReady(corruptId, {
      sha256: sha256Bytes(original),
      sizeBytes: original.length
    });
    await fs.writeFile(
      corruptPath,
      Buffer.from("tampered-bytes", "utf8")
    );

    const first = await recovery.recoverProject(projectId);
    assert.ok(first.artifactRecovery.missing.includes(missingId));
    assert.ok(first.artifactRecovery.corrupt.includes(corruptId));
    assert.equal(
      (await artifacts.findById(missingId))?.integrityStatus,
      "MISSING"
    );
    assert.equal(
      (await artifacts.findById(corruptId))?.integrityStatus,
      "CORRUPT"
    );

    const blockers = await workflow.listOpenBlockers(projectId);
    assert.equal(
      blockers.filter(
        (item) => item.reasonCode === "ARTIFACT_INTEGRITY_FAILURE"
      ).length,
      1
    );

    const snapshot = JSON.parse(
      await fs.readFile(first.projectJson, "utf8")
    ) as {
      workflow: {
        blockers: Array<{ reasonCode: string }>;
      };
      audit: {
        artifacts: Array<{
          id: string;
          integrityStatus: string;
        }>;
      };
    };
    assert.ok(
      snapshot.workflow.blockers.some(
        (item) => item.reasonCode === "ARTIFACT_INTEGRITY_FAILURE"
      )
    );
    assert.equal(
      snapshot.audit.artifacts.find((item) => item.id === missingId)
        ?.integrityStatus,
      "MISSING"
    );
    assert.equal(
      snapshot.audit.artifacts.find((item) => item.id === corruptId)
        ?.integrityStatus,
      "CORRUPT"
    );

    const second = await recovery.recoverProject(projectId);
    assert.deepEqual(second.artifactRecovery.missing, []);
    assert.deepEqual(second.artifactRecovery.corrupt, []);
    const secondBlockers = await workflow.listOpenBlockers(projectId);
    assert.equal(
      secondBlockers.filter(
        (item) => item.reasonCode === "ARTIFACT_INTEGRITY_FAILURE"
      ).length,
      1
    );
  } finally {
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
    await db.generationAttemptRecord.deleteMany({ where: { projectId } });
    await db.userApprovalRecord.deleteMany({ where: { projectId } });
    await db.preflightReportRecord.deleteMany({ where: { projectId } });
    await db.generationRequestRecord.deleteMany({ where: { projectId } });
    await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
    await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
    await db.providerIdentityRecord.deleteMany({ where: { projectId } });
    await db.artifactRecord.deleteMany({ where: { projectId } });
    await db.versionedEntity.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
