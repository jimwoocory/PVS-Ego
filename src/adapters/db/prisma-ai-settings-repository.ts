import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  AiExecutionRecord,
  AiModelCapability,
  AiModelConfig,
  AiProviderConfig,
  AiSettingsRepository,
  AiStep,
  AiSystemPreference,
  ProjectAiPreference,
  StepModelOverride
} from "../../application/ports/ai-settings-repository.js";

function iso(value: Date): string {
  return value.toISOString();
}

export class PrismaAiSettingsRepository implements AiSettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private provider(record: {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    configVersion: number;
    defaultModelId: string | null;
    timeoutMs: number;
    maxRetries: number;
    hasSecret: boolean;
    connectionStatus: string;
    lastTestedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): AiProviderConfig {
    return {
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      enabled: record.enabled,
      configVersion: record.configVersion,
      ...(record.defaultModelId ? { defaultModelId: record.defaultModelId } : {}),
      timeoutMs: record.timeoutMs,
      maxRetries: record.maxRetries,
      hasSecret: record.hasSecret,
      connectionStatus:
        record.connectionStatus === "CONNECTED"
          ? "CONNECTED"
          : record.connectionStatus === "FAILED"
            ? "FAILED"
            : record.connectionStatus === "UNTESTED"
              ? "UNTESTED"
              : "UNCONFIGURED",
      ...(record.lastTestedAt
        ? { lastTestedAt: iso(record.lastTestedAt) }
        : {}),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt)
    };
  }

  private model(record: {
    id: string;
    providerId: string;
    modelId: string;
    displayName: string | null;
    enabled: boolean;
    source: string;
    capabilitiesJson: string;
    discoveredAt: Date;
  }): AiModelConfig {
    let capabilities: AiModelCapability[] = ["TEXT"];
    try {
      const parsed = JSON.parse(record.capabilitiesJson) as unknown;
      if (Array.isArray(parsed)) {
        const allowed = new Set<AiModelCapability>([
          "TEXT",
          "VISION",
          "AUDIO",
          "VIDEO",
          "OCR"
        ]);
        const normalized = parsed.filter(
          (item): item is AiModelCapability =>
            typeof item === "string" &&
            allowed.has(item as AiModelCapability)
        );
        if (normalized.length) capabilities = [...new Set(normalized)];
      }
    } catch {
      capabilities = ["TEXT"];
    }
    return {
      id: record.id,
      providerId: record.providerId,
      modelId: record.modelId,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      enabled: record.enabled,
      source:
        record.source === "MANUAL"
          ? "MANUAL"
          : record.source === "USER_DISABLED"
            ? "USER_DISABLED"
            : "DISCOVERED",
      capabilities,
      discoveredAt: iso(record.discoveredAt)
    };
  }

  async listProviders(): Promise<AiProviderConfig[]> {
    const rows = await this.prisma.aiProviderConfigRecord.findMany({
      orderBy: [{ enabled: "desc" }, { name: "asc" }]
    });
    return rows.map((row) => this.provider(row));
  }

  async getProvider(id: string): Promise<AiProviderConfig | null> {
    const row = await this.prisma.aiProviderConfigRecord.findUnique({
      where: { id }
    });
    return row ? this.provider(row) : null;
  }

  async upsertProvider(input: {
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
  }): Promise<AiProviderConfig> {
    const existing = await this.prisma.aiProviderConfigRecord.findUnique({
      where: { id: input.id }
    });
    const row = await this.prisma.aiProviderConfigRecord.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled,
        defaultModelId: input.defaultModelId ?? null,
        timeoutMs: input.timeoutMs,
        maxRetries: input.maxRetries,
        hasSecret: input.hasSecret,
        connectionStatus: input.connectionStatus,
        lastTestedAt: input.lastTestedAt ? new Date(input.lastTestedAt) : null,
        configVersion: 1
      },
      update: {
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled,
        defaultModelId: input.defaultModelId ?? null,
        timeoutMs: input.timeoutMs,
        maxRetries: input.maxRetries,
        hasSecret: input.hasSecret,
        connectionStatus: input.connectionStatus,
        lastTestedAt: input.lastTestedAt ? new Date(input.lastTestedAt) : null,
        configVersion: (existing?.configVersion ?? 0) + 1
      }
    });
    return this.provider(row);
  }

  async updateProviderConnectionStatus(
    id: string,
    status: AiProviderConfig["connectionStatus"],
    testedAt?: string
  ): Promise<AiProviderConfig> {
    const row = await this.prisma.aiProviderConfigRecord.update({
      where: { id },
      data: {
        connectionStatus: status,
        lastTestedAt: testedAt ? new Date(testedAt) : null
      }
    });
    return this.provider(row);
  }

  async listModels(providerId: string): Promise<AiModelConfig[]> {
    const rows = await this.prisma.aiModelRecord.findMany({
      where: { providerId },
      orderBy: [{ enabled: "desc" }, { modelId: "asc" }]
    });
    return rows.map((row) => this.model(row));
  }

  async upsertModels(
    providerId: string,
    models: Array<{
      modelId: string;
      displayName?: string;
      enabled?: boolean;
      source: "DISCOVERED" | "MANUAL";
      capabilities?: AiModelCapability[];
    }>
  ): Promise<AiModelConfig[]> {
    const discoveredAt = new Date();
    await this.prisma.$transaction(
      models.map((model) =>
        this.prisma.aiModelRecord.upsert({
          where: {
            providerId_modelId: {
              providerId,
              modelId: model.modelId
            }
          },
          create: {
            id: randomUUID(),
            providerId,
            modelId: model.modelId,
            displayName: model.displayName ?? null,
            enabled: model.enabled ?? true,
            source: model.source,
            capabilitiesJson: JSON.stringify(model.capabilities ?? ["TEXT"]),
            discoveredAt
          },
          update: {
            displayName: model.displayName ?? null,
            ...(model.enabled !== undefined
              ? { enabled: model.enabled }
              : {}),
            source: model.source,
            ...(model.capabilities
              ? { capabilitiesJson: JSON.stringify(model.capabilities) }
              : {}),
            discoveredAt
          }
        })
      )
    );
    return this.listModels(providerId);
  }

  async syncDiscoveredModels(
    providerId: string,
    models: Array<{
      modelId: string;
      displayName?: string;
    }>
  ): Promise<AiModelConfig[]> {
    const discoveredAt = new Date();
    const incomingIds = [...new Set(models.map((model) => model.modelId))];
    const protectedExisting = new Set(
      (
        await this.prisma.aiModelRecord.findMany({
          where: {
            providerId,
            source: { in: ["MANUAL", "USER_DISABLED"] },
            modelId: { in: incomingIds }
          },
          select: { modelId: true }
        })
      ).map((row) => row.modelId)
    );

    await this.prisma.$transaction([
      this.prisma.aiModelRecord.updateMany({
        where: {
          providerId,
          source: "DISCOVERED",
          ...(incomingIds.length
            ? { modelId: { notIn: incomingIds } }
            : {})
        },
        data: { enabled: false }
      }),
      ...models.map((model) =>
        protectedExisting.has(model.modelId)
          ? this.prisma.aiModelRecord.update({
              where: {
                providerId_modelId: {
                  providerId,
                  modelId: model.modelId
                }
              },
              data: {
                ...(model.displayName
                  ? { displayName: model.displayName }
                  : {}),
                discoveredAt
              }
            })
          : this.prisma.aiModelRecord.upsert({
              where: {
                providerId_modelId: {
                  providerId,
                  modelId: model.modelId
                }
              },
              create: {
                id: randomUUID(),
                providerId,
                modelId: model.modelId,
                displayName: model.displayName ?? null,
                enabled: true,
                source: "DISCOVERED",
                capabilitiesJson: JSON.stringify(["TEXT"]),
                discoveredAt
              },
              update: {
                displayName: model.displayName ?? null,
                enabled: true,
                source: "DISCOVERED",
                discoveredAt
              }
            })
      )
    ]);

    const incoming = new Set(incomingIds);
    return (await this.listModels(providerId)).filter(
      (model) => model.enabled && incoming.has(model.modelId)
    );
  }

  async getModel(
    providerId: string,
    modelId: string
  ): Promise<AiModelConfig | null> {
    const row = await this.prisma.aiModelRecord.findUnique({
      where: {
        providerId_modelId: { providerId, modelId }
      }
    });
    return row ? this.model(row) : null;
  }

  async setModelCapabilities(
    providerId: string,
    modelId: string,
    capabilities: AiModelCapability[]
  ): Promise<AiModelConfig> {
    const row = await this.prisma.aiModelRecord.update({
      where: { providerId_modelId: { providerId, modelId } },
      data: { capabilitiesJson: JSON.stringify(capabilities) }
    });
    return this.model(row);
  }

  async getSystemPreference(): Promise<AiSystemPreference> {
    const row = await this.prisma.aiSystemPreferenceRecord.upsert({
      where: { id: "system" },
      create: { id: "system" },
      update: {}
    });
    return {
      id: "system",
      ...(row.defaultProviderId ? { defaultProviderId: row.defaultProviderId } : {}),
      ...(row.defaultModelId ? { defaultModelId: row.defaultModelId } : {}),
      updatedAt: iso(row.updatedAt)
    };
  }

  async setSystemPreference(input: {
    defaultProviderId?: string;
    defaultModelId?: string;
  }): Promise<AiSystemPreference> {
    const row = await this.prisma.aiSystemPreferenceRecord.upsert({
      where: { id: "system" },
      create: {
        id: "system",
        defaultProviderId: input.defaultProviderId ?? null,
        defaultModelId: input.defaultModelId ?? null
      },
      update: {
        defaultProviderId: input.defaultProviderId ?? null,
        defaultModelId: input.defaultModelId ?? null
      }
    });
    return {
      id: "system",
      ...(row.defaultProviderId ? { defaultProviderId: row.defaultProviderId } : {}),
      ...(row.defaultModelId ? { defaultModelId: row.defaultModelId } : {}),
      updatedAt: iso(row.updatedAt)
    };
  }

  async getProjectPreference(projectId: string): Promise<ProjectAiPreference> {
    const row = await this.prisma.projectAiPreferenceRecord.upsert({
      where: { projectId },
      create: { projectId },
      update: {}
    });
    return {
      projectId,
      ...(row.defaultProviderId ? { defaultProviderId: row.defaultProviderId } : {}),
      ...(row.defaultModelId ? { defaultModelId: row.defaultModelId } : {}),
      updatedAt: iso(row.updatedAt)
    };
  }

  async setProjectPreference(
    projectId: string,
    input: {
      defaultProviderId?: string;
      defaultModelId?: string;
    }
  ): Promise<ProjectAiPreference> {
    const row = await this.prisma.projectAiPreferenceRecord.upsert({
      where: { projectId },
      create: {
        projectId,
        defaultProviderId: input.defaultProviderId ?? null,
        defaultModelId: input.defaultModelId ?? null
      },
      update: {
        defaultProviderId: input.defaultProviderId ?? null,
        defaultModelId: input.defaultModelId ?? null
      }
    });
    return {
      projectId,
      ...(row.defaultProviderId ? { defaultProviderId: row.defaultProviderId } : {}),
      ...(row.defaultModelId ? { defaultModelId: row.defaultModelId } : {}),
      updatedAt: iso(row.updatedAt)
    };
  }

  async listStepOverrides(projectId: string): Promise<StepModelOverride[]> {
    const rows = await this.prisma.stepModelOverrideRecord.findMany({
      where: { projectId },
      orderBy: { step: "asc" }
    });
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      step: row.step as AiStep,
      providerId: row.providerId,
      modelId: row.modelId,
      updatedAt: iso(row.updatedAt)
    }));
  }

  async getStepOverride(
    projectId: string,
    step: AiStep
  ): Promise<StepModelOverride | null> {
    const row = await this.prisma.stepModelOverrideRecord.findUnique({
      where: { projectId_step: { projectId, step } }
    });
    return row
      ? {
          id: row.id,
          projectId: row.projectId,
          step: row.step as AiStep,
          providerId: row.providerId,
          modelId: row.modelId,
          updatedAt: iso(row.updatedAt)
        }
      : null;
  }

  async setStepOverride(
    projectId: string,
    step: AiStep,
    selection: { providerId: string; modelId: string } | null
  ): Promise<StepModelOverride | null> {
    if (!selection) {
      await this.prisma.stepModelOverrideRecord.deleteMany({
        where: { projectId, step }
      });
      return null;
    }
    const row = await this.prisma.stepModelOverrideRecord.upsert({
      where: { projectId_step: { projectId, step } },
      create: {
        id: randomUUID(),
        projectId,
        step,
        providerId: selection.providerId,
        modelId: selection.modelId
      },
      update: {
        providerId: selection.providerId,
        modelId: selection.modelId
      }
    });
    return {
      id: row.id,
      projectId: row.projectId,
      step: row.step as AiStep,
      providerId: row.providerId,
      modelId: row.modelId,
      updatedAt: iso(row.updatedAt)
    };
  }

  async createExecution(
    record: AiExecutionRecord
  ): Promise<AiExecutionRecord> {
    const row = await this.prisma.aiExecutionRecord.create({
      data: {
        id: record.id,
        projectId: record.projectId,
        step: record.step,
        providerId: record.providerId,
        modelId: record.modelId,
        configVersion: record.configVersion,
        runtimeId: record.runtimeId,
        inputHash: record.inputHash,
        outputHash: record.outputHash ?? null,
        status: record.status,
        errorCode: record.errorCode ?? null,
        createdAt: new Date(record.createdAt),
        completedAt: record.completedAt ? new Date(record.completedAt) : null
      }
    });
    return this.execution(row);
  }

  async updateExecution(
    id: string,
    update: Partial<
      Pick<
        AiExecutionRecord,
        "outputHash" | "status" | "errorCode" | "completedAt"
      >
    >
  ): Promise<AiExecutionRecord> {
    const row = await this.prisma.aiExecutionRecord.update({
      where: { id },
      data: {
        ...(update.outputHash !== undefined
          ? { outputHash: update.outputHash ?? null }
          : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.errorCode !== undefined
          ? { errorCode: update.errorCode ?? null }
          : {}),
        ...(update.completedAt !== undefined
          ? { completedAt: update.completedAt ? new Date(update.completedAt) : null }
          : {})
      }
    });
    return this.execution(row);
  }

  async listExecutions(projectId: string): Promise<AiExecutionRecord[]> {
    const rows = await this.prisma.aiExecutionRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map((row) => this.execution(row));
  }

  private execution(record: {
    id: string;
    projectId: string;
    step: string;
    providerId: string;
    modelId: string;
    configVersion: number;
    runtimeId: string;
    inputHash: string;
    outputHash: string | null;
    status: string;
    errorCode: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }): AiExecutionRecord {
    return {
      id: record.id,
      projectId: record.projectId,
      step: record.step as AiStep,
      providerId: record.providerId,
      modelId: record.modelId,
      configVersion: record.configVersion,
      runtimeId: record.runtimeId,
      inputHash: record.inputHash,
      ...(record.outputHash ? { outputHash: record.outputHash } : {}),
      status: record.status === "FAILED" ? "FAILED" : "SUCCEEDED",
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      createdAt: iso(record.createdAt),
      ...(record.completedAt ? { completedAt: iso(record.completedAt) } : {})
    };
  }
}
