import { renderV8ProductionWorkbench } from "./v8-production-ui.js";
import type { ProjectWorkspace } from "../application/services/product-flow.js";
import type { ProductInputSnapshot } from "../application/ports/product-input-store.js";
import { renderPostProductionControls, postProductionBrowserScript } from "./post-production-ui.js";
import { runnableSmartStatuses, closedSmartStatuses, type SmartGenerationRun, type SmartRunStatus } from "../domain/smart-generation.js";
import { canWorkerAdvanceRun, type SmartWorkerPolicy } from "../application/services/smart-generation-worker.js";
import type { ProductionAssetEntry } from "../domain/production-strategy.js";
import { renderDirectorV3Panels } from "./director-v3-ui.js";
import { auditNarrativeTiming, isScriptDurationWithinTolerance } from "../application/services/script-narrative-timing.js";
import { resolveWorkflowReadModel, type WorkflowReadInput } from "../application/services/workflow-read-model.js";
import { renderNativeReview, renderNativeTools, type WorkflowInlineData } from "./workflow-inline-panels.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";
import { douyinResearchPreflightBrowserScript } from "./douyin-research-preflight-ui.js";
import { savedReviewSyncBrowserScript } from "./saved-review-sync.js";
function esc(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
function formatUserTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}
function humanizeGeneratedText(value: unknown): string {
  return String(value ?? "")
    .replace(/产品\s*canonical\s*参考/gi, "产品主参考图")
    .replace(/canonical product reference/gi, "已确认产品主参考图")
    .replace(/canonical\s*参考/gi, "产品主参考图")
    .replace(/canonical/gi, "产品主参考")
    .replace(/querying/gi, "处理中")
    .replace(/submit[_ -]?id/gi, "任务编号");
}
function assetUserDescription(entry: {
  description?: string;
  purpose?: string;
}): string {
  const description = humanizeGeneratedText(entry.description);
  const asciiLetters = (description.match(/[A-Za-z]/g) ?? []).length;
  const chineseChars = (description.match(/[\u3400-\u9fff]/g) ?? []).length;
  if (asciiLetters > Math.max(12, chineseChars * 1.5)) {
    return humanizeGeneratedText(entry.purpose ?? description);
  }
  return description;
}
function assetReviewUserMessage(entry: ProductionAssetEntry): string {
  const summary = humanizeGeneratedText(entry.reviewSummary ?? "");
  const asciiLetters = (summary.match(/[A-Za-z]/g) ?? []).length;
  const chineseChars = (summary.match(/[㐀-鿿]/g) ?? []).length;
  if (asciiLetters > Math.max(16, chineseChars * 1.5)) {
    return entry.status === "NEEDS_REVIEW"
      ? "自动检查已经完成，请以图片为准人工确认；不满意可以修改提示词后重新生成。"
      : "自动检查已经完成。";
  }
  return summary || (
    entry.status === "NEEDS_REVIEW"
      ? "请查看图片后决定确认使用或重新生成。"
      : "暂无额外检查说明。"
  );
}
/** Product-facing copy hides technical pipeline revisions; durable IDs remain unchanged. */
function userFacingCreationText(value: unknown): string {
  return humanizeGeneratedText(value).replace(/\bV8\b/g, "完整创作");
}
function blockerUserMessage(blocker: {
  code?: string;
  message?: string;
}): string {
  if (blocker.code === "VISUAL_REVIEW_REQUIRED") {
    const matches = [...(blocker.message ?? "").matchAll(/视频\s*(\d+)/g)];
    const numbers = [...new Set(matches.map(match=>match[1]))];
    return numbers.length
      ? "逐镜视觉审核尚未全部通过：视频 "+numbers.join("、")+" 需要核查。请展开本轮镜头审片，查看对应视频。现有视频不会自动重生。"
      : "历史视觉质检结果已失效。请在视频质检操作区重新检查，或逐镜播放后人工核查。";
  }
  if (blocker.code === "ASSET_REMOTE_RESULT_STALE") {
    return "即梦队列已经结束，但平台长时间没有返回图片结果。系统已停止继续等待，并保留原任务记录；如需再次生成，必须重新确认积分。";
  }
  return userFacingCreationText(blocker.message);
}
const statusLabels: Record<SmartRunStatus, string> = {
  PLANNING: "正在规划", WAITING_FOR_TRUTH_REVIEW: "等待产品事实审核", WAITING_FOR_REFERENCE_REVIEW: "等待创作参考审核",
  WAITING_FOR_CREATIVE_REVIEW: "等待选择创意", WAITING_FOR_SCRIPT_REVIEW: "等待确认脚本", WAITING_FOR_PLAN_REVIEW: "等待确认分镜",
  WAITING_FOR_DIRECTOR_REVIEW: "等待采用导演镜头", WAITING_FOR_PROMPT_REVIEW: "等待采用视频提示词",
  READY_FOR_ASSET_PAID_CONFIRM: "等待制作资产付费确认", ASSET_PREPARING: "正在准备角色与场景资产", WAITING_FOR_ASSET_REVIEW: "等待制作资产确认",
  READY_FOR_PAID_CONFIRM: "等待本次付费确认", APPROVING: "正在建立独立审批", GENERATING: "正在生成与下载",
  WAITING_FOR_CLIP_REVIEW: "等待审片", AUTO_EDITING: "正在准备自动剪辑", WAITING_FOR_AUDIO: "等待音频素材",
  RENDERING: "正在渲染", REVIEW_READY: "成片待确认", COMPLETED: "成片已确认", BLOCKED: "需要处理", FAILED: "执行失败", CANCELLED: "本地编排已取消"
};
const contentTypeLabels: Record<string, string> = {
  SHORT_DRAMA: "短剧情节",
  PRODUCT_DEMO: "产品演示",
  HOST: "人物讲解",
  UGC: "真实体验",
  CG: "产品视觉广告",
  MIXED: "混合表现"
};
const assetKindLabels: Record<string, string> = {
  CHARACTER: "固定角色",
  SET: "固定场景",
  PROP: "关键道具",
  PRODUCT: "产品参考",
  PRODUCT_STATE: "产品状态",
  STYLE: "视觉风格"
};
const assetStatusLabels: Record<string, string> = {
  PLANNED: "待准备",
  SUBMISSION_UNKNOWN: "提交结果待核查",
  SUBMITTED: "已提交",
  PROCESSING: "生成中",
  READY: "已准备",
  NEEDS_REVIEW: "需要确认",
  FAILED: "失败"
};
const assetSourceLabels: Record<string, string> = {
  PRODUCT_INPUT: "你提供的产品图片",
  CREATIVE_REFERENCE: "已确认参考素材",
  DREAMINA_GENERATED: "AI 生成"
};
function renderProductionAssetCard(
  entry: ProductionAssetEntry,
  runStatus: SmartRunStatus,
  allEntries: ProductionAssetEntry[]
): string {
  const canEditPlanned =
    entry.source === "DREAMINA_GENERATED" &&
    entry.status === "PLANNED" &&
    runStatus === "READY_FOR_ASSET_PAID_CONFIRM";
  const canReview =
    entry.status === "NEEDS_REVIEW" &&
    runStatus === "WAITING_FOR_ASSET_REVIEW";
  const canRegenerate =
    entry.source === "DREAMINA_GENERATED" &&
    entry.artifactIds.length > 0 &&
    ["NEEDS_REVIEW", "READY"].includes(entry.status) &&
    runStatus === "WAITING_FOR_ASSET_REVIEW";
  const canRetryStale =
    entry.source === "DREAMINA_GENERATED" &&
    entry.status === "SUBMISSION_UNKNOWN" &&
    entry.errorCode === "ASSET_REMOTE_RESULT_STALE" &&
    runStatus === "BLOCKED";
  const canEditPrompt =
    entry.source === "DREAMINA_GENERATED" &&
    Boolean(entry.generationPrompt) &&
    (canEditPlanned || canRegenerate || canRetryStale);
  const dependencyLabels = entry.dependsOnAssetKeys
    .map(key => allEntries.find(item => item.key === key)?.label ?? key);
  const relationshipText =
    entry.source !== "DREAMINA_GENERATED"
      ? " · 直接复用，不参与图片生成队列"
      : dependencyLabels.length
        ? " · 依赖：" + dependencyLabels.join("、") + "；前置资产确认后再制作"
        : entry.sourceReferenceAssetIds.length
          ? " · 已有参考图可直接使用，可与其他独立资产并行制作"
          : " · 无前置生成依赖，可与其他独立资产并行制作";
  const legacyUnconfirmed =
    entry.source === "DREAMINA_GENERATED" &&
    entry.status === "READY" &&
    !entry.humanConfirmedAt &&
    !entry.reviewSummary?.includes("用户已明确确认用于本轮生产");
  let promptPanel = "";
  if (entry.source === "DREAMINA_GENERATED" && entry.generationPrompt) {
    promptPanel =
      '<details class="asset-prompt-panel"><summary>查看 / 修改资产提示词</summary>' +
      '<textarea class="asset-prompt-text" data-asset="' + esc(entry.key) +
      '" maxlength="12000" ' + (canEditPrompt ? "" : "readonly") + '>' +
      esc(entry.generationPrompt) + '</textarea>' +
      (canEditPlanned
        ? '<button data-action="asset-prompt" data-asset="' + esc(entry.key) +
          '">保存此资产提示词</button><p class="muted">保存后会重新计算本轮图片生成授权范围，旧的积分确认自动失效。</p>'
        : "") +
      (!canEditPrompt
        ? '<p class="muted">当前提示词只读；如需修改生成结果，请在资产确认阶段选择重新生成。</p>'
        : "") +
      '</details>';
  } else {
    promptPanel = entry.source === "DREAMINA_GENERATED"
      ? '<p class="muted">当前资产没有可编辑的生图提示词。</p>'
      : '<p class="muted">此资产直接复用已有图片，不需要生图提示词。</p>';
  }
  const image = entry.artifactIds[0]
    ? '<a class="asset-image-link" href="/api/artifacts/' +
      encodeURIComponent(entry.artifactIds[0]) +
      '/content" target="_blank" rel="noopener"><img class="asset-preview" loading="lazy" src="/api/artifacts/' +
      encodeURIComponent(entry.artifactIds[0]) +
      '/content" alt="' + esc(entry.label) +
      '"><span>点击图片查看原图</span></a>'
    : '<p class="muted">' +
      (entry.status === "PLANNED" ? "图片尚未生成。" : "当前没有可显示的图片。") +
      '</p>';
  let reviewActions = canReview
    ? '<div class="asset-actions"><button data-action="CONFIRM_ASSET" data-asset="' +
      esc(entry.key) +
      '">确认使用此资产</button><button class="secondary" data-action="regenerate-asset" data-asset="' +
      esc(entry.key) +
      '">修改提示词后重新生成</button></div>'
    : "";
  if (!canReview && canRegenerate) {
    reviewActions = '<div class="asset-actions"><button class="secondary" data-action="regenerate-asset" data-asset="' +
      esc(entry.key) +
      '">修改提示词后重新生成此资产</button></div>';
  }
  const retryAction = canRetryStale
    ? '<button data-action="retry-asset" data-asset="' + esc(entry.key) +
      '">重新准备此资产（下一步重新确认积分）</button>'
    : "";
  return '<details class="asset-card" data-asset="' + esc(entry.key) + '">' +
    '<summary><span><b>' + esc(entry.label) + '</b><small>' +
    esc(assetKindLabels[entry.kind] ?? entry.kind) + ' · ' +
    esc(assetStatusLabels[entry.status] ?? entry.status) +
    '</small></span></summary><div class="asset-card-body">' +
    '<p>' + esc(assetUserDescription(entry)) + '</p>' +
    '<p class="muted">来源：' + esc(assetSourceLabels[entry.source] ?? entry.source) +
    esc(relationshipText) +
    '</p>' + image +
    (entry.reviewSummary
      ? '<p class="muted">检查说明：' + esc(assetReviewUserMessage(entry)) + '</p>'
      : "") +
    (legacyUnconfirmed
      ? '<p class="asset-warning">这是旧任务自动采用的 AI 图片，尚未记录你的人工确认；恢复任务时会退回这里确认。</p>'
      : "") +
    (canRetryStale ? '<details class="technical"><summary>技术信息（排查用）</summary><p>任务编号：' + esc(entry.submitId ?? "未记录") + '</p></details>' : "") +
    promptPanel + reviewActions + retryAction +
    '</div></details>';
}
function renderV8ManualEditor(run: SmartGenerationRun): string {
  const source = run.v8Screenplay?.screenplay;
  if (!source) return "";
  const field = (label: string, kind: string, value: string | number,
    indexes: {scene?: number; beat?: number; actor?: number; line?: number} = {},
    numeric = false) => {
    const coords = Object.entries(indexes).map(([k,v])=>
      ' data-v8-' + k + '="' + v + '"').join('');
    const attributes = ' class="v8-editor" data-v8-kind="' + esc(kind) + '"' + coords;
    return '<label class="field v8-edit-field"><span>' + esc(label) + '</span>' +
      (numeric
        ? '<input type="number" min="1" max="120" step="0.1"' + attributes +
          ' value="' + esc(value) + '">'
        : '<textarea' + attributes + ' rows="2">' + esc(value) + '</textarea>') +
      '</label>';
  };
  return '<details class="v3-panel v8-edit-panel"><summary>修改完整剧本（先保存新版，再审核）</summary>' +
    '<p class="muted">可调整场景、人物目标、动作、台词、语气、时长及后期文字。原有节拍数量和经确认产品事实不允许偷偷增删。修改后当前审核哈希失效，不调用即梦生成。</p>' +
    field('剧本标题', 'title', source.title) +
    field('故事核心', 'premise', source.premise) +
    field('主要冲突', 'storyConflict', source.storyConflict) +
    field('结局', 'finalOutcome', source.finalOutcome) +
    source.scenes.map((scene,si)=>
      '<h4>场次 ' + (si + 1) + '</h4>' +
      field('场景地点','location',scene.location,{scene:si}) +
      field('场景情境','situation',scene.situation,{scene:si}) +
      field('本场戏剧目的','dramaticPurpose',scene.dramaticPurpose,{scene:si}) +
      scene.actorObjectives.map((actor,ai)=>
        '<h4>人物 ' + esc(actor.speaker) + '</h4>' +
        field('此人想达到什么目的','wants',actor.wants,{scene:si,actor:ai}) +
        field('此人的阻碍','obstacle',actor.obstacle,{scene:si,actor:ai})
      ).join('') +
      scene.beats.map((beat,bi)=>
        '<h4>事件 ' + (bi + 1) + '</h4>' +
        field('此段时长（秒）','estimatedDurationMs',beat.estimatedDurationMs/1000,{scene:si,beat:bi},true) +
        field('镜头能拍到的事件','action',beat.action,{scene:si,beat:bi}) +
        field('演员实际动作','actorAction',beat.actorAction,{scene:si,beat:bi}) +
        field('事件开始状态','stateIn',beat.stateIn,{scene:si,beat:bi}) +
        field('事件结束状态','stateOut',beat.stateOut,{scene:si,beat:bi}) +
        field('产品在事件中的作用','productRole',beat.productRole,{scene:si,beat:bi}) +
        field('观众此刻获知的新信息','audienceKnowledgeChange',beat.audienceKnowledgeChange,{scene:si,beat:bi}) +
        beat.dialogue.map((line,li)=>
          '<h4>' + esc(line.speaker) + ' · ' + esc(line.mode) + '</h4>' +
          field('台词原句','text',line.text,{scene:si,beat:bi,line:li}) +
          field('说话语气','tone',line.tone,{scene:si,beat:bi,line:li}) +
          field('配音及表演指令','delivery',line.delivery,{scene:si,beat:bi,line:li})
        ).join('') +
        field('后期文字（每行一条）','postProductionText',beat.postProductionText.join('\n'),{scene:si,beat:bi}) +
        field('环境声（每行一条）','ambience',beat.ambience.join('\n'),{scene:si,beat:bi}) +
        field('物理音效（每行一条）','sfx',beat.sfx.join('\n'),{scene:si,beat:bi})
      ).join('')
    ).join('') +
    '<p><button type="button" data-action="script-v8">保存修改，重新审核完整剧本</button></p>' +
    '</details>';
}

