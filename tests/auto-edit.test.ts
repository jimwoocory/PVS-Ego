import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { HermesProductDirectorGenerator } from "../src/adapters/ai/hermes-product-director-generator.js";
import { confirmProductionPlanDraft } from "../src/application/services/review-actions.js";
import { planAutoEdit, captionChunks, type AutoEditSource, type PreparedAudio } from "../src/application/services/auto-edit-planner.js";
import { postProductionSettingsSchema, AutoEditBlocked } from "../src/domain/auto-edit.js";
import { resolveRenderTarget } from "../src/application/services/render-target.js";
import { audioVolumeFilter, renderableText } from "../src/application/services/render-audio.js";
import { renderPostProductionControls, postProductionBrowserScript } from "../src/web/post-production-ui.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";
import { directorCase } from "./model-aware-fixtures.js";
import { H, ISO } from "./fixtures.js";
import type { ArtifactRecord } from "../src/domain/schemas.js";
import { visualClipAssessmentSchema } from "../src/domain/visual-edit.js";
import { hashValue } from "../src/domain/hashing.js";
function artifact(id: string, audio = false): ArtifactRecord & { sha256: string } {
  return { id, projectId: "project-1", kind: audio ? "OTHER" : "GENERATED_VIDEO", relativePath: id + (audio ? ".wav" : ".mp4"), sha256: H.a,
    sizeBytes: 10, mimeType: audio ? "audio/wav" : "video/mp4", integrityStatus: "READY", immutable: true, createdAt: ISO };
}
async function fixture() {
  const c = directorCase(30000, 15);
  const draft = await new HermesProductDirectorGenerator({ id: "fixture", version: "test", generateJson: async () => structuredClone(c.proposal) }).generate(c.input);
  const plan = confirmProductionPlanDraft(draft);
  const sources: AutoEditSource[] = plan.scenes.flatMap(s => s.clips).map((clip, i) => ({ clip, attemptId: "attempt-" + i, artifact: artifact("video-" + i), media: { durationMs: clip.durationMs + 200, width: 1280, height: 720, hasVideo: true, hasAudio: false } }));
  return { operationKey: H.e, truth: c.input.productTruth, script: c.input.script, plan, sources, audio: [] as PreparedAudio[],
    settings: postProductionSettingsSchema.parse({ allowSilentOutput: true }), targetDurationMs: 30000, now: ISO };
}

test("rule-based AutoEditPlan keeps approved director order, exact trims, immutable references and horizontal target", async () => {
  const f = await fixture(), before = JSON.stringify(f), result = planAutoEdit(f);
  assert.equal(result.actualDurationMs, 30000); assert.equal(result.renderConfig.width, 1280); assert.equal(result.renderConfig.height, 720);
  assert.deepEqual(result.timeline.clips.map(c => c.sourceArtifactId), ["video-0", "video-1"]);
  assert.ok(result.timeline.clips.every(c => c.inMs === 0 && c.outMs === 15000 && c.transition.type === "CUT"));
  assert.equal(JSON.stringify(f), before); assert.equal(result.source, "RULE_BASED_AUTO_EDIT_V1");
  assert.equal(result.contentHash, planAutoEdit(f).contentHash);
});

test("high-confidence visual gate may choose a fixed-duration trim window without changing director timing", async () => {
  const f = await fixture(), source = f.sources[0]!;
  source.media.durationMs = 17000;
  const window = { index: 1, inMs: 1000, outMs: 16000 };
  const body = {
    id: "visual-assessment-fixture",
    projectId: "project-1",
    clipId: source.clip.id,
    clipHash: source.clip.contentHash,
    attemptId: source.attemptId,
    outputArtifactId: source.artifact.id,
    outputArtifactHash: source.artifact.sha256,
    productTruthRef: { entityType: "ProductTruth", entityId: "truth", version: 1, hash: H.b },
    canonicalImageAssetId: "canonical",
    canonicalImageArtifactId: "canonical-artifact",
    canonicalImageHash: H.c,
    evaluatorVersion: "p1f06-visual-edit-v1",
    sourceDurationMs: 17000,
    requiredDurationMs: 15000,
    sampledFrameTimestampsMs: [0, 4000, 8000, 12000, 16000],
    candidateWindows: [{ index: 0, inMs: 0, outMs: 15000 }, window],
    checks: { productIdentity: "PASS", productStability: "PASS", usageCompliance: "PASS", visualQuality: "PASS", cutQuality: "PASS" },
    confidence: "HIGH",
    recommendedWindowIndex: 1,
    status: "PASS",
    autoAcceptEligible: true,
    reasons: ["fixture high-confidence pass"],
    createdAt: ISO
  } as const;
  const assessment = visualClipAssessmentSchema.parse({ ...body, contentHash: hashValue(body) });
  source.visualAssessment = { assessment, artifactId: "visual-artifact", artifactHash: H.d, selectedWindow: window };
  const result = planAutoEdit(f);
  assert.equal(result.timeline.clips[0]!.inMs, 1000);
  assert.equal(result.timeline.clips[0]!.outMs, 16000);
  assert.equal(result.timeline.clips[0]!.outMs - result.timeline.clips[0]!.inMs, source.clip.durationMs);
  assert.equal(result.actualDurationMs, 30000);
  assert.equal(result.inputs[0]!.visualAssessment?.artifactId, "visual-artifact");
  assert.match(result.rationale[0]!, /视觉 AI 高置信通过/);
});

