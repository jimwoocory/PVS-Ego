import test from "node:test";
import assert from "node:assert/strict";
import { estimateV8SpeechMs, segmentV8SemanticSpeech } from "../src/application/services/v8-semantic-dialogue.js";

test("V8 semantic speech keeps original punctuation, spaces and exact total time", () => {
  const original = "请你先听我解释， 我并不是故意要瞒着你。还有一件事情，必须现在告诉你。";
  const result = segmentV8SemanticSpeech({ text: original });
  assert.equal(result.status, "READY", result.reason ?? "未能安全拆镜");
  assert.ok(result.parts.length > 1);
  assert.equal(result.parts.map(part => part.text).join(""), original);
  assert.equal(result.parts.reduce((total, part) => total + part.durationMs, 0),
    estimateV8SpeechMs(original, 5.2));
  assert.ok(result.parts.every(part => part.durationMs >= 300 && part.durationMs <= 4200));
  assert.deepEqual(result.parts.map(part => part.partIndex),
    result.parts.map((_, index) => index + 1));
  assert.ok(result.parts.every(part => part.partCount === result.parts.length));
});

test("V8 semantic speech refuses a long line without a safe punctuation break", () => {
  const original = "这是一个没有任何自然断句的长句我们不允许程序直接截取任意字数之后就偷偷交给视频模型生成";
  const result = segmentV8SemanticSpeech({ text: original });
  assert.equal(result.status, "NEEDS_MANUAL_SEMANTIC_CUT");
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0]!.text, original);
});

test("V8 semantic speech preserves short original dialogue as one contiguous part", () => {
  const original = "你确定？";
  const result = segmentV8SemanticSpeech({ text: original });
  assert.equal(result.status, "READY");
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0]!.text, original);
  assert.equal(result.parts[0]!.durationMs, estimateV8SpeechMs(original, 5.2));
});

test("V8 semantic speech rejects impossible timing settings", () => {
  assert.throws(() => segmentV8SemanticSpeech({ text: "你好", charactersPerSecond: 0 }));
  assert.throws(() => segmentV8SemanticSpeech({ text: "你好", maxSpeechShotMs: 100 }));
});
