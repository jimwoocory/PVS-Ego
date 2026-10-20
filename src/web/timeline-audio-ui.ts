import type { Timeline } from "../domain/schemas.js";
function esc(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export function renderTimelineAudioEditor(timeline: Timeline): string {
  const active = timeline.audioItems.filter(a => !a.deleted);
  if (!active.length) return "";
  return `<section class="card" id="tl-post-audio" data-project="${esc(timeline.projectId)}" data-hash="${esc(timeline.contentHash)}"><h3>后期多音轨微调</h3><p class="muted">旁白、场景音效和每段背景音乐可以独立调整。保留源音频文件；修改已确认时间线会创建新草稿。混音结果以最终渲染为准。</p>
  ${active.map(item => `<div class="clip tl-audio-edit" data-id="${esc(item.id)}"><b>${({ BGM: "背景音乐", NARRATION: "旁白 / 对话", SFX: "场景音效" })[item.role ?? "BGM"]}</b>
  <audio controls preload="metadata" src="/api/artifacts/${encodeURIComponent(item.sourceArtifactId)}/content" style="width:100%"></audio><div class="row">
    <label class="field">时间线起点（秒）<input class="audio-start" type="number" min="0" step="0.01" value="${item.startMs / 1000}"></label>
    <label class="field">源入点（秒）<input class="audio-in" type="number" min="0" step="0.01" value="${item.inMs / 1000}"></label>
    <label class="field">源出点（秒）<input class="audio-out" type="number" min="0.01" step="0.01" value="${item.outMs / 1000}"></label>
    <label class="field">音量（0–2）<input class="audio-volume" type="number" min="0" max="2" step="0.01" value="${item.audio.volume}"></label></div>
    <p><label><input class="audio-muted" type="checkbox" ${item.audio.muted ? "checked" : ""}> 静音</label> <label><input class="audio-clear-envelope" type="checkbox"> 清除原音量关键帧（当前 ${item.audio.keyframes.length} 个）</label></p>
    <button class="secondary audio-save" type="button">保存音轨</button> <button class="secondary audio-delete" type="button">移除此音轨</button><p class="danger audio-error" role="alert"></p></div>`).join("")}</section>
    <script>(()=>{const root=document.querySelector('#tl-post-audio');for(const row of root.querySelectorAll('.tl-audio-edit'))for(const button of row.querySelectorAll('button'))button.addEventListener('click',async()=>{button.disabled=true;const error=row.querySelector('.audio-error');error.textContent='';try{const payload={expectedHash:root.dataset.hash,...(button.classList.contains('audio-delete')?{deleted:true}:{startMs:Math.round(Number(row.querySelector('.audio-start').value)*1000),inMs:Math.round(Number(row.querySelector('.audio-in').value)*1000),outMs:Math.round(Number(row.querySelector('.audio-out').value)*1000),volume:Number(row.querySelector('.audio-volume').value),muted:row.querySelector('.audio-muted').checked,clearKeyframes:row.querySelector('.audio-clear-envelope').checked})};const response=await fetch('/api/projects/'+encodeURIComponent(root.dataset.project)+'/timeline/audio/'+encodeURIComponent(row.dataset.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.message||'音轨更新失败');location.reload();}catch(cause){error.textContent=cause.message;button.disabled=false;}});})();</script>`;
}
