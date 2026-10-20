import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleSmartGenerationHttp } from "../src/web/smart-generation-http.js";
import { makeValidClip, H, ISO } from "./fixtures.js";

const projectId = "project-v8-http";
const runId = "run-v8-http";
function fixture() {
  const beatId = "beat-v8-http";
  const clip = makeValidClip();
  clip.id = "clip-v8-http";
  clip.sourceBeatIds = [beatId];
  clip.referenceAssets = [];
  clip.segments.forEach(segment => {
    segment.sourceBeatIds = [beatId];
    segment.postProductionText = [];
    segment.dialogueOrNarration = { kind: "NONE" };
  });
  const script = {
    id: "script-v8-http", projectId, version: 1,
    contentHash: H.a, targetDurationMs: 8000,
    beats: [{ id: beatId, order: 1, purpose: "HOOK", text: "一位人物拾起产品。",
      estimatedDurationMs: 8000, requiredFactIds: [],
      videoIntent: { location: "卧室", storyAction: "拾起产品",
        productRole: "产品", stateIn: "产品静置", stateOut: "产品拿起",
        audioIntent: { ambience: [], sfx: [], bgm: false },
        postProductionText: [] } }]
  };
  const productionPlan = {
    id: "plan-v8-http", contentHash: H.b, projectId,
    scriptRef: { entityType: "ScriptDraft", entityId: script.id, version: 1, hash: H.a },
    visualDirection: "真实写实，保留空间连续",
    generationTarget: { requestedModelVersion: "seedance2.0mini", aspectRatio: "9:16",
      videoResolution: "720p", operationConstraints: [
        { operation: "multimodal2video", durationMinSeconds: 4, durationMaxSeconds: 15 }
      ] },
    scenes: [{ location: "卧室", clips: [clip] }]
  };
  return { id: runId, projectId, script, productionPlan };
}

test("V8 read-only HTTP endpoint handles numeric action, returns actual shot preview, and forbids writes", async () => {
  const run = fixture();
  let writes = 0, reads = 0;
  const deps = {
    smartGeneration: { get: async (project: string, id: string) => {
      reads++;
      return project === projectId && id === runId ? run : undefined;
    }, create: async () => { writes++; throw Error("unexpected create"); },
    confirmPaid: async () => { writes++; throw Error("unexpected paid"); },
    advance: async () => { writes++; throw Error("unexpected advance"); } }
  } as unknown as Parameters<typeof handleSmartGenerationHttp>[3];
  const server = http.createServer((req, res) =>
    void handleSmartGenerationHttp(req,res,new URL(req.url ?? "/", "http://127.0.0.1"),deps)
      .catch(error => { res.writeHead(500);res.end(String(error)); })
  );
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const uri = "/api/projects/" + projectId + "/smart-runs/" + runId + "/v8-shadow";
    const response = await fetch(base + uri);
    assert.equal(response.status, 200);
    const data = await response.json() as {
      readOnly: boolean; paidSubmissions: number;
      preview: { fidelity: { status: string; clips: Array<{promptText:string;sourceShotIds:string[]}> },
        shotFirst: { status: string; clips: Array<{durationMs:number}> } };
    };
    assert.equal(data.readOnly,true);
    assert.equal(data.paidSubmissions,0);
    assert.equal(data.preview.fidelity.status,"PASS");
    assert.equal(data.preview.shotFirst.status,"PASS");
    assert.equal(data.preview.fidelity.clips[0]!.sourceShotIds.length,2);
    assert.match(data.preview.fidelity.clips[0]!.promptText,/【镜头 02】/);
    assert.deepEqual(data.preview.shotFirst.clips.map(c=>c.durationMs),[8000]);
    assert.equal((await fetch(base+uri,{method:"POST"})).status,405);
    assert.equal((await fetch(base+"/api/projects/not-this-project/smart-runs/"+runId+"/v8-shadow")).status,404);
    assert.equal(writes,0);
    assert.equal(reads,2);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
