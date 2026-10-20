import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { GenerationPreflightService } from "../src/application/services/generation-preflight.js";
import {
  buildVerifiedDreaminaRuntime,
  createConfiguredDomesticJimengProvider
} from "../src/adapters/video/verified-dreamina-runtime-loader.js";
import { ProviderNotReadyError } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import type { CommandExecution } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import type {
  CreativeBatch,
  ProductionPlan,
  ScriptDraft
} from "../src/domain/schemas.js";
import { H, ISO, makeProductTruth, makeValidClip } from "./fixtures.js";

process.env.DATABASE_URL ??= "file:./dev.db";

test("production Dreamina runtime treats logged-out user_credit and CLI permission denial as terminal, not unknown", async () => {
  const config = JSON.parse(
    await fs.readFile(
      path.resolve(process.cwd(), "config", "dreamina-runtime.verified.json"),
      "utf8"
    )
  );
  const runtime = buildVerifiedDreaminaRuntime(config);
  assert.equal(
    runtime.account?.parse({
      stdout: JSON.stringify({ total_credit: 0, user_id: 0, user_name: "", vip_level: "" }),
      stderr: "",
      exitCode: 0,
      timedOut: false
    }).status,
    "NOT_AUTHENTICATED"
  );
  assert.equal(
    runtime.submit?.classifyFailure?.({
      stdout: "",
      stderr: "当前账号没有 dreamina_cli 使用权限: current account is not allowed to use dreamina_cli",
      exitCode: 1,
      timedOut: false
    }),
    "FAILED"
  );
});

function makeConfig(executablePath: string, executableSha256: string) {
  return {
    schemaVersion: "p0-v1",
    identity: {
      id: "verified-dreamina-runtime-test",
      officialSourceUrl: "https://official.example.test/dreamina",
      publisher: "Official Test Publisher",
      executablePath,
      executableSha256,
      cliVersion: "1.2.3",
      officialLoginOrigins: ["https://login.example.test/"],
      verificationStatus: "VERIFIED",
      verifiedAt: ISO
    },
    probe: {
      versionArgs: ["--version"],
      helpArgs: ["--help"],
      versionRegex: "dreamina\\s+1\\.2\\.3",
      helpRequiredFragments: [
        "seedance-2.0",
        "submit",
        "status",
        "download"
      ],
      supportedOperations: [
        "accountStatus",
        "estimate",
        "submit",
        "status",
        "download",
        "reconcileSubmission"
      ],
      supportedModels: ["seedance-2.0"],
      supportedDurationsMs: [8000]
    },
    account: {
      args: ["account", "status"],
      authenticatedRegex: "AUTHENTICATED",
      notAuthenticatedRegex: "NOT_AUTHENTICATED"
    },
    estimate: {
      argsTemplate: ["estimate", "{requestCount}"],
      creditsRegex: "credits=(\\d+)"
    },
    submit: {
      argsTemplate: [
        "submit",
        "--model",
        "{model}",
        "--duration-ms",
        "{durationMs}",
        "--prompt",
        "{promptText}"
      ],
      taskIdRegex: "task=([A-Za-z0-9_-]+)",
      failedRegex: "FAILED",
      outcomeUnknownRegex: "UNKNOWN_OUTCOME"
    },
    status: {
      argsTemplate: ["status", "{externalTaskId}"],
      submittedRegex: "SUBMITTED",
      processingRegex: "PROCESSING",
      succeededRegex: "SUCCEEDED",
      failedRegex: "FAILED"
    },
    download: {
      argsTemplate: ["download", "{externalTaskId}", "{outputPath}"]
    },
    reconcile: {
      argsTemplate: [
        "reconcile",
        "{requestHash}",
        "{submissionFingerprint}"
      ],
      foundActiveRegex: "ACTIVE",
      foundSucceededRegex: "SUCCEEDED",
      foundFailedRegex: "FAILED",
      notFoundRegex: "NOT_FOUND",
      taskIdRegex: "task=([A-Za-z0-9_-]+)",
      failureReasonRegex: "reason=([^\\r\\n]+)"
    }
  };
}

