import test from "node:test";
import assert from "node:assert/strict";
import { canServeArtifactContent } from "../src/web/artifact-media-policy.js";

test("artifact media policy serves safe OTHER media but never structured/log artifacts", () => {
  assert.equal(canServeArtifactContent({
    kind: "OTHER",
    mimeType: "image/png",
    integrityStatus: "READY"
  }), true);
  assert.equal(canServeArtifactContent({
    kind: "OTHER",
    mimeType: "audio/wav",
    integrityStatus: "READY"
  }), true);
  assert.equal(canServeArtifactContent({
    kind: "OTHER",
    mimeType: "application/json",
    integrityStatus: "READY"
  }), false);
  assert.equal(canServeArtifactContent({
    kind: "STRUCTURED_SNAPSHOT",
    mimeType: "image/png",
    integrityStatus: "READY"
  }), false);
  assert.equal(canServeArtifactContent({
    kind: "STDOUT",
    mimeType: "text/plain",
    integrityStatus: "READY"
  }), false);
  assert.equal(canServeArtifactContent({
    kind: "OTHER",
    mimeType: "image/png",
    integrityStatus: "CORRUPT"
  }), false);
  assert.equal(canServeArtifactContent({
    kind: "GENERATED_VIDEO",
    mimeType: undefined,
    integrityStatus: "READY"
  }), true);
  assert.equal(canServeArtifactContent({
    kind: "FINAL_VIDEO",
    mimeType: "video/mp4",
    integrityStatus: "READY"
  }), true);
});
