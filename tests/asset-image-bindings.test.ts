import test from "node:test";
import { makeRequest } from "./fixtures.js";
import { buildAgentSubmitArgs } from "../src/adapters/video/verified-dreamina-runtime-loader.js";
import assert from "node:assert/strict";
import {
  assertAssetImageBindings,
  assertNamedImageAspectRatio,
  buildAssetImageBindings,
  orderedImageAssets,
  parseNamedImageMentions
} from "../src/application/services/asset-image-bindings.js";

const H = "f".repeat(64);
const assets = Array.from({ length: 5 }, (_, i) => ({
  assetId: "artifact-" + (i + 1),
  artifactHash: String.fromCharCode(97 + i).repeat(64),
  priority: i,
  required: true,
  role: "CHARACTER" as const,
  inputType: "image" as const
}));

test("mixed-index references bind names to exact ordered input files, not guessed model semantics", () => {
  const promptText = "县令@图片1；公堂场景@图片3；上一个视频尾帧@图片5";
  const imageBindings = buildAssetImageBindings({
    promptText,
    assetManifest: assets,
    dreaminaOperation: "multimodal2video"
  });
  assert.deepEqual(imageBindings.filter(b => b.referencedByPrompt)
    .map(b => [b.assetName, b.imageIndex, b.assetId]), [
      ["县令", 1, "artifact-1"],
      ["公堂场景", 3, "artifact-3"],
      ["上一个视频尾帧", 5, "artifact-5"]
    ]);
  assert.equal(imageBindings[4]?.providerSlot, "REFERENCE_IMAGE",
    "multimodal tail reference is NOT a hard first frame");
  assertAssetImageBindings({ promptText, assetManifest: assets,
    dreaminaOperation: "multimodal2video", imageBindings }, assets);
});

test("CLI sorting is deterministic, independent of upload array position", () => {
  const shuffled = [assets[3]!, assets[0]!, assets[4]!, assets[1]!, assets[2]!];
  assert.deepEqual(orderedImageAssets(shuffled).map(a => a.assetId),
    assets.map(a => a.assetId));
  const bindings = buildAssetImageBindings({
    promptText: "县令@图片1，场景@图片3，尾帧@图片5", assetManifest: shuffled,
    dreaminaOperation: "multimodal2video"
  });
  assertAssetImageBindings({
    promptText: "县令@图片1，场景@图片3，尾帧@图片5",
    assetManifest: shuffled,
    dreaminaOperation: "multimodal2video",
    imageBindings: bindings
  }, shuffled);
});

test("reject dangling index, missing label, contradictory name and contradictory ordinal", () => {
  assert.throws(() => buildAssetImageBindings({ promptText: "县令@图片6",
    assetManifest: assets }), /只有5张图片/);
  assert.throws(() => parseNamedImageMentions("单独写 @图片1"), /资产名@图片编号/);
  assert.throws(() => parseNamedImageMentions("县令@图片1；师爷@图片1"), /不同资产/);
  assert.throws(() => parseNamedImageMentions("县令@图片1；县令@图片2"), /唯一对应/);
  assert.throws(() => buildAssetImageBindings({ promptText: "场景@图片1",
    assetManifest: [] }), /只有0张图片/);
});

test("in-place slot/hash/submission order tampering blocks before any CLI submit", () => {
  const promptText = "县令@图片1；师爷@图片2";
  const manifest = assets.slice(0, 2);
  const imageBindings = buildAssetImageBindings({
    promptText, assetManifest: manifest, dreaminaOperation: "multimodal2video"
  });
  const request = { promptText, assetManifest: manifest,
    dreaminaOperation: "multimodal2video" as const, imageBindings };
  const changedOrder = [ { ...manifest[0]!, priority: 1 },
    { ...manifest[1]!, priority: 0 } ];
  assert.throws(() => assertAssetImageBindings({ ...request,
    assetManifest: changedOrder }), /对应素材已变化/);
  assert.throws(() => assertAssetImageBindings(request, [
    { ...manifest[0]!, artifactHash: H }, manifest[1]!
  ]), /实际读取的图片文件/);
  assert.throws(() => assertAssetImageBindings({ ...request,
    imageBindings: [ { ...imageBindings[0]!, providerSlot: "FIRST_FRAME" as const },
      imageBindings[1]! ] }), /槽位/);
  assert.throws(() => assertAssetImageBindings({ ...request,
    promptText: "师爷@图片1，县令@图片2" }), /名称/);
});

test("frames2video uses actual FIRST/LAST slots, not a generic image list", () => {
  const promptText = "第一帧@图片1；最后一帧@图片2";
  const manifest = assets.slice(0, 2);
  const imageBindings = buildAssetImageBindings({
    promptText, assetManifest: manifest, dreaminaOperation: "frames2video"
  });
  assert.deepEqual(imageBindings.map(b => b.providerSlot),
    ["FIRST_FRAME", "LAST_FRAME"]);
  assertAssetImageBindings({ promptText, assetManifest: manifest,
    dreaminaOperation: "frames2video", imageBindings }, manifest);
});

test("real CLI argument compiler preserves named image 1/3/5 file order and blocks mismatch", () => {
  const promptText = "县令@图片1；场景@图片3；上一个视频尾帧@图片5";
  const imageBindings = buildAssetImageBindings({
    promptText, assetManifest: assets, dreaminaOperation: "multimodal2video"
  });
  const request = { ...makeRequest(), promptText, assetManifest: assets,
    dreaminaOperation: "multimodal2video" as const, imageBindings };
  const resolved = assets.map((a, i) => ({ ...a, absolutePath: "C:/asset-" + (i + 1) + ".png" }));
  const args = buildAgentSubmitArgs(request, [...resolved].reverse(), "seedance2.0_vip");
  assert.deepEqual(args.flatMap((flag, index) => flag === "--image" ? [args[index + 1]] : []),
    resolved.map(a => a.absolutePath));
  assert.deepEqual(args.slice(args.indexOf("--ratio"), args.indexOf("--ratio") + 2),
    ["--ratio", "9:16"]);
  assert.throws(() => buildAgentSubmitArgs(request,
    resolved.map((a, i) => i === 4 ? { ...a, artifactHash: "f".repeat(64) } : a),
    "seedance2.0_vip"), /实际读取的图片文件/);
});

test("named image input forbids AUTO ratio fallback for a specified 9:16 project", () => {
  assert.doesNotThrow(()=>assertNamedImageAspectRatio({
    promptText:"县令@图片1",requestedRatio:"9:16",aspectRatioMode:"EXPLICIT"
  }));
  for(const aspectRatioMode of ["INFER_FROM_FIRST_FRAME","COMMAND_DEFAULT",undefined] as const){
    assert.throws(()=>assertNamedImageAspectRatio({
      promptText:"场景@图片3",requestedRatio:"9:16",aspectRatioMode
    }),/不能显式锁定9:16/);
  }
  assert.doesNotThrow(()=>assertNamedImageAspectRatio({
    promptText:"没有图片引用",requestedRatio:"9:16",aspectRatioMode:"COMMAND_DEFAULT"
  }));
});

test("historical requests with no binding version remain readable", () => {
  assert.doesNotThrow(() => assertAssetImageBindings({
    promptText: "县令@图片1", assetManifest: assets, imageBindings: undefined
  }));
  assert.deepEqual(buildAssetImageBindings({
    promptText: "县令持卷宗", assetManifest: assets
  }), []);
});
