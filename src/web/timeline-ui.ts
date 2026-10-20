import type { ProjectWorkspace } from "../application/services/product-flow.js";
import type { RenderJob, Timeline } from "../domain/schemas.js";
import { renderTimelineAudioEditor } from "./timeline-audio-ui.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function durationMs(timeline: Timeline): number {
  const clips = timeline.clips
    .filter((clip) => !clip.deleted)
    .sort((a, b) => a.order - b.order);
  let total = clips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
  for (let index = 0; index < clips.length - 1; index += 1) {
    if (clips[index]!.transition.type !== "CUT") {
      total -= clips[index]!.transition.durationMs;
    }
  }
  return Math.max(0, total);
}

function transitionLabel(type: Timeline["clips"][number]["transition"]["type"]): string {
  if (type === "CROSSFADE") return "交叉淡化";
  if (type === "FADE") return "淡入淡出";
  return "硬切";
}

function positionLabel(position: Timeline["textItems"][number]["position"]): string {
  if (position === "TOP") return "顶部";
  if (position === "CENTER") return "居中";
  return "底部";
}

function timelineStatusLabel(status: Timeline["status"]): string {
  if (status === "CONFIRMED") return "已确认";
  if (status === "STALE") return "已失效";
  return "编辑中";
}

function renderJobStatusLabel(status: RenderJob["status"]): string {
  if (status === "QUEUED") return "等待渲染";
  if (status === "RENDERING") return "渲染中";
  if (status === "SUCCEEDED") return "渲染完成";
  return "渲染失败";
}

