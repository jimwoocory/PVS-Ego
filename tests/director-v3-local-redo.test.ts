import test from "node:test";
import assert from "node:assert/strict";
import {
  smartRunSchema,
  type SmartGenerationRun
} from "../src/domain/smart-generation.js";
import {
  DIRECTOR_V3_VERSION,
  type DirectorV3Plan
} from "../src/domain/director-v3.js";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import {
  MemorySmartRuns,
  FixtureProduction,
  smartOptions
} from "./smart-test-support.js";
import {
  buildSeedancePromptV3,
  createSeedancePromptV3Draft
} from "../src/application/services/seedance-model-prompt-v3.js";
import { hashValue } from "../src/domain/hashing.js";
import { H, ISO } from "./fixtures.js";
import { renderDirectorV3Panels } from "../src/web/director-v3-ui.js";

class V3EditProduction extends FixtureProduction {
  async reviseScriptV3(
    run: SmartGenerationRun,
    beats: NonNullable<SmartGenerationRun["script"]>["beats"]
  ) {
    const current = run.script!;
    const script = {
      ...current,
      id: "script-v3-revised",
      version: current.version + 1,
      status: "DRAFT" as const,
      beats: structuredClone(beats),
      contentHash: H.f,
      confirmedAt: undefined
    };
    const base = {
      version: DIRECTOR_V3_VERSION,
      projectId: run.projectId,
      scriptRef: {
        entityType: "ScriptDraft" as const,
        entityId: script.id,
        version: script.version,
        hash: script.contentHash
      },
      status: "PASS" as const,
      metrics: {
        beatCount: script.beats.length,
        estimatedTotalMs: script.targetDurationMs,
        detectedActionCount: 1,
        detectedSceneTransitionCount: 0,
        detectedProductStateChangeCount: 1,
        editingDirectiveCount: 0,
        burnedTextDirectiveCount: 0
      },
      issues: [],
      createdAt: ISO
    };
    return {
      script,
      feasibility: {
        ...base,
        contentHash: hashValue(base)
      }
    };
  }
}

