import test from "node:test";
import assert from "node:assert/strict";
import { SystemHealthService } from "../src/application/services/system-health-service.js";
import type { VideoProvider } from "../src/application/ports/video-provider.js";
import { H, ISO } from "./fixtures.js";

test("health recognizes the real Hermes fallback without claiming model authentication", async () => {
  const dependencies = baseDeps({aiProviders: []}) as ConstructorParameters<typeof SystemHealthService>[0];
  const service = new SystemHealthService({...dependencies, hermesFallbackAvailable: async () => true});
  const report = await service.check();
  const ai = report.items.find(item => item.group === "AI")!;
  assert.equal(ai.id, "ai:hermes-fallback");
  assert.equal(ai.severity, "WARN");
  assert.match(ai.detail!, /实际模型连接/);
});

test("failed fallback command remains blocked when no independent provider exists", async () => {
  const dependencies = baseDeps({aiProviders: []}) as ConstructorParameters<typeof SystemHealthService>[0];
  const service = new SystemHealthService({...dependencies, hermesFallbackAvailable: async () => {throw Error("missing CLI");}});
  const report = await service.check();
  assert.equal(report.items.find(item => item.group === "AI")!.severity, "BLOCKED");
});

function provider(input?: {
  ready?: boolean;
  authenticated?: boolean;
  onSubmit?: () => void;
}): VideoProvider {
  return {
    id: "domestic-jimeng-cli",
    probe: async () =>
      input?.ready === false
        ? {
            code: "DREAMINA_NOT_FOUND",
            cliFound: false,
            providerIdentityHash: H.a,
            capabilityFingerprint: H.b,
            rawStdout: "",
            rawStderr: ""
          }
        : {
            code: "READY",
            cliFound: true,
            identityVerified: true,
            executablePath: "dreamina",
            executableSha256: H.c,
            cliVersion: "test",
            providerIdentityHash: H.a,
            supportedOperations: ["text2video"],
            supportedModels: ["seedance2.0mini"],
            capabilityFingerprint: H.b,
            rawStdout: "",
            rawStderr: ""
          },
    accountStatus: async () => ({
      status: input?.authenticated === false ? "NOT_AUTHENTICATED" : "AUTHENTICATED",
      availableCredits: 100
    }),
    estimate: async () => ({ status: "UNKNOWN" }),
    submit: async () => {
      input?.onSubmit?.();
      throw new Error("submit should not be called");
    },
    status: async () => {
      throw new Error("status should not be called");
    },
    download: async () => {
      throw new Error("download should not be called");
    },
    reconcileSubmission: async () => {
      throw new Error("reconcile should not be called");
    }
  };
}

function baseDeps(input?: {
  aiProviders?: unknown[];
  dreaminaReady?: boolean;
  authenticated?: boolean;
  dbFails?: boolean;
  browserResearchUrl?: string;
  onSubmit?: () => void;
}) {
  return {
    aiSettings: {
      listProviders: async () =>
        input?.aiProviders ??
        [
          {
            id: "ai-1",
            name: "AIHubMix",
            baseUrl: "https://example.invalid/v1",
            enabled: true,
            configVersion: 1,
            timeoutMs: 30000,
            maxRetries: 1,
            hasSecret: true,
            connectionStatus: "CONNECTED",
            lastTestedAt: ISO,
            createdAt: ISO,
            updatedAt: ISO,
            defaultModelId: "deepseek-v4.1-flash",
            models: [
              {
                providerId: "ai-1",
                modelId: "deepseek-v4.1-flash",
                capabilities: {
                  structuredJson: true,
                  text: true,
                  vision: false,
                  audio: false
                },
                source: "MANUAL",
                createdAt: ISO,
                updatedAt: ISO
              }
            ]
          }
        ],
      getSystemPreference: async () => ({
        defaultProviderId: "ai-1",
        updatedAt: ISO
      })
    },
    productFlow: {
      listProjects: async () => [
        {
          id: "project-1",
          name: "Health Project",
          status: "DRAFT",
          targetPlatform: "douyin",
          targetDurationMs: 30000,
          aspectRatio: "9:16",
          createdAt: ISO,
          updatedAt: ISO
        }
      ],
      getProject: async (id: string) =>
        id === "project-1"
          ? {
              id: "project-1",
              name: "Health Project",
              status: "DRAFT",
              targetPlatform: "douyin",
              targetDurationMs: 30000,
              aspectRatio: "9:16",
              createdAt: ISO,
              updatedAt: ISO
            }
          : null
    },
    provider: provider({
      ready: input?.dreaminaReady,
      authenticated: input?.authenticated,
      onSubmit: input?.onSubmit
    }),
    publishBridge: {
      providerStatus: async () => ({
        preference: {
          projectId: "project-1",
          providerType: "MANUAL_EXPORT",
          updatedAt: ISO
        },
        probes: [
          {
            providerType: "MANUAL_EXPORT",
            displayName: "手动导出",
            mode: "MANUAL",
            code: "READY",
            supportsTrustedFinalConfirmation: false,
            requiresMobileDevice: false
          },
          {
            providerType: "DOUYIN_H5_HANDOFF",
            displayName: "抖音 H5",
            mode: "HANDOFF",
            code: "DISABLED",
            reason: "正式授权入口暂未启用",
            supportsTrustedFinalConfirmation: false,
            requiresMobileDevice: true
          }
        ]
      })
    },
    databasePing: async () => {
      if (input?.dbFails) throw new Error("database unavailable");
    },
    ffmpegPath: process.execPath,
    ffprobePath: process.execPath,
    browserResearchUrl: input?.browserResearchUrl ?? ""
  } as never;
}

