import test from "node:test";
import assert from "node:assert/strict";
import { compileV8ShotShadow } from "../src/application/services/v8-shot-prompt-shadow.js";
import type { ScriptDraft, ProductionPlan } from "../src/domain/schemas.js";
import type { ProductionAssetSet } from "../src/domain/production-strategy.js";
import { makeValidClip, H, ISO } from "./fixtures.js";

function fixture() {
  const script: ScriptDraft = {
    id: "script-test", projectId: "project-test", version: 1, status: "CONFIRMED",
    productTruthRef: { entityType: "ProductTruth", entityId: "truth-test", version: 1, hash: H.a },
    creativeBatchRef: { entityType: "CreativeBatch", entityId: "creative-test", version: 1, hash: H.b },
    selectedCreativeId: "concept-test", targetDurationMs: 8000, contentHash: H.c, confirmedAt: ISO,
    beats: [{
      id: "beat-test", order: 1, purpose: "HOOK", text: "两位成年人在卧室谈论产品。",
      estimatedDurationMs: 8000, requiredFactIds: [],
      videoIntent: {
        location: "卧室", storyAction: "主人公展示产品，室友提出问题。",
        productRole: "产品是对话焦点", stateIn: "两人尚未谈话", stateOut: "两人已讨论产品",
        dialogue: "主人公：“我来演示。”室友：“这是产品吗？”",
        audioIntent: { ambience: ["卧室现场声"], sfx: [], bgm: false },
        postProductionText: ["品牌名称"]
      }
    }]
  };
  const clip = makeValidClip();
  clip.id = "clip-test";
  clip.sceneId = "scene-test";
  clip.sourceBeatIds = ["beat-test"];
  clip.segments.forEach(segment => { segment.sourceBeatIds = ["beat-test"]; });
  clip.segments[0]!.composition = "主人公在左侧前景，室友在右侧中景";
  clip.segments[0]!.subjectAction = "主人公拿出产品，清楚露出产品形状";
  clip.segments[0]!.dialogueOrNarration = {
    kind: "DIALOGUE", text: "主人公：“我来演示。”",
    estimatedDurationMs: 1200, estimatorVersion: "test"
  };
  clip.segments[1]!.dialogueOrNarration = {
    kind: "DIALOGUE", text: "室友：“这是产品吗？”",
    estimatedDurationMs: 2000, estimatorVersion: "test"
  };
  clip.segments[1]!.postProductionText = [{
    kind: "LABEL", text: "品牌名称", startMs: 5000, endMs: 7000,
    position: "BOTTOM", fontScale: 1, sourceBeatIds: ["beat-test"], requiredFactIds: []
  }];
  clip.referenceAssets = [
    { assetId: "asset-a", role: "CHARACTER", priority: 0, required: true },
    { assetId: "asset-b", role: "CHARACTER", priority: 1, required: true }
  ];
  const plan = {
    id: "plan-test", projectId: "project-test", version: 1, status: "CONFIRMED",
    scriptRef: { entityType: "ScriptDraft", entityId: script.id, version: script.version, hash: script.contentHash },
    visualDirection: "真实写实，保持人物空间连续", contentHash: H.d,
    scenes: [{ id: "scene-test", location: "卧室", clips: [clip] }]
  } as unknown as ProductionPlan;
  const productionAssetSet = { entries: [
    { key: "CHARACTER_A", label: "主人公参考图", referenceAssetId: "asset-a", kind: "CHARACTER", status: "READY" },
    { key: "CHARACTER_B", label: "室友参考图", referenceAssetId: "asset-b", kind: "CHARACTER", status: "READY" }
  ] } as ProductionAssetSet;
  const bindings = { "主人公": "CHARACTER_A", "室友": "CHARACTER_B" };
  return { script, plan, productionAssetSet, bindings };
}

test("V8 shadow compiler renders actual detailed shots and exact speaker-bound dialogue", () => {
  const f = fixture();
  const result = compileV8ShotShadow({
    script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet,
    speakerBindings: f.bindings
  });
  assert.equal(result.status, "PASS", JSON.stringify(result.issues));
  assert.equal(result.coverage.sourceDialogueCount, 2);
  assert.equal(result.coverage.mappedDialogueCount, 2);
  assert.equal(result.coverage.mappedTextCount, 1);
  const prompt = result.clips[0]!.promptText;
  assert.match(prompt, /主人公在左侧前景，室友在右侧中景/);
  assert.match(prompt, /主人公开口说：“我来演示。”/);
  assert.match(prompt, /室友开口说：“这是产品吗？”/);
  assert.match(prompt, /使用同一角色声线|保持同一角色声线/);
  assert.match(prompt, /【后期字幕及画外文案/);
  assert.match(prompt, /品牌名称/);
  assert.match(prompt, /总时长：8 秒/);
  assert.equal(result.clips[0]!.sourceShotIds.length, 2);
  assert.equal(result.issues.length, 0);
});

