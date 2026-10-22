import type { AgentCycle } from "../domain/agent-cycle.js";
import { renderPvsGlobalHeader, pvsGlobalStyles } from "./pvs-global-shell.js";
import type { ProjectWorkspace } from "../application/services/product-flow.js";
import type { SmartGenerationRun } from "../domain/smart-generation.js";
import type { ProductionQuote } from "../domain/generation-quote.js";
import type {CanvasShortPreview} from "../domain/canvas-short-preview.js";
import type {CanvasShortPlan} from "../domain/canvas-short-plan.js";
import {renderOperationsOverview} from "./operations-evidence-ui.js";
import type {OperationsOverview} from "../application/services/operations-evidence-reader.js";

const escape=(text:unknown)=>String(text??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
const labels:Record<string,string>={READY:"准备继续",RUNNING:"后台处理中",WAITING_USER:"需要补充信息",WAITING_CONFIRMATION:"等待你确认具体动作",BLOCKED:"需要处理阻断",OUTCOME_UNKNOWN:"结果待核对，请勿重发",COMPLETED:"本轮目标已完成",CANCELLED:"已停止后续处理"};
export function renderAgentCyclePage(input:{project?:{id:string;name:string};projects:Array<{id:string;name:string}>;cycles:AgentCycle[];skills:Array<{id:string;title:string}>;snapshot?:Record<string,unknown>;operationsReview?:OperationsOverview;egoLite?:{sourceUrl:string}}) {
  const projectId=input.project?.id;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent 全业务工作台 · 产品视频工作台</title><style>${pvsGlobalStyles}
  body{margin:0;font:15px/1.6 system-ui}main{max-width:1050px;margin:auto;padding:24px}section,article{background:white;border:1px solid #dce5f0;border-radius:12px;padding:20px;margin:16px 0}textarea{box-sizing:border-box;width:100%;min-height:95px;padding:12px}button{padding:10px 16px;border:1px solid #b8cbe5;border-radius:8px;background:#eaf2ff;cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:#63758d}.message{padding:8px;border-bottom:1px solid #edf1f7}.error{color:#a31a20}.actions{display:flex;gap:12px;flex-wrap:wrap}.badge{font-weight:700}.review{background:#fff8e7;padding:15px;border-radius:8px}.stage{display:inline-block;background:#eef4fc;padding:3px 10px;border-radius:15px;margin:3px}</style>
  ${renderPvsGlobalHeader("agent-cycle",input.project?{project:input.project}:{})}<main><h1>智能业务工作台</h1>
  <p>行业视频研究 → 策略创作 → 视频生产 → 发布与作品关联 → 数据和评论运营 → 复盘反馈下一轮</p>
  ${!projectId?`<section><h2>选择已有项目</h2>${input.projects.map(project=>`<p><a href="/projects/${encodeURIComponent(project.id)}/agent-cycle">${escape(project.name)} · 打开 Agent 工作台</a></p>`).join("")}<a href="/projects">新建或管理项目</a></section>`:`
  ${renderCheckpoint(input.snapshot)}
  <section aria-label="Ego Lite 本机接入"><h2>Ego Lite 本机只读采集</h2>${input.egoLite?`<p>执行器已配置。准备后会展示本次来源，待你确认再启动独立浏览器读取和截图。</p><p>来源：<a href="${escape(input.egoLite.sourceUrl)}" target="_blank" rel="noopener">本机合成页面</a>。仅用于验证，内容不是商品事实。</p><button id="ego-lite-prepare" type="button">准备本机页面采集</button><p id="ego-lite-error" role="alert" class="error"></p>`:'<p>本机执行器尚未配置，暂不能开始采集。</p>'}</section>
  ${input.snapshot?.feedbackReadError||(input.snapshot?.operations as {insightReadError?:boolean}|undefined)?.insightReadError?'<p role="alert">部分保存反馈或复盘暂不可核验；已保留原记录，没有作为新输入使用。</p>':""}
  ${(input.snapshot?.operations as {metricReadError?:boolean}|undefined)?.metricReadError?'<p role="alert">保存指标暂不可核验；原记录已保留，没有作为新输入使用，也不把读取失败解释为零或没有观察。</p>':""}
  ${renderOperationsOverview(projectId,input.operationsReview)}
  <section><h2>${input.cycles.some(c=>!["COMPLETED","CANCELLED"].includes(c.status))?"已有任务可在下方继续；新目标另开一轮":"这次想完成什么？"}</h2><form id="goal-form"><textarea id="goal" required minlength="3" maxlength="6000" placeholder="例如：研究这个行业的同类视频，结合产品资料制作一条广告；发布后收集指标和评论，复盘并形成下一轮创意。"></textarea><p class="muted">Agent在后台调用自有技能和业务工具，沿用当前已确认资料。付费生成、发布和回复前展示具体内容请你确认；价格未核实不会请求扣费。</p><button type="submit">开始新一轮 Agent 任务</button></form><p id="error" role="alert" class="error"></p></section>
  <section><h2>我们的业务技能</h2>${input.skills.map(skill=>`<span class="stage">${escape(skill.title)}</span>`).join("")}</section><div id="cycles">${input.cycles.map(renderCycle).join("")||"<p>暂无 Agent 任务。现有项目资料不会因打开本页而改变。</p>"}</div>
  <script>const projectId=${JSON.stringify(projectId)?.replace(/</g,"\\u003c")},base='/api/projects/'+encodeURIComponent(projectId)+'/agent-cycles';let busy=false,typing=false;
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function post(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.message||data.error||'操作未完成');return data.result;}
  const egoLiteSource=${JSON.stringify(input.egoLite?.sourceUrl??null).replace(/</g,"\\u003c")};
  document.querySelector('#ego-lite-prepare')?.addEventListener('click',async event=>{if(busy)return;busy=true;event.target.disabled=true;try{const key='pvs-ego-lite-proposal:'+projectId+':'+egoLiteSource;let requestKey=sessionStorage.getItem(key);if(!requestKey){requestKey=crypto.randomUUID();sessionStorage.setItem(key,requestKey);}const goal='只读采集本机合成页面，保存正文和截图供审阅';const cycle=await post(base,{goal,requestKey,stages:['RESEARCH']});await post(base+'/'+encodeURIComponent(cycle.id)+'/invoke',{capabilityId:'research.collect-evidence',arguments:{goal,sourceUrls:[{url:egoLiteSource,sourceType:'USER_URL'}]},requestKey:requestKey+'-read'});sessionStorage.removeItem(key);location.reload();}catch(error){document.querySelector('#ego-lite-error').textContent=error.message;}finally{busy=false;event.target.disabled=false;}});
  const requestStorageKey='pvs-agent-goal-request:'+projectId;let goalRequest=null;
  try{const saved=JSON.parse(sessionStorage.getItem(requestStorageKey)||'null');if(saved&&typeof saved.goal==='string'&&typeof saved.requestKey==='string'&&saved.requestKey.length>0&&saved.requestKey.length<=120)goalRequest=saved;}catch{}
  function goalRequestKey(goal){if(!goalRequest||goalRequest.goal!==goal){goalRequest={goal,requestKey:crypto.randomUUID()};try{sessionStorage.setItem(requestStorageKey,JSON.stringify(goalRequest));}catch{}}return goalRequest.requestKey;}
  document.querySelector('#goal-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;try{const goal=document.querySelector('#goal').value.trim();await post(base,{goal,requestKey:goalRequestKey(goal)});location.reload();}catch(error){document.querySelector('#error').textContent=error.message;}finally{busy=false;}});
  document.addEventListener('focusin',event=>{if(event.target.matches('textarea'))typing=true;});document.addEventListener('focusout',()=>typing=false);
  document.addEventListener('click',async event=>{const button=event.target.closest('button[data-action]');if(!button||busy)return;const card=button.closest('[data-cycle]'),id=card.dataset.cycle,revision=Number(card.dataset.revision),action=button.dataset.action;let payload={expectedRevision:revision};if(action==='confirm'){payload={...payload,actionId:button.dataset.actionId,inputHash:button.dataset.hash};if(!confirm('确认执行上方展示的这一项具体动作？授权不覆盖其他发布、回复或新的生成。'))return;}if(action==='reply'){payload.text=card.querySelector('textarea').value;if(!payload.text.trim())return;}if(action==='advance'){button.disabled=true;void post(base+'/'+encodeURIComponent(id)+'/'+action,{}).then(()=>location.reload()).catch(error=>{card.querySelector('[role=alert]').textContent=error.message;button.disabled=false;});return;}busy=true;button.disabled=true;try{await post(base+'/'+encodeURIComponent(id)+'/'+action,payload);location.reload();}catch(error){card.querySelector('[role=alert]').textContent=error.message;}finally{busy=false;button.disabled=false;}});
  setInterval(async()=>{if(busy||typing)return;try{const r=await fetch(base);if(!r.ok)return;const data=await r.json();const versions=Array.from(document.querySelectorAll('[data-cycle]')).map(n=>n.dataset.cycle+':'+n.dataset.revision+':'+n.dataset.executionVersion).join('|');const current=data.result.map(n=>n.id+':'+n.revision+':'+(n.actions.at(-1)?.localExecution?.version??0)).join('|');if(versions!==current)location.reload();}catch{}},1000);
  </script>`}
  </main></html>`;
}
function renderCheckpoint(snapshot?:Record<string,unknown>) {
  if (!snapshot?.workspace) return "";
  const w=snapshot.workspace as ProjectWorkspace;
  const runs=(snapshot.production??[]) as SmartGenerationRun[];
  const run=runs.find(r=>!["COMPLETED","CANCELLED"].includes(r.status));
  const shortPlan=run?.canvasShortPlans?.at(-1);
  const shortDelivered=shortPlan?.status==="DELIVERED"&&Boolean(shortPlan.final?.acceptedAt);
  const shortVideoState=shortDelivered?"15秒成片已确认并可下载":shortPlan?.attemptIds.length?"视频已提交，沿原任务核对结果，不自动重提":shortPlan?.consent?"本次视频范围已有用户确认，执行前仍须核价":"视频尚未授权";
  const visualRevision=run?.canvasShortPlans?.at(-1)?.visualRevisions?.at(-1);
  const planning=(snapshot.productionPlanning??[]) as Array<{contentType:string;assets:Array<{status:string;label:string}>;costStatus:string}>;
  const assets=run?.productionAssetSet?.entries??planning[0]?.assets??[];
  const needed=assets.filter(a=>!("source" in a)||a.source==="DREAMINA_GENERATED");
  const generated=needed.filter(a=>"artifactIds" in a&&Array.isArray(a.artifactIds)&&a.artifactIds.length);
  const research=snapshot.research as {runs?:Array<{browserState?:{marketVideoResearch?:{candidates?:Array<{status:string}>}}}>}|undefined;
  const candidates=research?.runs?.flatMap(r=>r.browserState?.marketVideoResearch?.candidates??[])??[];
  const analyzed=candidates.filter(c=>c.status==="ANALYZED").length;
  const final=snapshot.final as {status?:string;id?:string}|null;
  const publication=snapshot.publication as {packages?:Array<{id:string;finalAssemblyId:string}>;receipts?:Array<{packageId:string;trusted:boolean;kind:string}>}|undefined;
  const published=publication?.receipts?.some(r=>r.trusted&&r.kind==="PUBLISHED_CONFIRMED"&&publication.packages?.some(p=>p.id===r.packageId&&p.finalAssemblyId===final?.id));
  const production=shortDelivered?"15秒成片已确认并可下载，原60秒任务单独保留":run?.status==="READY_FOR_ASSET_PAID_CONFIRM"?"待核实角色与场景费用，未生成":final?.status==="ACCEPTED"?"成片已审阅":run?"沿原任务推进中":w.script&&w.productionPlan?"已有脚本与分镜，待接入执行任务":w.script?"已有脚本，分镜尚未准备":"脚本与分镜尚未准备";
  const observation = (snapshot.operations as {binding?:{source?:string;awemeId?:string;workDescription?:string}}|undefined)?.binding;
  const historical = observation?.source === "HISTORICAL_WORK";
  const stages=[ ["行业视频搜索与分析",`${candidates.length}条已保存候选，${analyzed}条已分析`],
    ["营销策略",w.project.selectedCreativeId?"已采用创意方案":"待选择方案"],
    ["视频制作",production], ["发布与作品关联",published?"当前成片已有可信发布回执":shortDelivered?"成片已审阅，发布须独立确认":"待成片审阅与发布确认"],
    ["指标、评论与楼中楼",historical?`独立验证历史作品 ${observation.awemeId} 的采集；当前新片未发布`:published?"按当前作品的采集记录验收":"等待当前成片真实发布，不使用旧作品代替"],
    ["复盘进入下一轮创意",historical?"历史作品反馈仅用于表达方向；以实际复盘和下一轮输入回执验收":published?"待验证实际数据进入下一轮创意":"等待当前作品运营证据"] ];
  return `<section aria-label="当前项目业务检查点"><h2>当前项目与完整业务进度</h2>
    <p>${visualRevision?"原60秒方案：":""}脚本${w.script?`v${w.script.version} · ${w.script.status==="CONFIRMED"?"已确认":"待审阅"}`:"尚未准备"}；分镜${w.productionPlan?`v${w.productionPlan.version} · ${w.productionPlan.status==="CONFIRMED"?"已确认":"待审阅"}`:"尚未准备"}。${visualRevision?"新版15秒采用仿真人AI短剧情节植入，按新版审核与参考状态继续。":(run?.productionStrategy?.contentType??planning[0]?.contentType)==="SHORT_DRAMA"?"沿用漫剧情节植入广告方向。":""}</p>
    <p>${visualRevision?`仿真人新版：${visualRevision.designReview?"文字分镜已确认":"文字分镜待审核"}；${run?.canvasShortPlans?.at(-1)?.referenceImage?.artifact?(run?.canvasShortPlans?.at(-1)?.referenceImage?.review?"同框参考图1张已由用户采用":"同框参考图1张已下载，等待用户审核"):"新同框参考图按当前授权状态处理"}。旧三张二维图保留在历史任务中，不用于新版；${shortVideoState}。发布须独立确认。`:`新增设定图：${generated.length}/${needed.length}张已生成，${needed.filter(a=>a.status==="NEEDS_REVIEW").length}张待审核，${needed.filter(a=>a.status==="READY").length}张已采用。${run?.assetConsent?"设定图按已确认范围生成；视频生成和发布尚需分别确认。":run?.assetPaidScope?.assets.some(a=>a.costStatus==="UNKNOWN")?"后台生成费用尚未核实；未获得费用授权。":"费用以当前具体生成范围为准。"}`}</p>
    ${generated.length&&!visualRevision?`<section aria-label="已生成的设定图"><h3>本轮真实设定图</h3><div style="display:flex;gap:16px;flex-wrap:wrap">${generated.map(a=>{const entry=a as NonNullable<SmartGenerationRun["productionAssetSet"]>["entries"][number];return `<figure style="margin:0;max-width:260px"><a href="/api/artifacts/${encodeURIComponent(entry.artifactIds[0]!)}/content" target="_blank" rel="noopener"><img loading="lazy" style="width:220px;height:200px;object-fit:contain" src="/api/artifacts/${encodeURIComponent(entry.artifactIds[0]!)}/content" alt="${escape(entry.label)}设定图"></a><figcaption>${escape(entry.label)} · ${entry.status==="READY"?"已采用":"待审核"}</figcaption><details><summary>查看检查意见</summary><p>${escape(entry.reviewSummary)}</p></details></figure>`;}).join("")}</div><p><a href="/projects/${encodeURIComponent(w.project.id)}/smart?activeRun=${encodeURIComponent(run!.id)}">进入原制作任务审阅设定图</a>；核价不等于采用这些图片，不会自动重做。</p></section>`:""}
    ${visualRevision?`<details><summary>原方案历史报价（不适用于仿真人新版）</summary>${renderProductionQuote(run?.feeQuote)}${renderCanvasShortPreview(run?.canvasShortPreviews?.at(-1))}</details>`:`${renderProductionQuote(run?.feeQuote)}${renderCanvasShortPreview(run?.canvasShortPreviews?.at(-1))}`}
    ${renderCanvasShortPlan(run?.canvasShortPlans?.at(-1))}
    <ol>${stages.map(([name,state])=>`<li><b>${escape(name)}</b>：${escape(state)}</li>`).join("")}</ol>
    <p class="muted">本页读取当前项目记录；任务历史中的旧版本仅供追溯。发布、评论运营和下一轮反馈缺少真实结果时，整轮不会标记完成。</p></section>`;
}
export function renderProductionQuote(quote?: ProductionQuote) {
  if (!quote) return "";
  const valid = quote.status === "QUOTED" && Boolean(quote.expiresAt && Date.parse(quote.expiresAt) > Date.now());
  const ceiling = quote.items.some(i => i.result.status === "QUOTED" && i.result.kind === "CREDIT_CEILING");
  const images = quote.items.filter(i => i.request.kind === "IMAGE").length;
  const videos = quote.items.filter(i => i.request.kind === "VIDEO").length;
  return `<section aria-label="后台制作报价"><h3>后台制作费用：${images}张设定图、${videos}段视频</h3>
    <p>${valid ? (ceiling ? "已取得后台最高消耗报价，不代表最终实际扣费；仍须通道检查和你的预算确认。" : "已取得本次范围的后台报价，仍须生成通道检查和你的付费确认。") : "实际总费用尚未取得有效报价，暂不能确认付费。"}</p>
    <table><thead><tr><th>项目</th><th>生成规格</th><th>本项积分</th></tr></thead><tbody>${quote.items.map(i => `<tr><td>${escape(i.request.label)}</td><td>${escape(i.result.status==="QUOTED"?i.result.canvas?.canonicalModel??i.request.model:i.request.model)} · ${escape(i.request.resolution)} · ${escape(i.request.aspectRatio)} · ${i.request.durationMs ? `${i.request.durationMs / 1000}秒` : `${i.request.count}张`}</td><td>${i.result.status === "QUOTED" && Date.parse(i.result.expiresAt)>Date.now() ? `${i.result.kind==="CREDIT_CEILING"?"最高":""}${i.result.credits}积分` : "待报价"}</td></tr>`).join("")}</tbody></table>
    <p><b>总费用：${valid ? (quote.grandTotal ? `${quote.grandTotal.kind === "CREDIT_CEILING" ? "最高" : ""}${quote.grandTotal.credits}积分；` : "不同计费账户/来源分别列示；") + quote.totals.map(t => `${t.providerId === "domestic-jimeng-image-cli" ? "设定图" : "视频"}${t.kind === "CREDIT_CEILING" ? "最高" : ""}${t.credits}积分`).join("；") : "待核实（缺项不按0积分计算）"}</b></p>
    ${quote.missingInterfaces.map(m => `<p>${m.providerId === "domestic-jimeng-image-cli" ? "图片通道" : "视频通道"}：${escape(m.message)}</p>`).join("")}
    <p class="muted">沿用原项目和制作任务；报价查询未提交生成。付费生成和发布分别需要你确认。</p></section>`;
}
export function renderCanvasShortPreview(p?:CanvasShortPreview){
  if(!p)return "";
  const modelLabel:Record<string,string>={"seedance_2.0_fast_vip":"Seedance 2.0 快速版","seedance_2.0_vip":"Seedance 2.0 标准版","seedance_2.5":"Seedance 2.5"};
  const recommended=p.candidates.find(c=>c.key===p.recommendedKey);
  return `<section aria-label="15秒独立报价方案"><h3>15秒漫剧方案：${escape(p.title)}</h3><p>独立保存的比价草稿；原60秒方案保留。统一720p、9:16、单次生成，复用现有参考图。</p>
    <table><thead><tr><th>模型</th><th>组成</th><th>积分上限</th></tr></thead><tbody>${p.candidates.map(c=>`<tr><td>${escape(modelLabel[c.model]??c.model)}</td><td>${c.generatedDurationMs/1000}秒剧情${c.localTailMs?`＋${c.localTailMs/1000}秒本地产品尾卡`:""}</td><td>${c.quote&&Date.parse(c.quote.expiresAt)>Date.now()?`最高${c.quote.maxCredits}积分`:c.quote?`报价已过期（上次最高${c.quote.maxCredits}积分）`:"待核价"}</td></tr>`).join("")}</tbody></table>
    <p>${recommended?.quote?`本次比较中积分最低：${escape(modelLabel[recommended.model]??recommended.model)}，${recommended.generatedDurationMs/1000}秒剧情${recommended.localTailMs?"＋3秒产品尾卡":""}。`:"尚无完整可用报价。"}尾卡文字：${p.tailCardText.map(escape).join("；")}。</p>
    <p>仅比较上述六项；报价为最高消耗，不保证实际质量。设定图审核、视频下载通道、正式短片计划及费用确认通过后才能生成。当前未授权视频生成或发布。</p></section>`;
}
function renderCanvasShortExecution(p:CanvasShortPlan):string{
  const revision=p.visualRevisions?.find(r=>r.contentHash===p.realisticExecution?.sourceRevisionHash);
  const clip=(p.realisticExecution?.binding??p.binding)?.nodes.find(n=>n.kind==="VIDEO")?.delivery;
  const reviewed=Boolean(clip&&p.clipReview&&p.clipReview.attemptId===clip.attemptId&&p.clipReview.artifactId===clip.artifactId&&p.clipReview.sha256===clip.sha256);
  const accepted=p.status==="DELIVERED"&&Boolean(p.final?.acceptedAt);
  const statuses:Record<string,string>={AUTHORIZED:"已确认本次生成范围，尚未提交",GENERATING:"正在接收原生成任务，不自动重提",CLIP_REVIEW:"待审看12秒实际视频",CLIP_ACCEPTED:"镜头已采用，待本地合成",FINAL_REVIEW:"待审看15秒实际成片",DELIVERED:accepted?"成片已确认并可下载":"成片确认回执待核对",BLOCKED:"原任务需要核对，不自动重提"};
  const content=(id:string)=>"/api/artifacts/"+encodeURIComponent(id)+"/content";
  const references=p.realisticExecution?.payload.references??p.payload.references;
  return `<section aria-label="15秒制作执行与交付"><h3>${accepted?"已审核通过的15秒成片":"15秒制作执行与交付"}</h3><p><b>${escape(statuses[p.status]??p.status)}</b>。原60秒方案单独保留。</p>
    ${p.final?`<h4>实际15秒成片 · ${accepted?"已确认":"等待你审阅"}</h4><video controls preload="metadata" style="max-width:260px;max-height:400px" src="${content(p.final.artifactId)}"></video><p><a href="${content(p.final.artifactId)}">下载成片</a> · <a href="${content(p.final.qcArtifactId)}">质检结果</a> · <a href="${content(p.final.manifestArtifactId)}">交付清单</a></p>`:"<p>原任务按当前阶段继续，尚无15秒实际成片。</p>"}
    ${clip?.artifactId?`<details><summary>实际12秒原视频 · ${reviewed?"已采用":clip.state==="QC_FAILED"?"媒体检查未通过":"待按实际内容审核"}</summary><video controls preload="metadata" style="max-width:260px;max-height:400px" src="${content(clip.artifactId)}"></video><p>${clip.findings.map(escape).join("；")}</p></details>`:""}
    <details><summary>已确认方案与原参考回执</summary><p>方案原始标题（保留历史文字）：${escape(revision?.payload.title??p.payload.title)}</p><p>12秒快速版视频＋3秒本地尾卡；原规划最高72积分。已有许可只覆盖原一次生成，不扩展为再次生成或发布。</p>${revision?`<p>${escape(revision.payload.visualDirection)}</p><table><thead><tr><th>时段</th><th>已确认画面与动作</th></tr></thead><tbody>${(revision.payload.productionPlan.scenes[0]?.clips[0]?.segments??[]).map(s=>`<tr><td>${s.startMs/1000}–${s.endMs/1000}秒</td><td>${escape(s.subjectAction)}</td></tr>`).join("")}</tbody></table>`:""}<ul>${references.map(r=>`<li><a href="${content(r.artifactId)}">${r.key==="PRODUCT"?"原产品参考":"原同框参考"}</a></li>`).join("")}</ul></details>
    <p>发布须独立确认。需要重新生成时，须另定范围、重新核价并取得新的明确授权。</p></section>`;
}
export function renderCanvasShortPlan(p?:CanvasShortPlan):string{
  if(!p)return "";
  if(p.status==="DELIVERED"||p.visualRevisions?.length&&(p.consent||p.attemptIds.length||p.final))return renderCanvasShortExecution(p);
  const revision=p.visualRevisions?.at(-1);
  if(revision){const v=revision.payload,segments=v.productionPlan.scenes[0]!.clips[0]!.segments;
      const rq=p.referenceQuote?.revisionHash===revision.contentHash?p.referenceQuote:undefined;
      const ri=p.referenceImage?.revisionHash===revision.contentHash?p.referenceImage:undefined;
      const bq=p.boundVideoQuotes?.at(-1)?.revisionHash===revision.contentHash?p.boundVideoQuotes.at(-1):undefined;
      return `<section aria-label="仿真人15秒修订稿"><h3>${escape(v.title)}</h3><p><b>${revision.designReview?"仿真人脚本与文字设定已确认，待准备新参考图":"待你审核：仿真人脚本分镜与文字设定"}</b>。${ri?.artifact?(ri.review?"同框参考图已由用户采用":"已下载1张同框参考图，等待用户审核"):"新版参考图按当前授权状态处理"}；旧二维图不用于新版。原项目和60秒方案保留。</p>
      <p>${escape(v.visualDirection)}</p><p>参考依据：${escape(v.styleReference.description)}${escape(v.storyPremise??"借鉴视觉表现，保留现代父女剧情。")}</p>
      <p>面向：${escape(v.audience)}</p><p>产品表达：${escape(v.productMessage)}</p>
      <table><thead><tr><th>时间</th><th>镜头与画面动作</th><th>对白</th></tr></thead><tbody>${segments.map(s=>`<tr><td>${s.startMs/1000}–${s.endMs/1000}秒</td><td>${escape(s.shotSize)}；${escape(s.subjectAction)}</td><td>${escape(s.dialogueOrNarration.kind!=="NONE"?s.dialogueOrNarration.text:"")}</td></tr>`).join("")}<tr><td>12–15秒</td><td>原产品图，3秒本地产品尾卡</td><td>${v.tailCardText.map(escape).join("<br>")}</td></tr></tbody></table>
        <div style="display:flex;gap:16px;flex-wrap:wrap">${v.designs.map(d=>`<article style="flex:1;min-width:240px"><h4>${escape(d.label)}</h4><p><b>${revision.designReview?"文字设定已确认":"文字设定待审核"} · ${ri?.artifact?"同框参考图见下方":"尚无新版设定图"}</b></p><p>${escape(d.description)}</p><ul>${d.consistency.map(c=>`<li>${escape(c)}</li>`).join("")}</ul></article>`).join("")}</div>
        ${rq?`${bq?"<details><summary>此前参考报价草稿（保留历史，不作为本次实际报价）</summary>":""}<section aria-label="最少参考后台报价"><h4>最少参考方案：原产品图＋1张人物与场景同框图＋文字动作</h4><p>seedream_5.0_lite · 2K · 9:16 · 1张；seedance_2.0_fast_vip · 720p · 9:16 · 12秒。${ri?"仅同框参考图获准最高0积分；视频尚未生成":"没有提交生成"}。</p><table><thead><tr><th>报价项</th><th>实时查询结果</th></tr></thead><tbody>${(rq.items??[]).map(i=>`<tr><td>${escape(i.key==="SETTING"?"人物与书房同框参考":i.key==="VIDEO"?"实际参考范围视频":"仅产品图比较草稿（不计入实际总价）")}</td><td>${i.credits===null?`待报价：${escape(i.error??"未知")}`:`最高${i.credits}积分`}</td></tr>`).join("")}</tbody></table><p><b>实际总价：${rq.totalCredits===null?"未齐，缺项不能按0计算":`最高${rq.totalCredits}积分`}</b>。72上限不变；报价绑定草稿版本${rq.draftVersion??"待核实"}，生成前必须重验实际参考和节点。</p><p>${escape(rq.error??"")} 本次记录不产生费用或发布许可，未准备可执行的原生生成请求。</p></section>${bq?"</details>":""}`:""}
      ${ri?`<section aria-label="同框参考图审核"><h4>人物与书房同框参考图 · ${ri.review?"已由用户采用":ri.state==="NEEDS_REVIEW"?"待你审核":"原提交处理中"}</h4><p>只授权此图1张、最高0积分；视频未授权。${escape(ri.error??"")}</p>${ri.artifact?`<a target="_blank" rel="noopener" href="/api/artifacts/${encodeURIComponent(ri.artifact.id)}/content"><img style="max-width:360px;width:100%;height:auto" src="/api/artifacts/${encodeURIComponent(ri.artifact.id)}/content" alt="待审核的人物与书房同框参考图"></a><p>${ri.artifact.width}×${ri.artifact.height}；${ri.review?"已由用户明确采用；视频实际报价单独核实":"未自动采用。审核通过后再核实视频实际报价"}。</p>`:""}</section>`:""}
      ${bq?`<section aria-label="本版视频实际报价"><h4>真实产品图＋已采用同框图：本版视频实际报价</h4><p>Seedance 2.0快速版 · 720p · 9:16 · 12秒 · 1段；另加3秒本地原图尾卡。</p><table><thead><tr><th>范围</th><th>最高积分</th></tr></thead><tbody><tr><td>本轮已生成并采用同框图</td><td>0</td></tr><tr><td>绑定两张真实参考的视频</td><td>${bq.videoCredits===null?"待报价":bq.videoCredits}</td></tr><tr><td>本版合计</td><td>${bq.totalCredits===null?"未齐，缺项不计0":bq.totalCredits}</td></tr></tbody></table><p>${bq.status==="OVER_BUDGET"?"超过72积分上限，已停止":bq.status==="QUOTED"?"在72积分总上限内；这是本次已绑定参考的最高消耗报价":"报价仍有缺项："+escape(bq.error??"未知")}。视频尚未授权或提交。</p><p>报价绑定当前账号、两份实际图片、原视频节点与草稿版本${bq.draftVersion}；生成前须重验报价及执行条件，并另请你确认。</p></section>`:""}
      ${p.realisticExecution?`<section aria-label="本版执行预检"><h4>本版执行预检：${p.realisticExecution.preflight?.status==="PASS"?"已通过，待你确认具体生成范围":"有待处理项"}</h4><p>1段12秒视频，Seedance 2.0快速版，720p，9:16；真实产品图＋已采用同框参考。另加3秒本地产品尾卡，共15秒。只保留自然动作声，无对白、旁白、配音或BGM。</p><p>图片0积分＋视频最高${p.realisticExecution.feeQuote?.grandTotal?.credits??"待核实"}积分，总上限72。${p.consent?"此范围已有用户确认":"当前没有视频许可、费用批准或生成提交"}。</p><p>本机同账号实际视频下载检查：${p.realisticExecution.preflight?.delivery.ready?"通过":"未通过"}。原生视频请求：${p.realisticExecution.paidScope?.requests.length??0}个；${(p.realisticExecution.preflight?.blockers??[]).map(escape).join("；")}</p><p>报价显示的是本机检查缓存，原生请求和实际节点在确认及提交前仍须重新核验；价格上涨、未知或超过72即停，不自动重提。</p></section>`:""}
      <p><b>本套方案规划上限72积分</b>：12秒快速版视频＋3秒本地尾卡。新设定图和视频需重新核价；图片费用未知不能按0计，合计超72即停。本页不把旧72积分报价当作新版有效报价。</p>
        <p>参考方案不等于生成许可。实际设定图、视频生成和发布前分别展示具体范围请你确认；旧节点、旧二维参考图和旧许可不会自动沿用。</p>
      <details><summary>审核要点</summary><ul>${v.reviewChecklist.map(c=>`<li>${escape(c)}</li>`).join("")}</ul></details>
      <details><summary>原15秒方案历史稿（保留追溯，不用于新版生成）</summary>${renderCanvasShortPlan({...p,visualRevisions:undefined})}</details></section>`;
  }
  const status:Record<string,string>={DRAFT:"待审核脚本与分镜",PLAN_CONFIRMED:"已审核规划，待生成前检查",REQUEST_READY:"待你确认具体生成费用",AUTHORIZED:"已确认本次生成范围",GENERATING:"正在接收原生成任务",CLIP_REVIEW:"待审看12秒实际视频",CLIP_ACCEPTED:"镜头已采用，待本地合成",FINAL_REVIEW:"待审看15秒实际成片",DELIVERED:"成片已确认并可下载",BLOCKED:"有待处理项"};
  const content=(id:string)=>"/api/artifacts/"+encodeURIComponent(id)+"/content";
  const clip=p.binding?.nodes.find(n=>n.kind==="VIDEO")?.delivery;
  return `<section aria-label="15秒独立制作计划"><h3>15秒独立制作：${escape(p.payload.title)}</h3><p><b>${escape(status[p.status]??p.status)}</b>。快速版12秒剧情＋3秒本地产品尾卡，计划积分上限72；此上限尚不代表已授权扣费。原60秒方案保留。</p>
    <table><thead><tr><th>时段</th><th>画面、对白和产品植入</th></tr></thead><tbody>${p.payload.script.beats.map((b,i)=>`<tr><td>${["0–3秒","3–8秒","8–12秒","12–15秒"][i]??""}</td><td>${escape(b.text)}</td></tr>`).join("")}</tbody></table>
      ${p.feeQuote?`<h4>本15秒方案的后台报价</h4>${renderProductionQuote(p.feeQuote)}`:"<p>本15秒方案尚需刷新后台实际报价；72积分是计划上限。</p>"}
      <p>需要审核父女身份和对白、剧情转折、产品外观、未夸大功效，以及尾卡可读性。设定图仍需分别审核；费用确认、镜头采用、成片确认是独立动作。</p>
    ${p.tailPreview?`<h4>3秒尾卡预览（不是完整成片）</h4><video controls preload="metadata" style="max-width:260px;max-height:400px" src="${content(p.tailPreview.artifactId)}"></video>`:""}
    ${clip?.artifactId?`<h4>实际12秒视频 · ${clip.state==="QC_FAILED"?"媒体检查未通过":"待按实际内容审核"}</h4><video controls preload="metadata" style="max-width:260px;max-height:400px" src="${content(clip.artifactId)}"></video><p>${clip.findings.map(escape).join("；")}</p>`:""}
    ${p.final?`<h4>实际15秒成片 · ${p.final.acceptedAt?"已确认":"等待你审阅"}</h4><video controls preload="metadata" style="max-width:260px;max-height:400px" src="${content(p.final.artifactId)}"></video><p><a href="${content(p.final.artifactId)}">下载成片</a> · <a href="${content(p.final.qcArtifactId)}">质检结果</a> · <a href="${content(p.final.manifestArtifactId)}">交付清单</a></p>`:"<p>尚无15秒实际成片，没有把测试片或尾卡预览计为成片交付。</p>"}
    <p>发布前另行确认。</p></section>`;
}
function renderCycle(cycle:AgentCycle) {
  const pending=cycle.actions.find(action=>action.status==="PROPOSED");
  const last=cycle.actions.at(-1);
  const execution=last?.localExecution;
  const executionLabels:Record<string,string>={CONNECTING:"正在连接本机执行器",CONNECTED:"本机执行器已连接",OBSERVING:"正在观察本机页面",CANCELLING:"正在取消，等待工作进程退出",SUCCEEDED:"本机只读动作已完成",CANCELLED:"本机只读动作已取消",TIMED_OUT:"本机只读动作已超时",FAILED:"本机只读动作失败，需检查回执"};
  const localRunning=cycle.status==="RUNNING"&&Boolean(execution);
  const readiness=last?.capabilityId==="production.readiness"&&last.result?.data&&typeof last.result.data==="object"
    ?last.result.data as {providerReady?:boolean;costStatus?:string;items?:unknown[]}:undefined;
  const lastUser=cycle.messages.map(m=>m.role).lastIndexOf("user");
  const updates=cycle.messages.slice(lastUser+1).filter(m=>m.role!=="user");
  const recent=updates.filter((m,i)=>!updates.slice(i+1).some(other=>other.text===m.text)).slice(-3);
  return `<article data-cycle="${escape(cycle.id)}" data-revision="${cycle.revision}" data-execution-version="${execution?.version??0}"><h2>当前业务任务</h2><p class="badge">${labels[cycle.status]??escape(cycle.status)}</p><details><summary>查看本轮目标</summary><p>${escape(cycle.input.goal)}</p></details>
  ${execution?`<div role="status" aria-label="本机执行状态"><b>${executionLabels[execution.phase]??escape(execution.phase)}</b><p>已收到 ${execution.samples} 次页面观察。${execution.workerExited?"工作进程退出已确认。":"尚未确认工作进程退出。"}取消仅停止本机动作和后续调度。</p></div>`:""}
  ${readiness&&cycle.status==="BLOCKED"?`<div class="review" role="status"><h3>当前暂停原因</h3><p>${readiness.providerReady?"后台生成通道检查已通过。":"后台生成前检查仍有未满足条件，可能涉及预算或素材依赖，详细原因已保留在诊断回执。"}</p><p>${readiness.costStatus==="UNKNOWN"?`本次${readiness.items?.length??0}项生成范围尚未取得完整、有效的后台积分报价，暂不能进入费用确认。`:"生成前检查仍有未满足项。"}原任务、脚本和素材规划已保留，没有提交生成或发布。</p><p>无需反复确认创意或改用外部网页。后台问题解决后从这条原任务继续，付费生成和发布仍需分别请你确认。</p></div>`:""}
  ${recent.map(message=>`<div class="message"><b>${message.role==="agent"?"最近进展":"执行记录"}</b>：${escape(message.text)}</div>`).join("")}
  ${pending?`<div class="review"><h3>下一项具体动作</h3><pre>${escape(pending.preview)}</pre>${cycle.status==="WAITING_CONFIRMATION"?`<button data-action="confirm" data-action-id="${escape(pending.id)}" data-hash="${escape(pending.inputHash)}">确认这一项动作</button>`:""}</div>`:""}
  ${last?.result?.resumeHref?`<p><a href="${escape(last.result.resumeHref)}">查看实际结果或处理业务审核</a></p>`:""}
  ${["WAITING_USER","BLOCKED","WAITING_CONFIRMATION","OUTCOME_UNKNOWN"].includes(cycle.status)?'<p><textarea placeholder="补充要求，或说明在业务页面核对和处理后的结果"></textarea></p><button data-action="reply">补充后继续原任务</button>':""}
  <p class="actions">${["READY","RUNNING"].includes(cycle.status)&&!localRunning?'<button data-action="advance">检查并继续一步</button>':""}${!["CANCELLED","COMPLETED"].includes(cycle.status)?`<button data-action="cancel" ${execution?.phase==="CANCELLING"?"disabled":""}>${localRunning?"取消本机只读动作":"停止后续处理"}</button>`:""}</p><p role="alert" class="error"></p>
  <details><summary>历史记录与工具诊断</summary><pre>${escape(JSON.stringify({cycleId:cycle.id,steps:cycle.steps,messages:cycle.messages,skills:cycle.loadedSkills,actions:cycle.actions,evidence:cycle.evidence},null,2))}</pre></details></article>`;
}
