import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import { z } from "zod";
import type { GenerationQuoteProvider } from "../../application/ports/generation-quote-provider.js";
import { providerQuoteSchema, type ProviderQuote, type QuoteItem } from "../../domain/generation-quote.js";

const configSchema = z.object({ contract: z.literal("pvs-generation-quote-v1"), providers: z.record(z.string(), z.object({
  endpoint: z.string().url(), readOnly: z.literal(true), accountFingerprint: z.string().min(1),
  sourceUrl: z.string().url(), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional()
}).strict()) }).strict();
export function validateQuoteEndpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new Error("报价接口必须使用HTTPS或本机HTTP，不得含凭据、查询参数或重定向");
  return url;
}
/** Operator-registered read-only provider/MCP bridge. No undocumented platform URLs. */
export class ConfiguredGenerationQuoteProvider implements GenerationQuoteProvider {
  constructor(private readonly configPath = process.env.PVS_QUOTE_CONFIG, private readonly fetcher: typeof fetch = fetch) {}
  async quote(input: { requestHash: string; item: QuoteItem }): Promise<ProviderQuote> {
    const unavailable = (code: string, message: string): ProviderQuote => ({ status: "UNAVAILABLE", code, message });
    if (!this.configPath) return unavailable("QUOTE_INTERFACE_MISSING",
      "PVS当前绑定的旧版dreamina CLI没有提交前报价命令。独立的Dreamina Canvas CLI有node quote，但尚未与本机生成通道、同一账号/模型及已保存节点绑定。缺少当前通道的只读报价桥接；不能把另一通道报价、余额或网页价格套用到本任务。");
    try {
      const config = configSchema.parse(JSON.parse(await fs.readFile(this.configPath, "utf8")));
      const provider = config.providers[input.item.providerId];
      if (!provider) return unavailable("QUOTE_PROVIDER_NOT_REGISTERED", "当前生成通道没有登记只读报价接口；不会切换模型或通道");
      const endpoint = validateQuoteEndpoint(provider.endpoint);
      const token = provider.tokenEnv ? process.env[provider.tokenEnv] : undefined;
      if (provider.tokenEnv && !token) return unavailable("QUOTE_AUTH_MISSING", "报价接口的后台凭据尚未配置");
      const response = await this.fetcher(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
        body: JSON.stringify({ contract: "pvs-generation-quote-v1", requestHash: input.requestHash, item: input.item }) });
      if (!response.ok) return unavailable("QUOTE_HTTP_ERROR", `报价接口返回HTTP ${response.status}；未提交生成`);
      const text = await response.text();
      if (text.length > 65536) return unavailable("QUOTE_RESPONSE_INVALID", "报价返回超出允许大小");
      const result = providerQuoteSchema.parse(JSON.parse(text));
      if (result.status === "QUOTED" && (result.accountFingerprint !== provider.accountFingerprint || result.sourceUrl !== provider.sourceUrl))
        return unavailable("QUOTE_ACCOUNT_OR_SOURCE_MISMATCH", "报价账号或计费来源与登记的生成通道不一致");
      return result;
    } catch {
      // Do not persist response bodies, tokens or URLs from network/config errors.
      return unavailable("QUOTE_INTERFACE_INVALID", "报价接口配置、连接或返回格式无效；需要符合PVS只读报价契约，未提交生成");
    }
  }
}
