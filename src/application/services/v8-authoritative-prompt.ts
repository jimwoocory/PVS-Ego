import { hashValue } from "../../domain/hashing.js";
import type {
  ScriptDraft, ProductionPlan, ProductTruth
} from "../../domain/schemas.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { V8DirectorDecision } from "./v8-director-decision.js";
import { reviewV8DirectorConformance } from "./v8-director-conformance.js";
import { compileV8ShotShadow } from "./v8-shot-prompt-shadow.js";
import { DomainValidationError } from "../../domain/validation.js";
import { buildClipContinuityGraph } from "./clip-continuity-engine.js";

export type V8VoiceBinding = {
  actorAssetKey: string;
  voiceType: string;
};
export type V8PromptPackage = {
  version:"v8-authoritative-prompt-1";
  clipId:string;
  durationMs:number;
  scriptHash:string;
  directorHash:string;
  productionPlanHash:string;
  sourceShotIds:string[];
  promptText:string;
  incomingContinuity?: {
    sourceClipId:string;
    relationship:"HARD_CONTINUITY"|"SAME_SCENE_CUT"|"SCENE_OR_TIME_JUMP"|"REVIEW_REQUIRED";
    plannedSourceEndStateHash:string;
    plannedTargetStartStateHash:string;
    contractHash:string;
    requiresHardFirstFrame:boolean;
  };
  audioManifest:Array<{
    sourceShotId:string;
    speaker:string;
    mode:"ONSCREEN"|"OFFSCREEN"|"OS";
    exactText:string;
    sourceLineText?:string;
    sourcePartIndex?:number;
    sourcePartCount?:number;
    voiceType:string;
    delivery:string;
  }>;
  postProductionText:Array<{
    sourceShotId:string;
    startMs:number;
    endMs:number;
    kind:"CAPTION"|"LABEL"|"LEGAL"|"CTA";
    exactText:string;
  }>;
  contentHash:string;
};

