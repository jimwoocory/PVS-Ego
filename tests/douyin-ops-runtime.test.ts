import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  YhtDouyinOpsRuntime,
  douyinOpsContractVersion,
  douyinOpsResultPrefix,
  type DouyinOpsCommandRunner
} from "../src/adapters/douyin/yht-douyin-ops-runtime.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsRuntime,
  type DouyinOpsWork
} from "../src/application/ports/douyin-ops-runtime.js";
import { DouyinOpsService } from "../src/application/services/douyin-ops-service.js";

const work: DouyinOpsWork = {
  awemeId: "7900000000000000010",
  description: "测试作品",
  publishedAt: "2026-09-15T09:35:34.000Z",
  author: {
    nickname: "WC",
    uid: "7900000000000000008",
    secUid: "sec-user",
    uniqueId: "50805615998"
  },
  metrics: {
    plays: 310,
    likes: 9,
    comments: 2,
    shares: 0,
    collects: 1
  },
  durationMs: 30047,
  coverUrl: "https://example.test/cover.jpg",
  externalUrl:
    "https://www.douyin.com/video/7900000000000000010"
};

function bridgeResult(
  operation: string,
  data: unknown,
  options: {
    ok?: boolean;
    status?: string;
    contractVersion?: number;
    readonly?: boolean;
    error?: { code: string; message: string };
  } = {}
) {
  const ok = options.ok ?? true;
  const body = {
    contractVersion: options.contractVersion ?? 1,
    readonly: options.readonly ?? true,
    operation,
    ok,
    status: options.status ?? (ok ? "READY" : "PROVIDER_ERROR"),
    checkedAt: "2026-10-07T05:00:00.000Z",
    ...(data !== undefined ? { data } : {}),
    ...(options.error ? { error: options.error } : {})
  };
  return {
    exitCode: ok ? 0 : 2,
    stdout:
      "ignored human output\n" +
      "PVS_DOUYIN_JSON:" +
      JSON.stringify(body) +
      "\n",
    stderr: ""
  };
}

async function withBridge(
  runner: DouyinOpsCommandRunner,
  fn: (
    runtime: YhtDouyinOpsRuntime,
    context: { root: string; bridgeScript: string }
  ) => Promise<void>
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-ops-")
  );
  const bridgeScript = path.join(root, "pvs_bridge.js");
  await fs.writeFile(
    bridgeScript,
    "// fixture bridge",
    "utf8"
  );
  try {
    const runtime = new YhtDouyinOpsRuntime({
      engineRoot: root,
      bridgeScript,
      nodeExecutable: process.execPath,
      timeoutMs: 4321,
      runner
    });
    await fn(runtime, { root, bridgeScript });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("PVS Douyin Ops contract constants are frozen at v1", () => {
  assert.equal(douyinOpsContractVersion, 1);
  assert.equal(douyinOpsResultPrefix, "PVS_DOUYIN_JSON:");
});

test("missing bridge fails closed before spawning a process", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-douyin-ops-missing-")
  );
  let calls = 0;
  try {
    const runtime = new YhtDouyinOpsRuntime({
      engineRoot: root,
      bridgeScript: path.join(root, "missing.js"),
      runner: async () => {
        calls += 1;
        throw new Error("must not run");
      }
    });
    const probe = await runtime.probe();
    assert.equal(probe.ok, false);
    assert.equal(probe.ready, false);
    assert.equal(probe.status, "ENGINE_UNAVAILABLE");
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("probe parses the v1 readonly envelope and uses fixed argv", async () => {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
  }> = [];
  await withBridge(
    async (executable, args, options) => {
      calls.push({
        executable,
        args: [...args],
        cwd: options.cwd,
        timeoutMs: options.timeoutMs
      });
      return bridgeResult("probe", {
        ready: true,
        status: "READY",
        bridgeVersion: "1.0.0",
        uptimeSeconds: 12,
        connection: {
          id: "conn-1",
          url: "https://www.douyin.com/",
          connectedAt: "2026-10-07T04:00:00.000Z",
          lastActivity: "2026-10-07T05:00:00.000Z"
        },
        capabilities: {
          bridge: true,
          identity: true,
          my: true,
          search: true,
          video: true,
          comments: true,
          replies: true
        }
      });
    },
    async (runtime, context) => {
      const probe = await runtime.probe();
      assert.equal(probe.ok, true);
      assert.equal(probe.ready, true);
      assert.equal(probe.status, "READY");
      assert.equal(probe.contractVersion, 1);
      assert.equal(probe.runtimeRoot, context.root);
      assert.equal(probe.connection?.id, "conn-1");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.executable, process.execPath);
      assert.deepEqual(calls[0]!.args, [
        context.bridgeScript,
        "probe"
      ]);
      assert.equal(calls[0]!.cwd, context.root);
      assert.equal(calls[0]!.timeoutMs, 4321);
    }
  );
});

test("probe rejects a contract version mismatch", async () => {
  await withBridge(
    async () =>
      bridgeResult(
        "probe",
        { ready: true, status: "READY" },
        { contractVersion: 2 }
      ),
    async (runtime) => {
      const probe = await runtime.probe();
      assert.equal(probe.ok, false);
      assert.equal(probe.ready, false);
      assert.equal(probe.status, "PROTOCOL_ERROR");
    }
  );
});

test("identity maps runtime AUTH_REQUIRED to DouyinOpsRuntimeError", async () => {
  await withBridge(
    async () =>
      bridgeResult(
        "identity",
        undefined,
        {
          ok: false,
          status: "AUTH_REQUIRED",
          error: {
            code: "AUTH_REQUIRED",
            message: "未取得当前抖音登录账号身份"
          }
        }
      ),
    async (runtime) => {
      await assert.rejects(
        runtime.identity(),
        (error: unknown) =>
          error instanceof DouyinOpsRuntimeError &&
          error.code === "AUTH_REQUIRED"
      );
    }
  );
});

