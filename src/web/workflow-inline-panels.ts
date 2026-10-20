import { douyinResearchPreflightControls } from "./douyin-research-preflight-ui.js";
import type { ProjectWorkspace } from "../application/services/product-flow.js";
import type { ProductInputSnapshot } from "../application/ports/product-input-store.js";
import type { SmartGenerationRun } from "../domain/smart-generation.js";
import type { GenerationAttempt, ReviewDecision, ReferenceVideoProfile, ArtifactRecord, Clip } from "../domain/schemas.js";
import type { ResearchService } from "../application/services/research-service.js";
import type { ReferencePageData } from "./creative-reference-ui.js";
import type { FinalAssembly } from "../application/ports/final-output-repository.js";
import type { FinalQcReport } from "../domain/final-qc.js";
import type { VisualReviewReadSummary } from "../application/services/visual-edit-assessment.js";

export type WorkflowInlineData = {
  workspace: ProjectWorkspace;
  productInput?: ProductInputSnapshot | null;
  run?: SmartGenerationRun;
  attempts?: GenerationAttempt[];
  artifacts?: ArtifactRecord[];
  decisions?: ReviewDecision[];
  visualSummaries?: VisualReviewReadSummary[];
  referenceData?: ReferencePageData;
  research?: Awaited<ReturnType<ResearchService["pageData"]>>;
  referenceVideo?: ReferenceVideoProfile | null;
  referenceVideoPreviewArtifactId?: string;
  finalAssembly?: FinalAssembly | null;
  finalQc?: FinalQcReport | null;
};
const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const route=(pid:string,path:string)=>"/projects/"+encodeURIComponent(pid)+"/"+path;
const media=(artifactId:string)=>"/api/artifacts/"+encodeURIComponent(artifactId)+"/content";
const kinds:Record<string,string>={PRODUCT_ANGLE:"产品多角度",WEARING_REFERENCE:"佩戴位置",USAGE_ACTION_REFERENCE:"使用动作",SCENE_REFERENCE:"场景",LOGO_REFERENCE:"品牌标志"};
function empty(text:string):string{return '<p class="ux-hint">'+esc(text)+'</p>';}
function renderTruth(input:WorkflowInlineData):string{
 const {workspace}=input,truth=workspace.productTruth,pid=workspace.project.id;
 if(!truth)return '<section class="ux-native-review" id="ux-truth-review"><h3>产品事实 · 等待资料</h3>'
   +empty("尚无产品事实草稿。请先检查产品资料和图片，生成可确认的事实后回到本任务。")
   +'<a class="ux-expert-link" href="'+route(pid,"truth")+'">高级：打开完整事实审核页</a></section>';
 const canonical=input.productInput?.assets.find(item=>item.id===truth.canonicalImageId);
 const canonicalReady=(input.artifacts??[]).some(item=>item.id===canonical?.artifactId&&item.projectId===pid&&item.integrityStatus==="READY"&&item.mimeType?.startsWith("image/"));
 const imagePreview=canonicalReady&&canonical?.artifactId
   ? '<img loading="lazy" alt="已上传的产品主参考图" style="display:block;max-width:290px;width:100%;max-height:270px;object-fit:contain;border:1px solid #dbe3ed;border-radius:10px;background:#f7f9fc" src="'+media(canonical.artifactId)+'">'
   : '<p class="ux-hint">当前产品主参考图尚不可预览，请检查已上传的素材。</p>';
 const researchStatus=input.research?.brief?.status==="READY"?"已有可查的研究报告":input.research?.latestRun?.status==="BLOCKED"?"研究暂不可用，可跳过可选研究":"没有研究报告或已跳过研究";
 const facts=[...truth.confirmedFeatures,...truth.sellingPoints].map(f=>'<li>'+esc(f.statement)+'</li>').join("");
 const claims=truth.uncertainClaims.filter(c=>!c.dispositionConfirmedByUser).map(c=>
   '<label class="ux-fact-row"><span>'+esc(c.statement)+'</span><small>'+esc(c.reason)+'</small><select data-inline-claim="'+esc(c.id)+'"><option value="KEEP_UNVERIFIED">保留未验证</option><option value="REJECT">拒绝该说法</option><option value="PROMOTE">我确认属实，提升为事实</option></select></label>').join("");
 const rules=(truth.usageRules??[]).filter(c=>!c.dispositionConfirmedByUser).map(c=>
   '<label class="ux-fact-row"><span>'+esc(c.statement)+'</span><select data-inline-usage="'+esc(c.id)+'"><option value="KEEP_UNVERIFIED">暂不确认</option><option value="REJECT">拒绝该规则</option><option value="CONFIRM">确认作为使用约束</option></select></label>').join("");
 return '<section class="ux-native-review" id="ux-truth-review" data-state="'+esc(truth.status)+'"><h3>产品事实 · '+esc(truth.status==="DRAFT"?"待确认":"已确认")+'</h3>'
    +'<p class="ux-hint">只批准有来源的真实卖点，未经核对的竞品内容不会被直接采用。</p>'
    +'<p><b>'+esc(truth.productName)+'</b> · 事实版本 v'+truth.version+' · '+esc(researchStatus)+'</p>'
    +'<p class="ux-hint">产品主参考图（身份基准）</p>'+imagePreview
    +'<details><summary>当前可靠事实（'+(truth.confirmedFeatures.length+truth.sellingPoints.length)+' 条）</summary><ul>'+facts+'</ul></details>'
    +(claims||rules?claims+rules:empty("暂无需要逐项处理的不确定事实或使用规则。"))
    +(truth.status==="DRAFT"?'<p><button type="button" data-inline-action="truth-confirm" class="ux-confirm-action">确认上述产品事实，继续原任务</button></p>':empty("事实已确认，等待原任务自动继续。"))
    +'<p><a href="'+route(pid,"truth")+'" class="ux-expert-link">高级：打开完整事实审核页</a></p><p class="ux-inline-error" role="alert"></p></section>';
}
/** Identical per-clip audit/preview for V3 Prompt cards and other workflows.
 * Uses exact ClipId/Attempt/Artifact references, not array-index guesses.
 */
