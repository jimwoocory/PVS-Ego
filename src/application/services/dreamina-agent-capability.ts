import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { DomesticJimengCliProvider } from "../../adapters/video/domestic-jimeng-cli-provider.js";
import {
  generationProfileSchema,
  type DreaminaVideoOperation,
  type GenerationProfile
} from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";

const AGENT_OPERATIONS: DreaminaVideoOperation[] = [
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video"
];

export type DreaminaCommandCapability = {
  operation: DreaminaVideoOperation;
  helpText: string;
  helpSha256: string;
  supportedModels: string[];
  durationMinSeconds?: number;
  durationMaxSeconds?: number;
  transitionMinSeconds?: number;
  transitionMaxSeconds?: number;
  supportsImages: boolean;
  supportsVideos: boolean;
  supportsAudio: boolean;
  minImages?: number;
  maxImages?: number;
  maxVideos?: number;
  maxAudio?: number;
  maxTotalInputs?: number;
  inputMediaMinSeconds?: number;
  inputMediaMaxSeconds?: number;
  videoResolutionRequired: boolean;
};

export type DreaminaSkillSnapshot = {
  skillPath: string;
  skillSha256: string;
  rootHelp: string;
  rootHelpSha256: string;
  cliVersion: string;
  providerIdentityHash: string;
  capabilityFingerprint: string;
  command: DreaminaCommandCapability;
  checkedAt: string;
};

export type DreaminaModelCapability = {
  modelVersion: string;
  supportedResolutions: string[];
  durationMinSeconds?: number;
  durationMaxSeconds?: number;
  explicitRatioAllowed: boolean;
  vipOnly: boolean;
  maxImages?: number;
  maxVideos?: number;
  maxAudio?: number;
  maxTotalInputs?: number;
  inputMediaMinSeconds?: number;
  inputMediaMaxSeconds?: number;
};

export type DreaminaOperationCapability = {
  operation: DreaminaVideoOperation;
  operationLabel: string;
  helpSha256: string;
  modelConfigurable: boolean;
  fixedModel: boolean;
  fixedModelLabel?: string;
  defaultModelVersion?: string;
  supportedModels: string[];
  supportedRatios: string[];
  models: DreaminaModelCapability[];
  fixedResolutions: string[];
  transitionMinSeconds?: number;
  transitionMaxSeconds?: number;
  supportsImages: boolean;
  supportsVideos: boolean;
  supportsReferenceAudio: boolean;
  supportsNativeAudioOutput: boolean;
  minImages?: number;
  maxImages?: number;
  maxVideos?: number;
  maxAudio?: number;
  maxTotalInputs?: number;
  inputMediaMinSeconds?: number;
  inputMediaMaxSeconds?: number;
};

export type DreaminaCapabilityRegistry = {
  source: "DREAMINA_SKILL_AND_CLI_HELP";
  skillPath: string;
  skillSha256: string;
  rootHelpSha256: string;
  cliVersion: string;
  providerIdentityHash: string;
  providerCapabilityFingerprint: string;
  registryFingerprint: string;
  checkedAt: string;
  operations: DreaminaOperationCapability[];
  models: string[];
  ratios: string[];
  nativeAudioOutputSupported: boolean;
};