test("uncertain visual assessment never overrides a human-accepted source trim", async () => {
  const f = await fixture(), source = f.sources[0]!;
  source.media.durationMs = 17000;
  const window = { index: 1, inMs: 1000, outMs: 16000 };
  const body = {
    id: "visual-uncertain-fixture",
    projectId: "project-1",
    clipId: source.clip.id,
    clipHash: source.clip.contentHash,
    attemptId: source.attemptId,
    outputArtifactId: source.artifact.id,
    outputArtifactHash: source.artifact.sha256,
    productTruthRef: { entityType: "ProductTruth", entityId: "truth", version: 1, hash: H.b },
    canonicalImageAssetId: "canonical",
    canonicalImageArtifactId: "canonical-artifact",
    canonicalImageHash: H.c,
    evaluatorVersion: "p1f06-visual-edit-v1",
    sourceDurationMs: 17000,
    requiredDurationMs: 15000,
    sampledFrameTimestampsMs: [0, 8000, 16000],
    candidateWindows: [{ index: 0, inMs: 0, outMs: 15000 }, window],
    checks: { productIdentity: "PASS", productStability: "UNCERTAIN", usageCompliance: "PASS", visualQuality: "PASS", cutQuality: "PASS" },
    confidence: "MEDIUM",
    recommendedWindowIndex: 1,
    status: "UNCERTAIN",
    autoAcceptEligible: false,
    reasons: ["fixture uncertainty"],
    createdAt: ISO
  } as const;
  const assessment = visualClipAssessmentSchema.parse({ ...body, contentHash: hashValue(body) });
  source.visualAssessment = { assessment, artifactId: "visual-uncertain-artifact", artifactHash: H.d, selectedWindow: window };
  const result = planAutoEdit(f);
  assert.equal(result.timeline.clips[0]!.inMs, 0);
  assert.equal(result.timeline.clips[0]!.outMs, 15000);
  assert.ok(result.warnings.some(item => /UNCERTAIN\/MEDIUM/.test(item)));
});

test("user-authorized repair masks are source-hash bound and text position overrides are segment-scoped", async () => {
  const f = await fixture(), source = f.sources[0]!, segment = source.clip.segments[0]!;
  segment.postProductionText = [{
    kind: "LABEL", text: "Tonemay Q8", startMs: 500, endMs: 2500,
    position: "CENTER", fontScale: 1, sourceBeatIds: [], requiredFactIds: []
  }];
  f.settings.repairMasks = [{
    sourceArtifactId: source.artifact.id,
    sourceArtifactHash: source.artifact.sha256,
    startMs: 13000,
    endMs: 15000,
    xRatio: 0,
    yRatio: 0,
    widthRatio: 1,
    heightRatio: 0.25,
    color: "WHITE",
    opacity: 1,
    reason: "用户确认清除模型误生成文字"
  }];
  f.settings.textPositionOverrides = [{
    segmentId: segment.id,
    text: "Tonemay Q8",
    position: "TOP",
    reason: "避开产品主体并覆盖顶部安全区"
  }];
  const result = planAutoEdit(f);
  assert.equal(result.timeline.repairMasks.length, 1);
  assert.equal(result.timeline.repairMasks[0]!.sourceArtifactId, source.artifact.id);
  assert.equal(result.timeline.repairMasks[0]!.sourceArtifactHash, source.artifact.sha256);
  assert.equal(result.timeline.textItems.find(item => item.text === "Tonemay Q8")?.position, "TOP");
  assert.ok(result.rationale.some(item => /用户明确授权后期修复遮罩/.test(item)));

  f.settings.repairMasks[0]!.sourceArtifactHash = H.f;
  assert.throws(
    () => planAutoEdit(f),
    (error: unknown) => error instanceof AutoEditBlocked && error.code === "REPAIR_MASK_SOURCE_CHANGED"
  );
});

