import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaDouyinOpsRepository } from "../src/adapters/db/prisma-douyin-ops-repository.js";
import { DouyinCommentService } from "../src/application/services/douyin-comment-service.js";
import type {
  DouyinOpsCommentPage,
  DouyinOpsRuntime
} from "../src/application/ports/douyin-ops-runtime.js";
import { DomainValidationError } from "../src/domain/validation.js";

const exec = promisify(execFile);
const AWEME = "7900000000000000010";

class FakeRuntime implements DouyinOpsRuntime {
  commentCalls = 0;
  replyCalls = 0;
  fail = false;
  wrongAweme = false;
  stuckCursor = false;

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
  async listMyWorks() { return []; }
  async searchWorks() { return []; }
  async getWork(): Promise<never> {
    throw new Error("not used");
  }
  async getDownloadMetadata(): Promise<never> {
    throw new Error("not used");
  }

  async getComments(input: {
    awemeId: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    this.commentCalls += 1;
    if (this.fail) throw new Error("runtime offline");
    const awemeId = this.wrongAweme
      ? "7900000000000000001"
      : input.awemeId;
    if ((input.cursor ?? "0") === "0") {
      return {
        comments: [
          {
            cid: "1001",
            awemeId,
            uid: "u1",
            secUid: "s1",
            nickname: "用户A",
            text: "第一条",
            diggCount: 2,
            replyCount: 1,
            createdAt: "2026-10-07T05:00:00.000Z",
            parentCid: "",
            avatarUrl: ""
          },
          {
            cid: "1002",
            awemeId,
            uid: "u2",
            secUid: "s2",
            nickname: "用户B",
            text: "第二条",
            diggCount: 1,
            replyCount: 0,
            createdAt: "2026-10-07T05:01:00.000Z",
            parentCid: "",
            avatarUrl: ""
          }
        ],
        cursor: this.stuckCursor ? "0" : "2",
        hasMore: true
      };
    }
    return {
      comments: [
        {
          cid: "1003",
          awemeId,
          uid: "u3",
          secUid: "s3",
          nickname: "用户C",
          text: "第三条",
          diggCount: 0,
          replyCount: 0,
          createdAt: "2026-10-07T05:02:00.000Z",
          parentCid: "",
          avatarUrl: ""
        }
      ],
      cursor: "3",
      hasMore: false
    };
  }

  async getReplies(input: {
    awemeId: string;
    cid: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    this.replyCalls += 1;
    if (this.fail) throw new Error("runtime offline");
    return {
      comments: [
        {
          cid: "2001",
          awemeId: input.awemeId,
          uid: "u4",
          secUid: "s4",
          nickname: "用户D",
          text: "回复第一条",
          diggCount: 0,
          replyCount: 0,
          createdAt: "2026-10-07T05:03:00.000Z",
          parentCid: input.cid,
          avatarUrl: ""
        }
      ],
      cursor: "0",
      hasMore: false
    };
  }
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-comments-")
  );
  const database =
    "file:" + path.join(root, "fixture.db").replaceAll("\\", "/");
  await fs.writeFile(path.join(root, "fixture.db"), Buffer.alloc(0), { flag: "wx" });

  await exec(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy"
    ],
    {
      env: { ...process.env, DATABASE_URL: database },
      windowsHide: true,
      timeout: 90_000
    }
  );

  const db = new PrismaClient({
    datasources: { db: { url: database } }
  });
  const projectId = "douyin-comment-project";
  await db.project.create({
    data: {
      id: projectId,
      name: "评论隔离测试",
      status: "PUBLISHED",
      targetPlatform: "douyin",
      targetDurationMs: 15000,
      aspectRatio: "9:16"
    }
  });

  const repo = new PrismaDouyinOpsRepository(db);
  const now = "2026-10-07T05:00:00.000Z";
  await repo.upsertWorkBinding({
    id: "binding-1",
    projectId,
    packageId: "package-1",
    publishReceiptId: "receipt-1",
    awemeId: AWEME,
    source: "PUBLISH_RECEIPT",
    confidence: "TRUSTED",
    status: "BOUND",
    boundAt: now,
    externalUrl: "https://www.douyin.com/video/" + AWEME,
    createdAt: now,
    updatedAt: now
  });

  const runtime = new FakeRuntime();
  const service = new DouyinCommentService(repo, runtime);