function makeBatch(projectId: string): CreativeBatch {
  return {
    id: "batch-ready",
    projectId,
    version: 1,
    status: "ACTIVE",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-1",
      version: 1,
      hash: H.a
    },
    generatorVersion: "test",
    concepts: Array.from({ length: 4 }, (_, index) => ({
      id: `creative-${index + 1}`,
      title: `Concept ${index + 1}`,
      targetAudience: "buyers",
      painPoint: "need",
      hook: "hook",
      coreSellingPoint: "Feature one",
      narrativePattern: "problem-solution",
      expectedDurationMs: 60000,
      productShowcaseStrategy: "hero",
      generationRisk: "LOW" as const,
      requiredFactIds: ["fact-1"]
    })),
    selectedCreativeId: "creative-1",
    contentHash: H.b,
    createdAt: ISO
  };
}

function makeScript(projectId: string, batch: CreativeBatch): ScriptDraft {
  return {
    id: "script-ready",
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: batch.productTruthRef,
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: batch.id,
      version: batch.version,
      hash: batch.contentHash
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 60000,
    beats: [
      {
        id: "beat-1",
        order: 1,
        purpose: "PRODUCT",
        text: "Feature one",
        estimatedDurationMs: 60000,
        requiredFactIds: ["fact-1"]
      }
    ],
    contentHash: H.c,
    confirmedAt: ISO
  };
}

function makePlan(
  projectId: string,
  script: ScriptDraft
): ProductionPlan {
  const truth = makeProductTruth();
  const clip = makeValidClip();
  return {
    id: "plan-ready",
    projectId,
    version: 1,
    status: "CONFIRMED",
    productTruthRef: script.productTruthRef,
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    selectedCreativeId: script.selectedCreativeId,
    visualDirection: "studio",
    soundDirection: "clean",
    productShowcaseRules: ["show product"],
    continuityLock: {
      product: {
        stableAttributes: ["logo"],
        forbiddenChanges: structuredClone(truth.forbiddenChanges)
      },
      characters: [],
      environments: [
        { sceneId: "scene-1", stableElements: ["studio"] }
      ]
    },
    scenes: [
      {
        id: "scene-1",
        order: 1,
        purpose: "product",
        location: "studio",
        visualState: "clean",
        sourceBeatIds: ["beat-1"],
        requiredFactIds: ["fact-1"],
        clips: [clip]
      }
    ],
    contentHash: H.e,
    confirmedAt: ISO
  };
}

