import test from "node:test";
import assert from "node:assert/strict";
import type {
  MarketVideoMediaFetcher,
  MarketVideoSearchProvider,
  MarketVideoSearchResult
} from "../src/application/ports/market-video-provider.js";
import {
  DouyinBrowserBridgeMarketVideoSearchProvider,
  DouyinBrowserBridgeRuntime,
  DouyinBrowserMarketVideoMediaFetcher,
  DouyinBrowserMarketVideoSearchProvider,
  FallbackMarketVideoMediaFetcher,
  FallbackMarketVideoSearchProvider,
  parseDouyinBrowserCard,
  type DouyinBrowserMediaRuntime,
  type DouyinBrowserSearchRuntime
} from "../src/adapters/research/douyin-browser-market-video-provider.js";

function bridgeJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("browser Bridge provider maps raw Douyin metrics and sorts by likes", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/status")) {
      return bridgeJson({
        ok: true,
        connections: {
          "douyin.com": [
            {
              alive: true,
              lastActivity: new Date().toISOString()
            }
          ]
        }
      });
    }
    if (url.endsWith("/api/call")) {
      return bridgeJson({
        ok: true,
        value: {
          status_code: 0,
          data: [
            {
              aweme_info: {
                aweme_id: "7900000000000000001",
                desc: "较低点赞样本",
                create_time: 1791230000,
                author: {
                  nickname: "作者甲",
                  sec_uid: "sec-a"
                },
                statistics: {
                  digg_count: 90,
                  comment_count: 5,
                  share_count: 7,
                  play_count: 0
                }
              }
            },
            {
              aweme_info: {
                aweme_id: "7900000000000000003",
                desc: "高点赞样本",
                create_time: 1791240000,
                author: {
                  nickname: "作者乙",
                  sec_uid: "sec-b"
                },
                statistics: {
                  digg_count: 32000,
                  comment_count: 880,
                  share_count: 1900,
                  play_count: 0
                }
              }
            }
          ]
        }
      });
    }
    throw new Error("unexpected URL " + url);
  }) as typeof fetch;
  const runtime = new DouyinBrowserBridgeRuntime({
    endpoint: "http://127.0.0.1:19422",
    token: "fixture-token",
    fetcher
  });
  const provider =
    new DouyinBrowserBridgeMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-bridge",
    queries: ["手机"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 5
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.provider, "douyin-browser-bridge-search");
  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.candidates[0]!.videoId,
    "7900000000000000003"
  );
  assert.equal(result.candidates[0]!.authorName, "作者乙");
  assert.equal(result.candidates[0]!.metrics.likes, 32000);
  assert.equal(result.candidates[0]!.metrics.comments, 880);
  assert.equal(result.candidates[0]!.metrics.shares, 1900);
  assert.equal(result.candidates[0]!.metrics.plays, 0);
});

test("browser Bridge provider fails closed when no live Edge page is connected", async () => {
  let callRequests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/status")) {
      return bridgeJson({
        ok: true,
        connections: {}
      });
    }
    if (url.endsWith("/api/call")) {
      callRequests += 1;
      return bridgeJson({ ok: true, value: {} });
    }
    throw new Error("unexpected URL " + url);
  }) as typeof fetch;
  const runtime = new DouyinBrowserBridgeRuntime({
    endpoint: "http://127.0.0.1:19422",
    token: "fixture-token",
    fetcher
  });
  const provider =
    new DouyinBrowserBridgeMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-bridge",
    queries: ["手机"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 5
  });
  assert.equal(result.status, "BLOCKED");
  if (result.status !== "BLOCKED") return;
  assert.equal(result.code, "PROVIDER_ERROR");
  assert.match(result.message, /Bridge.*尚未连接/);
  assert.equal(callRequests, 0);
});

test("Douyin browser card parser extracts video id, title, author and public likes", () => {
  const candidate = parseDouyinBrowserCard(
    {
      href: "https://www.douyin.com/video/7900000000000000012",
      text:
        "00:46\n3.2万\n华为:你这么搞我是吧？我跟你爆了! #二手机 #华为\n@星言(高价回收)\n6天前"
    },
    "手机",
    3,
    "douyin-browser-search",
    Date.parse("2026-10-06T12:00:00.000Z")
  );
  assert.ok(candidate);
  assert.equal(candidate.videoId, "7900000000000000012");
  assert.equal(candidate.url, "https://www.douyin.com/video/7900000000000000012");
  assert.equal(candidate.title, "华为:你这么搞我是吧？我跟你爆了! #二手机 #华为");
  assert.equal(candidate.authorName, "星言(高价回收)");
  assert.equal(candidate.metrics.likes, 32000);
  assert.equal(candidate.metricsAvailability, "PLATFORM_PUBLIC");
  assert.equal(candidate.sourceProvider, "douyin-browser-search");
  assert.equal(candidate.publishedAt, "2026-09-30T12:00:00.000Z");
});

