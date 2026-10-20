import { randomUUID } from "node:crypto";
import type {
  Clip,
  ProductFact,
  ProductTruth,
  ProductionPlan
} from "../../domain/schemas.js";
import type {
  DirectorV3ClipContract,
  SeedancePromptV3Draft
} from "../../domain/director-v3.js";
import {
  SEEDANCE_PROMPT_V3_VERSION,
  seedancePromptV3DraftSchema
} from "../../domain/director-v3.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { CreativeReferenceSet } from "../../domain/creative-reference.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

export const SEEDANCE_PROMPT_V3_MAX_CHARS = 2200;

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HASH_PATTERN = /\b[0-9a-f]{64}\b/i;
const INTERNAL_TOKEN_PATTERN =
  /\b(?:compiler_template|capability_fingerprint|command_help_sha256|required_facts|artifactHash|contentHash|productionAssetSet|creativeReferenceSet|segmentId|factId)\b/i;

function compact(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : normalized.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function mostlyChinese(value: string): boolean {
  const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  const ascii = (value.match(/[A-Za-z]/g) ?? []).length;
  return han >= 4 && ascii <= Math.max(12, han);
}

function productionReferenceLine(
  entry: ProductionAssetSet["entries"][number]
): string {
  if (entry.kind === "CHARACTER") {
    return (
      "- 固定角色参考：" +
      compact(entry.label, 70) +
      "；保持人物身份、服装与整体外观一致。"
    );
  }
  if (entry.kind === "SET") {
    return (
      "- 固定场景参考：" +
      compact(entry.label, 70) +
      "；保持空间布局、主要家具和光线方向一致。"
    );
  }
  if (entry.kind === "PROP") {
    return (
      "- 固定道具参考：" +
      compact(entry.label, 70) +
      "；保持关键道具外形与位置逻辑一致。"
    );
  }
  if (entry.kind === "PRODUCT_STATE") {
    return (
      "- 产品状态参考：" +
      compact(entry.label, 70) +
      "；只用于当前产品状态/内部结构参考，不改变产品主参考身份。"
    );
  }
  if (entry.kind === "STYLE") {
    return (
      "- 视觉风格参考：" +
      compact(entry.label, 70) +
      "；只借鉴整体视觉基调，不改变产品身份。"
    );
  }
  return "- 制作参考：" + compact(entry.label, 70) + "。";
}

function creativeReferenceLine(
  entry: CreativeReferenceSet["entries"][number]
): string {
  const roleLabel: Record<string, string> = {
    PRODUCT_ANGLE: "产品角度参考",
    WEARING_REFERENCE: "使用姿态参考",
    USAGE_ACTION_REFERENCE: "动作参考",
    SCENE_REFERENCE: "场景参考",
    LOGO_REFERENCE: "Logo 参考",
    PRIMARY_PRODUCT: "产品身份参考",
    ENVIRONMENT: "环境参考",
    CHARACTER: "角色参考",
    STYLE: "视觉风格参考",
    OTHER: "视觉方法参考"
  };
  const label = roleLabel[entry.role] ?? "视觉方法参考";
  return mostlyChinese(entry.description)
    ? "- " + label + "：" + compact(entry.description, 110)
    : "- " + label + "：只借鉴已确认的构图、动作或场景方法。";
}

function factsForClip(
  truth: ProductTruth,
  clip: Clip
): ProductFact[] {
  const ids = new Set([
    ...clip.requiredFactIds,
    ...clip.segments.flatMap(
      (segment) => segment.requiredFactIds
    )
  ]);
  return [
    ...truth.confirmedFeatures,
    ...truth.sellingPoints
  ]
    .filter((fact) => ids.has(fact.id))
    .slice(0, 5);
}

function referenceLines(input: {
  truth: ProductTruth;
  clip: Clip;
  productionAssetSet?: ProductionAssetSet;
  creativeReferences?: CreativeReferenceSet | null;
}) {
  const lines: string[] = [];
  if (input.clip.productVisibility !== "NONE") {
    lines.push(
      "- 产品主参考：" +
        compact(input.truth.productName, 80) +
        "；以已确认产品主图作为唯一产品身份基准。"
    );
  }

  const used = new Set(
    input.clip.referenceAssets.map((item) => item.assetId)
  );
  if (input.productionAssetSet) {
    for (const entry of input.productionAssetSet.entries) {
      if (
        entry.status !== "READY" ||
        !used.has(entry.referenceAssetId) ||
        entry.kind === "PRODUCT"
      ) {
        continue;
      }
      lines.push(productionReferenceLine(entry));
      if (lines.length >= 5) break;
    }
  }
  if (input.creativeReferences && lines.length < 5) {
    for (const entry of input.creativeReferences.entries) {
      if (!used.has(entry.assetId)) continue;
      lines.push(creativeReferenceLine(entry));
      if (lines.length >= 5) break;
    }
  }
  if (!lines.length) {
    lines.push("- 按本段场景与动作生成，不引入额外参考身份。");
  }
  return lines;
}

function audioLine(contract: DirectorV3ClipContract): string {
  if (contract.audio.mode === "SILENT") {
    return "本段明确为静音画面，不生成声音，也不生成背景音乐。";
  }
  const parts: string[] = [
    "不生成背景音乐。"
  ];
  if (contract.audio.ambience.length) {
    parts.push(
      "生成并保留自然环境声：" +
        contract.audio.ambience
          .slice(0, 4)
          .map((item) => compact(item, 80))
          .join("、") +
        "。"
    );
  }
  if (contract.audio.sfx.length) {
    parts.push(
      "生成并保留与动作同步的交互声/音效：" +
        contract.audio.sfx
          .slice(0, 5)
          .map((item) => compact(item, 80))
          .join("、") +
        "。"
    );
  }
  for (const voice of contract.audio.dialogueOrOs.slice(0, 3)) {
    parts.push(
      (voice.kind === "DIALOGUE"
        ? "人物对白："
        : "OS旁白：") +
        "“" +
        compact(voice.text, 120) +
        "”。"
    );
  }
  if (
    !contract.audio.ambience.length &&
    !contract.audio.sfx.length &&
    !contract.audio.dialogueOrOs.length
  ) {
    parts.push(
      "生成并保留与画面动作一致的自然现场声和轻微交互声。"
    );
  }
  return parts.join("");
}

export type SeedancePromptV3Input = {
  truth: ProductTruth;
  plan: ProductionPlan;
  scene: ProductionPlan["scenes"][number];
  clip: Clip;
  contract: DirectorV3ClipContract;
  productionAssetSet?: ProductionAssetSet;
  creativeReferences?: CreativeReferenceSet | null;
  model: string;
  aspectRatio: string;
  videoResolution?: string;
};

export function buildSeedancePromptV3(
  input: SeedancePromptV3Input
): string {
  const {
    truth,
    clip,
    contract
  } = input;
  if (clip.durationMs !== contract.durationMs) {
    throw new DomainValidationError(
      "Seedance Prompt V3 的 Clip 时长与 Clip Contract 不一致"
    );
  }
  const references = referenceLines({
    truth,
    clip,
    productionAssetSet: input.productionAssetSet,
    creativeReferences: input.creativeReferences
  });
  const lines: string[] = [
    "【参考素材】",
    ...references,
    "",
    "【本段视频目标】",
    compact(contract.purpose, 260) +
      " 场景：" +
      compact(contract.location, 80) +
      "。时长 " +
      seconds(contract.durationMs) +
      " 秒，" +
      input.aspectRatio +
      (input.videoResolution
        ? "，" + input.videoResolution
        : "") +
      "。",
    "",
    "【动作与时间顺序】"
  ];

  for (const action of contract.actions) {
    lines.push(
      seconds(action.startMs) +
        "–" +
        seconds(action.endMs) +
        "秒：" +
        compact(action.description, 220) +
        (action.productState
          ? "；产品状态：" +
            compact(action.productState, 120)
          : "")
    );
  }

  lines.push(
    "",
    "【摄影】",
    [
      contract.camera.shotSize,
      contract.camera.position,
      contract.camera.angle,
      contract.camera.movement
    ]
      .map((item) => compact(item, 100))
      .join("；") +
      "。全段只围绕当前剧情目标拍摄，不自行增加场景或额外动作。",
    "",
    "【声音】",
    audioLine(contract),
    "",
    "【全局约束】"
  );

  const constraints: string[] = [];
  if (contract.globalConstraints.preserveProductIdentity) {
    constraints.push(
      "本段出现产品时，严格保持已确认产品主参考图的整体外形、比例、颜色、纹样、缝线、边缘结构和材质，不重新设计、不替换款式。"
    );
  }
  if (contract.globalConstraints.noReadableText) {
    constraints.push(
      "生成画面中不出现任何可读文字、字幕、数字、标签、水印、UI 或额外文字 Logo；需要的文案全部由后期添加。"
    );
  }
  const facts = factsForClip(truth, clip);
  if (facts.length) {
    constraints.push(
      "涉及产品信息时，只依据已确认事实：" +
        facts
          .map((fact) => compact(fact.statement, 120))
          .join("；") +
        "。"
    );
  }
  const hard = truth.forbiddenChanges
    .filter((item) => item.severity === "HARD")
    .slice(0, 4);
  if (hard.length) {
    constraints.push(
      "不可改变：" +
        hard
          .map((item) => compact(item.description, 100))
          .join("；") +
        "。"
    );
  }
  constraints.push(
    "不得增加未确认的功效、认证、参数、人物、道具或剧情事实。"
  );
  for (const extra of contract.globalConstraints.extra.slice(0, 3)) {
    constraints.push(compact(extra, 120));
  }
  lines.push(...constraints);

  return lines.join("\n").trim();
}

export type SeedancePromptV3LintCode =
  | "PROMPT_TOO_LONG"
  | "INTERNAL_ID_LEAK"
  | "HASH_LEAK"
  | "INTERNAL_TOKEN_LEAK"
  | "SECTION_MISSING"
  | "GLOBAL_CONSTRAINT_DUPLICATED"
  | "BGM_POLICY_MISSING"
  | "NATIVE_AUDIO_MISSING"
  | "LEGACY_AUDIO_DISABLE_PRESENT";

export function lintSeedancePromptV3(
  prompt: string,
  contract: DirectorV3ClipContract
): SeedancePromptV3LintCode[] {
  const codes: SeedancePromptV3LintCode[] = [];
  if (prompt.length > SEEDANCE_PROMPT_V3_MAX_CHARS) {
    codes.push("PROMPT_TOO_LONG");
  }
  if (UUID_PATTERN.test(prompt)) codes.push("INTERNAL_ID_LEAK");
  if (HASH_PATTERN.test(prompt)) codes.push("HASH_LEAK");
  if (INTERNAL_TOKEN_PATTERN.test(prompt)) {
    codes.push("INTERNAL_TOKEN_LEAK");
  }
  for (const section of [
    "【参考素材】",
    "【本段视频目标】",
    "【动作与时间顺序】",
    "【摄影】",
    "【声音】",
    "【全局约束】"
  ]) {
    if (!prompt.includes(section)) {
      codes.push("SECTION_MISSING");
      break;
    }
  }
  if (
    (prompt.match(/【全局约束】/g) ?? []).length !== 1
  ) {
    codes.push("GLOBAL_CONSTRAINT_DUPLICATED");
  }
  if (
    contract.audio.mode === "NATIVE" &&
    !/不生成背景音乐/.test(prompt)
  ) {
    codes.push("BGM_POLICY_MISSING");
  }
  if (
    contract.audio.mode === "NATIVE" &&
    !/(?:生成并保留|自然现场声|人物对白|OS旁白)/.test(
      prompt
    )
  ) {
    codes.push("NATIVE_AUDIO_MISSING");
  }
  if (
    /不请求模型原生音轨|不要生成对白、旁白、环境声|声音由后期统一处理/.test(
      prompt
    )
  ) {
    codes.push("LEGACY_AUDIO_DISABLE_PRESENT");
  }
  return [...new Set(codes)];
}

export function assertSeedancePromptV3(
  prompt: string,
  contract: DirectorV3ClipContract
): void {
  const codes = lintSeedancePromptV3(prompt, contract);
  if (codes.length) {
    throw new DomainValidationError(
      "Seedance Prompt V3 未通过提交前检查：" +
        codes.join(", ")
    );
  }
}

export function createSeedancePromptV3Draft(input: {
  projectId: string;
  clipId: string;
  contract: DirectorV3ClipContract;
  promptText: string;
  now?: string;
}): SeedancePromptV3Draft {
  assertSeedancePromptV3(
    input.promptText,
    input.contract
  );
  const now = input.now ?? new Date().toISOString();
  const sourceContractHash = hashValue(input.contract);
  const base = {
    version: SEEDANCE_PROMPT_V3_VERSION,
    id: randomUUID(),
    projectId: input.projectId,
    clipId: input.clipId,
    sourceContractHash,
    status: "DRAFT" as const,
    promptText: input.promptText,
    originalPromptText: input.promptText,
    createdAt: now,
    updatedAt: now
  };
  return seedancePromptV3DraftSchema.parse({
    ...base,
    contentHash: hashValue(base)
  });
}
