import test from "node:test";
import assert from "node:assert/strict";
import { buildV8DirectorDecision } from "../src/application/services/v8-director-decision.js";
import type { ScriptDraft } from "../src/domain/schemas.js";
import type { V8DetailedProposal } from "../src/application/services/v8-detailed-screenplay-service.js";
import { H } from "./fixtures.js";

function fixture() {
  const proposal:V8DetailedProposal={
    title:"浴室外的奇怪声音",premise:"两位朋友发现一个小误会。",
    storyConflict:"室友误认为某个物品不属于自己。",
    finalOutcome:"真相被清楚说明。",
    scenes:[{
      location:"客厅",interiorExterior:"INT",timeOfDay:"DAY",
      situation:"两人在同一空间问答。",dramaticPurpose:"提出疑问、给出答案。",
      actorObjectives:[{speaker:"室友",wants:"知道答案",obstacle:"缺乏信息"},
        {speaker:"主人公",wants:"解释事实",obstacle:"对方不理解"}],
      beats:[{
        purpose:"HOOK",action:"室友向主人公追问",
        actorAction:"室友看向主人公发问",
        stateIn:"两人尚未对话",stateOut:"室友提出问题",
        productRole:"未出现",estimatedDurationMs:5000,
        requiredFactIds:[],audienceKnowledgeChange:"观众知道室友困惑",
        dialogue:[{speaker:"室友",mode:"ONSCREEN",text:"这是什么？",tone:"疑惑",delivery:"低声、轻快、尾音清楚"}],
        postProductionText:[],ambience:[],sfx:[]
      },{
        purpose:"PRODUCT",action:"主人公指向产品给出答案",
        actorAction:"主人公指向桌上的产品",
        stateIn:"室友等待答案",stateOut:"主人公已说明答案",
        productRole:"答案揭晓",estimatedDurationMs:5000,
        requiredFactIds:[],audienceKnowledgeChange:"观众知道真实物品",
        dialogue:[{speaker:"主人公",mode:"OFFSCREEN",text:"是桌上的产品。",tone:"温和",delivery:"语速正常"}],
        postProductionText:[],ambience:[],sfx:[]
      }]
    }]
  };
  const script={
    id:"script-1",projectId:"project-1",version:1,targetDurationMs:10000,contentHash:H.c,
    beats:proposal.scenes[0]!.beats.map((beat,i)=>({
      id:"beat-"+i,order:i+1,purpose:beat.purpose,text:beat.action,estimatedDurationMs:beat.estimatedDurationMs,
      requiredFactIds:[],videoIntent:{
        location:"客厅",storyAction:beat.actorAction,productRole:beat.productRole,
        stateIn:beat.stateIn,stateOut:beat.stateOut,
        dialogue:beat.dialogue.map(line=>line.speaker+"：“"+line.text+"”").join(""),
        audioIntent:{ambience:[],sfx:[],bgm:false as const},postProductionText:[]
      }
    }))
  } as unknown as ScriptDraft;
  return {proposal,script};
}

test("V8 director decisions lock all source dialogue, performance, reveal and variable clip durations",()=>{
  const {proposal,script}=fixture();
  const result=buildV8DirectorDecision({script,screenplay:proposal,modelMinSeconds:4,modelMaxSeconds:15});
  assert.equal(result.status,"DRAFT_NEEDS_VISUAL_DIRECTING");
  assert.deepEqual(result.clips.map(c=>c.durationMs/1000),[5,5]);
  assert.deepEqual(result.traceability,{totalLines:2,coveredLines:2,sourceBeats:2,coveredBeats:2});
  const spoken=result.clips.flatMap(clip=>clip.shots.flatMap(shot=>shot.spoken?[shot.spoken]:[]));
  assert.deepEqual(spoken.map(x=>x.exactText),["这是什么？","是桌上的产品。"]);
  assert.deepEqual(spoken.map(x=>x.mode),["ONSCREEN","OFFSCREEN"]);
  assert.equal(spoken[0]?.tone,"疑惑");
  assert.ok(result.clips[1]?.sourceAfterReveal.includes("观众知道真实物品"));
  assert.ok(result.clips.every(c=>c.shots.every(s=>s.cameraDecisionsPending&&s.blockingDecisionsPending)));
});
test("V8 director decision refuses a different screenplay action or model capability",()=>{
  const a=fixture();
  a.script.beats[0]!.videoIntent!.storyAction="擅自改变动作";
  assert.throws(()=>buildV8DirectorDecision({script:a.script,screenplay:a.proposal,modelMinSeconds:4,modelMaxSeconds:15}),/动作、场景或时长不一致/);
  const b=fixture();
  assert.throws(()=>buildV8DirectorDecision({script:b.script,screenplay:b.proposal,modelMinSeconds:4,modelMaxSeconds:4}),/时间预算未通过/);
});
test("V8 director decision maintains named actor's OS even though legacy videoIntent stores OS separately",()=>{
  const {proposal,script}=fixture();
  const beat=proposal.scenes[0]!.beats[1]!;
  beat.dialogue=[{speaker:"主人公",mode:"OS",text:"答案马上揭晓。",tone:"平静",delivery:"声线稳定"}];
  script.beats[1]!.videoIntent!.dialogue=undefined;
  script.beats[1]!.videoIntent!.os="答案马上揭晓。";
  const output=buildV8DirectorDecision({script,screenplay:proposal,modelMinSeconds:4,modelMaxSeconds:15});
  const os=output.clips.flatMap(c=>c.shots.map(s=>s.spoken).filter(Boolean)).find(v=>v?.mode==="OS");
  assert.equal(os?.speaker,"主人公");
  assert.equal(os?.exactText,"答案马上揭晓。");
});

test("V8 director counts a semantically split dialogue line exactly once without changing its speaker", () => {
  const { proposal, script } = fixture();
  const original = "等一下，这不是我的香水味。卧室里这股草本味是谁的？";
  proposal.scenes[0]!.beats[0]!.estimatedDurationMs = 9000;
  proposal.scenes[0]!.beats[0]!.dialogue[0]!.text = original;
  script.beats[0]!.estimatedDurationMs = 9000;
  script.beats[0]!.videoIntent!.dialogue = "室友：“" + original + "”";
  script.targetDurationMs = 14000;
  const result = buildV8DirectorDecision({
    script, screenplay: proposal, modelMinSeconds: 4, modelMaxSeconds: 15
  });
  assert.deepEqual(result.clips.map(clip => clip.durationMs), [9000, 5000]);
  assert.deepEqual(result.traceability, {
    totalLines: 2, coveredLines: 2, sourceBeats: 2, coveredBeats: 2
  });
  const parts = result.clips[0]!.shots.flatMap(shot => shot.spoken ? [shot.spoken] : []);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.exactText).join(""), original);
  assert.ok(parts.every(part => part.speaker === "室友" &&
    part.sourceLineText === original && part.sourcePartCount === parts.length));
  assert.deepEqual(parts.map(part => part.sourcePartIndex), parts.map((_, index) => index + 1));
});