function renderClipReviewRow(input:WorkflowInlineData,clip:Clip,i:number):string{
 const pid=input.workspace.project.id;
   const candidates=(input.attempts??[]).filter(a=>a.clipId===clip.id&&["SUCCEEDED","RECONCILED_SUCCEEDED"].includes(a.status)&&a.outputArtifactId).sort((a,b)=>b.attemptNumber-a.attemptNumber);
   const latest=candidates[0];
   const verifiedArtifact=latest?.outputArtifactId ? (input.artifacts??[]).find(a=>a.id===latest.outputArtifactId&&a.projectId===pid&&a.integrityStatus==="READY"&&a.mimeType==="video/mp4") : undefined;
   const accepted=(input.decisions??[]).filter(d=>d.clipId===clip.id).sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt))[0];
   const acceptedCurrent=accepted?.decision==="ACCEPT"&&accepted.generationAttemptId===latest?.id&&accepted.clipHash===clip.contentHash;
   const note=acceptedCurrent?"已采用":accepted?.decision==="STALE"?"上游镜头已变化，需要重新审核并处理":accepted?.decision==="SKIP"?"已跳过":verifiedArtifact?"待人工审核":latest?"候选文件尚不可用":"暂无已完成候选";
   const visual=input.visualSummaries?.find(v=>v.clipId===clip.id && v.attemptId===latest?.id);
   const expected={NONE:"纯剧情：产品不需要出镜",PARTIAL:"部分展示产品",CLEAR:"清晰展示产品",HERO:"产品主视觉重点展示"}[clip.productVisibility];
   const visualState=!visual?"尚未进行视觉质检"
     :visual.status==="OUTDATED"?"历史质检结果已失效，需要重新检查"
     :visual.status==="PASS"?"视觉抽帧通过；声音与跨镜叙事仍待核对"
     :visual.status==="BLOCKED"?"视觉抽帧发现问题，必须人工复核"
     :"视觉证据不充分，需要人工复核";
   const identity=visual?.productIdentity==="NOT_APPLICABLE"
     ?"产品身份／稳定性：不适用（剧情镜头无产品）"
     :visual?.status==="OUTDATED"?"此镜头暂无有效的产品身份质检结果"
     :visual?.productIdentity?"产品身份："+({PASS:"已初步确认",BLOCKED:"不合格",UNCERTAIN:"无法确认"}[visual.productIdentity]??"待核验")
     :"身份与稳定性尚待检测";
   const storyNote=visual?.storyActionAlignment === "PASS" ? "可见主要动作初步符合分镜"
     :visual?.storyActionAlignment === "BLOCKED" ? "可见动作与分镜有明确冲突"
     :visual?.storyActionAlignment === "UNCERTAIN" ? "无法通过抽帧确认动作完成情况"
     :"动作匹配未按新版审核";
   const audioNote=visual?.audioTrackPresent===true?"已发现音频轨（未验证台词及音效）"
     :visual?.audioTrackPresent===false?"本片段未检测到音频轨（需核查原生声音）"
     :"音频和对白尚未审核";
   return '<article class="ux-clip-card" id="ux-clip-'+(i+1)+'" tabindex="-1" data-ux-clip="'+esc(clip.id)+'"><h4>镜头 '+(i+1)+' · '+esc(clip.purpose)+'</h4><p class="ux-hint">预计时长 '+Math.round(clip.durationMs/1000)+' 秒 · '+note+'</p>'
     +'<p class="ux-hint">产品出镜要求：'+esc(expected)+' · <b data-visual-status="'+esc(visual?.status??"NOT_RUN")+'">'+esc(visualState)+'</b></p>'
     +'<p class="ux-hint">'+esc(identity)+'；'+esc(storyNote)+'；'+esc(audioNote)+'。人物对白与剧情连续性需要播放后确认。</p>'
     +(latest&&verifiedArtifact?('<video controls preload="metadata" playsinline src="'+media(verifiedArtifact.id)+'" style="width:100%;max-height:310px;background:#101b2a;border-radius:9px"></video>'
       +'<p class="ux-hint">视频候选版本 '+latest.attemptNumber+' · 需检查产品身份、动作与声音。旧版本保留。</p>'
       +(accepted?.decision==="STALE"
         ? '<p class="ux-hint">当前结果已因连续性依赖失效，必须等待上游镜头重新生成后再审核。</p>'
         : '<div class="ux-inline-actions"><button type="button" data-inline-action="clip-decision" data-decision="ACCEPT" data-clip="'+esc(clip.id)+'" data-attempt="'+esc(latest.id)+'">采用镜头</button>'
         +'<button class="secondary" type="button" data-inline-action="clip-decision" data-decision="REDO" data-clip="'+esc(clip.id)+'" data-attempt="'+esc(latest.id)+'">仅重做此镜头</button></div>'))
       :'<p class="ux-hint">请先完成当前镜头生成或恢复原提交结果；不会自动付费重试。</p>')
     +'<p><button class="secondary" type="button" data-inline-action="clip-decision" data-decision="SKIP" data-clip="'+esc(clip.id)+'">明确跳过此镜头</button></p></article>';
 }
