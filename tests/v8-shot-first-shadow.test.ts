import test from "node:test";
import assert from "node:assert/strict";
import { planV8ShotFirstShadow } from "../src/application/services/v8-shot-first-shadow.js";
import type { ScriptDraft } from "../src/domain/schemas.js";
import { H, ISO } from "./fixtures.js";

function script(durations: number[], lines: string[] = []): ScriptDraft {
  return {
    id: "script-v8-shadow", projectId: "project-test", version: 1, status: "CONFIRMED",
    productTruthRef: { entityType: "ProductTruth", entityId: "truth-1", version: 1, hash: H.a },
    creativeBatchRef: { entityType: "CreativeBatch", entityId: "batch-1", version: 1, hash: H.b },
    selectedCreativeId: "concept-1", contentHash: H.c, confirmedAt: ISO,
    targetDurationMs: durations.reduce((a, b) => a + b, 0),
    beats: durations.map((ms, index) => ({
      id: "beat-" + index, order: index + 1,
      purpose: index === 0 ? "HOOK" as const : "FEATURE" as const,
      text: "讲述第" + index + "个故事节拍",
      estimatedDurationMs: ms, requiredFactIds: [],
      videoIntent: {
        location: "卧室", storyAction: "延续人物问答和产品展示",
        productRole: "不改变产品", stateIn: "故事持续", stateOut: "本段完成",
        ...(lines[index] ? { dialogue: lines[index] } : {}),
        audioIntent: { ambience: [], sfx: [], bgm: false as const },
        postProductionText: []
      }
    }))
  };
}

test("V8 shot-first preview preserves six variable 60s beats without four forced 15s clips", () => {
  const original = script([9000, 10000, 10000, 13000, 9000, 9000]);
  original.beats[0]!.videoIntent!.dialogue =
    "室友：“这股气味来自哪里？”主人公：“你猜？”";
  const originalText = structuredClone(original.beats[0]!.videoIntent!.dialogue);
  const result = planV8ShotFirstShadow({ script: original, modelMinSeconds: 4, modelMaxSeconds: 15 });
  // Non-speaking time is allocated to actual staging/action/reaction, not
  // padded onto a short line to fabricate a 4.2s-plus speech problem.
  assert.equal(result.status, "PASS");
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.clips.map(x => x.durationMs / 1000), [9, 10, 10, 13, 9, 9]);
  assert.equal(result.clips.reduce((t, c) => t + c.durationMs, 0), 60000);
  assert.equal(original.beats[0]!.videoIntent!.dialogue, originalText);
  const speech = result.clips[0]!.shots.filter(x => x.function === "SPEECH");
  assert.deepEqual(speech.map(x => x.dialogueText), ["这股气味来自哪里？", "你猜？"]);
  assert.ok(result.clips[0]!.shots.some(shot => shot.function === "ACTION"));
  assert.ok(speech.every(shot => shot.endMs - shot.startMs <= 4200));
  assert.equal(speech.reduce((sum, shot) => sum + shot.speechTimeEstimateMs!, 0), 2200);
});

test("V8 merges only genuinely too-short same-room beats", () => {
  const result = planV8ShotFirstShadow({
    script: script([2000, 3000, 5000]), modelMinSeconds: 4, modelMaxSeconds: 15
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.clips.map(x => x.durationMs), [5000, 5000]);
  assert.deepEqual(result.clips[0]!.beatIds, ["beat-0", "beat-1"]);
});

test("V8 refuses a too-long beat instead of truncating its dialogue", () => {
  const result = planV8ShotFirstShadow({
    script: script([17000]), modelMinSeconds: 4, modelMaxSeconds: 15
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(x => x.code === "BEAT_TOO_LONG_FOR_CLIP"));
  assert.ok(result.issues.some(x => x.code === "TOTAL_DURATION_MISMATCH"));
});

test("V8 blocks speech that cannot fit the real time budget", () => {
  const result = planV8ShotFirstShadow({
    script: script([4000], [
      "主人公：“这是一个需要比较长时间才能说清楚内容的重要说明，我们还没有结束这段话。”"
    ]), modelMinSeconds: 4, modelMaxSeconds: 15
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(x => x.code === "SPEECH_TOO_LONG"));
});

test("V8 safely splits a long utterance at punctuation, preserving every original character", () => {
  const utterance = "等一下，这不是我的香水味。卧室里这股草本味是谁的？";
  const input = script([9000], ["室友：“" + utterance + "”主人公：“猜猜看。”"]);
  const result = planV8ShotFirstShadow({ script: input, modelMinSeconds: 4, modelMaxSeconds: 15 });
  assert.equal(result.status, "PASS", JSON.stringify(result.issues));
  const speech = result.clips[0]!.shots.filter(shot => shot.function === "SPEECH");
  const roomMate = speech.filter(shot => shot.speaker === "室友");
  assert.ok(roomMate.length >= 2);
  assert.equal(roomMate.map(shot => shot.dialogueText).join(""), utterance);
  assert.ok(roomMate.every(shot => shot.sourceDialogueText === utterance));
  assert.deepEqual(roomMate.map(shot => shot.speechPartIndex), roomMate.map((_, i) => i + 1));
  assert.ok(speech.every(shot => shot.endMs - shot.startMs <= 4200));
  assert.equal(result.clips[0]!.shots.at(-1)!.endMs, 9000);
});

test("V8 blocks long unpunctuated speech without chopping the source line", () => {
  const utterance = "这个真正需要我们认真解释清楚的问题绝对不能被模型随便剪开否则观众可能完全不知道发生什么";
  const original = script([14000], ["主人公：“" + utterance + "”"]);
  const result = planV8ShotFirstShadow({ script: original, modelMinSeconds: 4, modelMaxSeconds: 15 });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(issue => issue.code === "SEMANTIC_SPEECH_MANUAL_CUT"));
  assert.ok(result.issues.some(issue => issue.code === "SPEECH_SHOT_REQUIRES_SPLIT"));
  assert.equal(result.clips[0]!.shots.find(shot => shot.function === "SPEECH")!.dialogueText, utterance);
  assert.equal(original.beats[0]!.videoIntent!.dialogue, "主人公：“" + utterance + "”");
});

test("V8 does not silently change integer model time constraints", () => {
  const result = planV8ShotFirstShadow({
    script: script([5500, 4500]), modelMinSeconds: 4, modelMaxSeconds: 15
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some(x => x.code === "CLIP_SECONDS_NOT_INTEGER"));
});
