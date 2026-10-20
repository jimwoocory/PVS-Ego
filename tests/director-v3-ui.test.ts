import test from "node:test";
import assert from "node:assert/strict";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import { renderDirectorV3Panels } from "../src/web/director-v3-ui.js";
import { H, ISO, makeValidClip, makeProductTruth } from "./fixtures.js";
import type { WorkflowInlineData } from "../src/web/workflow-inline-panels.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";

function v3Run(): SmartGenerationRun {
  const clip = makeValidClip();
  const script = {
    id: "script-v3-ui",
    projectId: "project-1",
    version: 1,
    status: "DRAFT" as const,
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
    targetDurationMs: 10000,
    beats: [
      {
        id: "beat-v3-ui",
        order: 1,
        purpose: "PRODUCT" as const,
        text: "取出产品并自然放好。",
        estimatedDurationMs: 10000,
        requiredFactIds: ["fact-1"],
        videoIntent: {
          location: "卧室",
          storyAction: "取出产品并自然放好",
          productRole: "完整产品出现",
          stateIn: "产品收在柜内",
          stateOut: "产品放到床面",
          productStateIn: "完整成品，外罩闭合",
          productStateOut: "完整成品，外罩闭合",
          audioIntent: {
            ambience: ["卧室自然环境声"],
            sfx: ["柜门声", "布料声"],
            bgm: false as const
          },
          postProductionText: ["后期文案"]
        }
      }
    ],
    contentHash: H.c
  };
  clip.durationMs = 10000;
  clip.sourceBeatIds = ["beat-v3-ui"];
  clip.segments[0]!.endMs = 5000;
  clip.segments[1]!.startMs = 5000;
  clip.segments[1]!.endMs = 10000;
  const productionPlan = {
    id: "plan-v3-ui",
    projectId: "project-1",
    version: 1,
    status: "DRAFT" as const,
    productTruthRef: script.productTruthRef,
    scriptRef: {
      entityType: "ScriptDraft",
      entityId: script.id,
      version: script.version,
      hash: script.contentHash
    },
    selectedCreativeId: "creative-1",
    visualDirection: "真实自然",
    soundDirection: "保留原生声音",
    productShowcaseRules: ["保持产品身份"],
    continuityLock: {
      product: {
        stableAttributes: ["产品身份"],
        forbiddenChanges: []
      },
      characters: [],
      environments: [
        {
          sceneId: "scene-v3-ui",
          stableElements: ["卧室"]
        }
      ]
    },
    scenes: [
      {
        id: "scene-v3-ui",
        order: 1,
        purpose: "产品出现",
        location: "卧室",
        visualState: "稳定",
        sourceBeatIds: ["beat-v3-ui"],
        requiredFactIds: ["fact-1"],
        clips: [{ ...clip, sceneId: "scene-v3-ui" }]
      }
    ],
    contentHash: H.d
  };
  const contract = {
    id: "contract-v3-ui",
    order: 1,
    sourceBeatIds: ["beat-v3-ui"],
    purpose: "取出产品并自然放到床面",
    location: "卧室",
    durationMs: 10000,
    openingState: "产品在柜内",
    closingState: "产品在床面",
    actions: [
      {
        order: 1,
        startMs: 0,
        endMs: 10000,
        description: "取出产品并放到床面",
        productState: "完整成品，外罩闭合"
      }
    ],
    camera: {
      shotSize: "中近景",
      position: "稳定机位",
      angle: "轻俯视",
      movement: "轻微跟随"
    },
    referenceAssetIds: [],
    productStateChanges: [],
    audio: {
      mode: "NATIVE" as const,
      dialogueOrOs: [],
      ambience: ["卧室自然环境声"],
      sfx: ["柜门声", "布料声"],
      bgm: false as const
    },
    globalConstraints: {
      preserveProductIdentity: true,
      noReadableText: true,
      noBgm: true as const,
      extra: []
    }
  };
  return {
    id: "run-v3-ui",
    projectId: "project-1",
    workflowVersion: 2,
    requestKey: "v3-ui",
    inputHash: H.e,
    revision: 3,
    status: "PLANNING",
    stage: "PREFLIGHT",
    targetDurationMs: 10000,
    options: {
      requestText: "生成产品视频",
      directorVersion: 3,
      generationSettings: {
        requestedModelVersion: "seedance2.0mini",
        aspectRatio: "9:16",
        videoResolution: "720p",
        nativeAudioOutputRequested: true
      },
      reviewMode: "AUTO",
      autoSelectLowRiskClips: false,
      useExistingResearch: false,
      useResearchReferences: false,
      allowSilentOutput: false
    },
    expectedWorkspace: {},
    script,
    scriptFeasibility: {
      version: "director-v3-1",
      projectId: "project-1",
      scriptRef: {
        entityType: "ScriptDraft",
        entityId: script.id,
        version: script.version,
        hash: script.contentHash
      },
      status: "PASS",
      metrics: {
        beatCount: 1,
        estimatedTotalMs: 10000,
        detectedActionCount: 2,
        detectedSceneTransitionCount: 0,
        detectedProductStateChangeCount: 0,
        editingDirectiveCount: 0,
        burnedTextDirectiveCount: 0
      },
      issues: [],
      createdAt: ISO,
      contentHash: H.f
    },
    directorV3Plan: {
      version: "director-v3-1",
      projectId: "project-1",
      scriptRef: {
        entityType: "ScriptDraft",
        entityId: script.id,
        version: script.version,
        hash: script.contentHash
      },
      targetDurationMs: 10000,
      clipContracts: [contract],
      createdAt: ISO,
      contentHash: H.one
    },
    seedancePromptDrafts: [
      {
        version: "seedance-prompt-v3-1",
        id: "prompt-v3-ui",
        projectId: "project-1",
        clipId: clip.id,
        sourceContractHash: H.two,
        status: "DRAFT",
        promptText:
          "【参考素材】\n产品主参考\n【本段视频目标】\n产品出现\n【动作与时间顺序】\n0–10秒：取出产品\n【摄影】\n稳定机位\n【声音】\n不生成背景音乐。生成并保留自然环境声。\n【全局约束】\n保持产品身份。",
        originalPromptText:
          "【参考素材】\n产品主参考\n【本段视频目标】\n产品出现\n【动作与时间顺序】\n0–10秒：取出产品\n【摄影】\n稳定机位\n【声音】\n不生成背景音乐。生成并保留自然环境声。\n【全局约束】\n保持产品身份。",
        createdAt: ISO,
        updatedAt: ISO,
        contentHash: H.three
      }
    ],
    productionPlan,
    attemptIds: [],
    notes: [],
    createdAt: ISO,
    updatedAt: ISO
  };
}

