import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DomesticJimengCliProvider,
  ProviderNotReadyError,
  type CommandExecution,
  type CommandRunner,
  type LocateExecutable,
  type ResolveGenerationAssets,
  type ResolvedGenerationAsset,
  type VerifiedDreaminaRuntime
} from "./domestic-jimeng-cli-provider.js";
import type { GenerationRequest } from "../../domain/schemas.js";
import { assertAssetImageBindings } from "../../application/services/asset-image-bindings.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const nonEmpty = z.string().trim().min(1);
const argsSchema = z.array(nonEmpty).min(1);

function regexSchema(label: string) {
  return nonEmpty.superRefine((value, ctx) => {
    try {
      new RegExp(value, "i");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `${label} must be a valid regular expression`
      });
    }
  });
}

const identitySchema = z
  .object({
    id: nonEmpty,
    officialSourceUrl: z.string().url(),
    publisher: nonEmpty.optional(),
    packageName: nonEmpty.optional(),
    executablePath: nonEmpty,
    executableSha256: sha256Schema,
    signatureInfo: nonEmpty.optional(),
    cliVersion: nonEmpty,
    officialLoginOrigins: z.array(z.string().url()).min(1),
    verificationStatus: z.literal("VERIFIED"),
    verifiedAt: z.string().datetime()
  })
  .superRefine((identity, ctx) => {
    if (!identity.publisher && !identity.packageName) {
      ctx.addIssue({
        code: "custom",
        path: ["publisher"],
        message: "VERIFIED identity requires publisher or packageName"
      });
    }
    if (!path.isAbsolute(identity.executablePath)) {
      ctx.addIssue({
        code: "custom",
        path: ["executablePath"],
        message: "VERIFIED executablePath must be absolute"
      });
    }
  });

const configSchema = z.object({
  schemaVersion: z.literal("p0-v1"),
  identity: identitySchema,
  probe: z.object({
    versionArgs: argsSchema,
    helpArgs: argsSchema,
    versionRegex: regexSchema("versionRegex"),
    helpRequiredFragments: z.array(nonEmpty).min(1),
    supportedOperations: z.array(nonEmpty).min(1),
    supportedModels: z.array(nonEmpty).min(1),
    supportedDurationsMs: z.array(z.number().int().positive()).min(1)
  }),
  account: z.object({
    args: argsSchema,
    authenticatedRegex: regexSchema("authenticatedRegex"),
    notAuthenticatedRegex: regexSchema("notAuthenticatedRegex"),
    creditsRegex: regexSchema("account.creditsRegex").optional()
  }),
  estimate: z.object({
    argsTemplate: argsSchema,
    creditsRegex: regexSchema("creditsRegex").optional(),
    costTextRegex: regexSchema("costTextRegex").optional()
  }).optional(),
  submit: z.object({
    argsTemplate: argsSchema,
    modelVersionMap: z.record(z.string(), nonEmpty).optional(),
    assetFlag: nonEmpty.optional(),
    minAssets: z.number().int().nonnegative().optional(),
    taskIdRegex: regexSchema("taskIdRegex").optional(),
    submitIdRegex: regexSchema("submitIdRegex").optional(),
    opaqueHandleRegex: regexSchema("opaqueHandleRegex").optional(),
    failedRegex: regexSchema("failedRegex").optional(),
    outcomeUnknownRegex: regexSchema("outcomeUnknownRegex").optional()
  }),
  status: z.object({
    argsTemplate: argsSchema,
    submittedRegex: regexSchema("submittedRegex").optional(),
    processingRegex: regexSchema("processingRegex"),
    succeededRegex: regexSchema("succeededRegex"),
    failedRegex: regexSchema("failedRegex")
  }),
  download: z.object({
    argsTemplate: argsSchema,
    outputMode: z.enum(["FILE", "DIRECTORY"]).optional()
  }),
  reconcile: z.object({
    argsTemplate: argsSchema,
    foundActiveRegex: regexSchema("foundActiveRegex"),
    foundSucceededRegex: regexSchema("foundSucceededRegex"),
    foundFailedRegex: regexSchema("foundFailedRegex"),
    notFoundRegex: regexSchema("notFoundRegex"),
    taskIdRegex: regexSchema("reconcile.taskIdRegex").optional(),
    failureReasonRegex: regexSchema("failureReasonRegex").optional()
  })
});

