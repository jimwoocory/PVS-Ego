import type { SmartGenerationRun } from "../domain/smart-generation.js";
import { renderClipAssetBindingPreview } from "./clip-reference-bindings-ui.js";
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const area = (attribute: string, value: string) => '<textarea class="v8-production-editor" '+attribute+' rows="3">'+esc(value)+'</textarea>';
const adopt = (action: string, hash: string, label: string) =>
  '<p><label><input type="checkbox" class="v8-production-confirm"> 我已核对完整动作、台词归属、声音和观众揭晓时机，明确采用这一版本。</label></p>'+
  '<button data-action="'+action+'" data-v8-artifact="'+esc(hash)+'">'+label+'（不生成视频）</button>';

export function renderV8ProductionWorkbench(run: SmartGenerationRun, previous: string): string {
  const record = run.v8Director;
  if (!record) return previous;
  const editable = !run.pendingInstall && !run.attemptIds.length &&
    ["WAITING_FOR_DIRECTOR_REVIEW", "WAITING_FOR_PLAN_REVIEW", "WAITING_FOR_PROMPT_REVIEW", "READY_FOR_PAID_CONFIRM", "BLOCKED", "FAILED"].includes(run.status);
  const clips = run.productionPlan?.scenes.flatMap(s => s.clips) ?? [];
  let html = '<section class="v8-production-workbench"><h3>完整创作工作流 · 镜头 → 声音 → 提示词</h3>'+
    '<p class="muted">剧本已确认；导演 v'+record.revision+' · '+(record.status === 'CONFIRMED'?'已人工采用':'待人工采用')+
    '。每次编辑都创建新版并使下游审核与费用确认失效。技术检查不能代替实际成片审查。</p>'+
    '<details open><summary>导演镜头表：'+record.decision.clips.length+' 个视频编号 · '+record.decision.targetDurationMs/1000+' 秒</summary>';
  for (const clip of record.decision.clips) {
    html += '<h4>视频 '+clip.order+' · '+clip.durationMs/1000+' 秒 · '+esc(clip.location)+'</h4>'+
      '<p>开始：'+esc(clip.openingState)+'；结束：'+esc(clip.closingState)+'</p>';
    for (const shot of clip.shots) {
      html += '<article><p><b>'+shot.startMs/1000+'–'+shot.endMs/1000+' 秒 · '+esc(shot.shotFunction)+'</b> '+esc(shot.visibleAction)+'</p>'+
        (shot.actorObjective?'<p>人物目标：'+esc(shot.actorObjective.speaker)+' · '+esc(shot.actorObjective.wants)+'；阻碍：'+esc(shot.actorObjective.obstacle)+'</p>':'')+
        (shot.spoken?'<p>发声：'+esc(shot.spoken.speaker)+'（'+esc(shot.spoken.mode)+'）：“'+esc(shot.spoken.exactText)+'”；语气：'+esc(shot.spoken.tone)+'；执行：'+esc(shot.spoken.delivery)+'</p>':'<p>此镜无新增对白。</p>')+
        (shot.audienceKnowledgeChange?'<p>观众此刻获知：'+esc(shot.audienceKnowledgeChange)+'</p>':'')+
        '<p>原生环境/音效：'+esc([...(shot.ambience??[]),...(shot.sfx??[])].join('；')||'无')+'；后期文字：'+esc((shot.postProductionText??[]).join('；')||'无')+'</p>'+
        (editable?'<label>视觉补充（人物站位、视线、机位；不得改剧情）'+area('data-v8-shot="'+esc(shot.shotId)+'"',shot.visualGuidance??'')+'</label>':'<p>'+esc(shot.visualGuidance)+'</p>')+'</article>';
    }
  }
  html += (editable?'<button data-action="director-v8">保存导演视觉要求，重新采用</button>':'')+'</details>';
  if (run.status === 'WAITING_FOR_DIRECTOR_REVIEW') html += adopt('CONFIRM_V8_DIRECTOR',record.contentHash,'采用当前导演镜头与时长');
  if (clips.length) {
    html += '<details open><summary>正式导演分镜 · v'+run.productionPlan!.version+' · '+(run.productionPlan!.status==='CONFIRMED'?'已确认':'待确认')+'</summary>';
    for (const [i, clip] of clips.entries()) {
      html += '<h4>视频 '+(i+1)+' · '+clip.durationMs/1000+' 秒</h4>';
      for (const segment of clip.segments) {
        html += '<div data-v8-segment="'+esc(segment.id)+'"><p>'+segment.startMs/1000+'–'+segment.endMs/1000+' 秒 · '+esc(segment.subjectAction)+'</p>'+
          '<p>台词：'+esc(segment.dialogueOrNarration.kind==='NONE'?'无':segment.dialogueOrNarration.text)+'</p>'+
          '<p>后期文字：'+esc(segment.postProductionText.map(c=>c.startMs/1000+'–'+c.endMs/1000+'秒 '+c.text).join('；'))+'</p>'+
          (editable?'<label>构图、演员站位与视线'+area('data-v8-composition',segment.composition)+'</label><label>运镜'+area('data-v8-camera',segment.cameraMovement)+'</label><label>灯光'+area('data-v8-lighting',segment.lighting)+'</label>':'<p>'+esc(segment.composition)+'；'+esc(segment.cameraMovement)+'；'+esc(segment.lighting)+'</p>')+'</div>';
      }
    }
    html += (editable?'<button data-action="plan-v8">保存正式镜头新版，重新审核</button>':'')+'</details>';
    if (run.status==='WAITING_FOR_PLAN_REVIEW') html += adopt('CONFIRM_PLAN',run.productionPlan!.contentHash,'确认当前正式分镜');
  }
  if (run.productionPlan?.status==='CONFIRMED') {
    const speakers = [...new Set(record.decision.clips.flatMap(c=>c.shots.flatMap(s=>s.spoken?[s.spoken.speaker]:[])))];
    html += '<details open><summary>固定演员、声线与逐镜视频提示词</summary><p>声线描述用于原生模型配音，不代表已克隆或验证的声音。无 BGM；后期文字交给既有时间线。</p>';
    for (const speaker of speakers) {
      const binding=run.v8Prompts?.voiceBindings[speaker];
      html += '<label data-v8-voice="'+esc(speaker)+'">'+esc(speaker)+' 的固定角色与声线 <select class="v8-production-editor" '+(!editable?'disabled':'')+'><option value="">请选择已确认演员</option>'+
        (run.productionAssetSet?.entries??[]).filter(e=>e.kind==='CHARACTER'&&e.status==='READY').map(e=>'<option value="'+esc(e.key)+'" '+(binding?.actorAssetKey===e.key?'selected':'')+'>'+esc(e.label)+'（'+esc(e.key)+'）</option>').join('')+
        '</select><input class="v8-production-editor" '+(!editable?'readonly':'')+' value="'+esc(binding?.voiceType??'')+'" placeholder="例如：清晰青年女声，保持同一音色"></label>';
    }
    if (editable) html += '<button data-action="prompts-v8">保存声线 / 重编译提示词新版</button>';
    for (const [i,p] of (run.v8Prompts?.packages??[]).entries()) {
      const matchingClip = clips.find(c=>c.id===p.clipId);
      const assetPreview=matchingClip ? renderClipAssetBindingPreview({
        clip: matchingClip, assetSet: run.productionAssetSet
      }) : '<p class="error">当前提示词找不到对应的正式Clip，请重新审核。</p>';
      const incoming=p.incomingContinuity;
      const transition=incoming
        ? '<p class="'+(incoming.relationship==='REVIEW_REQUIRED'?'error':'muted')+'">跨段衔接：'+
          esc(incoming.sourceClipId)+' → '+esc(p.clipId)+'；关系：'+esc(incoming.relationship)+
          (incoming.requiresHardFirstFrame?'；要求上一段真实尾帧经审核后接入专用首帧槽，不可只传普通参考图':'')+'</p>'
        : '';
      html += '<article class="v8-clip-prompt" data-clip-id="'+esc(p.clipId)+'"><h4>视频 '+(i+1)+' Prompt · '+p.durationMs/1000+' 秒</h4>'+
        assetPreview+transition+
        '<details class="v8-prompt-details" open><summary>查看本段完整视频生成提示词</summary><pre class="v8-prompt-pre">'+esc(p.promptText)+'</pre></details>'+
        '<p>后期文案清单：'+esc(p.postProductionText.map(c=>c.startMs/1000+'–'+c.endMs/1000+'秒 '+c.exactText).join('；')||'无')+'</p></article>';
    }
    html += '<p class="muted">提示词由已确认镜头编译。需要修改画面请编辑上方正式镜头；需要修改声音请编辑声线后重编译。直接改写自由文本无法保证语义完整，将被拒绝。</p></details>';
    if (run.status==='WAITING_FOR_PROMPT_REVIEW' && run.v8Prompts) html += adopt('CONFIRM_V8_PROMPTS',run.v8Prompts.contentHash,'采用本版完整提示词与声音');
  }
  return previous+html+'</section>';
}
