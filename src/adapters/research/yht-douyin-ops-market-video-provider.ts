import "../../isolation/require-isolation.js";
import type {
  MarketVideoCandidate,
  MarketVideoMediaFetcher,
  MarketVideoSearchProvider,
  MarketVideoSearchResult,
  MarketVideoSort,
  MarketVideoTimeRange
} from "../../application/ports/market-video-provider.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsRuntime,
  type DouyinOpsWork
} from "../../application/ports/douyin-ops-runtime.js";
import { DomainValidationError } from "../../domain/validation.js";
import { assertSafeResearchUrl } from "./http-web-research-provider.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function uniqueQueries(queries: string[]): string[] {
  return [
    ...new Set(
      queries
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ].slice(0, 4);
}

function candidateWithinRange(
  candidate: MarketVideoCandidate,
  range: MarketVideoTimeRange,
  nowMs = Date.now()
): boolean {
  if (range === "ANY") return true;
  if (!candidate.publishedAt) return false;
  const published = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(published)) return false;
  const days =
    range === "DAY"
      ? 1
      : range === "WEEK"
        ? 7
        : 182;
  const cutoff =
    nowMs - days * 24 * 60 * 60 * 1000;
  return (
    published >= cutoff &&
    published <= nowMs + 24 * 60 * 60 * 1000
  );
}

function candidateFromWork(
  work: DouyinOpsWork,
  query: string,
  rank: number,
  provider: string
): MarketVideoCandidate {
  return {
    id: work.awemeId,
    platform: "DOUYIN",
    videoId: work.awemeId,
    url:
      work.externalUrl ||
      "https://www.douyin.com/video/" +
        work.awemeId,
    title:
      work.description ||
      "抖音公开视频 " + work.awemeId,
    ...(work.author.nickname
      ? { authorName: work.author.nickname }
      : {}),
    ...(work.author.secUid ||
    work.author.uid ||
    work.author.uniqueId
      ? {
          authorId:
            work.author.secUid ||
            work.author.uid ||
            work.author.uniqueId
        }
      : {}),
    ...(work.publishedAt
      ? { publishedAt: work.publishedAt }
      : {}),
    query,
    rank,
    metrics: {
      likes: work.metrics.likes,
      comments: work.metrics.comments,
      shares: work.metrics.shares,
      plays: work.metrics.plays
    },
    metricsAvailability: "PLATFORM_PUBLIC",
    sourceProvider: provider,
    status: "DISCOVERED"
  };
}

function sortCandidates(
  candidates: MarketVideoCandidate[],
  sort: MarketVideoSort
): MarketVideoCandidate[] {
  const values = [...candidates];
  if (sort === "MOST_LIKED") {
    values.sort(
      (a, b) =>
        (b.metrics.likes ?? -1) -
          (a.metrics.likes ?? -1) ||
        a.rank - b.rank
    );
  } else if (sort === "LATEST") {
    values.sort(
      (a, b) =>
        (b.publishedAt
          ? Date.parse(b.publishedAt)
          : -1) -
          (a.publishedAt
            ? Date.parse(a.publishedAt)
            : -1) ||
        a.rank - b.rank
    );
  }
  return values;
}

function blocked(
  error: unknown,
  provider: string,
  queries: string[]
): MarketVideoSearchResult {
  const checkedAt = new Date().toISOString();
  if (
    error instanceof DouyinOpsRuntimeError &&
    error.code === "AUTH_REQUIRED"
  ) {
    return {
      status: "BLOCKED",
      provider,
      code: "LOGIN_REQUIRED",
      message:
        "抖音竞品视频搜索需要先登录抖音运营账号。",
      requiredUserAction:
        "打开 PVS 的“抖音运营”，启动专用浏览器并完成正常登录后重新研究。",
      searchedQueries: queries,
      checkedAt
    };
  }
  if (
    error instanceof DouyinOpsRuntimeError &&
    error.code === "RISK_CONTROL"
  ) {
    return {
      status: "BLOCKED",
      provider,
      code: "RISK_CONTROL",
      message:
        "抖音搜索触发验证码或平台风控，本轮已停止。",
      requiredUserAction:
        "在专用抖音浏览器中完成人工验证后再重试；系统不会绕过验证码或风控。",
      searchedQueries: queries,
      checkedAt
    };
  }
  if (
    error instanceof DouyinOpsRuntimeError &&
    [
      "ENGINE_UNAVAILABLE",
      "BRIDGE_OFFLINE",
      "SITE_OFFLINE",
      "CLIENT_SCRIPT_OUTDATED"
    ].includes(error.code)
  ) {
    return {
      status: "BLOCKED",
      provider,
      code: "PROVIDER_NOT_AVAILABLE",
      message:
        "抖音运营连接当前不可用。",
      requiredUserAction:
        "在 PVS 的“抖音运营”中启动或恢复专用浏览器连接后重新运行研究。",
      searchedQueries: queries,
      checkedAt
    };
  }
  return {
    status: "BLOCKED",
    provider,
    code: "PROVIDER_ERROR",
    message: "抖音竞品视频搜索暂时失败。",
    requiredUserAction:
      "检查抖音运营连接和登录状态后重新运行；产品事实研究仍可独立继续。",
    searchedQueries: queries,
    checkedAt
  };
}