export function renderTimelineEditor(
  workspace: ProjectWorkspace,
  timeline: Timeline,
  renderJob?: RenderJob
): string {
  const active = timeline.clips
    .filter((clip) => !clip.deleted)
    .sort((a, b) => a.order - b.order);
  const deleted = timeline.clips
    .filter((clip) => clip.deleted)
    .sort((a, b) => a.order - b.order);
  const activeText = timeline.textItems.filter((item) => !item.deleted);
  const activeBgm = timeline.audioItems
    .filter((item) => !item.deleted && (!item.role || item.role === "BGM"))
    .sort((a, b) => b.order - a.order)[0];
  const totalMs = durationMs(timeline);

  const previewData = {
    projectId: workspace.project.id,
    clips: active.map((clip) => ({
      id: clip.id,
      artifactId: clip.sourceArtifactId,
      inMs: clip.inMs,
      outMs: clip.outMs,
      volume: clip.audio.volume,
      muted: clip.audio.muted,
      transitionType: clip.transition.type,
      transitionDurationMs: clip.transition.durationMs
    })),
    textItems: activeText.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      startMs: item.startMs,
      endMs: item.endMs,
      position: item.position
    }))
  };

  const clipCards = active
    .map((clip, index) => {
      const transitionOptions = ["CUT", "CROSSFADE", "FADE"]
        .map(
          (type) =>
            '<option value="' +
            type +
            '"' +
            (clip.transition.type === type ? " selected" : "") +
            ">" +
            esc(
              transitionLabel(
                type as Timeline["clips"][number]["transition"]["type"]
              )
            ) +
            "</option>"
        )
        .join("");
      return (
        '<article class="tl-clip" draggable="true" data-id="' +
        esc(clip.id) +
        '">' +
        '<div class="tl-clip-head"><div><span class="drag-handle">☰</span> <b>镜头 ' +
        (index + 1) +
        "</b> <span class=\"muted\">非破坏式剪辑</span></div>" +
        '<div class="quick"><button type="button" class="secondary tl-move" data-dir="-1">上移</button>' +
        '<button type="button" class="secondary tl-move" data-dir="1">下移</button>' +
        '<button type="button" class="secondary tl-save">保存</button>' +
        '<button type="button" class="secondary tl-delete">删除</button></div></div>' +
        '<div class="tl-clip-grid">' +
        '<video controls preload="metadata" src="/api/artifacts/' +
        esc(clip.sourceArtifactId) +
        '/content"></video>' +
        '<div class="tl-fields">' +
        '<div class="row"><label class="field">入点（秒）<input data-field="in" type="number" min="0" step="0.1" value="' +
        (clip.inMs / 1000).toFixed(3) +
        '"></label>' +
        '<label class="field">出点（秒）<input data-field="out" type="number" min="0.1" step="0.1" value="' +
        (clip.outMs / 1000).toFixed(3) +
        '"></label></div>' +
        '<div class="row"><label class="field">原声音量 0–2<input data-field="volume" type="number" min="0" max="2" step="0.05" value="' +
        clip.audio.volume.toFixed(2) +
        '"></label>' +
        '<label class="field">镜头后转场<select data-field="transition">' +
        transitionOptions +
        "</select></label>" +
        '<label class="field">转场时长（秒）<input data-field="transition-duration" type="number" min="0" max="2" step="0.1" value="' +
        (clip.transition.durationMs / 1000).toFixed(2) +
        '"></label></div>' +
        '<label><input data-field="muted" type="checkbox"' +
        (clip.audio.muted ? " checked" : "") +
        "> 静音此镜头原声</label>" +
        '<p class="muted">源时长 ' +
        (clip.sourceDurationMs / 1000).toFixed(2) +
        "s · 当前保留 " +
        ((clip.outMs - clip.inMs) / 1000).toFixed(2) +
        "s · 原始视频保持只读</p>" +
        '<p class="technical hash">edit=' +
        esc(clip.id) +
        "<br>artifact=" +
        esc(clip.sourceArtifactId) +
        "<br>sha256=" +
        esc(clip.sourceArtifactHash) +
        "</p>" +
        "</div></div></article>"
      );
    })
    .join("");

  const deletedCards = deleted.length
    ? deleted
        .map(
          (clip) =>
            '<div class="clip tl-deleted" data-id="' +
            esc(clip.id) +
            '"><b>已删除镜头</b> <button type="button" class="secondary tl-restore">恢复到末尾</button>' +
            '<p class="muted">原始视频仍保留，恢复不会重新生成视频。</p></div>'
        )
        .join("")
    : '<p class="muted">没有已删除镜头。</p>';

  const textRows = activeText.length
    ? activeText
        .map(
          (item) =>
            '<div class="clip tl-text-item" data-id="' +
            esc(item.id) +
            '"><b>' +
            (item.kind === "CTA" ? "花字 / 行动引导" : "字幕") +
            "</b> · " +
            esc(item.text) +
            '<p class="muted">' +
            (item.startMs / 1000).toFixed(2) +
            "–" +
            (item.endMs / 1000).toFixed(2) +
            "s · " +
            positionLabel(item.position) +
            " · 字号倍率 " +
            item.fontScale.toFixed(2) +
            '</p><button type="button" class="secondary tl-remove-text">删除</button></div>'
        )
        .join("")
    : '<p class="muted">当前没有字幕或行动引导。</p>';

  const bgmHtml = activeBgm
    ? '<div class="clip"><b>当前背景音乐</b><audio controls preload="metadata" src="/api/artifacts/' +
      esc(activeBgm.sourceArtifactId) +
      '/content" style="width:100%"></audio><p class="muted">开始 ' +
      (activeBgm.startMs / 1000).toFixed(2) +
      "s · 裁剪 " +
      (activeBgm.inMs / 1000).toFixed(2) +
      "–" +
      (activeBgm.outMs / 1000).toFixed(2) +
      "s · 音量 " +
      activeBgm.audio.volume.toFixed(2) +
      '</p><button type="button" id="tl-remove-bgm" class="secondary">移除背景音乐</button></div>'
    : '<p class="muted">当前没有背景音乐。</p>';

  const renderJobHtml = renderJob
    ? '<div class="clip"><b>渲染任务：' +
      esc(renderJobStatusLabel(renderJob.status)) +
      '</b><p class="hash">job=' +
      esc(renderJob.id) +
      "<br>timeline=" +
      esc(renderJob.timelineHash) +
      "</p></div>"
    : '<p class="muted">确认剪辑方案后会创建渲染任务。</p>';

  const finalRenderAction =
    renderJob?.status === "SUCCEEDED"
      ? '<a class="primary" href="/projects/' +
        esc(workspace.project.id) +
        '/final">查看最终成片</a>'
      : renderJob?.status === "RENDERING"
        ? '<button type="button" class="primary" disabled>正在最终渲染…</button>'
        : '<button type="button" id="tl-render-final" class="primary">进入最终渲染</button>';

  const confirmHtml =
    timeline.status === "CONFIRMED"
      ? '<p class="ok"><b>剪辑方案已确认。</b> 已创建或复用渲染任务，可以开始最终渲染。</p>' +
        renderJobHtml +
        '<p>' +
        finalRenderAction +
        ' <button type="button" id="tl-reset" class="secondary">从已采用镜头重新建立剪辑</button></p>'
      : '<p><button type="button" id="tl-confirm" class="primary">确认剪辑方案并创建渲染任务</button> ' +
        '<button type="button" id="tl-reset" class="secondary">从已采用镜头重新建立剪辑</button></p>';

  const body =
    '<style>' +
    ".tl-summary{display:flex;gap:14px;flex-wrap:wrap}.tl-stat{background:#f7f7f4;border:1px solid #ddd;border-radius:10px;padding:10px 14px;min-width:150px}.tl-preview-wrap{display:grid;grid-template-columns:minmax(280px,520px) 1fr;gap:16px;align-items:start}.tl-preview-stage{position:relative;background:#111;border-radius:12px;overflow:hidden;aspect-ratio:9/16;max-height:620px}.tl-preview-stage video{width:100%;height:100%;object-fit:contain;background:#000}.tl-overlay{position:absolute;left:8%;right:8%;text-align:center;color:#fff;font-weight:700;text-shadow:0 2px 8px #000;background:rgba(0,0,0,.28);padding:8px;border-radius:8px;pointer-events:none}.tl-overlay[data-position=TOP]{top:8%}.tl-overlay[data-position=CENTER]{top:45%}.tl-overlay[data-position=BOTTOM]{bottom:8%}.tl-track{border:1px solid #d8d8d1;border-radius:12px;padding:10px;background:#f7f7f4;min-height:70px}.tl-clip{background:#fff;border:1px solid #d8d8d1;border-radius:12px;padding:14px;margin:10px 0}.tl-clip.dragging{opacity:.45}.tl-clip-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}.drag-handle{cursor:grab;font-size:20px}.tl-clip-grid{display:grid;grid-template-columns:minmax(220px,360px) 1fr;gap:14px;margin-top:10px}.tl-clip-grid video{width:100%;max-height:280px;background:#000;border-radius:8px}.tl-fields .field{min-width:140px}.tl-deleted{opacity:.75}.tl-editor-actions{position:sticky;bottom:12px;background:#fff;border:1px solid #ddd;border-radius:12px;padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.08);z-index:2}@media(max-width:800px){.tl-preview-wrap,.tl-clip-grid{grid-template-columns:1fr}.tl-preview-stage{max-height:520px}}" +
    "</style>" +
    '<section class="card"><h3>剪辑方案 v' +
    timeline.version +
    " · " +
    esc(timelineStatusLabel(timeline.status)) +
    '</h3><div class="tl-summary">' +
    '<div class="tl-stat"><b>有效镜头</b><br>' +
    active.length +
    "</div>" +
    '<div class="tl-stat"><b>总时长</b><br>' +
    (totalMs / 1000).toFixed(2) +
    "s</div>" +
    '<div class="tl-stat"><b>轨道</b><br>' +
    timeline.tracks.length +
    "</div>" +
    '<div class="tl-stat"><b>字幕 / 行动引导</b><br>' +
    activeText.length +
    "</div></div>" +
    '<p class="muted">剪辑是非破坏式的：这里只保存顺序、裁剪、音量、转场、字幕与背景音乐设置，原始生成视频不会被修改。</p>' +
    '<p class="hash">timeline=' +
    esc(timeline.id) +
    "<br>hash=" +
    esc(timeline.contentHash) +
    "<br>productionPlan=" +
    esc(timeline.productionPlanHash) +
    "</p></section>" +
    '<section class="card"><h3>实时预览</h3><div class="tl-preview-wrap"><div><div class="tl-preview-stage"><video id="tl-preview-video" preload="metadata" playsinline></video><div id="tl-preview-overlay" class="tl-overlay" hidden></div></div><p><button type="button" id="tl-preview-play" class="primary">从头预览</button> <button type="button" id="tl-preview-stop" class="secondary">停止</button></p><p id="tl-preview-time" class="muted">0.00s / ' +
    (totalMs / 1000).toFixed(2) +
    's</p></div><div><p><b>预览说明</b></p><p class="muted">顺序、裁剪、原声音量、静音、字幕和行动引导会即时反映；基础转场与背景音乐的最终混音以最终渲染结果为准。</p><div class="tl-track"><b>主视频轨道</b><br>' +
    active.map((clip, i) => "镜头 " + (i + 1) + " " + ((clip.outMs - clip.inMs) / 1000).toFixed(1) + "s").join(" → ") +
    '</div><div class="tl-track"><b>背景音乐轨道</b><br>' +
    (activeBgm ? "已配置" : "未配置") +
    '</div><div class="tl-track"><b>字幕 / 行动引导轨道</b><br>' +
    (activeText.length ? activeText.length + " 条" : "未配置") +
    "</div></div></div></section>" +
    '<section class="card"><h3>镜头剪辑</h3><p class="muted">可拖动镜头卡片重排；也可以使用上移/下移。每个镜头独立设置入点、出点、原声音量和镜头后的转场。</p><div id="tl-active-list">' +
    (clipCards || '<p class="danger">没有有效镜头。</p>') +
    '</div><details><summary>已删除镜头（' +
    deleted.length +
    '）</summary><div id="tl-deleted-list">' +
    deletedCards +
    "</div></details></section>" +
    '<section class="card"><h3>背景音乐</h3>' +
    bgmHtml +
    '<div class="row"><label class="field">选择音频文件<input id="tl-bgm-file" type="file" accept="audio/*"></label><label class="field">背景音乐音量 0–2<input id="tl-bgm-volume" type="number" min="0" max="2" step="0.05" value="' +
    (activeBgm?.audio.volume ?? 0.35).toFixed(2) +
    '"></label></div><p><button type="button" id="tl-upload-bgm" class="secondary">上传并使用背景音乐</button></p><div id="tl-bgm-error" class="danger"></div></section>' +
    '<section class="card"><h3>字幕 / 花字行动引导</h3>' +
    textRows +
    '<div class="row"><label class="field">类型<select id="tl-text-kind"><option value="CAPTION">字幕</option><option value="CTA">花字 / 行动引导</option></select></label><label class="field">位置<select id="tl-text-position"><option value="BOTTOM">底部</option><option value="CENTER">居中</option><option value="TOP">顶部</option></select></label><label class="field">字号倍率<input id="tl-text-scale" type="number" min="0.5" max="3" step="0.1" value="1"></label></div><label class="field">文字<input id="tl-text-value" maxlength="240" placeholder="输入字幕或行动引导文字"></label><div class="row"><label class="field">开始（秒）<input id="tl-text-start" type="number" min="0" step="0.1" value="0"></label><label class="field">结束（秒）<input id="tl-text-end" type="number" min="0.1" step="0.1" value="' +
    Math.max(1, Math.min(totalMs / 1000, 5)).toFixed(1) +
    '"></label></div><p><button type="button" id="tl-add-text" class="secondary">添加文字</button></p><div id="tl-text-error" class="danger"></div></section>' +
    '<section class="card"><h3>确认与渲染</h3>' +
    confirmHtml +
    '<div id="tl-main-error" class="danger"></div></section>' +
    '<script id="tl-data" type="application/json">' +
    jsonForScript(previewData) +
    "</script>" +
    '<script>' +
    "(function(){" +
    "const data=JSON.parse(document.getElementById('tl-data').textContent||'{}');" +
    "const projectId=data.projectId;" +
    "const api=(path,body)=>fetch('/api/projects/'+encodeURIComponent(projectId)+'/timeline'+path,{method:'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||'操作失败');return j;});" +
    "const reload=()=>location.reload();" +
    "const num=(el)=>Number(el.value);" +
    "const activeList=document.getElementById('tl-active-list');" +
    "const saveOrder=async()=>{const ids=[...activeList.querySelectorAll('.tl-clip')].map(x=>x.dataset.id);await api('/reorder',{orderedClipEditIds:ids});reload();};" +
    "let dragged=null;" +
    "activeList.querySelectorAll('.tl-clip').forEach(card=>{" +
    "card.addEventListener('dragstart',()=>{dragged=card;card.classList.add('dragging');});" +
    "card.addEventListener('dragend',()=>{card.classList.remove('dragging');dragged=null;});" +
    "card.addEventListener('dragover',e=>e.preventDefault());" +
    "card.addEventListener('drop',async e=>{e.preventDefault();if(!dragged||dragged===card)return;const rect=card.getBoundingClientRect();if(e.clientY<rect.top+rect.height/2)activeList.insertBefore(dragged,card);else activeList.insertBefore(dragged,card.nextSibling);try{await saveOrder();}catch(err){alert(err.message||String(err));reload();}});" +
    "card.querySelector('.tl-save').addEventListener('click',async()=>{try{const transition=card.querySelector('[data-field=transition]').value;await api('/clips/'+encodeURIComponent(card.dataset.id),{inMs:Math.round(num(card.querySelector('[data-field=in]'))*1000),outMs:Math.round(num(card.querySelector('[data-field=out]'))*1000),volume:num(card.querySelector('[data-field=volume]')),muted:card.querySelector('[data-field=muted]').checked,transitionType:transition,transitionDurationMs:transition==='CUT'?0:Math.round(num(card.querySelector('[data-field=transition-duration]'))*1000)});reload();}catch(err){alert(err.message||String(err));}});" +
    "card.querySelector('.tl-delete').addEventListener('click',async()=>{try{await api('/clips/'+encodeURIComponent(card.dataset.id),{deleted:true});reload();}catch(err){alert(err.message||String(err));}});" +
    "card.querySelectorAll('.tl-move').forEach(btn=>btn.addEventListener('click',async()=>{const dir=Number(btn.dataset.dir);const cards=[...activeList.querySelectorAll('.tl-clip')];const i=cards.indexOf(card),j=i+dir;if(j<0||j>=cards.length)return;if(dir<0)activeList.insertBefore(card,cards[j]);else activeList.insertBefore(cards[j],card);try{await saveOrder();}catch(err){alert(err.message||String(err));reload();}}));" +
    "});" +
    "document.querySelectorAll('.tl-restore').forEach(btn=>btn.addEventListener('click',async()=>{const card=btn.closest('[data-id]');try{await api('/clips/'+encodeURIComponent(card.dataset.id),{deleted:false});reload();}catch(err){alert(err.message||String(err));}}));" +
    "document.querySelectorAll('.tl-remove-text').forEach(btn=>btn.addEventListener('click',async()=>{const item=btn.closest('[data-id]');try{await api('/text/'+encodeURIComponent(item.dataset.id)+'/delete');reload();}catch(err){alert(err.message||String(err));}}));" +
    "document.getElementById('tl-add-text').addEventListener('click',async()=>{const error=document.getElementById('tl-text-error');error.textContent='';try{await api('/text',{kind:document.getElementById('tl-text-kind').value,text:document.getElementById('tl-text-value').value,position:document.getElementById('tl-text-position').value,fontScale:num(document.getElementById('tl-text-scale')),startMs:Math.round(num(document.getElementById('tl-text-start'))*1000),endMs:Math.round(num(document.getElementById('tl-text-end'))*1000)});reload();}catch(err){error.textContent=err.message||String(err);}});" +
    "const fileToDataUrl=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||new Error('读取文件失败'));reader.readAsDataURL(file);});" +
    "document.getElementById('tl-upload-bgm').addEventListener('click',async()=>{const error=document.getElementById('tl-bgm-error');error.textContent='';const file=document.getElementById('tl-bgm-file').files[0];if(!file){error.textContent='请选择音频文件';return;}try{const base64=await fileToDataUrl(file);await api('/bgm',{audio:{name:file.name,mimeType:file.type||'audio/mpeg',base64},volume:num(document.getElementById('tl-bgm-volume'))});reload();}catch(err){error.textContent=err.message||String(err);}});" +
    "document.getElementById('tl-remove-bgm')?.addEventListener('click',async()=>{try{await api('/bgm/remove');reload();}catch(err){alert(err.message||String(err));}});" +
    "document.getElementById('tl-reset')?.addEventListener('click',async()=>{if(!confirm('确认丢弃当前剪辑修改，并重新从已采用镜头建立？'))return;try{await api('/reset');reload();}catch(err){document.getElementById('tl-main-error').textContent=err.message||String(err);}});" +
    "document.getElementById('tl-confirm')?.addEventListener('click',async()=>{const btn=document.getElementById('tl-confirm'),error=document.getElementById('tl-main-error');btn.disabled=true;error.textContent='';try{await api('/confirm');reload();}catch(err){error.textContent='确认剪辑方案失败：'+(err.message||String(err));btn.disabled=false;}});" +
    "document.getElementById('tl-render-final')?.addEventListener('click',async()=>{const btn=document.getElementById('tl-render-final'),error=document.getElementById('tl-main-error');btn.disabled=true;error.textContent='正在进行最终渲染…';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/final/render',{method:'POST'});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||'最终渲染失败');location.href='/projects/'+encodeURIComponent(projectId)+'/final';}catch(err){error.textContent='最终渲染失败：'+(err.message||String(err));btn.disabled=false;}});" +
    "const video=document.getElementById('tl-preview-video'),overlay=document.getElementById('tl-preview-overlay'),time=document.getElementById('tl-preview-time');" +
    "let previewIndex=-1,playing=false;" +
    "const offsets=[];let cursor=0;for(let i=0;i<data.clips.length;i++){offsets.push(cursor);const c=data.clips[i];cursor+=c.outMs-c.inMs;if(i<data.clips.length-1&&c.transitionType!=='CUT')cursor-=c.transitionDurationMs;}" +
    "const showOverlay=globalMs=>{const item=data.textItems.find(x=>globalMs>=x.startMs&&globalMs<x.endMs);if(!item){overlay.hidden=true;return;}overlay.hidden=false;overlay.dataset.position=item.position;overlay.textContent=item.text;};" +
    "const loadClip=i=>{if(i>=data.clips.length){playing=false;video.pause();time.textContent=(cursor/1000).toFixed(2)+'s / '+(cursor/1000).toFixed(2)+'s';showOverlay(cursor);return;}previewIndex=i;const c=data.clips[i];video.src='/api/artifacts/'+encodeURIComponent(c.artifactId)+'/content';video.volume=Math.max(0,Math.min(1,c.volume));video.muted=Boolean(c.muted)||c.volume===0;video.onloadedmetadata=()=>{video.currentTime=c.inMs/1000;video.play().catch(()=>{});};};" +
    "video.addEventListener('timeupdate',()=>{if(!playing||previewIndex<0)return;const c=data.clips[previewIndex];const local=Math.max(0,video.currentTime*1000-c.inMs);const global=Math.min(cursor,offsets[previewIndex]+local);time.textContent=(global/1000).toFixed(2)+'s / '+(cursor/1000).toFixed(2)+'s';showOverlay(global);if(video.currentTime*1000>=c.outMs-25)loadClip(previewIndex+1);});" +
    "document.getElementById('tl-preview-play').addEventListener('click',()=>{if(!data.clips.length)return;playing=true;loadClip(0);});" +
    "document.getElementById('tl-preview-stop').addEventListener('click',()=>{playing=false;video.pause();previewIndex=-1;time.textContent='0.00s / '+(cursor/1000).toFixed(2)+'s';overlay.hidden=true;});" +
    "})();" +
    "</script>";

  const target = timeline.renderConfig;
  return `<section class="card"><h3>自动剪辑与声音</h3><p><a class="primary" href="/projects/${encodeURIComponent(workspace.project.id)}/auto-edit">按已采用镜头自动剪辑</a> <a href="/projects/${encodeURIComponent(workspace.project.id)}/smart">返回一键成片编排</a></p><p class="muted">自动剪辑会保留此时间线历史版本；旁白、音效与背景音乐可在下方逐条微调。</p>${target ? `<p>最终输出尺寸：${target.width} × ${target.height}</p>` : ""}</section>` + body + renderTimelineAudioEditor(timeline) +
    (target ? `<style>.tl-preview-stage{aspect-ratio:${target.width}/${target.height}}</style>` : "");
}