test("malformed success data is rejected as a protocol error", async () => {
  await withBridge(
    async () =>
      bridgeResult("identity", {
        nickname: "WC"
      }),
    async (runtime) => {
      await assert.rejects(
        runtime.identity(),
        (error: unknown) =>
          error instanceof DouyinOpsRuntimeError &&
          error.code === "PROTOCOL_ERROR"
      );
    }
  );
});

test("adapter maps all P0 read operations and fixed flag arrays", async () => {
  const operations: string[][] = [];
  await withBridge(
    async (_executable, args) => {
      const operation = String(args[1] ?? "");
      operations.push([...args.slice(1)]);
      if (operation === "identity") {
        return bridgeResult("identity", {
          nickname: "WC",
          uid: "7900000000000000008",
          secUid: "sec-user",
          uniqueId: "50805615998",
          shortId: "0"
        });
      }
      if (operation === "my") {
        return bridgeResult("my", { items: [work] });
      }
      if (operation === "search") {
        return bridgeResult("search", { items: [work] });
      }
      if (operation === "video") {
        return bridgeResult("video", { work });
      }
      if (operation === "comments") {
        return bridgeResult("comments", {
          comments: [
            {
              cid: "7900000000000000011",
              awemeId: work.awemeId,
              uid: "132367766257955",
              secUid: "sec-commenter",
              nickname: "MJ",
              text: "帅呀",
              diggCount: 0,
              replyCount: 0,
              createdAt: "2026-09-15T11:22:55.000Z",
              parentCid: "",
              avatarUrl: "https://example.test/avatar.jpg"
            }
          ],
          cursor: "5",
          hasMore: false
        });
      }
      if (operation === "replies") {
        return bridgeResult("replies", {
          comments: [],
          cursor: "0",
          hasMore: false
        });
      }
      if (operation === "download") {
        return bridgeResult("download", {
          work,
          media: {
            videoUrl: "https://example.test/video.mp4",
            audioUrl: "https://example.test/audio.mp3"
          }
        });
      }
      throw new Error("unexpected operation " + operation);
    },
    async (runtime) => {
      assert.equal((await runtime.identity()).nickname, "WC");
      assert.equal((await runtime.listMyWorks(5))[0]!.awemeId, work.awemeId);
      assert.equal(
        (
          await runtime.searchWorks({
            query: "蓝牙耳机",
            count: 3,
            offset: 2
          })
        )[0]!.awemeId,
        work.awemeId
      );
      assert.equal(
        (await runtime.getWork(work.awemeId)).description,
        "测试作品"
      );
      assert.equal(
        (
          await runtime.getComments({
            awemeId: work.awemeId,
            cursor: "0",
            count: 5
          })
        ).comments[0]!.text,
        "帅呀"
      );
      assert.equal(
        (
          await runtime.getReplies({
            awemeId: work.awemeId,
            cid: "7900000000000000011",
            cursor: "0",
            count: 5
          })
        ).comments.length,
        0
      );
      assert.equal(
        (await runtime.getDownloadMetadata(work.awemeId)).media.videoUrl,
        "https://example.test/video.mp4"
      );

      assert.deepEqual(operations, [
        ["identity"],
        ["my", "--count", "5"],
        ["search", "--query", "蓝牙耳机", "--count", "3", "--offset", "2"],
        ["video", "--aweme-id", work.awemeId],
        ["comments", "--aweme-id", work.awemeId, "--cursor", "0", "--count", "5"],
        [
          "replies",
          "--aweme-id",
          work.awemeId,
          "--cid",
          "7900000000000000011",
          "--cursor",
          "0",
          "--count",
          "5"
        ],
        ["download", "--aweme-id", work.awemeId]
      ]);
    }
  );
});

test("default adapter implementation uses execFile with shell disabled", async () => {
  const source = await fs.readFile(
    path.resolve(
      "src/adapters/douyin/yht-douyin-ops-runtime.ts"
    ),
    "utf8"
  );
  assert.match(source, /execFile\(/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /exec\(/);
});

test("DouyinOpsService delegates only through the typed runtime", async () => {
  const calls: string[] = [];
  const runtime: DouyinOpsRuntime = {
    async probe() {
      calls.push("probe");
      return {
        ok: true,
        ready: true,
        status: "READY"
      };
    },
    async identity() {
      calls.push("identity");
      return {
        nickname: "WC",
        uid: "u",
        secUid: "s",
        uniqueId: "50805615998",
        shortId: "0"
      };
    },
    async listMyWorks() {
      calls.push("my");
      return [work];
    },
    async searchWorks() {
      calls.push("search");
      return [work];
    },
    async getWork() {
      calls.push("video");
      return work;
    },
    async getComments() {
      calls.push("comments");
      return { comments: [], cursor: "0", hasMore: false };
    },
    async getReplies() {
      calls.push("replies");
      return { comments: [], cursor: "0", hasMore: false };
    },
    async getDownloadMetadata() {
      calls.push("download");
      return {
        work,
        media: { videoUrl: "", audioUrl: "" }
      };
    }
  };

  const service = new DouyinOpsService(runtime);
  await service.probe();
  await service.identity();
  await service.listMyWorks();
  await service.searchWorks({ query: "测试" });
  await service.getWork(work.awemeId);
  await service.getComments({ awemeId: work.awemeId });
  await service.getReplies({
    awemeId: work.awemeId,
    cid: "1"
  });
  await service.getDownloadMetadata(work.awemeId);

  assert.deepEqual(calls, [
    "probe",
    "identity",
    "my",
    "search",
    "video",
    "comments",
    "replies",
    "download"
  ]);
});
