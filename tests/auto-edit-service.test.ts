import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { Script } from "node:vm";
import { createAutoEditFixture, runMedia } from "./auto-edit-integration-fixture.js";
import { AutoEditService } from "../src/application/services/auto-edit-service.js";
import { AutoEditBlocked } from "../src/domain/auto-edit.js";
import { inspectMedia } from "../src/adapters/media/inspect-media.js";
import { handleAutoEditHttp } from "../src/web/auto-edit-http.js";

function amplitude(bytes: Buffer, frequency: number, sampleRate = 16000): number {
  let cosine = 0, sine = 0; const count = bytes.length / 4;
  for (let i = 0; i < count; i++) { const x = bytes.readFloatLE(i * 4); cosine += x * Math.cos(2 * Math.PI * frequency * i / sampleRate); sine += x * Math.sin(2 * Math.PI * frequency * i / sampleRate); }
  return 2 * Math.hypot(cosine, sine) / count;
}

test("AutoEditService integrates real SQLite, immutable media, multitrack rendering, safe retries and manual-edit protection", { timeout: 180_000 }, async () => {
  const f = await createAutoEditFixture();
  try {
    const initialAttempts = await f.workflow.listGenerationAttempts(f.projectId);
    await assert.rejects(f.autoEdit.create({ projectId: f.projectId, settings: {} }), (e: unknown) => e instanceof AutoEditBlocked && e.code === "NARRATION_REQUIRED");
    await assert.rejects(f.autoEdit.create({ projectId: f.projectId, settings: f.settings, attemptIds: [] }), /本轮可用结果/);
    await assert.rejects(f.autoEdit.create({ projectId: f.projectId, settings: f.settings, expectedPlanHash: "0".repeat(64) }), /导演计划已失效/);
    const made = await f.autoEdit.create({ projectId: f.projectId, settings: f.settings, expectedPlanHash: f.plan.contentHash, attemptIds: f.attemptIds });
    assert.equal(made.timeline.status, "DRAFT"); assert.equal(made.plan.actualDurationMs, 12000);
    assert.equal(made.timeline.audioItems.length, 6); assert.equal(made.timeline.textItems.length, 2);
    assert.equal(made.plan.audioProvenance!.length, 5);
    const recreated = new AutoEditService({ productFlow: f.productFlow, workflow:f.workflow, review:f.review, artifacts:f.artifacts, timelines:f.timelines, projectsRoot:f.projectsRoot });
    const repeated = await recreated.create({ projectId: f.projectId, settings: f.settings, attemptIds: f.attemptIds });
    assert.equal(repeated.timeline.id, made.timeline.id); assert.equal(repeated.planArtifactId, made.planArtifactId);
    assert.equal(await f.db.timelineRecord.count({ where: { projectId: f.projectId } }), 1);
    assert.deepEqual((await f.workflow.listGenerationAttempts(f.projectId)).map(a => a.id), initialAttempts.map(a => a.id));
    assert.equal(made.timeline.renderConfig?.width, 1280); assert.equal(made.timeline.renderConfig?.height, 720);
    const confirmed = await f.timeline.confirm(f.projectId, { id: made.timeline.id, hash: made.timeline.contentHash });
    const rendered = await f.render.render(f.projectId);
    assert.equal(rendered.renderJob.status, "SUCCEEDED"); assert.equal(rendered.assembly.timelineHash, confirmed.contentHash);
    const output = (await f.artifacts.findById(rendered.assembly.outputArtifactId))!;
    const file = path.join(f.projectsRoot, f.projectId, output.relativePath);
    const media = await inspectMedia(file); assert.equal(media.width, 1280); assert.equal(media.height, 720); assert.ok(media.hasAudio && media.hasVideo);
    assert.ok(Math.abs(media.durationMs - 12000) < 120);
    const sample = path.join(f.root, "mix.f32");
    await runMedia(["-ss", "0.5", "-i", file, "-t", "1", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-y", sample]);
    const pcm = await fs.readFile(sample);
    for (const frequency of [550,880,220]) assert.ok(amplitude(pcm, frequency) > 0.0005, "Missing mixed frequency " + frequency);
    assert.equal((await f.render.render(f.projectId)).assembly.id, rendered.assembly.id);
    // A cached SUCCEEDED flag is not enough: validate the live plan and actual output bytes.
    await f.db.project.update({ where: { id: f.projectId }, data: { currentProductionPlanHash: "f".repeat(64) } });
    await assert.rejects(f.render.render(f.projectId), /导演方案已变化/);
    await f.db.project.update({ where: { id: f.projectId }, data: { currentProductionPlanHash: f.plan.contentHash } });
    await fs.appendFile(file, "isolated cache corruption");
    await assert.rejects(f.render.render(f.projectId), /bytes changed/);
    const changed = await f.timeline.updateAudioItem(f.projectId, made.timeline.audioItems[0]!.id, { expectedHash: confirmed.contentHash, volume: 0.8, startMs: 100 });
    assert.equal(changed.status, "DRAFT"); assert.notEqual(changed.id, confirmed.id);
    await assert.rejects(f.autoEdit.create({ projectId: f.projectId, settings:f.settings }), /手工版本/);
    await assert.rejects(f.timeline.updateAudioItem(f.projectId, made.timeline.audioItems[0]!.id, { expectedHash: confirmed.contentHash, volume: 1 }), /已被更新/);
    const withoutBgm = await f.timeline.removeBgm(f.projectId);
    assert.equal(withoutBgm.audioItems.filter(a => !a.deleted).length, 4);
    assert.ok(withoutBgm.audioItems.filter(a => !a.deleted).every(a => a.role !== "BGM"));
    const restoredBgm = await f.timeline.setBgm({ projectId: f.projectId, artifactId: f.toneArtifacts[2]!.id });
    assert.equal(restoredBgm.audioItems.filter(a => !a.deleted && a.role === "NARRATION").length, 2);
    assert.ok(restoredBgm.tracks.find(t => t.id === restoredBgm.audioItems.at(-1)!.trackId)?.label.includes("音乐"));
    const source = f.inputs[0]!; const sourcePath = path.join(f.projectsRoot, f.projectId, source.relativePath);
    assert.equal(createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex"), source.sha256);
    await fs.appendFile(sourcePath, "test corruption");
    await assert.rejects(f.autoEdit.create({ projectId: f.projectId, settings:f.settings }), /文件校验失败/);
  } finally { await f.cleanup(); }
});

test("automatic editing page and audio HTTP controls validate uploads without changing product-input state", { timeout: 120_000 }, async () => {
  const f = await createAutoEditFixture();
  const deps = { autoEdit:f.autoEdit,productFlow:f.productFlow,artifacts:f.artifacts,timeline:f.timeline,projectsRoot:f.projectsRoot };
  const server = http.createServer(async (req,res) => {
    try { if (!await handleAutoEditHttp(req,res,new URL(req.url ?? "/","http://localhost"),deps)) {res.writeHead(404);res.end();} }
    catch (e) { res.writeHead(400, {"content-type":"application/json"});res.end(JSON.stringify({message:e instanceof Error?e.message:String(e)})); }
  });
  await new Promise<void>(r => server.listen(0,"127.0.0.1",r));
  const base = "http://127.0.0.1:" + (server.address() as {port:number}).port;
  try {
    const w = await f.productFlow.getWorkspace(f.projectId);
    const html = await (await fetch(base+"/projects/"+f.projectId+"/auto-edit")).text();
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
    const metadata = await (await fetch(base+"/api/projects/"+f.projectId+"/post-production")).json() as {audioAssets: Array<{name:string;source?:string}>};
    assert.equal(metadata.audioAssets.length, 6);
    assert.equal(metadata.audioAssets.filter(item => item.source === "BUILTIN_BGM").length, 3);
    assert.ok(metadata.audioAssets.some(item => item.name.includes("温暖叙事")));
    assert.ok(metadata.audioAssets.some(item => item.name.includes("轻快产品")));
    assert.ok(metadata.audioAssets.some(item => item.name.includes("克制工艺")));
    const bytes = await fs.readFile(path.join(f.projectsRoot,f.projectId,f.toneArtifacts[0]!.relativePath));
    const uploaded = await fetch(base+"/api/projects/"+f.projectId+"/post-production/audio", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:"配音 test.wav",base64:bytes.toString("base64")})});
    assert.equal(uploaded.status,201);
    const invalid = await fetch(base+"/api/projects/"+f.projectId+"/post-production/audio", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:"wrong.exe",base64:bytes.toString("base64")})});
    assert.equal(invalid.status,400);
    assert.deepEqual((await f.productFlow.getWorkspace(f.projectId))?.project,w?.project);
    const create = await fetch(base+"/api/projects/"+f.projectId+"/auto-edit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({settings:f.settings,expectedPlanHash:f.plan.contentHash})});
    assert.equal(create.status,201,await create.text());
    const after = await (await fetch(base+"/projects/"+f.projectId+"/auto-edit")).text();
    assert.match(after,/replace-timeline/);
    for (const match of after.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
  } finally { await new Promise<void>(r => server.close(()=>r())); await f.cleanup(); }
});