test("auto edit never fills skipped footage with duplicates or silently claims the target length", async () => {
  const f = await fixture(); f.sources.pop(); const result = planAutoEdit(f);
  assert.equal(result.timeline.clips.length, 1); assert.equal(result.actualDurationMs, 15000);
  assert.ok(result.warnings.some(w => /跳过/.test(w)));
});

test("missing source sound pauses unless the user explicitly allows silent output", async () => {
  const f = await fixture(); f.settings.allowSilentOutput = false;
  assert.throws(() => planAutoEdit(f), (e: unknown) => e instanceof AutoEditBlocked && e.code === "AUDIO_REQUIRED");
  f.sources[0]!.clip.segments[0]!.dialogueOrNarration = { kind: "NARRATION", text: "真实产品展示", estimatedDurationMs: 2000, estimatorVersion: "fixture" };
  assert.throws(() => planAutoEdit(f), (e: unknown) => e instanceof AutoEditBlocked && e.code === "NARRATION_REQUIRED");
  f.settings.allowSilentOutput = true;
  assert.equal(planAutoEdit(f).timeline.textItems[0]!.text, "真实产品展示");
});

test("local/provided narration duration is measured, fully retained and never truncated to fit", async () => {
  const f = await fixture(), segment = f.sources[0]!.clip.segments[0]!;
  segment.dialogueOrNarration = { kind: "NARRATION", text: "Literal quote ' and 100%: %{not_a_filter} 中文", estimatedDurationMs: 2000, estimatorVersion: "fixture" };
  f.settings.narrationMode = "LOCAL_TTS";
  f.audio.push({ kind: "NARRATION", segmentId: segment.id, artifact: artifact("speech", true), media: { durationMs: 2400, hasAudio: true, hasVideo: false }, inMs: 0, outMs: 2400, volume: 1, synthesized: true });
  const plan = planAutoEdit(f);
  assert.equal(plan.timeline.audioItems[0]!.outMs, 2400);
  assert.equal(plan.timeline.textItems.at(-1)!.endMs, 2400);
  assert.ok(plan.timeline.clips[0]!.audio.keyframes.length >= 2);
  assert.ok(plan.timeline.clips[0]!.audio.keyframes.every(frame => frame.volume === 0));
  f.audio[0]!.outMs = 16000; f.audio[0]!.media.durationMs = 16000;
  assert.throws(() => planAutoEdit(f), (e: unknown) => e instanceof AutoEditBlocked && e.code === "NARRATION_TOO_LONG");
});

test("missing ambient audio is not fabricated and requires an explicit omit decision", async () => {
  const f = await fixture(); f.settings.allowSilentOutput = false;
  f.sources[0]!.clip.segments[0]!.ambientSound = { kind: "AMBIENT", description: "摄影棚轻微环境声" };
  f.sources[1]!.media.hasAudio = true;
  assert.throws(() => planAutoEdit(f), (e: unknown) => e instanceof AutoEditBlocked && e.code === "AMBIENT_REQUIRED");
  f.settings.omitMissingEffects = true; assert.ok(planAutoEdit(f).warnings.some(w => /场景音效/.test(w)));
});

test("multiple narration, SFX and looping BGM tracks coexist; music ducks around speech", async () => {
  const f = await fixture(), segment = f.sources[0]!.clip.segments[0]!;
  segment.dialogueOrNarration = { kind: "NARRATION", text: "你好，这是产品展示。", estimatedDurationMs: 3000, estimatorVersion: "fixture" };
  for (const [kind, seconds, volume] of [["NARRATION", 3, 1], ["AMBIENT", 2, 0.5], ["BGM", 10, 0.22]] as const) {
    f.audio.push({ kind, ...(kind !== "BGM" ? { segmentId: segment.id } : {}), artifact: artifact(kind, true), media: { durationMs: seconds * 1000, hasAudio: true, hasVideo: false }, inMs: 0, outMs: seconds * 1000, volume });
  }
  const t = planAutoEdit(f).timeline;
  assert.equal(t.audioItems.length, 5); assert.equal(t.audioItems.filter(a => a.role === "BGM").length, 3);
  const firstBgm = t.audioItems.find(a => a.role === "BGM")!;
  assert.equal(firstBgm.audio.keyframes[0]!.volume, 0.22 * 0.3);
  assert.ok(audioVolumeFilter(firstBgm.audio, 10000).includes("eval=frame"));
  assert.ok(t.audioItems.every(a => t.tracks.some(track => track.id === a.trackId)));
});

