import { Script as VmScript } from "node:vm";
import { scriptDraftSchema } from "../src/domain/schemas.js";
import { v8DetailedProposalSchema, type V8DetailedProposal } from "../src/domain/v8-screenplay.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { SmartGenerationService } from "../src/application/services/smart-generation-service.js";
import { smartRunSchema, runnableSmartStatuses } from "../src/domain/smart-generation.js";
import { renderSmartGenerationPage } from "../src/web/smart-generation-ui.js";
import { MemorySmartRuns, FixtureProduction, smartOptions } from "./smart-test-support.js";
import { hashValue } from "../src/domain/hashing.js";
async function drain(service: SmartGenerationService, start: SmartGenerationRun) {
    let run = start;
    for (let i = 0; i < 30 && runnableSmartStatuses.includes(run.status); i++) {
        run = await service.advance(run.projectId, run.id);
    }
    return run;
}
class V8Fixture extends FixtureProduction {
    v8Calls = 0;
    async scriptV8(run: SmartGenerationRun) {
        this.v8Calls++;
        const script = await this.script(run);
        const screenplay: V8DetailedProposal = {
            title: "卧室里的疑问",
            premise: "室友发现新产品，双方发生自然的误会。",
            storyConflict: "一方寻求答案，另一方希望解释清楚。",
            finalOutcome: "产品身份在结尾获得解释。",
            scenes: [{
                    location: "卧室", interiorExterior: "INT", timeOfDay: "DAY",
                    situation: "两个成年人谈论卧室里的新物品。",
                    dramaticPurpose: "让观众理解误会及解答。",
                    actorObjectives: [{
                            speaker: "室友", wants: "知道产品的来历", obstacle: "一开始不知道答案"
                        }],
                    beats: script.beats.map((beat, index) => ({
                        purpose: beat.purpose,
                        action: beat.text,
                        actorAction: beat.videoIntent?.storyAction ?? "室友查看新物品",
                        stateIn: "问题尚未解释",
                        stateOut: "观众得知第 " + (index + 1) + " 步结果",
                        productRole: "只显示已确认产品",
                        estimatedDurationMs: beat.estimatedDurationMs,
                        requiredFactIds: beat.requiredFactIds,
                        audienceKnowledgeChange: "观众看到动作发生",
                        dialogue: [{
                                speaker: "室友", mode: "ONSCREEN", text: "这是什么？",
                                tone: "疑惑", delivery: "正常语速，清晰完整"
                            }],
                        postProductionText: ["产品名称"], ambience: ["室内背景声"], sfx: []
                    }))
                }]
        };
        return { script, screenplay };
    }
}
const v8Options = {
    ...smartOptions,
    requestText: "用真实短剧故事介绍产品",
    directorVersion: 3,
    directorPipeline: "V8",
    reviewMode: "MANUAL"
};
test("complete creation workflow uses a friendly user-facing name while preserving internal V8 compatibility", () => {
    const previousFlag = process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
    process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = "1";
    try {
        const page = renderSmartGenerationPage({
            project: { id: "project-1", name: "样例项目", status: "DRAFT", targetPlatform: "douyin",
                targetDurationMs: 10000, aspectRatio: "16:9",
                createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }
        }, []);
        assert.match(page, /完整创作工作流（分步审核）/);
        assert.match(page, /逐阶段人工确认剧本、导演分镜和视频提示词/);
        assert.doesNotMatch(page, /试用 V8 详细短剧剧本|新 V8 详细剧本试点/);
        // IDs are intentionally stable so saved runs and HTTP actions stay compatible.
        assert.match(page, /id="smart-v8-authoring"/);
    } finally {
        if (previousFlag === undefined) delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
        else process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = previousFlag;
    }
});
test("V8 is disabled by default, and cannot be requested on a legacy or automatic run", async () => {
    const before = process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
    try {
        delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
        let service = new SmartGenerationService(new MemorySmartRuns(), new V8Fixture());
        await assert.rejects(service.create("project-1", "flag-off", v8Options, 2), /试点开关/);
        process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = "1";
        service = new SmartGenerationService(new MemorySmartRuns(), new V8Fixture());
        await assert.rejects(service.create("project-1", "legacy", v8Options, 1), /全新 V2/);
        await assert.rejects(service.create("project-1", "auto", { ...v8Options, reviewMode: "AUTO" }, 2), /人工确认/);
        await assert.rejects(service.create("project-1", "director2", { ...v8Options, directorVersion: 2 }, 2), /人工确认/);
    }
    finally {
        if (before === undefined)
            delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
        else
            process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = before;
    }
});
test("V8 screenplay persists across service restart and requires explicit hash-bound manual review", async () => {
    const before = process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
    process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = "1";
    try {
        const repo = new MemorySmartRuns(), production = new V8Fixture();
        const service = new SmartGenerationService(repo, production);
        let run = await drain(service, await service.create("project-1", "v8-new", v8Options, 2));
        assert.equal(run.status, "WAITING_FOR_CREATIVE_REVIEW");
        run = await service.review(run.projectId, run.id, {
            action: "SELECT_CREATIVE", expectedRevision: run.revision, creativeId: "creative-1"
        });
        run = await drain(service, run);
        assert.equal(run.status, "WAITING_FOR_SCRIPT_REVIEW");
        assert.equal(run.stage, "SCRIPT");
        assert.equal(production.v8Calls, 1);
        assert.equal(run.v8Screenplay?.status, "DRAFT");
        assert.equal(run.v8Screenplay?.sourceScriptHash, run.script?.contentHash);
        assert.equal(run.v8Screenplay?.screenplayHash, hashValue(run.v8Screenplay.screenplay));
        assert.equal(run.paidScope, undefined);
        assert.equal(production.counts.approvals, 0);
        assert.ok(repo.history.some(state => state.pendingInstall === "SCRIPT" &&
            state.v8Screenplay?.status === "DRAFT"));
        const page = renderSmartGenerationPage({
            project: { id: run.projectId, name: "样例项目", status: "DRAFT", targetPlatform: "douyin",
                targetDurationMs: run.targetDurationMs, aspectRatio: "16:9",
                createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }
        }, [run]);
        assert.match(page, /完整剧本 · 人工审核/);
        assert.match(page, /观众此刻得知/);
        assert.match(page, /逐场/);
        assert.match(page, /data-v8-screenplay/);
        assert.doesNotMatch(page, /data-action="paid"/);
        assert.match(page, /修改完整剧本/);
        assert.match(page, /data-action="script-v8"/);
        // Inline browser JavaScript bypasses TypeScript's regular compiler.
        const embeddedScripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
        assert.ok(embeddedScripts.length >= 2, "browser scripts must be present");
        for (const element of embeddedScripts) {
            new VmScript(element[1]!);
        }
        const resumed = new SmartGenerationService(repo, production);
        await assert.rejects(resumed.review(run.projectId, run.id, {
            action: "CONFIRM_SCRIPT", expectedRevision: run.revision
        }), /明确确认当前剧本版本/);
        await assert.rejects(resumed.review(run.projectId, run.id, {
            action: "CONFIRM_SCRIPT", expectedRevision: run.revision,
            confirmV8Screenplay: true, screenplayHash: "f".repeat(64)
        }), /明确确认当前剧本版本/);
        assert.equal((await resumed.get(run.projectId, run.id))?.revision, run.revision);
        run = await resumed.review(run.projectId, run.id, {
            action: "CONFIRM_SCRIPT", expectedRevision: run.revision,
            confirmV8Screenplay: true, screenplayHash: run.v8Screenplay.screenplayHash
        });
        assert.equal(run.v8Screenplay?.status, "CONFIRMED");
        assert.ok(run.v8Screenplay?.approvedAt);
        assert.equal(run.v8Screenplay?.sourceScriptHash, run.script?.contentHash);
        assert.equal(run.script?.status, "CONFIRMED");
        run = await drain(resumed, run);
        assert.equal(run.status, "BLOCKED");
        assert.equal(run.blocker?.code, "V8_DIRECTOR_ADOPTION_NOT_READY");
        assert.equal(production.counts.director, 0);
        assert.equal(production.counts.approvals, 0);
        assert.equal(production.counts.generate, 0);
        assert.equal(run.paidScope, undefined);
        assert.equal(run.consent, undefined);
        assert.deepEqual(run.attemptIds, []);
        await assert.rejects(resumed.updateScriptV3(run.projectId, run.id, {
            expectedRevision: run.revision, beats: run.script!.beats
        }), /互斥/);
        assert.equal(await resumed.get("other-project", run.id), null);
    }
    finally {
        if (before === undefined)
            delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
        else
            process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = before;
    }
});
test("V8 schema rejects stale screenplay, forged confirmation and inherited paid scope", async () => {
    const before = process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
    process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = "1";
    try {
        const service = new SmartGenerationService(new MemorySmartRuns(), new V8Fixture());
        const run = await service.create("project-1", "v8-schema", v8Options, 2);
        assert.throws(() => smartRunSchema.parse({
            ...run, options: { ...run.options, directorVersion: 2 }
        }), /V8 新流程/);
        assert.throws(() => smartRunSchema.parse({
            ...run, paidScope: {
                hash: "a".repeat(64),
                planRef: { entityType: "ProductionPlan", entityId: "fake-plan", version: 1, hash: "b".repeat(64) },
                requests: [], preparedAt: "2026-10-09T00:00:00.000Z"
            }
        }), /V8 导演/);
    }
    finally {
        if (before === undefined)
            delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
        else
            process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING = before;
    }
});

