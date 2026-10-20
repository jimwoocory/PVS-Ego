export type AiStep =
  | "PRODUCT_TRUTH"
  | "CREATIVE"
  | "SCRIPT"
  | "DIRECTOR"
  | "REFERENCE_VIDEO_ANALYSIS"
  | "AUTO_EDIT_VISUAL"
  | "RESEARCH"
  | "DOUYIN_OPS";

export type AiModelCapability =
  | "TEXT"
  | "VISION"
  | "AUDIO"
  | "VIDEO"
  | "OCR";

export type AiProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  configVersion: number;
  defaultModelId?: string;
  timeoutMs: number;
  maxRetries: number;
  hasSecret: boolean;
  connectionStatus: "UNCONFIGURED" | "UNTESTED" | "CONNECTED" | "FAILED";
  lastTestedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AiModelConfig = {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  source: "DISCOVERED" | "MANUAL" | "USER_DISABLED";
  capabilities: AiModelCapability[];
  discoveredAt: string;
};

export type AiSystemPreference = {
  id: "system";
  defaultProviderId?: string;
  defaultModelId?: string;
  updatedAt: string;
};

export type ProjectAiPreference = {
  projectId: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  updatedAt: string;
};

export type StepModelOverride = {
  id: string;
  projectId: string;
  step: AiStep;
  providerId: string;
  modelId: string;
  updatedAt: string;
};

export type AiExecutionRecord = {
  id: string;
  projectId: string;
  step: AiStep;
  providerId: string;
  modelId: string;
  configVersion: number;
  runtimeId: string;
  inputHash: string;
  outputHash?: string;
  status: "SUCCEEDED" | "FAILED";
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
};

export type ResolvedAiModel = {
  source:
    | "STEP_OVERRIDE"
    | "PROJECT_DEFAULT"
    | "SYSTEM_DEFAULT"
    | "PROVIDER_DEFAULT"
    | "CAPABILITY_FALLBACK"
    | "HERMES_FALLBACK";
  providerId: string;
  modelId: string;
  configVersion: number;
  provider?: AiProviderConfig;
};

export interface AiSettingsRepository {
  listProviders(): Promise<AiProviderConfig[]>;
  getProvider(id: string): Promise<AiProviderConfig | null>;
  upsertProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    defaultModelId?: string;
    timeoutMs: number;
    maxRetries: number;
    hasSecret: boolean;
    connectionStatus: AiProviderConfig["connectionStatus"];
    lastTestedAt?: string;
  }): Promise<AiProviderConfig>;
  updateProviderConnectionStatus(
    id: string,
    status: AiProviderConfig["connectionStatus"],
    testedAt?: string
  ): Promise<AiProviderConfig>;

  listModels(providerId: string): Promise<AiModelConfig[]>;
  upsertModels(
    providerId: string,
    models: Array<{
      modelId: string;
      displayName?: string;
      enabled?: boolean;
      source: "DISCOVERED" | "MANUAL";
      capabilities?: AiModelCapability[];
    }>
  ): Promise<AiModelConfig[]>;
  syncDiscoveredModels(
    providerId: string,
    models: Array<{
      modelId: string;
      displayName?: string;
    }>
  ): Promise<AiModelConfig[]>;
  getModel(providerId: string, modelId: string): Promise<AiModelConfig | null>;
  setModelCapabilities(
    providerId: string,
    modelId: string,
    capabilities: AiModelCapability[]
  ): Promise<AiModelConfig>;

  getSystemPreference(): Promise<AiSystemPreference>;
  setSystemPreference(input: {
    defaultProviderId?: string;
    defaultModelId?: string;
  }): Promise<AiSystemPreference>;

  getProjectPreference(projectId: string): Promise<ProjectAiPreference>;
  setProjectPreference(
    projectId: string,
    input: {
      defaultProviderId?: string;
      defaultModelId?: string;
    }
  ): Promise<ProjectAiPreference>;

  listStepOverrides(projectId: string): Promise<StepModelOverride[]>;
  getStepOverride(
    projectId: string,
    step: AiStep
  ): Promise<StepModelOverride | null>;
  setStepOverride(
    projectId: string,
    step: AiStep,
    selection:
      | { providerId: string; modelId: string }
      | null
  ): Promise<StepModelOverride | null>;

  createExecution(record: AiExecutionRecord): Promise<AiExecutionRecord>;
  updateExecution(
    id: string,
    update: Partial<
      Pick<
        AiExecutionRecord,
        "outputHash" | "status" | "errorCode" | "completedAt"
      >
    >
  ): Promise<AiExecutionRecord>;
  listExecutions(projectId: string): Promise<AiExecutionRecord[]>;
}
