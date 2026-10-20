import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AiExecutionRecord,
  AiModelConfig,
  AiProviderConfig,
  AiSettingsRepository,
  AiStep,
  AiSystemPreference,
  ProjectAiPreference,
  StepModelOverride
} from "../src/application/ports/ai-settings-repository.js";
import type { SecretStore } from "../src/application/ports/secret-store.js";
import type {
  StructuredAiRequest,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import { AiSettingsService } from "../src/application/services/ai-settings-service.js";
import { AiRuntimeRouter } from "../src/adapters/ai/ai-runtime-router.js";
import { OpenAiCompatibleClient } from "../src/adapters/ai/openai-compatible-client.js";
import { WindowsDpapiSecretStore } from "../src/adapters/store/windows-dpapi-secret-store.js";

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async has(key: string) {
    return this.values.has(key);
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

class MemoryAiSettingsRepository implements AiSettingsRepository {
  readonly providers = new Map<string, AiProviderConfig>();
  readonly models = new Map<string, AiModelConfig>();
  readonly projectPreferences = new Map<string, ProjectAiPreference>();
  readonly overrides = new Map<string, StepModelOverride>();
  readonly executions: AiExecutionRecord[] = [];
  systemPreference: AiSystemPreference = {
    id: "system",
    updatedAt: new Date(0).toISOString()
  };

  async listProviders() {
    return [...this.providers.values()];
  }
  async getProvider(id: string) {
    return this.providers.get(id) ?? null;
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
  }) {
    const old = this.providers.get(input.id);
    const now = new Date().toISOString();
    const value: AiProviderConfig = {
      ...input,
      configVersion: (old?.configVersion ?? 0) + 1,
      createdAt: old?.createdAt ?? now,
      updatedAt: now
    };
    this.providers.set(input.id, value);
    return value;
  }
  async updateProviderConnectionStatus(
    id: string,
    status: AiProviderConfig["connectionStatus"],
    testedAt?: string
  ) {
    const old = this.providers.get(id);
    if (!old) throw new Error("missing provider");
    const value: AiProviderConfig = {
      ...old,
      connectionStatus: status,
      ...(testedAt ? { lastTestedAt: testedAt } : {}),
      updatedAt: new Date().toISOString()
    };
    this.providers.set(id, value);
    return value;
  }
  async listModels(providerId: string) {
    return [...this.models.values()].filter((m) => m.providerId === providerId);
  }
  async upsertModels(
    providerId: string,
    models: Array<{
      modelId: string;
      displayName?: string;
      enabled?: boolean;
      source: "DISCOVERED" | "MANUAL";
      capabilities?: AiModelConfig["capabilities"];
    }>
  ) {
    const now = new Date().toISOString();
    for (const model of models) {
      const key = providerId + "::" + model.modelId;
      const old = this.models.get(key);
      this.models.set(key, {
        id: old?.id ?? "model-" + key,
        providerId,
        modelId: model.modelId,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        enabled: model.enabled ?? true,
        source: model.source,
        capabilities: model.capabilities ?? old?.capabilities ?? ["TEXT"],
        discoveredAt: now
      });
    }
    return this.listModels(providerId);
  }
  async syncDiscoveredModels(
    providerId: string,
    models: Array<{ modelId: string; displayName?: string }>
  ) {
    const now = new Date().toISOString();
    const incoming = new Set(models.map((model) => model.modelId));
    for (const [key, current] of this.models.entries()) {
      if (
        current.providerId === providerId &&
        current.source === "DISCOVERED" &&
        !incoming.has(current.modelId)
      ) {
        this.models.set(key, { ...current, enabled: false });
      }
    }
    for (const model of models) {
      const key = providerId + "::" + model.modelId;
      const current = this.models.get(key);
      if (
        current?.source === "MANUAL" ||
        current?.source === "USER_DISABLED"
      ) {
        this.models.set(key, {
          ...current,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          discoveredAt: now
        });
        continue;
      }
      this.models.set(key, {
        id: current?.id ?? "model-" + key,
        providerId,
        modelId: model.modelId,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        enabled: true,
        source: "DISCOVERED",
        capabilities: current?.capabilities ?? ["TEXT"],
        discoveredAt: now
      });
    }
    return (await this.listModels(providerId)).filter(
      (model) => model.enabled && incoming.has(model.modelId)
    );
  }
  async getModel(providerId: string, modelId: string) {
    return this.models.get(providerId + "::" + modelId) ?? null;
  }
  async setModelCapabilities(
    providerId: string,
    modelId: string,
    capabilities: AiModelConfig["capabilities"]
  ) {
    const key = providerId + "::" + modelId;
    const current = this.models.get(key);
    if (!current) throw new Error("missing model");
    const next = { ...current, capabilities: [...capabilities] };
    this.models.set(key, next);
    return next;
  }
  async getSystemPreference() {
    return this.systemPreference;
  }
  async setSystemPreference(input: {
    defaultProviderId?: string;
    defaultModelId?: string;
  }) {
    this.systemPreference = {
      id: "system",
      ...input,
      updatedAt: new Date().toISOString()
    };
    return this.systemPreference;
  }
  async getProjectPreference(projectId: string) {
    return (
      this.projectPreferences.get(projectId) ?? {
        projectId,
        updatedAt: new Date(0).toISOString()
      }
    );
  }
  async setProjectPreference(
    projectId: string,
    input: { defaultProviderId?: string; defaultModelId?: string }
  ) {
    const value = {
      projectId,
      ...input,
      updatedAt: new Date().toISOString()
    };
    this.projectPreferences.set(projectId, value);
    return value;
  }
  async listStepOverrides(projectId: string) {
    return [...this.overrides.values()].filter((x) => x.projectId === projectId);
  }
  async getStepOverride(projectId: string, step: AiStep) {
    return this.overrides.get(projectId + "::" + step) ?? null;
  }
  async setStepOverride(
    projectId: string,
    step: AiStep,
    selection: { providerId: string; modelId: string } | null
  ) {
    const key = projectId + "::" + step;
    if (!selection) {
      this.overrides.delete(key);
      return null;
    }
    const value: StepModelOverride = {
      id: "override-" + key,
      projectId,
      step,
      ...selection,
      updatedAt: new Date().toISOString()
    };
    this.overrides.set(key, value);
    return value;
  }
  async createExecution(record: AiExecutionRecord) {
    this.executions.push(record);
    return record;
  }
  async updateExecution(
    id: string,
    update: Partial<
      Pick<
        AiExecutionRecord,
        "outputHash" | "status" | "errorCode" | "completedAt"
      >
    >
  ) {
    const index = this.executions.findIndex((x) => x.id === id);
    if (index < 0) throw new Error("missing execution");
    const value = { ...this.executions[index]!, ...update };
    this.executions[index] = value;
    return value;
  }
  async listExecutions(projectId: string) {
    return this.executions.filter((x) => x.projectId === projectId);
  }
}

class FallbackRuntime implements StructuredAiRuntime {
  readonly id = "hermes-agent";
  readonly version = "test";
  calls = 0;
  async generateJson(): Promise<unknown> {
    this.calls += 1;
    return { fallback: true };
  }
}

async function startMockOpenAi(
  initialModels: Array<{ id: string; name?: string }> = [
    { id: "model-a", name: "Model A" }
  ]
) {
  let models = [...initialModels];
  const requests: Array<{
    path: string;
    authorization?: string;
    body?: string;
  }> = [];
  const server = http.createServer(async (req, res) => {
    const record: {
      path: string;
      authorization?: string;
      body?: string;
    } = {
      path: req.url ?? "",
      ...(typeof req.headers.authorization === "string"
        ? { authorization: req.headers.authorization }
        : {})
    };
    requests.push(record);
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      record.body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }]
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    setModels(next: Array<{ id: string; name?: string }>) {
      models = [...next];
    }
  };
}

