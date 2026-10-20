import type {CreativeReferenceService} from "../application/services/creative-reference-service.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";
export type ReferencePageData=Awaited<ReturnType<CreativeReferenceService["pageData"]>>;
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const roles:Record<string,string>={PRODUCT_ANGLE:"产品外观 / 多角度",WEARING_REFERENCE:"佩戴 / 安装位置",USAGE_ACTION_REFERENCE:"使用动作",SCENE_REFERENCE:"场景参考",LOGO_REFERENCE:"包装 / 标志参考"};
const categories:Record<string,string>={APPEARANCE:"产品外观",ANGLE:"多角度",WEARING:"佩戴方式",USAGE:"使用方法",DETAIL:"产品细节",SCENE:"场景",PACKAGING_LOGO:"包装 / 标志",VIDEO_FRAME:"视频抽帧"};
const status:Record<string,string>={REVIEWABLE:"可审核",BLOCKED:"不可加入",DUPLICATE:"重复候选",ANALYSIS_FAILED:"分析失败",WAITING_FOR_TRUTH:"等待产品事实确认"};
export function renderCreativeReferencePage(project:{id:string;name:string},data:ReferencePageData):string{
 const selected=new Map(data.set?.entries.map(e=>[e.candidateId,e])??[]),decisions=new Map(data.decisions.map(d=>[d.candidateId,d.decision]));
 const cards=data.candidates.map(c=>`<article class="candidate" data-id="${esc(c.id)}" data-hash="${esc(c.contentHash)}" data-categories="${esc((c.assessment?.categories??[]).concat(c.mediaKind==="VIDEO_FRAME"?["VIDEO_FRAME"]:[]).join(','))}">
 <label class="pick"><input class="candidate-pick" type="checkbox">选择此候选</label><img loading="lazy" src="/api/artifacts/${encodeURIComponent(c.artifactId)}/content" alt="${esc(c.title)}">
 <h3>${esc(c.title||"研究图片")}</h3><p>${esc(status[c.status])}${selected.has(c.id)?" · 已在确认集合中":""}${decisions.get(c.id)==="IGNORE"?" · 已忽略":decisions.get(c.id)==="UNTRUSTED"?" · 已标记不可信":""}</p>
 <p>${esc((c.assessment?.categories??[]).map(t=>categories[t]).join(' / '))} · ${c.width}×${c.height}</p>
 <p>${esc(c.assessment?.description??"尚无可用视觉分析")}</p><p class="muted">身份判断：${esc(c.assessment?.identityReason??"等待分析")}</p>
 <p class="muted">来源：${c.sourceTrust==="DECLARED_OFFICIAL"?"声明为官方（非系统背书）":c.sourceTrust==="USER_SUPPLIED"?"用户提供":"公开来源，尚未核实"} · <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">原网页</a></p>
 ${c.timestampMs===undefined?"":`<p>视频采样 ${Number(c.frameIndex)+1} · 定位目标 ${(c.timestampMs/1000).toFixed(2)} 秒（非逐帧时间戳）</p><a href="/api/artifacts/${encodeURIComponent(c.sourceArtifactId)}/content#t=${c.timestampMs/1000}" target="_blank" rel="noopener">查看来源视频</a>`}
 <p class="error">${esc(c.blockers.join('；'))}${c.status==="REVIEWABLE"&&!c.availableRoles.length?"当前产品事实或主图已变化，需要重新分析":""}</p><p class="muted">${esc(c.assessment?.risks.join('；'))}</p>
 <select class="candidate-role" ${c.availableRoles.length?"":"disabled"}>${c.availableRoles.map(r=>`<option value="${r}" ${selected.get(c.id)?.role===r?"selected":""}>${roles[r]}</option>`).join('')}</select>
 <button data-decision="INCLUDE" ${c.availableRoles.length?"":"disabled"}>加入创作参考</button><button data-decision="REMOVE" ${selected.has(c.id)?"":"disabled"}>移出参考</button><button data-decision="IGNORE">忽略</button><button data-decision="UNTRUSTED">标记不可信</button><button data-reanalyze="1">重新分析</button></article>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>创作参考素材池 · ${esc(project.name)}</title><style>body{font:16px/1.6 system-ui;margin:0;background:#f5f6f8;color:#17212b}main{max-width:1180px;margin:24px auto;padding:0 20px}a{color:#225a88}.toolbar,.candidate{background:white;border:1px solid #d6dce2;border-radius:10px;padding:18px;margin:15px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}.candidate img{display:block;width:100%;height:200px;object-fit:contain;background:#f3f4f5}.candidate[hidden]{display:none}h3{font-size:18px;overflow-wrap:anywhere}.muted{font-size:14px;color:#596978}.error{color:#a32020}button,select,input{font:inherit}button{margin:8px 6px 0 0;padding:7px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}select{max-width:100%;padding:8px}.pick{display:block;margin-bottom:10px}${pvsGlobalStyles}</style></head><body>${renderPvsGlobalHeader("studio", { project })}<main data-project="${esc(project.id)}" data-revision="${data.revision}" data-truth="${esc(data.truthHash)}">
 <nav aria-label="本项目导航"><a href="/projects/${encodeURIComponent(project.id)}/smart">返回制作工作台</a> · <a href="/projects/${encodeURIComponent(project.id)}/research">返回研究</a> · <a href="/projects/${encodeURIComponent(project.id)}/truth">产品事实审核</a> · <a id="smart-reference-return" hidden href="/projects/${encodeURIComponent(project.id)}/smart">返回原智能生成任务</a></nav><h1>创作参考素材池</h1><p>${esc(project.name)} · 候选 ${data.candidates.length} 条 · 已确认参考 ${data.set?.entries.length??0} 条</p>
 ${data.identityBlocker?`<p class="error" role="alert">${esc(data.identityBlocker)}。本页保留预览，加入参考与创作不会绕过主图检查。</p>`:""}
 <p>候选图片不是产品事实。只有你明确选择的参考才可进入创作；主图、颜色、结构和已确认使用规则仍优先。修改已确认集合会使旧创意、分镜和未用生成审批失效，历史记录保留。</p>
 <section class="toolbar"><button id="collect-reference">从已有研究提取候选</button><p class="muted">提取和重新分析会使用当前配置的研究模型；不会提交即梦视频生成。缺少可下载媒体时会说明，不绕过登录或网站限制。</p><label>分类 <select id="category-filter"><option value="">全部</option>${Object.entries(categories).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
 <p><label><input id="rights-confirmed" type="checkbox">我已核对选中素材，并确认有权将它们用于本项目创作参考。</label></p><button id="select-visible">选择当前可见候选</button><button data-bulk="INCLUDE">批量加入</button><button data-bulk="REMOVE">批量移出</button><button data-bulk="IGNORE">批量忽略</button><button data-bulk="UNTRUSTED">批量标记不可信</button><p id="reference-message" role="status"></p></section>
 <div class="grid">${cards||'<p>尚无候选。先完成深度研究，再提取图片与视频帧；产品事实未确认时只能留存待审候选。</p>'}</div></main>${referenceBrowserScript}</body></html>`;
}
const referenceBrowserScript=`<script>
(()=>{const root=document.querySelector('main'),base='/api/projects/'+encodeURIComponent(root.dataset.project)+'/creative-references',message=document.querySelector('#reference-message');let busy=false;
const fromRun=new URLSearchParams(location.search).get('fromSmartRun');
const returnLink=document.querySelector('#smart-reference-return');
if(returnLink&&fromRun&&/^[A-Za-z0-9_-]{6,128}$/.test(fromRun)){
  const projectId=root.dataset.project;
  fetch('/api/projects/'+encodeURIComponent(projectId)+'/smart-runs/'+encodeURIComponent(fromRun))
    .then(async response=>response.ok?response.json():null)
    .then(data=>{if(data?.run?.id!==fromRun||data?.run?.projectId!==projectId)return;
      returnLink.href='/projects/'+encodeURIComponent(projectId)+'/smart#smart-run-'+encodeURIComponent(fromRun);
      returnLink.hidden=false;
    }).catch(()=>{});
}
async function send(endpoint,payload){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent='正在处理，请勿重复提交…';try{const r=await fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw Error(d.message||'操作失败');if(d.failures?.length){message.textContent=d.failures.join('；');const a=document.createElement('a');a.href=location.href;a.textContent=' 刷新查看已留存候选';message.append(a);}else location.reload();}catch(e){message.textContent=e.message+'；请刷新核对实际结果。';}}
function review(cards,decision){if(!cards.length){message.textContent='请选择候选。';return;}if(!root.dataset.truth){message.textContent='请先确认产品事实。';return;}if(decision==='INCLUDE'&&!document.querySelector('#rights-confirmed').checked){message.textContent='加入参考前必须明确确认素材使用权。';return;}if(decision==='INCLUDE'&&cards.some(c=>!c.querySelector('.candidate-role').value)){message.textContent='选中内容包含不可加入的候选，请先处理身份或使用规则问题。';return;}send('/review',{expectedRevision:Number(root.dataset.revision),expectedTruthHash:root.dataset.truth,acknowledgeRights:document.querySelector('#rights-confirmed').checked,changes:cards.map(c=>({candidateId:c.dataset.id,candidateHash:c.dataset.hash,decision,...(decision==='INCLUDE'?{role:c.querySelector('.candidate-role').value}:{})}))});}
for(const c of document.querySelectorAll('.candidate')){for(const b of c.querySelectorAll('[data-decision]'))b.onclick=()=>review([c],b.dataset.decision);c.querySelector('[data-reanalyze]').onclick=()=>send('/reanalyze',{candidateId:c.dataset.id});}
for(const b of document.querySelectorAll('[data-bulk]'))b.onclick=()=>review([...document.querySelectorAll('.candidate')].filter(c=>!c.hidden&&c.querySelector('.candidate-pick').checked),b.dataset.bulk);
document.querySelector('#category-filter').onchange=e=>{for(const c of document.querySelectorAll('.candidate'))c.hidden=Boolean(e.target.value&&!c.dataset.categories.split(',').includes(e.target.value));};
document.querySelector('#select-visible').onclick=()=>{for(const c of document.querySelectorAll('.candidate'))if(!c.hidden)c.querySelector('.candidate-pick').checked=true;};document.querySelector('#collect-reference').onclick=()=>send('/collect',{});
})();</script>`;