test("health check is read-only and reports configured subsystems", async () => {
  let submits = 0;
  const service = new SystemHealthService(
    baseDeps({
      browserResearchUrl: "http://127.0.0.1:9999/research",
      onSubmit: () => {
        submits += 1;
      }
    })
  );

  const report = await service.check("project-1");
  assert.equal(submits, 0);
  assert.equal(report.projectId, "project-1");
  assert.ok(report.items.some((item) => item.id === "ai:ai-1" && item.severity === "READY"));
  assert.ok(report.items.some((item) => item.id === "dreamina:provider" && item.severity === "READY"));
  assert.ok(report.items.some((item) => item.id === "database:sqlite" && item.severity === "READY"));
  assert.ok(report.items.some((item) => item.id === "research:browser" && item.severity === "READY"));
  assert.ok(report.items.some((item) => item.id === "publish:MANUAL_EXPORT" && item.severity === "READY"));
  assert.ok(report.items.some((item) => item.id === "publish:DOUYIN_H5_HANDOFF" && item.severity === "WARN"));
});

test("missing AI key, Dreamina and database are BLOCKED while public search fallback keeps research at WARN", async () => {
  const service = new SystemHealthService(
    baseDeps({
      aiProviders: [
        {
          id: "ai-bad",
          name: "Missing Key",
          baseUrl: "https://example.invalid/v1",
          enabled: true,
          configVersion: 1,
          timeoutMs: 30000,
          maxRetries: 1,
          hasSecret: false,
          connectionStatus: "UNCONFIGURED",
          createdAt: ISO,
          updatedAt: ISO,
          models: []
        }
      ],
      dreaminaReady: false,
      dbFails: true,
      browserResearchUrl: ""
    })
  );

  const report = await service.check("project-1");
  assert.equal(report.overall, "BLOCKED");
  assert.ok(report.counts.BLOCKED >= 3);
  assert.ok(
    report.items.some(
      (item) =>
        item.id === "research:browser" &&
        item.severity === "WARN" &&
        item.technical?.publicSearchFallback === true
    )
  );
  assert.ok(
    report.items.some(
      (item) => item.id === "ai:ai-bad" && item.severity === "BLOCKED"
    )
  );
  assert.ok(
    report.items.some(
      (item) => item.id === "dreamina:provider" && item.severity === "BLOCKED"
    )
  );
  assert.ok(
    report.items.some(
      (item) => item.id === "database:sqlite" && item.severity === "BLOCKED"
    )
  );
});

test("installed Dreamina without authentication is an actionable blocker", async () => {
  const service = new SystemHealthService(
    baseDeps({ authenticated: false })
  );
  const report = await service.check("project-1");
  const item = report.items.find((entry) => entry.id === "dreamina:provider");
  assert.equal(item?.severity, "BLOCKED");
  assert.match(item?.summary ?? "", /尚未登录/);
});

test("authenticated CLI with invalid dynamic Skill registry remains BLOCKED without generation", async () => {
  let submitted=0;
  const dependencies = baseDeps({onSubmit:()=>{submitted++;}}) as ConstructorParameters<typeof SystemHealthService>[0];
  const service = new SystemHealthService({...dependencies,dreaminaRegistry:async()=>{throw new Error("Skill contract markers missing");}});
  const report = await service.check("project-1");
  const item = report.items.find(entry=>entry.id==="dreamina:provider");
  assert.equal(item?.severity,"BLOCKED");
  assert.equal(item?.technical?.code,"DYNAMIC_CAPABILITY_UNAVAILABLE");
  assert.equal(submitted,0);
});
