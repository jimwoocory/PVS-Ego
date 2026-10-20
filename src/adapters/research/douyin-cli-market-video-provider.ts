import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  MarketVideoCandidate,
  MarketVideoMediaFetcher,
  MarketVideoSearchProvider,
  MarketVideoSearchResult,
  MarketVideoSort,
  MarketVideoTimeRange
} from "../../application/ports/market-video-provider.js";
import { DomainValidationError } from "../../domain/validation.js";
import { assertSafeResearchUrl } from "./http-web-research-provider.js";

const execFileAsync = promisify(execFile);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export function resolveDouyinCli(): string {
  const explicit = process.env.PVS_DOUYIN_CLI_BIN?.trim();
  if (explicit) return explicit;
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    const installed = path.join(
      userProfile,
      "AgentDock",
      "douyin",
      ".venv",
      "Scripts",
      "dy.exe"
    );
    if (fs.existsSync(installed)) return installed;
  }
  return "dy";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const clean = stripAnsi(stdout);
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new DomainValidationError("抖音 CLI 没有返回可解析的 JSON");
  }
  const parsed = JSON.parse(clean.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new DomainValidationError("抖音 CLI JSON 结构无效");
  }
  return parsed as Record<string, unknown>;
}

export function douyinEnvelopeRequiresVerification(
  payload: Record<string, unknown>,
  stderr = ""
): boolean {
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};
  const nilInfo =
    data.search_nil_info &&
    typeof data.search_nil_info === "object" &&
    !Array.isArray(data.search_nil_info)
      ? (data.search_nil_info as Record<string, unknown>)
      : {};
  const signals = [
    nilInfo.search_nil_type,
    nilInfo.search_nil_item,
    data.qc,
    data.status_msg,
    data.message,
    payload.message,
    stderr
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /verify[_\s-]?check|captcha|risk[_\s-]?control|验证码|风控/i.test(
    signals
  );
}

