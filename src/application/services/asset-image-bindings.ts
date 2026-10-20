import { DomainValidationError } from "../../domain/validation.js";
import type { GenerationRequest } from "../../domain/schemas.js";

/**
 * A UI image number is the index in the ordered IMAGE inputs, not an image ID
 * invented by the model. CLI -image args and this table use one ordering rule.
 * A named reference does not magically become a hard first-frame control.
 */
type ManifestAsset = Pick<
  GenerationRequest["assetManifest"][number],
  "assetId" | "artifactHash" | "priority" | "inputType"
>;

export type AssetImageBinding = {
  imageIndex: number;
  assetName: string;
  assetId: string;
  artifactHash: string;
  providerSlot: "REFERENCE_IMAGE" | "FIRST_FRAME" | "LAST_FRAME";
  referencedByPrompt: boolean;
};

type RequestFields = Pick<GenerationRequest,
  "promptText" | "assetManifest" | "dreaminaOperation" | "imageBindings"
>;

type ResolvedInput = {
  assetId: string;
  artifactHash: string;
  priority: number;
  inputType?: "image" | "video" | "audio";
};

export function orderedImageAssets<T extends ManifestAsset>(assets: readonly T[]): T[] {
  return [...assets]
    .sort((a, b) => a.priority - b.priority || a.assetId.localeCompare(b.assetId))
    .filter(a => !a.inputType || a.inputType === "image");
}

/** Parse the user-visible "县令@图片1；场景@图片3" without guessing names. */
export function parseNamedImageMentions(promptText: string): Map<number, string> {
  const mentions = new Map<number, string>();
  const indexByName = new Map<string, number>();
  const tokens = [...promptText.matchAll(/@图片(\d+)/g)];
  const named = [...promptText.matchAll(/([\p{L}\p{N}_·-]{1,48})@图片(\d+)/gu)];
  if (named.length !== tokens.length) {
    throw new DomainValidationError("图片引用需要写成“资产名@图片编号”，例如“县令@图片1”。");
  }
  for (const match of named) {
    const name = match[1]!;
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new DomainValidationError("图片编号必须从1开始：" + match[0]);
    }
    const previous = mentions.get(index);
    if (previous && previous !== name) {
      throw new DomainValidationError(`@图片${index} 被用于不同资产（${previous}、${name}），请确认绑定。`);
    }
    const oldIndex = indexByName.get(name);
    if (oldIndex && oldIndex !== index) {
      throw new DomainValidationError(`资产“${name}”同时引用图片${oldIndex}与图片${index}，请先确认唯一对应关系。`);
    }
    mentions.set(index, name);
    indexByName.set(name, index);
  }
  return mentions;
}

export function buildAssetImageBindings(input: {
  promptText: string;
  assetManifest: readonly ManifestAsset[];
  dreaminaOperation?: GenerationRequest["dreaminaOperation"];
  namesByAssetId?: Readonly<Record<string, string>>;
}): AssetImageBinding[] {
  const mentions = parseNamedImageMentions(input.promptText);
  if (!mentions.size) return [];
  const ordered = orderedImageAssets(input.assetManifest);
  for (const index of mentions.keys()) {
    if (index > ordered.length) {
      throw new DomainValidationError(`提示词引用@图片${index}，但当前片段只有${ordered.length}张图片；不能提交错误素材。`);
    }
  }
  return ordered.map((asset, offset) => {
    const imageIndex = offset + 1;
    return {
      imageIndex,
      assetId: asset.assetId,
      artifactHash: asset.artifactHash,
      assetName: mentions.get(imageIndex) ??
        input.namesByAssetId?.[asset.assetId] ?? `未命名参考图${imageIndex}`,
      providerSlot: input.dreaminaOperation === "frames2video"
        ? (imageIndex === 1 ? "FIRST_FRAME" : imageIndex === 2 ? "LAST_FRAME" : "REFERENCE_IMAGE")
        : input.dreaminaOperation === "image2video" && imageIndex === 1
          ? "FIRST_FRAME"
          : "REFERENCE_IMAGE",
      referencedByPrompt: mentions.has(imageIndex)
    };
  });
}

