import "../../isolation/require-isolation.js";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  WebResearchDocument,
  WebResearchMedia,
  WebResearchProvider,
  WebResearchSource
} from "../../application/ports/research-provider.js";
import { DomainValidationError } from "../../domain/validation.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 198 && b !== undefined && (b === 18 || b === 19)) ||
    (a !== undefined && a >= 224)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if(normalized.startsWith("::ffff:")){
    const tail=normalized.slice(7);
    if(tail.includes("."))return isPrivateIpv4(tail);
    const pair=tail.split(":");
    if(pair.length===2){const hi=parseInt(pair[0]!,16),lo=parseInt(pair[1]!,16);return isPrivateIpv4([hi>>>8,hi&255,lo>>>8,lo&255].join("."));}
    return true;
  }
  return (
    normalized === "::1" ||
    normalized === "::" ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

export async function assertSafeResearchUrl(
  rawUrl: string,
  allowPrivateNetwork: boolean,
  resolveAddresses: ResearchAddressLookup = defaultResearchAddressLookup
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainValidationError("研究来源网址无效");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new DomainValidationError("研究来源只允许 http/https");
  }
  if (url.username || url.password) {
    throw new DomainValidationError("研究来源网址不允许包含用户名或密码");
  }
  if (allowPrivateNetwork) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal"
  ) {
    throw new DomainValidationError("研究来源不能访问本机或云元数据地址");
  }

  if (isIP(hostname)) {
    if (
      (isIP(hostname) === 4 && isPrivateIpv4(hostname)) ||
      (isIP(hostname) === 6 && isPrivateIpv6(hostname))
    ) {
      throw new DomainValidationError("研究来源不能访问私有网络地址");
    }
    return url;
  }

  const addresses = await resolveAddresses(hostname);
  if (!addresses.length) {
    throw new DomainValidationError("研究来源域名无法解析");
  }
  for (const item of addresses) {
    if (
      (item.family === 4 && isPrivateIpv4(item.address)) ||
      (item.family === 6 && isPrivateIpv6(item.address))
    ) {
      throw new DomainValidationError("研究来源解析到了私有网络地址");
    }
  }
  return url;
}

export type ResearchAddressLookup=(hostname:string)=>Promise<Array<{address:string;family:number}>>;
export const defaultResearchAddressLookup:ResearchAddressLookup=hostname=>lookup(hostname,{all:true,verbatim:true});

function htmlEntityDecode(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function researchMediaUrl(raw: string, baseUrl: string): string | null {
  const decoded = htmlEntityDecode(raw.trim());
  if (!decoded || /^(?:data|blob|javascript):/i.test(decoded)) return null;
  try {
    const url = new URL(decoded, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractResearchMedia(
  html: string,
  baseUrl: string
): WebResearchMedia[] {
  const result: WebResearchMedia[] = [];
  const seen = new Set<string>();
  const add = (item: WebResearchMedia) => {
    if (
      item.type === "IMAGE" &&
      /\.(?:svg|gif|ico)(?:[?#]|$)/i.test(item.url)
    ) {
      return;
    }
    if (seen.has(item.url)) return;
    seen.add(item.url);
    result.push(item);
  };

  for (const match of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) {
    const url = researchMediaUrl(match[1] ?? "", baseUrl);
    if (url) add({ type: "IMAGE", url, label: "页面主图" });
  }
  for (const match of html.matchAll(
    /<meta\b[^>]*(?:property|name)=["'](?:og:video|og:video:url|twitter:player:stream)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  )) {
    const url = researchMediaUrl(match[1] ?? "", baseUrl);
    if (url) add({ type: "VIDEO", url, label: "页面视频" });
  }

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    if (result.filter((item) => item.type === "IMAGE").length >= 8) break;
    const attrs = match[1] ?? "";
    const src = /\b(?:src|data-src|data-original)=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    const url = researchMediaUrl(src, baseUrl);
    if (!url) continue;
    const label = /\balt=["']([^"']*)["']/i.exec(attrs)?.[1];
    add({
      type: "IMAGE",
      url,
      ...(label?.trim()
        ? { label: htmlEntityDecode(label.trim()).slice(0, 200) }
        : {})
    });
  }

  for (const match of html.matchAll(/<(?:video|source)\b([^>]*)>/gi)) {
    if (result.filter((item) => item.type === "VIDEO").length >= 3) break;
    const attrs = match[1] ?? "";
    const src = /\bsrc=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    const url = researchMediaUrl(src, baseUrl);
    if (!url) continue;
    const mimeType = /\btype=["']([^"']+)["']/i.exec(attrs)?.[1];
    add({
      type: "VIDEO",
      url,
      ...(mimeType?.trim() ? { mimeType: mimeType.trim() } : {})
    });
  }

  return result.slice(0, 10);
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = htmlEntityDecode(
    (titleMatch?.[1] ?? "Untitled")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  const text = htmlEntityDecode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  return {
    title: title || "Untitled",
    text
  };
}

async function readLimitedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body) return "";
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
      throw new DomainValidationError(
        "研究来源正文超过允许大小"
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export class HttpWebResearchProvider implements WebResearchProvider {
  constructor(
    private readonly options: {
      allowPrivateNetwork?: boolean;
      timeoutMs?: number;
      maxBytes?: number;
      maxRedirects?: number;
      resolveAddresses?: ResearchAddressLookup;
      fetcher?: typeof fetch;
    } = {}
  ) {}

  async fetchSource(
    source: WebResearchSource
  ): Promise<WebResearchDocument> {
    const allowPrivateNetwork =
      this.options.allowPrivateNetwork === true;
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const maxBytes = this.options.maxBytes ?? 2 * 1024 * 1024;
    const maxRedirects = this.options.maxRedirects ?? 5;

    let url = await assertSafeResearchUrl(source.url, allowPrivateNetwork,this.options.resolveAddresses);
    let response: Response | undefined;
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await (this.options.fetcher??fetch)(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept:
              "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
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
        if (redirect >= maxRedirects) {
          throw new DomainValidationError("研究来源重定向次数过多");
        }
        const next = new URL(
          response.headers.get("location")!,
          url
        ).toString();
        url = await assertSafeResearchUrl(next, allowPrivateNetwork,this.options.resolveAddresses);
        continue;
      }
      break;
    }

    if (!response) {
      throw new DomainValidationError("研究来源请求失败");
    }
    if (!response.ok) {
      throw new DomainValidationError(
        "研究来源返回 HTTP " + response.status
      );
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/json")
    ) {
      throw new DomainValidationError(
        "研究来源不是可分析的文本网页"
      );
    }

    const raw = await readLimitedText(response, maxBytes);
    const isHtml = contentType.includes("html");
    const parsed = isHtml
      ? htmlToText(raw)
      : {
          title: url.hostname,
          text: raw.replace(/\s+/g, " ").trim()
        };
    if (parsed.text.length < 20) {
      throw new DomainValidationError("研究来源正文内容过少");
    }
    const excerpt = parsed.text.slice(0, 4000);
    return {
      sourceUrl: source.url,
      finalUrl: url.toString(),
      title: parsed.title.slice(0, 500),
      fetchedAt: new Date().toISOString(),
      sourceType: source.sourceType,
      text: parsed.text,
      excerpt,
      contentHash: sha256(parsed.text),
      ...(isHtml
        ? { media: extractResearchMedia(raw, url.toString()) }
        : {})
    };
  }
}
