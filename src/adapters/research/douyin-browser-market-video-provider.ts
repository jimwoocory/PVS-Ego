import "../../isolation/require-isolation.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  FetchedMarketVideo,
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

type BrowserCard = {
  href: string;
  text: string;
};

type BrowserQueryResult =
  | {
      status: "READY";
      cards?: BrowserCard[];
      rawItems?: Record<string, unknown>[];
    }
  | {
      status: "BLOCKED";
      code: "LOGIN_REQUIRED" | "RISK_CONTROL" | "PROVIDER_ERROR";
      message: string;
      requiredUserAction: string;
    };

type BrowserMediaResult =
  | {
      status: "READY";
      mediaUrl: string;
    }
  | {
      status: "BLOCKED";
      code: "LOGIN_REQUIRED" | "RISK_CONTROL" | "PROVIDER_ERROR";
      message: string;
      requiredUserAction: string;
    };

export interface DouyinBrowserSearchRuntime {
  query(input: {
    query: string;
    wantedCount: number;
  }): Promise<BrowserQueryResult>;
}

export interface DouyinBrowserMediaRuntime {
  resolveMedia(input: {
    videoId: string;
  }): Promise<BrowserMediaResult>;
}

function bridgeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bridgeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function bridgeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (
    typeof value === "string" &&
    /^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed));
    }
  }
  return undefined;
}

