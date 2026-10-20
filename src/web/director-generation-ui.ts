import type { DirectorGenerationTarget } from "../domain/schemas.js";

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

/** Only presentation logic: the server resolves settings against the same registry again. */
export function renderDirectorGenerationControls(input: {
  projectId: string;
  targetDurationMs: number;
  canGenerate: boolean;
  hasPlan: boolean;
  target?: DirectorGenerationTarget;
}): string {
  const state = {
    projectId: input.projectId,
    targetDurationMs: input.targetDurationMs,
    canGenerate: input.canGenerate,
    hasPlan: input.hasPlan,
    target: input.target ?? null
  };
  return `<section class="card" id="director-generation-controls" data-state="${escape(JSON.stringify(state))}">
  <h3>${input.hasPlan ? "按新模型重新适配分镜" : "先选择视频模型，再生成导演分镜"}</h3>
  <p class="muted">分镜时长、参考图数量、画幅与声音策略从当前即梦能力读取。此步不会提交即梦付费视频生成。</p>
  ${input.target ? `<p>当前绑定：<b>${escape(input.target.requestedModelVersion)}</b> · ${escape(input.target.aspectRatio)} · ${escape(input.target.videoResolution)} · ${input.target.nativeAudioOutputRequested ? "原生声音" : "后期音轨"}</p>` : ""}
  <div class="row">
    <label class="field">目标视频模型<select id="director-model" disabled><option>正在读取模型…</option></select></label>
    <label class="field">画幅<select id="director-ratio" disabled><option>正在读取画幅…</option></select></label>
    <label class="field">分辨率<select id="director-resolution" disabled><option>正在读取分辨率…</option></select></label>
  </div>
  <p><label><input type="checkbox" id="director-native-audio" checked disabled> 让模型原生输出声音</label></p>
  <p class="muted" id="director-audio-help"></p>
  <p class="muted" id="director-duration-preview"></p>
  ${input.hasPlan ? '<p class="muted">重新适配会保存新的导演草稿，并使旧提示词、生成前检查和未使用授权失效；原素材、生成记录和历史版本保留，需要重新审核。</p>' : ""}
  <button class="${input.hasPlan ? "secondary" : "primary"}" id="generate-plan" disabled>${input.hasPlan ? "重新适配为新分镜草稿" : "生成导演分镜计划"}</button>
  <span id="plan-generate-progress" class="muted"></span>
  <div id="plan-generate-error" class="danger" role="alert"></div>
</section>
<script>
(()=>{
 const root=document.querySelector('#director-generation-controls');
 const state=JSON.parse(root.dataset.state);
 const model=document.querySelector('#director-model'),ratio=document.querySelector('#director-ratio'),resolution=document.querySelector('#director-resolution');
 const audio=document.querySelector('#director-native-audio'),button=document.querySelector('#generate-plan');
 const error=document.querySelector('#plan-generate-error'),progress=document.querySelector('#plan-generate-progress');
 const previous=state.target||{};
 let registry=null,ready=false;
 const intersection=arrays=>arrays.length?arrays.reduce((a,b)=>a.filter(value=>b.includes(value))):[];
 const fill=(element,values,preferred,label)=>{
   element.replaceChildren();
   for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=label?label(value):value;element.appendChild(option);}
   if(values.includes(preferred))element.value=preferred;
   element.disabled=!values.length;
 };
 const operations=()=>['text2video','multimodal2video'].map(name=>registry.operations.find(item=>item.operation===name));
 const refresh=()=>{
   const ops=operations();
   const models=ops.map(op=>op.models.find(item=>item.modelVersion===model.value));
   if(models.some(item=>!item)){ready=false;button.disabled=true;return;}
   const oldRatio=ratio.disabled?(previous.aspectRatio||'9:16'):ratio.value;
   const explicit=models.every(item=>item.explicitRatioAllowed);
   const ratios=explicit?intersection(ops.map(op=>op.supportedRatios)):[];
   fill(ratio,['AUTO',...ratios],oldRatio,value=>value==='AUTO'?'自动 / 跟随素材':value);
   fill(resolution,intersection(models.map(item=>item.supportedResolutions)),resolution.disabled?(previous.videoResolution||'720p'):resolution.value);
   const native=ops.every(op=>op.supportsNativeAudioOutput===true);
   audio.disabled=!native;if(!native)audio.checked=false;
   document.querySelector('#director-audio-help').textContent=native?'Seedance 当前链路会直接生成原生音轨；程序下载后还会检查音轨是否真实存在。参考音频输入仍是另一种能力。':'当前生成方式不能保证返回音轨；如需原生声音，请使用文生视频或全能参考。';
   const min=Math.max(4,...models.map(item=>Math.ceil(item.durationMinSeconds??Infinity)));
   const max=Math.min(15,...models.map(item=>Math.floor(item.durationMaxSeconds??0)));
   const total=state.targetDurationMs/1000,count=Math.ceil(total/max);
   ready=Number.isFinite(min)&&max>=min&&count*min<=total&&Boolean(resolution.value);
   document.querySelector('#director-duration-preview').textContent=ready?'目标 '+total+' 秒 · 当前长镜头 '+min+'–'+max+' 秒 · 建议自动拆为 '+count+' 个镜头，台词不得跨模型时长强行截断。':'所选模型暂无可验证的整秒拆镜方案，请调整设置或刷新能力。';
   button.disabled=!ready||!state.canGenerate;
   if(!state.canGenerate)error.textContent='请先确认当前脚本，再生成导演分镜。';
 };
 model.addEventListener('change',refresh);
 button.addEventListener('click',async()=>{
   if(!ready)return;
   button.disabled=true;error.textContent='';progress.textContent=' 正在按所选模型生成与校验分镜…';
   try{
     const generationSettings={requestedModelVersion:model.value,aspectRatio:ratio.value,videoResolution:resolution.value,nativeAudioOutputRequested:audio.checked};
     const response=await fetch('/api/projects/'+encodeURIComponent(state.projectId)+'/production-plan/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({generationSettings})});
     const payload=await response.json();if(!response.ok)throw new Error(payload.message||payload.error||'生成导演分镜失败');
     location.reload();
   }catch(cause){error.textContent=cause.message||String(cause);progress.textContent='';button.disabled=false;}
 });
 (async()=>{
   try{
     const response=await fetch('/api/dreamina/capabilities');const payload=await response.json();
     if(!response.ok)throw new Error(payload.message||payload.error||'读取即梦能力失败');
     registry=payload.registry;
     const ops=operations();if(ops.some(item=>!item))throw new Error('当前缺少标准分镜需要的已验证视频命令');
     const values=intersection(ops.map(op=>op.supportedModels));
     const preferred=previous.requestedModelVersion||(values.includes('seedance2.0mini')?'seedance2.0mini':values[0]);
     fill(model,values,preferred);
     audio.checked=previous.requestedModelVersion?Boolean(previous.nativeAudioOutputRequested):true;
     refresh();
     if(previous.requestedModelVersion&&!values.includes(previous.requestedModelVersion))error.textContent='旧模型已不在当前能力表中，请明确选择新模型后重新适配。';
   }catch(cause){ready=false;button.disabled=true;error.textContent='无法准备导演生成设置：'+(cause.message||String(cause));}
 })();
})();
</script>`;
}