async function seeded() {
  const repo = new MemorySmartRuns();
  const production = new V3EditProduction();
  const service = new SmartGenerationService(repo, production);
  let run = await service.create(
    "project-1",
    "v3-local-redo",
    {
      ...smartOptions,
      directorVersion: 3,
      generationSettings: {
        ...smartOptions.generationSettings,
        nativeAudioOutputRequested: true
      }
    },
    2
  );

  const script = structuredClone(production.c.input.script);
  script.status = "CONFIRMED";
  const productionPlan = await production.director({
    ...run,
    script
  } as SmartGenerationRun);
  const scene = productionPlan.scenes[0]!;
  const clip = scene.clips[0]!;
  const contract = {
    id: "contract-local-redo",
    order: 1,
    sourceBeatIds: [...clip.sourceBeatIds],
    purpose: "展示当前产品并完成一个清晰动作",
    location: scene.location,
    durationMs: clip.durationMs,
    openingState: "产品准备展示",
    closingState: "产品完成展示",
    actions: [
      {
        order: 1,
        startMs: 0,
        endMs: clip.durationMs,
        description: "自然展示当前产品",
        productState: "完整产品"
      }
    ],
    camera: {
      shotSize: "中近景",
      position: "稳定机位",
      angle: "轻俯视",
      movement: "固定机位"
    },
    referenceAssetIds: [],
    productStateChanges: [],
    audio: {
      mode: "NATIVE" as const,
      dialogueOrOs: [],
      ambience: ["自然室内环境声"],
      sfx: ["产品接触声"],
      bgm: false as const
    },
    globalConstraints: {
      preserveProductIdentity: true,
      noReadableText: true,
      noBgm: true as const,
      extra: []
    }
  };
  const directorBase = {
    version: DIRECTOR_V3_VERSION,
    projectId: run.projectId,
    scriptRef: {
      entityType: "ScriptDraft" as const,
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    targetDurationMs: script.targetDurationMs,
    clipContracts: [contract],
    createdAt: ISO
  };
  const directorV3Plan: DirectorV3Plan = {
    ...directorBase,
    contentHash: hashValue(directorBase)
  };
  const promptText = buildSeedancePromptV3({
    truth: production.c.input.productTruth,
    plan: productionPlan,
    scene,
    clip,
    contract,
    model: "seedance2.0mini",
    aspectRatio: "16:9",
    videoResolution: "720p"
  });
  const promptDraft = createSeedancePromptV3Draft({
    projectId: run.projectId,
    clipId: clip.id,
    contract,
    promptText,
    now: ISO
  });
  const scope = await production.preparePaidScope({
    ...run,
    script,
    productionPlan
  } as SmartGenerationRun);

  run = smartRunSchema.parse({
    ...run,
    revision: 5,
    stage: "PREFLIGHT",
    status: "PLANNING",
    script,
    productionPlan,
    directorV3Plan,
    seedancePromptDrafts: [promptDraft],
    paidScope: scope,
    attemptIds: [],
    pendingInstall: undefined
  });
  repo.runs.set(run.id, structuredClone(run));
  return {
    repo,
    production,
    service,
    run,
    clip,
    promptDraft
  };
}

test("Director V3 prompt edit invalidates only paid preflight, not script/storyboard", async () => {
  const fx = await seeded();
  const edited =
    fx.promptDraft.promptText.replace(
      "固定机位",
      "固定机位，动作保持自然"
    );
  const updated = await fx.service.updatePromptV3(
    fx.run.projectId,
    fx.run.id,
    {
      expectedRevision: fx.run.revision,
      clipId: fx.clip.id,
      prompt: edited
    }
  );
  assert.equal(updated.script?.contentHash, fx.run.script?.contentHash);
  assert.equal(
    updated.productionPlan?.contentHash,
    fx.run.productionPlan?.contentHash
  );
  assert.equal(
    updated.directorV3Plan?.contentHash,
    fx.run.directorV3Plan?.contentHash
  );
  assert.equal(
    updated.seedancePromptDrafts?.[0]?.promptText,
    edited
  );
  assert.equal(updated.paidScope, undefined);
  assert.equal(updated.stage, "PREFLIGHT");
});

test("Director V3 storyboard edit keeps script but rebuilds formal plan and prompt", async () => {
  const fx = await seeded();
  const c = fx.run.directorV3Plan!.clipContracts[0]!;
  const updated = await fx.service.updateClipContractV3(
    fx.run.projectId,
    fx.run.id,
    {
      expectedRevision: fx.run.revision,
      clipId: fx.clip.id,
      purpose: c.purpose + "，避免多余动作",
      location: c.location,
      actionDescriptions: ["稳定展示产品，不增加额外动作"],
      camera: {
        ...c.camera,
        movement: "固定机位，不切换场景"
      },
      audio: {
        ambience: c.audio.ambience,
        sfx: c.audio.sfx,
        dialogueOrOs: c.audio.dialogueOrOs
      }
    }
  );
  assert.equal(updated.script?.contentHash, fx.run.script?.contentHash);
  assert.equal(updated.productionPlan, undefined);
  assert.equal(updated.seedancePromptDrafts, undefined);
  assert.notEqual(
    updated.directorV3Plan?.contentHash,
    fx.run.directorV3Plan?.contentHash
  );
  assert.equal(updated.stage, "DIRECTOR");
  assert.equal(updated.paidScope, undefined);
});

test("Director V3 script edit invalidates storyboard and prompt but keeps product/assets outside this run patch", async () => {
  const fx = await seeded();
  const beats = structuredClone(fx.run.script!.beats);
  beats[0]!.text = "更简洁地完成产品展示。";
  const updated = await fx.service.updateScriptV3(
    fx.run.projectId,
    fx.run.id,
    {
      expectedRevision: fx.run.revision,
      beats
    }
  );
  assert.equal(updated.script?.id, "script-v3-revised");
  assert.equal(updated.productionPlan, undefined);
  assert.equal(updated.directorV3Plan, undefined);
  assert.equal(updated.seedancePromptDrafts, undefined);
  assert.equal(updated.paidScope, undefined);
  assert.equal(updated.pendingInstall, "SCRIPT");
  assert.equal(updated.stage, "SCRIPT");
});

test("Director V3 editing is fail-closed after a real generation attempt exists", async () => {
  const fx = await seeded();
  const locked = smartRunSchema.parse({
    ...fx.run,
    attemptIds: ["attempt-real"]
  });
  fx.repo.runs.set(locked.id, structuredClone(locked));
  await assert.rejects(
    fx.service.updatePromptV3(
      locked.projectId,
      locked.id,
      {
        expectedRevision: locked.revision,
        clipId: fx.clip.id,
        prompt: fx.promptDraft.promptText
      }
    ),
    /真实生成|不能覆盖/
  );
});

test("Director V3 UI exposes editable script, storyboard and final Seedance prompt before paid generation", async () => {
  const fx = await seeded();
  const html = renderDirectorV3Panels(fx.run);
  assert.match(html, /① 剧本 · Director V3/);
  assert.match(html, /② 分镜 · Clip Contract/);
  assert.match(html, /③ 最终 Seedance Prompt/);
  assert.match(html, /data-action="script-v3"/);
  assert.match(html, /data-action="storyboard-v3"/);
  assert.match(html, /data-action="prompt-v3"/);
  assert.match(
    html,
    /保留 Seedance 原生环境声 \/ 交互声 \/ 音效 \/ 对白 \/ OS；BGM 禁止/
  );
  assert.doesNotMatch(
    html,
    /class="v3-editor[^"]*"[^>]*readonly/
  );
});

test("Director V3 UI becomes read-only after a real attempt exists", async () => {
  const fx = await seeded();
  const locked = smartRunSchema.parse({
    ...fx.run,
    attemptIds: ["attempt-real"]
  });
  const html = renderDirectorV3Panels(locked);
  assert.match(html, /本轮导演内容只读/);
  assert.doesNotMatch(html, /data-action="script-v3"/);
  assert.doesNotMatch(html, /data-action="storyboard-v3"/);
  assert.doesNotMatch(html, /data-action="prompt-v3"/);
});
