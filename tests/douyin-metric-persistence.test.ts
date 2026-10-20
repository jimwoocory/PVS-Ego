import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinMetricService } from "../src/application/services/douyin-metric-service.js";
import type {
  DouyinOpsRuntime,
  DouyinOpsWork
} from "../src/application/ports/douyin-ops-runtime.js";
import type {
  DouyinWorkBindingDecision
} from "../src/application/services/douyin-work-binding-service.js";
import { DomainValidationError } from "../src/domain/validation.js";

const exec = promisify(execFile);

class FakeOpsRuntime implements DouyinOpsRuntime {
  calls = 0;
  fail = false;
  work: DouyinOpsWork = {
    awemeId: "7900000000000000010",
    description: "测试作品",
    publishedAt: "2026-10-07T05:05:00.000Z",
    author: {
      nickname: "WC",
      uid: "uid",
      secUid: "sec",
      uniqueId: "50805615998"
    },
    metrics: {
      plays: 100,
      likes: 10,
      comments: 2,
      shares: 1
    },
    durationMs: 15000,
    coverUrl: "https://example.test/cover.jpg",
    externalUrl:
      "https://www.douyin.com/video/7900000000000000010"
  };

  async probe() {
    return { ok: true, ready: true, status: "READY" };
  }

  async identity() {
    return {
      nickname: "WC",
      uid: "uid",
      secUid: "sec",
      uniqueId: "50805615998",
      shortId: "0"
    };
  }

  async listMyWorks() {
    return [this.work];
  }

  async searchWorks() {
    return [this.work];
  }

  async getWork() {
    this.calls += 1;
    if (this.fail) throw new Error("runtime offline");
    return structuredClone(this.work);
  }

  async getComments() {
    return { comments: [], cursor: "0", hasMore: false };
  }

  async getReplies() {
    return { comments: [], cursor: "0", hasMore: false };
  }