test("caption chunks preserve Unicode and literal syntax; CTA only uses included approved script", async () => {
  const text = "保留🙂真实外观 'literal': 100% %{metadata:x};这是一段很长但不能被悄悄删除的产品展示字幕。";
  assert.equal(captionChunks(text).join("").replaceAll("\n", ""), text);
  const f = await fixture(); f.script.beats[0]!.purpose = "CTA"; f.script.beats[0]!.text = "查看已确认的产品信息";
  const plan = planAutoEdit(f); assert.equal(plan.timeline.textItems[0]!.kind, "CTA");
  assert.equal(plan.timeline.textItems[0]!.position, "TOP");
  f.sources.forEach(s => { s.clip.sourceBeatIds = []; });
  assert.equal(planAutoEdit(f).timeline.textItems.length, 0);
});

test("planned post-production copy keeps exact brand/legal text out of optional dialogue-caption behavior", async () => {
  const f = await fixture();
  const segment = f.sources[0]!.clip.segments[0]!;
  segment.postProductionText = [
    { kind: "LABEL", text: "Tonemay Q8", startMs: 500, endMs: 2500, position: "CENTER", fontScale: 1.3, sourceBeatIds: [], requiredFactIds: [] },
    { kind: "LEGAL", text: "厂商标称，条件未给出", startMs: 2500, endMs: 3900, position: "BOTTOM", fontScale: 0.6, sourceBeatIds: [], requiredFactIds: [] },
    { kind: "CAPTION", text: "可选编辑字幕", startMs: 500, endMs: 2000, position: "TOP", fontScale: 1, sourceBeatIds: [], requiredFactIds: [] },
    { kind: "CTA", text: "关注了解更多", startMs: 2000, endMs: 3900, position: "TOP", fontScale: 1.1, sourceBeatIds: [], requiredFactIds: [] }
  ];
  f.settings.captions = false;
  f.settings.cta = false;
  let items = planAutoEdit(f).timeline.textItems;
  assert.deepEqual(items.map(item => item.text), ["Tonemay Q8", "厂商标称，条件未给出"]);
  assert.equal(items[0]!.position, "CENTER");
  assert.equal(items[0]!.fontScale, 1.3);
  assert.equal(items[1]!.fontScale, 0.6);

  f.settings.captions = true;
  f.settings.cta = true;
  items = planAutoEdit(f).timeline.textItems;
  assert.ok(items.some(item => item.text === "Tonemay Q8"));
  assert.ok(items.some(item => item.text === "厂商标称，条件未给出"));
  assert.ok(items.some(item => item.text === "可选编辑字幕"));
  assert.equal(items.filter(item => item.text === "关注了解更多").length, 1);
});

test("output dimensions honor all project ratios; AUTO requires actual video dimensions", () => {
  for (const ratio of ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]) {
    const config = resolveRenderTarget(ratio, "720p"), [w,h] = ratio.split(":").map(Number);
    assert.equal(Math.min(config.width, config.height), 720); assert.equal(config.width % 2, 0); assert.equal(config.height % 2, 0);
    assert.ok(Math.abs(config.width/config.height-w!/h!) < 0.005);
  }
  assert.equal(resolveRenderTarget("AUTO", "720p", { width: 600, height: 600 }).width, 720);
  assert.throws(() => resolveRenderTarget("AUTO", "720p"), /实际视频/);
  assert.throws(() => resolveRenderTarget("16:9", "unknown"), /分辨率/);
});

test("source trims and keyframes outside real media fail closed", async () => {
  const f = await fixture(); f.sources[0]!.media.durationMs = 9000;
  assert.throws(() => planAutoEdit(f), (e: unknown) => e instanceof AutoEditBlocked && e.code === "VIDEO_TOO_SHORT");
  assert.throws(() => audioVolumeFilter({ muted:false,volume:1,keyframes:[{atMs:5000,volume:1},{atMs:4000,volume:0}] }, 10000), /关键帧/);
});