class V8EditFixture extends V8Fixture {
  async reviseV8Screenplay(run: SmartGenerationRun, input: unknown) {
    const screenplay=v8DetailedProposalSchema.parse(input);
    const source=run.script!;
    const beats=screenplay.scenes.flatMap(scene=>scene.beats);
    const { contentHash: _old, ...base }=source;
    const revised={
      ...base, version:source.version+1,
      beats:source.beats.map((beat,index)=>({
        ...beat,
        text:beats[index]!.action,
        estimatedDurationMs:beats[index]!.estimatedDurationMs,
        videoIntent:beat.videoIntent?{
          ...beat.videoIntent,
          storyAction:beats[index]!.actorAction
        }:undefined
      }))
    };
    return scriptDraftSchema.parse({...revised,contentHash:hashValue(revised)});
  }
}

test("V8 manual edit creates a fresh source version, resets review, and blocks stale approval",async()=>{
  const previous=process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
  process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING="1";
  try{
    const repo=new MemorySmartRuns();
    const production=new V8EditFixture();
    const service=new SmartGenerationService(repo,production);
    let run=await drain(service,await service.create("project-1","v8-edit",v8Options,2));
    run=await service.review(run.projectId,run.id,{
      action:"SELECT_CREATIVE",expectedRevision:run.revision,creativeId:"creative-1"
    });
    run=await drain(service,run);
    assert.equal(run.status,"WAITING_FOR_SCRIPT_REVIEW");
    const originalScript=run.script!;
    const originalHash=run.v8Screenplay!.screenplayHash;
    const updated=structuredClone(run.v8Screenplay!.screenplay);
    updated.scenes[0]!.beats[0]!.action="室友先看向桌面，再提出自己的疑问。";
    updated.scenes[0]!.beats[0]!.dialogue[0]!.text="这个东西是什么？";
    updated.scenes[0]!.beats[0]!.dialogue[0]!.tone="疑惑，稍有迟疑";
    updated.scenes[0]!.beats[0]!.audienceKnowledgeChange=
      "观众此时只知道室友困惑，不知道产品答案。";
    const edit=await service.updateV8Screenplay(run.projectId,run.id,{
      expectedRevision:run.revision,screenplay:updated
    });
    assert.equal(edit.status,"PLANNING");
    assert.equal(edit.pendingInstall,"SCRIPT");
    assert.equal(edit.v8Screenplay?.status,"DRAFT");
    assert.notEqual(edit.v8Screenplay?.screenplayHash,originalHash);
    assert.notEqual(edit.script?.contentHash,originalScript.contentHash);
    assert.equal(edit.script?.version,originalScript.version+1);
    assert.equal(edit.script?.beats[0]?.id,originalScript.beats[0]?.id);
    assert.equal(edit.paidScope,undefined);
    assert.equal(edit.consent,undefined);
    assert.deepEqual(edit.attemptIds,[]);
    assert.ok(repo.history.some(entry=>
      entry.v8Screenplay?.screenplayHash===originalHash));
    await assert.rejects(service.updateV8Screenplay(run.projectId,run.id,{
      expectedRevision:run.revision,screenplay:updated
    }),/更新/);
    run=await drain(service,edit);
    assert.equal(run.status,"WAITING_FOR_SCRIPT_REVIEW");
    await assert.rejects(service.review(run.projectId,run.id,{
      action:"CONFIRM_SCRIPT",expectedRevision:run.revision,
      confirmV8Screenplay:true,screenplayHash:originalHash
    }),/明确确认当前剧本版本/);
    const tampered=structuredClone(updated);
    tampered.scenes[0]!.beats[0]!.estimatedDurationMs+=1000;
    await assert.rejects(service.updateV8Screenplay(run.projectId,run.id,{
      expectedRevision:run.revision,screenplay:tampered
    }),/时长/);
    run=await service.review(run.projectId,run.id,{
      action:"CONFIRM_SCRIPT",expectedRevision:run.revision,
      confirmV8Screenplay:true,screenplayHash:run.v8Screenplay!.screenplayHash
    });
    assert.equal(run.v8Screenplay?.status,"CONFIRMED");
    await assert.rejects(service.updateV8Screenplay(run.projectId,run.id,{
      expectedRevision:run.revision,screenplay:updated
    }),/未确认|只能在/);
  }finally{
    if(previous===undefined) delete process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING;
    else process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING=previous;
  }
});
