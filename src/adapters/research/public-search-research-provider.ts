import "../../isolation/require-isolation.js";
import type {
  BrowserResearchProvider,
  BrowserResearchResult,
  WebResearchSource
} from "../../application/ports/research-provider.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

type SearchResultCandidate = {
  url: string;
  title?: string;
  snippet?: string;
  rank: number;
};

export function normalizeResultUrl(raw: string, engine: "bing" | "duck"): string | null {
  let value = decodeHtml(raw.trim());
  try {
    if (engine === "duck") {
      const redirect = new URL(value, "https://html.duckduckgo.com");
      const nested = redirect.searchParams.get("uddg");
      if (nested) value = nested;
    } else {
      const redirect = new URL(value, "https://www.bing.com");
      if (
        redirect.hostname.toLowerCase().endsWith("bing.com") &&
        redirect.pathname.startsWith("/ck/")
      ) {
        const encoded = redirect.searchParams.get("u");
        if (encoded?.startsWith("a1")) {
          try {
            const decoded = Buffer.from(
              encoded.slice(2),
              "base64url"
            ).toString("utf8");
            if (/^https?:\/\//i.test(decoded)) value = decoded;
          } catch {
            // Keep original URL. Search-engine URLs are filtered later.
          }
        }
      }
    }
    const url = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function blockedSearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "bing.com" ||
    host.endsWith(".bing.com") ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "duckduckgo.com" ||
    host.endsWith(".duckduckgo.com")
  );
}

export function unsafeOrAdultHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return [
    "pornhub.",
    "xvideos.",
    "xnxx.",
    "xhamster.",
    "redtube.",
    "youporn.",
    "onlyfans.",
    "rule34.",
    "brazzers."
  ].some((token) => host.includes(token));
}

export function classifySource(query: string, url: string): WebResearchSource["sourceType"] {
  const q = query.toLowerCase();
  const host = new URL(url).hostname.toLowerCase();

  // Host identity is stronger than the wording of the search query. A query
  // containing “官网” must never make Taobao/1688/etc. look official.
  if (
    /douyin\.com|tiktok\.com|youtube\.com|youtu\.be|bilibili\.com|xiaohongshu\.com/.test(
      host
    )
  ) {
    return "PLATFORM";
  }
  if (
    /1688\.com|amazon\.|jd\.com$|tmall\.com$|taobao\.com$|pinduoduo\.com$|aliexpress\.|walmart\.|bestbuy\./.test(
      host
    )
  ) {
    return "PUBLIC_PRODUCT";
  }

  if (/竞品|竞争|competitor|对比|comparison/.test(q)) return "COMPETITOR";
  if (/趋势|trend|市场|行业|industry/.test(q)) return "TREND";

  if (/官网|官方网站|official|说明书|manual|support/.test(q)) {
    const generic = new Set([
      "official",
      "manual",
      "support",
      "product",
      "review",
      "usage",
      "guide"
    ]);
    const identityTokens = (q.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
      .filter((token) => !generic.has(token));
    if (identityTokens.some((token) => host.includes(token))) {
      return "OFFICIAL";
    }
    return "INDUSTRY";
  }

  if (/review|评测|tech|news|lab|测评/.test(q + " " + host)) return "INDUSTRY";
  return "PUBLIC_PRODUCT";
}

function extractBing(html: string): SearchResultCandidate[] {
  const blocks = [
    ...html.matchAll(
      /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
    )
  ];
  const sourceBlocks = blocks.length
    ? blocks.map((item) => item[1] ?? "")
    : [html];
  const results: SearchResultCandidate[] = [];
  for (const block of sourceBlocks) {
    const anchor = block.match(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
    );
    if (!anchor) continue;
    const url = normalizeResultUrl(anchor[1] ?? "", "bing");
    if (!url) continue;
    const snippetMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      url,
      title: stripHtml(anchor[2] ?? ""),
      ...(snippetMatch
        ? { snippet: stripHtml(snippetMatch[1] ?? "") }
        : {}),
      rank: results.length + 1
    });
  }
  return results;
}