  return {
    root,
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

test("Douyin comments sync with pagination, dedup, replies and offline history", async (t) => {
  const fx = await fixture();
  try {
    await t.test("syncs two pages of top-level comments", async () => {
      const result = await fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1",
        maxPages: 5,
        pageSize: 20,
        syncedAt: "2026-10-07T05:10:00.000Z"
      });
      assert.equal(result.pages, 2);
      assert.equal(result.syncedCount, 3);
      assert.equal(result.hasMore, false);
      assert.equal(result.truncated, false);

      const rows = await fx.service.listComments({
        projectId: fx.projectId,
        awemeId: AWEME,
        parentCid: null
      });
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((x) => x.cid), ["1001", "1002", "1003"]);
    });

    await t.test("repeating sync upserts instead of duplicating", async () => {
      await fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1",
        syncedAt: "2026-10-07T05:11:00.000Z"
      });
      assert.equal(
        await fx.db.douyinCommentRecord.count({
          where: { awemeId: AWEME, parentCid: null }
        }),
        3
      );
    });

    await t.test("source resync preserves AI-derived sentiment and priority", async () => {
      await fx.db.douyinCommentRecord.update({
        where: {
          awemeId_cid: { awemeId: AWEME, cid: "1001" }
        },
        data: {
          sentiment: "POSITIVE",
          priority: "HIGH"
        }
      });
      await fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1",
        syncedAt: "2026-10-07T05:12:00.000Z"
      });
      const row = await fx.db.douyinCommentRecord.findUniqueOrThrow({
        where: {
          awemeId_cid: { awemeId: AWEME, cid: "1001" }
        }
      });
      assert.equal(row.sentiment, "POSITIVE");
      assert.equal(row.priority, "HIGH");
    });

    await t.test("explicit reply sync stores parentCid and stays deduplicated", async () => {
      const first = await fx.service.syncReplies({
        projectId: fx.projectId,
        packageId: "package-1",
        cid: "1001",
        syncedAt: "2026-10-07T05:13:00.000Z"
      });
      assert.equal(first.syncedCount, 1);

      await fx.service.syncReplies({
        projectId: fx.projectId,
        packageId: "package-1",
        cid: "1001",
        syncedAt: "2026-10-07T05:14:00.000Z"
      });

      const replies = await fx.service.listComments({
        projectId: fx.projectId,
        awemeId: AWEME,
        parentCid: "1001"
      });
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.cid, "2001");
      assert.equal(replies[0]!.parentCid, "1001");
    });

    await t.test("history remains readable while external runtime is offline", async () => {
      fx.runtime.fail = true;
      const callsBefore =
        fx.runtime.commentCalls + fx.runtime.replyCalls;
      const rows = await fx.service.listComments({
        projectId: fx.projectId,
        awemeId: AWEME
      });
      assert.equal(rows.length, 4);
      assert.equal(
        fx.runtime.commentCalls + fx.runtime.replyCalls,
        callsBefore
      );
    });

    await t.test("project deletion cascades stored comments", async () => {
      await fx.db.project.delete({
        where: { id: fx.projectId }
      });
      assert.equal(await fx.db.douyinCommentRecord.count(), 0);
    });
  } finally {
    await fx.cleanup();
  }
});

test("comment sync fails closed without a BOUND work", async () => {
  const fx = await fixture();
  try {
    await fx.db.douyinWorkBindingRecord.update({
      where: { packageId: "package-1" },
      data: { status: "PENDING_DISCOVERY", awemeId: null }
    });
    await assert.rejects(
      fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /尚未确认/.test(error.message)
    );
    assert.equal(fx.runtime.commentCalls, 0);
  } finally {
    await fx.cleanup();
  }
});

test("comment sync rejects a comment from another aweme", async () => {
  const fx = await fixture();
  try {
    fx.runtime.wrongAweme = true;
    await assert.rejects(
      fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /评论所属作品/.test(error.message)
    );
    assert.equal(await fx.db.douyinCommentRecord.count(), 0);
  } finally {
    await fx.cleanup();
  }
});

test("comment sync stops on a non-advancing pagination cursor", async () => {
  const fx = await fixture();
  try {
    fx.runtime.stuckCursor = true;
    await assert.rejects(
      fx.service.syncComments({
        projectId: fx.projectId,
        packageId: "package-1",
        maxPages: 5
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /游标没有推进/.test(error.message)
    );
  } finally {
    await fx.cleanup();
  }
});

test("reply sync requires a previously synced parent comment", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.service.syncReplies({
        projectId: fx.projectId,
        packageId: "package-1",
        cid: "9999"
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /请先同步/.test(error.message)
    );
    assert.equal(fx.runtime.replyCalls, 0);
  } finally {
    await fx.cleanup();
  }
});