async function runDy(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    const envelope = parseJsonEnvelope(String(result.stdout ?? ""));
    if (
      douyinEnvelopeRequiresVerification(
        envelope,
        stripAnsi(String(result.stderr ?? ""))
      )
    ) {
      throw new DomainValidationError("DOUYIN_RISK_CONTROL");
    }
    return envelope;
  } catch (error) {
    if (
      error instanceof DomainValidationError &&
      [
        "DOUYIN_CLI_NOT_FOUND",
        "DOUYIN_LOGIN_REQUIRED",
        "DOUYIN_RISK_CONTROL"
      ].includes(error.message)
    ) {
      throw error;
    }
    const item = error as {
      code?: string | number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stdout = String(item.stdout ?? "");
    const stderr = String(item.stderr ?? "");
    const message = stripAnsi([stderr, stdout, item.message ?? ""].join("\n")).trim();
    if (
      item.code === "ENOENT" ||
      /not recognized|cannot find|找不到|无法找到/i.test(message)
    ) {
      throw new DomainValidationError("DOUYIN_CLI_NOT_FOUND");
    }
    if (/请先登录|未登录|login required/i.test(message)) {
      throw new DomainValidationError("DOUYIN_LOGIN_REQUIRED");
    }
    if (/风控|验证码|captcha|risk control/i.test(message)) {
      throw new DomainValidationError("DOUYIN_RISK_CONTROL");
    }
    throw new DomainValidationError(
      "DOUYIN_CLI_ERROR:" + (message || "unknown error").slice(0, 1000)
    );
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractVideos(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = objectValue(payload.data);
  const body = Object.keys(data).length ? data : payload;
  const directLists = [body.aweme_list, body.items, body.videos];
  for (const list of directLists) {
    if (Array.isArray(list)) {
      return list
        .map((item) => objectValue(item))
        .filter((item) => Object.keys(item).length > 0);
    }
  }
  if (!Array.isArray(body.data)) return [];
  return body.data.flatMap((raw) => {
    const item = objectValue(raw);
    const aweme = objectValue(item.aweme_info);
    if (Object.keys(aweme).length) return [aweme];
    return item.aweme_id ? [item] : [];
  });
}

function publishedAt(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapCandidate(
  raw: Record<string, unknown>,
  query: string,
  rank: number,
  provider: string
): MarketVideoCandidate | null {
  const videoId =
    textValue(raw.aweme_id) ??
    (typeof raw.aweme_id === "number" ? String(raw.aweme_id) : undefined);
  if (!videoId || !/^\d{8,30}$/.test(videoId)) return null;
  const stats = objectValue(raw.statistics ?? raw.stats);
  const author = objectValue(raw.author);
  const metrics = {
    ...(numberValue(stats.digg_count ?? stats.likes) !== undefined
      ? { likes: numberValue(stats.digg_count ?? stats.likes)! }
      : {}),
    ...(numberValue(stats.comment_count ?? stats.comments) !== undefined
      ? { comments: numberValue(stats.comment_count ?? stats.comments)! }
      : {}),
    ...(numberValue(stats.share_count ?? stats.shares) !== undefined
      ? { shares: numberValue(stats.share_count ?? stats.shares)! }
      : {}),
    ...(numberValue(stats.play_count ?? stats.plays) !== undefined
      ? { plays: numberValue(stats.play_count ?? stats.plays)! }
      : {})
  };
  return {
    id: videoId,
    platform: "DOUYIN",
    videoId,
    url: "https://www.douyin.com/video/" + videoId,
    title: textValue(raw.desc) ?? "抖音公开视频 " + videoId,
    ...(textValue(author.nickname) ? { authorName: textValue(author.nickname)! } : {}),
    ...(textValue(author.sec_uid ?? author.uid ?? author.unique_id)
      ? { authorId: textValue(author.sec_uid ?? author.uid ?? author.unique_id)! }
      : {}),
    ...(publishedAt(raw.create_time) ? { publishedAt: publishedAt(raw.create_time)! } : {}),
    query,
    rank,
    metrics,
    metricsAvailability: Object.keys(metrics).length
      ? "PLATFORM_PUBLIC"
      : "UNAVAILABLE",
    sourceProvider: provider,
    status: "DISCOVERED"
  };
}

function cliSort(value: MarketVideoSort): string {
  if (value === "MOST_LIKED") return "最多点赞";
  if (value === "LATEST") return "最新发布";
  return "综合";
}

function cliTime(value: MarketVideoTimeRange): string {
  if (value === "DAY") return "一天内";
  if (value === "WEEK") return "一周内";
  if (value === "HALF_YEAR") return "半年内";
  return "不限";
}

function sortCandidates(
  candidates: MarketVideoCandidate[],
  sort: MarketVideoSort
): MarketVideoCandidate[] {
  const copy = [...candidates];
  if (sort === "MOST_LIKED") {
    copy.sort(
      (a, b) =>
        (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1) ||
        a.rank - b.rank
    );
  } else if (sort === "LATEST") {
    copy.sort(
      (a, b) =>
        (b.publishedAt ? Date.parse(b.publishedAt) : -1) -
          (a.publishedAt ? Date.parse(a.publishedAt) : -1) ||
        a.rank - b.rank
    );
  }
  return copy;
}

export function marketVideoCandidateWithinTimeRange(
  candidate: MarketVideoCandidate,
  timeRange: MarketVideoTimeRange,
  nowMs = Date.now()
): boolean {
  if (timeRange === "ANY") return true;
  if (!candidate.publishedAt) return false;
  const publishedMs = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(publishedMs)) return false;
  const days =
    timeRange === "DAY" ? 1 : timeRange === "WEEK" ? 7 : 182;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return publishedMs >= cutoff && publishedMs <= nowMs + 24 * 60 * 60 * 1000;
}

function blockedFromError(
  error: unknown,
  provider: string,
  queries: string[]
): MarketVideoSearchResult {
  const raw = error instanceof Error ? error.message : String(error);
  const checkedAt = new Date().toISOString();
  if (raw.includes("DOUYIN_LOGIN_REQUIRED")) {
    return {
      status: "BLOCKED",
      provider,
      code: "LOGIN_REQUIRED",
      message: "抖音竞品视频搜索需要先完成抖音账号登录。",
      requiredUserAction:
        "在本机完成 dy-cli 抖音登录后重新运行深度研究；登录仅用于正常公开搜索，不会自动发布或互动。",
      searchedQueries: queries,
      checkedAt
    };
  }
  if (raw.includes("DOUYIN_CLI_NOT_FOUND")) {
    return {
      status: "BLOCKED",
      provider,
      code: "PROVIDER_NOT_AVAILABLE",
      message: "抖音视频搜索运行时未安装或路径不可用。",
      requiredUserAction:
        "安装/恢复 dy-cli，或通过 PVS_DOUYIN_CLI_BIN 指向 dy 可执行文件后重新运行。",
      searchedQueries: queries,
      checkedAt
    };
  }
  if (raw.includes("DOUYIN_RISK_CONTROL")) {
    return {
      status: "BLOCKED",
      provider,
      code: "RISK_CONTROL",
      message: "抖音搜索触发验证码或平台风控，本轮已停止。",
      requiredUserAction:
        "在正常浏览器会话中完成人工验证后再重试；系统不会绕过验证码或风控。",
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
      "检查抖音登录状态和网络连接后重新运行；产品事实研究仍可独立继续。",
    searchedQueries: queries,
    checkedAt
  };
}

export class DouyinCliMarketVideoSearchProvider
  implements MarketVideoSearchProvider
{
  readonly id = "douyin-cli-search";
  private readonly executable: string;

  constructor(options: { executable?: string; timeoutMs?: number } = {}) {
    this.executable = options.executable?.trim() || resolveDouyinCli();
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  private readonly timeoutMs: number;

  async search(input: {
    projectId: string;
    queries: string[];
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    count: number;
  }): Promise<MarketVideoSearchResult> {
    const queries = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))].slice(0, 4);
    if (!queries.length) {
      return {
        status: "READY",
        provider: this.id,
        candidates: [],
        searchedQueries: [],
        checkedAt: new Date().toISOString(),
        note: "没有足够的产品品类信息生成抖音竞品搜索词。"
      };
    }

    const perQuery = Math.max(3, Math.min(20, Math.ceil(input.count / queries.length) + 2));
    const all: MarketVideoCandidate[] = [];
    const failures: string[] = [];
    for (const query of queries) {
      try {
        const envelope = await runDy(
          this.executable,
          [
            "search",
            query,
            "--sort",
            cliSort(input.sort),
            "--time",
            cliTime(input.timeRange),
            "--type",
            "video",
            "--count",
            String(perQuery),
            "--json-output"
          ],
          this.timeoutMs
        );
        const videos = extractVideos(envelope);
        videos.forEach((video, index) => {
          const candidate = mapCandidate(video, query, index + 1, this.id);
          if (candidate) all.push(candidate);
        });
      } catch (error) {
        const blocked = blockedFromError(error, this.id, queries);
        if (
          blocked.status === "BLOCKED" &&
          (blocked.code === "LOGIN_REQUIRED" ||
            blocked.code === "PROVIDER_NOT_AVAILABLE" ||
            blocked.code === "RISK_CONTROL")
        ) {
          return blocked;
        }
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    const deduped = new Map<string, MarketVideoCandidate>();
    for (const candidate of all) {
      const previous = deduped.get(candidate.videoId);
      if (!previous) {
        deduped.set(candidate.videoId, candidate);
        continue;
      }
      const previousLikes = previous.metrics.likes ?? -1;
      const nextLikes = candidate.metrics.likes ?? -1;
      if (nextLikes > previousLikes) deduped.set(candidate.videoId, candidate);
    }
    const timeFiltered = [...deduped.values()].filter((candidate) =>
      marketVideoCandidateWithinTimeRange(candidate, input.timeRange)
    );
    const candidates = sortCandidates(timeFiltered, input.sort).slice(
      0,
      Math.max(1, Math.min(50, input.count))
    );
    if (!candidates.length && failures.length) {
      return blockedFromError(failures[0], this.id, queries);
    }
    return {
      status: "READY",
      provider: this.id,
      candidates,
      searchedQueries: queries,
      checkedAt: new Date().toISOString(),
      ...(failures.length || timeFiltered.length !== deduped.size
        ? {
            note: [
              failures.length ? "部分搜索词失败，其余结果已保留。" : "",
              timeFiltered.length !== deduped.size
                ? "已在本地再次校验发布时间，移除不符合时间范围的候选。"
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
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DomainValidationError("竞品参考视频超过允许大小");
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

export class DouyinCliMarketVideoMediaFetcher
  implements MarketVideoMediaFetcher
{
  readonly id = "douyin-cli-download-link";
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(
    options: {
      executable?: string;
      timeoutMs?: number;
      maxBytes?: number;
    } = {}
  ) {
    this.executable = options.executable?.trim() || resolveDouyinCli();
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxBytes = options.maxBytes ?? 140 * 1024 * 1024;
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
      throw new DomainValidationError("当前 MediaFetcher 只支持抖音公开视频");
    }
    const envelope = await runDy(
      this.executable,
      ["download", input.candidate.videoId, "--json-output"],
      this.timeoutMs
    );
    const data = objectValue(envelope.data);
    const body = Object.keys(data).length ? data : envelope;
    const rawUrl = textValue(body.video_url);
    if (!rawUrl) {
      throw new DomainValidationError(
        "该抖音候选没有取得可分析的视频媒体链接"
      );
    }

    let url = await assertSafeResearchUrl(rawUrl, false);
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "video/mp4,video/*;q=0.9,*/*;q=0.1",
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
          throw new DomainValidationError("竞品视频重定向次数过多");
        }
        url = await assertSafeResearchUrl(
          new URL(response.headers.get("location")!, url).toString(),
          false
        );
        continue;
      }
      break;
    }
    if (!response?.ok) {
      throw new DomainValidationError(
        "竞品视频媒体下载失败" +
          (response ? "：HTTP " + response.status : "")
      );
    }
    const bytes = await readLimitedBytes(response, this.maxBytes);
    if (bytes.byteLength < 1024) {
      throw new DomainValidationError("竞品视频媒体内容过小，无法分析");
    }
    return {
      sourceUrl: input.candidate.url,
      originalFilename: "douyin-" + input.candidate.videoId + ".mp4",
      mimeType: "video/mp4",
      bytes
    };
  }
}