function renderV8DetailedScreenplayReview(run: SmartGenerationRun): string {
  const record = run.v8Screenplay;
  if (!record || !run.script) {
    return '<p class="error">完整剧本尚未就绪，请勿确认空白脚本。</p>';
  }
  const script = record.screenplay;
  const scenes = script.scenes.map((scene, sceneIndex) =>
    '<details class="v3-panel" open><summary>场次 ' + (sceneIndex + 1) + ' · ' +
      esc(scene.location) + ' · ' + esc(scene.interiorExterior) + ' / ' +
      esc(scene.timeOfDay) + '</summary>' +
    '<p><b>场景情境：</b>' + esc(scene.situation) + '</p>' +
    '<p><b>戏剧目的：</b>' + esc(scene.dramaticPurpose) + '</p>' +
    scene.actorObjectives.map(actor =>
      '<p><b>' + esc(actor.speaker) + '</b> 想要：' + esc(actor.wants) +
      '；面临阻碍：' + esc(actor.obstacle) + '</p>'
    ).join('') +
    scene.beats.map((beat, index) =>
      '<article class="v3-script-beat"><h4>动作 ' + (index + 1) +
      ' · ' + (beat.estimatedDurationMs / 1000) + ' 秒</h4>' +
      '<p><b>可见事件：</b>' + esc(beat.action) +
      '；<b>演员动作：</b>' + esc(beat.actorAction) + '</p>' +
      '<p><b>开始状态：</b>' + esc(beat.stateIn) +
      '；<b>结束状态：</b>' + esc(beat.stateOut) + '</p>' +
      '<p><b>产品角色：</b>' + esc(beat.productRole) + '</p>' +
      (beat.audienceKnowledgeChange
        ? '<p><b>观众此刻得知：</b>' + esc(beat.audienceKnowledgeChange) + '</p>'
        : '') +
      beat.dialogue.map(line =>
        '<p><b>' + esc(line.speaker) + '（' + esc(line.mode) + '）</b>：' +
        esc(line.text) + '<br>语气：' + esc(line.tone) +
        '；配音执行：' + esc(line.delivery) + '</p>'
      ).join('') +
      (beat.postProductionText.length
        ? '<p><b>后期文字：</b>' + beat.postProductionText.map(esc).join('、') + '</p>'
        : '') +
      '</article>'
    ).join('') +
    '</details>'
  ).join('');
  return '<div class="v8-manual-review">' +
    '<h3>完整剧本 · 人工审核</h3>' +
    '<p><b>标题：</b>' + esc(script.title) +
    '；<b>一句话故事：</b>' + esc(script.premise) + '</p>' +
    '<p><b>主要冲突：</b>' + esc(script.storyConflict) +
    '；<b>结局：</b>' + esc(script.finalOutcome) + '</p>' +
    '<p class="muted">完整展示每场的人物目标、阻碍、台词、观众知情节点及声音要求。此处只确认剧本，不能自动跳过导演审核，也不会提交付费视频。</p>' +
    scenes + renderV8ManualEditor(run) +
    (run.status === "WAITING_FOR_SCRIPT_REVIEW" ? '<p><label><input type="checkbox" class="v8-manual-confirm"> 我已阅读完整场次、台词、角色动机和观众知情信息，同意保存这一版详细剧本。</label></p>' +
    '<button data-action="CONFIRM_SCRIPT" data-v8-screenplay="' +
      esc(record.screenplayHash) + '">确认本版完整剧本（不生成视频）</button>' : '') +
    '</div>';
}

