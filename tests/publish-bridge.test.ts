import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaPublishRepository } from "../src/adapters/db/prisma-publish-repository.js";
import { PrismaReferenceVideoRepository } from "../src/adapters/db/prisma-reference-video-repository.js";
import { PrismaResearchRepository } from "../src/adapters/db/prisma-research-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaTimelineRepository } from "../src/adapters/db/prisma-timeline-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { LocalProductInputStore } from "../src/adapters/store/local-product-input-store.js";
import type {
  PublishDirectInput,
  PublishDirectResult,
  PublishHandoffInput,
  PublishHandoffResult,
  PublishProvider,
  PublishProviderProbe
} from "../src/application/ports/publish-provider.js";
import { PublishSubmissionUnknownError } from "../src/application/ports/publish-provider.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { PublishProviderRegistry } from "../src/application/services/publish-provider-registry.js";
import { PublishBridgeService } from "../src/application/services/publish-bridge-service.js";
import { ProjectSnapshotService } from "../src/application/services/project-snapshot.js";
import { DouyinSdkHandoffProvider } from "../src/adapters/publish/douyin-sdk-handoff-provider.js";
import { DouyinH5HandoffProvider } from "../src/adapters/publish/douyin-h5-handoff-provider.js";
import { DouyinOpenApiDirectProviderAdapter } from "../src/adapters/publish/douyin-openapi-direct-provider.js";
import { ManualExportProvider } from "../src/adapters/publish/manual-export-provider.js";
import { OfficialDouyinOpenApiProvider } from "../src/adapters/publish/official-douyin-openapi-provider.js";
import { DouyinBrowserAutomationProvider } from "../src/adapters/publish/douyin-browser-automation-provider.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { H } from "./fixtures.js";

// These fault tests deliberately write records and a test trigger. Never fall back to the deployed database.
const testDatabasePath = process.env.DATABASE_URL?.startsWith("file:")
  ? decodeURIComponent(process.env.DATABASE_URL.slice(5).split("?")[0]!) : "";
const temporaryRoot = realpathSync.native(os.tmpdir()).toLowerCase() + path.sep;
if (!path.isAbsolute(testDatabasePath) ||
    !realpathSync.native(testDatabasePath).toLowerCase().startsWith(temporaryRoot)) {
  throw new Error("publish-bridge tests require an explicit isolated DATABASE_URL inside the OS temporary directory");
}

class FakeHandoffProvider implements PublishProvider {
  readonly type = "DOUYIN_SDK_HANDOFF" as const;
  readonly displayName = "Fake SDK";
  readonly mode = "HANDOFF" as const;
  lastInput?: PublishHandoffInput;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: true
    };
  }

  async prepareHandoff(input: PublishHandoffInput): Promise<PublishHandoffResult> {
    this.lastInput = input;
    return {
      launchUrl:
        "pvscompanion://publish?package_id=" +
        encodeURIComponent(input.packageId),
      handoffReference: "handoff-" + input.packageId,
      instruction: "Open fake SDK",
      awaitingUserAction: true
    };
  }
}

class FakeUnknownDirectProvider implements PublishProvider {
  readonly type = "DOUYIN_BROWSER_AUTOMATION" as const;
  readonly displayName = "Fake Browser";
  readonly mode = "DIRECT" as const;
  publishCalls = 0;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      accountDisplayName: "WC",
      platformUserId: "50805615998",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    };
  }

  async directPublish(_input: PublishDirectInput): Promise<PublishDirectResult> {
    this.publishCalls += 1;
    throw new PublishSubmissionUnknownError(
      "抖音已接收发布动作，但管理页暂未确认",
      "https://creator.douyin.com/creator-micro/content/manage"
    );
  }
}

class FakeDirectProvider implements PublishProvider {
  readonly type = "DOUYIN_OPENAPI_DIRECT" as const;
  readonly displayName = "Fake Direct";
  readonly mode = "DIRECT" as const;
  publishCalls = 0;
  lastInput?: PublishDirectInput;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      platformUserId: "open-id-confirmed",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    };
  }

  async directPublish(_input: PublishDirectInput): Promise<PublishDirectResult> {
    this.publishCalls += 1;
    this.lastInput = _input;
    return {
      trusted: true,
      externalReference: "item-trusted-1",
      videoId: "video-trusted-1",
      itemId: "item-trusted-1"
    };
  }
}