test("verified runtime config drives installed CLI to READY Preflight and persists identity/audit evidence", async () => {
  process.env.NODE_ENV = "test";
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-verified-dreamina-")
  );
  const executable = path.join(temp, "dreamina.exe");
  const configPath = path.join(temp, "dreamina-runtime.verified.json");
  const projectsRoot = path.join(temp, "projects");
  const bytes = Buffer.from("verified-dreamina-binary", "utf8");
  await fs.writeFile(executable, bytes);
  const executableSha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await fs.writeFile(
    configPath,
    JSON.stringify(makeConfig(executable, executableSha256), null, 2),
    "utf8"
  );

  const calls: string[][] = [];
  const runner = async (
    _executablePath: string,
    args: readonly string[]
  ): Promise<CommandExecution> => {
    calls.push([...args]);
    if (args[0] === "--version") {
      return {
        stdout: "dreamina 1.2.3",
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    if (args[0] === "--help") {
      return {
        stdout:
          "seedance-2.0 submit status download account estimate reconcile",
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    if (args[0] === "account") {
      return {
        stdout: "AUTHENTICATED",
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    if (args[0] === "estimate") {
      return {
        stdout: "credits=2",
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false
    };
  };

  const provider = createConfiguredDomesticJimengProvider({
    configPath,
    locateExecutable: async () => executable,
    runner
  });

  const db = new PrismaClient();
  const projectId = `verified-ready-${randomUUID()}`;
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const generation = new PrismaGenerationRepository(db);
  const workflow = new PrismaWorkflowRepository(db);
  const artifacts = new PrismaArtifactRepository(db);
  const providerAudit = new PrismaProviderAuditRepository(db);
  try {
    const now = new Date().toISOString();
    await productFlow.createProject({
      id: projectId,
      name: "Verified Dreamina Ready",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 60000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    });

    const truth = {
      ...makeProductTruth(),
      projectId
    };
    const batch = makeBatch(projectId);
    const script = makeScript(projectId, batch);
    const plan = makePlan(projectId, script);
    const service = new GenerationPreflightService(
      generation,
      workflow,
      provider,
      (pid, entityKey) =>
        productFlow.nextVersion(pid, "CompiledPrompt", entityKey)
    );

    const result = await service.run({
      projectId,
      productTruth: truth,
      creativeBatch: batch,
      script,
      productionPlan: plan,
      assets: []
    });

    assert.equal(result.probe.code, "READY");
    assert.equal(result.authenticated, true);
    assert.equal(result.costEstimate.status, "KNOWN");
    assert.equal(result.costEstimate.estimatedCredits, 2);
    assert.equal(result.overallStatus, "PASS");
    assert.equal(result.reports[0]?.status, "PASS");
    assert.equal(result.reports[0]?.blockers.length, 0);

    const { persistPreflightProviderAudit } = await import(
      "../src/web/server.js"
    );
    const audit = await persistPreflightProviderAudit(
      {
        provider,
        providerAudit,
        artifacts,
        projectsRoot
      } as any,
      projectId,
      result.probe
    );
    assert.equal(audit.providerIdentityId, "verified-dreamina-runtime-test");
    assert.equal(audit.commandAttemptIds.length, 4);

    const identity = await db.providerIdentityRecord.findUnique({
      where: { id: "verified-dreamina-runtime-test" }
    });
    assert.equal(identity?.verificationStatus, "VERIFIED");
    assert.equal(identity?.executableSha256, executableSha256);
    assert.ok(identity?.rawVersionArtifactId);
    assert.ok(identity?.rawHelpArtifactId);

    const commands =
      await providerAudit.listCommandAttempts(projectId);
    assert.deepEqual(
      commands.map((item) => item.operation).sort(),
      ["ACCOUNT", "ESTIMATE", "PROBE", "PROBE"].sort()
    );
    for (const command of commands) {
      assert.ok(command.stdoutArtifactId);
      assert.ok(command.stderrArtifactId);
      assert.ok(
        (await artifacts.findById(command.stdoutArtifactId!))
          ?.integrityStatus === "READY"
      );
      assert.ok(
        (await artifacts.findById(command.stderrArtifactId!))
          ?.integrityStatus === "READY"
      );
    }

    assert.ok(calls.some((args) => args[0] === "--version"));
    assert.ok(calls.some((args) => args[0] === "--help"));
    assert.ok(calls.some((args) => args[0] === "account"));
    assert.ok(calls.some((args) => args[0] === "estimate"));
  } finally {
    await db.commandAttemptRecord.deleteMany({ where: { projectId } });
    await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
    await db.providerIdentityRecord.deleteMany({ where: { projectId } });
    await db.generationAttemptRecord.deleteMany({ where: { projectId } });
    await db.userApprovalRecord.deleteMany({ where: { projectId } });
    await db.preflightReportRecord.deleteMany({ where: { projectId } });
    await db.generationRequestRecord.deleteMany({ where: { projectId } });
    await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
    await db.artifactRecord.deleteMany({ where: { projectId } });
    await db.versionedEntity.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("verified runtime config rejects credential material and hash mismatch fails closed", async () => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-verified-dreamina-block-")
  );
  const executable = path.join(temp, "dreamina.exe");
  const bytes = Buffer.from("verified-dreamina-binary", "utf8");
  await fs.writeFile(executable, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");

  try {
    const credentialConfig = makeConfig(executable, hash);
    credentialConfig.submit.argsTemplate.push("--token", "literal-secret");
    assert.throws(
      () => buildVerifiedDreaminaRuntime(credentialConfig),
      (error: unknown) =>
        error instanceof ProviderNotReadyError &&
        /must not contain credential/.test(error.message)
    );

    const badHashConfig = makeConfig(executable, "f".repeat(64));
    const runtime = buildVerifiedDreaminaRuntime(badHashConfig);
    let executed = false;
    const { DomesticJimengCliProvider } = await import(
      "../src/adapters/video/domestic-jimeng-cli-provider.js"
    );
    const provider = new DomesticJimengCliProvider(
      async () => executable,
      runtime,
      async () => {
        executed = true;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false
        };
      }
    );
    const probe = await provider.probe();
    assert.equal(probe.code, "PROVIDER_IDENTITY_UNVERIFIED");
    assert.equal(executed, false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