function renderClips(input:WorkflowInlineData):string{
 const pid=input.workspace.project.id,plan=input.run?.productionPlan??input.workspace.productionPlan;
 const clips=plan?.scenes.flatMap(s=>s.clips)??[];
 if(!clips.length)return '<section class="ux-native-review" id="ux-clips-review"><h3>镜头审片</h3>'+empty("当前暂无可核对的导演镜头；请检查正式分镜版本。")+'<a href="'+route(pid,"generate")+'">前往完整生成记录</a></section>';
 const rows=clips.map((clip,i)=>renderClipReviewRow(input,clip,i)).join("");
 return '<section class="ux-native-review" id="ux-clips-review"><h3>本轮镜头审片</h3><p class="ux-hint">逐个检查画面、产品出镜要求与可用视频。产品不需出现的剧情镜头不会因为没有产品而扣分；有产品镜头必须与确认主图一致。视觉抽帧结果不代表对白、环境声或跨镜叙事已通过。</p>'
   +(input.run?.blocker?.code==="VISUAL_REVIEW_REQUIRED"
      ? '<p class="ux-inline-error">自动视觉检查未全部达到采用标准。请逐一播放下列视频，或使用工作台上的重新检测入口；不会自动重新生成视频。</p>'
      : '')
   +'<div class="ux-clip-list">'+rows+'</div><p><button type="button" data-inline-action="clip-finalize" class="secondary">完成本轮已采用镜头的选择</button></p>'
   +'<a class="ux-expert-link" href="'+route(pid,"generate")+'?fromSmartRun='+encodeURIComponent(input.run?.id??"")+'">高级：打开生成与多版本审核页</a><p class="ux-inline-error" role="alert"></p></section>';
}
/**
 * Mount the SAME current-generation review card inside the corresponding
 * Seedance Prompt. A missing ClipId is never silently paired with a different
 * video; the user gets an explicit mismatch warning instead.
 */
