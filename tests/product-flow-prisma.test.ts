import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { makeProductTruth } from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

test("Prisma product-flow commit atomically updates current ref and stales downstream", async () => {
  const db = new PrismaClient();
  const projectId = `pf-${randomUUID()}`;
  const truthId = `truth-${randomUUID()}`;
  const oldBatchId = `batch-${randomUUID()}`;
  const service = new ProductFlowService(new PrismaProductFlowRepository(db));
  const now = new Date().toISOString();

  try {
    await service.createProject({
      id: projectId,
      name: "Prisma product flow",
      status: "DRAFT",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    await db.versionedEntity.create({
      data: {
        id: oldBatchId,
        projectId,
        entityType: "CreativeBatch",
        entityKey: "creative-batch",
        version: 1,
        status: "ACTIVE",
        contentHash: "b".repeat(64),
        dataJson: JSON.stringify({ status: "ACTIVE" })
      }
    });

    const truth = makeProductTruth();
    truth.id = truthId;
    truth.projectId = projectId;
    truth.contentHash = "c".repeat(64);

    const project = await service.confirmProductTruth(truth);
    assert.equal(project.status, "CREATIVE_REVIEW");
    assert.equal(project.currentProductTruthRef?.entityId, truthId);
    assert.equal(project.currentProductTruthRef?.hash, truth.contentHash);

    const [storedTruth, staleBatch] = await Promise.all([
      db.versionedEntity.findUnique({ where: { id: truthId } }),
      db.versionedEntity.findUnique({ where: { id: oldBatchId } })
    ]);
    assert.equal(storedTruth?.status, "CONFIRMED");
    assert.equal(staleBatch?.status, "STALE");
  } finally {
    await db.versionedEntity.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  }
});