test("Bridge rejects account drift before claim and passes the explicitly confirmed ID to provider", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "账号确认", publicBaseUrl: "https://studio.example.test" });
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    await assert.rejects(f.bridge.directPublish({ ...input, expectedAccountId: "old-account" }), /发布账号.*不一致/);
    assert.equal(direct.publishCalls, 0);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.status, "PACKAGE_READY");
    await f.bridge.directPublish({ ...input, expectedAccountId: "open-id-confirmed" });
    assert.equal(direct.lastInput?.expectedAccountId, "open-id-confirmed");
  } finally { await f.dispose(); }
});

test("a browser transport interruption leaves an UNKNOWN fence that a fresh package cannot bypass", async () => {
  let calls = 0;
  const browser = new DouyinBrowserAutomationProvider({
    async resolveAccountName() { return "profile-A"; },
    async probe() { return { ok: true, status: "READY", engine: "synthetic", bridgeVersion: 1 }; },
    async check() { return { ok: true, account: "profile-A", status: "VALID", valid: true, platformUserId: "confirmed-A" }; },
    async login() { throw new Error("Not used"); },
    async publish() { calls += 1; throw new Error("synthetic timeout after platform accepted publish"); }
  });
  const f = await fixture([browser]);
  try {
    await f.bridge.setPreference(f.projectId, browser.type);
    const create = () => f.bridge.createPackage({ projectId: f.projectId, title: "传输中断", publicBaseUrl: "https://studio.example.test" });
    const first = await create();
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: first.package.id,
      confirmed: true, expectedAccountId: "confirmed-A" }), /无法确认平台是否已接受/);
    assert.equal((await f.publishRepo.findPackageById(first.package.id))?.status, "SUBMISSION_UNKNOWN");
    const next = await create();
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: next.package.id,
      confirmed: true, expectedAccountId: "confirmed-A" }), /不能通过新发布包/);
    assert.equal(calls, 1);
  } finally { await f.dispose(); }
});

async function cleanup(db: PrismaClient, projectId: string): Promise<void> {
  await db.publishReceiptRecord.deleteMany({ where: { projectId } });
  await db.publishPackageRecord.deleteMany({ where: { projectId } });
  await db.publishPreferenceRecord.deleteMany({ where: { projectId } });
  await db.publishAttemptRecord.deleteMany({ where: { projectId } });
  await db.finalAssemblyRecord.deleteMany({ where: { projectId } });
  await db.renderJobRecord.deleteMany({ where: { projectId } });
  await db.timelineRecord.deleteMany({ where: { projectId } });
  await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
  await db.commandAttemptRecord.deleteMany({ where: { projectId } });
  await db.generationAttemptRecord.deleteMany({ where: { projectId } });
  await db.userApprovalRecord.deleteMany({ where: { projectId } });
  await db.preflightReportRecord.deleteMany({ where: { projectId } });
  await db.generationRequestRecord.deleteMany({ where: { projectId } });
  await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
  await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
  await db.providerIdentityRecord.deleteMany({ where: { projectId } });
  await db.referenceVideoProfileRecord.deleteMany({ where: { projectId } });
  await db.researchEvidenceRecord.deleteMany({ where: { projectId } });
  await db.researchBriefRecord.deleteMany({ where: { projectId } });
  await db.researchRunRecord.deleteMany({ where: { projectId } });
  await db.artifactRecord.deleteMany({ where: { projectId } });
  await db.versionedEntity.deleteMany({ where: { projectId } });
  await db.project.deleteMany({ where: { id: projectId } });
}