export type GenerationProfileInput = {
  operation: DreaminaVideoOperation;
  requestedModelVersion: string;
  aspectRatio: string;
  videoResolution: string;
  durationMs: number;
  referenceAudioInputCount: number;
  nativeAudioOutputRequested: boolean;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function extractModels(help: string): string[] {
  const matches = [
    ...help.matchAll(/seedance(?:1\.0fast|1\.5pro|2\.0(?:fast_vip|fast|_vip|mini)?|2\.5)/gi)
  ].map((match) => match[0]!.toLowerCase());
  return [...new Set(matches)].sort();
}

const operationLabel: Record<DreaminaVideoOperation, string> = {
  text2video: "文生视频",
  image2video: "图生视频",
  frames2video: "首尾帧视频",
  multiframe2video: "多图故事视频（固定模型）",
  multimodal2video: "全能参考视频"
};

function extractRatios(help: string): string[] {
  const matches = [...help.matchAll(/\b(?:1:1|3:4|16:9|4:3|9:16|21:9)\b/g)].map(
    (match) => match[0]!
  );
  return [...new Set(matches)];
}

function extractDefaultModel(help: string): string | undefined {
  const direct =
    /default model_version:\s*([a-z0-9._-]+)/i.exec(help) ??
    /--model_version[^\n]*default:\s*([a-z0-9._-]+)/i.exec(help);
  return direct?.[1]?.toLowerCase();
}

function extractResolutionValues(text: string): string[] {
  const values = [...text.matchAll(/\b(?:480p|720p|1080p|4k)\b/gi)].map(
    (match) => match[0]!.toLowerCase()
  );
  return [...new Set(values)];
}

function resolutionsForModel(
  operation: DreaminaVideoOperation,
  help: string,
  modelVersion: string
): string[] {
  if (operation === "multiframe2video") {
    const flag = /--video_resolution[^\n]*supported values:\s*([^\n]+)/i.exec(
      help
    );
    return extractResolutionValues(flag?.[1] ?? help);
  }
  const model = modelVersion.toLowerCase();
  const escaped = escapeRegex(model);
  const direct = new RegExp(
    escaped + "\\s*->[^\\n]*?video_resolution\\s+([^;\\n]+)",
    "i"
  ).exec(help);
  if (direct) return extractResolutionValues(direct[1]!);
  if (model === "seedance2.0_vip") {
    const vip =
      /seedance2\.0_vip\s*->[^\n]*?video_resolution\s+([^;\n]+)/i.exec(
        help
      );
    if (vip) return extractResolutionValues(vip[1]!);
  }
  const fallback =
    /all other(?: seedance2\.0)? models\s*->[^\n]*?video_resolution\s+([^;\n]+)/i.exec(
      help
    ) ??
    /all other models\s*->[^\n]*?video_resolution\s+([^;\n]+)/i.exec(
      help
    );
  if (fallback) return extractResolutionValues(fallback[1]!);
  const flag = /--video_resolution[^\n]*supported values(?: by model)?:\s*([^\n]+)/i.exec(
    help
  );
  const parsed = extractResolutionValues(flag?.[1] ?? "");
  return parsed.length ? parsed : ["720p"];
}

function explicitRatioAllowedForModel(
  operation: DreaminaVideoOperation,
  help: string,
  modelVersion: string
): boolean {
  if (operation === "multiframe2video") return false;
  if (
    (operation === "image2video" || operation === "frames2video") &&
    modelVersion.toLowerCase() === "seedance2.5" &&
    /seedance2\.5[^\n]*(?:rejects|not accepted)[^\n]*--ratio|--ratio[^\n]*not accepted[^\n]*seedance2\.5/i.test(
      help
    )
  ) {
    return false;
  }
  return true;
}

function supportsNativeAudioOutput(
  operation: DreaminaVideoOperation,
  help: string
): boolean {
  if (
    /--(?:generate[_-]?audio|audio[_-]?output|with[_-]?audio|sound[_-]?output)\b/i.test(
      help
    )
  ) {
    return true;
  }
  // Current Dreamina Seedance text/all-around-reference outputs already carry
  // model-native audio without a separate CLI switch. Local production
  // artifacts confirm AAC audio on both commands. Multi-frame fixed-model
  // output is excluded because existing outputs are silent.
  return (
    operation === "text2video" ||
    operation === "multimodal2video"
  );
}

function parseFixedResolutions(help: string): string[] {
  const flag = /--video_resolution[^\n]*supported values:\s*([^\n]+)/i.exec(help);
  return extractResolutionValues(flag?.[1] ?? "");
}

function parseDurationRange(
  operation: DreaminaVideoOperation,
  help: string,
  modelVersion: string
): { min?: number; max?: number } {
  const model = modelVersion.toLowerCase();
  if (operation === "multimodal2video") {
    const durationLine = help
      .split(/\r?\n/)
      .find((line) => line.includes("--duration"));
    if (durationLine) {
      const match =
        model === "seedance2.5"
          ? /seedance2\.5\s*->\s*(\d+)-(\d+)/i.exec(durationLine)
          : /all other models\s*->\s*(\d+)-(\d+)/i.exec(durationLine);
      if (match) {
        return { min: Number(match[1]), max: Number(match[2]) };
      }
    }
  }
  const escaped = escapeRegex(model);
  const directPatterns = [
    new RegExp(escaped + "\\s*->[^\\n]*?duration\\s+(\\d+)-(\\d+)s", "i"),
    new RegExp(escaped + "\\s*->\\s*(\\d+)-(\\d+)", "i")
  ];
  for (const pattern of directPatterns) {
    const match = pattern.exec(help);
    if (match) return { min: Number(match[1]), max: Number(match[2]) };
  }

  if (model === "seedance2.0mini" || model.startsWith("seedance2.0")) {
    const family =
      /seedance2\.0(?:\s+family)?\/seedance2\.0mini\s*->\s*(\d+)-(\d+)/i.exec(help) ??
      /all other (?:seedance2\.0 )?models\s*->[^\n]*?duration\s+(\d+)-(\d+)s/i.exec(help);
    if (family) {
      return { min: Number(family[1]), max: Number(family[2]) };
    }
  }

  if (operation === "multiframe2video") return { min: 2 };

  const flagLine =
    /--duration[^\n]*?(?:supported range(?:s)?(?: by model)?:)?[^\n]*?(\d+)-(\d+)/i.exec(help);
  return flagLine
    ? { min: Number(flagLine[1]), max: Number(flagLine[2]) }
    : {};
}

function parseLimit(help: string, label: string): number | undefined {
  const match = new RegExp(label + "\\s*<=\\s*(\\d+)", "i").exec(help);
  return match ? Number(match[1]) : undefined;
}

function parseMultimodalLimits(
  help: string,
  modelVersion: string
): {
  maxImages?: number;
  maxVideos?: number;
  maxAudio?: number;
  maxTotalInputs?: number;
  inputMediaMinSeconds?: number;
  inputMediaMaxSeconds?: number;
} {
  const model = modelVersion.toLowerCase();
  const lines = help
    .split(/\r?\n/)
    .filter((item) =>
      model === "seedance2.5"
        ? /seedance2\.5\s*->/i.test(item)
        : /seedance2\.0 family\/seedance2\.0mini\s*->/i.test(item)
    );
  if (!lines.length) return {};
  // Current CLI help may describe output duration and input limits on
  // separate lines for the same model family. Parse their union rather than
  // assuming one formatting line is the entire capability contract.
  const modelHelp = lines.join(" ");
  const image = /image\s*<=\s*(\d+)/i.exec(modelHelp);
  const video = /video\s*<=\s*(\d+)/i.exec(modelHelp);
  const audio = /audio\s*<=\s*(\d+)/i.exec(modelHelp);
  const total = /total inputs\s*<=\s*(\d+)/i.exec(modelHelp);
  const mediaDuration =
    /(?:each and total )?video\/audio duration\s*(\d+)-(\d+)s/i.exec(
      modelHelp
    );
  return {
    ...(image ? { maxImages: Number(image[1]) } : {}),
    ...(video ? { maxVideos: Number(video[1]) } : {}),
    ...(audio ? { maxAudio: Number(audio[1]) } : {}),
    ...(total ? { maxTotalInputs: Number(total[1]) } : {}),
    ...(mediaDuration
      ? {
          inputMediaMinSeconds: Number(mediaDuration[1]),
          inputMediaMaxSeconds: Number(mediaDuration[2])
        }
      : {})
  };
}

/** Explicit paths fail closed; discovery only falls back when a default file is absent. */
export async function resolveDreaminaSkillPath(options: {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = options.explicitPath?.trim() || env.DREAMINA_SKILL_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const home = options.homeDir ?? (env.USERPROFILE?.trim() || os.homedir());
  const official = path.join(home, ".dreamina_cli", "dreamina", "SKILL.md");
  const legacy = path.join(home, ".agentdock", "tmp", "dreamina-official", "SKILL.md");
  for (const candidate of [official, legacy]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) {
      // Permission or I/O failures must not silently select another Skill.
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return official;
}

export class DreaminaAgentCapabilityService {
  constructor(
    private readonly provider: DomesticJimengCliProvider,
    private readonly skillPathOverride?: string
  ) {}

  async registry(): Promise<DreaminaCapabilityRegistry> {
    if (typeof this.provider.inspectCommandHelp !== "function") {
      throw new DomainValidationError("当前 Dreamina Provider 不支持动态 help 检查");
    }
    const skillPath = await resolveDreaminaSkillPath({ explicitPath: this.skillPathOverride });
    const skillText = await fs.readFile(skillPath, "utf8").catch(() => "");
    if (!skillText.trim()) {
      throw new DomainValidationError(
        "未找到 Dreamina 官方 Skill，不能建立动态能力注册表"
      );
    }
    for (const fragment of [
      "dreamina-cli",
      "Choosing the right command",
      "dreamina <subcommand> -h",
      "Warn the user before running commands that may consume credits."
    ]) {
      if (!skillText.includes(fragment)) {
        throw new DomainValidationError(
          "Dreamina Skill 内容与已审核能力说明不一致"
        );
      }
    }
    // Windows CLI cold starts can exceed ten seconds when seven executables
    // start together. Read-only discovery stays bounded and sequential.
    const probe = await this.provider.probe();
    const root = await this.provider.inspectCommandHelp("__root__");
    const commands = [];
    for (const operation of AGENT_OPERATIONS) commands.push(await this.provider.inspectCommandHelp(operation));
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        "Dreamina Provider 当前不可用：" + probe.code
      );
    }
    const rootHelp = [root.stdout, root.stderr].filter(Boolean).join("\n");
    const operations: DreaminaOperationCapability[] = [];
    for (const [index, operation] of AGENT_OPERATIONS.entries()) {
      if (!rootHelp.includes(operation)) {
        throw new DomainValidationError(
          "当前 dreamina -h 未列出 " + operation
        );
      }
      const result = commands[index]!;
      const helpText = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n");
      const supportedModels =
        operation === "multiframe2video" ? [] : extractModels(helpText);
      const modelConfigurable = helpText.includes("--model_version");
      const supportedRatios = extractRatios(helpText);
      const models = supportedModels.map((modelVersion) => {
        const duration = parseDurationRange(
          operation,
          helpText,
          modelVersion
        );
        const modelInputLimits =
          operation === "multimodal2video"
            ? parseMultimodalLimits(helpText, modelVersion)
            : {};
        return {
          modelVersion,
          supportedResolutions: resolutionsForModel(
            operation,
            helpText,
            modelVersion
          ),
          ...(duration.min !== undefined
            ? { durationMinSeconds: duration.min }
            : {}),
          ...(duration.max !== undefined
            ? { durationMaxSeconds: duration.max }
            : {}),
          explicitRatioAllowed: explicitRatioAllowedForModel(
            operation,
            helpText,
            modelVersion
          ),
          vipOnly:
            modelVersion === "seedance2.5" &&
            /seedance2\.5[^\n]*VIP-only/i.test(helpText),
          ...modelInputLimits
        };
      });
      const multimodalLimits =
        operation === "multimodal2video"
          ? parseMultimodalLimits(
              helpText,
              supportedModels.includes("seedance2.5")
                ? "seedance2.5"
                : "seedance2.0"
            )
          : {};
      const transitionRange =
        operation === "multiframe2video"
          ? /each duration segment must be (\d+)-(\d+) seconds/i.exec(
              helpText
            ) ??
            /--duration[^\n]*supported range:\s*(\d+)-(\d+)/i.exec(
              helpText
            )
          : null;
      operations.push({
        operation,
        operationLabel: operationLabel[operation],
        helpSha256: sha256(helpText),
        modelConfigurable,
        fixedModel: !modelConfigurable,
        ...(!modelConfigurable
          ? { fixedModelLabel: "Dreamina 固定模型（当前 CLI/后端决定）" }
          : {}),
        ...(extractDefaultModel(helpText)
          ? { defaultModelVersion: extractDefaultModel(helpText)! }
          : {}),
        supportedModels,
        supportedRatios,
        models,
        fixedResolutions:
          operation === "multiframe2video"
            ? parseFixedResolutions(helpText)
            : [],
        ...(transitionRange
          ? {
              transitionMinSeconds: Number(transitionRange[1]),
              transitionMaxSeconds: Number(transitionRange[2])
            }
          : {}),
        supportsImages:
          helpText.includes("--image") || helpText.includes("--images"),
        supportsVideos: helpText.includes("--video"),
        supportsReferenceAudio: helpText.includes("--audio"),
        supportsNativeAudioOutput: supportsNativeAudioOutput(
          operation,
          helpText
        ),
        ...(operation === "multiframe2video"
          ? { minImages: 2, maxImages: 20 }
          : {}),
        ...(multimodalLimits.maxImages !== undefined
          ? { maxImages: multimodalLimits.maxImages }
          : parseLimit(helpText, "image") !== undefined
            ? { maxImages: parseLimit(helpText, "image")! }
            : {}),
        ...(multimodalLimits.maxVideos !== undefined
          ? { maxVideos: multimodalLimits.maxVideos }
          : parseLimit(helpText, "video") !== undefined
            ? { maxVideos: parseLimit(helpText, "video")! }
            : {}),
        ...(multimodalLimits.maxAudio !== undefined
          ? { maxAudio: multimodalLimits.maxAudio }
          : parseLimit(helpText, "audio") !== undefined
            ? { maxAudio: parseLimit(helpText, "audio")! }
            : {}),
        ...(multimodalLimits.maxTotalInputs !== undefined
          ? { maxTotalInputs: multimodalLimits.maxTotalInputs }
          : parseLimit(helpText, "total inputs") !== undefined
            ? { maxTotalInputs: parseLimit(helpText, "total inputs")! }
            : {}),
        ...(multimodalLimits.inputMediaMinSeconds !== undefined
          ? {
              inputMediaMinSeconds:
                multimodalLimits.inputMediaMinSeconds
            }
          : {}),
        ...(multimodalLimits.inputMediaMaxSeconds !== undefined
          ? {
              inputMediaMaxSeconds:
                multimodalLimits.inputMediaMaxSeconds
            }
          : {})
      });
    }
    const models = [
      ...new Set(operations.flatMap((item) => item.supportedModels))
    ].sort();
    const ratios = [
      ...new Set(operations.flatMap((item) => item.supportedRatios))
    ];
    const checkedAt = new Date().toISOString();
    const registryFingerprint = sha256(
      JSON.stringify({
        skillSha256: sha256(skillText),
        rootHelpSha256: sha256(rootHelp),
        providerCapabilityFingerprint: probe.capabilityFingerprint,
        commands: operations.map((item) => ({
          operation: item.operation,
          helpSha256: item.helpSha256
        }))
      })
    );
    return {
      source: "DREAMINA_SKILL_AND_CLI_HELP",
      skillPath,
      skillSha256: sha256(skillText),
      rootHelpSha256: sha256(rootHelp),
      cliVersion: probe.cliVersion,
      providerIdentityHash: probe.providerIdentityHash,
      providerCapabilityFingerprint: probe.capabilityFingerprint,
      registryFingerprint,
      checkedAt,
      operations,
      models,
      ratios,
      nativeAudioOutputSupported: operations.some(
        (item) => item.supportsNativeAudioOutput
      )
    };
  }

  async inspect(
    operation: DreaminaVideoOperation,
    modelVersion: string
  ): Promise<DreaminaSkillSnapshot> {
    if (!AGENT_OPERATIONS.includes(operation)) {
      throw new DomainValidationError("Agent 不支持该 Dreamina 视频命令");
    }
    if (typeof this.provider.inspectCommandHelp !== "function") {
      throw new DomainValidationError("当前 Dreamina Provider 不支持动态 help 检查");
    }

    const skillPath = await resolveDreaminaSkillPath({ explicitPath: this.skillPathOverride });
    const skillText = await fs.readFile(skillPath, "utf8").catch(() => "");
    if (!skillText.trim()) {
      throw new DomainValidationError(
        "未找到 Dreamina 官方 Skill，不能进入 Agent 真实生成"
      );
    }
    for (const fragment of [
      "dreamina-cli",
      "Choosing the right command",
      "dreamina <subcommand> -h",
      "Warn the user before running commands that may consume credits."
    ]) {
      if (!skillText.includes(fragment)) {
        throw new DomainValidationError(
          "Dreamina Skill 内容与已审核能力说明不一致"
        );
      }
    }

    const [probe, root, command] = await Promise.all([
      this.provider.probe(),
      this.provider.inspectCommandHelp("__root__"),
      this.provider.inspectCommandHelp(operation)
    ]);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        "Dreamina Provider 当前不可用：" + probe.code
      );
    }

    const rootHelp = [root.stdout, root.stderr].filter(Boolean).join("\n");
    const helpText = [command.stdout, command.stderr].filter(Boolean).join("\n");
    if (!rootHelp.includes(operation)) {
      throw new DomainValidationError(
        "当前 dreamina -h 未列出 " + operation
      );
    }

    const requiredFlags: Record<DreaminaVideoOperation, string[]> = {
      text2video: ["--prompt", "--duration", "--video_resolution"],
      image2video: ["--image", "--prompt", "--duration", "--video_resolution"],
      frames2video: ["--first", "--last", "--duration", "--video_resolution"],
      multiframe2video: ["--images", "--video_resolution"],
      multimodal2video: ["--image", "--video", "--audio", "--video_resolution"]
    };
    for (const flag of requiredFlags[operation]) {
      if (!helpText.includes(flag)) {
        throw new DomainValidationError(
          "dreamina " + operation + " 当前 help 缺少 " + flag
        );
      }
    }

    const supportedModels =
      operation === "multiframe2video" ? [] : extractModels(helpText);
    if (
      operation !== "multiframe2video" &&
      modelVersion &&
      !supportedModels.includes(modelVersion.toLowerCase())
    ) {
      throw new DomainValidationError(
        "dreamina " + operation + " 当前不支持模型 " + modelVersion
      );
    }
    const duration = parseDurationRange(operation, helpText, modelVersion);
    const multimodalLimits =
      operation === "multimodal2video"
        ? parseMultimodalLimits(helpText, modelVersion)
        : {};
    const transitionRange =
      operation === "multiframe2video"
        ? /each duration segment must be (\d+)-(\d+) seconds/i.exec(
            helpText
          ) ??
          /--duration[^\n]*supported range:\s*(\d+)-(\d+)/i.exec(
            helpText
          )
        : null;

    return {
      skillPath,
      skillSha256: sha256(skillText),
      rootHelp,
      rootHelpSha256: sha256(rootHelp),
      cliVersion: probe.cliVersion,
      providerIdentityHash: probe.providerIdentityHash,
      capabilityFingerprint: probe.capabilityFingerprint,
      checkedAt: new Date().toISOString(),
      command: {
        operation,
        helpText,
        helpSha256: sha256(helpText),
        supportedModels,
        ...(duration.min !== undefined
          ? { durationMinSeconds: duration.min }
          : {}),
        ...(duration.max !== undefined
          ? { durationMaxSeconds: duration.max }
          : {}),
        ...(transitionRange
          ? {
              transitionMinSeconds: Number(transitionRange[1]),
              transitionMaxSeconds: Number(transitionRange[2])
            }
          : {}),
        supportsImages:
          helpText.includes("--image") || helpText.includes("--images"),
        supportsVideos: helpText.includes("--video"),
        supportsAudio: helpText.includes("--audio"),
        ...(operation === "multiframe2video"
          ? { minImages: 2, maxImages: 20 }
          : {}),
        ...(multimodalLimits.maxImages !== undefined
          ? { maxImages: multimodalLimits.maxImages }
          : parseLimit(helpText, "image") !== undefined
          ? { maxImages: parseLimit(helpText, "image")! }
          : {}),
        ...(multimodalLimits.maxVideos !== undefined
          ? { maxVideos: multimodalLimits.maxVideos }
          : parseLimit(helpText, "video") !== undefined
          ? { maxVideos: parseLimit(helpText, "video")! }
          : {}),
        ...(multimodalLimits.maxAudio !== undefined
          ? { maxAudio: multimodalLimits.maxAudio }
          : parseLimit(helpText, "audio") !== undefined
          ? { maxAudio: parseLimit(helpText, "audio")! }
          : {}),
        ...(multimodalLimits.maxTotalInputs !== undefined
          ? { maxTotalInputs: multimodalLimits.maxTotalInputs }
          : parseLimit(helpText, "total inputs") !== undefined
          ? { maxTotalInputs: parseLimit(helpText, "total inputs")! }
          : {}),
        ...(multimodalLimits.inputMediaMinSeconds !== undefined
          ? {
              inputMediaMinSeconds:
                multimodalLimits.inputMediaMinSeconds
            }
          : {}),
        ...(multimodalLimits.inputMediaMaxSeconds !== undefined
          ? {
              inputMediaMaxSeconds:
                multimodalLimits.inputMediaMaxSeconds
            }
          : {}),
        videoResolutionRequired: /--video_resolution[^\n]*required/i.test(helpText)
      }
    };
  }
}


