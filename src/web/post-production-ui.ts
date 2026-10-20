import type { ProductionPlan } from "../domain/schemas.js";
import { postProductionSettingsSchema } from "../domain/auto-edit.js";
function esc(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

export function renderPostProductionControls(input: { projectId: string; settings?: unknown; plan?: ProductionPlan }): string {
  const settings = postProductionSettingsSchema.parse(input.settings ?? {});
  const segments = input.plan?.scenes.flatMap(scene => scene.clips.flatMap(clip => clip.segments.map(segment => ({
    id: segment.id, clipOrder: clip.order, startMs: segment.startMs, endMs: segment.endMs,
    speech: segment.dialogueOrNarration.kind === "NONE" ? undefined : segment.dialogueOrNarration.text,
    ambient: segment.ambientSound.kind === "NONE" ? undefined : segment.ambientSound.description
  })))) ?? [];
  return `<div class="post-production-settings" data-project="${esc(input.projectId)}" data-settings="${esc(JSON.stringify(settings))}">
  <h3>字幕与后期声音</h3><p class="muted">只使用已确认分镜的台词。原声音轨存在不等于已核验台词，最终仍需试听。系统配音是本机离线音色，不是即梦原生声音，也不调用付费语音接口。</p>
  <div class="row"><label class="field">旁白来源<select class="post-mode">
    <option value="SOURCE_ONLY">保留视频原声；缺声时暂停</option><option value="SOURCE_OR_LOCAL_TTS">优先原声，无声镜头用本机配音</option>
    <option value="LOCAL_TTS">使用本机配音替换有台词镜头原声</option><option value="PROVIDED">使用下方提供的旁白音频</option></select></label>
    <label class="field">系统音色<select class="post-voice"><option value="">按文本语言选择</option></select></label>
    <label class="field">本机配音语速<select class="post-rate">${[-2,-1,0,1,2,3].map(rate => `<option value="${rate}">${rate === 0 ? "标准" : rate > 0 ? "加快 " + rate : "放慢 " + Math.abs(rate)}</option>`).join("")}</select></label>
  </div><p class="muted post-voice-status">正在读取已安装系统音色…</p>
  <div class="row"><label class="field">后期统一背景音乐<select class="post-bgm post-audio-select"><option value="">不添加背景音乐</option></select><span class="muted">这里的音乐只在最终剪辑阶段铺到整条成片，不会交给 Seedance 分段生成。</span></label>
    <label class="field">背景音乐音量（0–1）<input class="post-bgm-volume" type="number" min="0" max="1" step="any" value="${settings.bgmArtifactId ? settings.bgmVolume : ""}" placeholder="未启用" ${settings.bgmArtifactId ? "" : "disabled"}></label>
    <label class="field">原视频音量（0–2）<input class="post-source-volume" type="number" min="0" max="2" step="any" value="${settings.sourceVolume}"></label></div>
  <p><label><input class="post-captions" type="checkbox" ${settings.captions ? "checked" : ""}> 按分镜台词与配音时段自动排字幕</label></p>
  <p><label><input class="post-cta" type="checkbox" ${settings.cta ? "checked" : ""}> 使用已确认脚本中的行动引导</label></p>
  <p><label><input class="post-omit-effects" type="checkbox" ${settings.omitMissingEffects ? "checked" : ""}> 明确允许略过无法补齐的场景音效</label></p>
  <p><label><input class="post-silent" type="checkbox" ${settings.allowSilentOutput ? "checked" : ""}> 明确允许缺少声音时输出无声版本（台词可保留为字幕）</label></p>
  <details><summary>上传背景音乐、旁白或场景音效</summary><p class="muted">请使用有权使用的音频。上传仅加入后期素材，不改变产品主图、产品事实或已确认的视频生成费用范围。</p>
    <input class="post-upload" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"><p class="post-upload-status muted"></p></details>
  ${segments.length ? `<details><summary>按分镜绑定已有旁白与音效</summary>${segments.flatMap(segment => (["NARRATION", "AMBIENT"] as const).filter(kind => kind === "NARRATION" ? Boolean(segment.speech) : Boolean(segment.ambient)).map(kind => {
    const binding = settings.audioBindings.find(b => b.segmentId === segment.id && b.kind === kind);
    return `<div class="post-binding" data-segment="${esc(segment.id)}" data-kind="${kind}"><p>镜头 ${segment.clipOrder} · ${segment.startMs / 1000}–${segment.endMs / 1000} 秒 · ${kind === "NARRATION" ? "旁白 / 对话" : "场景音效"}：${esc(kind === "NARRATION" ? segment.speech : segment.ambient)}</p>
    <select class="post-audio-select post-bound-audio" data-selected="${esc(binding?.artifactId ?? "")}"><option value="">不指定外部音频</option></select>
    <label>源起点（毫秒）<input class="post-in" type="number" min="0" step="1" value="${binding?.inMs ?? 0}"></label>
    <label>源终点（毫秒；空白为全部）<input class="post-out" type="number" min="1" step="1" value="${binding?.outMs ?? ""}"></label>
    <label>音量<input class="post-volume" type="number" min="0" max="2" step="any" value="${binding?.volume ?? 1}"></label></div>`;
  })).join("")}</details>` : ""}
  <p class="error post-error" role="alert"></p>
  </div>`;
}

/** Install once per page. All labels use textContent; uploaded names never become executable markup. */
export const postProductionBrowserScript = `<script>
(()=>{
 window.pvsReadPostProduction=root=>({
   narrationMode:root.querySelector('.post-mode').value,
   ...(root.querySelector('.post-voice').value?{voiceName:root.querySelector('.post-voice').value}:{}),
   speechRate:Number(root.querySelector('.post-rate').value),captions:root.querySelector('.post-captions').checked,cta:root.querySelector('.post-cta').checked,
   ...(root.querySelector('.post-bgm').value?{bgmArtifactId:root.querySelector('.post-bgm').value}:{}),
   bgmVolume:Number(root.querySelector('.post-bgm-volume').value),sourceVolume:Number(root.querySelector('.post-source-volume').value),
   allowSilentOutput:root.querySelector('.post-silent').checked,omitMissingEffects:root.querySelector('.post-omit-effects').checked,
   audioBindings:[...root.querySelectorAll('.post-binding')].filter(row=>row.querySelector('.post-bound-audio').value).map(row=>({segmentId:row.dataset.segment,kind:row.dataset.kind,artifactId:row.querySelector('.post-bound-audio').value,
     inMs:Number(row.querySelector('.post-in').value),...(row.querySelector('.post-out').value?{outMs:Number(row.querySelector('.post-out').value)}:{}),volume:Number(row.querySelector('.post-volume').value)}))
 });
 for(const root of document.querySelectorAll('.post-production-settings')){
   const settings=JSON.parse(root.dataset.settings),base='/api/projects/'+encodeURIComponent(root.dataset.project)+'/post-production';
   root.querySelector('.post-mode').value=settings.narrationMode;root.querySelector('.post-rate').value=String(settings.speechRate);
   const bgmSelect=root.querySelector('.post-bgm'),bgmVolume=root.querySelector('.post-bgm-volume');
   let lastBgmVolume=Number(settings.bgmVolume)>0?Number(settings.bgmVolume):0.22;
   const syncBgm=()=>{
     if(bgmSelect.value){
       bgmVolume.disabled=false;
       if(bgmVolume.value==='')bgmVolume.value=String(lastBgmVolume);
     }else{
       if(bgmVolume.value!=='')lastBgmVolume=Number(bgmVolume.value)||lastBgmVolume;
       bgmVolume.value='';
       bgmVolume.disabled=true;
     }
   };
   let first=true;
   const load=async()=>{
     const response=await fetch(base);const data=await response.json();if(!response.ok)throw new Error(data.message||'后期素材读取失败');
     const voice=root.querySelector('.post-voice'),chosenVoice=first?(settings.voiceName||''):voice.value;
     voice.replaceChildren(new Option('按文本语言选择',''));for(const v of data.voices.voices)voice.add(new Option(v.name+' · '+v.locale,v.name));
     if(chosenVoice&&!data.voices.voices.some(v=>v.name===chosenVoice))voice.add(new Option(chosenVoice+'（当前不可用）',chosenVoice));voice.value=chosenVoice;
     root.querySelector('.post-voice-status').textContent=data.voices.message;
     for(const select of root.querySelectorAll('.post-audio-select')){
       const chosen=first?(select.classList.contains('post-bgm')?(settings.bgmArtifactId||''):(select.dataset.selected||'')):select.value;
       select.replaceChildren(new Option(select.classList.contains('post-bgm')?'不添加背景音乐':'不指定外部音频',''));
       for(const a of data.audioAssets)select.add(new Option(a.name,a.id));
       if(chosen&&!data.audioAssets.some(a=>a.id===chosen))select.add(new Option('所选音频当前不可用',chosen));select.value=chosen;
     }
     syncBgm();
     first=false;
   };
   load().catch(e=>root.querySelector('.post-error').textContent=e.message);
   bgmSelect.addEventListener('change',()=>{syncBgm();root.dataset.dirty='1';});
   bgmVolume.addEventListener('input',()=>{if(bgmVolume.value!=='')lastBgmVolume=Number(bgmVolume.value)||lastBgmVolume;});
   root.addEventListener('input',()=>{root.dataset.dirty='1';});root.addEventListener('change',()=>{root.dataset.dirty='1';});
   root.querySelector('.post-upload').addEventListener('change',async e=>{
     const file=e.target.files?.[0];if(!file)return;const status=root.querySelector('.post-upload-status');
     root.dataset.uploading='1';status.textContent='正在验证并保存后期音频…';
     try{if(file.size>20*1024*1024)throw new Error('后期音频单文件不能超过20MB');
       const base64=await new Promise((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=()=>fail(new Error('音频读取失败'));r.readAsDataURL(file);});
       const response=await fetch(base+'/audio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:file.name,base64})});const data=await response.json();if(!response.ok)throw new Error(data.message||'上传失败');
       await load();status.textContent='已保存：'+file.name+'。请在背景音乐或分镜绑定中选择此音频。';e.target.value='';
     }catch(error){status.textContent=error.message;}finally{root.dataset.uploading='0';}
   });
 }
})();
</script>`;