function bridgePublishedAt(value: unknown): string | undefined {
  const seconds = bridgeNumber(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString();
}

function mapDouyinBridgeCandidate(
  raw: Record<string, unknown>,
  query: string,
  rank: number,
  provider: string
): MarketVideoCandidate | null {
  const videoId =
    bridgeText(raw.aweme_id) ??
    (typeof raw.aweme_id === "number"
      ? String(raw.aweme_id)
      : undefined);
  if (!videoId || !/^\d{8,30}$/.test(videoId)) return null;

  const statistics = bridgeObject(raw.statistics ?? raw.stats);
  const author = bridgeObject(raw.author);
  const likes = bridgeNumber(
    statistics.digg_count ?? statistics.likes
  );
  const comments = bridgeNumber(
    statistics.comment_count ?? statistics.comments
  );
  const shares = bridgeNumber(
    statistics.share_count ?? statistics.shares
  );
  const plays = bridgeNumber(
    statistics.play_count ?? statistics.plays
  );
  const metrics = {
    ...(likes !== undefined ? { likes } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(plays !== undefined ? { plays } : {})
  };

  const published = bridgePublishedAt(raw.create_time);
  const authorName = bridgeText(author.nickname);
  const authorId = bridgeText(
    author.sec_uid ?? author.uid ?? author.unique_id
  );

  return {
    id: videoId,
    platform: "DOUYIN",
    videoId,
    url: "https://www.douyin.com/video/" + videoId,
    title:
      bridgeText(raw.desc) ?? "抖音公开视频 " + videoId,
    ...(authorName ? { authorName } : {}),
    ...(authorId ? { authorId } : {}),
    ...(published ? { publishedAt: published } : {}),
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

function extractBridgeSearchItems(
  payload: Record<string, unknown>
): Record<string, unknown>[] {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows.flatMap((row) => {
    const item = bridgeObject(row);
    const aweme = bridgeObject(item.aweme_info);
    if (Object.keys(aweme).length) return [aweme];
    return item.aweme_id ? [item] : [];
  });
}

function bridgeRequiresVerification(
  payload: Record<string, unknown>
): boolean {
  const nil = bridgeObject(payload.search_nil_info);
  const signals = [
    nil.search_nil_type,
    nil.search_nil_item,
    payload.status_msg,
    payload.message,
    payload.qc
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /verify[_\s-]?check|captcha|risk[_\s-]?control|验证码|风控/i.test(
    signals
  );
}

function mediaUrlFromBridgeItem(
  raw: Record<string, unknown>
): string | undefined {
  const video = bridgeObject(raw.video);
  const bitRates = Array.isArray(video.bit_rate)
    ? [...video.bit_rate]
        .map((item) => bridgeObject(item))
        .sort(
          (a, b) =>
            (bridgeNumber(b.bit_rate) ?? 0) -
            (bridgeNumber(a.bit_rate) ?? 0)
        )
    : [];

  for (const rate of bitRates) {
    const play = bridgeObject(rate.play_addr);
    if (!Array.isArray(play.url_list)) continue;
    const candidate = play.url_list.find(
      (value): value is string =>
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
    );
    if (candidate) return candidate;
  }

  for (const key of ["play_addr", "download_addr"]) {
    const address = bridgeObject(video[key]);
    if (!Array.isArray(address.url_list)) continue;
    const candidate = address.url_list.find(
      (value): value is string =>
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
    );
    if (candidate) return candidate;
  }
  return undefined;
}

function parseCountToken(value: string): number | undefined {
  const normalized = value.trim().replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(万|亿|[wW])?$/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2];
  if (unit === "万" || unit === "w" || unit === "W") {
    return Math.round(base * 10_000);
  }
  if (unit === "亿") return Math.round(base * 100_000_000);
  return Math.round(base);
}

function relativePublishedAt(value: string, nowMs = Date.now()): string | undefined {
  const text = value.trim();
  let deltaMs: number | undefined;
  let match = text.match(/^(\d+)分钟前$/);
  if (match) deltaMs = Number(match[1]) * 60_000;
  match = text.match(/^(\d+)小时前$/);
  if (match) deltaMs = Number(match[1]) * 60 * 60_000;
  match = text.match(/^(\d+)天前$/);
  if (match) deltaMs = Number(match[1]) * 24 * 60 * 60_000;
  match = text.match(/^(\d+)周前$/);
  if (match) deltaMs = Number(match[1]) * 7 * 24 * 60 * 60_000;
  match = text.match(/^(\d+)个月前$/);
  if (match) deltaMs = Number(match[1]) * 30 * 24 * 60 * 60_000;
  if (text === "刚刚") deltaMs = 0;
  if (text === "昨天") deltaMs = 24 * 60 * 60_000;
  if (deltaMs === undefined) return undefined;
  return new Date(nowMs - deltaMs).toISOString();
}

export function parseDouyinBrowserCard(
  card: BrowserCard,
  query: string,
  rank: number,
  provider = "douyin-browser-search",
  nowMs = Date.now()
): MarketVideoCandidate | null {
  const idMatch = card.href.match(/\/video\/(\d{8,30})(?:[/?#]|$)/);
  if (!idMatch) return null;
  const videoId = idMatch[1]!;
  const lines = card.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const authorIndex = lines.findIndex((line) => line.startsWith("@"));
  const durationIndex = lines.findIndex((line) =>
    /^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)
  );
  let likesIndex = -1;
  if (durationIndex >= 0) {
    for (let index = durationIndex + 1; index < lines.length; index += 1) {
      if (parseCountToken(lines[index]!) !== undefined) {
        likesIndex = index;
        break;
      }
      if (authorIndex >= 0 && index >= authorIndex) break;
    }
  }
  const likes =
    likesIndex >= 0 ? parseCountToken(lines[likesIndex]!) : undefined;
  const titleStart = likesIndex >= 0 ? likesIndex + 1 : durationIndex + 1;
  const titleEnd = authorIndex >= 0 ? authorIndex : lines.length;
  const title = lines
    .slice(Math.max(0, titleStart), Math.max(titleStart, titleEnd))
    .filter((line) => line !== "合集")
    .join(" ")
    .trim();
  const authorName =
    authorIndex >= 0 ? lines[authorIndex]!.replace(/^@/, "").trim() : undefined;
  const publishedText =
    authorIndex >= 0 && lines[authorIndex + 1]
      ? lines[authorIndex + 1]!
      : undefined;
  const publishedAt = publishedText
    ? relativePublishedAt(publishedText, nowMs)
    : undefined;
  const metrics = likes !== undefined ? { likes } : {};

  return {
    id: videoId,
    platform: "DOUYIN",
    videoId,
    url: "https://www.douyin.com/video/" + videoId,
    title: title || "抖音公开视频 " + videoId,
    ...(authorName ? { authorName } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    query,
    rank,
    metrics,
    metricsAvailability:
      likes !== undefined ? "PLATFORM_PUBLIC" : "UNAVAILABLE",
    sourceProvider: provider,
    status: "DISCOVERED"
  };
}

function inTimeRange(
  candidate: MarketVideoCandidate,
  range: MarketVideoTimeRange,
  nowMs = Date.now()
): boolean {
  if (range === "ANY") return true;
  if (!candidate.publishedAt) return false;
  const value = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(value)) return false;
  const days = range === "DAY" ? 1 : range === "WEEK" ? 7 : 182;
  return value >= nowMs - days * 24 * 60 * 60_000;
}

function sortCandidates(
  candidates: MarketVideoCandidate[],
  sort: MarketVideoSort
): MarketVideoCandidate[] {
  const result = [...candidates];
  if (sort === "MOST_LIKED") {
    result.sort(
      (a, b) =>
        (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1) ||
        a.rank - b.rank
    );
  } else if (sort === "LATEST") {
    result.sort(
      (a, b) =>
        (b.publishedAt ? Date.parse(b.publishedAt) : -1) -
          (a.publishedAt ? Date.parse(a.publishedAt) : -1) ||
        a.rank - b.rank
    );
  }
  return result;
}

async function copyFileIfPossible(source: string, target: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } catch {
    // Live Chrome may lock optional files. The browser fallback only needs the
    // stable local profile state; current login cookies are injected separately.
  }
}

async function robocopyDirectory(source: string, target: string): Promise<void> {
  if (!fsSync.existsSync(source)) return;
  await fs.mkdir(target, { recursive: true });
  try {
    await execFileAsync(
      "robocopy.exe",
      [
        source,
        target,
        "/E",
        "/R:1",
        "/W:1",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        "/XF",
        "LOCK",
        "LOG",
        "Cookies",
        "Cookies-journal"
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024
      }
    );
  } catch (error) {
    const code = Number(
      (error as { code?: number | string }).code ?? 16
    );
    if (!Number.isFinite(code) || code > 7) throw error;
  }
}

export class SystemChromeDouyinSearchRuntime
  implements DouyinBrowserSearchRuntime, DouyinBrowserMediaRuntime
{
  private readonly userDataRoot: string;
  private readonly sourceProfileName: string;
  private readonly profileRoot: string;
  private readonly debugPort: number;
  private readonly browserExecutable: string;
  private readonly browserLabel: "Microsoft Edge" | "Google Chrome";
  private browserProcess?: ChildProcess;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: {
    userDataRoot?: string;
    sourceProfileName?: string;
    profileRoot?: string;
    debugPort?: number;
    browserExecutable?: string;
    chromeExecutable?: string;
  } = {}) {
    const configuredExecutable =
      options.browserExecutable ??
      options.chromeExecutable ??
      process.env.PVS_DOUYIN_RESEARCH_BROWSER_BIN?.trim();
    const edgeExecutable =
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const chromeExecutable =
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const executable =
      configuredExecutable ||
      (fsSync.existsSync(edgeExecutable)
        ? edgeExecutable
        : chromeExecutable);
    const useEdge = /(?:^|[\\/])msedge\.exe$/i.test(executable);
    this.browserExecutable = executable;
    this.browserLabel = useEdge ? "Microsoft Edge" : "Google Chrome";
    this.userDataRoot =
      options.userDataRoot ??
      process.env.PVS_DOUYIN_BROWSER_USER_DATA_ROOT?.trim() ??
      path.join(
        process.env.LOCALAPPDATA ?? "",
        useEdge ? "Microsoft" : "Google",
        useEdge ? "Edge" : "Chrome",
        "User Data"
      );
    this.sourceProfileName =
      options.sourceProfileName ??
      process.env.PVS_DOUYIN_BROWSER_SOURCE_PROFILE?.trim() ??
      (useEdge ? "Default" : "Profile 3");
    this.profileRoot =
      options.profileRoot ??
      process.env.PVS_DOUYIN_BROWSER_FALLBACK_PROFILE?.trim() ??
      path.resolve(
        process.cwd(),
        "..",
        useEdge
          ? "douyin-browser-fallback-edge-v1"
          : "douyin-browser-fallback-chrome-v1"
      );
    this.debugPort =
      options.debugPort ??
      Number(process.env.PVS_DOUYIN_BROWSER_FALLBACK_PORT ?? "9230");
  }

  private profileDirectory(): string {
    return path.join(this.profileRoot, this.sourceProfileName);
  }

  private async ensureProfile(): Promise<void> {
    const profileDir = this.profileDirectory();
    if (
      fsSync.existsSync(path.join(profileDir, "Preferences")) &&
      fsSync.existsSync(path.join(this.profileRoot, "Local State"))
    ) {
      return;
    }
    const sourceProfile = path.join(
      this.userDataRoot,
      this.sourceProfileName
    );
    if (
      !fsSync.existsSync(sourceProfile) ||
      !fsSync.existsSync(path.join(this.userDataRoot, "Local State"))
    ) {
      throw new Error(
        "找不到用于抖音网页研究的 " +
          this.browserLabel +
          " " +
          this.sourceProfileName +
          " 会话。"
      );
    }
    await fs.mkdir(profileDir, { recursive: true });
    await copyFileIfPossible(
      path.join(this.userDataRoot, "Local State"),
      path.join(this.profileRoot, "Local State")
    );
    for (const file of [
      "Preferences",
      "Secure Preferences",
      "Web Data",
      "History",
      "Login Data"
    ]) {
      await copyFileIfPossible(
        path.join(sourceProfile, file),
        path.join(profileDir, file)
      );
    }
    for (const directory of [
      "Network",
      "Local Storage",
      "Session Storage",
      "IndexedDB",
      "Storage",
      "Service Worker"
    ]) {
      await robocopyDirectory(
        path.join(sourceProfile, directory),
        path.join(profileDir, directory)
      );
    }
  }

  private async waitForCdp(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + this.debugPort + "/json/version",
          { signal: AbortSignal.timeout(800) }
        );
        if (response.ok) return;
      } catch {
        // retry below
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("抖音网页搜索浏览器启动失败：CDP 未就绪");
  }

  private async launch(): Promise<void> {
    if (!fsSync.existsSync(this.browserExecutable)) {
      throw new Error("未找到可用的 Microsoft Edge 或 Google Chrome");
    }
    await this.ensureProfile();
    this.browserProcess = spawn(
      this.browserExecutable,
      [
        `--user-data-dir=${this.profileRoot}`,
        `--profile-directory=${this.sourceProfileName}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${this.debugPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-sync",
        "--no-service-autorun",
        "--disable-backgrounding-occluded-windows",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--window-position=-32000,-32000",
        "--window-size=1280,900",
        "about:blank"
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }
    );
    this.browserProcess.unref();
    await this.waitForCdp();
  }

  private async ensureBrowser(): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }> {
    if (
      this.browser?.isConnected() &&
      this.context &&
      this.page &&
      !this.page.isClosed()
    ) {
      return {
        browser: this.browser,
        context: this.context,
        page: this.page
      };
    }
    try {
      const response = await fetch(
        "http://127.0.0.1:" + this.debugPort + "/json/version",
        { signal: AbortSignal.timeout(800) }
      );
      if (!response.ok) await this.launch();
    } catch {
      await this.launch();
    }
    const endpoint = "http://127.0.0.1:" + this.debugPort;
    try {
      this.browser = await chromium.connectOverCDP(endpoint, {
        timeout: 60_000
      });
    } catch (firstError) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        this.browser = await chromium.connectOverCDP(endpoint, {
          timeout: 60_000
        });
      } catch (secondError) {
        const firstMessage =
          firstError instanceof Error
            ? firstError.message
            : String(firstError);
        const secondMessage =
          secondError instanceof Error
            ? secondError.message
            : String(secondError);
        throw new Error(
          "抖音网页搜索浏览器 CDP 连接失败。" +
            " first=" +
            firstMessage.slice(0, 280) +
            "；retry=" +
            secondMessage.slice(0, 280)
        );
      }
    }
    this.browser.on("disconnected", () => {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.browserProcess = undefined;
    });
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error("浏览器上下文不存在");
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return {
      browser: this.browser,
      context: this.context,
      page: this.page
    };
  }

  private async addCurrentCookies(context: BrowserContext): Promise<number> {
    const currentCookies = await context.cookies(
      "https://www.douyin.com/"
    );
    const sessionCookieNames = new Set([
      "sessionid",
      "sessionid_ss",
      "sid_tt",
      "uid_tt",
      "uid_tt_ss"
    ]);
    if (
      currentCookies.some(
        (cookie) =>
          sessionCookieNames.has(cookie.name) &&
          Boolean(cookie.value)
      )
    ) {
      return 0;
    }
    const cookieFile = path.join(
      os.homedir(),
      ".dy",
      "cookies",
      "default.json"
    );
    const raw = JSON.parse(await fs.readFile(cookieFile, "utf8")) as {
      cookies?: Array<Record<string, unknown>>;
    };
    const cookies = (raw.cookies ?? [])
      .filter(
        (cookie) =>
          typeof cookie.name === "string" &&
          typeof cookie.value === "string" &&
          typeof cookie.domain === "string" &&
          cookie.domain.includes("douyin")
      )
      .map((cookie) => ({
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain),
        path:
          typeof cookie.path === "string" && cookie.path
            ? cookie.path
            : "/",
        ...(typeof cookie.expires === "number" && cookie.expires > 0
          ? { expires: cookie.expires }
          : {}),
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        ...(cookie.sameSite === "Strict" ||
        cookie.sameSite === "Lax" ||
        cookie.sameSite === "None"
          ? {
              sameSite: cookie.sameSite as
                | "Strict"
                | "Lax"
                | "None"
            }
          : {})
      }));
    if (!cookies.length) throw new Error("抖音登录 Cookie 不存在");
    await context.addCookies(cookies);
    return cookies.length;
  }

  private async waitForCards(page: Page): Promise<BrowserQueryResult> {
    for (let attempt = 0; attempt < 28; attempt += 1) {
      if ((await page.locator('a[href*="/video/"]').count()) > 0) {
        break;
      }
      const title = await page.title().catch(() => "");
      const body = await page.locator("body").innerText().catch(() => "");
      if (
        /验证码中间页|验证中心|完成验证|滑块|captcha/i.test(
          title + " " + body
        )
      ) {
        return {
          status: "BLOCKED",
          code: "RISK_CONTROL",
          message: "抖音网页搜索也触发了平台验证或风控。",
          requiredUserAction:
            "在正常抖音浏览器中完成人工验证后稍后重试；系统不会绕过验证码。"
        };
      }
      if (/登录后即可搜索|扫码登录|验证码登录/.test(body)) {
        return {
          status: "BLOCKED",
          code: "LOGIN_REQUIRED",
          message: "抖音网页搜索 fallback 当前没有有效登录态。",
          requiredUserAction:
            "先完成抖音账号登录，再重新运行研究。"
        };
      }
      await page.waitForTimeout(350);
    }

    for (let round = 0; round < 3; round += 1) {
      if ((await page.locator('a[href*="/video/"]').count()) >= 24) break;
      await page.evaluate(
        "window.scrollTo(0, document.body.scrollHeight)"
      );
      await page.waitForTimeout(700);
    }
    const cards = await page
      .locator('a[href*="/video/"]')
      .evaluateAll((anchors: any[]) =>
        anchors.map((anchor) => ({
          href: anchor.href,
          text: (
            anchor.innerText ||
            anchor.textContent ||
            ""
          )
            .trim()
            .slice(0, 2000)
        }))
      );
    if (!cards.length) {
      return {
        status: "BLOCKED",
        code: "RISK_CONTROL",
        message:
          "抖音网页搜索没有返回可读的视频候选，当前搜索会话可能仍受平台限制。",
        requiredUserAction:
          "稍后重试抖音网页搜索；其他联网研究可以继续。"
      };
    }
    return { status: "READY", cards };
  }

  private async queryInner(input: {
    query: string;
    wantedCount: number;
  }): Promise<BrowserQueryResult> {
    try {
      const { context, page } = await this.ensureBrowser();
      await this.addCurrentCookies(context);
      await page.goto(
        "https://www.douyin.com/search/" +
          encodeURIComponent(input.query) +
          "?type=video",
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        }
      );
      let result = await this.waitForCards(page);
      if (
        result.status === "BLOCKED" &&
        result.code === "RISK_CONTROL" &&
        result.message.includes("没有返回可读的视频候选")
      ) {
        await page.waitForTimeout(1800);
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        result = await this.waitForCards(page);
      }
      return result;
    } catch (error) {
      return {
        status: "BLOCKED",
        code: "PROVIDER_ERROR",
        message:
          "抖音网页搜索 fallback 执行失败：" +
          (error instanceof Error ? error.message : String(error)),
        requiredUserAction:
          "检查系统 " + this.browserLabel + " 与抖音登录状态后稍后重试。"
      };
    }
  }



  private async resolveMediaInner(input: {
    videoId: string;
  }): Promise<BrowserMediaResult> {
    try {
      const { context, page } = await this.ensureBrowser();
      await this.addCurrentCookies(context);
      await page.goto(
        "https://www.douyin.com/video/" + input.videoId,
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        }
      );
      await page.waitForTimeout(800);
      const detail = await page.evaluate(
        async (videoId: string) => {
          const nav = navigator as Navigator & {
            connection?: {
              downlink?: number;
              effectiveType?: string;
              rtt?: number;
            };
            deviceMemory?: number;
          };
          const connection = nav.connection ?? {};
          const viewport = (globalThis as any).screen ?? {
            width: 1280,
            height: 900
          };
          const ua = nav.userAgent;
          const versionMatch = ua.match(
            /(?:Chrome|Edg)\/(\d+\.\d+\.\d+\.\d+)/
          );
          const browserVersion =
            versionMatch?.[1] ?? "154.0.0.0";
          const params = new URLSearchParams({
            device_platform: "webapp",
            aid: "6383",
            channel: "channel_pc_web",
            pc_client_type: "1",
            pc_libra_divert: "Windows",
            update_version_code: "170400",
            support_h265: "1",
            support_dash: "1",
            version_code: "170400",
            version_name: "17.4.0",
            cookie_enabled: "true",
            screen_width: String(viewport.width ?? 1280),
            screen_height: String(viewport.height ?? 900),
            browser_language: nav.language || "zh-CN",
            browser_platform: "Win32",
            browser_name: "Chrome",
            browser_version: browserVersion,
            browser_online: "true",
            engine_name: "Blink",
            engine_version: browserVersion,
            os_name: "Windows",
            os_version: "10",
            cpu_core_num: String(nav.hardwareConcurrency || 12),
            device_memory: String(nav.deviceMemory || 16),
            platform: "PC",
            downlink: String(connection.downlink || 10),
            effective_type: connection.effectiveType || "4g",
            round_trip_time: String(connection.rtt || 100),
            aweme_id: videoId
          });
          const response = await fetch(
            "/aweme/v1/web/aweme/detail/?" + params.toString(),
            { credentials: "include" }
          );
          const text = await response.text();
          let payload: any;
          try {
            payload = JSON.parse(text);
          } catch {
            return {
              ok: false,
              httpStatus: response.status,
              statusCode: undefined,
              mediaUrl: undefined
            };
          }
          const item = payload?.aweme_detail;
          if (!item) {
            return {
              ok: false,
              httpStatus: response.status,
              statusCode: payload?.status_code,
              mediaUrl: undefined
            };
          }
          const bitRates = Array.isArray(item.video?.bit_rate)
            ? [...item.video.bit_rate].sort(
                (a: any, b: any) =>
                  Number(b?.bit_rate ?? 0) -
                  Number(a?.bit_rate ?? 0)
              )
            : [];
          const mediaUrl =
            bitRates
              .flatMap((item: any) =>
                Array.isArray(item?.play_addr?.url_list)
                  ? item.play_addr.url_list
                  : []
              )
              .find((value: unknown) => typeof value === "string") ??
            item.video?.play_addr?.url_list?.[0] ??
            item.video?.download_addr?.url_list?.[0];
          return {
            ok: Boolean(mediaUrl),
            httpStatus: response.status,
            statusCode: payload?.status_code,
            mediaUrl:
              typeof mediaUrl === "string" ? mediaUrl : undefined
          };
        },
        input.videoId
      );

      if (detail.ok && detail.mediaUrl) {
        return {
          status: "READY",
          mediaUrl: detail.mediaUrl
        };
      }

      const title = await page.title().catch(() => "");
      const body = await page.locator("body").innerText().catch(() => "");
      if (
        /验证码中间页|验证中心|完成验证|滑块|captcha/i.test(
          title + " " + body
        )
      ) {
        return {
          status: "BLOCKED",
          code: "RISK_CONTROL",
          message: "抖音网页视频详情触发平台验证或风控。",
          requiredUserAction:
            "在正常抖音浏览器中完成人工验证后稍后重试；系统不会绕过验证码。"
        };
      }
      if (/登录后即可|扫码登录|验证码登录/.test(body)) {
        return {
          status: "BLOCKED",
          code: "LOGIN_REQUIRED",
          message: "抖音网页视频详情当前没有有效登录态。",
          requiredUserAction:
            "先完成抖音账号登录，再重新获取竞品视频。"
        };
      }
      return {
        status: "BLOCKED",
        code: "PROVIDER_ERROR",
        message:
          "抖音网页视频详情没有返回可下载的媒体地址。",
        requiredUserAction:
          "稍后重试该视频，或选择另一条公开候选。"
      };
    } catch (error) {
      return {
        status: "BLOCKED",
        code: "PROVIDER_ERROR",
        message:
          "抖音网页媒体 fallback 执行失败：" +
          (error instanceof Error ? error.message : String(error)),
        requiredUserAction:
          "检查系统 " + this.browserLabel + " 与抖音登录状态后稍后重试。"
      };
    }
  }

  async resolveMedia(input: {
    videoId: string;
  }): Promise<BrowserMediaResult> {
    let result!: BrowserMediaResult;
    const run = this.queue.then(
      async () => {
        result = await this.resolveMediaInner(input);
      },
      async () => {
        result = await this.resolveMediaInner(input);
      }
    );
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    await run;
    return result;
  }

  async query(input: {
    query: string;
    wantedCount: number;
  }): Promise<BrowserQueryResult> {
    const run = this.queue.then(
      () => this.queryInner(input),
      () => this.queryInner(input)
    );
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    const pid = this.browserProcess?.pid;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.browserProcess = undefined;
    if (browser?.isConnected()) {
      await browser.close().catch(() => undefined);
    }
    if (pid) {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 }
      ).catch(() => undefined);
    }
  }
}

type DouyinBridgeResolvedConfig = {
  endpoint: string;
  token: string;
};

function resolveDouyinBridgeConfig(
  explicit?: {
    endpoint?: string;
    token?: string;
    configPath?: string;
  }
): DouyinBridgeResolvedConfig {
  if (explicit?.endpoint && explicit.token) {
    const endpoint = new URL(explicit.endpoint);
    if (!["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
      throw new Error("抖音浏览器 Bridge 只允许连接本机地址");
    }
    return {
      endpoint: endpoint.toString().replace(/\/$/, ""),
      token: explicit.token
    };
  }

  const userProfile = process.env.USERPROFILE ?? "";
  const configPath =
    explicit?.configPath ??
    process.env.PVS_DOUYIN_BROWSER_BRIDGE_CONFIG?.trim() ??
    path.join(
      userProfile,
      "AgentDock",
      "douyin-cli",
      "config.json"
    );
  if (!fsSync.existsSync(configPath)) {
    throw new Error("未找到抖音浏览器 Bridge 配置");
  }
  const parsed = JSON.parse(
    fsSync.readFileSync(configPath, "utf8")
  ) as {
    bridge?: {
      host?: string;
      port?: number;
      token?: string;
    };
  };
  const host = parsed.bridge?.host?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("抖音浏览器 Bridge 只允许连接本机地址");
  }
  const port = Number(parsed.bridge?.port ?? 19422);
  const token = parsed.bridge?.token?.trim() || "";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token
  ) {
    throw new Error("抖音浏览器 Bridge 配置无效");
  }
  return {
    endpoint: "http://" + host + ":" + port,
    token
  };
}

export class DouyinBrowserBridgeRuntime
  implements DouyinBrowserSearchRuntime, DouyinBrowserMediaRuntime
{
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly freshnessMs: number;
  private readonly explicit?: {
    endpoint?: string;
    token?: string;
    configPath?: string;
  };
  private readonly mediaCache = new Map<string, string>();

  constructor(
    options: {
      endpoint?: string;
      token?: string;
      configPath?: string;
      fetcher?: typeof fetch;
      timeoutMs?: number;
      freshnessMs?: number;
    } = {}
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.freshnessMs = options.freshnessMs ?? 70_000;
    this.explicit = {
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.token ? { token: options.token } : {}),
      ...(options.configPath
        ? { configPath: options.configPath }
        : {})
    };
  }

  private config(): DouyinBridgeResolvedConfig {
    return resolveDouyinBridgeConfig(this.explicit);
  }

  private async fetchJson(
    url: string,
    init: RequestInit = {}
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs
    );
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          "抖音浏览器 Bridge 返回了无法解析的数据"
        );
      }
      const record = bridgeObject(body);
      if (!response.ok || record.ok === false) {
        const message =
          bridgeText(record.error) ??
          "HTTP " + response.status;
        throw new Error(message);
      }
      return record;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureFreshConnection(): Promise<DouyinBridgeResolvedConfig> {
    const config = this.config();
    const status = await this.fetchJson(
      config.endpoint + "/api/status"
    );
    const connections = bridgeObject(status.connections);
    const rows = Array.isArray(connections["douyin.com"])
      ? (connections["douyin.com"] as unknown[])
      : [];
    const now = Date.now();
    const active = rows.some((raw) => {
      const item = bridgeObject(raw);
      if (item.alive === false) return false;
      const lastActivity = bridgeText(item.lastActivity);
      if (!lastActivity) return false;
      const value = Date.parse(lastActivity);
      return (
        Number.isFinite(value) &&
        now - value >= -5_000 &&
        now - value <= this.freshnessMs
      );
    });
    if (!active) {
      throw new Error(
        "PVS_DOUYIN_BROWSER_BRIDGE_NOT_CONNECTED"
      );
    }
    return config;
  }

  private async call(
    expression: string
  ): Promise<Record<string, unknown>> {
    const config = await this.ensureFreshConnection();
    const body = await this.fetchJson(
      config.endpoint + "/api/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + config.token
        },
        body: JSON.stringify({
          site: "douyin.com",
          expression,
          awaitPromise: true,
          timeout: Math.min(this.timeoutMs, 30_000)
        })
      }
    );
    return bridgeObject(body.value);
  }

  async query(input: {
    query: string;
    wantedCount: number;
  }): Promise<BrowserQueryResult> {
    try {
      const payload = await this.call(
        "PVS_SEARCH:" +
          JSON.stringify({
            keyword: input.query,
            offset: 0,
            count: Math.max(
              1,
              Math.min(20, input.wantedCount)
            )
          })
      );
      if (bridgeRequiresVerification(payload)) {
        return {
          status: "BLOCKED",
          code: "RISK_CONTROL",
          message:
            "正常 Edge 抖音网页搜索也触发了平台验证或风控。",
          requiredUserAction:
            "在当前 Edge 抖音页面按平台提示完成人工验证后再试；系统不会绕过验证码。"
        };
      }
      const statusCode = bridgeNumber(payload.status_code);
      if (statusCode !== undefined && statusCode !== 0) {
        return {
          status: "BLOCKED",
          code: "PROVIDER_ERROR",
          message:
            "抖音浏览器搜索返回异常状态 " +
            statusCode,
          requiredUserAction:
            "刷新当前 Edge 抖音页面后重新运行研究。"
        };
      }
      const rawItems = extractBridgeSearchItems(payload);
      for (const item of rawItems) {
        const videoId =
          bridgeText(item.aweme_id) ??
          (typeof item.aweme_id === "number"
            ? String(item.aweme_id)
            : undefined);
        const mediaUrl = mediaUrlFromBridgeItem(item);
        if (videoId && mediaUrl) {
          this.mediaCache.set(videoId, mediaUrl);
        }
      }
      return {
        status: "READY",
        rawItems
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      if (
        /login|未登录|登录后即可|扫码登录/i.test(message)
      ) {
        return {
          status: "BLOCKED",
          code: "LOGIN_REQUIRED",
          message:
            "Edge 抖音网页研究会话当前没有有效登录态。",
          requiredUserAction:
            "请在当前 Edge 抖音页面正常登录后重新运行研究。"
        };
      }
      return {
        status: "BLOCKED",
        code: "PROVIDER_ERROR",
        message: message.includes(
          "PVS_DOUYIN_BROWSER_BRIDGE_NOT_CONNECTED"
        )
          ? "抖音网页研究 Bridge 尚未连接到当前 Edge 抖音页面。"
          : "抖音网页研究 Bridge 搜索失败：" +
            message.slice(0, 320),
        requiredUserAction:
          "在 Product Video Studio 中打开/启用 Edge 抖音网页研究会话后重试。"
      };
    }
  }

  async resolveMedia(input: {
    videoId: string;
  }): Promise<BrowserMediaResult> {
    const cached = this.mediaCache.get(input.videoId);
    if (cached) {
      return {
        status: "READY",
        mediaUrl: cached
      };
    }

    try {
      const payload = await this.call(
        "PVS_DETAIL:" +
          JSON.stringify({ videoId: input.videoId })
      );
      if (bridgeRequiresVerification(payload)) {
        return {
          status: "BLOCKED",
          code: "RISK_CONTROL",
          message:
            "正常 Edge 抖音视频详情触发了平台验证或风控。",
          requiredUserAction:
            "在当前 Edge 抖音页面按平台提示完成人工验证后再试。"
        };
      }
      const item = bridgeObject(
        payload.aweme_detail ?? payload.item
      );
      const mediaUrl = mediaUrlFromBridgeItem(item);
      if (!mediaUrl) {
        return {
          status: "BLOCKED",
          code: "PROVIDER_ERROR",
          message:
            "抖音网页详情没有返回可下载的视频地址。",
          requiredUserAction:
            "稍后重试该候选，或选择另一条公开视频。"
        };
      }
      this.mediaCache.set(input.videoId, mediaUrl);
      return {
        status: "READY",
        mediaUrl
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      return {
        status: "BLOCKED",
        code: "PROVIDER_ERROR",
        message:
          "抖音网页研究 Bridge 获取视频详情失败：" +
          message.slice(0, 320),
        requiredUserAction:
          "确认 Edge 抖音网页研究会话在线后重试。"
      };
    }
  }
}

export class DouyinBrowserMarketVideoSearchProvider
  implements MarketVideoSearchProvider
{
  readonly id: string;

  constructor(
    private readonly runtime: DouyinBrowserSearchRuntime =
      new SystemChromeDouyinSearchRuntime(),
    id = "douyin-browser-search"
  ) {
    this.id = id;
  }

  async search(input: {
    projectId: string;
    queries: string[];
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    count: number;
  }): Promise<MarketVideoSearchResult> {
    const queries = input.queries
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, 8);
    const all: MarketVideoCandidate[] = [];
    const wantedPerQuery = Math.max(
      8,
      Math.ceil(input.count / Math.max(1, queries.length)) * 2
    );

    for (const query of queries) {
      const result = await this.runtime.query({
        query,
        wantedCount: wantedPerQuery
      });
      if (result.status === "BLOCKED") {
        return {
          status: "BLOCKED",
          provider: this.id,
          code: result.code,
          message: result.message,
          requiredUserAction: result.requiredUserAction,
          searchedQueries: queries,
          checkedAt: new Date().toISOString()
        };
      }
      const seen = new Set<string>();
      let rank = 1;
      for (const raw of result.rawItems ?? []) {
        const candidate = mapDouyinBridgeCandidate(
          raw,
          query,
          rank,
          this.id
        );
        rank += 1;
        if (!candidate || seen.has(candidate.videoId)) continue;
        seen.add(candidate.videoId);
        all.push(candidate);
      }
      for (const card of result.cards ?? []) {
        const candidate = parseDouyinBrowserCard(
          card,
          query,
          rank,
          this.id
        );
        rank += 1;
        if (!candidate || seen.has(candidate.videoId)) continue;
        seen.add(candidate.videoId);
        all.push(candidate);
      }
    }

    const deduped = new Map<string, MarketVideoCandidate>();
    for (const candidate of all) {
      const existing = deduped.get(candidate.videoId);
      if (
        !existing ||
        (candidate.metrics.likes ?? -1) >
          (existing.metrics.likes ?? -1)
      ) {
        deduped.set(candidate.videoId, candidate);
      }
    }

    const filtered = [...deduped.values()].filter((candidate) =>
      inTimeRange(candidate, input.timeRange)
    );
    const candidates = sortCandidates(filtered, input.sort).slice(
      0,
      input.count
    );

    return {
      status: "READY",
      provider: this.id,
      candidates,
      searchedQueries: queries,
      checkedAt: new Date().toISOString(),
      note:
        "dy-cli 搜索受限时自动切换到真实 Edge / Chrome 抖音网页搜索；候选按页面公开点赞数在本地排序。"
    };
  }
}



export class DouyinBrowserBridgeMarketVideoSearchProvider
  extends DouyinBrowserMarketVideoSearchProvider
{
  constructor(
    runtime: DouyinBrowserSearchRuntime =
      new DouyinBrowserBridgeRuntime()
  ) {
    super(runtime, "douyin-browser-bridge-search");
  }
}

async function readLimitedBrowserMediaBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DomainValidationError("竞品视频媒体文件超过允许大小");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DomainValidationError("竞品视频媒体文件超过允许大小");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class DouyinBrowserMarketVideoMediaFetcher
  implements MarketVideoMediaFetcher
{
  readonly id = "douyin-browser-media";
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly runtime: DouyinBrowserMediaRuntime =
      new SystemChromeDouyinSearchRuntime(),
    options: {
      timeoutMs?: number;
      maxBytes?: number;
      fetcher?: typeof fetch;
    } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxBytes = options.maxBytes ?? 140 * 1024 * 1024;
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetch(input: {
    projectId: string;
    candidate: MarketVideoCandidate;
  }): Promise<FetchedMarketVideo> {
    if (input.candidate.platform !== "DOUYIN") {
      throw new DomainValidationError(
        "当前浏览器 MediaFetcher 只支持抖音公开视频"
      );
    }

    const resolved = await this.runtime.resolveMedia({
      videoId: input.candidate.videoId
    });
    if (resolved.status === "BLOCKED") {
      throw new DomainValidationError(resolved.message);
    }

    let url = await assertSafeResearchUrl(
      resolved.mediaUrl,
      false
    );
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 4; redirect += 1) {
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
            accept: "video/mp4,video/*;q=0.9,*/*;q=0.1",
            "accept-language": "zh-CN,zh;q=0.9",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/154.0.0.0 Safari/537.36",
            referer: input.candidate.url
          }
        });
      } finally {
        clearTimeout(timer);
      }
      const location = response.headers.get("location");
      if (
        response.status >= 300 &&
        response.status < 400 &&
        location
      ) {
        if (redirect >= 4) {
          throw new DomainValidationError(
            "竞品视频重定向次数过多"
          );
        }
        url = await assertSafeResearchUrl(
          new URL(location, url).toString(),
          false
        );
        continue;
      }
      break;
    }

    if (!response?.ok) {
      throw new DomainValidationError(
        "浏览器竞品视频媒体下载失败" +
          (response ? "：HTTP " + response.status : "")
      );
    }
    const bytes = await readLimitedBrowserMediaBytes(
      response,
      this.maxBytes
    );
    if (bytes.byteLength < 1024) {
      throw new DomainValidationError(
        "浏览器竞品视频媒体内容过小，无法分析"
      );
    }
    return {
      sourceUrl: input.candidate.url,
      originalFilename:
        "douyin-" + input.candidate.videoId + ".mp4",
      mimeType: "video/mp4",
      bytes
    };
  }
}

export class FallbackMarketVideoMediaFetcher
  implements MarketVideoMediaFetcher
{
  readonly id = "douyin-resilient-media";

  constructor(
    private readonly primary: MarketVideoMediaFetcher,
    private readonly fallback: MarketVideoMediaFetcher
  ) {}

  async fetch(input: {
    projectId: string;
    candidate: MarketVideoCandidate;
  }): Promise<FetchedMarketVideo> {
    try {
      return await this.primary.fetch(input);
    } catch (primaryError) {
      try {
        return await this.fallback.fetch(input);
      } catch (fallbackError) {
        const primaryMessage =
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError);
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        throw new DomainValidationError(
          "dy-cli 下载失败，浏览器媒体 fallback 也未成功。" +
            " dy-cli: " +
            primaryMessage.slice(0, 260) +
            "；browser: " +
            fallbackMessage.slice(0, 260)
        );
      }
    }
  }
}

export class FallbackMarketVideoSearchProvider
  implements MarketVideoSearchProvider
{
  readonly id = "douyin-resilient-search";

  constructor(
    private readonly primary: MarketVideoSearchProvider,
    private readonly fallback: MarketVideoSearchProvider
  ) {}

  async search(input: {
    projectId: string;
    queries: string[];
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    count: number;
  }): Promise<MarketVideoSearchResult> {
    const primary = await this.primary.search(input);
    if (
      primary.status === "READY" ||
      primary.code !== "RISK_CONTROL"
    ) {
      return primary;
    }

    const fallback = await this.fallback.search(input);
    if (fallback.status === "READY") {
      return {
        ...fallback,
        note:
          "dy-cli 返回 verify_check / RISK_CONTROL，已自动切换到真实浏览器网页搜索。" +
          (fallback.note ? " " + fallback.note : "")
      };
    }
    return {
      ...fallback,
      message:
        "dy-cli 搜索受到平台风控；浏览器网页 fallback 也未能取得候选。" +
        " " +
        fallback.message
    };
  }
}