async function fixture(providers: PublishProvider[]) {
  const db = new PrismaClient();
  const projectId = "publish-bridge-" + crypto.randomUUID();
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-publish-bridge-")
  );
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const artifacts = new PrismaArtifactRepository(db);
  const finalOutput = new PrismaFinalOutputRepository(db);
  const publishRepo = new PrismaPublishRepository(db);
  const now = new Date().toISOString();
  await productFlow.createProject({
    id: projectId,
    name: "Publish Bridge",
    status: "READY_TO_PUBLISH",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    createdAt: now,
    updatedAt: now
  });
  const store = new LocalArtifactStore(
    path.join(projectsRoot, projectId),
    artifacts
  );
  const finalArtifact = await store.writeImmutable({
    id: "final-" + crypto.randomUUID(),
    projectId,
    kind: "FINAL_VIDEO",
    relativePath: "final/final.mp4",
    immutable: true,
    bytes: Buffer.from("fake-final-video-" + projectId, "utf8"),
    mimeType: "video/mp4"
  });
  assert.ok(finalArtifact.sha256);
  const assembly = await finalOutput.createAssembly({
    id: "assembly-" + crypto.randomUUID(),
    projectId,
    productionPlanHash: H.a,
    selectedClipIds: ["clip-a"],
    inputArtifactIds: ["source-a"],
    inputArtifactHashes: [H.b],
    outputArtifactId: finalArtifact.id,
    outputArtifactHash: finalArtifact.sha256!,
    status: "ACCEPTED",
    createdAt: now,
    acceptedAt: now
  });
  const registry = new PublishProviderRegistry(providers);
  const bridge = new PublishBridgeService(
    productFlow,
    artifacts,
    finalOutput,
    publishRepo,
    registry,
    projectsRoot
  );
  return {
    db,
    projectId,
    projectsRoot,
    productFlow,
    artifacts,
    finalOutput,
    publishRepo,
    bridge,
    finalArtifact,
    assembly,
    async dispose() {
      await cleanup(db, projectId).catch(() => undefined);
      await db.$disconnect();
      await fs.rm(projectsRoot, { recursive: true, force: true });
    }
  };
}