function extractDuck(html: string): SearchResultCandidate[] {
  const matches = [
    ...html.matchAll(
      /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    )
  ];
  const results: SearchResultCandidate[] = [];
  for (const item of matches) {
    const url = normalizeResultUrl(item[1] ?? "", "duck");
    if (!url) continue;
    const start = item.index ?? 0;
    const tail = html.slice(start, start + 2500);
    const snippetMatch = tail.match(
      /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>|<div\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    results.push({
      url,
      title: stripHtml(item[2] ?? ""),
      ...(snippetMatch
        ? { snippet: stripHtml(snippetMatch[1] ?? snippetMatch[2] ?? "") }
        : {}),
      rank: results.length + 1
    });
  }
  return results;
}

export class PublicSearchResearchProvider implements BrowserResearchProvider {
  readonly id = "public-search";

  constructor(
    private readonly options: {
      fetcher?: typeof fetch;
      bingBaseUrl?: string;
      duckBaseUrl?: string;
      maxQueries?: number;
      maxResultsPerQuery?: number;
      maxTotalResults?: number;
      timeoutMs?: number;
    } = {}
  ) {}

  private async search(
    query: string,
    engine: "bing" | "duck"
  ): Promise<SearchResultCandidate[]> {
    const fetcher = this.options.fetcher ?? fetch;
    const base =
      engine === "bing"
        ? this.options.bingBaseUrl ?? "https://www.bing.com/search"
        : this.options.duckBaseUrl ?? "https://html.duckduckgo.com/html/";
    const url = new URL(base);
    url.searchParams.set("q", query);
    if (engine === "bing") url.searchParams.set("setlang", "zh-Hans");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15_000
    );
    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
          "user-agent": BROWSER_UA
        }
      });
      if (!response.ok) return [];
      const html = await response.text();
      return engine === "bing" ? extractBing(html) : extractDuck(html);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async discover(input: {
    projectId: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }): Promise<BrowserResearchResult> {
    const queries = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))].slice(
      0,
      this.options.maxQueries ?? 12
    );
    const maxEach = this.options.maxResultsPerQuery ?? 3;
    const maxTotal = this.options.maxTotalResults ?? 12;
    const seen = new Set<string>();
    const sources: WebResearchSource[] = [];
    const queryBuckets: Array<{
      query: string;
      engine: "duck" | "bing";
      candidates: SearchResultCandidate[];
    }> = [];

    // Search every selected query first. Do not let the first few generic
    // queries consume the global result budget before strong model/SKU
    // queries get a chance to run.
    for (const query of queries) {
      let engine: "duck" | "bing" = "duck";
      let candidates = await this.search(query, engine);
      if (!candidates.length) {
        engine = "bing";
        candidates = await this.search(query, engine);
      }
      queryBuckets.push({
        query,
        engine,
        candidates: candidates.slice(0, maxEach)
      });
    }

    // Merge round-robin by rank: rank-1 from every query, then rank-2, etc.
    // Only after that apply the global maxTotal budget.
    for (let rankIndex = 0; rankIndex < maxEach; rankIndex += 1) {
      for (const bucket of queryBuckets) {
        if (sources.length >= maxTotal) break;
        const candidate = bucket.candidates[rankIndex];
        if (!candidate) continue;
        let parsed: URL;
        try {
          parsed = new URL(candidate.url);
        } catch {
          continue;
        }
        if (
          blockedSearchHost(parsed.hostname) ||
          unsafeOrAdultHost(parsed.hostname)
        ) {
          continue;
        }
        const key = parsed.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({
          url: key,
          sourceType: classifySource(bucket.query, key),
          discoveryQuery: bucket.query,
          discoveryEngine: bucket.engine,
          discoveryRank: candidate.rank,
          ...(candidate.title ? { resultTitle: candidate.title } : {}),
          ...(candidate.snippet ? { resultSnippet: candidate.snippet } : {})
        });
      }
      if (sources.length >= maxTotal) break;
    }

    if (!sources.length) {
      return {
        status: "BLOCKED",
        blockerCode: "BROWSER_PROVIDER_ERROR",
        message: "公开搜索暂时没有发现可用来源。",
        requiredUserAction:
          "检查网络或调整研究关键词；如果目标平台需要登录，可连接外部 Playwright Research Provider 后继续。",
        browserState: { provider: this.id }
      };
    }

    return {
      status: "READY",
      sources,
      browserState: { provider: this.id }
    };
  }
}

export class HybridBrowserResearchProvider implements BrowserResearchProvider {
  readonly id = "hybrid-browser-research";

  constructor(
    private readonly external: BrowserResearchProvider,
    private readonly publicSearch: BrowserResearchProvider =
      new PublicSearchResearchProvider()
  ) {}

  async discover(input: {
    projectId: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }): Promise<BrowserResearchResult> {
    const external = await this.external.discover(input);
    if (
      external.status === "READY" ||
      (external.status === "BLOCKED" &&
        external.blockerCode !== "BROWSER_PROVIDER_NOT_CONFIGURED")
    ) {
      return external;
    }
    return this.publicSearch.discover(input);
  }
}
