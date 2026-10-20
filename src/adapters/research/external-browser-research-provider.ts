import "../../isolation/require-isolation.js";
import type {
  BrowserResearchProvider,
  BrowserResearchResult,
  WebResearchSource
} from "../../application/ports/research-provider.js";

function normalizeSource(value: unknown): WebResearchSource | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.url !== "string" || !item.url.trim()) return null;
  const allowed = new Set([
    "OFFICIAL",
    "USER_URL",
    "PUBLIC_PRODUCT",
    "COMPETITOR",
    "INDUSTRY",
    "TREND",
    "PLATFORM"
  ]);
  const sourceType =
    typeof item.sourceType === "string" &&
    allowed.has(item.sourceType)
      ? (item.sourceType as WebResearchSource["sourceType"])
      : "COMPETITOR";
  return {
    url: item.url.trim(),
    sourceType
  };
}

export class ExternalBrowserResearchProvider
  implements BrowserResearchProvider
{
  readonly id = "external-browser-research";

  constructor(
    private readonly endpoint =
      process.env.PVS_BROWSER_RESEARCH_URL?.trim() ?? ""
  ) {}

  async discover(input: {
    projectId: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }): Promise<BrowserResearchResult> {
    if (!this.endpoint) {
      return {
        status: "BLOCKED",
        blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
        message:
          "深度研究需要浏览器/Playwright Research Provider，但当前尚未配置。",
        requiredUserAction:
          "连接或启动浏览器研究 Provider 后，点击“继续深度研究”。",
        browserState: {
          provider: this.id,
          ...(input.resumeToken
            ? { resumeToken: input.resumeToken }
            : {})
        }
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: input.projectId,
          goal: input.goal,
          queries: input.queries,
          ...(input.resumeToken
            ? { resumeToken: input.resumeToken }
            : {})
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        return {
          status: "BLOCKED",
          blockerCode: "BROWSER_PROVIDER_ERROR",
          message:
            "浏览器研究 Provider 返回 HTTP " + response.status,
          requiredUserAction:
            "检查浏览器研究服务连接后重新继续。",
          browserState: {
            provider: this.id,
            ...(input.resumeToken
              ? { resumeToken: input.resumeToken }
              : {})
          }
        };
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body.status === "READY") {
        const sources = Array.isArray(body.sources)
          ? body.sources
              .map(normalizeSource)
              .filter(
                (item): item is WebResearchSource =>
                  item !== null
              )
          : [];
        return {
          status: "READY",
          sources,
          browserState: {
            provider: this.id,
            ...(typeof body.resumeToken === "string" &&
            body.resumeToken.trim()
              ? { resumeToken: body.resumeToken.trim() }
              : {})
          }
        };
      }

      const rawCode =
        typeof body.blockerCode === "string"
          ? body.blockerCode
          : "BROWSER_PROVIDER_ERROR";
      const validCodes = new Set([
        "BROWSER_PROVIDER_NOT_CONFIGURED",
        "LOGIN_REQUIRED",
        "CAPTCHA_REQUIRED",
        "RISK_CONTROL",
        "BROWSER_SESSION_EXPIRED",
        "BROWSER_PROVIDER_ERROR"
      ]);
      const blockerCode = validCodes.has(rawCode)
        ? (rawCode as
            | "BROWSER_PROVIDER_NOT_CONFIGURED"
            | "LOGIN_REQUIRED"
            | "CAPTCHA_REQUIRED"
            | "RISK_CONTROL"
            | "BROWSER_SESSION_EXPIRED"
            | "BROWSER_PROVIDER_ERROR")
        : "BROWSER_PROVIDER_ERROR";
      return {
        status: "BLOCKED",
        blockerCode,
        message:
          typeof body.message === "string" && body.message.trim()
            ? body.message.trim()
            : "浏览器研究需要用户接管。",
        requiredUserAction:
          typeof body.requiredUserAction === "string" &&
          body.requiredUserAction.trim()
            ? body.requiredUserAction.trim()
            : "完成浏览器接管后点击继续。",
        browserState: {
          provider: this.id,
          ...(typeof body.resumeToken === "string" &&
          body.resumeToken.trim()
            ? { resumeToken: body.resumeToken.trim() }
            : input.resumeToken
              ? { resumeToken: input.resumeToken }
              : {})
        }
      };
    } catch {
      return {
        status: "BLOCKED",
        blockerCode: "BROWSER_PROVIDER_ERROR",
        message: "浏览器研究 Provider 当前不可连接。",
        requiredUserAction:
          "检查浏览器研究服务后重新继续。",
        browserState: {
          provider: this.id,
          ...(input.resumeToken
            ? { resumeToken: input.resumeToken }
            : {})
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
