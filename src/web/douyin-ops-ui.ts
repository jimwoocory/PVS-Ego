import type {
  DouyinOpsGlobalView,
  DouyinOpsProjectView
} from "../application/services/douyin-ops-dashboard-service.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";
import type { DouyinCollectionRun } from "../domain/douyin-collection.js";
import {commentObservationDisplay} from "../domain/douyin-comment-observation.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]!
  );

function layout(title: string, body: string, project?: { id: string; name: string }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${esc(title)} · Product Video Studio</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#17212b}.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:13px 22px;background:#171717;color:white}.top a{color:white;text-decoration:none}.top a.current{font-weight:800;text-decoration:underline}.wrap{max-width:1180px;margin:28px auto;padding:0 20px}.head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:14px}.card{background:white;border:1px solid #d7dde3;border-radius:12px;padding:18px;margin:14px 0}.metric{font-size:28px;font-weight:800}.muted{color:#687580}.ok{color:#216e39}.warn{color:#8a5a00}.danger{color:#a12424}.status{display:inline-block;border:1px solid #cbd2d9;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:700}.status-ok{background:#edf8ef;border-color:#a9d6b1}.status-warn{background:#fff8e8;border-color:#e4c77c}.status-danger{background:#fff0f0;border-color:#e1aaaa}button,.button{font:inherit;border:1px solid #17212b;border-radius:8px;background:#17212b;color:white;padding:8px 13px;cursor:pointer;text-decoration:none;display:inline-block}button.secondary,.button.secondary{background:white;color:#17212b}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e4e8ec;vertical-align:top}th{font-size:13px;color:#56616b}.scroll{overflow:auto}.comment{padding:13px 0;border-bottom:1px solid #e4e8ec}.comment:last-child{border-bottom:0}.comment-meta{display:flex;gap:10px;flex-wrap:wrap;color:#687580;font-size:13px}.notice{padding:11px 13px;border-radius:8px;background:#fff8e8;border:1px solid #e4c77c}.error{color:#a12424;white-space:pre-wrap}.technical{font-size:12px;color:#687580}.technical,.comment-audit,.saved-replies,.notice{overflow-wrap:anywhere;word-break:break-word;min-width:0}.draft-editor{width:100%;min-height:86px;margin-top:8px;padding:9px;border:1px solid #cbd2d9;border-radius:8px;font:inherit;resize:vertical}a{color:#245b91}@media(max-width:700px){.metric{font-size:23px}th,td{white-space:nowrap}}
${pvsGlobalStyles}</style></head><body>${renderPvsGlobalHeader("ops", project ? { project } : {})}<main class="wrap">${body}</main></body></html>`;
}

function statusChip(
  text: string,
  kind: "ok" | "warn" | "danger"
) {
  return `<span class="status status-${kind}">${esc(text)}</span>`;
}

function accountStatus(view: DouyinOpsGlobalView["account"]) {
  if (view.status === "MATCHED") {
    return statusChip("账号已匹配", "ok");
  }
  if (view.status === "MISMATCHED") {
    return statusChip("账号不一致", "danger");
  }
  return statusChip("账号待确认", "warn");
}

function runtimeStatus(view: DouyinOpsGlobalView["runtime"]) {
  return view.ready
    ? statusChip("运营连接正常", "ok")
    : statusChip("运营连接未就绪", "warn");
}

function fmt(value: number | undefined) {
  return value===undefined?"未提供":new Intl.NumberFormat("zh-CN").format(value);
}
function metricValue(snapshot:import("../domain/douyin-ops.js").DouyinMetricSnapshot,key:"plays"|"likes"|"comments"|"shares"){
 const state=snapshot.metricAvailability?.[key];return state==="NOT_VISIBLE"?"不可见":state==="LEGACY_UNVERIFIED"?"未核实":fmt(snapshot[key]);
}
function commentCount(comment:import("../domain/douyin-ops.js").DouyinComment,key:"diggCount"|"replyCount"){
 return esc(commentObservationDisplay(comment)[key]);
}
function commentAudit(comment:import("../domain/douyin-ops.js").DouyinComment){const d=commentObservationDisplay(comment);return `<details class="comment-audit"><summary>关系与计数来源</summary><p>${esc(d.relation)} · ${esc(d.relationSource)}</p><p>${esc(d.replyTarget)}</p><p>${esc(d.threadRoot)}</p><p>${esc(d.countSource)} · ${esc(d.coverage)}</p><p class="technical">${esc(d.evidence)} · 观察时间 ${time(d.observedAt)}</p><a href="/api/projects/${encodeURIComponent(comment.projectId)}/douyin/comments/${encodeURIComponent(comment.cid)}/evidence" target="_blank" rel="noopener">查看本地原始页证据</a></details>`;}

function time(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? esc(value)
    : esc(date.toLocaleString("zh-CN", { hour12: false }));
}

const sentimentLabel: Record<string, string> = {
  POSITIVE: "正向",
  NEUTRAL: "中性",
  NEGATIVE: "负向",
  MIXED: "复杂"
};

const categoryLabel: Record<string, string> = {
  PRODUCT_QUESTION: "产品疑问",
  PURCHASE_INTENT: "购买意向",
  USAGE_FEEDBACK: "使用反馈",
  PRAISE: "好评",
  COMPLAINT: "投诉 / 不满",
  GENERAL_INTERACTION: "普通互动",
  SPAM_OR_IRRELEVANT: "无关 / 垃圾内容"
};

const priorityLabel: Record<string, string> = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低"
};

const replyStrategyLabel: Record<string, string> = {
  ANSWER_QUESTION: "回答问题",
  ACKNOWLEDGE_FEEDBACK: "回应反馈",
  THANK_AND_ENGAGE: "感谢互动",
  DEESCALATE: "安抚回应",
  CLARIFY_WITHOUT_CLAIMING: "保守澄清"
};

function classificationMeta(
  comment: DouyinOpsProjectView["comments"][number]
): string {
  if (!comment.sentiment && !comment.category && !comment.priority) {
    return '<div class="comment-meta"><span class="muted">尚未进行 AI 分类</span></div>';
  }
  const sentiment = sentimentLabel[comment.sentiment ?? ""] ?? comment.sentiment ?? "—";
  const category = categoryLabel[comment.category ?? ""] ?? comment.category ?? "—";
  const priority = priorityLabel[comment.priority ?? ""] ?? comment.priority ?? "—";
  return '<div class="comment-meta"><span>情绪：' + esc(sentiment) + '</span><span>类型：' + esc(category) + '</span><span>优先级：' + esc(priority) + '</span></div>';
}

function workRows(view: DouyinOpsGlobalView) {
  if (!view.works.length) {
    return `<p class="muted">${esc(
      view.worksMessage ??
        (view.worksStatus === "READY"
          ? "当前账号没有返回作品。"
          : "当前无法读取账号作品。")
    )}</p>`;
  }
  return `<div class="scroll"><table><thead><tr><th>作品</th><th>发布时间</th><th>播放</th><th>点赞</th><th>评论</th><th>分享</th></tr></thead><tbody>${view.works
    .map(
      (work) =>
        `<tr><td><b>${esc(work.description || "未命名作品")}</b><div class="technical">${esc(work.awemeId)}</div></td><td>${time(work.publishedAt)}</td><td>${fmt(work.metrics.plays)}</td><td>${fmt(work.metrics.likes)}</td><td>${fmt(work.metrics.comments)}</td><td>${fmt(work.metrics.shares)}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

export function renderDouyinOpsGlobalPage(
  view: DouyinOpsGlobalView
): string {
  const linked = view.linkedProjects.length
    ? `<div class="scroll"><table><thead><tr><th>项目</th><th>绑定状态</th><th>抖音作品</th><th></th></tr></thead><tbody>${view.linkedProjects
        .map(
          (item) =>
            `<tr><td>${esc(item.projectName)}</td><td>${esc(item.binding.status)}</td><td>${esc(item.binding.awemeId ?? "待绑定")}</td><td><a href="/projects/${encodeURIComponent(item.projectId)}/douyin">查看发布后表现</a></td></tr>`
        )
        .join("")}</tbody></table></div>`
    : '<p class="muted">还没有项目建立抖音作品绑定。</p>';

  const body = `
<div class="head"><div><h1>抖音运营</h1><p class="muted">统一查看账号状态、作品数据和项目发布后表现。当前支持读取、同步、本地绑定、AI 评论分类、回复草稿和单条人工确认回复；不会自动评论、批量回复、点赞或私信。</p></div><div class="actions"><button id="launch-ops">启动 / 打开抖音运营连接</button><a class="button secondary" href="/douyin-ops">重新检查</a></div></div>
<section class="grid">
  <div class="card"><h3>运营连接</h3><p>${runtimeStatus(view.runtime)}</p><p>${esc(view.runtime.message ?? (view.runtime.ready ? "Bridge 与抖音主页面已连接。" : "Bridge 或抖音主页面当前未连接。"))}</p><div class="technical">状态：${esc(view.runtime.status)} · Contract v${esc(view.runtime.contractVersion ?? "—")}</div></div>
  <div class="card"><h3>账号关系</h3><p>${accountStatus(view.account)}</p><p><b>发布账号：</b>${esc(view.account.publish.displayName || "未登录")} ${view.account.publish.platformUserId ? "· 抖音号 " + esc(view.account.publish.platformUserId) : ""}</p><p><b>运营账号：</b>${esc(view.account.ops.nickname || (!view.runtime.ready ? "状态未知（运营连接未就绪）" : view.account.ops.runtimeStatus === "AUTH_REQUIRED" ? "未登录" : "尚未识别"))} ${view.account.ops.uniqueId ? "· 抖音号 " + esc(view.account.ops.uniqueId) : ""}</p><p class="muted">${esc(view.account.message)}</p></div>
</section>
<section class="card"><h2>我的抖音作品</h2>${workRows(view)}</section>
<section class="card"><h2>已关联到 PVS 的项目</h2>${linked}</section>
<div id="launch-message" class="error"></div>
<script>
(()=>{const b=document.querySelector('#launch-ops'),m=document.querySelector('#launch-message');b?.addEventListener('click',async()=>{b.disabled=true;m.textContent='正在启动专用抖音浏览器与 Bridge…';try{const r=await fetch('/api/douyin/ops/launch',{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.message||'启动失败');m.textContent=data.message||'已启动，请在专用浏览器完成登录。';setTimeout(()=>location.reload(),1800);}catch(err){m.textContent=err.message;b.disabled=false;}});})();
</script>`;
  return layout("抖音运营", body);
}

export function renderDouyinOpsBlockedPage(message:string,disabled:boolean) {
  return layout("抖音运营暂不可用",`<section class="card" role="status"><h1>${disabled?"抖音运营尚未接入":"抖音运营暂不可用"}</h1><p>${esc(message)}</p>${disabled?'<p>Ego Lite 当前只读取本机合成页面，尚未连接真实抖音账号。</p><p>账号状态：未核验。作品与运营数据：未采集，不能当作零指标。</p><p>真实账号接入和采集需要另行明确授权；本页不会启动浏览器、同步数据、发布或回复。</p>':'<p>现有项目和保存证据保留，请核对本地服务状态后再检查。</p>'}<div class="actions"><a class="button" href="/projects">返回项目工作台</a><a class="button secondary" href="/agent-cycle">打开 Agent 工作台</a></div></section>`);
}

function bindingBlock(view: DouyinOpsProjectView) {
  const binding = view.binding;
  if (binding?.status === "BOUND" && binding.awemeId) {
    if (binding.source === "HISTORICAL_WORK") return `<p>${statusChip("历史作品运营观察", "ok")}</p><p><b>作品：</b>${esc(binding.workDescription)} · ${esc(binding.awemeId)}</p><p class="notice">用于验证指标、评论、楼中楼与复盘流程。此作品不是当前项目新片；当前新片尚未发布，原脚本、分镜和制作任务保留。</p>`;
    return `<p>${statusChip("已绑定抖音作品", "ok")}</p><p><b>作品：</b>${esc(binding.awemeId)}</p><p class="muted">来源：${esc(binding.source ?? "—")} · 可信度：${esc(binding.confidence)}</p>${view.publishPackage && view.publishPackage.id !== binding.packageId ? '<p class="notice">新建发布包尚未替换当前运营作品。下方采集、分析和回复继续使用上述已绑定作品。</p>' : ''}`;
  }
  const candidates =
    view.candidatesStatus === "READY" && view.candidates.length
      ? `<div class="candidate-list"><p><b>请选择本次发布对应的作品：</b></p>${view.candidates
          .slice(0, 12)
          .map(
            (work) =>
              `<div class="comment"><div><b>${esc(work.description || "未命名作品")}</b></div><div class="comment-meta"><span>${time(work.publishedAt)}</span><span>播放 ${fmt(work.metrics.plays)}</span><span>点赞 ${fmt(work.metrics.likes)}</span></div><div class="actions"><button class="bind-work" data-aweme="${esc(work.awemeId)}" data-url="${esc(work.externalUrl)}">确认绑定这条作品</button></div></div>`
          )
          .join("")}</div>`
      : `<p class="muted">${esc(view.candidatesMessage ?? "当前没有可用于人工绑定的作品候选。")}</p>`;
  return `<p>${statusChip(
    binding?.status === "BLOCKED_ACCOUNT_MISMATCH"
      ? "账号不一致，禁止自动绑定"
      : "作品待绑定",
    binding?.status === "BLOCKED_ACCOUNT_MISMATCH"
      ? "danger"
      : "warn"
  )}</p><p class="muted">${esc(
    binding?.status === "BLOCKED_ACCOUNT_MISMATCH"
      ? "发布账号与运营账号不一致。若你确认某条作品属于本项目，可以人工选择；系统不会静默猜测。"
      : "发布回执暂未提供可信作品 ID。登录正确的运营账号后可人工选择作品。"
  )}</p>${candidates}`;
}

function metricBlock(view: DouyinOpsProjectView) {
  const latest = view.snapshots.at(-1);
  if (!latest) {
    return '<p class="muted">还没有保存指标快照。作品绑定后点击“刷新数据”即可创建第一条历史快照。</p>';
  }
  return `<div class="grid"><div><div class="muted">播放</div><div class="metric">${metricValue(latest,"plays")}</div></div><div><div class="muted">点赞</div><div class="metric">${metricValue(latest,"likes")}</div></div><div><div class="muted">评论</div><div class="metric">${metricValue(latest,"comments")}</div></div><div><div class="muted">分享</div><div class="metric">${metricValue(latest,"shares")}</div></div></div><p class="muted">上次同步：${time(latest.capturedAt)}。未提供、不可见和未核实指标均不是零。</p>`;
}

function historyBlock(view: DouyinOpsProjectView) {
  if (!view.snapshots.length) return "";
  return `<div class="scroll"><table><thead><tr><th>时间</th><th>播放</th><th>点赞</th><th>评论</th><th>分享</th></tr></thead><tbody>${view.snapshots
    .map(
      (item) =>
        `<tr><td>${time(item.capturedAt)}</td><td>${metricValue(item,"plays")}</td><td>${metricValue(item,"likes")}</td><td>${metricValue(item,"comments")}</td><td>${metricValue(item,"shares")}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function insightItems(title: string, items: DouyinOpsProjectView["latestInsight"] extends infer T ? any[] : never): string {
  if (!items?.length) return "";
  return `<h4>${esc(title)}</h4><ul>${items.map((item) => `<li>${esc(item.text)}<div class="technical">证据：${esc(item.evidenceRefs.join(" / "))}</div></li>`).join("")}</ul>`;
}

function retrospectiveBlock(view: DouyinOpsProjectView): string {
  const insight = view.latestInsight;
  if (!insight) {
    return view.retrospectiveMode === 'LOCAL' ? '<p class="muted">还没有本地证据复盘。只整理已保存数据，不调用模型；建议须人工审核。</p>' : '<p class="muted">还没有发布后 AI 复盘。至少保存一条作品指标快照后即可生成。</p>';
  }
  const feedbackByAction = new Map(
    view.creativeFeedback
      .filter((item) => item.insightId === insight.id && item.active)
      .map((item) => [item.actionIndex, item])
  );
  const creativeActions = insight.nextCreativeActions.length
    ? `<h4>下一条创意建议</h4><ul>${insight.nextCreativeActions
        .map((item, index) => {
          const feedback = feedbackByAction.get(index);
          return `<li>${esc(item.text)}<div class="technical">证据：${esc(item.evidenceRefs.join(" / "))}</div><div class="actions">${feedback ? `<span class="status status-ok">已加入下一轮创意</span><button class="secondary deactivate-creative-feedback" data-feedback-id="${esc(feedback.id)}">停用</button>` : `<button class="secondary promote-creative-feedback" data-insight-id="${esc(insight.id)}" data-action-index="${index}" ${insight.observationEvidence?"":"disabled"}>${insight.observationEvidence?"作为待验证方法加入下一轮":"历史覆盖未核实"}</button>`}</div></li>`;
        })
        .join("")}</ul>`
    : '<p class="muted">这次复盘没有生成下一条创意建议。</p>';
  const scope=insight.observationEvidence;
  const scopeHtml=scope?`<p>观察时段：${time(scope.window.start)} 至 ${time(scope.window.end)}（离散保存时点，非连续观察）</p><p>范围：${esc(scope.description??scope.awemeId)}；最新保存的 ${scope.coverage.metrics.count} 条指标、${scope.coverage.comments.count} 条评论样本；部分覆盖，${scope.coverage.comments.capped?"已达到样本上限，":""}顶层及楼中楼覆盖 ${scope.coverage.collectionScopes.length} 项。不可见、截断和未核实范围保留。</p><p>完播率、转化率、销量未提供。建议为下一轮待验证的方法假设，不能证明因果、产品功效或商业效果。</p>`:`<p>历史复盘未保存可核验的观察时间窗和覆盖范围，原记录保留，不能自动用于下一轮。</p>`;
  return `<div class="notice">${scopeHtml}<p><b>复盘摘要</b></p><p>${esc(insight.summary)}</p><div class="comment-meta"><span>生成时间：${time(insight.createdAt)}</span><span>指标证据 ${insight.metricSnapshotIds.length} 条</span><span>评论证据 ${insight.commentIds.length} 条</span></div></div>${insightItems("观察到的现象", insight.strengths)}${insightItems("需要改进", insight.weaknesses)}${insightItems("用户真实关注", insight.audienceQuestions)}${creativeActions}`;
}

function commentsBlock(view: DouyinOpsProjectView) {
  if (!view.comments.length) {
    return '<p class="muted">还没有保存评论。作品绑定后点击“同步评论”。</p>';
  }
  const draftByComment = new Map(
    view.replyDrafts.map((draft) => [draft.commentId, draft])
  );
  return view.comments
    .map((comment) => {
      const draft = draftByComment.get(comment.id);
      const editable = draft?.status === "DRAFT";
      const canPublishReply =
        Boolean(
          editable &&
          view.runtime.ready &&
          view.account.status === "MATCHED" &&
          view.binding?.status === "BOUND" &&
          view.binding.awemeId === draft?.awemeId
        );
      const statusLabel =
        draft?.status === "POSTED"
          ? "已发布"
          : draft?.status === "REJECTED"
            ? "已拒绝"
            : "草稿";
      const draftHtml = draft
        ? `<div class="notice"><b>${draft.status === "POSTED" ? "已发布回复" : "AI 回复草稿"}${editable ? "（发布前可编辑）" : ""}</b>${editable ? `<textarea class="draft-editor" maxlength="280" data-draft-text="${esc(draft.id)}">${esc(draft.currentText)}</textarea>` : `<p>${esc(draft.currentText)}</p>`}<div class="comment-meta"><span>状态：${esc(statusLabel)}</span><span>revision ${esc(draft.revision)}</span><span>策略：${esc(replyStrategyLabel[draft.strategy] ?? draft.strategy)}</span><span>更新时间：${time(draft.updatedAt)}</span></div>${editable ? `<div class="actions"><button class="secondary save-reply-draft" data-draft-id="${esc(draft.id)}" data-revision="${esc(draft.revision)}">保存草稿</button><button class="secondary reject-reply-draft" data-draft-id="${esc(draft.id)}" data-revision="${esc(draft.revision)}">拒绝草稿</button><button class="publish-reply-draft" data-draft-id="${esc(draft.id)}" data-revision="${esc(draft.revision)}" ${canPublishReply ? "" : 'disabled title="需要运营连接正常、账号强匹配且作品已绑定"'}>确认并发布这条回复</button></div><p class="muted">发布按钮只会发送当前这一条评论回复；点击后还会展示完整回复文字并要求再次确认。</p>` : ""}</div>`
        : '<div class="comment-meta"><span class="muted">尚未生成回复草稿</span></div>';
      const draftButton = draft ? "重新生成AI回复草稿" : "生成AI回复草稿";
      return `<article class="comment"><div><b>${esc(comment.nickname || "抖音用户")}</b></div><div>${esc(comment.text)}</div><div class="comment-meta"><span>${time(comment.platformCreatedAt)}</span><span>点赞 ${commentCount(comment,"diggCount")}</span><span>回复 ${commentCount(comment,"replyCount")}</span></div>${commentAudit(comment)}${classificationMeta(comment)}${draftHtml}<div class="actions"><button class="secondary generate-reply-draft" data-cid="${esc(comment.cid)}">${draftButton}</button><button class="secondary view-saved-replies" data-cid="${esc(comment.cid)}">查看已保存的楼中楼回复</button>${((comment.replyCount===undefined||comment.replyCount > 0)||comment.sourceCoverage?.status!=="VISIBLE") ? `<button class="secondary sync-replies" data-cid="${esc(comment.cid)}">同步这条评论的回复</button>` : ""}</div><div class="saved-replies" data-parent-cid="${esc(comment.cid)}" aria-live="polite"></div></article>`;
    })
    .join("");
}

export function renderDouyinOpsProjectPage(
  view: DouyinOpsProjectView,
  collections: DouyinCollectionRun[] = []
): string {
  const localReview = view.retrospectiveMode === "LOCAL";
  const id = encodeURIComponent(view.project.id);
  const runtimeNote = view.runtime.ready
    ? "运营连接正常，可以刷新平台数据。"
    : "运营连接当前不可用；下方已保存的历史指标和评论仍可查看。";
  const runs = collections.filter(run => run.bindingId === view.binding?.id && run.awemeId === view.binding?.awemeId);
  const collectionProgress = runs.length ? runs.slice(0, 12).map(run => {
    const busy = run.status === "RUNNING" && Date.parse(run.leaseExpiresAt ?? "") > Date.now();
    const canContinue = run.hasMore && (run.status !== "BLOCKED" || run.retryable);
    return `<div class="notice"><b>${run.parentCid ? `评论 ${esc(run.parentCid)} 的楼中楼` : "顶层评论"}</b>：已保存 ${fmt(run.syncedCount)} 条，已读取 ${fmt(run.pages)} 页；${run.status === "COMPLETED" ? "本轮游标范围已结束" : run.status === "BLOCKED" ? "采集已中断" : "尚有后续数据"}。<p>${run.coverage?.status==="NOT_VISIBLE"?"源数据不可见，不能当作没有评论。":run.partial?"本次观察仍是部分数据。":"本次采集仅代表所记录时点和范围。"}${run.truncated?"采集存在截断。":""}${run.coverage?.status==="UNKNOWN"?"运行时未提供可见性证明。":""}${esc(run.coverage?.reason??"")}</p><span class="technical">游标 ${esc(run.cursor)} · 更新时间 ${time(run.updatedAt)}</span>${run.errorMessage ? `<p class="error">${esc(run.errorMessage)}</p>` : ""}${canContinue ? `<div class="actions"><button class="secondary continue-collection" data-run-id="${esc(run.id)}" ${busy ? "disabled" : ""}>${busy ? "正在采集" : "继续采集"}</button></div>` : ""}</div>`;
  }).join("") : '<p class="muted">尚无持久采集记录。同步每次读取一批，后续可从已保存游标继续。</p>';
  const body = `
<nav><a href="/projects/${id}/final">返回成片 / 发布</a> · <a href="/douyin-ops">抖音运营首页</a> · <a href="/projects">项目列表</a></nav>
<div class="head"><div><h1>发布后表现</h1><p>${esc(view.project.name)}</p><p class="muted">${esc(runtimeNote)}</p></div><div>${runtimeStatus(view.runtime)} ${accountStatus(view.account)}</div></div>
<section class="card"><h2>抖音作品绑定</h2>${bindingBlock(view)}<div id="bind-message" class="error"></div></section>
<section class="card"><div class="head"><div><h2>作品表现</h2><p class="muted">每次刷新都会保存在 PVS 自己的历史快照中。</p></div><div class="actions"><button id="refresh-metrics" ${view.binding?.status === "BOUND" ? "" : "disabled"}>刷新数据</button></div></div>${metricBlock(view)}${historyBlock(view)}<div id="metric-message" class="error"></div></section>
<section class="card"><div class="head"><div><h2>${localReview?"本地证据复盘（不调用模型）":"发布后 AI 复盘"}</h2><p class="muted">只使用 PVS 已保存的指标快照、最新保存的最多 500 条评论样本和已确认产品事实；样本不代表平台全部评论，不会编造平台指标。</p></div><div class="actions"><button id="generate-retrospective" ${view.snapshots.length ? "" : "disabled"}>${localReview?"整理本地证据复盘":"AI复盘"}</button></div></div>${retrospectiveBlock(view)}<div id="retrospective-message" class="error"></div></section>
<section class="card"><div class="head"><div><h2>评论中心</h2><p class="muted">评论同步仍然只读；AI 分类和草稿先保存在 PVS。本阶段仅支持你对单条草稿显式确认后发送，不会自动或批量回复。</p></div><div class="actions"><button id="sync-comments" ${view.binding?.status === "BOUND" ? "" : "disabled"}>同步评论</button><button class="secondary" id="classify-comments" ${view.comments.length ? "" : "disabled"}>AI分类评论</button></div></div><p id="collection-note" class="notice" role="status">采集进度与游标保存在本机数据库，刷新或重启后可继续。一次同步不代表平台全部数据；下方仅展示最新保存的最多 500 条顶层评论，楼中楼可逐条展开。</p><div id="collection-runs">${collectionProgress}</div><div id="comments-list">${commentsBlock(view)}</div><div id="comment-message" class="error"></div></section>
<script>
(()=>{const projectId=${JSON.stringify(view.project.id)};
const currentAweme=${JSON.stringify(view.binding?.awemeId ?? "")};
const currentBinding=${JSON.stringify(view.binding?.id ?? "")};
const collectionRequests=new Map();const collectionRequest=key=>{if(!collectionRequests.has(key))collectionRequests.set(key,crypto.randomUUID());return {requestKey:collectionRequests.get(key),bindingId:currentBinding,awemeId:currentAweme};};
const call=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data.message||'操作失败');return data;};
document.querySelector('#refresh-metrics')?.addEventListener('click',async(e)=>{const b=e.currentTarget,m=document.querySelector('#metric-message');b.disabled=true;m.textContent='正在读取抖音作品数据…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/metrics/refresh');location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}});
document.querySelector('#generate-retrospective')?.addEventListener('click',async(e)=>{const b=e.currentTarget,m=document.querySelector('#retrospective-message');b.disabled=true;m.textContent=${JSON.stringify(localReview?'正在整理已保存证据，不调用模型…':'正在基于已保存指标和评论生成 AI 复盘…')};try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/retrospective/generate',{});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}});
document.querySelectorAll('.promote-creative-feedback').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#retrospective-message');if(!confirm('确认把这条观察建议作为待验证的方法加入下一轮创意？这不证明因果或商业效果，不改变产品事实及已采用内容。'))return;b.disabled=true;m.textContent='正在加入下一轮创意…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/creative-feedback/promote',{insightId:b.dataset.insightId,actionIndex:Number(b.dataset.actionIndex),confirmed:true});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.deactivate-creative-feedback').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#retrospective-message');if(!confirm('确认停用这条创意反馈？后续创意将不再使用它。'))return;b.disabled=true;m.textContent='正在停用创意反馈…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/creative-feedback/'+encodeURIComponent(b.dataset.feedbackId)+'/deactivate',{confirmed:true});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelector('#sync-comments')?.addEventListener('click',async(e)=>{const b=e.currentTarget,m=document.querySelector('#comment-message');b.disabled=true;m.textContent='正在采集一批评论并保存进度…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/sync',collectionRequest('comments'));location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}});
document.querySelectorAll('.continue-collection').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message');b.disabled=true;m.textContent='正在从持久游标继续采集…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/collections/'+encodeURIComponent(b.dataset.runId)+'/advance');location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelector('#classify-comments')?.addEventListener('click',async(e)=>{const b=e.currentTarget,m=document.querySelector('#comment-message');b.disabled=true;m.textContent='正在用当前项目的大模型设置分析评论…';try{const data=await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/classify',{});const result=data.result||{};m.textContent='AI 分类完成：本次分类 '+(result.classifiedCount||0)+' 条，跳过 '+(result.skippedCount||0)+' 条。';setTimeout(()=>location.reload(),900);}catch(err){m.textContent=err.message;b.disabled=false;}});
document.querySelectorAll('.generate-reply-draft').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message');b.disabled=true;m.textContent='正在生成 AI 回复草稿（只保存到 PVS，不会发布）…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/'+encodeURIComponent(b.dataset.cid)+'/reply-draft',{});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.save-reply-draft').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message'),id=b.dataset.draftId,revision=Number(b.dataset.revision),editor=document.querySelector('[data-draft-text=\"'+CSS.escape(id)+'\"]');b.disabled=true;m.textContent='正在保存本地草稿…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/reply-drafts/'+encodeURIComponent(id)+'/save',{expectedRevision:revision,currentText:editor?.value||''});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.reject-reply-draft').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message'),id=b.dataset.draftId,revision=Number(b.dataset.revision);if(!confirm('确认拒绝这条本地回复草稿？不会对抖音执行任何操作。'))return;b.disabled=true;m.textContent='正在拒绝本地草稿…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/reply-drafts/'+encodeURIComponent(id)+'/reject',{expectedRevision:revision});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.publish-reply-draft').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message'),id=b.dataset.draftId,revision=Number(b.dataset.revision),editor=document.querySelector('[data-draft-text="'+CSS.escape(id)+'"]'),replyText=editor?.value||'';if(editor&&editor.value!==editor.defaultValue){m.textContent='草稿有尚未保存的修改。请先点击“保存草稿”，再确认发布。';return;}if(!replyText.trim()){m.textContent='回复内容为空，不能发布。';return;}const prompt='即将向抖音真实发送这 1 条回复：\\n\\n'+replyText+'\\n\\n确认后只发送这一条，不会自动回复其他评论。是否继续？';if(!confirm(prompt))return;b.disabled=true;m.textContent='正在重新核对账号、作品、评论和草稿版本…';try{const data=await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/reply-drafts/'+encodeURIComponent(id)+'/publish',{expectedRevision:revision,writeIntentId:crypto.randomUUID(),confirmed:true});const result=data.result||{},status=result.intent?.status;if(status==='REPLY_POSTED_CONFIRMED'){m.textContent='抖音已明确确认这条回复发布成功。';setTimeout(()=>location.reload(),900);return;}if(status==='SUBMISSION_UNKNOWN'){m.textContent='平台状态无法确认。系统不会自动重试，也不要再次点击；请先到抖音页面核对实际状态。';return;}m.textContent=result.intent?.message||'本次回复未发布。请检查运营连接后再处理。';}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.view-saved-replies').forEach(b=>{let offset=0;const box=b.closest('.comment').querySelector('.saved-replies');b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message');b.disabled=true;try{const response=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/'+encodeURIComponent(b.dataset.cid)+'/replies?offset='+offset+'&limit=50');const page=await response.json();if(!response.ok)throw new Error(page.message||'读取已保存回复失败');if(offset===0)box.replaceChildren();for(const reply of page.items||[]){const article=document.createElement('article'),author=document.createElement('b'),text=document.createElement('p'),meta=document.createElement('small');article.className='comment';author.textContent=reply.nickname||'抖音用户';text.textContent=reply.text;meta.textContent='回复评论 '+b.dataset.cid+' · '+(reply.platformCreatedAt||'时间未提供');const audit=document.createElement('details'),summary=document.createElement('summary'),counts=document.createElement('p');summary.textContent='关系与计数来源';const d=reply.display||{};counts.textContent='点赞 '+(d.diggCount||'未知')+' · 回复 '+(d.replyCount||'未知');audit.append(summary,counts);for(const key of ['relation','relationSource','replyTarget','threadRoot','countSource','coverage','evidence','observedAt']){const line=document.createElement('p');line.textContent=d[key]||'未知';audit.append(line);}const evidenceLink=document.createElement('a');evidenceLink.textContent='查看本地原始页证据';evidenceLink.href='/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/'+encodeURIComponent(reply.cid)+'/evidence';evidenceLink.target='_blank';evidenceLink.rel='noopener';audit.append(evidenceLink);article.append(author,text,meta,audit);box.append(article);}if(!offset&&!page.items?.length)box.textContent='尚未保存楼中楼回复，请先同步。';offset=page.nextOffset;b.textContent=page.hasMore?'加载更多已保存回复':'已显示本次保存的全部回复';b.disabled=!page.hasMore;}catch(err){m.textContent=err.message;b.disabled=false;}});});
document.querySelectorAll('.sync-replies').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#comment-message');b.disabled=true;m.textContent='正在采集一批楼中楼回复并保存进度…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/comments/'+encodeURIComponent(b.dataset.cid)+'/replies/sync',collectionRequest('replies:'+b.dataset.cid));location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));
document.querySelectorAll('.bind-work').forEach(b=>b.addEventListener('click',async()=>{const m=document.querySelector('#bind-message');if(!confirm('确认把这条抖音作品绑定到当前 PVS 项目？'))return;b.disabled=true;m.textContent='正在保存作品绑定…';try{await call('/api/projects/'+encodeURIComponent(projectId)+'/douyin/binding/confirm',{awemeId:b.dataset.aweme,externalUrl:b.dataset.url,confirmed:true});location.reload();}catch(err){m.textContent=err.message;b.disabled=false;}}));})();
</script>`;
  return layout("发布后表现", body, view.project);
}
