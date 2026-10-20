import test from "node:test";
import assert from "node:assert/strict";
import type {
  DouyinOpsDownloadMetadata,
  DouyinOpsProbe,
  DouyinOpsRuntime,
  DouyinOpsWork
} from "../src/application/ports/douyin-ops-runtime.js";
import { DouyinOpsRuntimeError } from "../src/application/ports/douyin-ops-runtime.js";
import type {
  MarketVideoCandidate
} from "../src/application/ports/market-video-provider.js";
import {
  YhtDouyinOpsMarketVideoMediaFetcher,
  YhtDouyinOpsMarketVideoSearchProvider,
  yhtDouyinCandidateWithinTimeRange
} from "../src/adapters/research/yht-douyin-ops-market-video-provider.js";

function work(input: {
  id: string;
  likes: number;
  publishedAt?: string;
  title?: string;
}): DouyinOpsWork {
  return {
    awemeId: input.id,
    description: input.title ?? "测试作品 " + input.id,
    publishedAt: input.publishedAt ?? "2026-10-06T10:00:00.000Z",
    author: {
      nickname: "作者",
      uid: "uid-" + input.id,
      secUid: "sec-" + input.id,
      uniqueId: ""
    },
    metrics: {
      plays: input.likes * 10,
      likes: input.likes,
      comments: Math.floor(input.likes / 10),
      shares: Math.floor(input.likes / 20)
    },
    durationMs: 15000,
    coverUrl: "",
    externalUrl:
      "https://www.douyin.com/video/" + input.id
  };
}

class Runtime implements DouyinOpsRuntime {
  probeValue: DouyinOpsProbe = {
    ok: true,
    ready: true,
    status: "READY"
  };
  searchCalls: Array<{
    query: string;
    count?: number;
    offset?: number;
  }> = [];
  searchMap = new Map<string, DouyinOpsWork[]>();
  searchError?: Error;
  download?: DouyinOpsDownloadMetadata;

  async probe() {
    return this.probeValue;
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
    return [];
  }
  async searchWorks(input: {
    query: string;
    count?: number;
    offset?: number;
  }) {
    this.searchCalls.push(input);
    if (this.searchError) throw this.searchError;
    return this.searchMap.get(input.query) ?? [];
  }
  async getWork(): Promise<never> {
    throw new Error("not used");
  }
  async getComments() {
    return { comments: [], cursor: "0", hasMore: false };
  }
  async getReplies() {
    return { comments: [], cursor: "0", hasMore: false };
  }
  async getDownloadMetadata() {
    if (!this.download) throw new Error("no metadata");
    return this.download;
  }
}

test("Yht research provider searches through DouyinOpsRuntime and sorts by likes", async () => {
  const runtime = new Runtime();
  runtime.searchMap.set("耳机", [
    work({ id: "7900000000000000001", likes: 10 }),
    work({ id: "7900000000000000003", likes: 900 })
  ]);
  runtime.searchMap.set("蓝牙", [
    work({ id: "7900000000000000004", likes: 300 }),
    work({ id: "7900000000000000003", likes: 800 })
  ]);

  const provider =
    new YhtDouyinOpsMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["耳机", "蓝牙"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 3
  });

  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.provider, "yht-douyin-ops-search");
  assert.deepEqual(
    result.candidates.map((item) => item.videoId),
    [
      "7900000000000000003",
      "7900000000000000004",
      "7900000000000000001"
    ]
  );
  assert.equal(result.candidates[0]!.metrics.likes, 900);
  assert.equal(result.candidates[0]!.sourceProvider, "yht-douyin-ops-search");
  assert.deepEqual(
    runtime.searchCalls.map((item) => item.query),
    ["耳机", "蓝牙"]
  );
});

test("Yht research provider maps auth failure to LOGIN_REQUIRED", async () => {
  const runtime = new Runtime();
  runtime.searchError = new DouyinOpsRuntimeError(
    "AUTH_REQUIRED",
    "need login"
  );
  const provider =
    new YhtDouyinOpsMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["耳机"],
    sort: "RELEVANCE",
    timeRange: "ANY",
    count: 5
  });

  assert.equal(result.status, "BLOCKED");
  if (result.status !== "BLOCKED") return;
  assert.equal(result.code, "LOGIN_REQUIRED");
  assert.match(result.requiredUserAction, /抖音运营/);
});

