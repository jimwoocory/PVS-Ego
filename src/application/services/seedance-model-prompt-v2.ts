import type {
  ProductTruth,
  ProductionPlan,
  Clip,
  ProductFact
} from "../../domain/schemas.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { CreativeReferenceSet } from "../../domain/creative-reference.js";
import { DomainValidationError } from "../../domain/validation.js";

export const SEEDANCE_MODEL_PROMPT_V2_VERSION = "seedance-model-prompt-v2-1";
export const SEEDANCE_MODEL_PROMPT_V2_MAX_CHARS = 2600;

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HASH_PATTERN = /\b[0-9a-f]{64}\b/i;
const INTERNAL_TOKEN_PATTERN =
  /\b(?:compiler_template|capability_fingerprint|command_help_sha256|estimatorVersion|required_facts|post_production_text_cues|creativeReferenceSet|productionAssetSet|segmentId|factId|artifactHash|contentHash)\b/i;

function compact(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function factsForClip(
  truth: ProductTruth,
  clip: Clip
): ProductFact[] {
  const ids = new Set([
    ...clip.requiredFactIds,
    ...clip.segments.flatMap(segment => segment.requiredFactIds)
  ]);
  return [...truth.confirmedFeatures, ...truth.sellingPoints]
    .filter(item => ids.has(item.id))
    .slice(0, 6);
}

function assetIdentityLines(
  set: ProductionAssetSet | undefined,
  clip: Clip
): string[] {
  if (!set) return [];
  const used = new Set(clip.referenceAssets.map(item => item.assetId));
  return set.entries
    .filter(
      entry =>
        entry.status === "READY" &&
        (used.has(entry.referenceAssetId) || entry.kind === "PRODUCT")
    )
    .slice(0, 8)
    .map(entry => {
      const lock = entry.identityLock.length
        ? "；保持：" + entry.identityLock.slice(0, 3).map(item => compact(item, 90)).join("；")
        : "";
      return "- " + entry.label + "：" + compact(entry.description, 140) + lock;
    });
}

function researchLines(
  references: CreativeReferenceSet | null | undefined,
  clip: Clip
): string[] {
  if (!references) return [];
  const used = new Set(clip.referenceAssets.map(item => item.assetId));
  return references.entries
    .filter(entry => used.has(entry.assetId))
    .slice(0, 5)
    .map(entry => "- " + compact(entry.description, 130));
}

function audioLine(clip: Clip, generateAudio: boolean): string {
  if (!generateAudio) {
    return "本镜头不请求模型原生音轨。不要生成对白、旁白、环境声或音乐；声音由后期统一处理。";
  }
  const cues = clip.segments.flatMap(segment => {
    const items: string[] = [];
    if (segment.dialogueOrNarration.kind !== "NONE") {
      items.push(
        (segment.dialogueOrNarration.kind === "DIALOGUE" ? "对白" : "旁白") +
          "“" +
          compact(segment.dialogueOrNarration.text, 90) +
          "”"
      );
    }
    if (segment.ambientSound.kind !== "NONE") {
      items.push("环境声：" + compact(segment.ambientSound.description, 90));
    }
    return items;
  });
  const specified = cues.length
    ? "只生成这些声音：" + cues.slice(0, 6).join("；") + "。"
    : "只生成与画面动作直接相关的自然声音。";
  return specified + " 严禁背景音乐、配乐、歌曲、音乐垫底或任何 musical score。";
}

export type SeedanceModelPromptV2Input = {
  truth: ProductTruth;
  plan: ProductionPlan;
  scene: ProductionPlan["scenes"][number];
  clip: Clip;
  productionAssetSet?: ProductionAssetSet;
  creativeReferences?: CreativeReferenceSet | null;
  model: string;
  aspectRatio: string;
  videoResolution?: string;
  generateAudio: boolean;
};

export function buildSeedanceModelPromptV2(
  input: SeedanceModelPromptV2Input
): string {
  const { truth, scene, clip } = input;
  const lines: string[] = [];

  lines.push(
    "【镜头目标】",
    compact(clip.purpose, 220) +
      "。时长 " +
      seconds(clip.durationMs) +
      " 秒，" +
      input.aspectRatio +
      (input.videoResolution ? "，" + input.videoResolution : "") +
      "。"
  );

  lines.push(
    "",
    "【场景与连续性】",
    compact(
      scene.location +
        (scene.timeOfDay ? "，" + scene.timeOfDay : "") +
        "。开场：" +
        clip.openingState.description +
        "。结束：" +
        clip.closingState.description,
      360
    )
  );

  const identity = assetIdentityLines(input.productionAssetSet, clip);
  if (identity.length) {
    lines.push("", "【固定身份参考】", ...identity);
  }

  const research = researchLines(input.creativeReferences, clip);
  if (research.length) {
    lines.push(
      "",
      "【可借鉴的视觉方法】",
      ...research,
      "只借鉴构图、动作或场景方法，不复制来源内容，不把参考素材当作产品事实。"
    );
  }

  lines.push("", "【按时间执行】");
  for (const segment of [...clip.segments].sort(
    (a, b) => a.startMs - b.startMs || a.order - b.order
  )) {
    const camera = [
      segment.shotSize,
      segment.cameraAngle,
      segment.cameraMovement
    ]
      .filter(Boolean)
      .map(item => compact(item, 70))
      .join("，");
    const action = compact(segment.subjectAction, 220);
    const productState =
      clip.productVisibility !== "NONE"
        ? "；产品状态：" + compact(segment.productState, 130)
        : "";
    lines.push(
      seconds(segment.startMs) +
        "–" +
        seconds(segment.endMs) +
        "秒：" +
        action +
        productState +
        (camera ? "；镜头：" + camera : "")
    );
  }

  const facts = factsForClip(truth, clip);
  lines.push(
    "",
    "【产品约束】",
    "产品外观必须严格遵循所附确认产品参考图，不改变形状、比例、颜色、图案、材质或品牌身份。"
  );
  if (facts.length) {
    lines.push(
      "本镜头只允许依赖以下已确认产品信息：" +
        facts.map(item => compact(item.statement, 150)).join("；")
    );
  }
  const hard = truth.forbiddenChanges
    .filter(item => item.severity === "HARD")
    .slice(0, 5);
  if (hard.length) {
    lines.push(
      "不可改变：" +
        hard.map(item => compact(item.description, 120)).join("；")
    );
  }
  const rules = (truth.usageRules ?? [])
    .filter(item => item.status === "CONFIRMED")
    .slice(0, 5);
  if (rules.length) {
    lines.push(
      "使用方式必须遵守：" +
        rules.map(item => compact(item.statement, 130)).join("；")
    );
  }

  lines.push("", "【声音】", audioLine(clip, input.generateAudio));

  lines.push(
    "",
    "【禁止】",
    "不要在生成画面中出现任何可读文字、字幕、数字、标签、UI、CTA 或额外 Logo 文字；需要的文字全部由后期添加。",
    "不要增加未经确认的产品功效、认证、参数或剧情事实。",
    "不要生成背景音乐。"
  );

  return lines.join("\n").trim();
}

export type SeedancePromptLintCode =
  | "INTERNAL_ID_LEAK"
  | "HASH_LEAK"
  | "INTERNAL_TOKEN_LEAK"
  | "PROMPT_TOO_LONG"
  | "AUDIO_CONTRADICTION"
  | "BGM_POLICY_CONTRADICTION";

export function lintSeedanceModelPromptV2(
  prompt: string,
  generateAudio: boolean
): SeedancePromptLintCode[] {
  const codes: SeedancePromptLintCode[] = [];
  if (UUID_PATTERN.test(prompt)) codes.push("INTERNAL_ID_LEAK");
  if (HASH_PATTERN.test(prompt)) codes.push("HASH_LEAK");
  if (INTERNAL_TOKEN_PATTERN.test(prompt)) codes.push("INTERNAL_TOKEN_LEAK");
  if (prompt.length > SEEDANCE_MODEL_PROMPT_V2_MAX_CHARS) {
    codes.push("PROMPT_TOO_LONG");
  }
  if (
    !generateAudio &&
    /(?:生成|保留|加入|添加).{0,12}(?:对白|旁白|环境声|原生音轨)/i.test(prompt) &&
    !/不请求模型原生音轨/.test(prompt)
  ) {
    codes.push("AUDIO_CONTRADICTION");
  }
  if (
    /(?:添加|加入|生成|配上|使用).{0,12}(?:背景音乐|配乐|歌曲|音乐垫底|musical score)/i.test(
      prompt
    ) &&
    !/严禁背景音乐|不要生成背景音乐/.test(prompt)
  ) {
    codes.push("BGM_POLICY_CONTRADICTION");
  }
  return [...new Set(codes)];
}

export function assertSeedanceModelPromptV2(
  prompt: string,
  generateAudio: boolean
): void {
  const codes = lintSeedanceModelPromptV2(prompt, generateAudio);
  if (codes.length) {
    throw new DomainValidationError(
      "Seedance Model Prompt V2 未通过提交前检查：" + codes.join(", ")
    );
  }
}
