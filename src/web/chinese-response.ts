import type { ServerResponse } from "node:http";
import { uiLabels, uiLabel, uiMessage, validationMessage } from "./zh-cn.js";

// All keys are display vocabulary. Protocol values and immutable user data never change.
Object.assign(uiLabels, {
  AUTO:"自动", MANUAL:"手动", FIXED:"固定", COMMAND_DEFAULT:"使用命令默认值", OFF:"关闭", ON:"开启",
  ENABLED:"已启用", DISABLED:"已停用", ABSENT:"未检测到", AVAILABLE:"可用", UNAVAILABLE:"不可用",
  NOT_APPLICABLE:"不适用", UNSPECIFIED:"未指定", PRESENT:"已检测到", PROVIDED:"已提供",
  VISION:"图片理解", AUDIO:"音频", VIDEO:"视频", TEXT:"文本", IMAGE:"图片", SPEECH:"语音",
  SOURCE_ONLY:"仅保留原始声音", SOURCE_OR_LOCAL_TTS:"原始声音或本地语音合成", LOCAL_TTS:"本地语音合成",
  NATIVE:"保留原生声音", SILENT:"静音", BGM:"背景音乐", SFX:"音效", OS:"画外音", OFFSCREEN:"画外音", ONSCREEN:"画内对白",
  INT:"室内", EXT:"室外", DAY:"白天", NIGHT:"夜晚", OPEN:"开放", CLOSED:"关闭",
  SOURCE:"来源", REFERENCE:"参考", USER_UPLOAD:"用户上传", GENERATED:"系统生成", EXTERNAL:"外部来源",
  PLANNING:"规划中", QUEUED:"排队中", RUNNING:"执行中", CANCELLED:"已取消", EXPIRED:"已过期",
  APPROVING:"正在确认授权", APPROVED:"已授权", AUTHORIZED:"已授权", AWAITING_USER_ACTION:"等待你处理",
  NEEDS_USER:"需要你处理", NEEDS_USER_SELECTION:"需要你选择", REVIEW_READY:"已准备好审核",
  REVIEW_REQUIRED:"需要人工复核", REVIEWABLE:"可审核", REVIEW:"审核", REVISE:"需要修改", REJECT:"拒绝",
  BLOCK:"阻止继续", BLOCKER:"必须先处理", WARN:"警告", WARNING:"注意", INFO:"说明", SKIPPED:"已跳过",
  ANALYSIS_FAILED:"分析失败", CONFLICT:"存在冲突", MATCH:"一致", MISMATCH:"不一致", DUPLICATE:"重复",
  NOT_SUBMITTED:"尚未提交", SUBMISSION_UNKNOWN:"提交结果未知", WAITING_FOR_USER:"等待你确认",
  READY_FOR_ASSET_PAID_CONFIRM:"参考图生成方案已准备，等待费用确认", READY_FOR_PAID_CONFIRM:"等待视频生成费用确认",
  ASSET_PREPARING:"正在准备制作资产", PRODUCTION_PLANNING:"正在规划制作", AUTO_EDITING:"自动剪辑中",
  READY_TO_ASSEMBLE:"待制作成片", READY_TO_GENERATE:"待生成", READY_TO_PUBLISH:"待发布",
  PRODUCT_TRUTH_REVIEW:"待确认产品事实", CREATIVE_REVIEW:"待选择创意", SCRIPT_REVIEW:"待确认脚本",
  DIRECTOR_REVIEW:"待确认导演计划", GENERATION_REVIEW:"待审片", FINAL_REVIEW:"待确认成片",
  PRODUCT_INPUT:"产品资料", PRODUCT_STATE:"产品状态", CREATIVE:"创意", SCRIPT:"脚本", DIRECTOR:"导演计划",
  PRODUCTION_ASSETS:"制作资产", ASSET_PREP:"制作资产准备", PREFLIGHT:"生成前检查", APPROVAL:"生成授权",
  GENERATION:"视频生成", GENERATION_ATTEMPT:"生成任务", CLIP_REVIEW:"视频审片", AUTO_EDIT:"自动剪辑",
  RENDER:"生成成片", PUBLISH:"发布", RESEARCH:"参考研究", SMART_RUN:"一键成片任务", AGENT:"视频创作助手",
  TIMELINE:"剪辑时间线", PROJECT:"项目", PROVIDER:"服务提供方", REQUEST:"生成请求", PROMPT:"提示词",
  DATABASE:"数据库", MEDIA:"媒体文件", LEGAL:"合规要求", SOURCES:"资料来源", LABEL:"标注",
  UPLOAD:"上传", EDIT:"编辑", RESUME:"继续执行", CONFIRM_PLAN:"确认导演计划", CONFIRM_SCRIPT:"确认脚本",
  SELECT_CREATIVE:"选择创意", REMOVE:"移除", INCLUDE:"纳入", IGNORE:"忽略", FREE:"免费",
  DIRECT:"直接", HANDOFF:"交接", PAID_OR_EXTERNAL:"需要费用或外部服务", FILE_PLAYABLE:"视频可播放",
  HARD_CONTINUITY:"强连续：必须承接上一片段", SAME_SCENE_CUT:"同场景切换机位", SCENE_OR_TIME_JUMP:"场景或时间跳转",
  FIRST_FRAME:"专用首帧", LAST_FRAME:"尾帧", REFERENCE_IMAGE:"普通参考图片", KEYFRAME:"关键帧",
  INFER_FROM_FIRST_FRAME:"根据首帧推断", CONTINUITY_DEPENDENCY:"连续性依赖", REUSE_EXISTING_REFERENCE:"复用已有参考图",
  REUSE_PRODUCT_REFERENCE:"复用产品参考图", GENERATE_IMAGE:"生成参考图", DREAMINA_GENERATED:"即梦生成",
  NO_PRODUCT:"不展示产品", OTHER_PRODUCT:"其他产品", SINGLE_CLIP:"单片段", MULTI_CLIP:"多片段",
  SHORT_DRAMA:"短剧情", PRODUCT_DEMO:"产品演示", UGC:"用户视角分享", FUNCTION_EFFECT:"功能与效果",
  ESTABLISH:"交代场景", CONTEXT:"补充背景", ACTION:"呈现动作", REACTION:"呈现反应", HOST:"主持讲解",
  PRODUCT_ANGLE:"产品外观与角度", WEARING_REFERENCE:"佩戴位置参考", USAGE_ACTION_REFERENCE:"使用动作参考",
  SCENE_REFERENCE:"场景参考", LOGO_REFERENCE:"包装与品牌标识参考", APPEARANCE:"产品外观", ANGLE:"角度",
  WEARING:"佩戴方式", USAGE:"使用方法", DETAIL:"产品细节", SCENE:"场景", PACKAGING_LOGO:"包装与品牌标识", VIDEO_FRAME:"视频抽帧",
  PROP:"道具", SET:"场景布置", MUST:"必须遵守", MUST_NOT:"禁止出现", PRECAUTION:"注意事项", LIMITATION:"使用限制",
  UNCERTAIN:"尚不确定", PUBLIC_UNVERIFIED:"公开来源，尚未核实", DECLARED_OFFICIAL:"来源自称官方", TRUSTED:"已核实来源", UNTRUSTED:"来源尚未核实",
  STRUCTURE_AND_METHOD_ONLY:"仅参考结构与方法", STRUCTURE_ONLY_NOT_PRODUCT_FACTS:"仅参考叙事结构，不作为产品事实",
  AUTO_DISCOVERY:"自动发现", PENDING_DISCOVERY:"等待发现", AUTH_REQUIRED:"需要账号授权",
  MATCHED:"账号已匹配", MISMATCHED:"账号不匹配", BOUND:"已关联", NEEDS_BINDING:"需要关联作品",
  POSITIVE:"正面", NEUTRAL:"中性", NEGATIVE:"负面", MIXED:"褒贬混合", PURCHASE_INTENT:"购买意向",
  PRODUCT_QUESTION:"产品提问", USAGE_FEEDBACK:"使用反馈", PRAISE:"赞扬", COMPLAINT:"投诉或不满",
  GENERAL_INTERACTION:"普通互动", SPAM_OR_IRRELEVANT:"无关或垃圾评论", ANSWER_QUESTION:"回答问题",
  ACKNOWLEDGE_FEEDBACK:"回应反馈", THANK_AND_ENGAGE:"感谢并互动", DEESCALATE:"平和回应", CLARIFY_WITHOUT_CLAIMING:"保守澄清",
  POSTED:"已发送", REPLY_POSTED_CONFIRMED:"回复已确认发送", PUBLISHED_CONFIRMED:"已确认发布",
  BLOCKED_ACCOUNT_MISMATCH:"账号不匹配，已阻止", DIRECT_PUBLISHING:"正在直接发布",
  HANDOFF_STARTED:"已开始交接", HANDOFF_COMPLETED:"交接已完成", PACKAGE_READY:"发布包已准备", PACKAGE_CLAIMED:"发布包已领取",
  DOUYIN_BROWSER_AUTOMATION:"抖音浏览器自动发布", DOUYIN_H5_HANDOFF:"抖音手机网页交接",
  DOUYIN_SDK_HANDOFF:"抖音官方应用交接", DOUYIN_OPENAPI_DIRECT:"抖音官方接口直发", MANUAL_EXPORT:"下载后手动发布",
  CUT:"直接切换", FADE:"淡入淡出", CROSSFADE:"交叉叠化", CENTER:"居中", TOP:"顶部", BOTTOM:"底部",
  CAPTION:"字幕", TEXT_SAFE_AREA:"文字安全区域", AUDIO_STREAM:"音轨", ASPECT_RATIO:"画面比例", RESOLUTION:"分辨率", DURATION:"时长",
  BLURRY:"画面模糊", BLACK:"黑色", BLACK_FRAMES:"黑帧", FREEZE_FRAMES:"画面卡住", LONG_SILENCE:"长时间无声",
  TEXT_INTEGRITY:"文字完整性", ARTIFACT_INTEGRITY:"文件完整性", AUDIO_INTENT_MISSING:"声音意图未明确",
  BEAT_ACTION_OVERLOAD:"段落动作过多", BEAT_SPEECH_OVERLOAD:"段落对白过长", BEAT_DURATION_IDLE:"段落留空过长",
  BEAT_DURATION_UNIFORM:"段落时长过于平均", DURATION_OVERLOAD:"内容超出时长", ACTION_DENSITY_HIGH:"动作密度过高",
  PRODUCT_STATE_DENSITY_HIGH:"产品状态变化过密", SCENE_DENSITY_HIGH:"场景变化过密", TOO_MANY_BEATS:"剧情段落过多",
  NARRATIVE_DESCRIPTION_THIN:"叙事信息不足", NARRATIVE_DUPLICATE_BEAT:"剧情段落重复", NARRATIVE_TRANSITION_UNCLEAR:"剧情转折不清晰",
  DRAFT_NEEDS_VISUAL_DIRECTING:"草稿仍需视觉导演规划", EDITING_INSTRUCTION_IN_STORY:"故事中混入剪辑指令",
  BURNED_TEXT_INSTRUCTION:"存在直接生成画面文字的指令", AI_VISUAL_GATE:"智能视觉审查", STDOUT:"标准输出", STDERR:"错误输出",
  USER_INPUT:"用户素材", STRUCTURED_SNAPSHOT:"结构化快照", GENERATED_VIDEO:"生成视频", FINAL_VIDEO:"最终成片", PROVIDER_RESULT:"服务返回结果",
  api:"接口", required:"必填", optional:"可选", true:"是", false:"否"
  ,WAITING:"等待中", WAITING_FOR_TRUTH:"等待产品事实", WAITING_FOR_TRUTH_REVIEW:"等待确认产品事实",
  WAITING_FOR_CREATIVE_REVIEW:"等待选择创意", WAITING_FOR_SCRIPT_REVIEW:"等待确认脚本",
  WAITING_FOR_DIRECTOR_REVIEW:"等待确认导演计划", WAITING_FOR_PLAN_REVIEW:"等待确认制作计划",
  WAITING_FOR_PROMPT_REVIEW:"等待审核提示词", WAITING_FOR_REFERENCE_REVIEW:"等待审核参考素材",
  WAITING_FOR_ASSET_REVIEW:"等待审核制作资产", WAITING_FOR_AUDIO:"等待音频准备", WAITING_FOR_CLIP_REVIEW:"等待审片",
  USER_CONFIRMED:"用户已确认", USER_CREATED:"用户创建", USER_RESUMED:"用户恢复", USER_SUPPLIED:"用户提供",
  USER_OVERRIDE:"用户手动调整", USER:"用户", WHITE:"白色", VIDEO_STREAM:"视频画面", VISUAL_PRODUCT_IDENTITY:"产品外观一致性",
  USAGE_SCENARIO:"使用场景", USAGE_METHOD:"使用方法", WEARING_POSITION:"佩戴位置",
  text:"文本", vision:"图片理解", audio:"音频", video:"视频", image:"图片", url:"链接",
  multimodal2video:"多模态参考生成", text2video:"文生视频", image2video:"图生视频", frames2video:"首尾帧生成",
  firstFrame2video:"专用首帧生成", generateAudio:"生成原生声音", duration:"时长"
});

