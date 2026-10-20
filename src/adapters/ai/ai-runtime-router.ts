import { createHash, randomUUID } from "node:crypto";
import type {
  AiSettingsRepository,
  ResolvedAiModel
} from "../../application/ports/ai-settings-repository.js";
import type {
  StructuredAiRequest,
  StructuredAiResult,
  StructuredAiRuntime
} from "../../application/ports/structured-ai-runtime.js";
import { hashValue } from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import { AiSettingsService } from "../../application/services/ai-settings-service.js";
import {
  OpenAiCompatibleClient,
  OpenAiCompatibleError
} from "./openai-compatible-client.js";

export class AiRuntimeRouter implements StructuredAiRuntime {
  readonly id = "ai-runtime-router";
  readonly version = "p1-v1";

  constructor(
    private readonly settings: AiSettingsService,
    private readonly repo: AiSettingsRepository,
    private readonly fallback: StructuredAiRuntime,
    private readonly client = new OpenAiCompatibleClient()
  ) {}

  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    return (await this.generateJsonWithMetadata(request)).data;
  }

  async generateJsonWithMetadata(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult> {
    if(request.context?.step==="REFERENCE_VIDEO_ANALYSIS"&&request.media?.some(item=>item.type==="audio"))
      throw new DomainValidationError("参考视频音频尚未取得实际能力、传输和账户费用核验及本次外发确认；停止发送，不自动切换模型");
    if (!request.context) {
      return { data: await this.fallback.generateJson(request) };
    }

    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    const requiredCapabilities = [
      ...(request.media?.some((item) => item.type === "image")
        ? (["VISION"] as const)
        : []),
      ...(request.media?.some((item) => item.type === "audio")
        ? (["AUDIO"] as const)
        : [])
    ];
    const resolved = requiredCapabilities.length
      ? await this.settings.resolveForCapabilities(
          request.context.projectId,
          request.context.step,
          [...requiredCapabilities],
          {allowModelFallback:request.context.step!=="REFERENCE_VIDEO_ANALYSIS"}
        )
      : await this.settings.resolve(
          request.context.projectId,
          request.context.step
        );
    const inputHash = hashValue({
      task: request.task,
      instructions: request.instructions,
      input: request.input,
      outputContract: request.outputContract,
      media:
        request.media?.map((item) => ({
          type: item.type,
          mimeType: item.mimeType,
          label: item.label,
          sha256: createHash("sha256")
            .update(item.dataBase64, "utf8")
            .digest("hex")
        })) ?? [],
      context: request.context
    });

    try {
      const data = await this.executeResolved(resolved, request);
      const completedAt = new Date().toISOString();
      await this.repo.createExecution({
        id: executionId,
        projectId: request.context.projectId,
        step: request.context.step,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        configVersion: resolved.configVersion,
        runtimeId:
          resolved.source === "HERMES_FALLBACK"
            ? this.fallback.id
            : this.id,
        inputHash,
        outputHash: hashValue(data),
        status: "SUCCEEDED",
        createdAt: startedAt,
        completedAt
      });
      return {
        data,
        metadata: {
          executionId,
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          configVersion: resolved.configVersion
        }
      };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const errorCode =
        error instanceof OpenAiCompatibleError
          ? error.code
          : error instanceof Error
            ? error.name
            : "AI_RUNTIME_ERROR";
      await this.repo.createExecution({
        id: executionId,
        projectId: request.context.projectId,
        step: request.context.step,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        configVersion: resolved.configVersion,
        runtimeId:
          resolved.source === "HERMES_FALLBACK"
            ? this.fallback.id
            : this.id,
        inputHash,
        status: "FAILED",
        errorCode,
        createdAt: startedAt,
        completedAt
      });
      throw error;
    }
  }

  private async executeResolved(
    resolved: ResolvedAiModel,
    request: StructuredAiRequest
  ): Promise<unknown> {
    if (resolved.source === "HERMES_FALLBACK" || !resolved.provider) {
      return this.fallback.generateJson(request);
    }
    const apiKey = await this.settings.apiKeyFor(resolved.provider);
    return this.client.generateJson(
      resolved.provider,
      resolved.modelId,
      apiKey,
      request
    );
  }
}