  async getDownloadMetadata() {
    return {
      work: this.work,
      media: { videoUrl: "", audioUrl: "" }
    };
  }
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-metrics-")
  );
  const database =
    "file:" +
    path.join(root, "fixture.db").replaceAll("\\", "/");

  await exec(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy"
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: database
      },
      windowsHide: true,
      timeout: 90_000
    }
  );

  const db = new PrismaClient({
    datasources: { db: { url: database } }
  });
  const projectId = "douyin-metric-project";

  await db.project.create({
    data: {
      id: projectId,
      name: "抖音指标隔离测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });

  const repo = new PrismaDouyinOpsRepository(db);
  const runtime = new FakeOpsRuntime();
  const service = new DouyinMetricService(repo, runtime);

  return {
    root,
    database,
    db,
    repo,
    runtime,
    service,
    projectId,
    cleanup: async () => {
      await db.$disconnect();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function trustedDecision(): DouyinWorkBindingDecision {
  return {
    status: "BOUND",
    source: "PUBLISH_RECEIPT",
    awemeId: "7900000000000000010",
    externalUrl:
      "https://www.douyin.com/video/7900000000000000010",
    confidence: "TRUSTED",
    canAutoDiscover: false,
    requiresUserSelection: false,
    reason: "TRUSTED_RECEIPT_VIDEO_ID",
    packageId: "package-1",
    receiptId: "receipt-1",
    message: "trusted"
  };
}

test("Douyin binding and metric history persist in isolated PVS SQLite", async (t) => {
  const fx = await fixture();
  try {
    let bindingId = "";

    await t.test("persists a trusted work binding in PVS", async () => {
      const binding = await fx.service.persistBinding({
        projectId: fx.projectId,
        decision: trustedDecision(),
        publishedAt: "2026-10-07T05:05:00.000Z",
        now: "2026-10-07T05:06:00.000Z"
      });

      bindingId = binding.id;
      assert.equal(binding.status, "BOUND");
      assert.equal(binding.source, "PUBLISH_RECEIPT");
      assert.equal(binding.awemeId, "7900000000000000010");

      const row = await fx.repo.findWorkBindingByPackage(
        "package-1"
      );
      assert.equal(row?.id, bindingId);
      assert.equal(row?.confidence, "TRUSTED");
    });

    await t.test("upserting the same package preserves binding identity", async () => {
      const binding = await fx.service.persistBinding({
        projectId: fx.projectId,
        decision: trustedDecision(),
        now: "2026-10-07T05:07:00.000Z"
      });
      assert.equal(binding.id, bindingId);
    });

    let firstSnapshotId = "";

    await t.test("creates an immutable metric snapshot from the bound aweme", async () => {
      const snapshot = await fx.service.refresh({
        projectId: fx.projectId,
        packageId: "package-1",
        captureKey: "manual-refresh-1",
        capturedAt: "2026-10-07T05:10:00.000Z"
      });

      firstSnapshotId = snapshot.id;
      assert.equal(snapshot.awemeId, "7900000000000000010");
      assert.equal(snapshot.plays, 100);
      assert.equal(snapshot.likes, 10);
      assert.equal(snapshot.comments, 2);
      assert.equal(snapshot.shares, 1);
      assert.equal(snapshot.bindingId, bindingId);
    });

    await t.test("same captureKey and same content is idempotent", async () => {
      const repeated = await fx.service.refresh({
        projectId: fx.projectId,
        packageId: "package-1",
        captureKey: "manual-refresh-1",
        capturedAt: "2026-10-07T05:11:00.000Z"
      });

      assert.equal(repeated.id, firstSnapshotId);
      const rows = await fx.repo.listMetricSnapshots({
        projectId: fx.projectId
      });
      assert.equal(rows.length, 1);
    });

    await t.test("same captureKey cannot be reused for different metric content", async () => {
      fx.runtime.work.metrics.plays = 101;
      await assert.rejects(
        fx.service.refresh({
          projectId: fx.projectId,
          packageId: "package-1",
          captureKey: "manual-refresh-1",
          capturedAt: "2026-10-07T05:12:00.000Z"
        }),
        /captureKey was reused with different content/
      );

      const rows = await fx.repo.listMetricSnapshots({
        projectId: fx.projectId
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.plays, 100);
    });

    await t.test("a new captureKey appends a second historical point", async () => {
      const second = await fx.service.refresh({
        projectId: fx.projectId,
        packageId: "package-1",
        captureKey: "manual-refresh-2",
        capturedAt: "2026-10-07T05:15:00.000Z"
      });
      assert.equal(second.plays, 101);

      const history = await fx.service.history({
        projectId: fx.projectId,
        awemeId: "7900000000000000010"
      });
      assert.equal(history.length, 2);
      assert.deepEqual(
        history.map((item) => item.plays),
        [100, 101]
      );
      assert.deepEqual(
        history.map((item) => item.captureKey),
        ["manual-refresh-1", "manual-refresh-2"]
      );
    });

    await t.test("history remains readable when the external runtime is unavailable", async () => {
      fx.runtime.fail = true;
      const callsBefore = fx.runtime.calls;
      const history = await fx.service.history({
        projectId: fx.projectId
      });
      assert.equal(history.length, 2);
      assert.equal(fx.runtime.calls, callsBefore);
    });

    await t.test("project deletion cascades PVS-owned Douyin derived data", async () => {
      await fx.db.project.delete({
        where: { id: fx.projectId }
      });
      assert.equal(
        await fx.db.douyinWorkBindingRecord.count(),
        0
      );
      assert.equal(
        await fx.db.douyinMetricSnapshotRecord.count(),
        0
      );
    });
  } finally {
    await fx.cleanup();
  }
});

test("metric refresh fails closed without a confirmed binding", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.service.refresh({
        projectId: fx.projectId,
        captureKey: "no-binding"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /尚未建立/.test(error.message)
    );
    assert.equal(fx.runtime.calls, 0);
  } finally {
    await fx.cleanup();
  }
});

test("metric refresh rejects a runtime work-id mismatch", async () => {
  const fx = await fixture();
  try {
    await fx.service.persistBinding({
      projectId: fx.projectId,
      decision: trustedDecision(),
      now: "2026-10-07T05:06:00.000Z"
    });

    fx.runtime.work.awemeId = "7900000000000000001";

    await assert.rejects(
      fx.service.refresh({
        projectId: fx.projectId,
        packageId: "package-1",
        captureKey: "wrong-work"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /作品 ID 与 PVS 绑定不一致/.test(error.message)
    );
  } finally {
    await fx.cleanup();
  }
});
