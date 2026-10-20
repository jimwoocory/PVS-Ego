import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import type {
  DouyinPublishProbe,
  DouyinPublishProvider
} from "../src/application/ports/douyin-publish-provider.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { DouyinPublishService } from "../src/application/services/douyin-publish-service.js";
import { DomainValidationError } from "../src/domain/validation.js";

process.env.DATABASE_URL ??= "file:./dev.db";

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

class FakeDouyinProvider implements DouyinPublishProvider {
  publishCalls = 0;
  constructor(public probeResult: DouyinPublishProbe) {}
  async probe(): Promise<DouyinPublishProbe> {
    return this.probeResult;
  }
  async beginOAuth(): Promise<{ authorizationUrl: string }> {
    return { authorizationUrl: "https://example.test/oauth" };
  }
  async completeOAuth(): Promise<{ projectId: string }> {
    return { projectId: "unused" };
  }
  async publish(): Promise<{ videoId: string; itemId: string }> {
    this.publishCalls += 1;
    return { videoId: "video-official-1", itemId: "item-official-1" };
  }
}

async function setupAcceptedFinal(db: PrismaClient, projectId: string) {
  const artifacts = new PrismaArtifactRepository(db);
  const finalOutput = new PrismaFinalOutputRepository(db);
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const now = new Date().toISOString();
  await productFlow.createProject({
    id: projectId,
    name: "Publish Test",
    status: "READY_TO_PUBLISH",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    createdAt: now,
    updatedAt: now
  });
  const artifactId = `final-video-${randomUUID()}`;
  const artifactHash = hash("final-video");
  await artifacts.createPending({
    id: artifactId,
    projectId,
    kind: "FINAL_VIDEO",
    relativePath: "final/test.mp4",
    immutable: true,
    mimeType: "video/mp4"
  });
  await artifacts.markReady(artifactId, {
    sha256: artifactHash,
    sizeBytes: 100,
    mimeType: "video/mp4"
  });
  const assembly = await finalOutput.createAssembly({
    id: `assembly-${randomUUID()}`,
    projectId,
    productionPlanHash: hash("plan"),
    selectedClipIds: ["clip-1"],
    inputArtifactIds: ["generated-video-1"],
    inputArtifactHashes: [hash("generated-video-1")],
    outputArtifactId: artifactId,
    outputArtifactHash: artifactHash,
    status: "ACCEPTED",
    createdAt: now,
    acceptedAt: now
  });
  return { artifacts, finalOutput, productFlow, assembly };
}

async function cleanup(db: PrismaClient, projectId: string) {
  await db.publishAttemptRecord.deleteMany({ where: { projectId } });
  await db.finalAssemblyRecord.deleteMany({ where: { projectId } });
  await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
  await db.commandAttemptRecord.deleteMany({ where: { projectId } });
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
}

test("Douyin publishing requires explicit confirmation and persists published IDs", async () => {
  const db = new PrismaClient();
  const projectId = `douyin-publish-${randomUUID()}`;
  try {
    const { artifacts, finalOutput, productFlow } = await setupAcceptedFinal(
      db,
      projectId
    );
    const workflow = new PrismaWorkflowRepository(db);
    const provider = new FakeDouyinProvider({
      code: "READY",
      openId: "open-id-1",
      scope: "video.create"
    });
    const service = new DouyinPublishService(
      productFlow,
      workflow,
      artifacts,
      finalOutput,
      provider,
      "projects"
    );

    await assert.rejects(
      service.publish({
        projectId,
        title: "Test",
        confirmed: false
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /explicit user confirmation/.test(error.message)
    );
    assert.equal(provider.publishCalls, 0);

    const published = await service.publish({
      projectId,
      title: "Test",
      description: "#demo",
      confirmed: true
    });
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.externalVideoId, "video-official-1");
    assert.equal(published.externalItemId, "item-official-1");
    assert.equal(provider.publishCalls, 1);
    assert.equal(
      (await productFlow.getProject(projectId))?.status,
      "PUBLISHED"
    );
  } finally {
    await cleanup(db, projectId);
    await db.$disconnect();
  }
});

test("missing Douyin authorization becomes an explicit blocker and does not publish", async () => {
  const db = new PrismaClient();
  const projectId = `douyin-auth-${randomUUID()}`;
  try {
    const { artifacts, finalOutput, productFlow } = await setupAcceptedFinal(
      db,
      projectId
    );
    const workflow = new PrismaWorkflowRepository(db);
    const provider = new FakeDouyinProvider({
      code: "AUTH_REQUIRED",
      reason: "OAuth required"
    });
    const service = new DouyinPublishService(
      productFlow,
      workflow,
      artifacts,
      finalOutput,
      provider,
      "projects"
    );

    const result = await service.publish({
      projectId,
      title: "Test",
      confirmed: true
    });
    assert.equal(result.status, "AUTH_REQUIRED");
    assert.equal(provider.publishCalls, 0);
    const blockers = await workflow.listOpenBlockers(projectId);
    assert.ok(
      blockers.some(
        (item) =>
          item.reasonCode === "AUTHENTICATION_REQUIRED" &&
          item.resumeCheckpoint === "publish.douyin.oauth"
      )
    );
  } finally {
    await cleanup(db, projectId);
    await db.$disconnect();
  }
});
