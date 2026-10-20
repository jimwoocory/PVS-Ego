import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AiExecutionRecord,
  AiModelCapability,
  AiModelConfig,
  AiProviderConfig,
  AiSettingsRepository,
  AiStep,
  AiSystemPreference,
  ProjectAiPreference,
  ResolvedAiModel,
  StepModelOverride
} from "../ports/ai-settings-repository.js";
import type { SecretStore } from "../ports/secret-store.js";
import { DomainValidationError } from "../../domain/validation.js";
import { OpenAiCompatibleClient } from "../../adapters/ai/openai-compatible-client.js";

const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

const providerInputSchema = z.object({
  id: providerIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  enabled: z.boolean().default(true),
  defaultModelId: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).default(180_000),
  maxRetries: z.number().int().min(0).max(3).default(1)
});

const capabilitySchema = z
  .array(z.enum(["TEXT", "VISION", "AUDIO", "VIDEO", "OCR"]))
  .min(1)
  .max(5);

function inferredCapabilities(
  modelId: string,
  displayName?: string
): AiModelCapability[] {
  const text = `${modelId} ${displayName ?? ""}`.toLowerCase();
  const capabilities = new Set<AiModelCapability>(["TEXT"]);
  if (
    /(vision|multimodal|omni|gpt-4o|gpt-5|gemini|qwen[^\s/]*[-_.]?vl|qwen-vl|internvl|pixtral|llava|glm[-_.]?4v|doubao[^\s/]*vision|seed[^\s/]*vl)/i.test(
      text
    )
  ) {
    capabilities.add("VISION");
    capabilities.add("OCR");
  }
  if (/(audio|realtime|omni|gpt-4o|gemini)/i.test(text)) {
    capabilities.add("AUDIO");
  }
  if (/(video|gemini|omni)/i.test(text)) {
    capabilities.add("VIDEO");
  }
  return [...capabilities];
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new DomainValidationError("Base URL 仅支持 http/https");
  }
  if (url.username || url.password) {
    throw new DomainValidationError("Base URL 不能包含用户名或密码");
  }
  return url.toString().replace(/\/+$/, "");
}

export class AiSettingsService {
  constructor(
    private readonly repo: AiSettingsRepository,
    private readonly secrets: SecretStore,
    private readonly client = new OpenAiCompatibleClient(),
    private readonly fallbackCapabilities?: (required: AiModelCapability[]) => Promise<boolean>
  ) {}

  async listProviders(): Promise<
    Array<AiProviderConfig & { models: AiModelConfig[] }>
  > {
    const providers = await this.repo.listProviders();
    return Promise.all(
      providers.map(async (provider) => ({
        ...provider,
        models: (await this.repo.listModels(provider.id)).filter(
          (model) => model.enabled
        )
      }))
    );
  }

  async getProvider(id: string): Promise<AiProviderConfig | null> {
    return this.repo.getProvider(id);
  }