export type VerifiedDreaminaRuntimeConfig = z.infer<typeof configSchema>;

const forbiddenCredentialPattern =
  /(?:access[-_]?token|refresh[-_]?token|authorization|cookie|password|secret|session[-_]?(?:id|key)|--?token)/i;

function assertNoCredentialMaterial(config: VerifiedDreaminaRuntimeConfig): void {
  const commandArgs = [
    ...config.probe.versionArgs,
    ...config.probe.helpArgs,
    ...config.account.args,
    ...(config.estimate?.argsTemplate ?? []),
    ...config.submit.argsTemplate,
    ...config.status.argsTemplate,
    ...config.download.argsTemplate,
    ...config.reconcile.argsTemplate
  ];
  const offenders = commandArgs.filter((arg) =>
    forbiddenCredentialPattern.test(arg)
  );
  if (offenders.length) {
    throw new ProviderNotReadyError(
      "Verified dreamina runtime config must not contain credential/token/cookie/password arguments"
    );
  }
}

function combined(result: CommandExecution): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function regex(value: string): RegExp {
  return new RegExp(value, "i");
}

function capture(pattern: string | undefined, text: string): string | undefined {
  if (!pattern) return undefined;
  const match = regex(pattern).exec(text);
  if (!match) return undefined;
  const named = match.groups?.value;
  return (named ?? match[1] ?? match[0])?.trim();
}

function assertRegex(pattern: string, text: string, label: string): void {
  if (!regex(pattern).test(text)) {
    throw new ProviderNotReadyError(
      `Verified dreamina runtime ${label} did not match current CLI output`
    );
  }
}

function expandArgs(
  template: readonly string[],
  values: Record<string, string>
): string[] {
  return template.map((part) =>
    part.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
      if (!(key in values)) {
        throw new ProviderNotReadyError(
          `Verified dreamina command template requested unavailable placeholder: ${key}`
        );
      }
      return values[key]!;
    })
  );
}

function requestValues(
  request: {
    model: string;
    promptText: string;
  durationMs: number;
  aspectRatio: string;
  generateAudio: boolean;
  requestHash: string;
  assetManifest: unknown;
    inputVersionRefs: unknown;
  },
  modelVersion: string
): Record<string, string> {
  return {
    model: request.model,
    modelVersion,
    promptText: request.promptText,
    durationMs: String(request.durationMs),
    durationSeconds: String(request.durationMs / 1000),
    aspectRatio: request.aspectRatio,
    generateAudio: String(request.generateAudio),
    requestHash: request.requestHash,
    assetManifestJson: JSON.stringify(request.assetManifest),
    inputVersionRefsJson: JSON.stringify(request.inputVersionRefs)
  };
}

function handleValues(handle: {
  externalTaskId?: string;
  submitId?: string;
  opaqueHandle?: string;
}): Record<string, string> {
  return {
    externalTaskId: handle.externalTaskId ?? "",
    submitId: handle.submitId ?? "",
    opaqueHandle: handle.opaqueHandle ?? ""
  };
}