test("P1 AI settings discover models and router records actual provider/model", async () => {
  const mock = await startMockOpenAi();
  const repo = new MemoryAiSettingsRepository();
  const secrets = new MemorySecretStore();
  const client = new OpenAiCompatibleClient();
  const settings = new AiSettingsService(repo, secrets, client);
  try {
    const provider = await settings.saveProvider({
      id: "provider-a",
      name: "Test Provider",
      baseUrl: mock.baseUrl,
      apiKey: "only-in-secret-store",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0
    });
    assert.equal(provider.hasSecret, true);
    assert.equal(JSON.stringify(provider).includes("only-in-secret-store"), false);

    const models = await settings.refreshModels(provider.id);
    assert.equal(models[0]?.modelId, "model-a");
    assert.equal((await repo.getProvider(provider.id))?.connectionStatus, "CONNECTED");
    await settings.setSystemPreference({
      defaultProviderId: provider.id,
      defaultModelId: "model-a"
    });

    const fallback = new FallbackRuntime();
    const router = new AiRuntimeRouter(settings, repo, fallback, client);
    const request: StructuredAiRequest = {
      task: "return ok",
      instructions: "strict json",
      input: { a: 1 },
      outputContract: { ok: true },
      context: { projectId: "project-1", step: "CREATIVE" }
    };
    const result = await router.generateJsonWithMetadata(request);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(result.metadata?.providerId, "provider-a");
    assert.equal(result.metadata?.modelId, "model-a");
    assert.equal(fallback.calls, 0);
    assert.equal(repo.executions.length, 1);
    assert.equal(repo.executions[0]?.providerId, "provider-a");
    assert.equal(repo.executions[0]?.modelId, "model-a");
    assert.equal(JSON.stringify(repo.executions).includes("only-in-secret-store"), false);
    assert.equal(mock.requests.every((x) => x.authorization === "Bearer only-in-secret-store"), true);
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test("refreshModels disables stale DISCOVERED models, preserves MANUAL models, and excludes stale capability fallback", async () => {
  const mock = await startMockOpenAi([
    { id: "remote-a", name: "Remote A" },
    { id: "remote-b", name: "Remote B" },
    { id: "remote-disabled", name: "Remote Disabled" }
  ]);
  const repo = new MemoryAiSettingsRepository();
  const secrets = new MemorySecretStore();
  const settings = new AiSettingsService(
    repo,
    secrets,
    new OpenAiCompatibleClient()
  );
  try {
    const provider = await settings.saveProvider({
      id: "provider-sync",
      name: "Sync Provider",
      baseUrl: mock.baseUrl,
      apiKey: "sync-secret",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0
    });

    const first = await settings.refreshModels(provider.id);
    assert.deepEqual(
      first.map((model) => model.modelId).sort(),
      ["remote-a", "remote-b", "remote-disabled"]
    );
    await settings.setModelCapabilities(
      provider.id,
      "remote-b",
      ["TEXT", "VISION"]
    );
    await settings.addManualModel(
      provider.id,
      "manual-only",
      "Manual Only",
      ["TEXT"]
    );
    const disabledKey = provider.id + "::remote-disabled";
    const toDisable = repo.models.get(disabledKey);
    assert.ok(toDisable);
    repo.models.set(disabledKey, {
      ...toDisable!,
      enabled: false,
      source: "USER_DISABLED"
    });

    mock.setModels([
      { id: "remote-a", name: "Remote A" },
      { id: "remote-disabled", name: "Remote Disabled" }
    ]);
    const refreshed = await settings.refreshModels(provider.id);
    assert.deepEqual(
      refreshed.map((model) => model.modelId),
      ["remote-a"]
    );

    const stale = await repo.getModel(provider.id, "remote-b");
    assert.equal(stale?.enabled, false);
    assert.equal(stale?.source, "DISCOVERED");

    const manual = await repo.getModel(provider.id, "manual-only");
    assert.equal(manual?.enabled, true);
    assert.equal(manual?.source, "MANUAL");

    const userDisabled = await repo.getModel(
      provider.id,
      "remote-disabled"
    );
    assert.equal(userDisabled?.enabled, false);
    assert.equal(userDisabled?.source, "USER_DISABLED");

    const visibleProvider = (await settings.listProviders()).find(
      (item) => item.id === provider.id
    );
    assert.deepEqual(
      visibleProvider?.models.map((model) => model.modelId).sort(),
      ["manual-only", "remote-a"]
    );

    await assert.rejects(
      settings.resolveForCapabilities(
        "project-sync",
        "RESEARCH",
        ["VISION"]
      ),
      /当前没有配置支持 VISION 的可用模型/
    );
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test("OpenAI-compatible runtime sends sampled reference frames as multimodal image_url content", async () => {
  const mock = await startMockOpenAi();
  const repo = new MemoryAiSettingsRepository();
  const secrets = new MemorySecretStore();
  const client = new OpenAiCompatibleClient();
  const settings = new AiSettingsService(repo, secrets, client);
  try {
    const provider = await settings.saveProvider({
      id: "vision-provider",
      name: "Vision Provider",
      baseUrl: mock.baseUrl,
      apiKey: "vision-secret",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0
    });
    await settings.addManualModel(
      provider.id,
      "model-a",
      "Vision Model",
      ["TEXT", "VISION", "OCR"]
    );
    await settings.setStepOverride(
      "project-vision",
      "REFERENCE_VIDEO_ANALYSIS",
      { providerId: provider.id, modelId: "model-a" }
    );
    const router = new AiRuntimeRouter(
      settings,
      repo,
      new FallbackRuntime(),
      client
    );
    await router.generateJsonWithMetadata({
      task: "analyze frames",
      instructions: "strict json",
      input: { durationMs: 10000 },
      outputContract: { ok: true },
      media: [
        {
          type: "image",
          mimeType: "image/jpeg",
          dataBase64: Buffer.from("fake-jpeg").toString("base64"),
          label: "sample@0ms"
        }
      ],
      context: {
        projectId: "project-vision",
        step: "REFERENCE_VIDEO_ANALYSIS"
      }
    });
    const chat = mock.requests.find(
      (item) => item.path === "/v1/chat/completions"
    );
    assert.ok(chat?.body);
    const body = JSON.parse(chat.body) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const user = body.messages?.find((item) => item.role === "user");
    assert.equal(Array.isArray(user?.content), true);
    const parts = user!.content as Array<{
      type?: string;
      image_url?: { url?: string };
    }>;
    assert.equal(
      parts.some(
        (part) =>
          part.type === "image_url" &&
          part.image_url?.url?.startsWith("data:image/jpeg;base64,")
      ),
      true
    );
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test("P1 AI model resolution honors step > project > system > provider default > Hermes fallback", async () => {
  const repo = new MemoryAiSettingsRepository();
  const secrets = new MemorySecretStore();
  const settings = new AiSettingsService(repo, secrets);
  await settings.saveProvider({
    id: "p",
    name: "Provider",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 0
  });
  await settings.addManualModel("p", "system-model");
  await settings.addManualModel("p", "project-model");
  await settings.addManualModel("p", "step-model");
  await settings.setSystemPreference({
    defaultProviderId: "p",
    defaultModelId: "system-model"
  });
  assert.equal((await settings.resolve("x", "SCRIPT")).modelId, "system-model");

  await settings.setProjectPreference("x", {
    defaultProviderId: "p",
    defaultModelId: "project-model"
  });
  assert.equal((await settings.resolve("x", "SCRIPT")).modelId, "project-model");

  await settings.setStepOverride("x", "SCRIPT", {
    providerId: "p",
    modelId: "step-model"
  });
  assert.equal((await settings.resolve("x", "SCRIPT")).modelId, "step-model");
  assert.equal((await settings.resolve("x", "DIRECTOR")).modelId, "project-model");

  await settings.setStepOverride("x", "SCRIPT", null);
  await settings.setProjectPreference("x", {});
  await settings.setSystemPreference({});
  await settings.saveProvider({
    id: "p",
    name: "Provider",
    baseUrl: "https://example.test/v1",
    enabled: true,
    defaultModelId: "system-model",
    timeoutMs: 5000,
    maxRetries: 0
  });
  const providerDefault = await settings.resolve("x", "SCRIPT");
  assert.equal(providerDefault.source, "PROVIDER_DEFAULT");
  assert.equal(providerDefault.modelId, "system-model");

  await settings.saveProvider({
    id: "p",
    name: "Provider",
    baseUrl: "https://example.test/v1",
    enabled: false,
    defaultModelId: "system-model",
    timeoutMs: 5000,
    maxRetries: 0
  });
  const fallback = await settings.resolve("x", "SCRIPT");
  assert.equal(fallback.source, "HERMES_FALLBACK");
});

test("verified native Hermes vision stays on the current fallback and does not authorize audio", async () => {
  const settings=new AiSettingsService(new MemoryAiSettingsRepository(),new MemorySecretStore(),undefined,async required=>required.length===1&&required[0]==="VISION");
  assert.equal((await settings.resolveForCapabilities("project-x","REFERENCE_VIDEO_ANALYSIS",["VISION"])).source,"HERMES_FALLBACK");
  await assert.rejects(settings.resolveForCapabilities("project-x","REFERENCE_VIDEO_ANALYSIS",["AUDIO"]),/AUDIO/);
  const unverified=new AiSettingsService(new MemoryAiSettingsRepository(),new MemorySecretStore());
  await assert.rejects(unverified.resolveForCapabilities("project-x","REFERENCE_VIDEO_ANALYSIS",["VISION"]),/VISION/);
});

test("P1 AI settings refuse selecting a provider without an API key", async () => {
  const repo = new MemoryAiSettingsRepository();
  const settings = new AiSettingsService(repo, new MemorySecretStore());
  await settings.saveProvider({
    id: "no-secret",
    name: "No Secret",
    baseUrl: "https://example.test/v1",
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 0
  });
  await settings.addManualModel("no-secret", "model-a");
  await assert.rejects(
    settings.setProjectPreference("project-x", {
      defaultProviderId: "no-secret",
      defaultModelId: "model-a"
    }),
    /API Key/
  );
  await assert.rejects(
    settings.setStepOverride("project-x", "SCRIPT", {
      providerId: "no-secret",
      modelId: "model-a"
    }),
    /API Key/
  );
});

test(
  "Windows DPAPI secret store encrypts provider API keys at rest",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-dpapi-"));
    try {
      const store = new WindowsDpapiSecretStore(root);
      const value = "dpapi-test-secret-12345";
      await store.set("provider-x", value);
      assert.equal(await store.get("provider-x"), value);
      const raw = await fs.readFile(path.join(root, "provider-x.json"), "utf8");
      assert.equal(raw.includes(value), false);
      assert.equal(JSON.parse(raw).scheme, "windows-dpapi-current-user");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