const formatSeconds=(ms:number)=> Number((ms/1000).toFixed(2)).toString();
export function compileV8AuthoritativePrompts(input:{
  script:ScriptDraft;
  truth:ProductTruth;
  decision:V8DirectorDecision;
  plan:ProductionPlan;
  assets:ProductionAssetSet;
  speakerBindings:Record<string,V8VoiceBinding>;
  maxPromptChars?:number;
  includeImageReferences?:boolean;
}):V8PromptPackage[]{
  const {script,truth,decision,plan,assets,speakerBindings}=input;
  if(truth.status!=="CONFIRMED" || script.contentHash!==decision.sourceScriptHash){
    throw new DomainValidationError("V8 提示词来源不是已确认的产品事实或权威剧本");
  }
  const conformance=reviewV8DirectorConformance(decision,plan);
  if(!conformance.passed){
    throw new DomainValidationError("V8 原分镜与 ProductDirector 详细镜头不一致：" +
      conformance.issues.slice(0,3).map(x=>x.message).join("；"));
  }
  const names:Record<string,string>={};
  const usedActorKeys = new Set<string>();
  for(const [name,binding] of Object.entries(speakerBindings)){
    const actor=assets.entries.find(e=>e.key===binding.actorAssetKey &&
      e.kind==="CHARACTER" && e.status==="READY");
    if(!actor)throw new DomainValidationError("V8 声线绑定的角色资产未就绪："+name);
    if(!binding.voiceType.trim())throw new DomainValidationError("V8 配音类型尚未明确："+name);
    if(usedActorKeys.has(binding.actorAssetKey))throw new DomainValidationError("V8 不同说话人不能复用同一演员身份，请分别绑定固定角色："+name);
    usedActorKeys.add(binding.actorAssetKey);
    names[name]=actor.key;
  }
  const combined=compileV8ShotShadow({
    script,plan,productionAssetSet:assets,
    speakerBindings:Object.fromEntries(Object.entries(speakerBindings)
      .map(([name,value])=>[name,value.actorAssetKey]))
  });
  if(combined.status!=="PASS"){
    throw new DomainValidationError("V8 原剧本与逐镜分镜仍有内容遗漏，不能编译正式视频提示词：" +
      combined.issues.slice(0,3).map(x=>x.message).join("；"));
  }
  const continuityGraph = input.includeImageReferences ? buildClipContinuityGraph(plan) : undefined;
  const actual=plan.scenes.flatMap(scene=>scene.clips.map(clip=>({scene,clip})));
  return actual.map(({scene,clip},index)=>{
    const decisionClip=decision.clips[index]!;
    const incoming=continuityGraph?.transitions.find(t=>t.targetClipId===clip.id);
    const lines=[
      "【项目规格】",
      "模型："+(plan.generationTarget?.requestedModelVersion??"需确认模型"),
      "画幅："+(plan.generationTarget?.aspectRatio??"按项目已选比例"),
      "分辨率："+(plan.generationTarget?.videoResolution??"按已验证模型能力"),
      "视频编号："+String(index+1).padStart(2,"0")+
        "；总时长："+formatSeconds(clip.durationMs)+" 秒",
      "",
      "【全局视觉】",
      plan.visualDirection,
      "画面无字幕、无水印、无无关文字；非剧情需要不出现 UI。禁止生成背景音乐，只保留剧本对白、明确 OS、必要环境声和物理音效。",
      "产品形态、材质、颜色、Logo 与已确认主参考图一致，不虚构功效。",
      "",
      "【场景与连续状态】",
      "场景："+scene.location+(scene.timeOfDay?"；时间："+scene.timeOfDay:""),
      "起始状态："+clip.openingState.description,
      "起始人物与空间："+(clip.openingState.characterState??"人物站位以分镜和固定角色参考为准"),
      "起始环境："+clip.openingState.environmentState,
      "起始产品："+clip.openingState.productState,
      "本段结束："+clip.closingState.description,
      "结束环境："+clip.closingState.environmentState,
      "结束产品："+clip.closingState.productState,
      "",
      "【光线】",
      clip.segments.map(s=>s.lighting).filter((v,i,a)=>a.indexOf(v)===i).join("；"),
      "",
      "【出场人物与身份】"
    ];
    if(incoming){
      lines.push("【跨视频连续性契约】",
        "上一段视频："+incoming.sourceClipId+"；连续关系："+incoming.relationship,
        "上一段预期结束状态："+incoming.plannedSourceEndStateHash,
        "本段预期开始状态："+incoming.plannedTargetStartStateHash,
        incoming.requiresHardFirstFrame
          ? "强连续：必须用上一段实际生成并审核通过的尾帧作为专用首帧控制，不能把普通多图参考当成硬首帧。"
          : "允许切机位或切场景，但人物道具和事件因果必须合理承接。",
        ...(incoming.relationship==="REVIEW_REQUIRED"
          ? ["当前导演尚未确认连续性类别，后续付费生成需阻断并人工确认。"] : []));
    }
    const referencedActors=assets.entries.filter(entry=>
      entry.kind==="CHARACTER" && entry.status==="READY" &&
      clip.referenceAssets.some(ref=>ref.assetId===entry.referenceAssetId && ref.role==="CHARACTER")
    );
    for(const actor of referencedActors){
      lines.push("参考角色资产："+actor.label+"（"+actor.key+"）；锁定外观身份、不可把参考图静态姿势当作动作。");
    }
    for (const [speaker,binding] of Object.entries(speakerBindings)) {
      if (decisionClip.shots.some(s=>s.spoken?.speaker === speaker)) {
        const actor=assets.entries.find(e=>e.key===binding.actorAssetKey)!;
        lines.push("说话人身份绑定："+speaker+" → "+actor.key+"；参考资产："+actor.referenceAssetId+"；固定声线："+binding.voiceType);
      }
    }
    // Use exactly the same deterministic order as PromptCompiler's assetManifest
    // and Dreamina's --image arguments. Names are human-readable aliases, not
    // a claim that the remote model provides a native @-binding mechanism.
    if (input.includeImageReferences === true) {
    const orderedImages = [...clip.referenceAssets].sort(
      (a, b) => a.priority - b.priority || a.assetId.localeCompare(b.assetId)
    );
    const usedLabels = new Set<string>();
    lines.push("【当前片段图片编号与资产】");
    for (const [offset, reference] of orderedImages.entries()) {
      const stored = assets.entries.find(entry => entry.referenceAssetId === reference.assetId);
      const baseLabel = (stored?.label ?? reference.role).replace(/[^\p{L}\p{N}_·-]/gu, "").slice(0, 36) ||
        ("素材" + (offset + 1));
      const label = usedLabels.has(baseLabel) ? baseLabel + "参考" + (offset + 1) : baseLabel;
      usedLabels.add(label);
      lines.push(label + "@图片" + (offset + 1) + "，对应已确认素材：" + reference.assetId);
    }
    }
    lines.push("参考资产绑定："+clip.referenceAssets.map(r=>r.role+"="+r.assetId).join("；"),
      "产品使用与硬约束："+truth.forbiddenChanges.filter(c=>c.severity === "HARD").map(c=>c.description).join("；"),
      "已确认使用规则："+(truth.usageRules??[]).filter(r=>r.status === "CONFIRMED").map(r=>r.statement).join("；"));
    const audioManifest:V8PromptPackage["audioManifest"]=[];
    const postProductionText:V8PromptPackage["postProductionText"]=[];
    for(const [shotIndex,segment] of clip.segments.entries()){
      const v8=segment.v8!;
      lines.push("",
        "【镜头 "+String(shotIndex+1).padStart(2,"0")+"】 "+
        formatSeconds(segment.endMs-segment.startMs)+"s"+
        "（"+formatSeconds(segment.startMs)+"–"+formatSeconds(segment.endMs)+"s）",
        "景别："+segment.shotSize+"；机位："+segment.cameraPosition+"；角度："+segment.cameraAngle,
        "运镜："+segment.cameraMovement,
        "构图、人物方位与焦点："+segment.composition,
        "画面："+segment.subjectAction,
        "衔接前："+segment.continuityIn.description+"；"+segment.continuityIn.environmentState,
        "衔接后："+segment.continuityOut.description+"；"+segment.continuityOut.environmentState,
        "光线："+segment.lighting);
      const speech=v8.spoken;
      if(speech){
        const voice=speakerBindings[speech.speaker];
        if(!voice || !names[speech.speaker]) {
          throw new DomainValidationError("V8 尚未明确分镜说话人身份与固定声线："+speech.speaker);
        }
        const actor=assets.entries.find(entry=>entry.key===voice.actorAssetKey && entry.status==="READY");
        if(speech.mode==="ONSCREEN" && (!actor ||
          !clip.referenceAssets.some(reference =>
            reference.role==="CHARACTER" && reference.assetId===actor.referenceAssetId))) {
          throw new DomainValidationError("V8 本镜开口说话的人物没有绑定当前视频编号的固定角色参考图："+speech.speaker);
        }
        const mode=speech.mode==="OS"?"角色闭口，内心声音":
          speech.mode==="OFFSCREEN"?"说话者画外继续，不让听者开口":"说话者明确开口并同步口型";
        lines.push("声音与台词：配音指令："+speech.speaker+"|"+voice.voiceType+"|"+
          speech.tone+"|"+speech.delivery,
          mode+"；"+speech.speaker+"：“"+speech.exactText+"”"+
            ((speech.sourcePartCount??1)>1
              ? "（同一句台词的第"+speech.sourcePartIndex+"/"+speech.sourcePartCount+"个连续语义段）" : ""));
        audioManifest.push({
          sourceShotId:v8.sourceShotId,speaker:speech.speaker,mode:speech.mode,
          exactText:speech.exactText,
          ...(speech.sourceLineText!==undefined?{
            sourceLineText:speech.sourceLineText,
            sourcePartIndex:speech.sourcePartIndex,
            sourcePartCount:speech.sourcePartCount
          }:{}),
          voiceType:voice.voiceType,delivery:speech.delivery
        });
      }else{
        lines.push("声音与台词：此镜无新增台词或旁白。");
      }
      lines.push("环境与交互音效："+
        (segment.ambientSound.kind==="AMBIENT"?segment.ambientSound.description:"不额外添加音效。"));
      if(v8.audienceKnowledgeChange)lines.push("观众此刻获得的信息："+v8.audienceKnowledgeChange);
      for(const cue of segment.postProductionText) {
        postProductionText.push({
          sourceShotId:v8.sourceShotId,startMs:cue.startMs,
          endMs:cue.endMs,kind:cue.kind,exactText:cue.text
        });
      }
    }
    lines.push("","【镜头承接和生成硬约束】",
      "严格保留上述镜头时序、说话者、原句和场景状态，不增删剧情。",
      "分镜时间用于指导生成，不保证模型逐帧准确执行；不符合时交由 Timeline 或局部重生成处理。",
      "后期文案和字幕另存，不要求视频模型渲染文字。"
    );
    const promptText=lines.join("\n");
    const maximum=input.maxPromptChars??12000;
    if(promptText.length>maximum){
      throw new DomainValidationError("V8 提示词超过所选接口可编辑长度，须先合理拆分视频编号，禁止直接截断关键台词。");
    }
    const base={
      version:"v8-authoritative-prompt-1" as const,
      clipId:clip.id,durationMs:clip.durationMs,
      scriptHash:script.contentHash,directorHash:decision.contentHash,
      productionPlanHash:plan.contentHash,
      sourceShotIds:decisionClip.shots.map(shot=>shot.shotId),
      ...(incoming ? { incomingContinuity: {
        sourceClipId:incoming.sourceClipId,relationship:incoming.relationship,
        plannedSourceEndStateHash:incoming.plannedSourceEndStateHash,
        plannedTargetStartStateHash:incoming.plannedTargetStartStateHash,
        contractHash:incoming.contentHash,
        requiresHardFirstFrame:incoming.requiresHardFirstFrame
      }} : {}),
      promptText,audioManifest,postProductionText
    };
    return {...base,contentHash:hashValue(base)};
  });
}