export const uiPhrases: Array<[string, string]> = [
  ["Product Video Studio", "产品视频工作台"], ["Product Truth Review", "产品事实审核"],
  ["Director / Clip Planner", "导演与分镜规划"], ["Generate / Task Monitor", "视频生成与任务进度"],
  ["Creative Selection", "创意选择"], ["Script Review", "脚本审核"], ["Final Video / Publish", "成片与发布"],
  ["Prompt Inspector", "提示词检查"], ["Product Truth", "产品事实"], ["ProductTruth", "产品事实"],
  ["Production Plan", "导演计划"], ["ProductionPlan", "导演计划"], ["CreativeBatch", "创意方案"],
  ["ProductFact IDs", "产品事实标识"], ["ProductFact", "已确认的产品事实"], ["ForbiddenChange", "禁止修改项"],
  ["UncertainClaim", "待核实信息"], ["CompiledPrompt", "编译后的生成提示词"], ["GenerationAttempt", "生成任务"],
  ["GenerationRequest", "生成请求"], ["WorkflowBlocker", "需要处理的问题"], ["Canonical image", "标准参考图"],
  ["Continuity In", "镜头开始状态"], ["Continuity Out", "镜头结束状态"], ["Product Input", "产品资料"],
  ["Shot-first", "优先规划镜头"], ["OpenAI-compatible", "OpenAI 兼容接口"], ["OpenAI Compatible", "OpenAI 兼容接口"],
  ["Dreamina CLI", "即梦命令行工具"], ["dreamina CLI", "即梦命令行工具"], ["AI Provider", "智能模型服务"],
  ["Provider", "服务提供方"], ["Preflight", "生成前检查"], ["Approval", "生成授权"], ["Attempt", "生成任务"],
  ["Request", "生成请求"], ["Script", "脚本"], ["Director", "导演"], ["Prompt", "提示词"],
  ["Scene", "场景"], ["Clip", "视频片段"], ["Segments", "镜头段落数"], ["Segment", "镜头段落"], ["Beat", "剧情段落"],
  ["Purpose", "段落用途"], ["Bridge", "浏览器连接服务"], ["CLI", "命令行工具"], ["QA", "质量检查"],
  ["QC", "质量检查"], ["BGM", "背景音乐"], ["SFX", "音效"], ["OS", "画外音"], ["Agent", "创作助手"],
  ["Logo", "品牌标识"], ["Timeline", "剪辑时间线"], ["Artifact", "文件记录"], ["Creative", "创意"], ["Truth", "产品事实"],
  ["factMapping", "产品事实对应关系"], ["segmentMapping", "镜头段落对应关系"], ["constraintMapping", "禁改项对应关系"],
  ["startMs", "开始时间（毫秒）"], ["endMs", "结束时间（毫秒）"], ["facts:", "引用事实："], ["Facts:", "引用事实："],
  ["models:", "支持模型："], ["operations:", "支持操作："], ["blockers:", "阻止继续的原因："], ["warnings:", "注意事项："],
  ["HIGH", "高风险"], ["MEDIUM", "中等风险"], ["LOW", "低风险"]
];

