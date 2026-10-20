import test from "node:test";
import assert from "node:assert/strict";
import type {
  ProductionPlan
} from "../src/domain/schemas.js";
import type {
  DirectorV3ClipContract
} from "../src/domain/director-v3.js";
import {
  buildSeedancePromptV3,
  lintSeedancePromptV3
} from "../src/application/services/seedance-model-prompt-v3.js";
import { makeProductTruth, makeValidClip } from "./fixtures.js";

function contract(): DirectorV3ClipContract {
  return {
    id: "contract-1",
    order: 1,
    sourceBeatIds: ["beat-1"],
    purpose: "回家后取出产品并自然放到床上",
    location: "卧室",
    durationMs: 8000,
    openingState: "产品在床边柜内",
    closingState: "产品完整放到床面",
    actions: [
      {
        order: 1,
        startMs: 0,
        endMs: 4000,
        description: "打开床边柜并取出产品",
        productState: "产品完整取出"
      },
      {
        order: 2,
        startMs: 4000,
        endMs: 8000,
        description: "双手将产品自然放到床面并整理平整",
        productState: "产品完整平铺"
      }
    ],
    camera: {
      shotSize: "中近景",
      position: "围绕产品与手部的稳定机位",
      angle: "轻俯视",
      movement: "固定机位，轻微跟随手部"
    },
    referenceAssetIds: [],
    productStateChanges: [
      "柜内完整产品 → 床面完整产品"
    ],
    audio: {
      mode: "NATIVE",
      dialogueOrOs: [],
      ambience: ["卧室自然环境声"],
      sfx: ["柜门开合声", "布料摩擦声"],
      bgm: false
    },
    globalConstraints: {
      preserveProductIdentity: true,
      noReadableText: true,
      noBgm: true,
      extra: []
    }
  };
}

function input() {
  const truth = makeProductTruth();
  const clip = makeValidClip();
  return {
    truth,
    plan: {} as ProductionPlan,
    scene: {} as ProductionPlan["scenes"][number],
    clip,
    contract: contract(),
    model: "seedance2.0mini",
    aspectRatio: "9:16",
    videoResolution: "720p"
  };
}

test("Seedance Prompt V3 uses six concise sections and one global constraint block", () => {
  const prompt = buildSeedancePromptV3(input());
  for (const section of [
    "【参考素材】",
    "【本段视频目标】",
    "【动作与时间顺序】",
    "【摄影】",
    "【声音】",
    "【全局约束】"
  ]) {
    assert.match(prompt, new RegExp(section));
  }
  assert.equal(
    (prompt.match(/【全局约束】/g) ?? []).length,
    1
  );
  assert.match(prompt, /不生成背景音乐/);
  assert.match(prompt, /卧室自然环境声/);
  assert.match(prompt, /柜门开合声/);
  assert.match(prompt, /布料摩擦声/);
  assert.doesNotMatch(prompt, /不请求模型原生音轨/);
  assert.doesNotMatch(
    prompt,
    /声音由后期统一处理/
  );
  assert.deepEqual(
    lintSeedancePromptV3(prompt, contract()),
    []
  );
});

test("Seedance Prompt V3 keeps dialogue/OS as native audio while still forbidding BGM", () => {
  const c = contract();
  c.audio.dialogueOrOs = [
    {
      kind: "DIALOGUE",
      text: "我回来啦。"
    },
    {
      kind: "OS",
      text: "终于可以休息一下。"
    }
  ];
  const prompt = buildSeedancePromptV3({
    ...input(),
    contract: c
  });
  assert.match(prompt, /人物对白：“我回来啦。”/);
  assert.match(
    prompt,
    /OS旁白：“终于可以休息一下。”/
  );
  assert.match(prompt, /不生成背景音乐/);
});

test("Seedance Prompt V3 lint rejects edited prompts that remove native audio policy or duplicate global constraints", () => {
  const c = contract();
  const prompt = buildSeedancePromptV3({
    ...input(),
    contract: c
  });
  const invalid =
    prompt
      .replace(
        /不生成背景音乐。[^\n]*/,
        "声音由后期统一处理。"
      ) +
    "\n【全局约束】\n重复约束";
  const codes = lintSeedancePromptV3(invalid, c);
  assert.ok(codes.includes("GLOBAL_CONSTRAINT_DUPLICATED"));
  assert.ok(codes.includes("BGM_POLICY_MISSING"));
  assert.ok(codes.includes("NATIVE_AUDIO_MISSING"));
  assert.ok(codes.includes("LEGACY_AUDIO_DISABLE_PRESENT"));
});
