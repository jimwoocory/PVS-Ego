import test from "node:test";
import assert from "node:assert/strict";
import { StructuredAiRuntimeError } from "../src/adapters/ai/hermes-structured-ai-runtime.js";
import { publicApiError } from "../src/web/public-api-error.js";

test("public AI errors never expose Hermes command, prompt or local path", () => {
  const error = new StructuredAiRuntimeError(
    "Hermes structured generation failed: Command failed: hermes --in C:\\Users\\Example\\AgentDock\\Product-Video-Studio -z INPUT_JSON secret prompt"
  );
  const safe = publicApiError(error);
  assert.equal(safe.error, "AI_GENERATION_FAILED");
  assert.match(safe.message, /大模型生成失败/);
  assert.doesNotMatch(safe.message, /hermes/i);
  assert.doesNotMatch(safe.message, /INPUT_JSON/);
  assert.doesNotMatch(safe.message, /Example/);
});

test("public AI timeout is actionable and sanitized", () => {
  const safe = publicApiError(
    new StructuredAiRuntimeError("Hermes structured generation timed out")
  );
  assert.equal(safe.error, "AI_GENERATION_TIMEOUT");
  assert.match(safe.message, /生成超时/);
  assert.match(safe.message, /大模型设置/);
});

test("unknown server failures use a generic safe message", () => {
  const safe = publicApiError(
    new Error("C:\\secret\\internal\\path token=abc123")
  );
  assert.equal(safe.error, "INTERNAL_ERROR");
  assert.doesNotMatch(safe.message, /secret|abc123|internal/i);
});