export function renderClipReviewForPrompt(input:WorkflowInlineData,clipId:string):string {
 const clips=(input.run?.productionPlan??input.workspace.productionPlan)?.scenes.flatMap(s=>s.clips)??[];
 const index=clips.findIndex(clip=>clip.id===clipId);
 if(index<0)return '<section class="ux-native-review ux-v3-prompt-review"><p class="ux-inline-error">当前提示词对应的正式分镜不存在，无法安全绑定视频；请核查分镜版本。</p></section>';
 const clip=clips[index]!;
 return '<section class="ux-native-review ux-v3-prompt-review" data-review-for="'+esc(clip.id)+'">'
   +renderClipReviewRow(input,clip,index)
   +'<p class="ux-inline-error" role="alert"></p></section>';
}

/** Manual finalize stays inside the V3 video/Prompt area, not above scripts. */
export function renderClipReviewFinalization(input:WorkflowInlineData):string {
 const clips=(input.run?.productionPlan??input.workspace.productionPlan)?.scenes.flatMap(s=>s.clips)??[];
 return '<section class="ux-native-review ux-v3-prompt-finalize" id="ux-clips-review">'
   +'<h4>完成当前镜头选择</h4>'
   +'<p class="ux-hint">本轮'+clips.length+'条镜头需要检查实际画面和声音。确定采用或跳过后再准备剪辑；未确认的镜头不会被视为通过。</p>'
   +'<button type="button" data-inline-action="clip-finalize" class="secondary">完成本轮已采用镜头的选择</button>'
   +'<a class="ux-expert-link" href="'+route(input.workspace.project.id,"generate")+'?fromSmartRun='+encodeURIComponent(input.run?.id??"")+'">高级：查看生成与多版本记录</a>'
   +'<p class="ux-inline-error" role="alert"></p></section>';
}