test("V8 shadow blocks a missing script text cue instead of silently dropping it", () => {
  const f = fixture();
  f.plan.scenes[0]!.clips[0]!.segments[1]!.postProductionText = [];
  const result = compileV8ShotShadow({
    script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet,
    speakerBindings: f.bindings
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(issue => issue.code === "POST_PRODUCTION_CUE_MISSING"));
  assert.match(result.clips[0]!.promptText, /待排布的剧本后期文案：品牌名称/);
});

test("V8 shadow refuses to guess unbound speakers from reference-image order", () => {
  const f = fixture();
  const result = compileV8ShotShadow({ script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.issues.filter(issue => issue.code === "SPEAKER_ASSET_UNBOUND").length, 2, JSON.stringify(result.issues));
  assert.equal(result.coverage.mappedDialogueCount, 2);
});

test("V8 shadow detects transcript substitution and loss of script-level dialogue", () => {
  const f = fixture();
  f.plan.scenes[0]!.clips[0]!.segments[1]!.dialogueOrNarration = {
    kind: "DIALOGUE", text: "室友：“你在说什么？”",
    estimatedDurationMs: 1100, estimatorVersion: "test"
  };
  const result = compileV8ShotShadow({
    script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet, speakerBindings: f.bindings
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(issue => issue.code === "DIALOGUE_NOT_IN_SOURCE"));
  assert.ok(result.issues.some(issue => issue.code === "SCRIPT_DIALOGUE_COVERAGE"));
});

test("V8 shadow fails closed for a source-script version mismatch", () => {
  const f = fixture();
  f.plan.scriptRef.hash = H.e;
  const result = compileV8ShotShadow({
    script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet, speakerBindings: f.bindings
  });
  assert.ok(result.issues.some(issue => issue.code === "PLAN_SCRIPT_VERSION_MISMATCH"));
  assert.equal(result.status, "BLOCKED");
});

test("V8 source audit reconstructs split dialogue once and detects part loss or substitution", () => {
  const f = fixture();
  const first = "等一下，这不是普通的香水味。";
  const second = "卧室里这股草本味到底是谁的？";
  const full = first + second;
  f.script.beats[0]!.videoIntent!.dialogue = "室友：“" + full + "”";
  const segments = f.plan.scenes[0]!.clips[0]!.segments;
  segments.forEach((segment, index) => {
    const text = index === 0 ? first : second;
    segment.dialogueOrNarration = {
      kind: "DIALOGUE", text: "室友：“" + text + "”",
      estimatedDurationMs: 2500, estimatorVersion: "test"
    };
    segment.v8 = {
      sourceShotId: "part-" + (index + 1), sourceBeatId: "beat-test",
      sourceActionHash: H.f, shotFunction: "SPEECH",
      spoken: {
        speaker: "室友", mode: "ONSCREEN", exactText: text,
        tone: "疑惑", delivery: "正常语速", sourceLineText: full,
        sourcePartIndex: index + 1, sourcePartCount: 2
      }
    };
  });
  const compile = () => compileV8ShotShadow({
    script: f.script, plan: f.plan, productionAssetSet: f.productionAssetSet,
    speakerBindings: f.bindings
  });
  const pass = compile();
  assert.equal(pass.status, "PASS", JSON.stringify(pass.issues));
  assert.equal(pass.coverage.sourceDialogueCount, 1);
  assert.equal(pass.coverage.mappedDialogueCount, 1);
  assert.deepEqual(pass.clips[0]!.dialogueLines.map(line => line.text), [first, second]);
  segments[1]!.dialogueOrNarration = {
    kind: "DIALOGUE", text: "室友：“这话被错误替换了。”",
    estimatedDurationMs: 2500, estimatorVersion: "test"
  };
  const drift = compile();
  assert.equal(drift.status, "BLOCKED");
  assert.ok(drift.issues.some(issue => issue.code === "DIALOGUE_FRAGMENT_DRIFT"));
  segments[1]!.dialogueOrNarration = {kind: "NONE"};
  const loss = compile();
  assert.equal(loss.status, "BLOCKED");
  assert.ok(loss.issues.some(issue => issue.code === "DIALOGUE_PART_INCOMPLETE"));
  assert.ok(loss.issues.some(issue => issue.code === "SCRIPT_DIALOGUE_COVERAGE"));
});
