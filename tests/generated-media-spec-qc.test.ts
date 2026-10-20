import test from "node:test";
import assert from "node:assert/strict";
import { assessGeneratedMediaAspectRatio } from "../src/application/services/generated-media-spec-qc.js";
import { buildAssetImageBindings } from "../src/application/services/asset-image-bindings.js";

const assetManifest=[{assetId:"image-1",artifactHash:"a".repeat(64),priority:0,
  inputType:"image" as const}];
const bindings=buildAssetImageBindings({
  promptText:"县令@图片1",assetManifest,dreaminaOperation:"image2video"
});
const request={aspectRatio:"9:16",imageBindings:bindings};
test("9:16 real output accepts correct portrait and refuses 16:9 horizontal",()=>{
  assert.equal(assessGeneratedMediaAspectRatio(request,{width:720,height:1280}).status,"PASS");
  const wrong=assessGeneratedMediaAspectRatio(request,{width:1280,height:720});
  assert.equal(wrong.status,"RATIO_MISMATCH");
  assert.match(wrong.detail,/720/);
  assert.equal(assessGeneratedMediaAspectRatio(request,{}).status,"RATIO_UNVERIFIED");
});
test("legacy no-binding output is unaffected",()=>{
  assert.equal(assessGeneratedMediaAspectRatio({aspectRatio:"9:16"},{width:1280,height:720}).status,
    "NOT_APPLICABLE");
});
