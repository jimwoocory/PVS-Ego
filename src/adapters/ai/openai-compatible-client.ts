import "../../isolation/require-isolation.js";
import { parseStrictJsonResponse } from "./hermes-structured-ai-runtime.js";
import type { AiProviderConfig } from "../../application/ports/ai-settings-repository.js";
import type { StructuredAiRequest } from "../../application/ports/structured-ai-runtime.js";

export class OpenAiCompatibleError extends Error {
  constructor(
    message: string,
    readonly code = "OPENAI_COMPATIBLE_ERROR"
  ) {
    super(message);
    this.name = "OpenAiCompatibleError";
  }
}

function endpoint(baseUrl: string, suffix: string): string {
  return baseUrl.replace(/\/+$/, "") + suffix;
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries: number
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (
        response.ok ||
        ![408, 429, 500, 502, 503, 504].includes(response.status) ||
        attempt >= maxRetries
      ) {
        return response;
      }
      lastError = new OpenAiCompatibleError(
        `Provider temporarily unavailable (HTTP ${response.status})`,
        "PROVIDER_RETRYABLE"
      );
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt >= maxRetries) break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 3000)));
  }
  if (lastError instanceof Error) throw lastError;
  throw new OpenAiCompatibleError("Provider request failed");
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json"
  };
}

export class OpenAiCompatibleClient {
  async listModels(
    provider: AiProviderConfig,
    apiKey: string
  ): Promise<Array<{ modelId: string; displayName?: string }>> {
    const response = await requestWithRetry(
      endpoint(provider.baseUrl, "/models"),
      {
        method: "GET",
        headers: authHeaders(apiKey)
      },
      provider.timeoutMs,
      provider.maxRetries
    );
    if (!response.ok) {
      throw new OpenAiCompatibleError(
        `Model discovery failed (HTTP ${response.status})`,
        "MODEL_DISCOVERY_FAILED"
      );
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
    };
    if (!Array.isArray(body.data)) {
      throw new OpenAiCompatibleError(
        "Provider /models response did not contain data[]",
        "INVALID_MODELS_RESPONSE"
      );
    }
    const unique = new Map<string, { modelId: string; displayName?: string }>();
    for (const item of body.data) {
      if (typeof item?.id !== "string" || !item.id.trim()) continue;
      const modelId = item.id.trim();
      const displayName =
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : undefined;
      unique.set(modelId, {
        modelId,
        ...(displayName ? { displayName } : {})
      });
    }
    return [...unique.values()].sort((a, b) =>
      a.modelId.localeCompare(b.modelId)
    );
  }

  async generateJson(
    provider: AiProviderConfig,
    modelId: string,
    apiKey: string,
    request: StructuredAiRequest
  ): Promise<unknown> {
    const system = [
      "你是 Product Video Studio 的结构化 AI 生成器。",
      "只返回一个合法 JSON 值，不要 Markdown，不要解释，不要代码围栏。",
      "面向用户阅读的标题、描述、脚本、镜头说明、风险原因等自然语言内容统一使用简体中文；JSON 字段名、枚举值、标识、模型名称和产品原有品牌型号保持接口约定，不得翻译。",
      "禁止把推测当事实；无法确认的信息必须按任务约定放入不确定字段。"
    ].join("\n");
    const user = [
      "TASK:",
      request.task,
      "",
      "INSTRUCTIONS:",
      request.instructions,
      "",
      "INPUT_JSON:",
      JSON.stringify(request.input),
      "",
      "OUTPUT_CONTRACT_JSON:",
      JSON.stringify(request.outputContract),
      "",
      "最终响应必须是严格 JSON。"
    ].join("\n");
    const userContent = request.media?.length
      ? [
          { type: "text", text: user },
          ...request.media.map((item) =>
            item.type === "image"
              ? {
                  type: "image_url",
                  image_url: {
                    url:
                      "data:" +
                      item.mimeType +
                      ";base64," +
                      item.dataBase64
                  }
                }
              : {
                  type: "input_audio",
                  input_audio: {
                    data: item.dataBase64,
                    format: item.mimeType === "audio/wav" ? "wav" : "mp3"
                  }
                }
          )
        ]
      : user;

    const response = await requestWithRetry(
      endpoint(provider.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent }
          ],
          temperature: 0.2
        })
      },
      provider.timeoutMs,
      provider.maxRetries
    );
    if (!response.ok) {
      throw new OpenAiCompatibleError(
        `Structured generation failed (HTTP ${response.status})`,
        "STRUCTURED_GENERATION_FAILED"
      );
    }
    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?:
            | string
            | Array<{ type?: string; text?: string }>;
        };
      }>;
    };
    const raw = body.choices?.[0]?.message?.content;
    const content =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((item) => (typeof item?.text === "string" ? item.text : ""))
              .join("")
          : "";
    if (!content.trim()) {
      throw new OpenAiCompatibleError(
        "Provider returned empty structured content",
        "EMPTY_STRUCTURED_OUTPUT"
      );
    }
    return parseStrictJsonResponse(content);
  }
}