export function renderSmartGenerationPage(
  workspace: ProjectWorkspace,
  runs: SmartGenerationRun[],
  defaults: {
    useResearch?: boolean;
    fromReference?: boolean;
    productInput?: ProductInputSnapshot | null;
    inline?: Partial<Omit<WorkflowInlineData, "workspace" | "run">>;
    selectedRunId?: string | null;
    timelineStatus?: WorkflowReadInput["timelineStatus"];
    timelinePlanHash?: string;
    finalAssemblyStatus?: WorkflowReadInput["finalAssemblyStatus"];
    finalAssemblyPlanHash?: string;
    projectPlanHash?: string;
    workerPolicy?: SmartWorkerPolicy;
  } = {}
): string {
  const id = encodeURIComponent(workspace.project.id);
  const active = runs.some(r => !closedSmartStatuses.includes(r.status));
  const truth = workspace.productTruth;
  const productInput = defaults.productInput;
  const productImageCount =
    productInput?.assets.filter(item => item.type === "image").length ?? 0;
  const productReady = Boolean(
    productInput &&
    productImageCount > 0 &&
    truth?.status === "CONFIRMED"
  );
  const workerPolicy: SmartWorkerPolicy = defaults.workerPolicy ?? { mode: "ALL" };
  const isRunPaused = (run: SmartGenerationRun) =>
    runnableSmartStatuses.includes(run.status) && !canWorkerAdvanceRun(workerPolicy, run.projectId, run.id, run.autoAdvanceGrant);
  const resolvedNextAction = resolveWorkflowReadModel({
    project: workspace.project,
    productInputPresent: Boolean(productInput),
    productImagePresent: productImageCount > 0,
    productTruthConfirmed: truth?.status === "CONFIRMED",
    productTruthDraftPresent: Boolean(truth),
    selectedRunId: defaults.selectedRunId,
    timelineStatus: defaults.timelineStatus,
    timelinePlanHash: defaults.timelinePlanHash,
    finalAssemblyStatus: defaults.finalAssemblyStatus,
    finalAssemblyPlanHash: defaults.finalAssemblyPlanHash,
    projectPlanHash: defaults.projectPlanHash,
    runs
  });
  const pausedRun = runs.find(run => run.id === resolvedNextAction.runId && isRunPaused(run));
  const nextRunPaused = Boolean(pausedRun);
  const nextCanAuthorize = workerPolicy.mode === "MANAGED" && pausedRun?.workflowVersion === 2 &&
    pausedRun.status === "PLANNING" && pausedRun.stage === "SOURCES" &&
    !pausedRun.autoAdvanceGrant && !pausedRun.pendingInstall &&
    !pausedRun.consent && !pausedRun.assetConsent && pausedRun.attemptIds.length === 0;
  const currentVisualQcRun = runs.find(run =>
    run.id === resolvedNextAction.runId &&
    run.status === "WAITING_FOR_CLIP_REVIEW" &&
    run.blocker?.code === "VISUAL_REVIEW_REQUIRED" &&
    run.blocker.retryable !== false
  );
  const nextAction = nextRunPaused ? {
    ...resolvedNextAction,
    statusLabel: nextCanAuthorize ? "等待本任务执行授权" : "后台自动编排已暂停",
    action: { ...resolvedNextAction.action,
      label: nextCanAuthorize ? "恢复本条任务的自动规划" : "等待当前任务执行器恢复",
      ...(nextCanAuthorize ? { href: "#smart-run-" + pausedRun!.id } : {}) },
    explanation: nextCanAuthorize ? "本轮资料和任务已保存；请在下方卡片明确恢复本任务自动规划，不会继承历史付费许可。" : "当前任务尚未进入后台规划。记录不会丢失；请不要重复创建或付费提交，需由授权执行器恢复本任务。"
  } : currentVisualQcRun ? {
    ...resolvedNextAction,
    statusLabel: "视觉质检待处理",
    action: { ...resolvedNextAction.action,
      label: "查看生成视频与审核结果",
      href: currentVisualQcRun.options.directorVersion === 3 &&
        currentVisualQcRun.options.directorPipeline !== "V8"
        ? "#v3-seedance-workbench-" + currentVisualQcRun.id
        : "#review-panel-" + currentVisualQcRun.id },
    explanation: "生成视频已保存。每段视频与对应生成提示词放在一起，请核对画面与声音后决定采用、重做或跳过。"
  } : resolvedNextAction;
  const workflowActionHref = nextCanAuthorize || Boolean(currentVisualQcRun)
    ? nextAction.action.href
    : nextAction.runId && ["WAITING_FOR_TRUTH_REVIEW","WAITING_FOR_REFERENCE_REVIEW",
        "WAITING_FOR_CLIP_REVIEW","REVIEW_READY"].includes(
          runs.find(run=>run.id===nextAction.runId)?.status ?? "")
      ? "#review-panel-" + nextAction.runId : nextAction.action.href;
  const taskChooser = nextAction.activeTaskCount > 1 || nextAction.taskSelectionRequired
    ? `<section class="card" id="choose-task" aria-label="选择当前制作任务">
        <h2>选择当前制作任务</h2>
        <p class="muted">${nextAction.taskSelectionRequired
          ? "此项目有多个未结束任务。请先明确选择，再处理具体镜头或费用。"
          : "已明确选中本轮任务；也可以切换到其他未结束的任务。"} 历史记录不会自动删除。</p>
        ${nextAction.taskOptions.map(task => `<p><a href="${esc(task.selectHref)}">${esc(task.stageLabel)} · ${esc(task.statusLabel)}${task.runId === nextAction.selectedRunId ? "（当前选择）" : "（切换到此任务）"}</a></p>`).join("")}
      </section>`
    : "";
  const historyPublication = nextAction.publication.projectMarkedPublished && nextAction.activeTaskCount > 0
    ? '<p class="muted">历史项目标记：已发布（回执请在成片页核对）；本轮新任务仍按上方待办继续。</p>'
    : "";
  const userPhases = nextAction.phases.map(item =>
    `<span style="display:inline-block;margin:3px 6px 3px 0;padding:4px 8px;border:1px solid #d9dfe5;border-radius:6px;${item.status === "CURRENT" ? "font-weight:700;background:#eaf3ff" : ""}">${esc(item.label)} · ${item.status === "DONE" ? (item.key === "PRODUCT" && truth?.status === "CONFIRMED" ? "已确认" : "已过") : item.status === "CURRENT" ? "当前" : item.status === "OPTIONAL" ? "可选" : "待开始"}</span>`
  ).join("");
  const focusRunId = nextAction.taskSelectionRequired ? undefined : nextAction.runId;
  const isFocusedTask = active || nextAction.taskSelectionRequired;
  const nativeTools = renderNativeTools({workspace, ...(defaults.inline??{})});
  const visibleRuns = nextAction.activeTaskCount > 1 || nextAction.taskSelectionRequired
    ? runs.filter(run => closedSmartStatuses.includes(run.status) ||
        (!nextAction.taskSelectionRequired && run.id === nextAction.selectedRunId))
    : runs;
  const cards = visibleRuns.filter(run => !closedSmartStatuses.includes(run.status) || (!active && run.id === runs[0]?.id)).map(run => {
    const pid = `/projects/${id}`;
    const workflowReviewPages: Partial<Record<SmartRunStatus, string>> = {
      WAITING_FOR_TRUTH_REVIEW: "truth",
      WAITING_FOR_REFERENCE_REVIEW: "creative-references",
      WAITING_FOR_CLIP_REVIEW: "generate",
      REVIEW_READY: "final"
    };
    const embeddedReviewPage = workflowReviewPages[run.status];
    const embeddedReviewHref = embeddedReviewPage
      ? `${pid}/${embeddedReviewPage}?fromSmartRun=${encodeURIComponent(run.id)}`
      : "";
    const currentClipCount = run.productionPlan?.scenes.reduce((count, scene) =>
      count + scene.clips.length, 0) ?? 0;
    const v3ReviewData = run.status === "WAITING_FOR_CLIP_REVIEW" &&
      run.options.directorVersion === 3 && run.options.directorPipeline !== "V8" &&
      currentClipCount > 0 && defaults.inline?.attempts && defaults.inline?.artifacts
      ? {workspace,run,...defaults.inline} : undefined;
    const visualRecheckControl = run.status === "WAITING_FOR_CLIP_REVIEW" &&
      run.blocker?.code === "VISUAL_REVIEW_REQUIRED" && run.blocker.retryable !== false
      ? `<section class="ux-visual-qc-footer" id="visual-qc-${esc(run.id)}" aria-label="视频质检操作">
          <button type="button" data-action="resume" data-visual-recheck="1">重新进行视觉质检</button>
          <p class="ux-hint">本轮 ${currentClipCount} 条镜头。重新检测可能消耗视觉模型 API 额度；全部待审镜头达到已启用的高置信门槛时可能自动采用。不会重新生成付费视频或发布。</p>
        </section>`
      : "";
    const embeddedReviewPanel = embeddedReviewPage && !v3ReviewData
      ? `<details id="review-panel-${esc(run.id)}" class="embedded-review" ${focusRunId === run.id ? "open" : ""}><summary>${run.status === "WAITING_FOR_CLIP_REVIEW"
            ? "逐镜审片 · 查看 " + currentClipCount + " 条镜头"
            : "在此审核并处理：" + esc(statusLabels[run.status])}</summary>
          <p class="muted">当前直接审核本轮结果。处理成功后系统自动更新原任务，不需要手工刷新；需要复杂修改时可 <a href="${esc(embeddedReviewHref)}">打开完整专业审核页</a>。</p>
          ${renderNativeReview({workspace,run,...(defaults.inline??{})})}
          <p class="ux-hint">若远端结果尚未确认，请先核查原任务编号，不能直接重新付费提交。</p>
        </details>`
      : "";
    const canAuthorizeWork = workerPolicy.mode === "MANAGED" &&
      isRunPaused(run) && !run.autoAdvanceGrant &&
      run.workflowVersion === 2 && run.status === "PLANNING" &&
      run.stage === "SOURCES" && !run.pendingInstall &&
      !run.consent && !run.assetConsent && !run.attemptIds.length;
    let action = canAuthorizeWork
      ? '<p class="muted">此任务创建于安全维修模式，尚未登记自动执行授权。只恢复当前任务，历史任务不会重启；产生积分费用仍需单独确认。</p><button data-action="authorize-worker">恢复本任务自动规划（不包含付费生成）</button>'
      : "";
    if (run.status === "WAITING_FOR_CREATIVE_REVIEW") action = (run.creativeBatch?.concepts ?? []).map(c => `<div class="item"><b>${esc(c.title)}</b><p>${esc(c.hook)}</p><p>${esc(c.productShowcaseStrategy)}</p><button data-action="SELECT_CREATIVE" data-creative="${esc(c.id)}">选择此方案</button></div>`).join("");
    if (run.status === "READY_FOR_ASSET_PAID_CONFIRM" && run.assetPaidScope) {
      const unknown = run.assetPaidScope.assets.some(item => item.costStatus === "UNKNOWN");
      action += `<h3>准备本创意所需的固定角色 / 场景资产</h3>
      <p>程序已经根据你选择的创意判断出需要新增 ${run.assetPaidScope.assets.length} 个制作资产。它们会在多个视频镜头中复用，用来保持人物和场景一致。</p>
      ${run.assetPaidScope.assets.map(item => {
        const asset = run.productionAssetSet?.entries.find(entry => entry.key === item.key);
        return `<p><b>${esc(asset?.label ?? item.key)}</b> · ${esc(assetKindLabels[asset?.kind ?? ""] ?? asset?.kind ?? "")} · ${item.costStatus === "UNKNOWN" ? "积分成本未知" : esc(item.estimatedCredits ?? item.costText ?? "")}</p>`;
      }).join("")}
      <p><label><input type="checkbox" class="confirm-asset-paid"> 我明确授权生成上述固定角色 / 场景制作资产；不包含后续重做或新增资产。</label></p>
      ${unknown ? '<p><label><input type="checkbox" class="asset-unknown-cost"> 我接受本轮制作资产成本未知的积分风险。</label></p>' : ""}
      <button data-action="asset-paid" data-scope="${esc(run.assetPaidScope.hash)}">确认并准备制作资产</button>`;
      if (unknown && run.workspaceContinuation) action = `<h3>后台生成费用尚未核实</h3><p>现有角色、场景和分镜方案已接入本项目；设定图尚未生成。当前生成通道没有返回可靠报价，不能用网页限免或积分余额代替。</p>
        <p>本阶段需要准备：${run.assetPaidScope.assets.map(item=>esc(run.productionAssetSet?.entries.find(e=>e.key===item.key)?.label??item.key)).join("、")}。未生成、未扣费。</p>
        <p>取得与当前任务绑定的报价后，再向你展示总额并请求确认；本页不提供未知价格的生成授权。</p>`;
    }
    if (run.status === "WAITING_FOR_ASSET_REVIEW" && run.productionAssetSet) {
      action += "<h3>制作资产待确认</h3><p>请在上方“本创意的制作策略”中点击资产名称，查看实际图片和资产提示词。每张 AI 新生图片都需要你明确确认；不满意可以修改提示词后重新生成。</p>";
    }
    if (
      run.status === "BLOCKED" &&
      run.blocker?.code === "ASSET_REMOTE_RESULT_STALE" &&
      run.productionAssetSet
    ) {
      action += "<h3>即梦制作资产结果长时间未返回</h3><p class=\"muted\">原任务记录已保留，系统没有自动重提，也没有再次扣费。请点击上方对应资产名称查看提示词并决定是否重新准备。</p>";
    }
    if (run.status === "WAITING_FOR_SCRIPT_REVIEW") action =
      run.options.directorPipeline === "V8"
        ? renderV8DetailedScreenplayReview(run)
        : `<div>${run.script?.beats.map(b => `<p>${b.estimatedDurationMs / 1000} 秒 · ${esc(b.text)}</p>`).join("")}</div><button data-action="CONFIRM_SCRIPT">确认此脚本</button>`;
    if (run.status === "WAITING_FOR_PLAN_REVIEW" && run.options.directorPipeline !== "V8") action = `<p>模型：${esc(run.productionPlan?.generationTarget?.requestedModelVersion)} · ${esc(run.productionPlan?.generationTarget?.aspectRatio)}</p>${run.productionPlan?.scenes.flatMap(s => s.clips).map(c => `<p>${c.durationMs / 1000} 秒 · ${esc(c.purpose)}</p>`).join("")}<button data-action="CONFIRM_PLAN">确认此分镜</button>`;
    if (run.options.directorPipeline === "V8" && run.v8Director) action = renderV8ProductionWorkbench(run,
      action + (!run.attemptIds.length && !run.consent ? '<details><summary>回看 / 修改已确认剧本（下游审核将失效）</summary>'+renderV8DetailedScreenplayReview(run)+'</details>' : ''));
    if (run.status === "READY_FOR_PAID_CONFIRM" && run.paidScope) {
      const audit = run.options.directorVersion === 3 && run.options.directorPipeline !== "V8" && run.script
        ? auditNarrativeTiming(run.script) : undefined;
      const invalidScriptTiming = Boolean(audit && (
        !isScriptDurationWithinTolerance(run.script!.targetDurationMs, audit.totalMs) ||
        audit.issues.some(issue => issue.severity === "REVISE")
      ));
      const scope = run.paidScope;
      const unknown = scope.requests.some(r => r.costStatus === "UNKNOWN");
      action = `<h3>确认本轮 ${scope.requests.length} 个镜头</h3><p>模型：${esc(run.options.generationSettings.requestedModelVersion)} · 画幅 ${esc(run.options.generationSettings.aspectRatio)} · ${esc(run.options.generationSettings.videoResolution)} · 用户目标 ${run.targetDurationMs / 1000} 秒 · 当前镜头合计 ${run.productionPlan?.scenes.flatMap(scene=>scene.clips).reduce((sum,clip)=>sum+clip.durationMs,0)! / 1000} 秒</p>
      <p>${unknown ? "部分镜头的积分成本无法准确估计。" : "预计积分合计：" + scope.requests.reduce((sum, r) => sum + (r.estimatedCredits ?? 0), 0)}</p>
      ${scope.requests.map((r, i) => `<p>请求 ${i + 1}：${r.costStatus === "UNKNOWN" ? "成本未知" : esc(r.estimatedCredits ?? r.costText ?? "平台估计")}<span class="muted"> ${esc(r.costText ?? "")}</span></p>`).join("")}
      <p><label><input type="checkbox" class="confirm-paid"> 我明确授权本轮上述镜头的付费生成；不包含重做或新增镜头。</label></p>
      ${unknown ? '<p><label><input type="checkbox" class="unknown-cost"> 我接受本轮成本未知的积分风险。</label></p>' : ""}
      <button data-action="paid" data-scope="${esc(scope.hash)}">确认并开始本轮生成</button>`;
      if (unknown && run.workspaceContinuation) action = '<h3>后台视频生成费用尚未核实</h3><p>保留原任务与已审核素材，取得当前镜头范围的可靠报价后再请求你确认。未提交视频生成，不接受未知价格授权。</p>';
      if (invalidScriptTiming) action =
        '<h3>费用确认已暂停：请先修订剧本</h3><p class="error">这份剧本段落时长或叙事没有通过最新审核。请先在上方“① 剧本”里修改或点击“按剧情重新编排”，重新确认剧本与分镜；原费用范围不能沿用。</p>';
    }
    if (run.status === "WAITING_FOR_TRUTH_REVIEW") {
      // Native in-workbench truth panel handles this review.
    }
    if (run.status === "WAITING_FOR_REFERENCE_REVIEW") {
      // Native in-workbench reference panel handles this review.
    }
    if (run.status === "WAITING_FOR_CLIP_REVIEW") {
      // Native in-workbench video player and review panel handle this review.
    }
    if (["WAITING_FOR_TRUTH_REVIEW", "WAITING_FOR_REFERENCE_REVIEW", "WAITING_FOR_CLIP_REVIEW", "WAITING_FOR_AUDIO", "BLOCKED", "FAILED"].includes(run.status)) {
      if (run.blocker?.retryable !== false && run.blocker?.code !== "VISUAL_REVIEW_REQUIRED")
        action += '<button data-action="resume">问题处理后继续原任务</button>';
    }
    if (!closedSmartStatuses.includes(run.status) && !["RENDER", "FINAL_REVIEW"].includes(run.stage)) {
      action += `<details><summary>调整本轮字幕与声音设置</summary>${renderPostProductionControls({ projectId: workspace.project.id,
        settings: run.postProduction ?? run.options.postProduction ?? { bgmArtifactId: run.options.bgmArtifactId, allowSilentOutput: run.options.allowSilentOutput }, plan: run.productionPlan })}
        <button data-action="post-production">保存后期设置${run.stage === "AUTO_EDIT" ? "并继续" : ""}</button></details>`;
    }
    if (run.workflowVersion !== 2 && ["AUTO_EDIT", "CLIP_REVIEW"].includes(run.stage) && !closedSmartStatuses.includes(run.status)) action += `<p><a href="${pid}/auto-edit">独立自动剪辑与音轨设置</a></p><button class="secondary" data-action="adopt-timeline">采用已确认的当前手工时间线</button>`;
    if (run.status === "REVIEW_READY") action += `<p><a href="${pid}/final">查看并确认最终成片</a></p><button data-action="final-confirmed">已在成片页确认，结束编排任务</button>`;
    if (visualRecheckControl) action += visualRecheckControl;
    if (!closedSmartStatuses.includes(run.status)) action += '<button class="secondary" data-action="cancel">停止后续编排</button>';
    const assetEntries = run.productionAssetSet?.entries ?? [];
    const strategy = run.workflowVersion === 2 && run.productionStrategy
      ? `<details ${["WAITING_FOR_ASSET_REVIEW","BLOCKED"].includes(run.status) ? "open" : ""}><summary>本创意的制作策略</summary><p><b>${esc(humanizeGeneratedText(run.productionStrategy.summary))}</b></p><p class="muted">内容类型：${esc(contentTypeLabels[run.productionStrategy.contentType] ?? run.productionStrategy.contentType)} · 固定制作资产 ${run.productionStrategy.assetRequirements.length} 项 · 点击资产名称查看图片与提示词</p>${assetEntries.length ? `<div class="production-assets">${assetEntries.map(entry => renderProductionAssetCard(entry, run.status, assetEntries)).join("")}</div>` : ""}</details>`
      : "";
    return `<section class="card run" id="smart-run-${esc(run.id)}" data-run="${esc(run.id)}" data-revision="${run.revision}" data-status="${run.status}"><h2>${esc(isRunPaused(run) ? "后台编排已暂停" : statusLabels[run.status])}</h2><p>${esc(run.options.requestText)}</p>
      ${isRunPaused(run) ? '<p class="error" role="status">本任务尚未获准自动推进；历史资料已保存。无需重新创建或重复付费。</p>' : ""}
      <p class="muted">${esc(formatUserTime(run.updatedAt))} · ${run.options.reviewMode === "AUTO" ? "自动创作，付费和事实仍需确认" : "分阶段审核创作"}</p>
      ${embeddedReviewPanel}
      ${strategy}

      ${run.options.directorPipeline === "V8" ? "" : renderDirectorV3Panels(run,v3ReviewData)}
      ${run.blocker ? `<p class="error">${esc(blockerUserMessage(run.blocker))}${run.blocker.code==="VISUAL_REVIEW_REQUIRED"
        ? '<a href="#ux-clip-'+(run.blocker.message.match(/视频\s*(\d+)/)?.[1]??'1')+'"> 打开对应镜头</a>'
        : ''}</p>` : ""}
      ${action}<p class="error action-error" role="alert"></p>
      <details><summary>执行记录</summary>${run.notes.slice(-12).map(n => `<p class="muted">${esc(formatUserTime(n.at))} · ${esc(userFacingCreationText(n.message))}</p>`).join("")}</details></section>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>智能生成 · ${esc(workspace.project.name)}</title>
  <style>body{font:16px/1.65 system-ui,sans-serif;background:#f5f6f7;color:#17212b;margin:0}main{max-width:1050px;margin:32px auto;padding:0 22px}.card{background:white;border:1px solid #d9dfe5;border-radius:12px;padding:24px;margin:20px 0}.row{display:flex;flex-wrap:wrap;gap:16px}label.field{display:flex;flex-direction:column;flex:1;min-width:180px}input,select,textarea,button{font:inherit}select,textarea{padding:10px;border:1px solid #bcc4cc;border-radius:7px}textarea{width:calc(100% - 22px);min-height:96px}button{padding:9px 16px;border-radius:7px;border:1px solid #17212b;background:#17212b;color:white;cursor:pointer;margin:8px 8px 0 0}button:disabled{opacity:.5;cursor:wait}.secondary{background:white;color:#17212b}.error{color:#ac2424}.muted{color:#63717e;font-size:14px}.item{border-bottom:1px solid #ddd;padding:14px 0}.asset-preview{display:block;max-width:100%;max-height:420px;object-fit:contain;border:1px solid #ddd;border-radius:10px;background:#f4f4f4}.asset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.asset-chip{border:1px solid #ddd;border-radius:8px;padding:9px;background:#fafafa;font-size:13px}.production-assets{display:grid;gap:10px;margin-top:12px}.asset-card{border:1px solid #d9dfe5;border-radius:10px;background:#fafafa}.asset-card>summary{cursor:pointer;padding:12px 14px;list-style:none}.asset-card>summary::-webkit-details-marker{display:none}.asset-card>summary span{display:flex;justify-content:space-between;gap:12px;align-items:center}.asset-card>summary small{font-size:13px;color:#63717e;font-weight:400}.asset-card-body{padding:0 14px 14px}.asset-image-link{display:inline-flex;max-width:100%;flex-direction:column;gap:4px;text-decoration:none}.asset-image-link span{font-size:13px;color:#63717e}.asset-prompt-panel{margin-top:12px;border-top:1px solid #ddd;padding-top:8px}.asset-prompt-panel>summary{display:inline-block;cursor:pointer;font-weight:600;padding:7px 10px;border:1px solid #bcc4cc;border-radius:7px;background:white}.asset-prompt-text{width:calc(100% - 22px);min-height:140px;margin-top:8px}.asset-warning{padding:8px 10px;background:#fff6e6;border:1px solid #e8c98d;border-radius:7px}.asset-actions{display:flex;flex-wrap:wrap;gap:8px}.main-nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.main-nav a{padding:8px 11px;border:1px solid #ccc;border-radius:8px;text-decoration:none;background:white}.main-nav .current{border-color:#17212b;font-weight:700}.support-nav{font-size:14px;color:#63717e}a{color:#245b91}h1,h2{line-height:1.3}.v3-panel{border:1px solid #cfd7df;border-radius:10px;padding:12px 14px;margin:14px 0;background:#fbfcfd}.v3-panel>summary{cursor:pointer}.v3-script-beat,.v3-storyboard,.v3-prompt{border-top:1px solid #dfe5ea;padding:14px 0}.v3-panel input{padding:9px;border:1px solid #bcc4cc;border-radius:7px}.v3-prompt-text{min-height:260px;font-family:ui-monospace,Consolas,monospace;font-size:13px}.v3-script-text,.v3-purpose{min-height:84px}.ok{color:#176b2c}.purpose-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.purpose-option{border:1px solid #d9dfe5;border-radius:10px;padding:13px;background:#fafbfd}.purpose-option p{min-height:44px;margin:7px 0}.purpose-option a,.purpose-option button{display:inline-block;max-width:100%;font-weight:600}.purpose-option button{margin-top:0}.embedded-review{margin:14px 0;border:1px solid #b8cce0;border-radius:9px;padding:12px;background:#f7faff}.embedded-review summary{cursor:pointer;font-weight:700}
.ux-visual-qc-footer{margin:14px 0 0;padding:9px 0}
.ux-visual-qc-footer button{display:inline-block}
.ux-visual-qc-footer .ux-hint{max-width:760px;margin:6px 0}
.v3-prompt-details{margin:14px 0 0;padding:10px 12px;border:1px solid #d6e0eb;border-radius:8px;background:#fff}
.v3-prompt-details>summary{cursor:pointer;font-size:13px;color:#2b5b94;font-weight:600}
.v3-prompt-details>textarea{margin-top:12px}
.ux-v3-prompt-review{margin-top:10px}
.ux-v3-prompt-review .ux-clip-card{background:#fff;border:0;padding:6px 0}
.ux-v3-prompt-review video{display:block;width:100%;max-width:720px;max-height:370px;object-fit:contain}
/* UX-R2: task-first workbench (legacy view may be opened explicitly). */
body{background:#f6f8fb;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#16253b}
main{max-width:1480px;margin:0 auto;padding:0 28px 50px}
main.ux-workbench .main-nav, main.ux-workbench .support-nav{display:none}
.ux-top{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:20px 0 14px;margin-bottom:14px;border-bottom:1px solid #dfe6f0}
.ux-top-brand{font-size:17px;font-weight:800;letter-spacing:-.5px}
.ux-top-brand small{display:block;color:#728299;font-size:11px;font-weight:500}
.ux-top-tools{display:flex;gap:17px;flex-wrap:wrap;font-size:12px}
.ux-top-tools a{text-decoration:none;color:#596e88}
.ux-workbench>h1{font-size:26px;margin:16px 0 4px}
.ux-lead{margin:0 0 17px;color:#687a93;font-size:13px}
.ux-grid{display:grid;grid-template-columns:226px minmax(0,1fr);gap:20px;align-items:start}
.ux-stages{background:white;border:1px solid #dfe6ee;border-radius:14px;padding:20px 15px;position:sticky;top:10px}
.ux-stages h2{font-size:14px;margin:0 0 12px}
.ux-stages ol{list-style:none;padding:0;margin:0}
.ux-stages li{display:flex;align-items:center;gap:9px;padding:10px 8px;border-radius:9px;font-size:12px}
.ux-stages li .stage-number{flex:0 0 25px;width:25px;height:25px;border-radius:50%;background:#eff2f7;color:#657895;text-align:center;line-height:25px}
.ux-stages li[data-state="CURRENT"]{background:#edf4ff;color:#1e5caf;font-weight:800}
.ux-stages li[data-state="CURRENT"] .stage-number{background:#2968ca;color:white}
.ux-stages li[data-state="DONE"] .stage-number{background:#e6f7ee;color:#1e8b66}
.ux-stages li[data-state="UPCOMING"],.ux-stages li[data-state="OPTIONAL"]{color:#8796a9}
.ux-stages li small{margin-left:auto;font-size:10px;color:inherit;white-space:nowrap}
.ux-stages>p{border-top:1px solid #e9edf5;color:#7888a1;font-size:11px;padding-top:15px;margin:18px 0 0}
.ux-main{min-width:0}
.ux-main .card{margin:0 0 15px}
.ux-main #workflow-next-action{border-color:#c9daee;box-shadow:0 10px 32px rgba(25,65,128,.06);padding:24px}
.ux-main #workflow-next-action h2{font-size:21px;margin:0 0 12px}
.ux-main #workflow-next-action a.primary{background:transparent;border:0;border-radius:0;color:#16457b;padding:2px 0;text-decoration:none;display:inline;font-weight:700;box-shadow:none}
#workflow-next-action a.primary,#workflow-next-action a.primary:visited{background:transparent;border:0;border-radius:0;color:#16457b;padding:2px 0;text-decoration:none;box-shadow:none}
#workflow-next-action a.primary:hover{text-decoration:underline;color:#123763}
#workflow-next-action a.primary:focus-visible{outline:2px solid #16457b;outline-offset:3px;text-decoration:underline}
.ux-main #workflow-next-action [aria-label="当前工作流进度"]{display:none}
.ux-main .run{border-color:#dfe6ef;box-shadow:0 6px 24px rgba(13,44,90,.05);padding:20px 22px}
.ux-main .run>h2{font-size:17px}
.ux-main .run .v3-panel:not([open]),.ux-main .run details:not([open]){padding-bottom:12px}
.ux-main .run .run-action-highlight{background:#f1f6ff;border:1px solid #bfd4f3;border-radius:10px;padding:14px}
.ux-bottom{margin-top:18px}
.ux-bottom>details,.ux-bottom>.card{margin:11px 0}
.ux-bottom .ux-optional>summary{padding:8px;font-weight:700;cursor:pointer}
.ux-bottom details.ux-optional{border:1px solid #e0e6ef;border-radius:10px;background:white;padding:10px 16px}
.ux-workbench #workflow-purpose-entry.ux-optional{background:#fff}
.ux-workbench #workflow-purpose-entry.ux-optional>summary{list-style-position:inside}
.ux-workbench #smart-create{max-width:100%}
.ux-run-history{margin-top:16px;border:1px solid #e4e9f3;background:white;border-radius:10px;padding:12px 18px}
.ux-run-history summary{cursor:pointer;color:#6d7c90;font-weight:600}
.ux-run-history .run{margin:10px 0}
.ux-live-panel{margin:10px 0;padding:12px;border-radius:10px;background:#f7faff;border:1px solid #dce7f6}
.ux-primary-prompt{color:#5e718f;font-size:12px;margin:0 0 6px}
.ux-main textarea{width:100%;max-width:100%;box-sizing:border-box}
@media(max-width:820px){main{padding:0 14px 28px}.ux-grid{grid-template-columns:1fr;gap:12px}.ux-stages{position:static;padding:12px}.ux-stages ol{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}.ux-stages li{font-size:10px;padding:7px 4px}.ux-stages li small{display:none}.ux-top nav{gap:10px}.ux-main #workflow-next-action{padding:16px}.ux-main .run{padding:16px}}

/* UX-R3: native, current-task scoped review/tool fragments. */
.ux-native-review{border:1px solid #cbdbea;border-radius:11px;background:#fff;padding:15px;margin-top:13px}
.ux-native-review h3{font-size:16px;margin:2px 0 8px}
.ux-native-review details{border:1px solid #e5ebf3;border-radius:7px;padding:8px 11px;margin:10px 0}
.ux-native-review details summary{cursor:pointer}
.ux-hint{font-size:12px;color:#637892;line-height:1.6}
.ux-fact-row{display:flex;flex-direction:column;gap:5px;border-top:1px solid #e8edf3;padding:12px 0;font-size:13px}
.ux-fact-row small{color:#7b8fa7}
.ux-fact-row select,.ux-native-review select{padding:8px;width:min(100%,380px);border:1px solid #b8c7d9;border-radius:7px}
.ux-inline-error{color:#a62f2f;font-size:12px;margin:9px 0;white-space:pre-wrap}
.v8-shadow-preview{border:1px solid #d5dfeb;border-radius:10px;background:#fafcff;padding:12px;margin-top:16px}
.v8-speaker-selections{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:12px 0}
.v8-speaker-selections label{display:flex;flex-direction:column;gap:5px;font-size:13px}
.v8-speaker-selections select{padding:8px;min-width:0}
.v8-shadow-result{margin-top:12px}
.v8-shadow-result details{border:1px solid #dde5ee;border-radius:7px;background:white;padding:10px;margin:9px 0}
.v8-prompt-pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 system-ui,sans-serif;background:#f5f8fc;color:#18344e;padding:11px;border-radius:7px;max-height:380px;overflow:auto}
.ux-inline-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.ux-clip-list{display:grid;gap:14px;margin:14px 0}
.ux-clip-card,.ux-ref-candidate{background:#f9fbff;border:1px solid #e1e9f2;border-radius:9px;padding:13px}
.ux-clip-card h4{margin:2px 0;font-size:14px}
.ux-ref-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:12px}
.ux-ref-candidate{display:grid;gap:7px;align-content:start}
.ux-ref-candidate p{margin:0}
.ux-ref-candidate img{border-radius:7px;background:#eef2f8}
.ux-expert-link{display:inline-block;font-size:12px;margin:8px 0;color:#2965ad}
.ux-native-review input[type="file"]{display:block;max-width:100%;margin:6px 0 10px}
.ux-native-review [data-inline-action]{margin-top:3px}
.ux-native-review [data-inline-action]:disabled{opacity:.45}
#workflow-tool-panel [hidden]{display:none!important}
#workflow-support-materials summary{cursor:pointer}
#ux-clips-review .ux-clip-card:not(:first-child){margin-top:4px}
@media(max-width:640px){.ux-native-review{padding:10px}.ux-ref-grid{grid-template-columns:1fr}.ux-native-review button{max-width:100%;white-space:normal}.ux-clip-card{padding:9px}}
${pvsGlobalStyles}</style></head><body>${renderPvsGlobalHeader("studio", { project: { id: workspace.project.id, name: workspace.project.name } })}<main data-project="${esc(workspace.project.id)}">
  <nav class="main-nav"><a href="/projects/${id}/product">产品资料</a><a class="current" href="/projects/${id}/smart">智能生成</a><a href="/projects/${id}/final">成片 / 发布</a></nav>
  <nav class="support-nav">辅助工具：<a href="/projects/${id}/research">联网研究</a> · <a href="/projects/${id}/reference-video">参考视频</a> · <a href="/projects/${id}/models">模型设置</a> · <a href="/projects">项目列表</a></nav>
  <h1>智能生成 · 一键成片</h1><p>${esc(workspace.project.name)} · <b>最终成片目标 ${workspace.project.targetDurationMs / 1000} 秒</b></p>
  <section class="card" id="workflow-next-action" data-workflow-source="${esc(nextAction.source)}" data-workflow-run="${esc(nextAction.runId ?? "")}">
    <h2>当前工作流 · ${esc(nextAction.stageLabel)}</h2>
    <p><b>当前状态：</b>${esc(nextAction.statusLabel)}</p>
    <p><b>下一步：</b>${nextRunPaused && !nextCanAuthorize ? '<span class="status" role="status">等待当前任务执行器恢复</span>' : '<a class="primary" href="'+esc(workflowActionHref)+'">'+esc(nextAction.action.label)+'</a>'}</p>
    <p class="muted">${esc(nextAction.explanation)}</p>
    ${historyPublication}
    <div aria-label="当前工作流进度" style="margin:10px 0">${userPhases}</div>
    ${nextAction.phaseNote ? '<p id="workflow-phase-note" class="muted">'+esc(nextAction.phaseNote)+'</p>' : ''}
    ${nextAction.action.requiresExplicitConsent ? '<p class="muted">打开费用确认界面不代表授权或扣费；仍需由你确认本次具体范围。</p>' : ""}
  </section>
  ${taskChooser}
  <section class="card" id="workflow-purpose-entry">
    <h2>这次想完成什么？</h2>
    <p class="muted">按制作目的选择路径。已开始的任务会继续原进度，不会因为切换页面而自动产生新的图片、视频费用或发布动作。</p>
    <div class="purpose-options">
      <div class="purpose-option"><b>从零制作完整视频</b><p class="muted">准备产品资料、创意、剧本、分镜、生成和自动剪辑。</p><a href="${esc(active ? nextAction.taskSelectionRequired ? '#choose-task' : nextAction.runId ? '#smart-run-'+encodeURIComponent(nextAction.runId) : '#choose-task' : '#smart-create')}">${active ? nextAction.taskSelectionRequired ? '选择当前视频任务' : '继续当前完整视频任务' : '填写完整视频要求'}</a></div>
      <div class="purpose-option"><b>参考同类爆款创作</b><p class="muted">先查看联网研究，再将确认的参考用于创意。</p><button class="secondary" type="button" data-workflow-tool="research">在本任务中打开研究</button></div>
      <div class="purpose-option"><b>参考已有视频创作</b><p class="muted">上传和分析参考视频，确认后继续本轮创作。</p><button class="secondary" type="button" data-workflow-tool="reference-video">在本任务中打开参考视频</button></div>
      <div class="purpose-option"><b>只生成单个视频片段</b><p class="muted">单片段制作与完整成片分开，按其自身的授权流程执行。</p><a href="/projects/${id}/single-video">进入单片段生成</a></div>
      <div class="purpose-option"><b>已有素材，继续剪辑</b><p class="muted">进入 Timeline 编辑，不从头重复生成镜头。</p><a href="/projects/${id}/timeline">进入视频剪辑</a></div>
      <div class="purpose-option"><b>已有成片，发布或运营</b><p class="muted">先检查现有成片和真实发布状态，发布确认后才进入运营。</p><a href="/projects/${id}/final">检查成片与发布</a></div>
    </div>
  </section>
  <section class="card">
    <h2>产品准备状态</h2>
    <div class="asset-grid">
      <div class="asset-chip"><b>产品资料</b><br>${productInput ? "已保存" : "待补充"}</div>
      <div class="asset-chip"><b>产品图片</b><br>${productImageCount} 张可用图片</div>
      <div class="asset-chip"><b>产品事实</b><br>${truth?.status === "CONFIRMED" ? "已确认" : truth ? "待确认" : "尚未生成"}</div>
      <div class="asset-chip"><b>当前状态</b><br>${productReady ? "可以开始创作" : "需要先补齐产品基础"}</div>
    </div>
    ${productReady ? '<p class="muted">产品资料与事实会自动带入后续创意、资产规划、脚本、分镜和生成，不需要再次手工选择。</p>' : `<p><a href="/projects/${id}/product">补充产品资料</a>${truth && truth.status !== "CONFIRMED" ? ` · <a href="/projects/${id}/truth">确认产品事实</a>` : ""}</p>`}
  </section>
  <p><b>时长处理：</b>这里的 ${workspace.project.targetDurationMs / 1000} 秒是整条成片时长。系统会先据此生成完整创意与脚本，再读取所选 Seedance 模型的实时单镜头时长上限，由导演层自动拆成多个可生成镜头，逐镜头生成后自动剪辑；不会把 ${workspace.project.targetDurationMs / 1000} 秒作为一次 Seedance 请求。</p>
  ${defaults.fromReference ? '<p class="card"><b>已从参考视频页进入：</b>当前已启用的参考视频分析会自动作为本轮创意、脚本和导演分镜的结构参考。</p>' : ""}
  ${defaults.useResearch ? '<p class="card"><b>已从联网研究页进入：</b>“使用当前联网研究报告”已为本轮预先勾选。</p>' : ""}
  <p class="muted">已接入可恢复规划、批量生成、视觉 AI 辅助审片、规则自动剪辑、字幕与后期音轨。视觉 AI 只在你明确启用且产品身份、稳定性、使用约束、画质和固定时长剪辑窗口全部高置信通过时自动采用；其他情况返回人工审片。</p>
  <details class="card" id="workflow-support-materials"><summary><b>在当前页面补充研究和参考素材</b></summary>
    <p class="muted">在当前页查看研究与素材；确认结果自动带入原任务的下一次版本读取，不嵌套完整网页。</p>
    <div class="row"><button class="secondary" type="button" data-workflow-tool="research">联网研究</button><button class="secondary" type="button" data-workflow-tool="reference-video">参考视频</button><button class="secondary" type="button" data-workflow-tool="creative-references">创作参考素材池</button></div>
    <div id="workflow-tool-panel" aria-live="polite">${nativeTools}</div>
    <p class="ux-hint">需要高级多轮搜索、批量素材操作时，可从当前面板进入专业工具。</p>
  </details>
  <section class="card"><h2>可导入的创作上下文</h2>
    <p><a href="/projects/${id}/research">联网研究</a>：研究报告中的内容机会、结构方向和不确定项可以带入本轮创作；新产品事实仍需审核。</p>
    <p><a href="/projects/${id}/reference-video">参考视频</a>：当前已启用的参考视频分析会自动用于钩子、节奏、镜头语言和表现方法。</p>
    <p><a href="/projects/${id}/creative-references">创作参考素材池</a>：研究得到并已确认的图片 / 视频帧可作为视觉参考带入导演与视频生成。</p>
  </section>
  <p><b>完整链路：</b>产品资料 / 产品事实 → 用户想法 → 创意选择 → 自动制作策略 → 自动角色 / 场景资产 → 脚本 → 自动拆镜 → Seedance → 自动审片 → 自动剪辑 → 成片确认。</p>
  ${runs.some(run => Boolean(run.script)) ? `<section class="card" id="director-v3-preview-card">
    <h2>Director V3 A/B 影子预演</h2>
    <p>使用当前真实项目的旧脚本与旧 Seedance Prompt 做对照，重新跑 Director V3 的脚本 QA、复杂度分镜和 Prompt V3。<b>不会创建视频生成请求，也不会提交 Seedance 付费生成。</b></p>
    <button id="director-v3-preview">生成 A/B 预演（不生成视频）</button>
    <p class="muted" id="director-v3-preview-status"></p>
    <div id="director-v3-preview-result"></div>
  </section>` : ""}
  ${active ? '<p>本项目已有未结束的编排，请继续下方原任务，或明确停止后再创建。</p>' : `<section class="card"><h2>创建编排任务</h2><form id="smart-create">
  <label for="request-text">视频要求</label><textarea id="request-text" required maxlength="6000" placeholder="说明产品展示方式、使用场景、受众和创作要求"></textarea>
  <div class="row"><label class="field">目标视频模型<select id="smart-model" disabled></select></label><label class="field">画幅<select id="smart-ratio" disabled></select></label><label class="field">分辨率<select id="smart-resolution" disabled></select></label></div>
  <p><label><input type="checkbox" id="smart-native-audio" checked disabled> 默认保留 Seedance 原生声音（环境声 / 交互声 / 音效 / 对白 / OS），不生成 BGM</label></p><p class="muted" id="smart-audio-help"></p>
  <p class="muted">默认流程会自动生成制作策略、脚本和分镜，付费生成仍需要用户确认。选择「完整创作工作流」后，需要逐阶段人工确认剧本、导演分镜和视频提示词。</p>
  ${process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING === "1"
    ? '<p><label><input type="checkbox" id="smart-v8-authoring"> 完整创作工作流（分步审核）：详细剧本、人物动机、完整对白、导演分镜及视频提示词逐项确认；付费生成仍需单独授权。</label></p>'
    : ""}
  <p><label><input type="checkbox" id="auto-visual-review" checked> 高置信视觉自动采用生成镜头；不确定、产品变化、使用动作疑点或明显穿帮时自动暂停给人工审片。</label></p>
  <p class="muted">启用此项会调用“模型设置 → 视觉审片 / 智能剪辑”配置的图片理解模型；它不会额外提交 Dreamina 视频生成。</p>
  <p><label><input type="checkbox" id="use-research" ${defaults.useResearch ? "checked" : ""}> 使用当前联网研究报告的结构、内容机会与创作方向；新事实候选必须先审核。</label></p>
  <p><label><input type="checkbox" id="use-research-references"> 同时使用“创作参考素材池”中已明确确认的研究图片 / 视频帧。</label></p>
  ${renderPostProductionControls({ projectId: workspace.project.id, settings: {
    narrationMode: "SOURCE_OR_LOCAL_TTS",
    captions: true,
    omitMissingEffects: true,
    allowSilentOutput: false
  } })}
  <p class="muted">会保存新的创意、脚本与分镜版本，使旧生成前检查失效；历史素材与生成记录不删除。</p>
  <button id="start-smart" disabled>开始规划（不提交付费视频生成）</button><p class="error" id="create-error" role="alert"></p></form></section>`}
  <div id="run-list">${cards || '<p class="muted">尚无一键成片任务。</p>'}</div><p class="muted" id="poll-state"></p>
  </main>${postProductionBrowserScript}<script>${douyinResearchPreflightBrowserScript}</script><script>${savedReviewSyncBrowserScript}</script><script>
  (()=>{
    const project=document.querySelector('main').dataset.project,base='/api/projects/'+encodeURIComponent(project)+'/smart-runs';
    const publicCreationError=error=>String(error?.message??error??'').replaceAll('V8','完整创作');
    // The V8 preview is read-only and intentionally separate from all SmartRun
    // mutations and paid-generation buttons. Never adopt it by side effect.
    document.addEventListener('click',async event=>{
      const button=event.target?.closest?.('button[data-v8-refresh]');
      if(!button)return;
      const panel=button.closest('.v8-shadow-preview');
      const output=panel?.querySelector('.v8-shadow-result');
      if(!panel||!output)return;
      button.disabled=true;output.textContent='正在读取并核查已保存的剧本、正式分镜与模型时长，不会触发视频生成。';
      try{
        const bindings={};
        for(const select of panel.querySelectorAll('[data-v8-speaker]')){
          if(select.value)bindings[select.dataset.v8Speaker]=select.value;
        }
        const path=base+'/'+encodeURIComponent(panel.dataset.v8Run)+'/v8-shadow'
          +'?bindings='+encodeURIComponent(JSON.stringify(bindings));
        const response=await fetch(path,{headers:{accept:'application/json'},cache:'no-store'});
        const result=await response.json();
        if(!response.ok)throw new Error(result.message||'导演对照预览暂不可用');
        output.replaceChildren();
        const fidelity=result.preview.fidelity;
        const shotFirst=result.preview.shotFirst;
        const screenplay=result.preview.screenplay;
        const status=document.createElement('p');
        const semanticShots=shotFirst.clips.flatMap(clip=>clip.shots)
          .filter(shot=>(shot.speechPartCount||1)>1).length;
        status.textContent='旧方案逐镜核查：'+(fidelity.status==='PASS'?'结构检查通过':'尚需处理差异')
          +' · 新版镜头时长与台词规则：'+(shotFirst.status==='PASS'?'结构检查通过（尚未正式采用）':'需要修改')
          +' · 自然语义分句镜头 '+semanticShots+' 个'
          +' · 原方案 '+fidelity.clips.length+' 段'
          +' · 新版时长备选 '+shotFirst.clips.length+' 段（'
          +shotFirst.clips.map(c=>c.durationMs/1000+'秒').join('、')+'）';
        output.append(status);
        const storyDetails=document.createElement('details');
        const storyTitle=document.createElement('summary');
        storyTitle.textContent='查看详细剧本源数据与待补充的表演信息';
        storyDetails.append(storyTitle);
        for(const scene of screenplay.scenes){
          const title=document.createElement('p');
          title.textContent='场 '+scene.sceneNo+' · '+scene.location+' · '+scene.plannedDurationMs/1000+'秒';
          storyDetails.append(title);
          const content=document.createElement('pre');content.className='v8-prompt-pre';
          content.textContent=scene.beats.map(beat=>beat.order+' · '+beat.action+'\\n'+
            beat.lines.map(line=>line.speakerName+':“'+line.exactText+'”').join('\\n')).join('\\n');
          storyDetails.append(content);
        }
        for(const issue of screenplay.issues){
          const message=document.createElement('p');message.className='muted';
          message.textContent=issue.message;storyDetails.append(message);
        }
        output.append(storyDetails);
        for(const issue of fidelity.issues){
          const item=document.createElement('p');
          item.className='ux-inline-error';
          item.textContent=issue.message;output.append(item);
        }
        for(const issue of shotFirst.issues){
          const item=document.createElement('p');
          item.className='ux-inline-error';
          item.textContent='镜头时间需调整：'+issue.message;output.append(item);
        }
        const previewTable=document.createElement('details');
        const previewTitle=document.createElement('summary');
        previewTitle.textContent='查看 Shot-first 不等长镜头与时长分配';
        previewTable.append(previewTitle);
        for(const clip of shotFirst.clips){
          const p=document.createElement('p');
          p.className='muted';p.textContent='视频编号 '+clip.order+' · '+clip.durationMs/1000+'秒 · '+clip.shots.length+' 个镜头';
          previewTable.append(p);
          const pre=document.createElement('pre');pre.className='v8-prompt-pre';
          pre.textContent=clip.shots.map(shot=>(
            shot.startMs/1000+'–'+shot.endMs/1000+'秒 · '+shot.description
          )).join('\\n');
          previewTable.append(pre);
        }
        output.append(previewTable);
        for(const clip of fidelity.clips){
          const details=document.createElement('details');
          const label=document.createElement('summary');
          label.textContent='视频 '+clip.clipIndex+' · '+clip.durationMs/1000+'秒 · 逐镜提示词（只读对照）';
          const pre=document.createElement('pre');pre.className='v8-prompt-pre';pre.textContent=clip.promptText;
          details.append(label,pre);output.append(details);
        }
      }catch(error){
        output.textContent='预演失败：'+publicCreationError(error);
      }finally{button.disabled=false;}
    });
    // UX-R2: DOM relocation is presentation-only; all existing forms, buttons,
    // native review handlers and saved data remain unchanged. Legacy is available
    // by an explicit ?ui=legacy opt-out until the later user acceptance gate.
    (()=>{
      const root=document.querySelector('main');
      if(new URLSearchParams(location.search).get('ui')==='legacy')return;
      root.classList.add('ux-workbench');
      const active=Boolean(document.querySelector('.run:not([data-status="COMPLETED"]):not([data-status="CANCELLED"])'))
        || document.querySelector('#workflow-next-action')?.dataset.workflowSource==='TASK_SELECTION';
      const head=document.createElement('div');head.className='ux-top';
      head.innerHTML='<div class="ux-top-brand">项目工作台<small>当前只显示此项目需要处理的操作</small></div>'
        +'<div class="ux-top-tools"><a href="/projects/'+encodeURIComponent(project)+'/models">此项目模型</a>'
        +'<a href="/projects/'+encodeURIComponent(project)+'/smart?ui=legacy">旧版回退</a></div>';
      root.insertBefore(head,root.firstChild);
      const h=root.querySelector('h1');
      if(h)h.textContent=active?'继续当前制作任务':'开始制作产品视频';
      const intro=document.createElement('p');intro.className='ux-lead';
      intro.textContent='当前只需完成一项操作；已保存资料、生成结果、镜头和授权记录不会因切换页面被覆盖。';
      h?.after(intro);
      const grid=document.createElement('div');grid.className='ux-grid';
      const sidebar=document.createElement('aside');sidebar.className='ux-stages';
      const heading=document.createElement('h2');heading.textContent='制作进度';sidebar.append(heading);
      const progress=document.querySelector('[aria-label="当前工作流进度"]');
      const labelTexts=['产品与事实','研究与创意','制作准备','视频与审片','剪辑与成片','发布与运营'];
      const ordered=document.createElement('ol');
      for(const [i,label] of labelTexts.entries()){
        const li=document.createElement('li');
        const value=[...progress?.children||[]].find(n=>n.textContent.includes(label))?.textContent||'';
        const status=value.includes(' · 当前')?'CURRENT':(value.includes(' · 已过')||value.includes(' · 已确认'))?'DONE':value.includes(' · 可选')?'OPTIONAL':'UPCOMING';
        li.dataset.state=status;
        const num=document.createElement('span');num.className='stage-number';num.textContent=status==='DONE'?'✓':String(i+1);
        const title=document.createElement('b');title.textContent=label;
        const suffix=document.createElement('small');suffix.textContent=status==='CURRENT'?'当前':status==='DONE'?(value.includes(' · 已确认')?'已确认':'已过'):status==='OPTIONAL'?'可选':'未开始';
        li.append(num,title,suffix);ordered.append(li);
      }
      sidebar.append(ordered);
      const phaseNote=document.querySelector('#workflow-phase-note');
      if(phaseNote)sidebar.append(phaseNote.cloneNode(true));
      const foot=document.createElement('p');foot.textContent='真实付费、素材确认与抖音发布均需要独立授权。';sidebar.append(foot);
      const column=document.createElement('section');column.className='ux-main';
      column.setAttribute('aria-label','当前任务');
      grid.append(sidebar,column);
      const actionBox=document.querySelector('#workflow-next-action');
      actionBox?.before(grid);
      if(actionBox)column.append(actionBox);
      const choice=document.querySelector('#choose-task');
      if(choice)column.append(choice);
      const purposes=document.querySelector('#workflow-purpose-entry');
      const creation=document.querySelector('#smart-create')?.closest('.card');
      const runs=document.querySelector('#run-list');
      const poll=document.querySelector('#poll-state');
      if(active){
        if(runs)column.append(runs);
        if(poll)column.append(poll);
      }else{
        if(purposes)column.append(purposes);
        if(creation)column.append(creation);
      }
      const tools=document.createElement('section');tools.className='ux-bottom';tools.id='ux-advanced-tools';
      root.append(tools);
      if(active && purposes){
        const extra=document.createElement('details');extra.className='ux-optional';extra.id='ux-new-goal-options';
        const summary=document.createElement('summary');summary.textContent='其他制作目标及工具（不影响当前任务）';
        extra.append(summary,purposes);tools.append(extra);
      }
      const remaining=[...root.children].filter(x=>x!==head&&x!==intro&&x!==grid&&x!==h&&x!==tools&&x.nodeName!=='NAV');
      for(const element of remaining){
        if(element===creation&&!active)continue;
        if(element===runs&&!active){
          const details=document.createElement('details');details.className='ux-run-history ux-optional';
          const summary=document.createElement('summary');summary.textContent='查看历史编排记录';
          details.append(summary,element);tools.append(details);continue;
        }
        if(element===poll&&!active){tools.append(element);continue;}
        if(element.tagName==='DETAILS'){element.classList.add('ux-optional');tools.append(element);continue;}
        const details=document.createElement('details');details.className='ux-optional';
        const summary=document.createElement('summary');
        summary.textContent=element.id==='workflow-support-materials'?'研究、参考视频与素材'
          :element.id==='director-v3-preview-card'?'Director V3 专业对照'
          :element.textContent.includes('产品准备状态')?'产品资料与事实状态'
          :element.textContent.includes('时长处理')?'时长与自动剪辑说明'
          :element.textContent.includes('可导入的创作上下文')?'创作参考来源'
          :element.textContent.includes('完整链路')?'完整制作流程'
          :'其他专业信息';
        details.append(summary,element);tools.append(details);
      }
      const advancedNotice=document.createElement('p');advancedNotice.className='ux-primary-prompt';
      advancedNotice.textContent='专业修改可展开下方对应模块。修改上游内容前会告知版本影响范围。';
      column.append(advancedNotice);
    })();

    // Read-only status polling below keeps this task current; no manual refresh buttons are exposed.
    document.querySelectorAll('[data-workflow-tool]').forEach(button=>button.addEventListener('click',()=>{
      const panel=document.querySelector('#workflow-tool-panel');
      if(!panel)return;
      const details=document.querySelector('#workflow-support-materials');
      if(details)details.open=true;
      // This page now uses a native reference panel instead of a nested document.
      const page=button.dataset.workflowTool;
      if(!['research','reference-video','creative-references'].includes(page))return;
      panel.querySelectorAll('[data-ux-tool-view]').forEach(view=>view.hidden=view.dataset.uxToolView!==page);
      panel.scrollIntoView({block:'nearest',behavior:'smooth'});
    }));
    function openEmbeddedReview(){if(!location.hash.startsWith('#review-panel-'))return;const panel=document.getElementById(location.hash.slice(1));if(panel?.classList.contains('embedded-review'))panel.open=true;}
    window.addEventListener('hashchange',openEmbeddedReview);openEmbeddedReview();
    let busy=false;const form=document.querySelector('#smart-create');
    async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||'操作失败');return j;}const textLines=value=>String(value||'').split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);
    const makeEl=(tag,textValue,className)=>{const el=document.createElement(tag);if(textValue!==undefined)el.textContent=textValue;if(className)el.className=className;return el;};
    // UX-R3 native review controls: exact existing endpoints; the server owns
    // version, rights, approval, cost and clip dependency checks.
    let inlineBusy=false;
    const inlineError=(root,text)=>{const el=root?.querySelector('.ux-inline-error');if(el)el.textContent=text;};
    const syncBanner=document.createElement('section');syncBanner.className='card';document.querySelector('main').prepend(syncBanner);
    const reviewSync=window.createPvsSavedReviewSync({project,post,storage:localStorage,onPending:(rows,durable)=>{
      syncBanner.replaceChildren();syncBanner.hidden=!rows.length;if(!rows.length)return;
      const message=document.createElement('p');message.textContent='审核已保存，原任务状态仍待同步。请只补同步，不必再次审核或重新生成。'+(durable?'':'浏览器未能持久保存此提示，请先完成同步再关闭本页。');syncBanner.append(message);
      for(const row of rows){const link=document.createElement('a');link.textContent='查看原任务 '+row.runId.slice(0,8);link.href='/projects/'+encodeURIComponent(project)+'/smart?activeRun='+encodeURIComponent(row.runId);syncBanner.append(link);const button=document.createElement('button');button.textContent='仅同步原任务 '+row.runId.slice(0,8);button.onclick=async()=>{button.disabled=true;try{await reviewSync.retry(row.id);location.reload();}catch(error){message.textContent='审核已保存、同步仍未完成：'+error.message+'。不会重新提交审核或视频生成。';button.disabled=false;}};syncBanner.append(button);}
    }});
    document.addEventListener('click',async(event)=>{
      const button=event.target.closest?.('[data-inline-action]');
      if(!button||inlineBusy)return;
      const review=button.closest('.ux-native-review')||document;
      const action=button.dataset.inlineAction;
      const run=document.querySelector('#workflow-next-action')?.dataset.workflowRun;
      const pid='/api/projects/'+encodeURIComponent(project);
      let endpoint='',payload={};
      if(action==='truth-confirm'){
        endpoint=pid+'/truth/confirm';
        const dispositions={},usageRuleDispositions={};
        review.querySelectorAll('[data-inline-claim]').forEach(el=>dispositions[el.dataset.inlineClaim]=el.value);
        review.querySelectorAll('[data-inline-usage]').forEach(el=>usageRuleDispositions[el.dataset.inlineUsage]=el.value);
        payload={projectId:project,dispositions,usageRuleDispositions};
        if(!confirm('确定确认这些产品信息？只有你明确提升为事实的内容才会成为后续广告依据。'))return;
      } else if(action==='ref-review'){
        endpoint=pid+'/creative-references/review';
        const card=button.closest('.ux-ref-candidate');
        const container=review.closest('[data-ux-tool-view]')||review;
        const main=container.querySelector('#ux-reference-review')||review;
        const decision=button.dataset.decision;
        const rights=Boolean(main.querySelector('#ux-reference-rights')?.checked);
        if(decision==='INCLUDE'&&!rights){inlineError(main,'请先确认素材使用权，不能直接加入。');return;}
        payload={expectedRevision:Number(main.dataset.revision),expectedTruthHash:main.dataset.truth,acknowledgeRights:rights,
          changes:[{candidateId:card.dataset.uxRefId,candidateHash:card.dataset.uxRefHash,decision,
            ...(decision==='INCLUDE'?{role:card.querySelector('.ux-ref-role').value}:{})}]};
        if(!confirm('确认本次素材审核？修改已确认参考可能使依赖它的下游版本失效，但不会覆盖已生成的视频。'))return;
      } else if(action==='clip-decision'){
        const decision=button.dataset.decision,clip=button.dataset.clip,attempt=button.dataset.attempt;
        if(!['ACCEPT','REDO','SKIP'].includes(decision))return;
        if(!confirm(decision==='REDO'?'只标记本镜头需要重做；新视频生成及新增积分仍需单独授权。继续吗？':
           decision==='SKIP'?'明确跳过本镜头？将从后续剪辑中排除本镜头，但历史记录不会删除。继续吗？':'确认采用此镜头的当前已下载候选视频？'))return;
        endpoint=pid+'/clips/'+encodeURIComponent(clip)+'/review';
        payload={decision,...(attempt&&decision!=='SKIP'?{generationAttemptId:attempt}:{})};
      } else if(action==='clip-finalize'){
        if(!confirm('将根据已确认采用或明确跳过的镜头准备剪辑；不会提交新视频生成。继续吗？'))return;
        endpoint=pid+'/review/finalize-selection';
      } else if(action==='final-qc'){
        if(!confirm('对当前已渲染的成片执行检查？该操作不发布作品。'))return;
        endpoint=pid+'/final/qc';
      } else if(action==='final-accept'){
        if(!confirm('确认已完整观看本轮成片、检查画面与音频且愿意采用该版本？此操作不会发布到抖音。'))return;
        endpoint=pid+'/final/accept';
      } else return;
      inlineBusy=true;button.disabled=true;inlineError(review,'');
      let reviewSaved=false;
      try{
        await post(endpoint,payload);reviewSaved=true;
        // Only after an explicit user's non-paid review decision has been saved,
        // resume the exact originating run. The SmartRun service still owns all
        // version, asset, cost and paid-generation gates. Never retry an unknown
        // remote submit or silently grant a new cost authorization.
        if(run&&['truth-confirm','ref-review','clip-decision','clip-finalize'].includes(action) && !(action==='clip-decision'&&payload.decision==='REDO')){
          const source=document.querySelector('[data-run="'+CSS.escape(run)+'"]');
          const followup=reviewSync.remember(run,'resume',Number(source?.dataset.revision));
          try{await reviewSync.retry(followup.id);}
          catch(error){inlineError(review,'审核已保存、待同步原任务。请使用页面上方的“仅同步原任务”，无需再次确认。');inlineBusy=false;return;}
        }
        if(run&&action==='final-accept'){
          const source=document.querySelector('[data-run="'+CSS.escape(run)+'"]');
          const followup=reviewSync.remember(run,'final-confirmed',Number(source?.dataset.revision));
          try{await reviewSync.retry(followup.id);}
          catch(error){inlineError(review,'成片已确认、任务结束状态待同步。请使用页面上方的“仅同步原任务”。');inlineBusy=false;return;}
        }
        // Exact run context is preserved in the URL; saved decisions are never
        // re-submitted just because the user refreshed the page.
        location.reload();
      }catch(error){
        inlineError(review,(reviewSaved?'审核已保存，原任务同步尚未完成：':'操作未被确认完成：')+(error.message||String(error))+'。请先核对当前状态，不自动重试或重复扣费。');
        inlineBusy=false;button.disabled=reviewSaved;
      }
    });
    // Research is optional but can be started in-place with explicit user intent.
    // It uses only the existing research route, never the paid Seedance submit.
    document.querySelector('#ux-native-research-form')?.addEventListener('submit',async event=>{
      event.preventDefault();if(inlineBusy)return;
      const form=event.currentTarget,fd=new FormData(form);
      const goal=String(fd.get('goal')||'').trim();
      const mode=fd.get('mode')==='DEEP'?'DEEP':'BASIC';
      const note=form.closest('.ux-native-review'),button=form.querySelector('button[type="submit"]');
      if(!goal){inlineError(note,'请先填写研究目标。');return;}
      if(!confirm('确认开始'+(mode==='DEEP'?'深度':'基础')+'研究？可能使用当前已配置的 AI 模型，但不会调用付费 Seedance 视频生成。'))return;
      inlineBusy=true;button.disabled=true;inlineError(note,'正在研究，请不要重复提交；完成后自动更新当前结果。');
      try{
        await post('/api/projects/'+encodeURIComponent(project)+'/research/run',{
          mode,goal,sourceUrls:[],queries:[],
          marketVideo:{enabled:fd.get('marketVideoEnabled')==='on',sort:'MOST_LIKED',timeRange:'ANY',count:12}
        });
        location.reload();
      }catch(error){
        inlineError(note,'研究未确认完成：'+(error.message||String(error))+'。请核对已有任务后再决定是否重试。');
        inlineBusy=false;button.disabled=false;
      }
    });
    document.querySelector('#ux-reference-upload')?.addEventListener('submit',async event=>{
      event.preventDefault();if(inlineBusy)return;
      const form=event.currentTarget,file=form.querySelector('input[name="video"]')?.files?.[0];
      const note=form.closest('.ux-native-review');
      if(!file){inlineError(note,'请选择一个 MP4 或 MOV 视频');return;}
      if(!['video/mp4','video/quicktime'].includes(file.type)&&!file.name.toLowerCase().endsWith('.mp4')&&!file.name.toLowerCase().endsWith('.mov')){
        inlineError(note,'只允许 MP4 或 MOV 视频');return;
      }
      if(!confirm('上传并分析此参考视频？这是多模态分析，可能使用已配置的 AI 模型，但不会调用付费 Seedance 视频生成。'))return;
      inlineBusy=true;const submit=form.querySelector('button[type="submit"]');submit.disabled=true;
      try{
        const video=await new Promise((resolve,reject)=>{
          const reader=new FileReader();
          reader.onerror=()=>reject(new Error('读取本地视频失败'));
          reader.onload=()=>resolve({name:file.name,mimeType:file.type||(file.name.toLowerCase().endsWith('.mov')?'video/quicktime':'video/mp4'),base64:String(reader.result||'')});
          reader.readAsDataURL(file);
        });
        await post('/api/projects/'+encodeURIComponent(project)+'/reference-video/analyze',{video});
        location.reload();
      }catch(error){
        inlineError(note,'分析状态未确认：'+(error.message||String(error))+'。请核对结果，避免重复分析。');
        inlineBusy=false;submit.disabled=false;
      }
    });

    const previewButton=document.querySelector('#director-v3-preview');
    if(previewButton){const previewStatus=document.querySelector('#director-v3-preview-status'),previewResult=document.querySelector('#director-v3-preview-result');previewButton.addEventListener('click',async()=>{previewButton.disabled=true;busy=true;previewStatus.textContent='正在读取旧版真实项目并生成 Director V3 影子预演；不会提交 Seedance 视频生成…';previewResult.replaceChildren();try{const data=await post('/api/projects/'+encodeURIComponent(project)+'/director-v3-preview',{}),p=data.preview;previewStatus.textContent='A/B 预演完成。旧任务未修改，未创建新视频生成请求。';
      const top=makeEl('div');top.append(makeEl('h3','A/B 预演结果'));top.append(makeEl('p','旧版：'+p.baseline.clipCount+' 条真实视频请求；新版：'+p.directorV3Plan.clipContracts.length+' 条 Clip Contract。'));top.append(makeEl('p','旧脚本 QA：'+p.scriptBefore.status+' → V3 修复后：'+p.scriptAfter.status,'muted'));previewResult.append(top);
      const oldBox=makeEl('details');oldBox.open=true;oldBox.append(makeEl('summary','A｜旧版 V2 真实请求'));for(const [i,r] of p.baseline.requests.entries()){oldBox.append(makeEl('h4','旧视频 '+(i+1)+' · '+(r.durationMs/1000)+' 秒 · 原生音轨='+String(r.generateAudio)));const ta=makeEl('textarea');ta.readOnly=true;ta.value=r.promptText;ta.style.minHeight='180px';oldBox.append(ta);if(r.outputArtifactId){const a=makeEl('a','查看旧版真实视频');a.href='/api/artifacts/'+encodeURIComponent(r.outputArtifactId)+'/content';a.target='_blank';a.rel='noopener';oldBox.append(a);}}previewResult.append(oldBox);
      const scriptBox=makeEl('details');scriptBox.open=true;scriptBox.append(makeEl('summary','B｜Director V3 修复后的剧本'));for(const beat of p.repairedScript.beats){scriptBox.append(makeEl('p','Beat '+beat.order+' · '+(beat.estimatedDurationMs/1000)+' 秒 · '+beat.text));if(beat.videoIntent)scriptBox.append(makeEl('p','场景：'+beat.videoIntent.location+'；动作：'+beat.videoIntent.storyAction+'；声音：'+[...(beat.videoIntent.audioIntent.ambience||[]),...(beat.videoIntent.audioIntent.sfx||[])].join('、'),'muted'));}previewResult.append(scriptBox);
      const clipBox=makeEl('details');clipBox.open=true;clipBox.append(makeEl('summary','C｜Director V3 分镜'));for(const [i,c] of p.directorV3Plan.clipContracts.entries()){clipBox.append(makeEl('h4','视频 '+(i+1)+' · '+(c.durationMs/1000)+' 秒 · '+c.location));clipBox.append(makeEl('p',c.purpose));for(const a of c.actions)clipBox.append(makeEl('p',(a.startMs/1000)+'–'+(a.endMs/1000)+' 秒：'+a.description,'muted'));clipBox.append(makeEl('p','声音：环境 '+c.audio.ambience.join('、')+'；音效 '+c.audio.sfx.join('、')+'；BGM=禁止','muted'));}previewResult.append(clipBox);
      const promptBox=makeEl('details');promptBox.open=true;promptBox.append(makeEl('summary','D｜最终 Seedance Prompt V3'));for(const [i,d] of p.prompts.entries()){promptBox.append(makeEl('h4','视频 '+(i+1)+' Prompt'));const ta=makeEl('textarea');ta.readOnly=true;ta.value=d.promptText;ta.style.minHeight='260px';promptBox.append(ta);}previewResult.append(promptBox);
      if(p.artifact?.id){const a=makeEl('a','查看完整 A/B JSON 审计包');a.href='/api/artifacts/'+encodeURIComponent(p.artifact.id)+'/content';a.target='_blank';a.rel='noopener';previewResult.append(a);}
    }catch(e){previewStatus.textContent='A/B 预演失败：'+publicCreationError(e);}finally{previewButton.disabled=false;busy=false;}});}
    if(form){const model=document.querySelector('#smart-model'),ratio=document.querySelector('#smart-ratio'),resolution=document.querySelector('#smart-resolution'),audio=document.querySelector('#smart-native-audio'),start=document.querySelector('#start-smart');let registry=null;const requestKey=crypto.randomUUID();
      const intersection=a=>a.length?a.reduce((x,y)=>x.filter(v=>y.includes(v))):[];
      const fill=(el,values,old)=>{el.replaceChildren();for(const v of values){const o=document.createElement('option');o.value=v;o.textContent=v==='AUTO'?'自动 / 跟随素材':v;el.append(o);}if(values.includes(old))el.value=old;el.disabled=!values.length;};
      const refresh=()=>{const ops=['text2video','multimodal2video'].map(n=>registry.operations.find(o=>o.operation===n));const caps=ops.map(o=>o.models.find(m=>m.modelVersion===model.value));if(caps.some(c=>!c))return;
        fill(ratio,['AUTO',...(caps.every(c=>c.explicitRatioAllowed)?intersection(ops.map(o=>o.supportedRatios)):[])],ratio.value||'9:16');fill(resolution,intersection(caps.map(c=>c.supportedResolutions)),resolution.value||'720p');
        const supported=ops.every(o=>o.supportsNativeAudioOutput);audio.disabled=!supported;if(!supported)audio.checked=false;
        document.querySelector('#smart-audio-help').textContent=supported?'Director V3 默认请求 Seedance 原生音轨，并在每条视频提示词中明确禁止 BGM；保留自然环境声、动作交互声、音效，以及剧本指定的对白 / OS。若模型仍生成疑似 BGM，保留原音并提示重做，不会整轨静音。':'当前生成方式不能保证返回音轨；Director V3 不会在这种能力下提交需要原生声音的镜头。';start.disabled=${productReady ? "false" : "true"}||!model.value||!resolution.value;};
      model.addEventListener('change',refresh);
      fetch('/api/dreamina/capabilities').then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.message||'读取能力失败');registry=j.registry;const ops=['text2video','multimodal2video'].map(n=>registry.operations.find(o=>o.operation===n));if(ops.some(o=>!o))throw new Error('当前命令能力不完整');fill(model,intersection(ops.map(o=>o.supportedModels)),'seedance2.0mini');refresh();}).catch(e=>document.querySelector('#create-error').textContent=publicCreationError(e));
      form.addEventListener('submit',async e=>{e.preventDefault();start.disabled=true;busy=true;try{await post(base,{requestKey,options:{requestText:document.querySelector('#request-text').value,directorVersion:3,directorPipeline:document.querySelector('#smart-v8-authoring')?.checked?'V8':undefined,generationSettings:{requestedModelVersion:model.value,aspectRatio:ratio.value,videoResolution:resolution.value,nativeAudioOutputRequested:audio.checked},reviewMode:document.querySelector('#smart-v8-authoring')?.checked?'MANUAL':'AUTO',autoSelectLowRiskClips:document.querySelector('#auto-visual-review').checked,useExistingResearch:document.querySelector('#use-research').checked,useResearchReferences:document.querySelector('#use-research-references').checked,postProduction:window.pvsReadPostProduction(form.querySelector('.post-production-settings'))}});location.reload();}catch(e){document.querySelector('#create-error').textContent=publicCreationError(e);start.disabled=false;busy=false;}});
    }
    for(const t of document.querySelectorAll('.asset-prompt-text:not([readonly]),.v3-editor:not([readonly]),.v8-editor,.v8-production-editor'))t.addEventListener('input',()=>t.dataset.dirty='1');
    for(const card of document.querySelectorAll('.run'))for(const b of card.querySelectorAll('[data-action]'))b.addEventListener('click',async()=>{const action=b.dataset.action;let endpoint=action,body={};const assetCard=b.closest('.asset-card'),prompt=assetCard?.querySelector('.asset-prompt-text')?.value?.trim();
      if(action==='authorize-worker'){
        if(!confirm('只恢复当前这一条任务的后台规划？旧项目不会自动继续，涉及付费图片或视频时仍须明确确认。'))return;
        body={expectedRevision:Number(card.dataset.revision),confirmCurrentTask:true};
      }
      if(action==='director-v8'){
        const visualGuidance={};for(const el of card.querySelectorAll('[data-v8-shot]'))if(el.value.trim())visualGuidance[el.dataset.v8Shot]=el.value.trim();
        body={expectedRevision:Number(card.dataset.revision),visualGuidance};
      }
      if(action==='plan-v8'){
        const segments=[...card.querySelectorAll('[data-v8-segment]')].map(el=>({id:el.dataset.v8Segment,
          composition:el.querySelector('[data-v8-composition]').value.trim(),cameraMovement:el.querySelector('[data-v8-camera]').value.trim(),
          lighting:el.querySelector('[data-v8-lighting]').value.trim()}));
        body={expectedRevision:Number(card.dataset.revision),segments};
      }
      if(action==='prompts-v8'){
        const voiceBindings={};for(const el of card.querySelectorAll('[data-v8-voice]'))voiceBindings[el.dataset.v8Voice]={actorAssetKey:el.querySelector('select').value,voiceType:el.querySelector('input').value.trim()};
        body={expectedRevision:Number(card.dataset.revision),voiceBindings};
      }
      if(action==='script-v8'){
        const panel=card.querySelector('.v8-edit-panel');
        if(!panel){card.querySelector('.action-error').textContent='没有可编辑的完整剧本';return;}
        if(!confirm('保存修改将创建新的完整剧本版本，重新审核；旧分镜和旧付费授权不能沿用。继续吗？'))return;
        try{
          const response=await fetch(base+'/'+encodeURIComponent(card.dataset.run));
          const live=await response.json();
          if(!response.ok||!live.run?.v8Screenplay)throw new Error('当前完整剧本版本不可用');
          if(live.run.revision!==Number(card.dataset.revision))throw new Error('任务版本已更新，请先刷新页面');
          const proposal=structuredClone(live.run.v8Screenplay.screenplay);
          for(const control of panel.querySelectorAll('.v8-editor')){
            const k=control.dataset.v8Kind;
            const s=control.dataset.v8Scene;
            const a=control.dataset.v8Actor;
            const bIndex=control.dataset.v8Beat;
            const l=control.dataset.v8Line;
            let target=proposal;
            if(s!==undefined)target=proposal.scenes[Number(s)];
            if(a!==undefined)target=target.actorObjectives[Number(a)];
            if(bIndex!==undefined)target=target.beats[Number(bIndex)];
            if(l!==undefined)target=target.dialogue[Number(l)];
            if(!target||!Object.prototype.hasOwnProperty.call(target,k)){
              throw new Error('编辑字段已变化，请刷新后重试');
            }
            if(k==='estimatedDurationMs'){
              const seconds=Number(control.value);
              if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw new Error('单段时长应为1–120秒');
              target[k]=Math.round(seconds*1000);
            }else if(['postProductionText','ambience','sfx'].includes(k)){
              target[k]=control.value.split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);
            }else{
              target[k]=control.value.trim();
            }
          }
          const total=proposal.scenes.flatMap(scene=>scene.beats)
            .reduce((sum,beat)=>sum+beat.estimatedDurationMs,0);
          if(total!==live.run.targetDurationMs)throw new Error(
            '全部事件总时长必须为'+(live.run.targetDurationMs/1000)+'秒，目前为'+(total/1000)+'秒');
          body={expectedRevision:Number(card.dataset.revision),screenplay:proposal};
        }catch(e){card.querySelector('.action-error').textContent=publicCreationError(e);return;}
      }
      if(action==='repair-script-v3'){
        if(!confirm('确认调用文本模型按剧情重编本轮剧本与段落时长？旧分镜、提示词和费用范围会失效，需重新审核；不会提交任何付费图片或视频。'))return;
        body={expectedRevision:Number(card.dataset.revision),confirmScriptRepair:true};
      }
      if(action==='script-v3'){
        if(!confirm('保存剧本修改后，当前分镜、Seedance Prompt 和生成前检查会重新生成；产品事实和制作资产不会重做。继续吗？'))return;
        const beats=[...card.querySelectorAll('.v3-script-beat')].map(block=>{
          const dialogue=block.querySelector('.v3-script-dialogue').value.trim(),os=block.querySelector('.v3-script-os').value.trim();
          return {id:block.dataset.beatId,order:Number(block.dataset.order),purpose:block.dataset.purpose,text:block.querySelector('.v3-script-text').value.trim(),estimatedDurationMs:Math.round(Number(block.querySelector('.v3-script-duration').value)*1000),requiredFactIds:(block.dataset.requiredFacts||'').split(',').filter(Boolean),videoIntent:{location:block.querySelector('.v3-script-location').value.trim(),storyAction:block.querySelector('.v3-script-action').value.trim(),productRole:block.querySelector('.v3-script-product-role').value.trim(),stateIn:block.querySelector('.v3-script-state-in').value.trim(),stateOut:block.querySelector('.v3-script-state-out').value.trim(),...(block.querySelector('.v3-script-product-state-in').value.trim()?{productStateIn:block.querySelector('.v3-script-product-state-in').value.trim()}:{}),...(block.querySelector('.v3-script-product-state-out').value.trim()?{productStateOut:block.querySelector('.v3-script-product-state-out').value.trim()}:{}),...(dialogue?{dialogue}:{}),...(os?{os}:{}),audioIntent:{ambience:textLines(block.querySelector('.v3-script-ambience').value),sfx:textLines(block.querySelector('.v3-script-sfx').value),bgm:false},postProductionText:textLines(block.querySelector('.v3-script-post-text').value)}};
        });
        if(beats.some(beat=>!Number.isInteger(beat.estimatedDurationMs)||beat.estimatedDurationMs<1000)){
          card.querySelector('.action-error').textContent='每段预计时长至少1秒，请检查填写的时长';return;
        }
        const targetMs=${workspace.project.targetDurationMs},sum=beats.reduce((n,beat)=>n+beat.estimatedDurationMs,0);
        if(Math.abs(sum-targetMs)>Math.round(targetMs*0.1)){
          card.querySelector('.action-error').textContent='剧本总时长需在用户目标±10%以内；当前 '+(sum/1000)+'秒，允许 '+(targetMs*0.9/1000)+'–'+(targetMs*1.1/1000)+'秒';return;
        }
        body={expectedRevision:Number(card.dataset.revision),beats};
      }
      if(action==='storyboard-v3'){
        if(!confirm('保存此分镜后，只重建正式分镜、Seedance Prompt 和生成前检查；剧本保持不变。继续吗？'))return;
        const panel=b.closest('.v3-storyboard');
        body={expectedRevision:Number(card.dataset.revision),clipId:panel.dataset.clipId,purpose:panel.querySelector('.v3-purpose').value.trim(),location:panel.querySelector('.v3-location').value.trim(),actionDescriptions:[...panel.querySelectorAll('.v3-action-text')].map(item=>item.value.trim()),camera:{shotSize:panel.querySelector('.v3-camera-shot').value.trim(),position:panel.querySelector('.v3-camera-position').value.trim(),angle:panel.querySelector('.v3-camera-angle').value.trim(),movement:panel.querySelector('.v3-camera-movement').value.trim()},audio:{ambience:textLines(panel.querySelector('.v3-audio-ambience').value),sfx:textLines(panel.querySelector('.v3-audio-sfx').value),dialogueOrOs:[...textLines(panel.querySelector('.v3-audio-dialogue').value).map(text=>({kind:'DIALOGUE',text})),...textLines(panel.querySelector('.v3-audio-os').value).map(text=>({kind:'OS',text}))]}};
      }
      if(action==='prompt-v3'){
        const panel=b.closest('.v3-prompt'),text=panel.querySelector('.v3-prompt-text').value.trim();
        if(!text){card.querySelector('.action-error').textContent='Seedance Prompt 不能为空';return;}
        body={expectedRevision:Number(card.dataset.revision),clipId:panel.dataset.clipId,prompt:text};
      }
      if(action==='asset-prompt'){if(!prompt){card.querySelector('.action-error').textContent='资产提示词不能为空';return;}body={expectedRevision:Number(card.dataset.revision),assetKey:b.dataset.asset,prompt};}
      if(action==='regenerate-asset'){if(!prompt){card.querySelector('.action-error').textContent='请先填写用于重新生成的资产提示词';return;}if(!confirm('重新生成会创建一次新的图片生成请求，并在下一步要求重新确认积分。原图片记录会保留。继续吗？'))return;body={expectedRevision:Number(card.dataset.revision),assetKey:b.dataset.asset,prompt};}
      if(action==='resume' && b.dataset.visualRecheck==='1' &&
          !confirm('将重新调用视觉模型逐条检查已有视频，可能消耗API额度。若六条均通过高置信门槛，将按本任务原设定自动采用；否则转人工，不重新生成视频或发布。确认开始吗？'))return;
      if(action==='cancel'&&!confirm('停止后续本地编排？已提交的远端视频可能仍在生成，历史记录会保留。'))return;
      if(action==='retry-asset'){
        if(!confirm('原即梦图片任务长时间没有返回产物。重新准备不会立即扣费，但下一步必须重新确认积分后才会提交新任务。继续吗？'))return;
        body={expectedRevision:Number(card.dataset.revision),assetKey:b.dataset.asset,...(prompt?{prompt}:{})};
      }
      if(['SELECT_CREATIVE','CONFIRM_ASSET','CONFIRM_SCRIPT','CONFIRM_PLAN','CONFIRM_V8_DIRECTOR','CONFIRM_V8_PROMPTS'].includes(action)){
        endpoint='review';
        body={action,expectedRevision:Number(card.dataset.revision),creativeId:b.dataset.creative,assetKey:b.dataset.asset};
        if(b.dataset.v8Artifact){
          if(!card.querySelector('.v8-production-confirm')?.checked){card.querySelector('.action-error').textContent='请先阅读当前镜头、台词、声线与揭晓信息并勾选确认';return;}
          body.confirmV8Review=true;body.artifactHash=b.dataset.v8Artifact;
        }
        if(action==='CONFIRM_SCRIPT' && b.dataset.v8Screenplay){
          if(!card.querySelector('.v8-manual-confirm')?.checked){
            card.querySelector('.action-error').textContent='请先逐场检查完整剧本，并勾选确认';
            return;
          }
          body.confirmV8Screenplay=true;
          body.screenplayHash=b.dataset.v8Screenplay;
        }
      }
      if(action==='asset-paid'){body={scopeHash:b.dataset.scope,confirmPaidAssetGeneration:Boolean(card.querySelector('.confirm-asset-paid')?.checked),acceptedUnknownCostRisk:Boolean(card.querySelector('.asset-unknown-cost')?.checked)};}
      if(action==='paid')body={scopeHash:b.dataset.scope,confirmPaidGeneration:Boolean(card.querySelector('.confirm-paid')?.checked),acceptedUnknownCostRisk:Boolean(card.querySelector('.unknown-cost')?.checked)};
      if(action==='post-production')body={expectedRevision:Number(card.dataset.revision),settings:window.pvsReadPostProduction(card.querySelector('.post-production-settings'))};
      if(action==='adopt-timeline'){
        if(!confirm('采用当前已确认的手工时间线并开始渲染？不会重新生成视频，也不会覆盖手工编辑。'))return;
        try{const response=await fetch('/api/projects/'+encodeURIComponent(project)+'/post-production');const data=await response.json();if(!response.ok||data.timeline?.status!=='CONFIRMED')throw new Error('请先到时间线页面确认当前剪辑版本');body={expectedRevision:Number(card.dataset.revision),timelineId:data.timeline.id,timelineHash:data.timeline.hash};}
        catch(error){card.querySelector('.action-error').textContent=publicCreationError(error);return;}
      }
      b.disabled=true;busy=true;try{await post(base+'/'+encodeURIComponent(card.dataset.run)+'/'+endpoint,body);location.reload();}catch(e){card.querySelector('.action-error').textContent=publicCreationError(e);b.disabled=false;busy=false;}});
    // Read-only status polling; it never grants consent or starts/advances work.
    const versions=new Map([...document.querySelectorAll('.run')].map(c=>[c.dataset.run,Number(c.dataset.revision)]));
    if([...document.querySelectorAll('.run')].some(c=>${JSON.stringify(runnableSmartStatuses)}.includes(c.dataset.status)))setInterval(async()=>{if(busy||document.querySelector('.post-production-settings[data-dirty="1"],.post-production-settings[data-uploading="1"],.asset-prompt-text[data-dirty="1"],.v3-editor[data-dirty="1"],.v8-editor[data-dirty="1"],.v8-production-editor[data-dirty="1"]'))return;try{const r=await fetch(base);const j=await r.json();if(!r.ok)throw new Error(j.message||'状态读取失败');if(j.runs.some(run=>versions.get(run.id)!==run.revision))location.reload();}catch(e){document.querySelector('#poll-state').textContent='状态刷新失败：'+publicCreationError(e);}},4000);
  })();
  </script></body></html>`;
}

export function renderBatchGenerationPanel(projectId: string): string {
  return `<section class="card" id="batch-generation" data-project="${esc(projectId)}"><h3>批量提交本轮镜头</h3><p class="muted">只提交当前计划中已有独立审批的最新待生成记录。本地顺序提交；每个镜头独立记录结果，失败镜头不会自动重提。</p><button class="primary" id="batch-submit" disabled>一键提交全部待生成镜头</button><p id="batch-status" class="muted"></p><div id="batch-results" role="status"></div></section>
  <script>(()=>{const root=document.querySelector('#batch-generation'),button=document.querySelector('#batch-submit'),status=document.querySelector('#batch-status'),results=document.querySelector('#batch-results');let selection=null;const base='/api/projects/'+encodeURIComponent(root.dataset.project)+'/generation-batch';
  fetch(base).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.message||'批量范围读取失败');selection=j.selection;button.disabled=!selection.targets.length;status.textContent='当前可提交 '+selection.targets.length+' 个镜头。';}).catch(e=>{status.textContent=e.message;});
  button.addEventListener('click',async()=>{if(!selection?.targets.length)return;button.disabled=true;status.textContent='正在依次提交已授权镜头，请勿重复点击…';try{const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attemptIds:selection.targets.map(t=>t.attemptId),scopeHash:selection.scopeHash})});const j=await r.json();if(!r.ok)throw new Error(j.message||'批量提交失败');results.replaceChildren();for(const [i,item] of j.result.results.entries()){const p=document.createElement('p');p.textContent='镜头 '+(i+1)+'：'+item.message;results.append(p);}status.textContent='本轮提交已结束。刷新页面可查看生成进度；不会自动重提失败或未知记录。';const link=document.createElement('a');link.href=location.href;link.textContent='刷新生成进度';results.append(link);if(j.result.results.some(item=>item.outcome==='SUBMITTED')){status.textContent+=' 三秒后自动转入现有查询与下载流程。';setTimeout(()=>location.reload(),3000);}}catch(e){status.textContent=e.message+'；请刷新核查实际记录，不会自动重试。';}});
  })();</script>`;
}