test("Director V3 UI exposes editable Script, Clip Contract and final Seedance Prompt layers", () => {
  const html = renderDirectorV3Panels(v3Run());
  assert.match(html, /① 剧本 · Director V3/);
  assert.match(html, /② 分镜 · Clip Contract/);
  assert.match(html, /③ 最终 Seedance Prompt/);
  assert.match(html, /v3-script-product-state-in/);
  assert.match(html, /v3-script-product-state-out/);
  assert.match(html, /data-action="script-v3"/);
  assert.match(html, /data-action="storyboard-v3"/);
  assert.match(html, /data-action="prompt-v3"/);
  assert.match(html, /不让 Seedance 生成文字/);
  assert.match(html, /BGM 禁止/);
});

test("old QA PASS cannot conceal an 8×7.5s script; V3 exposes explicit repair and editable time",()=>{
  const run=v3Run();
  const first=run.script!.beats[0]!;
  run.script!.beats=Array.from({length:8},(_,index)=>({
    ...structuredClone(first),id:"scene-uneven-"+index,
    order:index+1,text:"古装县令与师爷就今晚休息时辰发生新的对话与动作。"+index,
    estimatedDurationMs:7500
  }));
  run.script!.targetDurationMs=60000;
  run.targetDurationMs=60000;
  const html=renderDirectorV3Panels(run);
  assert.match(html,/原版 QA|旧版 QA 显示通过/);
  assert.match(html,/节奏或叙事问题/);
  assert.match(html,/机械均分/);
  assert.match(html,/data-action="repair-script-v3"/);
  assert.match(html,/v3-script-duration/);
  assert.match(html,/允许 54–66 秒/);
  run.attemptIds=["already-submitted"];
  const readonly=renderDirectorV3Panels(run);
  assert.doesNotMatch(readonly,/data-action="repair-script-v3"/);
  assert.match(readonly,/class="v3-editor v3-script-duration".*readonly/);
});

