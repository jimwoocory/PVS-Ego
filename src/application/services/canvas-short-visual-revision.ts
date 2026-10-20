import {randomUUID} from "node:crypto";
import {hashValue} from "../../domain/hashing.js";
import {scriptDraftSchema,productionPlanSchema} from "../../domain/schemas.js";
import {canvasShortVisualRevisionSchema} from "../../domain/canvas-short-visual-revision.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";

const seal=<T extends {contentHash?:string}>(v:T)=>{const {contentHash:_,...body}=v;return {...body,contentHash:hashValue(body)};};

/** A non-executable visual revision; old node, quote, approvals and cartoon references are never inherited. */
export function buildRealisticShortRevision(p:CanvasShortPlan){
  const visual="仿真人AI剧情广告。原创中国成年人物，真实人体比例、自然肤质和细微表情，真实家居布景、衣料与木材质感，柔和侧窗光和克制的影视摄影。人物通过对白、停顿、目光和动作推进情节，产品自然进入互动。";
  const limits="不使用二维动漫描线、赛璐璐平涂、Q版或3D玩偶质感；不套用旧二维人物和客厅图，不复制历史古装角色；本版保留现代父女题材。";
  const designs=[
    {key:"DAUGHTER" as const,label:"女儿｜26—30岁成年女性",description:"原创中国成年女性，深棕色侧分齐肩发，自然五官与皮肤纹理、淡妆；米杏色纯色长袖针织衫、深蓝长裤，上衣始终自然垂在裤腰外。生活化穿着。情绪从期待父亲接受，到被反问时短暂停顿，再放松地把决定权交给父亲。",
      consistency:["同一成年面容、发型、服装与上衣下摆穿法","每张参考图只出现同一个人，不把多视图拼成两个人","手部自然；不持产品，避免把生成的仿制枕头当身份参考"],
      draftPrompt:visual+" 现代成年女儿人物设定：26—30岁，深棕侧分齐肩发，米杏色纯色针织衫，深蓝长裤，上衣自然垂在裤腰外，单个人物，站姿三分之二身，干净中性背景，自然镜头焦段，表情克制。无产品、无文字、无拼接多视图。"+limits,state:"TEXT_DESIGN_PENDING_REVIEW" as const},
    {key:"FATHER" as const,label:"父亲｜58—65岁男性",description:"原创中国中老年男性，短灰发、无胡须，自然皱纹，精神清醒；藏蓝针织开衫、浅灰内搭、深灰长裤。保持自主、有主见的父亲形象。开始语气稍防备，随后认真看实物，最后主动索取资料。",
      consistency:["同一面容、短灰发、蓝色开衫和灰色内搭","只出现一位父亲，不拼接站坐多个人物","固定坐在客厅右侧同一把米灰布艺单椅上，椅子不另行生成进人物参考图"],
      draftPrompt:visual+" 现代父亲人物设定：58—65岁，短灰发，无胡须，自然面部皱纹，藏蓝针织开衫、浅灰内搭、深灰长裤，单个人物，三分之二身，中性背景，克制的平静表情，保持真实成年比例。不作病弱或疼痛表情，无产品、无椅子、无文字、无多视图拼接。"+limits,state:"TEXT_DESIGN_PENDING_REVIEW" as const},
    {key:"LIVING_ROOM" as const,label:"场景｜现代家庭客厅",description:"真实、整洁但有生活感的中国家庭客厅，米灰墙面、浅木矮桌，右后方固定一把米灰布艺扶手单椅，左侧留给女儿站立。左侧窗户柔和进光，右后落地灯辅助暖光；桌面留空，原产品在视频时按真实参考放入。",
      consistency:["父亲在右、女儿在左，镜头留在桌前同一侧，不越轴","全部镜头同一把布艺椅、同一张桌子、同一光线方向；不混入旧木椅","空场参考无人、无产品、无手机屏幕或可读广告文字；保留9:16拍摄空间"],
      draftPrompt:visual+" 现代中国家庭空客厅，竖屏9:16，浅木矮桌，右后方一把米灰布艺扶手单椅，左侧站立空地，米灰墙面；左窗柔和侧光，右后落地灯暖光，真实家具和织物，安静生活感。无人、无产品、无文字；不要额外木椅，不要拼贴多个场景。"+limits,state:"TEXT_DESIGN_PENDING_REVIEW" as const}
  ];
  const times=[[0,3000],[3000,8000],[8000,12000]],duration=[3000,5000,4000,3000];
  const actions=["女儿把完整枕头放到桌上，期待父亲收下；父亲没有接，抬眼反问，女儿笑容一顿。", "女儿收回催促的手，指向桌上完整产品，放缓语气；父亲目光转向枕头。", "父亲主动把枕头移到自己一侧，再伸手索取资料；女儿点头，将手机转向父亲，屏幕不生成可读文字。", "原产品主图与品牌、产品名及了解入口的3秒本地尾卡。"];
  const dialogue=["父亲：又替我选？","女儿：瑶药护颈枕。先看配方，再决定。","父亲：资料给我，我自己看。",""];
  const beats=actions.map((text,i)=>({id:randomUUID(),order:i+1,purpose:(["HOOK","PRODUCT","RESULT","CTA"] as const)[i]!,text:text+(dialogue[i]?" "+dialogue[i]:""),
    estimatedDurationMs:duration[i]!,requiredFactIds:p.payload.script.beats[i]?.requiredFactIds??[]}));
  const script=scriptDraftSchema.parse(seal({...p.payload.script,id:randomUUID(),version:p.payload.script.version+1,status:"DRAFT",confirmedAt:undefined,
    aiExecution:undefined,productionAssetSetRef:undefined,targetDurationMs:15000,beats}));
  const previous=p.payload.productionPlan,template=previous.scenes[0]!.clips[0]!,sceneId=randomUUID();
  const productState="使用原产品图的完整护颈枕，保持外形、比例、颜色、纹样和边缘结构；不拆解、不演示功效或使用后变化。";
  const state=(description:string)=>{const body={description,productState,environmentState:"同一现代客厅，父亲右侧米灰布艺椅、女儿左侧；同一产品与光线"};return {...body,stateHash:hashValue(body)};};
  const states=[state("女儿准备把产品放上桌，父亲坐在右侧，尚未接受。"),state("产品留在桌上，父亲刚反问，女儿收回催促的手。"),state("父亲已看向实物，女儿停止催促，等待他自己判断。"),state("父亲主动索取资料，女儿点头，产品完整留在父亲一侧；停住人物反应，不在云端生成尾卡。")];
  const segmentTemplate=template.segments[0]!;
  const segments=times.map(([startMs,endMs],i)=>({...segmentTemplate,id:randomUUID(),order:i+1,startMs,endMs,shotSize:["中景双人切父亲中近景","女儿过肩中近景，产品位于前景","双人中景，保留父亲索取资料和女儿反应"][i]!,
    cameraPosition:"桌前同一侧，父亲在右、女儿在左，保持对话轴线",cameraAngle:"自然平视，以人物表演为主",cameraMovement:"稳定机位，按人物反应切镜，不做环绕或炫技运动",composition:"人物和完整产品共享画面，留后期字幕安全区",
    subjectAction:actions[i]!,productState,lighting:"同一左窗柔和侧光，右后暖灯，真实肤质、布料和木材层次",
    dialogueOrNarration:{kind:"DIALOGUE" as const,text:dialogue[i]!,estimatedDurationMs:duration[i]!,estimatorVersion:"realistic-15s-native-speech-review-required"},
    ambientSound:{kind:"AMBIENT" as const,description:"自然室内底声、轻放枕头与衣料声，无背景音乐"},postProductionText:[],sourceBeatIds:[beats[i]!.id],requiredFactIds:beats[i]!.requiredFactIds,continuityIn:states[i]!,continuityOut:states[i+1]!}));
  const clip=seal({...template,id:randomUUID(),sceneId,order:1,durationMs:12000,purpose:"仿真人父女剧情：被替选的不满—先了解—主动索取资料",sourceBeatIds:beats.slice(0,3).map(b=>b.id),
    referenceAssets:template.referenceAssets.filter(a=>a.role==="PRIMARY_PRODUCT"),productVisibility:"CLEAR" as const,openingState:states[0]!,closingState:states[3]!,segments,
    riskAssessment:{level:"MEDIUM" as const,reasonCodes:["REALISTIC_CHARACTER_CONTINUITY","DIALOGUE_SPEAKER_BINDING","PRODUCT_IDENTITY"],mitigations:["先审核仿真人设定，再生成新的实际参考图并绑定","不得复用二维图或旧二维节点报价","检查对白、人物反应和原产品一致性"],source:"PRODUCT_DIRECTOR" as const},aggregateStatus:"PLANNED" as const});
  const plan=productionPlanSchema.parse(seal({...previous,id:randomUUID(),version:previous.version+1,status:"DRAFT",confirmedAt:undefined,aiExecution:undefined,productionAssetSetRef:undefined,
    scriptRef:{entityType:"ScriptDraft",entityId:script.id,version:script.version,hash:script.contentHash},visualDirection:visual+limits,
    soundDirection:"12秒生成原生普通话对白与自然环境/动作声；父亲为克制自然的中老年男声，女儿为自然成年女声；不生成BGM。说话者、口型和对白时长以实际视频审片为准。最后3秒为本地静态产品尾卡，不复用60秒版本的时长或TTS安排。",
    continuityLock:{product:{...previous.continuityLock.product,stableAttributes:[productState]},characters:designs.slice(0,2).map(d=>({name:d.key==="DAUGHTER"?"女儿":"父亲",stableAppearance:d.description,wardrobe:d.key==="DAUGHTER"?"米杏色针织衫自然垂在裤腰外、深蓝长裤":"藏蓝开衫、浅灰内搭、深灰长裤"})),environments:[{sceneId,stableElements:designs[2]!.consistency}]},
    scenes:[{...previous.scenes[0]!,id:sceneId,order:1,purpose:"父女交还选择权的仿真人短剧广告",location:"现代家庭客厅",visualState:designs[2]!.description,timeOfDay:"傍晚柔和侧光",sourceBeatIds:beats.slice(0,3).map(b=>b.id),requiredFactIds:[...new Set(beats.flatMap(b=>b.requiredFactIds))],clips:[clip]}]}));
  const product=p.payload.references.find(r=>r.key==="PRODUCT");if(!product)throw new Error("SHORT_PRODUCT_REFERENCE_MISSING");
  const payload={sourcePlanId:p.id,sourcePlanHash:p.contentHash,style:"REALISTIC_AI_SHORT_DRAMA",title:"爸，这次你来选｜仿真人短剧修订版",outputDurationMs:15000,generatedDurationMs:12000,localTailMs:3000,creditCeiling:72,budgetScope:"NEW_SETTING_IMAGES_AND_VIDEO",
    styleReference:{description:"已播放核对即梦10月13日贵族夫人与瑶寨医女的护颈枕13秒旧片，借鉴真人质感、生活化表演、摄影光线和产品互动。",sourceUrl:"https://jimeng.jianying.com/ai-tool/asset",historyDate:"10月13日",verification:"EXISTING_VIDEO_PLAYBACK_VERIFIED",use:"VISUAL_STYLE_ONLY"},
    visualDirection:visual+limits,audience:"给家人选枕头、希望先了解产品和配方信息再决定的人群。",productMessage:"明确产品名称为瑶药护颈枕，以查看枕形、配方与用法承接了解需求；不把资料中的成分名称推导成疗效，也不借用历史短剧的功效台词。",
    script,productionPlan:plan,designs,productReference:{artifactId:product.artifactId,sha256:product.sha256},excludedReferenceArtifactIds:p.payload.references.filter(r=>r.key!=="PRODUCT").map(r=>r.artifactId),
    draftVideoPrompt:visual+limits+" 12秒，9:16，720p；使用审核后的仿真人女儿、父亲、同一客厅与原产品图。"+segments.map((s,i)=>`${times[i]![0]!/1000}—${times[i]![1]!/1000}秒：${s.subjectAction}${s.dialogueOrNarration.text}`).join(" ")+" "+productState+" 自然普通话对白，无BGM；不生成可读字幕、手机文字或Logo，文字由后期添加。无治疗、止痛、助眠或改善颈椎等功效承诺，无使用前后效果对比。云端只生成12秒剧情，最后3秒本地尾卡独立处理。",
    tailCardText:p.payload.tailCardText,reviewChecklist:["是否采用仿真人影视质感与现代父女题材","父女的反问、女儿让步、父亲主动了解三个情节点是否清楚","两位人物的年龄、外观、衣着和表演是否合适","场景统一米灰布艺椅、桌子、人物站位与光线","产品信息和片尾文案是否准确；没有虚构功效","三张新设定图尚未生成，文字审核不等于图片采用或付费许可"],
    execution:{state:"PLANNING_ONLY",referenceBinding:"PENDING_NEW_REALISTIC_ASSETS",price:"REQUOTE_REQUIRED",imageGenerationAuthorized:false,videoGenerationAuthorized:false,publishAuthorized:false}};
  return canvasShortVisualRevisionSchema.parse({id:randomUUID(),contentHash:hashValue(payload),createdAt:new Date().toISOString(),status:"DRAFT",payload});
}