export class YhtDouyinOpsMarketVideoSearchProvider
  implements MarketVideoSearchProvider
{
  readonly id = "yht-douyin-ops-search";

  constructor(
    private readonly runtime: DouyinOpsRuntime
  ) {}

  async search(input: {
    projectId: string;
    queries: string[];
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    count: number;
  }): Promise<MarketVideoSearchResult> {
    const queries = uniqueQueries(input.queries);
    if (!queries.length) {
      return {
        status: "READY",
        provider: this.id,
        candidates: [],
        searchedQueries: [],
        checkedAt: new Date().toISOString(),
        note:
          "没有足够的产品品类信息生成抖音竞品搜索词。"
      };
    }

    const probe = await this.runtime.probe();
    if (!probe.ready) {
      return blocked(
        new DouyinOpsRuntimeError(
          probe.status,
          probe.message ??
            "抖音运营连接当前不可用"
        ),
        this.id,
        queries
      );
    }

    const perQuery = Math.max(
      3,
      Math.min(
        20,
        Math.ceil(input.count / queries.length) + 2
      )
    );
    const all: MarketVideoCandidate[] = [];
    const failures: string[] = [];

    for (const query of queries) {
      try {
        const works =
          await this.runtime.searchWorks({
            query,
            count: perQuery,
            offset: 0
          });
        works.forEach((work, index) => {
          all.push(
            candidateFromWork(
              work,
              query,
              index + 1,
              this.id
            )
          );
        });
      } catch (error) {
        if (
          error instanceof DouyinOpsRuntimeError &&
          [
            "AUTH_REQUIRED",
            "RISK_CONTROL",
            "ENGINE_UNAVAILABLE",
            "BRIDGE_OFFLINE",
            "SITE_OFFLINE",
            "CLIENT_SCRIPT_OUTDATED"
          ].includes(error.code)
        ) {
          return blocked(error, this.id, queries);
        }
        failures.push(
          error instanceof Error
            ? error.message
            : String(error)
        );
      }
    }

    const deduped =
      new Map<string, MarketVideoCandidate>();
    for (const candidate of all) {
      const previous =
        deduped.get(candidate.videoId);
      if (
        !previous ||
        (candidate.metrics.likes ?? -1) >
          (previous.metrics.likes ?? -1)
      ) {
        deduped.set(
          candidate.videoId,
          candidate
        );
      }
    }

    const filtered = [...deduped.values()].filter(
      (candidate) =>
        candidateWithinRange(
          candidate,
          input.timeRange
        )
    );
    const candidates = sortCandidates(
      filtered,
      input.sort
    ).slice(
      0,
      Math.max(
        1,
        Math.min(50, input.count)
      )
    );

    if (!candidates.length && failures.length) {
      return blocked(
        new Error(failures[0]),
        this.id,
        queries
      );
    }

    return {
      status: "READY",
      provider: this.id,
      candidates,
      searchedQueries: queries,
      checkedAt: new Date().toISOString(),
      ...(failures.length ||
      filtered.length !== deduped.size
        ? {
            note: [
              failures.length
                ? "部分搜索词失败，其余结果已保留。"
                : "",
              filtered.length !== deduped.size
                ? "已在 PVS 本地校验发布时间并移除不符合时间范围的候选。"
                : ""
            ]
              .filter(Boolean)
              .join(" ")
          }
        : {})
    };
  }
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } =
      await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DomainValidationError(
        "竞品参考视频超过允许大小"
      );
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class YhtDouyinOpsMarketVideoMediaFetcher
  implements MarketVideoMediaFetcher
{
  readonly id = "yht-douyin-ops-media";
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly runtime: DouyinOpsRuntime,
    options: {
      timeoutMs?: number;
      maxBytes?: number;
      fetcher?: typeof fetch;
    } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxBytes =
      options.maxBytes ?? 140 * 1024 * 1024;
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetch(input: {
    projectId: string;
    candidate: MarketVideoCandidate;
  }): Promise<{
    sourceUrl: string;
    originalFilename: string;
    mimeType: "video/mp4";
    bytes: Uint8Array;
  }> {
    if (input.candidate.platform !== "DOUYIN") {
      throw new DomainValidationError(
        "当前 MediaFetcher 只支持抖音公开视频"
      );
    }

    const metadata =
      await this.runtime.getDownloadMetadata(
        input.candidate.videoId
      );
    if (
      metadata.work.awemeId !==
      input.candidate.videoId
    ) {
      throw new DomainValidationError(
        "抖音媒体元数据与候选作品 ID 不一致"
      );
    }
    if (!metadata.media.videoUrl) {
      throw new DomainValidationError(
        "该抖音候选没有取得可分析的视频媒体链接"
      );
    }

    let url = await assertSafeResearchUrl(
      metadata.media.videoUrl,
      false
    );
    let response: Response | undefined;

    for (
      let redirect = 0;
      redirect <= 4;
      redirect += 1
    ) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.timeoutMs
      );
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept:
              "video/mp4,video/*;q=0.9,*/*;q=0.1",
            "accept-language": "zh-CN,zh;q=0.9",
            "user-agent": USER_AGENT,
            referer: "https://www.douyin.com/"
          }
        });
      } finally {
        clearTimeout(timer);
      }

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        if (redirect >= 4) {
          throw new DomainValidationError(
            "竞品视频重定向次数过多"
          );
        }
        url = await assertSafeResearchUrl(
          new URL(
            response.headers.get("location")!,
            url
          ).toString(),
          false
        );
        continue;
      }
      break;
    }

    if (!response?.ok) {
      throw new DomainValidationError(
        "竞品视频媒体下载失败" +
          (response
            ? "：HTTP " + response.status
            : "")
      );
    }

    const bytes = await readLimitedBytes(
      response,
      this.maxBytes
    );
    if (bytes.byteLength < 1024) {
      throw new DomainValidationError(
        "竞品视频媒体内容过小，无法分析"
      );
    }

    return {
      sourceUrl: input.candidate.url,
      originalFilename:
        "douyin-" +
        input.candidate.videoId +
        ".mp4",
      mimeType: "video/mp4",
      bytes
    };
  }
}

export {
  candidateWithinRange as yhtDouyinCandidateWithinTimeRange
};