test("PublishProvider defaults are capability-gated and Manual Export is always READY", async () => {
  const keys = [
    "PVS_DOUYIN_SDK_HANDOFF_ENABLED",
    "DOUYIN_MOBILE_CLIENT_KEY",
    "PVS_MOBILE_COMPANION_SCHEME",
    "PVS_DOUYIN_H5_HANDOFF_ENABLED",
    "PVS_DOUYIN_H5_CAPABILITY_APPROVED",
    "DOUYIN_H5_CLIENT_KEY",
    "DOUYIN_H5_CLIENT_SECRET",
    "PVS_DOUYIN_OPENAPI_DIRECT_ENABLED"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(
      (await new DouyinSdkHandoffProvider().probe("p")).code,
      "DISABLED"
    );
    assert.equal(
      (await new DouyinH5HandoffProvider().probe("p")).code,
      "DISABLED"
    );
    assert.equal(
      (
        await new DouyinOpenApiDirectProviderAdapter(
          new OfficialDouyinOpenApiProvider()
        ).probe("p")
      ).code,
      "DISABLED"
    );
    assert.equal((await new ManualExportProvider().probe("p")).code, "READY");
  } finally {
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("SDK handoff becomes READY only with explicit admin enablement and valid companion scheme", async () => {
  const keys = [
    "PVS_DOUYIN_SDK_HANDOFF_ENABLED",
    "DOUYIN_MOBILE_CLIENT_KEY",
    "PVS_MOBILE_COMPANION_SCHEME"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.PVS_DOUYIN_SDK_HANDOFF_ENABLED = "1";
    process.env.DOUYIN_MOBILE_CLIENT_KEY = "mobile-client-key";
    process.env.PVS_MOBILE_COMPANION_SCHEME = "pvscompanion";
    const provider = new DouyinSdkHandoffProvider();
    assert.equal((await provider.probe("project-sdk")).code, "READY");
    const result = await provider.prepareHandoff({
      projectId: "project-sdk",
      packageId: "package-sdk",
      title: "SDK",
      bridgeUrl: "https://studio.example.test/publish/mobile/package-sdk",
      videoUrl:
        "https://studio.example.test/api/publish/packages/package-sdk/media?media_token=x"
    });
    assert.match(result.launchUrl ?? "", /^pvscompanion:\/\/publish\?/);
    const launch = new URL(result.launchUrl!);
    assert.equal(launch.searchParams.get("package_id"), "package-sdk");
    assert.equal(
      launch.searchParams.get("bridge_url"),
      "https://studio.example.test/publish/mobile/package-sdk"
    );
    assert.equal(result.awaitingUserAction, true);
  } finally {
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("H5 handoff uses official ticket signature inputs and requires public HTTPS media", async () => {
  const keys = [
    "PVS_DOUYIN_H5_HANDOFF_ENABLED",
    "PVS_DOUYIN_H5_CAPABILITY_APPROVED",
    "DOUYIN_H5_CLIENT_KEY",
    "DOUYIN_H5_CLIENT_SECRET",
    "PVS_DOUYIN_H5_ALLOW_HTTP"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  try {
    process.env.PVS_DOUYIN_H5_HANDOFF_ENABLED = "1";
    process.env.PVS_DOUYIN_H5_CAPABILITY_APPROVED = "1";
    process.env.DOUYIN_H5_CLIENT_KEY = "h5-client-key";
    process.env.DOUYIN_H5_CLIENT_SECRET = "h5-secret";
    delete process.env.PVS_DOUYIN_H5_ALLOW_HTTP;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (target.includes("/oauth/client_token/")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "client-token",
              expires_in: 7200,
              error_code: 0
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (target.includes("/open/getticket/")) {
        return new Response(
          JSON.stringify({
            data: {
              ticket: "ticket-fixed",
              expires_in: 7200,
              error_code: 0
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      throw new Error("unexpected H5 test URL: " + target);
    }) as typeof fetch;

    const provider = new DouyinH5HandoffProvider();
    assert.equal((await provider.probe("project-h5")).code, "READY");
    const result = await provider.prepareHandoff({
      projectId: "project-h5",
      packageId: "package-h5",
      title: "H5 publish",
      bridgeUrl: "https://studio.example.test/publish/mobile/package-h5",
      videoUrl:
        "https://cdn.example.test/final.mp4?media_token=short-lived"
    });
    const launch = new URL(result.launchUrl!);
    assert.equal(launch.protocol, "snssdk1128:");
    assert.equal(launch.searchParams.get("share_type"), "h5");
    assert.equal(launch.searchParams.get("client_key"), "h5-client-key");
    assert.equal(launch.searchParams.get("state"), "package-h5");
    assert.equal(launch.searchParams.get("share_to_publish"), "1");
    assert.equal(
      launch.searchParams.get("video_path"),
      "https://cdn.example.test/final.mp4?media_token=short-lived"
    );
    const nonce = launch.searchParams.get("nonce_str")!;
    const timestamp = launch.searchParams.get("timestamp")!;
    const signParams: Array<[string, string]> = [
      ["nonce_str", nonce],
      ["ticket", "ticket-fixed"],
      ["timestamp", timestamp]
    ];
    const expected = createHash("md5")
      .update(
        signParams
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => key + "=" + value)
          .join("&"),
        "utf8"
      )
      .digest("hex");
    assert.equal(launch.searchParams.get("signature"), expected);

    await assert.rejects(
      provider.prepareHandoff({
        projectId: "project-h5",
        packageId: "package-local",
        title: "H5 local",
        bridgeUrl: "http://127.0.0.1/publish/mobile/package-local",
        videoUrl: "http://127.0.0.1/final.mp4"
      }),
      /publicly reachable HTTPS/
    );
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("one-time PublishPackage token is hashed, replay-safe, and handoff completion never means PUBLISHED", async () => {
  const handoff = new FakeHandoffProvider();
  const f = await fixture([handoff, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, handoff.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Publish once",
      description: "draft",
      publicBaseUrl: "https://studio.example.test"
    });

    assert.match(created.claimUrl, /#token=/);
    assert.doesNotMatch(created.claimUrl, /\?token=/);
    const row = await f.db.publishPackageRecord.findUnique({
      where: { id: created.package.id }
    });
    assert.ok(row);
    assert.equal(row!.singleUseTokenHash, sha256Text(created.claimToken));
    assert.notEqual(row!.singleUseTokenHash, created.claimToken);
    assert.equal(
      JSON.stringify(created.package).includes("singleUseTokenHash"),
      false
    );

    const claimed = await f.bridge.claimPackage({
      packageId: created.package.id,
      token: created.claimToken
    });
    assert.ok(claimed.sessionToken);
    await assert.rejects(
      f.bridge.claimPackage({
        packageId: created.package.id,
        token: created.claimToken
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /already used/.test(error.message)
    );

    const handoffResult = await f.bridge.startHandoff({
      packageId: created.package.id,
      sessionToken: claimed.sessionToken,
      publicBaseUrl: "https://studio.example.test"
    });
    assert.equal(handoffResult.package.status, "AWAITING_USER_ACTION");
    assert.ok(handoff.lastInput?.videoUrl.includes("media_token="));
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "PUBLISHING"
    );

    const mediaUrl = new URL(handoff.lastInput!.videoUrl);
    const mediaToken = mediaUrl.searchParams.get("media_token");
    assert.ok(mediaToken);
    const media = await f.bridge.mediaByToken({
      packageId: created.package.id,
      mediaToken: mediaToken!
    });
    assert.equal(media.artifact.id, f.finalArtifact.id);

    const completed = await f.bridge.completeHandoff({
      packageId: created.package.id,
      sessionToken: claimed.sessionToken,
      note: "handoff only"
    });
    assert.equal(completed.status, "HANDOFF_COMPLETED");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );
    const receipts = await f.publishRepo.listReceipts(f.projectId);
    assert.equal(
      receipts.some(
        (receipt) =>
          receipt.kind === "HANDOFF_COMPLETED" && receipt.trusted === false
      ),
      true
    );
    assert.equal(
      receipts.some((receipt) => receipt.kind === "PUBLISHED_CONFIRMED"),
      false
    );

    const snapshot = new ProjectSnapshotService(
      f.projectsRoot,
      f.productFlow,
      new LocalProductInputStore(f.projectsRoot, f.artifacts),
      f.artifacts,
      new PrismaGenerationRepository(f.db),
      new PrismaWorkflowRepository(f.db),
      new PrismaReviewRepository(f.db),
      new PrismaProviderAuditRepository(f.db),
      new PrismaReferenceVideoRepository(f.db),
      new PrismaResearchRepository(f.db),
      new PrismaTimelineRepository(f.db),
      f.bridge
    );
    const snapshotPath = await snapshot.refresh(f.projectId);
    const snapshotText = await fs.readFile(snapshotPath, "utf8");
    assert.equal(snapshotText.includes(created.claimToken), false);
    assert.equal(snapshotText.includes(claimed.sessionToken), false);
    assert.equal(snapshotText.includes("singleUseTokenHash"), false);
    assert.equal(snapshotText.includes("sessionTokenHash"), false);
    assert.equal(snapshotText.includes("mediaTokenHash"), false);
    const snapshotJson = JSON.parse(snapshotText) as {
      publish?: { packages?: Array<{ status?: string }> };
    };
    assert.equal(
      snapshotJson.publish?.packages?.[0]?.status,
      "HANDOFF_COMPLETED"
    );
  } finally {
    await f.dispose();
  }
});

test("expired or invalid PublishPackage claim is rejected", async () => {
  const f = await fixture([
    new FakeHandoffProvider(),
    new ManualExportProvider()
  ]);
  try {
    await f.bridge.setPreference(f.projectId, "DOUYIN_SDK_HANDOFF");
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Expire",
      publicBaseUrl: "https://studio.example.test"
    });
    await f.db.publishPackageRecord.update({
      where: { id: created.package.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    await assert.rejects(
      f.bridge.claimPackage({
        packageId: created.package.id,
        token: created.claimToken
      }),
      /invalid, expired, or already used/
    );
    const after = await f.publishRepo.findPackageById(created.package.id);
    assert.equal(after?.status, "EXPIRED");
  } finally {
    await f.dispose();
  }
});

test("only explicit trusted direct-publish receipt can move project to PUBLISHED", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Direct",
      publicBaseUrl: "https://studio.example.test"
    });
    await assert.rejects(
      f.bridge.directPublish({
        projectId: f.projectId,
        packageId: created.package.id,
        confirmed: false
      }),
      /explicit user confirmation/
    );
    assert.equal(direct.publishCalls, 0);
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );

    const result = await f.bridge.directPublish({
      projectId: f.projectId,
      packageId: created.package.id,
      confirmed: true
    });
    assert.equal(direct.publishCalls, 1);
    assert.equal(result.package.status, "PUBLISHED_CONFIRMED");
    assert.equal(result.receipt.trusted, true);
    assert.equal(result.receipt.kind, "PUBLISHED_CONFIRMED");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "PUBLISHED"
    );
    // Retrying a successful request is receipt replay, even after the package expires or the provider goes offline.
    await f.db.publishPackageRecord.update({
      where: { id: created.package.id }, data: { expiresAt: new Date(0) }
    });
    direct.probe = async () => { throw new Error("provider now offline"); };
    const replay = await f.bridge.directPublish({
      projectId: f.projectId, packageId: created.package.id, confirmed: true
    });
    assert.equal(replay.receipt.id, result.receipt.id);
    assert.equal(direct.publishCalls, 1);
  } finally {
    await f.dispose();
  }
});




test("browser submission unknown is recorded without marking project published or auto-retrying", async () => {
  const browser = new FakeUnknownDirectProvider();
  const f = await fixture([browser, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, browser.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Browser unknown",
      publicBaseUrl: "https://studio.example.test"
    });

    await assert.rejects(
      f.bridge.directPublish({
        projectId: f.projectId,
        packageId: created.package.id,
        confirmed: true
      }),
      /管理页暂未确认|禁止自动重试/
    );

    const stored = await f.publishRepo.findPackageById(created.package.id);
    assert.equal(stored?.status, "SUBMISSION_UNKNOWN");
    assert.equal(stored?.errorCode, "SUBMISSION_UNKNOWN");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );

    const receipts = await f.publishRepo.listReceiptsForPackage(
      created.package.id
    );
    assert.equal(
      receipts.some(
        (receipt) =>
          receipt.kind === "SUBMISSION_UNKNOWN" &&
          receipt.trusted === false
      ),
      true
    );
    assert.equal(
      receipts.some((receipt) => receipt.kind === "PUBLISHED_CONFIRMED"),
      false
    );
    await assert.rejects(f.bridge.directPublish({
      projectId: f.projectId, packageId: created.package.id, confirmed: true
    }), /禁止重复发布/);
    assert.equal(browser.publishCalls, 1);
  } finally {
    await f.dispose();
  }
});

test("direct publishing claims a package atomically across independent database clients", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  const otherDb = new PrismaClient();
  try {
    const created = await f.bridge.createPackage({
      projectId: f.projectId, title: "Concurrent", providerType: direct.type,
      publicBaseUrl: "https://studio.example.test"
    });
    const otherBridge = new PublishBridgeService(f.productFlow, f.artifacts, f.finalOutput,
      new PrismaPublishRepository(otherDb), new PublishProviderRegistry([direct]), f.projectsRoot);
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const originalPublish = direct.directPublish.bind(direct);
    direct.directPublish = async input => { entered(); await hold; return originalPublish(input); };
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    const first = f.bridge.directPublish(input);
    try {
      await Promise.race([running, first.then(() => { throw new Error("provider gate was not entered"); })]);
      await assert.rejects(otherBridge.directPublish(input), /禁止重复发布/);
    } finally { release(); }
    const published = await first;
    assert.equal(direct.publishCalls, 1);
    assert.equal((await otherBridge.directPublish(input)).receipt.id, published.receipt.id);
    // Exercise the repository compare-and-swap directly, without relying on the service's preliminary read.
    const independent = await fixture([direct]);
    try {
      const fresh = await independent.bridge.createPackage({
        projectId: independent.projectId, title: "CAS", providerType: direct.type,
        publicBaseUrl: "https://studio.example.test"
      });
      const claim = { id: fresh.package.id, projectId: independent.projectId, now: new Date().toISOString() };
      const claims = await Promise.all([
        independent.publishRepo.claimDirectPublish(claim), new PrismaPublishRepository(otherDb).claimDirectPublish(claim)
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
    } finally { await independent.dispose(); }
    assert.equal(direct.publishCalls, 1);
  } finally { await otherDb.$disconnect(); await f.dispose(); }
});

test("a new package cannot bypass the in-flight or successful fence for the same final video", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  const otherDb = new PrismaClient();
  try {
    const create = () => f.bridge.createPackage({ projectId: f.projectId, title: "Same final video",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    const firstPackage = await create();
    const secondPackage = await create();
    const otherBridge = new PublishBridgeService(f.productFlow, f.artifacts, f.finalOutput,
      new PrismaPublishRepository(otherDb), new PublishProviderRegistry([direct]), f.projectsRoot);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = direct.directPublish.bind(direct);
    direct.directPublish = async input => { entered(); await hold; return original(input); };
    const first = f.bridge.directPublish({ projectId: f.projectId, packageId: firstPackage.package.id, confirmed: true });
    try {
      await Promise.race([waiting, first.then(() => { throw new Error("provider did not enter"); })]);
      await assert.rejects(otherBridge.directPublish({ projectId: f.projectId, packageId: secondPackage.package.id, confirmed: true }), /不能通过新发布包/);
    } finally { release(); }
    await first;
    const third = await create();
    await assert.rejects(otherBridge.directPublish({ projectId: f.projectId, packageId: third.package.id, confirmed: true }), /不能通过新发布包/);
    assert.equal(direct.publishCalls, 1);
  } finally { await otherDb.$disconnect(); await f.dispose(); }
});

test("a new package cannot bypass an unknown submission for the same final video", async () => {
  const browser = new FakeUnknownDirectProvider();
  const f = await fixture([browser]);
  try {
    const create = () => f.bridge.createPackage({ projectId: f.projectId, title: "Unknown same final video",
      providerType: browser.type, publicBaseUrl: "https://studio.example.test" });
    const first = await create();
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: first.package.id, confirmed: true }), /管理页暂未确认/);
    const next = await create();
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: next.package.id, confirmed: true }), /不能通过新发布包/);
    assert.equal((await f.publishRepo.findPackageById(next.package.id))?.status, "PACKAGE_READY");
    assert.equal(browser.publishCalls, 1);
  } finally { await f.dispose(); }
});

test("expired, failed and outdated final packages cannot call the publishing provider", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    const create = () => f.bridge.createPackage({
      projectId: f.projectId, title: "Reject invalid package", providerType: direct.type,
      publicBaseUrl: "https://studio.example.test"
    });
    const expired = await create();
    await f.db.publishPackageRecord.update({ where: { id: expired.package.id }, data: { expiresAt: new Date(0) } });
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: expired.package.id, confirmed: true }), /过期/);
    const failed = await create();
    await f.publishRepo.updatePackage(failed.package.id, { status: "FAILED" });
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: failed.package.id, confirmed: true }), /禁止重复发布/);
    const stale = await create();
    // Drift after the service's first read must still be caught inside the atomic claim.
    const originalClaim = f.publishRepo.claimDirectPublish.bind(f.publishRepo);
    f.publishRepo.claimDirectPublish = async input => {
      await f.finalOutput.markAssembliesStale(f.projectId);
      return originalClaim(input);
    };
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: stale.package.id, confirmed: true }), /当前已确认成片/);
    assert.equal((await f.publishRepo.findPackageById(stale.package.id))?.status, "PACKAGE_READY");
    assert.equal(direct.publishCalls, 0);
  } finally { await f.dispose(); }
});