/**
 * Verify both the request snapshot and the resolved on-disk files immediately
 * before constructing CLI args. A stale picture/hash/slot must never submit.
 */

/** A user-selected ratio must reach a verified CLI --ratio input, not AUTO. */
export function assertNamedImageAspectRatio(input: {
  promptText: string;
  requestedRatio: string;
  aspectRatioMode?: "EXPLICIT" | "INFER_FROM_FIRST_FRAME" | "COMMAND_DEFAULT";
}): void {
  if (!/@图片\d+/.test(input.promptText) || input.requestedRatio === "AUTO") return;
  if (input.aspectRatioMode !== "EXPLICIT") {
    throw new DomainValidationError(
      "当前即梦多图/首帧模式不能显式锁定" + input.requestedRatio +
      "画幅，不能只在提示词中要求竖屏后继续付费。请选择支持--ratio的模型与模式。"
    );
  }
}

export function assertAssetImageBindings(
  request: RequestFields,
  resolved?: readonly ResolvedInput[]
): void {
  // Historical V2/V3 requests without a binding version keep their old path.
  if (!request.imageBindings) return;
  const bindings = request.imageBindings;
  const images = orderedImageAssets(request.assetManifest);
  const mentions = parseNamedImageMentions(request.promptText);
  if (bindings.length !== images.length || !bindings.length) {
    throw new DomainValidationError("图片绑定清单与实际图片数量不符，需要重新预检。");
  }
  if (mentions.size === 0) {
    throw new DomainValidationError("图片绑定清单已存在，但提示词缺少资产名@图片编号。");
  }
  const seenIndices = new Set<number>();
  for (const binding of bindings) {
    if (!Number.isInteger(binding.imageIndex) || binding.imageIndex < 1 ||
        binding.imageIndex > images.length || seenIndices.has(binding.imageIndex)) {
      throw new DomainValidationError("图片编号重复、缺失或越界，禁止生成。");
    }
    seenIndices.add(binding.imageIndex);
    const asset = images[binding.imageIndex - 1]!;
    if (binding.assetId !== asset.assetId || binding.artifactHash !== asset.artifactHash) {
      throw new DomainValidationError(`@图片${binding.imageIndex} 对应素材已变化，必须重新确认。`);
    }
    const named = mentions.get(binding.imageIndex);
    if (Boolean(named) !== binding.referencedByPrompt ||
        (named && named !== binding.assetName)) {
      throw new DomainValidationError(`@图片${binding.imageIndex} 的名称与已确认素材不一致。`);
    }
    const expectedSlot = request.dreaminaOperation === "frames2video"
      ? (binding.imageIndex === 1 ? "FIRST_FRAME" : binding.imageIndex === 2 ? "LAST_FRAME" : "REFERENCE_IMAGE")
      : request.dreaminaOperation === "image2video" && binding.imageIndex === 1
        ? "FIRST_FRAME"
        : "REFERENCE_IMAGE";
    if (binding.providerSlot !== expectedSlot) {
      throw new DomainValidationError(`@图片${binding.imageIndex} 的模型输入槽位与实际生成方式不匹配。`);
    }
  }
  for (const index of mentions.keys()) {
    if (!seenIndices.has(index)) {
      throw new DomainValidationError(`@图片${index} 未绑定实际图片文件。`);
    }
  }
  if (resolved) {
    const actual = orderedImageAssets(resolved);
    if (actual.length !== images.length ||
        images.some((expected, i) =>
          actual[i]?.assetId !== expected.assetId ||
          actual[i]?.artifactHash !== expected.artifactHash)) {
      throw new DomainValidationError("即梦实际读取的图片文件与已确认资产编号/哈希不一致，已阻断提交。");
    }
  }
}