function renderFinal(input:WorkflowInlineData):string{
 const pid=input.workspace.project.id,assembly=input.finalAssembly,qc=input.finalQc;
 const mediaReady=assembly?.outputArtifactId ? (input.artifacts??[]).find(a=>a.id===assembly.outputArtifactId&&a.projectId===pid&&a.integrityStatus==="READY"&&a.mimeType==="video/mp4") : undefined;
 const expectedPlanHash=input.run?.productionPlan?.contentHash??input.workspace.project.currentProductionPlanRef?.hash;
 const current=assembly&&assembly.status!=="STALE"&&mediaReady&&(!expectedPlanHash||assembly.productionPlanHash===expectedPlanHash) ? assembly : undefined;
 return '<section class="ux-native-review" id="ux-final-review"><h3>最终成片审核</h3>'
    +(current?'<video controls preload="metadata" playsinline style="width:100%;max-height:460px;background:#111;border-radius:10px" src="'+media(mediaReady!.id)+'"></video>'
       +'<p class="ux-hint">成片状态：'+esc(current.status)+'。观看完整视频并听取声音后，再考虑确认或发布。</p>'
       +'<p>质检结果：<b>'+esc(qc?.assemblyId===current.id?qc.overall:"尚未对本成片做质检")+'</b></p>'
       +'<div class="ux-inline-actions"><button class="secondary" type="button" data-inline-action="final-qc">运行成片质量检查</button>'
       +(current.status!=="ACCEPTED" ? '<button type="button" data-inline-action="final-accept">确认当前成片</button>' : '')+'</div>'
       :empty("尚无当前版本的已渲染视频；请到后期剪辑/成片页检查真实进度。"))
    +'<p>发布属于单独授权步骤；确认成片不代表抖音发布成功。</p>'
    +'<a class="ux-expert-link" href="'+route(pid,"final")+'">高级：查看成片、QC 与发布记录</a><p class="ux-inline-error" role="alert"></p></section>';
}
function renderReferences(input:WorkflowInlineData):string{
 const pid=input.workspace.project.id,data=input.referenceData;
 if(!data)return '<section class="ux-native-review" id="ux-reference-review">'+empty("当前没有可用的创作参考服务。")+'<a href="'+route(pid,"creative-references")+'">打开创作参考素材池</a></section>';
 const rows=data.candidates.slice(0,30).map(c=>{
   const chosen=data.set?.entries.find(item=>item.candidateId===c.id);
   const roles=c.availableRoles.map(role=>'<option value="'+esc(role)+'"'+(chosen?.role===role?" selected":"")+'>'+esc(kinds[role]??role)+'</option>').join("");
   return '<article class="ux-ref-candidate" data-ux-ref-id="'+esc(c.id)+'" data-ux-ref-hash="'+esc(c.contentHash)+'">'
     +'<img loading="lazy" src="'+media(c.artifactId)+'" alt="'+esc(c.title)+'" style="width:100%;height:140px;object-fit:contain">'
     +'<b>'+esc(c.title||"研究参考图片")+'</b>'
     +'<p class="ux-hint">'+esc(c.status)+(chosen?" · 已确认参考":"")+'</p>'
     +'<p class="ux-hint">'+esc(c.assessment?.description??"等待视觉分析")+'</p>'
     +'<select class="ux-ref-role" '+(c.availableRoles.length?'':'disabled')+'>'+roles+'</select>'
     +'<div class="ux-inline-actions"><button type="button" data-inline-action="ref-review" data-decision="INCLUDE" '+(roles?'':'disabled')+'>加入参考</button>'
     +'<button class="secondary" type="button" data-inline-action="ref-review" data-decision="IGNORE">忽略</button>'
     +(chosen?'<button class="secondary" type="button" data-inline-action="ref-review" data-decision="REMOVE">移出</button>':'')+'</div></article>';
 }).join("");
 return '<section class="ux-native-review" id="ux-reference-review" data-revision="'+data.revision+'" data-truth="'+esc(data.truthHash)+'"><h3>创作参考素材审核</h3><p class="ux-hint">当前候选 '+data.candidates.length+' 个，已确认 '+(data.set?.entries.length??0)+' 个。竞品参考不能替代本产品真实主图和事实。</p>'
   +(data.identityBlocker?'<p class="ux-inline-error">'+esc(data.identityBlocker)+'</p>':'')
   +'<label><input type="checkbox" id="ux-reference-rights"> 我确认有权将选定的图片或视频帧用于本项目创作参考</label>'
   +'<div class="ux-ref-grid">'+(rows||empty("尚无创作参考候选。请先完成研究并提取候选。"))+'</div>'
   +'<a class="ux-expert-link" href="'+route(pid,"creative-references")+'">高级：批量审核、提取或重新分析</a><p class="ux-inline-error" role="alert"></p></section>';
}
export function renderNativeReview(input:WorkflowInlineData):string{
 const run=input.run;
 if(!run)return "";
 if(run.status==="WAITING_FOR_TRUTH_REVIEW")return renderTruth(input);
 if(run.status==="WAITING_FOR_REFERENCE_REVIEW")return renderReferences(input);
 if(run.status==="WAITING_FOR_CLIP_REVIEW")return renderClips(input);
 if(run.status==="REVIEW_READY")return renderFinal(input);
 return "";
}
export function renderNativeTools(input:WorkflowInlineData):string{
 const pid=input.workspace.project.id,research=input.research,brief=research?.brief;
 const researchPanel='<section class="ux-native-review" data-ux-tool-view="research"><h3>联网研究</h3>'
   +(brief?'<p>'+esc(brief.summary)+'</p><p class="ux-hint">证据 '+(research?.evidence.length??0)+' 条 · 研究结论仅供创意参考，新事实仍需确认。</p>'
    +'<ul>'+brief.contentOpportunities.slice(0,6).map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>'
    :empty(research?.latestRun?.status==="BLOCKED"?research.latestRun.requiredUserAction??"研究需要处理":research?.latestRun?"本轮未形成可用研究报告":"当前暂无研究报告，可以按需启动研究"))
   +'<form id="ux-native-research-form" class="ux-inline-control" style="display:grid;gap:8px;margin:14px 0">'
   +'<label>研究深度 <select name="mode"><option value="BASIC">基础研究</option><option value="DEEP">深度研究及抖音竞品</option></select></label>'
   +'<label>研究目标 <input name="goal" type="text" required maxlength="400" placeholder="例如：分析同类耳机的高赞短视频、使用场景及卖点"></label>'
   +'<label><input type="checkbox" name="marketVideoEnabled" checked> 同时搜索抖音同类高赞视频</label>'
   +douyinResearchPreflightControls
   +'<button type="submit">在当前任务中开始研究（可能使用已配置的 AI 模型）</button>'
   +'<p class="ux-inline-error" role="alert"></p></form>'
   +'<a class="ux-expert-link" href="'+route(pid,"research")+'">高级：完整研究证据、外部来源和登录排查</a></section>';
 const profile=input.referenceVideo?.status==="ACTIVE"?input.referenceVideo:undefined;
 const referencePanel='<section class="ux-native-review" data-ux-tool-view="reference-video" hidden><h3>参考视频分析</h3>'
   +(profile?'<video controls preload="metadata" playsinline style="width:100%;max-height:260px;background:#111" src="'+media(input.referenceVideoPreviewArtifactId??profile.videoArtifactId)+'"></video>'
      +'<p><b>已启用参考 v'+profile.version+'</b>：'+esc(profile.hook.firstThreeSecondsPattern)+'</p>'
      +'<p class="ux-hint">节奏：'+esc(profile.pacing.overall)+'</p>'
      :empty("尚未启用参考视频。上传 MP4/MOV 后会分析钩子、节奏与镜头语言。"))
   +'<form id="ux-reference-upload"><label>上传本地参考视频 <input name="video" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" required></label><button type="submit">上传并分析（不提交 Seedance 视频生成）</button></form>'
   +'<a class="ux-expert-link" href="'+route(pid,"reference-video")+'">高级：查看完整参考视频分析与历史版本</a><p class="ux-inline-error" role="alert"></p></section>';
 return researchPanel+referencePanel+'<div data-ux-tool-view="creative-references" hidden>'+renderReferences(input)+'</div>';
}