export function buildAgentSubmitArgs(
  request: GenerationRequest,
  assets: readonly ResolvedGenerationAsset[],
  legacyModelVersion: string
): string[] {
  const operation = request.dreaminaOperation;
  if (!operation) {
    throw new ProviderNotReadyError("Agent request is missing dreaminaOperation");
  }
  const profile = request.generationProfile;
  if (profile && profile.operation !== operation) {
    throw new ProviderNotReadyError(
      "GenerationProfile operation does not match request operation"
    );
  }
  const durationSeconds = String(request.durationMs / 1000);
  const resolution =
    profile?.videoResolution ?? request.videoResolution ?? "720p";
  const effectiveModelVersion =
    profile?.modelVersion ?? legacyModelVersion;
  const passModelVersion = profile
    ? profile.modelMode === "EXPLICIT"
    : Boolean(effectiveModelVersion);
  const passRatio = profile
    ? profile.aspectRatioMode === "EXPLICIT"
    : request.aspectRatio !== "AUTO";
  if (
    profile?.modelMode === "EXPLICIT" &&
    profile.requestedModelVersion !== profile.modelVersion
  ) {
    throw new ProviderNotReadyError(
      "GenerationProfile requested model does not match effective CLI model_version"
    );
  }
  const sorted = [...assets].sort(
    (a, b) => a.priority - b.priority || a.assetId.localeCompare(b.assetId)
  );
  assertAssetImageBindings(request, sorted);
  const images = sorted.filter(
    (asset) => !asset.inputType || asset.inputType === "image"
  );
  const videos = sorted.filter((asset) => asset.inputType === "video");
  const audios = sorted.filter((asset) => asset.inputType === "audio");
  const appendGenerationParams = (
    args: string[],
    options: { ratio?: boolean; model?: boolean } = {}
  ): void => {
    if (options.ratio !== false && passRatio) {
      args.push("--ratio", request.aspectRatio);
    }
    args.push("--video_resolution", resolution);
    if (options.model !== false && passModelVersion) {
      if (!effectiveModelVersion) {
        throw new ProviderNotReadyError(
          "Explicit GenerationProfile is missing modelVersion"
        );
      }
      args.push("--model_version", effectiveModelVersion);
    }
    args.push("--poll", "0");
  };

  if (operation === "text2video") {
    const args = [
      operation,
      "--prompt",
      request.promptText,
      "--duration",
      durationSeconds
    ];
    appendGenerationParams(args);
    return args;
  }

  if (operation === "image2video") {
    if (!images.length) {
      throw new ProviderNotReadyError("image2video requires one image");
    }
    const args = [
      operation,
      "--image",
      images[0]!.absolutePath,
      "--prompt",
      request.promptText,
      "--duration",
      durationSeconds
    ];
    appendGenerationParams(args);
    return args;
  }

  if (operation === "frames2video") {
    if (images.length < 2) {
      throw new ProviderNotReadyError("frames2video requires first and last images");
    }
    const args = [
      operation,
      "--first",
      images[0]!.absolutePath,
      "--last",
      images[1]!.absolutePath,
      "--prompt",
      request.promptText,
      "--duration",
      durationSeconds
    ];
    appendGenerationParams(args);
    return args;
  }

  if (operation === "multiframe2video") {
    if (images.length < 2) {
      throw new ProviderNotReadyError("multiframe2video requires at least two images");
    }
    if (profile && profile.modelMode !== "FIXED") {
      throw new ProviderNotReadyError(
        "multiframe2video requires a FIXED GenerationProfile"
      );
    }
    const args = [
      operation,
      "--images",
      images.map((item) => item.absolutePath).join(","),
      "--video_resolution",
      resolution
    ];
    if (images.length === 2) {
      args.push(
        "--prompt",
        request.promptText,
        "--duration",
        durationSeconds
      );
    } else {
      const transitions = images.length - 1;
      const secondsPerTransition = request.durationMs / 1000 / transitions;
      const transitionDuration = String(
        Math.round(secondsPerTransition * 100) / 100
      );
      for (let index = 0; index < transitions; index += 1) {
        args.push("--transition-prompt", request.promptText);
        args.push("--transition-duration", transitionDuration);
      }
    }
    args.push("--poll", "0");
    return args;
  }

  const args = [
    operation,
    "--prompt",
    request.promptText,
    "--duration",
    durationSeconds
  ];
  appendGenerationParams(args);
  for (const image of images) args.push("--image", image.absolutePath);
  for (const video of videos) args.push("--video", video.absolutePath);
  for (const audio of audios) args.push("--audio", audio.absolutePath);
  return args;
}