test("provided voice suppresses only the target source segment and retains later ambient audio", async () => {
  const f=await fixture(), source=f.sources[0]!, original=source.clip.segments[0]!;
  source.media.hasAudio=true;
  source.clip.segments=[{...original,endMs:4000,dialogueOrNarration:{kind:"NARRATION",text:"替换这一句",estimatedDurationMs:2000,estimatorVersion:"fixture"}},
    {...original,id:original.id+"-tail",startMs:4000,endMs:15000,dialogueOrNarration:{kind:"NONE"},ambientSound:{kind:"AMBIENT",description:"保留现场环境声"}}];
  f.settings.allowSilentOutput=false;f.settings.narrationMode="SOURCE_ONLY";
  f.audio.push({kind:"NARRATION",segmentId:original.id,artifact:artifact("provided-voice",true),media:{durationMs:2000,hasAudio:true,hasVideo:false},inMs:0,outMs:2000,volume:1});
  const t=planAutoEdit(f).timeline, volume=t.clips[0]!.audio;
  assert.equal(volume.muted,false);assert.equal(volume.keyframes[0]!.volume,0);
  assert.ok(volume.keyframes.some(p=>p.atMs>4000&&p.volume===1));
  assert.equal(t.audioItems.filter(a=>a.role==="NARRATION").length,1);
});

test("legacy plans use the project output ratio and new planning versions are audited", async () => {
  const f=await fixture();delete f.plan.generationTarget;
  const result=planAutoEdit({...f,fallbackAspectRatio:"16:9"});
  assert.equal(result.renderConfig.width,1280);assert.equal(result.renderConfig.height,720);
  assert.match(result.plannerVersion!,/v2-audio/);
});

test("RC1 persisted plans without postProductionText remain auto-edit compatible", async () => {
  const f = await fixture();
  for (const source of f.sources) {
    for (const segment of source.clip.segments) {
      (segment as unknown as { postProductionText?: unknown }).postProductionText = undefined;
    }
  }
  const result = planAutoEdit(f);
  assert.equal(result.actualDurationMs, 30000);
  assert.equal(result.timeline.clips.length, 2);
  assert.ok(result.timeline.textItems.every(item => item.text !== undefined));
});

test("post-production numeric defaults and persisted gains satisfy native form constraints", async () => {
  const f = await fixture();
  f.plan.scenes[0]!.clips[0]!.segments[0]!.dialogueOrNarration = {kind:"NARRATION",text:"测试配音",estimatedDurationMs:1000,estimatorVersion:"fixture"};
  const segmentId = f.plan.scenes[0]!.clips[0]!.segments[0]!.id;
  for (const settings of [{}, {bgmVolume:0.223,sourceVolume:0.777,audioBindings:[{segmentId,kind:"NARRATION",artifactId:"voice-fixture",volume:0.333,inMs:1,outMs:1801}]}]) {
    const html=renderPostProductionControls({projectId:"project-1",plan:f.plan,settings});
    for (const input of html.matchAll(/<input\b[^>]*type="number"[^>]*>/g)) {
      const attrs=Object.fromEntries([...input[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1]!,m[2]!]));
      if(!attrs.value)continue;
      const value=Number(attrs.value), min=Number(attrs.min??0), step=attrs.step??"1";
      assert.ok(Number.isFinite(value)&&value>=min);
      if(attrs.max)assert.ok(value<=Number(attrs.max));
      if(step!=="any")assert.ok(Math.abs((value-min)/Number(step)-Math.round((value-min)/Number(step)))<1e-8,`Invalid native numeric field: ${input[0]}`);
    }
  }
});

test("new smart and post-production UI scripts parse and cannot execute user text", async () => {
  const f = await fixture();
  const workspace = { project: { id: "project-1", name: "test", status: "READY_TO_ASSEMBLE" as const, targetPlatform: "douyin" as const, targetDurationMs: 30000, aspectRatio: "16:9", createdAt:ISO,updatedAt:ISO }, productionPlan:f.plan };
  const html = renderSmartGenerationPage(workspace, []);
  for (const [i,match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) new Script(match[1]!, { filename: "smart-post-"+i });
  new Script(postProductionBrowserScript.replace(/^<script>|<\/script>$/g, ""));
  const controls = renderPostProductionControls({ projectId: '"><script>bad()</script>', plan:f.plan });
  assert.ok(!controls.includes('<script>bad()'));
  assert.match(controls, /SOURCE_OR_LOCAL_TTS/); assert.match(html, /postProduction:window.pvsReadPostProduction/);
});