test("browser provider parses, deduplicates and locally sorts by public likes", async () => {
  const runtime: DouyinBrowserSearchRuntime = {
    async query() {
      return {
        status: "READY",
        cards: [
          {
            href: "https://www.douyin.com/video/7900000000000000001",
            text: "00:30\n80\n低点赞样本\n@作者甲\n1天前"
          },
          {
            href: "https://www.douyin.com/video/7900000000000000003",
            text: "01:10\n1.2万\n高点赞样本\n@作者乙\n2天前"
          }
        ]
      };
    }
  };
  const provider = new DouyinBrowserMarketVideoSearchProvider(runtime);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["护颈枕"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 2
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]!.videoId, "7900000000000000003");
  assert.equal(result.candidates[0]!.metrics.likes, 12000);
  assert.equal(result.provider, "douyin-browser-search");
});

test("resilient provider never calls browser fallback when dy-cli is READY", async () => {
  let fallbackCalls = 0;
  const ready: MarketVideoSearchResult = {
    status: "READY",
    provider: "douyin-cli-search",
    candidates: [],
    searchedQueries: ["手机"],
    checkedAt: "2026-10-06T00:00:00.000Z"
  };
  const primary: MarketVideoSearchProvider = {
    id: "primary",
    async search() {
      return ready;
    }
  };
  const fallback: MarketVideoSearchProvider = {
    id: "fallback",
    async search() {
      fallbackCalls += 1;
      throw new Error("must not run");
    }
  };
  const provider = new FallbackMarketVideoSearchProvider(primary, fallback);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["手机"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 5
  });
  assert.equal(result, ready);
  assert.equal(fallbackCalls, 0);
});

test("resilient provider automatically falls back on dy-cli RISK_CONTROL", async () => {
  let fallbackCalls = 0;
  const primary: MarketVideoSearchProvider = {
    id: "primary",
    async search() {
      return {
        status: "BLOCKED",
        provider: "douyin-cli-search",
        code: "RISK_CONTROL",
        message: "verify_check",
        requiredUserAction: "manual",
        searchedQueries: ["手机"],
        checkedAt: "2026-10-06T00:00:00.000Z"
      };
    }
  };
  const fallback: MarketVideoSearchProvider = {
    id: "fallback",
    async search() {
      fallbackCalls += 1;
      return {
        status: "READY",
        provider: "douyin-browser-search",
        candidates: [],
        searchedQueries: ["手机"],
        checkedAt: "2026-10-06T00:00:01.000Z",
        note: "browser ok"
      };
    }
  };
  const provider = new FallbackMarketVideoSearchProvider(primary, fallback);
  const result = await provider.search({
    projectId: "project-1",
    queries: ["手机"],
    sort: "MOST_LIKED",
    timeRange: "ANY",
    count: 5
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.provider, "douyin-browser-search");
  assert.match(result.note ?? "", /verify_check/);
  assert.match(result.note ?? "", /browser ok/);
});

test("browser media fetcher resolves a page media URL and returns bounded MP4 bytes", async () => {
  const runtime: DouyinBrowserMediaRuntime = {
    async resolveMedia() {
      return {
        status: "READY",
        mediaUrl: "https://1.1.1.1/video.mp4"
      };
    }
  };
  let fetchCalls = 0;
  const fetcher = new DouyinBrowserMarketVideoMediaFetcher(runtime, {
    maxBytes: 4096,
    fetcher: (async () => {
      fetchCalls += 1;
      const bytes = new Uint8Array(2048);
      bytes.set([0, 0, 0, 32, 102, 116, 121, 112], 0);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "video/mp4"
        }
      });
    }) as typeof fetch
  });
  const media = await fetcher.fetch({
    projectId: "project-1",
    candidate: {
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
    }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(media.mimeType, "video/mp4");
  assert.equal(media.bytes.byteLength, 2048);
  assert.equal(
    media.originalFilename,
    "douyin-7900000000000000001.mp4"
  );
});

test("resilient media fetcher falls back to browser media when dy-cli download fails", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: MarketVideoMediaFetcher = {
    id: "primary",
    async fetch() {
      primaryCalls += 1;
      throw new Error("dy-cli video data empty");
    }
  };
  const fallback: MarketVideoMediaFetcher = {
    id: "fallback",
    async fetch(input) {
      fallbackCalls += 1;
      return {
        sourceUrl: input.candidate.url,
        originalFilename: "fallback.mp4",
        mimeType: "video/mp4",
        bytes: new Uint8Array(4096)
      };
    }
  };
  const fetcher = new FallbackMarketVideoMediaFetcher(
    primary,
    fallback
  );
  const media = await fetcher.fetch({
    projectId: "project-1",
    candidate: {
      id: "7900000000000000003",
      platform: "DOUYIN",
      videoId: "7900000000000000003",
      url: "https://www.douyin.com/video/7900000000000000003",
      title: "下载 fallback",
      query: "测试",
      rank: 1,
      metrics: {},
      metricsAvailability: "UNAVAILABLE",
      sourceProvider: "fixture",
      status: "DISCOVERED"
    }
  });
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(media.originalFilename, "fallback.mp4");
  assert.equal(media.bytes.byteLength, 4096);
});