export function buildVerifiedDreaminaRuntime(
  input: unknown
): VerifiedDreaminaRuntime {
  const config = configSchema.parse(input);
  assertNoCredentialMaterial(config);

  const identity = {
    ...config.identity,
    provider: "domestic-jimeng-cli" as const
  };

  return {
    identity,
    versionArgs: config.probe.versionArgs,
    helpArgs: config.probe.helpArgs,
    parseProbe(versionResult, helpResult) {
      const versionText = combined(versionResult);
      const helpText = combined(helpResult);
      assertRegex(config.probe.versionRegex, versionText, "versionRegex");
      if (!versionText.includes(config.identity.cliVersion)) {
        throw new ProviderNotReadyError(
          "Verified dreamina CLI version no longer matches reviewed identity"
        );
      }
      for (const fragment of config.probe.helpRequiredFragments) {
        if (!helpText.toLowerCase().includes(fragment.toLowerCase())) {
          throw new ProviderNotReadyError(
            `Verified dreamina help no longer contains reviewed capability fragment: ${fragment}`
          );
        }
      }
      return {
        cliVersion: config.identity.cliVersion,
        supportedOperations: config.probe.supportedOperations.filter(op => op !== "estimate" || Boolean(config.estimate &&
          config.estimate.argsTemplate[0] !== "user_credit" && config.estimate.creditsRegex)),
        supportedModels: [...config.probe.supportedModels],
        supportedDurationsMs: [...config.probe.supportedDurationsMs]
      };
    },
    account: {
      args: config.account.args,
      parse(result) {
        const text = combined(result);
        if (regex(config.account.authenticatedRegex).test(text)) {
          const creditsText = capture(config.account.creditsRegex, text);
          const availableCredits =
            creditsText !== undefined ? Number(creditsText) : undefined;
          return {
            status: "AUTHENTICATED" as const,
            ...(availableCredits !== undefined &&
            Number.isFinite(availableCredits) &&
            availableCredits >= 0
              ? { availableCredits }
              : {})
          };
        }
        if (regex(config.account.notAuthenticatedRegex).test(text)) {
          return { status: "NOT_AUTHENTICATED" as const };
        }
        return { status: "UNKNOWN" as const };
      }
    },
    estimate: config.estimate && config.estimate.argsTemplate[0] !== "user_credit" && config.estimate.creditsRegex ? {
      buildArgs(requests) {
        return expandArgs(config.estimate!.argsTemplate, {
          requestsJson: JSON.stringify(requests),
          requestCount: String(requests.length)
        });
      },
      parse(result) {
        const text = combined(result);
        const creditsValue = capture(config.estimate!.creditsRegex, text);
        const costText = capture(config.estimate!.costTextRegex, text);
        const credits =
          creditsValue !== undefined ? Number(creditsValue) : undefined;
        if (
          (credits !== undefined && !Number.isFinite(credits)) ||
          (credits !== undefined && credits < 0)
        ) {
          return { status: "UNKNOWN" as const };
        }
        if (credits === undefined) {
          return { status: "UNKNOWN" as const };
        }
        return {
          status: "KNOWN" as const,
          ...(credits !== undefined ? { estimatedCredits: credits } : {}),
          ...(costText ? { estimatedCostText: costText } : {})
        };
      }
    } : undefined,
    submit: {
      buildArgs(request, assets) {
        const modelVersion =
          config.submit.modelVersionMap?.[request.model] ?? request.model;
        if (request.dreaminaOperation) {
          return buildAgentSubmitArgs(request, assets, modelVersion);
        }
        const args = expandArgs(
          config.submit.argsTemplate,
          requestValues(request, modelVersion)
        );
        const minAssets = config.submit.minAssets ?? 0;
        if (assets.length < minAssets) {
          throw new ProviderNotReadyError(
            `dreamina submit requires at least ${minAssets} resolved local asset(s)`
          );
        }
        if (config.submit.assetFlag) {
          for (const asset of [...assets].sort(
            (a, b) =>
              a.priority - b.priority ||
              a.assetId.localeCompare(b.assetId)
          )) {
            args.push(config.submit.assetFlag, asset.absolutePath);
          }
        }
        return args;
      },
      parse(result) {
        const text = combined(result);
        return {
          ...(capture(config.submit.taskIdRegex, text)
            ? { externalTaskId: capture(config.submit.taskIdRegex, text)! }
            : {}),
          ...(capture(config.submit.submitIdRegex, text)
            ? { submitId: capture(config.submit.submitIdRegex, text)! }
            : {}),
          ...(capture(config.submit.opaqueHandleRegex, text)
            ? { opaqueHandle: capture(config.submit.opaqueHandleRegex, text)! }
            : {})
        };
      },
      classifyFailure(result) {
        const text = combined(result);
        if (
          config.submit.outcomeUnknownRegex &&
          regex(config.submit.outcomeUnknownRegex).test(text)
        ) {
          return "UNKNOWN";
        }
        if (
          config.submit.failedRegex &&
          regex(config.submit.failedRegex).test(text)
        ) {
          return "FAILED";
        }
        return "UNKNOWN";
      }
    },
    status: {
      buildArgs(handle) {
        return expandArgs(config.status.argsTemplate, handleValues(handle));
      },
      parse(result) {
        const text = combined(result);
        if (regex(config.status.failedRegex).test(text)) {
          return { status: "FAILED" as const };
        }
        if (regex(config.status.succeededRegex).test(text)) {
          return { status: "SUCCEEDED" as const };
        }
        if (regex(config.status.processingRegex).test(text)) {
          return { status: "PROCESSING" as const };
        }
        if (
          config.status.submittedRegex &&
          regex(config.status.submittedRegex).test(text)
        ) {
          return { status: "SUBMITTED" as const };
        }
        return { status: "UNKNOWN" as const };
      }
    },
    download: {
      buildArgs(handle, outputPath) {
        return expandArgs(config.download.argsTemplate, {
          ...handleValues(handle),
          outputPath,
          outputDir: path.dirname(outputPath)
        });
      },
      ...(config.download.outputMode
        ? { outputMode: config.download.outputMode }
        : {})
    },
    reconcile: {
      buildArgs(input) {
        return expandArgs(config.reconcile.argsTemplate, {
          requestHash: input.requestHash,
          submissionFingerprint: input.submissionFingerprint,
          knownExternalTaskId: input.knownHandle?.externalTaskId ?? "",
          knownSubmitId: input.knownHandle?.submitId ?? "",
          knownOpaqueHandle: input.knownHandle?.opaqueHandle ?? ""
        });
      },
      parse(result) {
        const text = combined(result);
        const taskId = capture(config.reconcile.taskIdRegex, text);
        const handle = taskId ? { externalTaskId: taskId } : undefined;
        if (regex(config.reconcile.foundActiveRegex).test(text)) {
          if (!handle) {
            return {
              outcome: "INCONCLUSIVE" as const,
              reason: "Reconcile matched active outcome without durable task id"
            };
          }
          return { outcome: "FOUND_ACTIVE" as const, handle };
        }
        if (regex(config.reconcile.foundSucceededRegex).test(text)) {
          if (!handle) {
            return {
              outcome: "INCONCLUSIVE" as const,
              reason: "Reconcile matched success outcome without durable task id"
            };
          }
          return { outcome: "FOUND_SUCCEEDED" as const, handle };
        }
        if (regex(config.reconcile.foundFailedRegex).test(text)) {
          return {
            outcome: "FOUND_FAILED" as const,
            ...(handle ? { handle } : {}),
            reason:
              capture(config.reconcile.failureReasonRegex, text) ??
              "Provider reported failed task"
          };
        }
        if (regex(config.reconcile.notFoundRegex).test(text)) {
          return { outcome: "NOT_FOUND" as const };
        }
        return {
          outcome: "INCONCLUSIVE" as const,
          reason: "Provider reconcile output did not match reviewed contract"
        };
      }
    }
  };
}

export function loadVerifiedDreaminaRuntime(
  configPath?: string
): VerifiedDreaminaRuntime | undefined {
  const explicit =
    configPath ?? process.env.DREAMINA_VERIFIED_RUNTIME_CONFIG;
  const resolved = path.resolve(
    explicit ?? path.join(process.cwd(), "config", "dreamina-runtime.verified.json")
  );
  if (!fs.existsSync(resolved)) {
    if (explicit) {
      throw new ProviderNotReadyError(
        `Verified dreamina runtime config not found: ${resolved}`
      );
    }
    return undefined;
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return buildVerifiedDreaminaRuntime(raw);
}

export function createConfiguredDomesticJimengProvider(options?: {
  configPath?: string;
  locateExecutable?: LocateExecutable;
  runner?: CommandRunner;
  resolveGenerationAssets?: ResolveGenerationAssets;
}): DomesticJimengCliProvider {
  const runtime = loadVerifiedDreaminaRuntime(options?.configPath);
  const locateExecutable =
    options?.locateExecutable ??
    (runtime ? async () => runtime.identity.executablePath : undefined);
  return new DomesticJimengCliProvider(
    locateExecutable,
    runtime,
    options?.runner,
    options?.resolveGenerationAssets
  );
}