test("accepted platform publication with a failed local receipt is unknown and cannot resubmit", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Receipt fault",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    const originalReceipt = f.publishRepo.createReceipt.bind(f.publishRepo);
    f.publishRepo.createReceipt = async receipt => {
      if (receipt.kind === "PUBLISHED_CONFIRMED") throw new Error("local receipt storage unavailable");
      return originalReceipt(receipt);
    };
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    await assert.rejects(f.bridge.directPublish(input), /本地确认记录未完整保存/);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.status, "SUBMISSION_UNKNOWN");
    await assert.rejects(f.bridge.directPublish(input), /禁止重复发布/);
    assert.equal(direct.publishCalls, 1);
    assert.equal((await f.publishRepo.listReceipts(f.projectId)).some(r => r.kind === "FAILED"), false);
  } finally { await f.dispose(); }
});

test("trusted receipt repairs an interrupted local finalization without publishing again", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Finalize fault",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    const originalUpdate = f.publishRepo.updatePackage.bind(f.publishRepo);
    let failOnce = true;
    f.publishRepo.updatePackage = async (id, update) => {
      if (update.status === "PUBLISHED_CONFIRMED" && failOnce) { failOnce = false; throw new Error("local finalization unavailable"); }
      return originalUpdate(id, update);
    };
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    await assert.rejects(f.bridge.directPublish(input), /本地确认记录未完整保存/);
    const trusted = (await f.publishRepo.listReceipts(f.projectId)).find(r => r.kind === "PUBLISHED_CONFIRMED");
    assert.ok(trusted);
    const replay = await f.bridge.directPublish(input);
    assert.equal(replay.receipt.id, trusted.id);
    assert.equal(replay.package.status, "PUBLISHED_CONFIRMED");
    assert.equal(direct.publishCalls, 1);
    assert.equal((await f.productFlow.getProject(f.projectId))?.status, "PUBLISHED");
  } finally { await f.dispose(); }
});