export function translateUiText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (uiLabels[trimmed]) return value.replace(trimmed, uiLabels[trimmed]!);
  let result = value;
  for (const [english, chinese] of uiPhrases) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g"), chinese);
  }
  result = result.replace(/\b[A-Z][A-Z_]{2,}\b/g, word => uiLabels[word] ?? word);
  result = result.replace(/(\d(?:\.\d+)?)ms\b/g, "$1 毫秒").replace(/(\d(?:\.\d+)?)s\b/g, "$1 秒");
  return result;
}

/** A tiny HTML text tokenizer, not a regex replacement across application code. */
export function localizeWorkbenchHtml(html: string): string {
  const protectedTags = new Set(["script", "style", "textarea", "pre", "code"]);
  const stack: string[] = [];
  let output = "", position = 0;
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const text = html.slice(position, match.index);
    output += stack.some(tag => protectedTags.has(tag)) ? text : translateUiText(text);
    let token = match[0];
    const tagMatch = token.match(/^<(\/?)\s*([A-Za-z][\w:-]*)/);
    if (tagMatch) {
      const tag = tagMatch[2]!.toLowerCase();
      if (!tagMatch[1]) {
        if (!stack.some(item => protectedTags.has(item))) {
          token = token.replace(/\b(placeholder|aria-label|title|alt)=("([^"]*)"|'([^']*)')/g,
            (_whole, key, quoted, doubleValue, singleValue) => `${key}=${quoted[0]}${translateUiText(doubleValue ?? singleValue)}${quoted[0]}`);
        }
        if (!/\/>$/.test(token) && !["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"].includes(tag)) stack.push(tag);
      } else {
        const index = stack.lastIndexOf(tag);
        if (index >= 0) stack.splice(index);
      }
    }
    output += token; position = tokens.lastIndex;
  }
  output += stack.some(tag => protectedTags.has(tag)) ? html.slice(position) : translateUiText(html.slice(position));
  if (!/<html\b/i.test(output) || output.includes('data-pvs-locale="zh-CN"')) return output;
  const serialized = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const script = `<script data-pvs-locale="zh-CN">(()=>{const uiLabels=${serialized(uiLabels)},uiPhrases=${serialized(uiPhrases)};${translateUiText.toString()}
const skip='script,style,textarea,pre,code,[data-pvs-preserve-text]';
function update(root){if(root.nodeType===3){if(!root.parentElement?.closest(skip)){const next=translateUiText(root.nodeValue||'');if(next!==root.nodeValue)root.nodeValue=next;}return;}
if(root.nodeType!==1||root.closest(skip))return;
const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);nodes.forEach(update);
for(const element of [root,...root.querySelectorAll('[placeholder],[aria-label],[title],[alt]')]){if(element.closest(skip))continue;for(const key of ['placeholder','aria-label','title','alt']){const current=element.getAttribute(key);if(current){const next=translateUiText(current);if(next!==current)element.setAttribute(key,next);}}}}
const alertOriginal=window.alert.bind(window),confirmOriginal=window.confirm.bind(window);window.alert=message=>alertOriginal(translateUiText(String(message)));window.confirm=message=>confirmOriginal(translateUiText(String(message)));
function start(){update(document.documentElement);new MutationObserver(records=>{for(const record of records){if(record.type==='characterData')update(record.target);else record.addedNodes.forEach(update);}}).observe(document.documentElement,{childList:true,characterData:true,subtree:true});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();</script>`;
  return output.replace(/<\/body>/i, script + "</body>");
}