test("generated V3 videos and correct ClipId prompts share one card, with prompt text folded", () => {
  const run=v3Run();
  run.stage="CLIP_REVIEW";
  run.status="WAITING_FOR_CLIP_REVIEW";
  run.blocker={code:"VISUAL_REVIEW_REQUIRED",retryable:true,message:"视频 1：需要检查"};
  run.attemptIds=["attempt-one","attempt-two"];
  const first=run.productionPlan!.scenes[0]!.clips[0]!;
  const second={...structuredClone(first),id:"clip-v3-two",order:2,contentHash:H.f};
  run.productionPlan!.scenes[0]!.clips=[first,second];
  const contract=run.directorV3Plan!.clipContracts[0]!;
  run.directorV3Plan!.clipContracts.push({...structuredClone(contract),id:"contract-v3-two",order:2});
  const draft=run.seedancePromptDrafts![0]!;
  // Deliberately shuffle saved prompt order: never pair a video by index.
  run.seedancePromptDrafts=[
    {...structuredClone(draft),id:"prompt-two",clipId:second.id,promptText:"PROMPT_SECOND_ONLY"},
    {...structuredClone(draft),id:"prompt-one",clipId:first.id,promptText:"PROMPT_FIRST_ONLY"}
  ];
  const workspace={
    project:{id:run.projectId,name:"通用 V3 视频审片项目",status:"READY_TO_GENERATE",
      targetPlatform:"douyin",targetDurationMs:10000,aspectRatio:"9:16",
      createdAt:ISO,updatedAt:ISO},
    productTruth:makeProductTruth()
  };
  const inline={
    attempts:[
      {id:"attempt-one",clipId:first.id,attemptNumber:1,status:"SUCCEEDED",outputArtifactId:"video-one"},
      {id:"attempt-two",clipId:second.id,attemptNumber:1,status:"SUCCEEDED",outputArtifactId:"video-two"}
    ],
    artifacts:[
      {id:"video-one",projectId:run.projectId,integrityStatus:"READY",mimeType:"video/mp4"},
      {id:"video-two",projectId:run.projectId,integrityStatus:"READY",mimeType:"video/mp4"}
    ],
    decisions:[],visualSummaries:[]
  };
  const review={workspace,run,...inline} as unknown as WorkflowInlineData;
  const panels=renderDirectorV3Panels(run,review);
  assert.match(panels,/id="v3-seedance-workbench-run-v3-ui" open/);
  const a=panels.indexOf('id="v3-video-1"'),b=panels.indexOf('id="v3-video-2"');
  assert.ok(a>0&&b>a);
  const firstCard=panels.slice(a,b),secondCard=panels.slice(b);
  assert.match(firstCard,/src="\/api\/artifacts\/video-one\/content"/);
  assert.match(firstCard,/PROMPT_FIRST_ONLY/);
  assert.doesNotMatch(firstCard,/PROMPT_SECOND_ONLY/);
  assert.match(secondCard,/src="\/api\/artifacts\/video-two\/content"/);
  assert.match(secondCard,/PROMPT_SECOND_ONLY/);
  assert.doesNotMatch(secondCard,/PROMPT_FIRST_ONLY/);
  assert.equal((panels.match(/<video controls/g)??[]).length,2);
  assert.equal((panels.match(/<details class="v3-prompt-details"\s*>/g)??[]).length,2);
  assert.equal((panels.match(/data-inline-action="clip-decision" data-decision="ACCEPT"/g)??[]).length,2);
  assert.equal((panels.match(/data-inline-action="clip-finalize"/g)??[]).length,1);
  // A missing matching prompt leaves its own playable video, not another clip's text.
  run.seedancePromptDrafts=run.seedancePromptDrafts.filter(item=>item.clipId!==second.id);
  const missing=renderDirectorV3Panels(run,review);
  assert.match(missing,/此镜头没有匹配的已保存生成提示词/);
  assert.equal((missing.match(/<video controls/g)??[]).length,2);
  const full=renderSmartGenerationPage(workspace as never,[run],{inline:inline as never,selectedRunId:run.id});
  assert.doesNotMatch(full,/id="review-panel-run-v3-ui"/);
  assert.match(full,/<a class="primary" href="#v3-seedance-workbench-run-v3-ui">查看生成视频与审核结果<\/a>/);
  assert.equal((full.match(/<video controls/g)??[]).length,2);
  assert.equal((full.match(/data-visual-recheck="1"/g)??[]).length,1);
  assert.ok(full.indexOf('data-visual-recheck="1"')>full.indexOf('id="v3-seedance-workbench-run-v3-ui"'));
  assert.ok(full.indexOf('data-visual-recheck="1"')<full.indexOf('data-action="cancel"'));
  assert.equal((full.match(/data-inline-action="clip-finalize"/g)??[]).length,1);
});

test("unproduced V3 prompts stay open and editable for user review",()=>{
  const html=renderDirectorV3Panels(v3Run());
  assert.match(html,/<details class="v3-prompt-details" open>/);
  assert.match(html,/data-action="prompt-v3"/);
  assert.doesNotMatch(html,/<video controls/);
});

test("Director V3 UI becomes read-only after a real attempt exists", () => {
  const run = v3Run();
  run.attemptIds = ["attempt-real"];
  const html = renderDirectorV3Panels(run);
  assert.doesNotMatch(html, /data-action="script-v3"/);
  assert.doesNotMatch(html, /data-action="storyboard-v3"/);
  assert.doesNotMatch(html, /data-action="prompt-v3"/);
  assert.match(html, /当前任务已经进入真实生成或下游阶段/);
});