export function resolveGenerationProfile(
  registry: DreaminaCapabilityRegistry,
  input: GenerationProfileInput
): GenerationProfile {
  const operation = registry.operations.find(
    (item) => item.operation === input.operation
  );
  if (!operation) {
    throw new DomainValidationError(
      "当前 Dreamina Registry 未提供命令 " + input.operation
    );
  }

  const requestedRaw = input.requestedModelVersion.trim();
  const requested =
    !requestedRaw || requestedRaw.toUpperCase() === "AUTO"
      ? "AUTO"
      : toDreaminaCliModel(requestedRaw).toLowerCase();

  let modelMode: GenerationProfile["modelMode"];
  let modelVersion: string | undefined;
  let requestedModelVersion: string | undefined;
  let fixedModelLabel: string | undefined;
  let modelCapability: DreaminaModelCapability | undefined;

  if (operation.fixedModel) {
    if (requested !== "AUTO" && requested.toUpperCase() !== "FIXED") {
      throw new DomainValidationError(
        operation.operationLabel +
          " 使用固定模型，不能选择 " +
          requestedRaw
      );
    }
    modelMode = "FIXED";
    fixedModelLabel =
      operation.fixedModelLabel ?? "Dreamina 固定模型（当前 CLI/后端决定）";
  } else if (requested === "AUTO") {
    if (!operation.defaultModelVersion) {
      throw new DomainValidationError(
        operation.operationLabel +
          " 当前 help 未声明默认模型，不能使用“自动模型”"
      );
    }
    modelMode = "COMMAND_DEFAULT";
    modelVersion = operation.defaultModelVersion;
    modelCapability = operation.models.find(
      (item) => item.modelVersion === modelVersion
    );
  } else {
    if (!operation.supportedModels.includes(requested)) {
      throw new DomainValidationError(
        operation.operationLabel + " 当前不支持模型 " + requestedRaw
      );
    }
    modelMode = "EXPLICIT";
    requestedModelVersion = requested;
    modelVersion = requested;
    modelCapability = operation.models.find(
      (item) => item.modelVersion === modelVersion
    );
  }

  const allowedResolutions = operation.fixedModel
    ? operation.fixedResolutions
    : (modelCapability?.supportedResolutions ?? []);
  if (
    !allowedResolutions.length ||
    !allowedResolutions.includes(input.videoResolution.toLowerCase())
  ) {
    throw new DomainValidationError(
      operation.operationLabel +
        " 当前模型不支持分辨率 " +
        input.videoResolution +
        "；可用：" +
        (allowedResolutions.join(" / ") || "未解析")
    );
  }

  if (modelCapability?.durationMinSeconds !== undefined) {
    if (input.durationMs < modelCapability.durationMinSeconds * 1000) {
      throw new DomainValidationError(
        "生成时长低于当前模型最低值 " +
          modelCapability.durationMinSeconds +
          " 秒"
      );
    }
  }
  if (modelCapability?.durationMaxSeconds !== undefined) {
    if (input.durationMs > modelCapability.durationMaxSeconds * 1000) {
      throw new DomainValidationError(
        "生成时长超过当前模型最高值 " +
          modelCapability.durationMaxSeconds +
          " 秒"
      );
    }
  }
  if (
    operation.fixedModel &&
    operation.transitionMinSeconds !== undefined &&
    input.durationMs < 2000
  ) {
    throw new DomainValidationError("多图故事视频总时长至少 2 秒");
  }

  if (
    input.referenceAudioInputCount > 0 &&
    !operation.supportsReferenceAudio
  ) {
    throw new DomainValidationError(
      operation.operationLabel + " 不接受参考音频输入"
    );
  }
  if (
    input.nativeAudioOutputRequested &&
    !operation.supportsNativeAudioOutput
  ) {
    throw new DomainValidationError(
      "当前 Dreamina " +
        operation.operationLabel +
        " 不能保证返回原生音轨；请选择文生视频/全能参考，或关闭原生声音要求"
    );
  }

  let aspectRatioMode: GenerationProfile["aspectRatioMode"];
  let aspectRatio: string | undefined;
  const requestedRatio = input.aspectRatio.trim() || "AUTO";
  const explicitRatioAllowed =
    operation.fixedModel
      ? false
      : (modelCapability?.explicitRatioAllowed ?? true);
  if (!explicitRatioAllowed) {
    if (requestedRatio !== "AUTO") {
      throw new DomainValidationError(
        operation.operationLabel +
          (modelVersion ? " / " + modelVersion : "") +
          " 不接受显式画幅；请选择“自动/跟随首帧”"
      );
    }
    aspectRatioMode = "INFER_FROM_FIRST_FRAME";
    aspectRatio = "AUTO";
  } else if (requestedRatio === "AUTO") {
    aspectRatioMode =
      input.operation === "image2video" ||
      input.operation === "frames2video"
        ? "INFER_FROM_FIRST_FRAME"
        : "COMMAND_DEFAULT";
    aspectRatio = "AUTO";
  } else {
    if (!operation.supportedRatios.includes(requestedRatio)) {
      throw new DomainValidationError(
        operation.operationLabel +
          " 当前不支持画幅 " +
          requestedRatio +
          "；可用：" +
          operation.supportedRatios.join(" / ")
      );
    }
    aspectRatioMode = "EXPLICIT";
    aspectRatio = requestedRatio;
  }

  return generationProfileSchema.parse({
    source: "DREAMINA_CAPABILITY_REGISTRY",
    operation: input.operation,
    modelMode,
    ...(requestedModelVersion ? { requestedModelVersion } : {}),
    ...(modelVersion ? { modelVersion } : {}),
    ...(fixedModelLabel ? { fixedModelLabel } : {}),
    aspectRatioMode,
    aspectRatio,
    videoResolution: input.videoResolution.toLowerCase(),
    durationMs: input.durationMs,
    referenceAudioInputCount: input.referenceAudioInputCount,
    nativeAudioOutputRequested: input.nativeAudioOutputRequested,
    nativeAudioOutputSupported: operation.supportsNativeAudioOutput,
    commandHelpSha256: operation.helpSha256,
    registryFingerprint: registry.registryFingerprint,
    capabilityCheckedAt: registry.checkedAt
  });
}

export function toDreaminaCliModel(model: string): string {
  const map: Record<string, string> = {
    "seedance-2.0": "seedance2.0",
    "seedance-2.0-fast": "seedance2.0fast",
    "seedance-2.0-vip": "seedance2.0_vip",
    "seedance-2.0-fast-vip": "seedance2.0fast_vip",
    "seedance-2.0-mini": "seedance2.0mini",
    "seedance-2.5": "seedance2.5"
  };
  return map[model.toLowerCase()] ?? model.toLowerCase();
}