  async saveProvider(inputRaw: unknown): Promise<AiProviderConfig> {
    const input = providerInputSchema.parse(inputRaw);
    const id = input.id ?? randomUUID();
    const existing = await this.repo.getProvider(id);
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      await this.secrets.set(id, input.apiKey);
    } else if (input.clearApiKey) {
      await this.secrets.delete(id);
    }
    const hasSecret = await this.secrets.has(id);
    const provider = await this.repo.upsertProvider({
      id,
      name: input.name,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      enabled: input.enabled,
      ...(input.defaultModelId
        ? { defaultModelId: input.defaultModelId }
        : existing?.defaultModelId
          ? { defaultModelId: existing.defaultModelId }
          : {}),
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
      hasSecret,
      connectionStatus: hasSecret ? "UNTESTED" : "UNCONFIGURED"
    });
    return provider;
  }

  async addManualModel(
    providerId: string,
    modelIdRaw: unknown,
    displayNameRaw?: unknown,
    capabilitiesRaw?: unknown
  ): Promise<AiModelConfig[]> {
    const provider = await this.requireProvider(providerId);
    const modelId = z.string().trim().min(1).max(200).parse(modelIdRaw);
    const displayName =
      typeof displayNameRaw === "string" && displayNameRaw.trim()
        ? displayNameRaw.trim()
        : undefined;
    const capabilities = capabilitiesRaw
      ? capabilitySchema.parse(capabilitiesRaw)
      : inferredCapabilities(modelId, displayName);
    await this.repo.upsertModels(provider.id, [
      {
        modelId,
        ...(displayName ? { displayName } : {}),
        capabilities,
        source: "MANUAL"
      }
    ]);
    return this.repo.listModels(provider.id);
  }

  async refreshModels(providerId: string): Promise<AiModelConfig[]> {
    const provider = await this.requireProvider(providerId);
    const apiKey = await this.requireSecret(provider);
    const testedAt = new Date().toISOString();
    try {
      const models = await this.client.listModels(provider, apiKey);
      if (!models.length) {
        throw new DomainValidationError("大模型服务商没有返回可用模型");
      }
      await this.repo.updateProviderConnectionStatus(
        provider.id,
        "CONNECTED",
        testedAt
      );
      return this.repo.syncDiscoveredModels(
        provider.id,
        models
      );
    } catch (error) {
      await this.repo.updateProviderConnectionStatus(
        provider.id,
        "FAILED",
        testedAt
      );
      throw error;
    }
  }

  async testProvider(providerId: string): Promise<{
    ok: true;
    modelCount: number;
  }> {
    const provider = await this.requireProvider(providerId);
    const apiKey = await this.requireSecret(provider);
    const testedAt = new Date().toISOString();
    try {
      const models = await this.client.listModels(provider, apiKey);
      await this.repo.updateProviderConnectionStatus(
        provider.id,
        "CONNECTED",
        testedAt
      );
      return { ok: true, modelCount: models.length };
    } catch (error) {
      await this.repo.updateProviderConnectionStatus(
        provider.id,
        "FAILED",
        testedAt
      );
      throw error;
    }
  }

  async getSystemPreference(): Promise<AiSystemPreference> {
    return this.repo.getSystemPreference();
  }

  async setModelCapabilities(
    providerId: string,
    modelIdRaw: unknown,
    capabilitiesRaw: unknown
  ): Promise<AiModelConfig> {
    const provider = await this.requireProvider(providerId);
    const modelId = z.string().trim().min(1).max(200).parse(modelIdRaw);
    const capabilities = [...new Set(capabilitySchema.parse(capabilitiesRaw))];
    if (!(await this.repo.getModel(provider.id, modelId))) {
      throw new DomainValidationError("找不到指定模型");
    }
    return this.repo.setModelCapabilities(
      provider.id,
      modelId,
      capabilities
    );
  }

  async setSystemPreference(input: {
    defaultProviderId?: string;
    defaultModelId?: string;
  }): Promise<AiSystemPreference> {
    if (!input.defaultProviderId || !input.defaultModelId) {
      return this.repo.setSystemPreference({});
    }
    await this.validateSelection(
      input.defaultProviderId,
      input.defaultModelId,
      true
    );
    return this.repo.setSystemPreference(input);
  }

  async getProjectPreference(
    projectId: string
  ): Promise<ProjectAiPreference> {
    return this.repo.getProjectPreference(projectId);
  }

  async setProjectPreference(
    projectId: string,
    input: {
      defaultProviderId?: string;
      defaultModelId?: string;
    }
  ): Promise<ProjectAiPreference> {
    if (!input.defaultProviderId || !input.defaultModelId) {
      return this.repo.setProjectPreference(projectId, {});
    }
    await this.validateSelection(
      input.defaultProviderId,
      input.defaultModelId,
      true
    );
    return this.repo.setProjectPreference(projectId, input);
  }

  async listStepOverrides(
    projectId: string
  ): Promise<StepModelOverride[]> {
    return this.repo.listStepOverrides(projectId);
  }

  async listExecutions(projectId: string): Promise<AiExecutionRecord[]> {
    return this.repo.listExecutions(projectId);
  }

  async setStepOverride(
    projectId: string,
    step: AiStep,
    selection:
      | { providerId: string; modelId: string }
      | null
  ): Promise<StepModelOverride | null> {
    if (!selection) {
      return this.repo.setStepOverride(projectId, step, null);
    }
    await this.validateSelection(
      selection.providerId,
      selection.modelId,
      true
    );
    return this.repo.setStepOverride(projectId, step, selection);
  }

  async resolve(
    projectId: string,
    step: AiStep
  ): Promise<ResolvedAiModel> {
    const stepOverride = await this.repo.getStepOverride(projectId, step);
    if (stepOverride) {
      const provider = await this.validateSelection(
        stepOverride.providerId,
        stepOverride.modelId,
        true
      );
      return {
        source: "STEP_OVERRIDE",
        providerId: provider.id,
        modelId: stepOverride.modelId,
        configVersion: provider.configVersion,
        provider
      };
    }

    const projectPreference = await this.repo.getProjectPreference(projectId);
    if (
      projectPreference.defaultProviderId &&
      projectPreference.defaultModelId
    ) {
      const provider = await this.validateSelection(
        projectPreference.defaultProviderId,
        projectPreference.defaultModelId,
        true
      );
      return {
        source: "PROJECT_DEFAULT",
        providerId: provider.id,
        modelId: projectPreference.defaultModelId,
        configVersion: provider.configVersion,
        provider
      };
    }

    const system = await this.repo.getSystemPreference();
    if (system.defaultProviderId && system.defaultModelId) {
      const provider = await this.validateSelection(
        system.defaultProviderId,
        system.defaultModelId,
        true
      );
      return {
        source: "SYSTEM_DEFAULT",
        providerId: provider.id,
        modelId: system.defaultModelId,
        configVersion: provider.configVersion,
        provider
      };
    }

    const providerDefaults = (await this.repo.listProviders())
      .filter(
        (provider) =>
          provider.enabled &&
          provider.hasSecret &&
          provider.defaultModelId &&
          provider.connectionStatus !== "FAILED"
      )
      .sort((a, b) => {
        const rank = (value: AiProviderConfig["connectionStatus"]) =>
          value === "CONNECTED" ? 0 : value === "UNTESTED" ? 1 : 2;
        return (
          rank(a.connectionStatus) - rank(b.connectionStatus) ||
          a.id.localeCompare(b.id)
        );
      });
    for (const candidate of providerDefaults) {
      const modelId = candidate.defaultModelId!;
      const model = await this.repo.getModel(candidate.id, modelId);
      if (!model?.enabled) continue;
      await this.requireSecret(candidate);
      return {
        source: "PROVIDER_DEFAULT",
        providerId: candidate.id,
        modelId,
        configVersion: candidate.configVersion,
        provider: candidate
      };
    }

    return {
      source: "HERMES_FALLBACK",
      providerId: "hermes-agent",
      modelId: "external-config",
      configVersion: 1
    };
  }

  async resolveForCapabilities(
    projectId: string,
    step: AiStep,
    required: AiModelCapability[],
    options: {allowModelFallback?:boolean} = {}
  ): Promise<ResolvedAiModel> {
    const normal = await this.resolve(projectId, step);

    if (normal.source === "HERMES_FALLBACK" && await this.fallbackCapabilities?.(required)) return normal;

    const supports = async (providerId: string, modelId: string) => {
      const model = await this.repo.getModel(providerId, modelId);
      if (!model?.enabled) return false;
      return required.every((capability) =>
        model.capabilities.includes(capability)
      );
    };
    if (await supports(normal.providerId, normal.modelId)) return normal;

    if(options.allowModelFallback===false)throw new DomainValidationError("当前选定模型的媒体能力不足；需要用户确认模型变更，不能自动切换备用模型");

    const providers = (await this.repo.listProviders()).filter(
      (provider) => provider.enabled && provider.hasSecret
    );
    const ordered = [
      ...providers.filter((provider) => provider.id === normal.providerId),
      ...providers.filter((provider) => provider.id !== normal.providerId)
    ];
    for (const provider of ordered) {
      const models = await this.repo.listModels(provider.id);
      let capable: AiModelConfig | undefined;
      for (const model of models) {
        if (await supports(provider.id, model.modelId)) {
          capable =
            (await this.repo.getModel(provider.id, model.modelId)) ?? model;
          break;
        }
      }
      if (!capable) continue;
      await this.requireSecret(provider);
      return {
        source: "CAPABILITY_FALLBACK",
        providerId: provider.id,
        modelId: capable.modelId,
        configVersion: provider.configVersion,
        provider
      };
    }

    throw new DomainValidationError(
      `当前没有配置支持 ${required.join("+")} 的可用模型，请在大模型设置中标记模型能力。`
    );
  }

  async apiKeyFor(provider: AiProviderConfig): Promise<string> {
    return this.requireSecret(provider);
  }

  private async requireProvider(
    providerId: string
  ): Promise<AiProviderConfig> {
    const provider = await this.repo.getProvider(providerId);
    if (!provider) {
      throw new DomainValidationError("找不到指定的大模型服务商");
    }
    return provider;
  }

  private async requireSecret(
    provider: AiProviderConfig
  ): Promise<string> {
    const secret = await this.secrets.get(provider.id);
    if (!secret) {
      throw new DomainValidationError(
        `Provider“${provider.name}”尚未配置 API Key`
      );
    }
    return secret;
  }

  private async validateSelection(
    providerId: string,
    modelId: string,
    requireSecret: boolean
  ): Promise<AiProviderConfig> {
    const provider = await this.requireProvider(providerId);
    if (!provider.enabled) {
      throw new DomainValidationError(
        `Provider“${provider.name}”已禁用`
      );
    }
    const model = await this.repo.getModel(providerId, modelId);
    if (!model || !model.enabled) {
      throw new DomainValidationError(
        `模型“${modelId}”未在 Provider“${provider.name}”中启用`
      );
    }
    if (requireSecret) {
      await this.requireSecret(provider);
    }
    return provider;
  }
}

export const p1AiSteps: Array<{ step: AiStep; label: string }> = [
  { step: "PRODUCT_TRUTH", label: "产品事实" },
  { step: "CREATIVE", label: "创意方案" },
  { step: "SCRIPT", label: "脚本" },
  { step: "DIRECTOR", label: "导演分镜" },
  { step: "REFERENCE_VIDEO_ANALYSIS", label: "参考视频分析" },
  { step: "AUTO_EDIT_VISUAL", label: "视觉审片 / 智能剪辑" },
  { step: "RESEARCH", label: "联网研究" },
  { step: "DOUYIN_OPS", label: "抖音运营" }
];
