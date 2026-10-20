import test from "node:test";
import assert from "node:assert/strict";
import type { ScriptDraft } from "../src/domain/schemas.js";
import { DirectorV3PlannerService } from "../src/application/services/director-v3-planner-service.js";
import { resolveDirectorGenerationTarget } from "../src/application/services/director-generation-target.js";
import { modelRegistry } from "./model-aware-fixtures.js";
import { H, ISO } from "./fixtures.js";

function script21(): ScriptDraft {
  const beat = (
    id: string,
    order: number,
    purpose: ScriptDraft["beats"][number]["purpose"],
    location: string,
    action: string,
    stateIn: string,
    stateOut: string,
    productRole: string,
    durationMs: number
  ): ScriptDraft["beats"][number] => ({
    id,
    order,
    purpose,
    text: action,
    estimatedDurationMs: durationMs,
    requiredFactIds:
      purpose === "PRODUCT" || purpose === "FEATURE"
        ? ["fact-1"]
        : [],
    videoIntent: {
      location,
      storyAction: action,
      productRole,
      stateIn,
      stateOut,
      audioIntent: {
        ambience: [
          location === "办公室"
            ? "安静办公室环境声"
            : "卧室自然环境声"
        ],
        sfx: ["自然交互声"],
        bgm: false
      },
      postProductionText: []
    }
  });

  return {
    id: "script-v3-21",
    projectId: "project-1",
    version: 1,
    status: "CONFIRMED",
    productTruthRef: {
      entityType: "ProductTruth",
      entityId: "truth-1",
      version: 1,
      hash: H.a
    },
    creativeBatchRef: {
      entityType: "CreativeBatch",
      entityId: "batch-1",
      version: 1,
      hash: H.b
    },
    selectedCreativeId: "creative-1",
    targetDurationMs: 21000,
    beats: [
      beat(
        "beat-office",
        1,
        "HOOK",
        "办公室",
        "结束工作并揉后颈后离开工位",
        "仍在工作",
        "准备离开办公室",
        "产品不出现",
        5000
      ),
      beat(
        "beat-product",
        2,
        "PRODUCT",
        "卧室",
        "从床边柜取出产品并放到床上",
        "产品收在柜内",
        "产品完整放到床面",
        "产品完整出现",
        5000
      ),
      beat(
        "beat-open",
        3,
        "FEATURE",
        "卧室",
        "打开产品展示一次内部状态",
        "产品完整闭合",
        "产品打开并稳定展示",
        "产品状态展示",
        5000
      ),
      beat(
        "beat-close",
        4,
        "RESULT",
        "卧室",
        "整理产品并回到完整平铺成品",
        "产品打开",
        "产品完整平铺",
        "完整产品 Hero",
        6000
      )
    ],
    contentHash: H.c,
    confirmedAt: ISO
  };
}

function target() {
  return resolveDirectorGenerationTarget(
    modelRegistry(15, true),
    {
      requestedModelVersion: "seedance2.0mini",
      aspectRatio: "9:16",
      videoResolution: "720p",
      nativeAudioOutputRequested: true
    }
  );
}

test("Director V3 plans the 21s story by complexity instead of the old 11s+10s duration-only split", () => {
  const plan = new DirectorV3PlannerService().plan({
    script: script21(),
    generationTarget: target()
  });
  assert.equal(plan.targetDurationMs, 21000);
  assert.equal(plan.clipContracts.length, 3);
  assert.deepEqual(
    plan.clipContracts.map((clip) => clip.durationMs),
    [5000, 10000, 6000]
  );
  assert.deepEqual(
    plan.clipContracts.map((clip) => clip.location),
    ["办公室", "卧室", "卧室"]
  );
  assert.deepEqual(
    plan.clipContracts[1]!.sourceBeatIds,
    ["beat-product", "beat-open"]
  );
  assert.ok(
    plan.clipContracts.every(
      (clip) =>
        clip.durationMs >= 4000 &&
        clip.durationMs <= 15000 &&
        clip.actions.length <= 2
    )
  );
});

test("Director V3 Clip Contracts request native ambience/SFX and never BGM", () => {
  const plan = new DirectorV3PlannerService().plan({
    script: script21(),
    generationTarget: target()
  });
  assert.ok(
    plan.clipContracts.every(
      (clip) =>
        clip.audio.mode === "NATIVE" &&
        clip.audio.bgm === false &&
        clip.audio.ambience.length > 0 &&
        clip.audio.sfx.length > 0 &&
        clip.globalConstraints.noBgm === true
    )
  );
});

test("Director V3 refuses a script that has not passed structured video-intent preparation", () => {
  const script = script21();
  delete script.beats[0]!.videoIntent;
  assert.throws(
    () =>
      new DirectorV3PlannerService().plan({
        script,
        generationTarget: target()
      }),
    /videoIntent/
  );
});

test("Director V3 preserves a natural 20s story inside a 21s user target (±10%)",()=>{
  const script=script21();
  script.beats[1]!.estimatedDurationMs=4000;
  const plan=new DirectorV3PlannerService().plan({script,generationTarget:target()});
  assert.equal(script.targetDurationMs,21000);
  assert.equal(plan.targetDurationMs,20000);
  assert.equal(plan.clipContracts.reduce((t,c)=>t+c.durationMs,0),20000);
  assert.ok(plan.clipContracts.every(c=>Number.isInteger(c.durationMs/1000)));
  assert.equal(plan.clipContracts.flatMap(c=>c.sourceBeatIds).length,4);
});

test("Director V3 refuses screenplay beyond the ±10% natural duration tolerance",()=>{
  const script=script21();
  script.beats[1]!.estimatedDurationMs=1000;
  assert.throws(()=>new DirectorV3PlannerService().plan({script,generationTarget:target()}),/±10%/);
});