test("Yht research provider maps unavailable Bridge to provider unavailable before search", async () => {
  const runtime = new Runtime();
  runtime.probeValue = {
    ok: false,
    ready: false,
    status: "SITE_OFFLINE",
    message: "no page"
  };
  const provider =
    new YhtDouyinOpsMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["耳机"],
    sort: "RELEVANCE",
    timeRange: "ANY",
    count: 5
  });

  assert.equal(result.status, "BLOCKED");
  if (result.status !== "BLOCKED") return;
  assert.equal(result.code, "PROVIDER_NOT_AVAILABLE");
  assert.equal(runtime.searchCalls.length, 0);
});

test("Yht time-range filter is local and deterministic", () => {
  const candidate = {
    id: "7900000000000000001",
    platform: "DOUYIN",
    videoId: "7900000000000000001",
    url: "https://www.douyin.com/video/7900000000000000001",
    title: "test",
    publishedAt: "2026-10-06T12:00:00.000Z",
    query: "test",
    rank: 1,
    metrics: { likes: 1 },
    metricsAvailability: "PLATFORM_PUBLIC",
    sourceProvider: "fixture",
    status: "DISCOVERED"
  } satisfies MarketVideoCandidate;
  const now = Date.parse("2026-10-07T12:00:00.000Z");

  assert.equal(
    yhtDouyinCandidateWithinTimeRange(candidate, "DAY", now),
    true
  );
  assert.equal(
    yhtDouyinCandidateWithinTimeRange(
      { ...candidate, publishedAt: "2026-09-01T00:00:00.000Z" },
      "WEEK",
      now
    ),
    false
  );
});

test("Yht media fetcher resolves metadata through runtime and returns bounded MP4 bytes", async () => {
  const runtime = new Runtime();
  const candidate: MarketVideoCandidate = {
    id: "7900000000000000001",
    platform: "DOUYIN",
    videoId: "7900000000000000001",
    url: "https://www.douyin.com/video/7900000000000000001",
    title: "测试候选",
    query: "测试",
    rank: 1,
    metrics: { likes: 100 },
    metricsAvailability: "PLATFORM_PUBLIC",
    sourceProvider: "fixture",
    status: "DISCOVERED"
  };
  const candidateWork = work({
    id: candidate.videoId,
    likes: 100
  });
  runtime.download = {
    work: candidateWork,
    media: {
      videoUrl: "https://1.1.1.1/video.mp4",
      audioUrl: ""
    }
  };

  let calls = 0;
  const fetcher =
    new YhtDouyinOpsMarketVideoMediaFetcher(
      runtime,
      {
        maxBytes: 4096,
        fetcher: (async () => {
          calls += 1;
          const bytes = new Uint8Array(2048);
          bytes.set(
            [0, 0, 0, 32, 102, 116, 121, 112],
            0
          );
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-length":
                String(bytes.byteLength),
              "content-type": "video/mp4"
            }
          });
        }) as typeof fetch
      }
    );

  const media = await fetcher.fetch({
    projectId: "project-1",
    candidate
  });
  assert.equal(calls, 1);
  assert.equal(media.mimeType, "video/mp4");
  assert.equal(media.bytes.byteLength, 2048);
  assert.equal(
    media.originalFilename,
    "douyin-7900000000000000001.mp4"
  );
});

test("Yht media fetcher rejects runtime metadata for the wrong work id", async () => {
  const runtime = new Runtime();
  runtime.download = {
    work: work({
      id: "7900000000000000003",
      likes: 1
    }),
    media: {
      videoUrl: "https://1.1.1.1/video.mp4",
      audioUrl: ""
    }
  };
  const fetcher =
    new YhtDouyinOpsMarketVideoMediaFetcher(runtime);

  await assert.rejects(
    fetcher.fetch({
      projectId: "project-1",
      candidate: {
        id: "7900000000000000001",
        platform: "DOUYIN",
        videoId: "7900000000000000001",
        url: "https://www.douyin.com/video/7900000000000000001",
        title: "测试",
        query: "测试",
        rank: 1,
        metrics: {},
        metricsAvailability: "UNAVAILABLE",
        sourceProvider: "fixture",
        status: "DISCOVERED"
      }
    }),
    /作品 ID 不一致/
  );
});
