import assert from "node:assert/strict";
import test from "node:test";
import type { ScriptDraft } from "../src/domain/schemas.js";
import { ScriptFeasibilityService } from "../src/application/services/script-feasibility-service.js";
import {
  auditNarrativeTiming, isScriptDurationWithinTolerance
} from "../src/application/services/script-narrative-timing.js";
import { H, ISO } from "./fixtures.js";

function screenplay(durations = [4000,5000,7000,8500,10500,9000,8000,8000]): ScriptDraft {
  const texts = [
    "古装县衙公堂之中，县令拍下惊堂木，直视师爷问道：为何今夜还有公务；师爷谨慎站在案旁，听出了他的倦意。",
    "师爷走到桌前翻开案卷，说出县令已经几晚未歇的缘故；县令表面不服气，手却仍握着朱笔不肯放下。",
    "县令说自己只再审一页，却发现案卷远不止这一页；师爷没有反驳，伸手将新案卷轻轻推回桌边。",
    "县令随后来到卧房，终于主动说今夜不再处理公事；师爷跟着进屋，确认县令这一次是真正要休息。",
    "卧房床头摆有已核实的草本护颈枕，师爷向县令说明这件寝具用于日常睡眠环境；县令靠近认真查看。",
    "师爷提醒县令先放下没办完的公务，把自己从繁忙的案卷中抽离；县令点头，神情渐渐安定下来。",
    "县令合起书案上带来的最后一册案卷，交到师爷手中；师爷收好案卷并走向门口，二人达成明日继续的约定。",
    "师爷问今晚是否还要审案，县令笑答今日先放过自己；房里只留下寻常休息的宁静，前面埋下的休息矛盾得以解决。"
  ];
  return {
    id:"script-story-rhythm", projectId:"project-1",version:1,status:"DRAFT",
    productTruthRef:{entityType:"ProductTruth",entityId:"truth-1",version:1,hash:H.a},
    creativeBatchRef:{entityType:"CreativeBatch",entityId:"batch-1",version:1,hash:H.b},
    selectedCreativeId:"creative-1",targetDurationMs:60000,
    beats:durations.map((ms,index)=>({
      id:"beat-rhythm-"+(index+1),order:index+1,
      purpose:(["HOOK","PAIN","PAIN","OTHER","PRODUCT","FEATURE","RESULT","CTA"] as const)[index]!,
      text:texts[index]!,estimatedDurationMs:ms,
      requiredFactIds:index===4?["fact-1"]:[],
      videoIntent:{
        location:index<3?"县衙公堂":"县令卧房",
        storyAction:index===3?"县令随后来到卧房":index===6?"县令收起案卷交给师爷":"县令与师爷围绕归还休息时辰作出具体行动",
        productRole:index>=4?"床头寝具融入就寝场景":"产品不出现",
        stateIn:"上一段延续的事件起点", stateOut:"事件发生后的当前结果",
        ...(index>=4?{productStateIn:"寝具保持原样",productStateOut:"寝具保持原样"}:{}),
        ...(index===3?{dialogue:"县令：今夜不再审案，明日继续。"}:{}),
        audioIntent:{ambience:["古装室内自然环境声"],sfx:["人物动作自然音效"],bgm:false as const},
        postProductionText:[]
      }
    })),
    contentHash:H.c
  };
}
const service=new ScriptFeasibilityService({id:"unused",version:"1",generateJson:async()=>{throw Error("offline test must not call model");}});

test("60s film allows actual 54..66 seconds, with no hidden 8% QA clamp",()=>{
  assert.equal(isScriptDurationWithinTolerance(60000,54000),true);
  assert.equal(isScriptDurationWithinTolerance(60000,66000),true);
  assert.equal(isScriptDurationWithinTolerance(60000,53999),false);
  assert.equal(isScriptDurationWithinTolerance(60000,66001),false);
  assert.equal(isScriptDurationWithinTolerance(10000,11000),true);
  assert.equal(isScriptDurationWithinTolerance(10000,12000),false);
  const within=screenplay([4000,5000,7000,8500,10500,9000,8000,12000]);
  assert.equal(within.beats.reduce((s,b)=>s+b.estimatedDurationMs,0),64000);
  assert.equal(service.review(within).issues.some(x=>x.code==="DURATION_OVERLOAD"),false);
  const outside=screenplay([4000,5000,7000,8500,10500,9000,8000,15000]);
  assert.ok(service.review(outside).issues.some(x=>x.code==="DURATION_OVERLOAD"));
});

test("real example: 8 different story beats of 7.5s each fails even with an exact 60s sum",()=>{
  const script=screenplay(Array(8).fill(7500));
  const report=service.review(script);
  assert.equal(report.status,"REVISE");
  assert.equal(report.metrics.estimatedTotalMs,60000);
  assert.ok(report.issues.some(i=>i.code==="BEAT_DURATION_UNIFORM"));
  assert.deepEqual(report.timingAudit?.map(a=>a.assignedMs),Array(8).fill(7500));
});

test("diverse durations with complete scenes and cause/action progression can pass",()=>{
  const script=screenplay();
  const report=service.review(script);
  assert.equal(report.status,"PASS",JSON.stringify(report.issues));
  assert.equal(report.timingAudit?.length,8);
  assert.ok(report.timingAudit?.some(a=>a.sceneChanged));
});

test("fast speaking with long exact dialogue fails regardless of good total duration",()=>{
  const script=screenplay();
  script.beats[0]!.videoIntent!.dialogue="县令：本官今日还有几十大本公文需要处理，而且每一本都要给你解释一遍现在为什么绝对不能休息，也不能明日再审，现在必须全部审完。";
  const report=service.review(script);
  assert.ok(report.issues.some(i=>i.code==="BEAT_SPEECH_OVERLOAD" && i.beatIds.includes(script.beats[0]!.id)));
});

test("thin long descriptions, unexplained location jumps and repeated actions fail",()=>{
  const thin=screenplay();
  thin.beats[4]!.text="县令点头。";
  assert.ok(service.review(thin).issues.some(i=>i.code==="NARRATIVE_DESCRIPTION_THIN"));
  const jump=screenplay();
  jump.beats[3]!.text="县令皱起眉头，仔细询问师爷今日是否准备继续审案，师爷拿过一册卷宗站在身边，县令又追问事情进展。";
  jump.beats[3]!.videoIntent!.storyAction="县令询问师爷要不要继续审案";
  assert.ok(service.review(jump).issues.some(i=>i.code==="NARRATIVE_TRANSITION_UNCLEAR"));
  const repeated=screenplay();
  repeated.beats[2]!.text=repeated.beats[1]!.text;
  assert.ok(service.review(repeated).issues.some(i=>i.code==="NARRATIVE_DUPLICATE_BEAT"));
});

test("isolated same-duration pairs are not automatically treated as mechanical timing",()=>{
  const script=screenplay([5000,5000,7000,8000,10500,8500,8000,8000]);
  const audit=auditNarrativeTiming(script);
  assert.equal(audit.issues.some(i=>i.code==="BEAT_DURATION_UNIFORM"),false);
});