/** Covers every HTML/failed-JSON handler, including the independently mounted feature routes. */
export function installChineseResponse(res: ServerResponse): void {
  let writtenContentType = "";
  const writeHead = res.writeHead.bind(res) as (...args: any[]) => ServerResponse;
  res.writeHead = ((status: number, ...args: any[]) => {
    const headers = typeof args[0] === "string" ? args[1] : args[0];
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === "content-type") writtenContentType = String(headers[i + 1]);
    } else if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === "content-type") writtenContentType = String(value);
    }
    return writeHead(status, ...args);
  }) as typeof res.writeHead;
  const finish = res.end.bind(res) as (...args: any[]) => ServerResponse;
  res.end = ((chunk?: any, ...args: any[]) => {
    const contentType = String(res.getHeader("content-type") ?? writtenContentType);
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      if (contentType.includes("text/html")) chunk = localizeWorkbenchHtml(String(chunk));
      else if (contentType.includes("application/json") && res.statusCode >= 400) {
        try {
          const value = JSON.parse(String(chunk));
          if (value && typeof value === "object" && value.jsonrpc !== "2.0") {
            value.message = uiMessage(value.message ?? value.error);
            chunk = JSON.stringify(value);
          }
        } catch { /* Preserve a non-JSON error body exactly. */ }
      }
    }
    return finish(chunk, ...args);
  }) as typeof res.end;
}

export { uiLabel, uiMessage, validationMessage };