test("a durable in-flight claim blocks resubmission even when recording unknown also fails", async () => {
  const browser = new FakeUnknownDirectProvider();
  const f = await fixture([browser]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Unknown storage fault",
      providerType: browser.type, publicBaseUrl: "https://studio.example.test" });
    f.publishRepo.updatePackage = async () => { throw new Error("database update unavailable"); };
    f.publishRepo.createReceipt = async () => { throw new Error("receipt update unavailable"); };
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    await assert.rejects(f.bridge.directPublish(input), /管理页暂未确认/);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.status, "DIRECT_PUBLISHING");
    await assert.rejects(f.bridge.directPublish(input), /禁止重复发布/);
    assert.equal(browser.publishCalls, 1);
  } finally { await f.dispose(); }
});

test("a project status write failure after platform success is unknown and recovers from its trusted receipt", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Project status fault",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    const originalStatus = f.productFlow.setProjectStatus.bind(f.productFlow);
    let failOnce = true;
    f.productFlow.setProjectStatus = async (projectId, status) => {
      if (status === "PUBLISHED" && failOnce) { failOnce = false; throw new Error("project status unavailable"); }
      return originalStatus(projectId, status);
    };
    const input = { projectId: f.projectId, packageId: created.package.id, confirmed: true };
    await assert.rejects(f.bridge.directPublish(input), /本地确认记录未完整保存/);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.status, "SUBMISSION_UNKNOWN");
    assert.equal((await f.bridge.directPublish(input)).package.status, "PUBLISHED_CONFIRMED");
    assert.equal((await f.productFlow.getProject(f.projectId))?.status, "PUBLISHED");
    assert.equal(direct.publishCalls, 1);
  } finally { await f.dispose(); }
});

test("structured platform identifiers round-trip separately while historical receipts stay unchanged", async () => {
  const direct = new FakeDirectProvider();
  const original = direct.directPublish.bind(direct);
  const identity = { videoId: "opaque-upload-video", itemId: "opaque-openapi-item",
    providerAccountId: "original-open-id", providerAccountIdType: "OPEN_ID" as const };
  direct.directPublish = async input => ({ ...await original(input),
    videoId: identity.videoId, itemId: identity.itemId, platformIdentity: identity });
  const f = await fixture([direct]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Identity retention",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    const result = await f.bridge.directPublish({ projectId: f.projectId, packageId: created.package.id, confirmed: true });
    assert.deepEqual(result.receipt.platformIdentity, identity);
    assert.deepEqual((await f.publishRepo.listReceipts(f.projectId))[0]?.platformIdentity, identity);
    assert.deepEqual((await f.publishRepo.listReceiptsForPackage(created.package.id))[0]?.platformIdentity, identity);
    const legacy = await f.publishRepo.createReceipt({ id: crypto.randomUUID(), projectId: f.projectId,
      packageId: created.package.id, providerType: direct.type, kind: "HANDOFF_STARTED", trusted: false,
      externalReference: "legacy-opaque-reference", createdAt: new Date().toISOString() });
    assert.equal(legacy.platformIdentity, undefined);
    assert.equal((await f.publishRepo.listReceipts(f.projectId)).find(r => r.id === legacy.id)?.externalReference,
      "legacy-opaque-reference");
  } finally { await f.dispose(); }
});

test("receipt and platform identity commit atomically when identity storage rejects an insert", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Identity atomicity",
      providerType: direct.type, publicBaseUrl: "https://studio.example.test" });
    await f.db.$executeRaw`CREATE TRIGGER "pvs_test_reject_receipt_identity" BEFORE INSERT ON "PublishReceiptIdentityRecord"
      BEGIN SELECT RAISE(ABORT, 'test identity storage fault'); END`;
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: created.package.id, confirmed: true }),
      /本地确认记录未完整保存/);
    const receipts = await f.publishRepo.listReceiptsForPackage(created.package.id);
    assert.equal(receipts.some(r => r.kind === "PUBLISHED_CONFIRMED"), false);
    assert.equal(receipts.some(r => r.kind === "SUBMISSION_UNKNOWN"), true);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.status, "SUBMISSION_UNKNOWN");
    assert.equal(direct.publishCalls, 1);
  } finally {
    await f.db.$executeRaw`DROP TRIGGER IF EXISTS "pvs_test_reject_receipt_identity"`;
    await f.dispose();
  }
});
