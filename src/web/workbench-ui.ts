import { renderDirectorGenerationControls } from "./director-generation-ui.js";
import { renderBatchGenerationPanel } from "./smart-generation-ui.js";
import type { WorkflowReadModel } from "../application/services/workflow-read-model.js";
import { hasTrustedDouyinPublication } from "../application/services/published-ops-entry.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";
import { douyinResearchPreflightControls, douyinResearchPreflightBrowserScript } from "./douyin-research-preflight-ui.js";
import type {
  ArtifactRecord,
  CommandAttemptRecord,
  CompiledPrompt,
  CreativeBatch,
  GenerationAttempt,
  GenerationRequest,
  PreflightReport,
  Project,
  ReferenceVideoProfile,
  RenderJob,
  ReviewDecision,
  Timeline,
  UserApproval,
  WorkflowBlocker
} from "../domain/schemas.js";
import type { ProjectWorkspace } from "../application/services/product-flow.js";
import type { ProductInputSnapshot } from "../application/ports/product-input-store.js";
import type { ProviderProbeResult } from "../application/ports/video-provider.js";
import type { DouyinPublishProbe } from "../application/ports/douyin-publish-provider.js";
import type { PublishProviderProbe } from "../application/ports/publish-provider.js";
import type { PublicPublishPackage } from "../application/services/publish-bridge-service.js";
import type { FinalQcReport } from "../domain/final-qc.js";
import type {
  PublishPreference,
  PublishReceipt
} from "../domain/publish.js";
import type {
  FinalAssembly,
  PublishAttempt
} from "../application/ports/final-output-repository.js";
import type {
  AiExecutionRecord,
  AiModelConfig,
  AiProviderConfig,
  AiStep,
  AiSystemPreference,
  ProjectAiPreference,
  StepModelOverride
} from "../application/ports/ai-settings-repository.js";
import type { AgentTask } from "../application/ports/agent-task-repository.js";
import type {
  ResearchBrief,
  ResearchEvidence,
  ResearchRun
} from "../application/ports/research-repository.js";
import { renderTimelineEditor } from "./timeline-ui.js";
import { renderPublishCenter } from "./publish-ui.js";
import {
  resolveWorkflowNavigation,
  workflowPageTaskText,
  type WorkflowNavigationState,
  type WorkflowPageKind
} from "../application/services/workflow-navigation.js";

type PageKind =
  | "product"
  | "truth"
  | "creative"
  | "script"
  | "director"
  | "generate"
  | "timeline"
  | "final";
type AiProviderWithModels = AiProviderConfig & { models: AiModelConfig[] };

const pageKindLabel: Record<PageKind, string> = {
  product: "产品输入",
  truth: "产品事实",
  creative: "创意方案",
  script: "脚本",
  director: "导演分镜",
  generate: "视频生成",
  timeline: "视频剪辑",
  final: "成片与发布"
};

const statusLabel: Record<Project["status"], string> = {
  DRAFT: "草稿",
  PRODUCT_TRUTH_REVIEW: "产品事实确认",
  CREATIVE_REVIEW: "创意选择",
  SCRIPT_REVIEW: "脚本确认",
  DIRECTOR_REVIEW: "导演计划确认",
  READY_TO_GENERATE: "待生成",
  GENERATING: "生成中",
  GENERATION_REVIEW: "生成结果确认",
  READY_TO_ASSEMBLE: "待生成成片",
  FINAL_REVIEW: "成片确认",
  READY_TO_PUBLISH: "成片已确认，待选择发布方式",
  PUBLISHING: "发布中",
  PUBLISHED: "已发布",
  COMPLETED: "已完成",
  FAILED: "不可恢复失败"
};

const attemptStatusLabel: Record<GenerationAttempt["status"], string> = {
  CREATED: "待提交",
  SUBMITTING: "正在提交",
  SUBMITTED: "已提交",
  PROCESSING: "生成中",
  SUCCEEDED: "生成完成",
  FAILED: "生成失败",
  SUBMISSION_OUTCOME_UNKNOWN: "提交结果未知",
  RECONCILING: "正在恢复任务",
  RECONCILED_SUCCEEDED: "恢复后生成完成",
  RECONCILED_FAILED: "恢复后生成失败"
};

const preflightStatusLabel: Record<PreflightReport["status"], string> = {
  PASS: "检查通过",
  BLOCKED: "需要处理",
  STALE: "已失效"
};

const publishAttemptStatusLabel: Record<PublishAttempt["status"], string> = {
  CREATED: "已创建",
  AUTH_REQUIRED: "需要授权",
  UPLOADING: "正在上传",
  PUBLISHING: "发布中",
  PUBLISHED: "已发布",
  FAILED: "失败"
};

const renderJobStatusLabel: Record<RenderJob["status"], string> = {
  QUEUED: "等待渲染",
  RENDERING: "渲染中",
  SUCCEEDED: "渲染完成",
  FAILED: "渲染失败"
};

const versionStatusLabel = {
  DRAFT: "待确认",
  CONFIRMED: "已确认",
  STALE: "已失效"
} as const;

const riskLabel = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高"
} as const;

const beatPurposeLabel = {
  HOOK: "开场钩子",
  PAIN: "痛点",
  PRODUCT: "产品出现",
  FEATURE: "功能卖点",
  PROOF: "证据/证明",
  RESULT: "结果",
  CTA: "行动引导",
  OTHER: "其他"
} as const;

const clipStatusLabel = {
  PLANNED: "已规划",
  READY: "待生成",
  GENERATING: "生成中",
  NEEDS_REVIEW: "待审片",
  ACTION_REQUIRED: "需要处理",
  ACCEPTED: "已采用",
  STALE: "已失效"
} as const;

const productVisibilityLabel = {
  NONE: "不展示",
  PARTIAL: "局部展示",
  CLEAR: "清晰展示",
  HERO: "主视觉展示"
} as const;

const claimStatusLabel = {
  UNVERIFIED: "未验证",
  REJECTED: "已拒绝",
  PROMOTED: "已确认事实"
} as const;

const researchModeLabel = {
  OFF: "关闭",
  BASIC: "基础研究",
  DEEP: "深度研究"
} as const;

const researchRunStatusLabel = {
  RUNNING: "进行中",
  READY: "待处理",
  BLOCKED: "等待处理",
  COMPLETED: "已完成",
  FAILED: "失败"
} as const;

const researchBriefStatusLabel = {
  READY: "可用",
  STALE: "已失效"
} as const;

const researchSourceLabel = {
  OFFICIAL: "官方来源",
  USER_URL: "指定网页",
  PUBLIC_PRODUCT: "公开商品页",
  COMPETITOR: "竞品来源",
  INDUSTRY: "行业来源",
  TREND: "趋势来源",
  PLATFORM: "平台来源"
} as const;

const usageRuleCategoryLabel = {
  USAGE_METHOD: "使用方法",
  WEARING_POSITION: "佩戴 / 安装位置",
  PRECAUTION: "注意事项",
  FUNCTION_EFFECT: "功能作用",
  USAGE_SCENARIO: "使用场景",
  PRODUCT_STATE: "产品状态",
  LIMITATION: "使用限制"
} as const;

const usageRulePolarityLabel = {
  MUST: "必须遵守",
  MUST_NOT: "禁止 / 不应",
  CONTEXT: "适用边界"
} as const;

const confidenceLabel = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高"
} as const;

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

function refText(ref?: { version: number; hash: string }): string {
  return ref ? `v${ref.version}` : "尚无版本";
}

function resumePath(project: Project): string {
  if (project.status === "DRAFT") return `/projects/${project.id}/product`;
  if (
    project.status === "FINAL_REVIEW" ||
    project.status === "READY_TO_PUBLISH" ||
    project.status === "PUBLISHING" ||
    project.status === "PUBLISHED" ||
    project.status === "COMPLETED"
  ) {
    return `/projects/${project.id}/final`;
  }
  return `/projects/${project.id}/smart`;
}

function currentActionText(project: Project): string {
  const labels: Record<Project["status"], string> = {
    DRAFT: "填写产品资料并准备产品事实",
    PRODUCT_TRUTH_REVIEW: "进入智能生成并完成产品事实确认",
    CREATIVE_REVIEW: "继续智能生成并选择创意",
    SCRIPT_REVIEW: "继续当前智能生成任务",
    DIRECTOR_REVIEW: "继续当前智能生成任务",
    READY_TO_GENERATE: "继续智能生成并确认本次付费范围",
    GENERATING: "智能生成正在执行视频生成与下载",
    GENERATION_REVIEW: "继续智能生成；需要时进行人工审片",
    READY_TO_ASSEMBLE: "继续智能生成并自动剪辑",
    FINAL_REVIEW: "确认最终成片",
    READY_TO_PUBLISH: "选择发布方式",
    PUBLISHING: "等待发布流程完成",
    PUBLISHED: "发布已完成",
    COMPLETED: "当前项目已完成",
    FAILED: "查看失败原因并处理"
  };
  return labels[project.status];
}

function pageKindForHeader(pageTitle: string): WorkflowPageKind | undefined {
  const byTitle: Record<string, WorkflowPageKind> = {
    "产品输入": "product",
    "联网研究 / 证据": "research",
    "产品事实确认": "truth",
    "创意方案": "creative",
    "脚本确认": "script",
    "导演分镜": "director",
    "视频生成": "generate",
    "视频剪辑": "timeline",
    "成片与发布": "final"
  };
  return byTitle[pageTitle];
}

function currentActionForPage(project: Project, pageTitle: string): string {
  if (pageTitle === "单视频生成") return "填写独立片段要求并检查生成材料";
  if (pageTitle === "项目模型设置") return "查看或配置此项目的模型设置";
  if (pageTitle === "参考视频") return "上传或检查此项目的参考视频";
  const page = pageKindForHeader(pageTitle);
  return page ? workflowPageTaskText(page, project) : currentActionText(project);
}

function staleImpact(project?: Project): string {
  if (!project) return "";
  if (project.status === "DRAFT" || project.status === "PRODUCT_TRUTH_REVIEW") {
    return "修改产品输入或产品事实，会使后续创意、脚本、导演方案、生成提示词与提交记录失效。";
  }
  if (project.status === "CREATIVE_REVIEW") {
    return "更换创意方案或创意选择，会使后续脚本、导演方案、生成提示词与提交记录失效。";
  }
  if (project.status === "SCRIPT_REVIEW") {
    return "修改脚本会使后续导演方案、生成提示词与提交记录失效。";
  }
  if (project.status === "DIRECTOR_REVIEW" || project.status === "READY_TO_GENERATE") {
    return "修改导演方案、镜头或镜头内分段，会使生成提示词、生成请求、生成前检查与确认记录失效。";
  }
  return "修改任何上游当前版本都会使绑定的下游结果失效；历史记录仍会保留为只读。";
}

export function layout(
  title: string,
  body: string,
  project?: Project,
  blockers: WorkflowBlocker[] = [],
  navigation?: WorkflowNavigationState
): string {
  const blockerHtml = blockers.length
    ? `<section class="blocker"><strong>需要你处理</strong><div>${blockers
        .map(
          (item) =>
            `<p>${esc(item.message)}<br><span><b>下一步：</b>${esc(item.requiredUserAction)}</span><br><code class="technical">${esc(item.reasonCode)} · resume=${esc(item.resumeCheckpoint)}</code></p>`
        )
        .join("")}</div></section>`
    : "";
  const navigationState = project
    ? navigation ??
      resolveWorkflowNavigation({
        project,
        currentPage: null,
        blockers
      })
    : undefined;
  const workflowBanner = project && navigationState?.workflow
    ? `<section class="card" id="workflow-read-model" data-workflow-source="${esc(navigationState.workflow.source)}">
         <b>当前制作任务：${esc(navigationState.workflow.stageLabel)}</b> · ${esc(navigationState.workflow.statusLabel)}
         <p>下一步：<a class="primary" href="${esc(navigationState.workflow.action.href)}">${esc(navigationState.workflow.action.label)}</a></p>
         ${navigationState.workflow.publication.projectMarkedPublished && navigationState.workflow.activeTaskCount > 0
           ? '<p class="muted">历史项目状态标记：已发布（不代表当前制作任务已完成；可信发布回执请在成片页核对）。</p>' : ""}
       </section>`
    : "";
  const nav = project && navigationState
    ? (() => {
        const mainHtml = [
          {
            title: "产品资料",
            href: `/projects/${project.id}/product`,
            current: title === "产品输入" || title === "产品事实"
          },
          {
            title: "智能生成",
            href: `/projects/${project.id}/smart`,
            current: title === "智能生成"
          },
          {
            title: "成片 / 发布",
            href: `/projects/${project.id}/final`,
            current: title === "成片与发布"
          }
        ].map((step, index) =>
          `<a class="step ${step.current ? "step-current" : ""}" href="${esc(step.href)}"><span>${index + 1} ${esc(step.title)}</span></a>`
        ).join("");
        const tools = [
          { title: "联网研究", href: `/projects/${project.id}/research` },
          { title: "参考视频", href: `/projects/${project.id}/reference-video` },
          { title: "模型设置", href: `/projects/${project.id}/models` }
        ].map((tool) => `<a class="tool-link ${title === tool.title ? "tool-current" : ""}" href="${tool.href}">${tool.title}</a>`).join("");
        const legacy = navigationState.steps
          .filter(step => ["creative","script","director","generate","timeline"].includes(step.key))
          .map(step => `<a class="tool-link" href="${esc(step.href)}">${esc(step.title)}</a>`)
          .join("");
        return `<section class="workflow-nav">
          <div class="workflow-nav-head"><b>智能生产主链</b><div class="muted"><div>当前位置：${esc(title)} · 本页任务：${esc(navigationState.pageTaskText)}</div><div>当前任务下一步：<a href="${esc(navigationState.globalResumeHref)}">${esc(navigationState.globalResumeText)}</a></div></div></div>
          <nav class="steps main-steps">${mainHtml}</nav>
          <div class="workflow-tools"><span class="muted">辅助工具</span><nav class="tool-steps">${tools}</nav></div>
          <details class="technical"><summary>高级兼容工具</summary><p class="muted">旧创意、脚本、导演、生成和时间线页面仅用于历史任务、诊断和高级微调，不再是正常生产必经步骤。</p><nav class="tool-steps">${legacy}</nav></details>
        </section>`;
      })()
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>${esc(title)} · Product Video Studio</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#171717;background:#f5f5f3}
*{box-sizing:border-box}body{margin:0}a{color:inherit}.top{background:#fff;border-bottom:1px solid #ddd;padding:14px 24px;display:flex;gap:20px;align-items:center}.top b{font-size:17px}.wrap{max-width:1180px;margin:0 auto;padding:24px}.steps{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}.steps a{background:#fff;border:1px solid #ddd;padding:8px 11px;border-radius:8px;text-decoration:none}.head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.status{font-size:13px;background:#eee;padding:5px 8px;border-radius:999px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}.card{background:#fff;border:1px solid #deded8;border-radius:12px;padding:16px;margin:12px 0}.card h3{margin-top:0}.muted{color:#707070;font-size:13px}.blocker{background:#fff3cd;border:1px solid #e7ca66;border-radius:10px;padding:14px;margin:14px 0}.blocker code{font-weight:700}.primary{background:#171717;color:#fff;border:0;border-radius:9px;padding:11px 16px;font-weight:700;cursor:pointer}.primary:disabled{opacity:.35;cursor:not-allowed}.secondary{background:#fff;border:1px solid #bbb;border-radius:9px;padding:9px 13px}.facts{padding-left:18px}.hash{font-family:ui-monospace,Consolas,monospace;font-size:12px}.row{display:flex;gap:12px;flex-wrap:wrap}.field{display:flex;flex-direction:column;gap:5px;min-width:220px;flex:1}input,textarea,select{border:1px solid #bbb;border-radius:8px;padding:10px;font:inherit;background:#fff}textarea{min-height:90px}pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f3;padding:12px;border-radius:8px;overflow:auto}.scene{border-left:3px solid #aaa;padding-left:14px}.clip{background:#fafaf8;border:1px solid #e1e1db;border-radius:8px;padding:12px;margin:8px 0}.claim-card{display:block;background:#fafaf8;border:1px solid #e1e1db;border-radius:10px;padding:13px 14px;margin:10px 0;cursor:pointer}.claim-card:hover{border-color:#c9c9c2;background:#fff}.claim-head{display:flex;align-items:flex-start;gap:11px}.claim-check{appearance:auto;width:17px;height:17px;min-width:17px;margin:3px 0 0;padding:0;cursor:pointer}.claim-check:disabled{cursor:not-allowed}.claim-body{min-width:0;flex:1}.claim-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.claim-title{font-weight:700;line-height:1.55;word-break:break-word}.claim-title-row .status{flex:0 0 auto;white-space:nowrap}.claim-meta{margin:7px 0 0;line-height:1.55}.claim-card .technical{margin:6px 0 0}.segment{font-size:13px;border-top:1px dashed #ccc;padding:8px 0}.danger{color:#8a1f11}.ok{color:#176b2c}.quick{display:flex;gap:6px;flex-wrap:wrap}.quick button{background:#fff;border:1px solid #bbb;border-radius:7px;padding:6px 10px;cursor:pointer}.top .advanced-toggle{margin-left:auto;background:#fff;border:1px solid #bbb;border-radius:7px;padding:6px 10px;cursor:pointer}body:not(.advanced-mode) .technical,body:not(.advanced-mode) .hash{display:none!important}
.workflow-nav{margin:0 0 18px}.workflow-nav-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px}.main-steps{margin-bottom:10px}.main-steps .step{display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #ddd;padding:8px 11px;border-radius:8px;text-decoration:none}.main-steps .step small{font-size:11px;color:#707070}.main-steps .step-current{border-color:#171717;box-shadow:0 0 0 1px #171717 inset}.main-steps .step-current small{color:#171717;font-weight:700}.main-steps .step-done{background:#f3f7f3;border-color:#b9cfbc}.main-steps .step-next{border-style:dashed;border-color:#777}.main-steps .step-next small{font-weight:700}.main-steps .step-optional{background:#fafafa}.workflow-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:8px;border-top:1px solid #ddd}.tool-steps{display:flex;gap:7px;flex-wrap:wrap}.tool-link{background:#fff;border:1px solid #ddd;padding:7px 10px;border-radius:8px;text-decoration:none}.tool-current{border-color:#171717;font-weight:700}.primary{display:inline-block;text-decoration:none}.material-list,.agent-material-list{display:grid;gap:10px;margin:10px 0}.material-card,.agent-material-card{display:grid;grid-template-columns:120px 1fr;gap:12px;border:1px solid #ddd;border-radius:10px;padding:10px;background:#fafaf8}.material-preview,.agent-material-preview{width:120px;height:90px;border-radius:8px;background:#eee;display:flex;align-items:center;justify-content:center;overflow:hidden}.material-preview img,.material-preview video,.agent-material-preview img,.agent-material-preview video{width:100%;height:100%;object-fit:contain;background:#111}.material-preview audio,.agent-material-preview audio{width:110px}.material-actions,.agent-material-actions{display:flex;gap:7px;flex-wrap:wrap}.material-empty,.agent-material-empty{padding:12px;border:1px dashed #bbb;border-radius:10px;color:#707070}.material-status,.agent-material-status{font-size:12px;font-weight:700}.material-logo-box,.agent-logo-box{margin-top:10px}.file-picker-input{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;opacity:0!important}.file-picker-label{display:inline-flex;align-items:center;justify-content:center;width:max-content;cursor:pointer;text-decoration:none}.file-picker-label:focus{outline:2px solid #555;outline-offset:2px}@media(max-width:760px){.workflow-nav-head{align-items:flex-start;flex-direction:column}.main-steps .step{flex:1 1 calc(50% - 8px);justify-content:space-between}.workflow-tools{align-items:flex-start;flex-direction:column}.material-card,.agent-material-card{grid-template-columns:1fr}.material-preview,.agent-material-preview{width:100%;height:180px}}
${pvsGlobalStyles}
</style>
<script>
window.pvsCreateMaterialManager=function(config){
  const items=(config.initialItems||[]).map(item=>({...item,source:'existing',status:item.status||'已上传',error:item.error||'',previewUrl:item.previewUrl||''}));
  let logo=config.initialLogo?({...config.initialLogo,source:'existing',status:config.initialLogo.status||'已上传',error:config.initialLogo.error||'',previewUrl:config.initialLogo.previewUrl||''}):null;
  let replaceIndex=-1;
  const allowed=new Set(config.allowedTypes||['image','video','audio']);
  const input=config.input,replaceInput=config.replaceInput,list=config.list,clearButton=config.clearButton;
  const logoInput=config.logoInput,logoPreview=config.logoPreview,logoReplace=config.logoReplace,logoRemove=config.logoRemove;
  const escValue=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const formatBytes=value=>value>=1024*1024?(value/1024/1024).toFixed(2)+' MB':value>=1024?(value/1024).toFixed(1)+' KB':value+' B';
  const signature=file=>[file.name,file.size,file.type,file.lastModified].join('|');
  const kindFromMime=mime=>mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'other';
  const maxBytes=kind=>kind==='image'?(config.maxImageBytes||10*1024*1024):(config.maxMediaBytes||80*1024*1024);
  function validateFile(file,isLogo){
    const mime=file.type||'';
    const kind=kindFromMime(mime);
    if(isLogo&&kind!=='image')return 'Logo 必须是图片文件';
    if(!isLogo&&!allowed.has(kind))return config.invalidTypeMessage||'文件类型不受支持';
    if(file.size<=0)return '文件为空';
    const max=maxBytes(kind);
    if(file.size>max)return '文件过大：当前限制为 '+Math.round(max/1024/1024)+' MB';
    return '';
  }
  function localEntry(file,isLogo,ignoreIndex){
    const kind=kindFromMime(file.type||'');
    const sig=signature(file);
    const duplicate=!isLogo&&items.some((item,index)=>index!==ignoreIndex&&(
      (item.source==='local'&&item.signature===sig)||
      ((item.name||item.originalFilename)===file.name&&
        Number(item.sizeBytes||0)===file.size&&
        (item.mimeType||'')===(file.type||''))
    ));
    const error=duplicate?'与当前已选素材重复':validateFile(file,isLogo);
    return {source:'local',file,name:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,type:isLogo?'logo':kind,status:duplicate?'重复':error?'不可用':'待上传',error,signature:sig,previewUrl:URL.createObjectURL(file)};
  }
  function previewHtml(entry){
    const src=escValue(entry.previewUrl||'');
    if(entry.type==='image'||entry.type==='logo')return src?'<img src="'+src+'" alt="">':'<span>图片</span>';
    if(entry.type==='video')return src?'<video src="'+src+'" controls muted preload="metadata"></video>':'<span>视频</span>';
    if(entry.type==='audio')return src?'<audio src="'+src+'" controls preload="metadata"></audio>':'<span>音频</span>';
    return '<span>文件</span>';
  }
  function release(entry){if(entry&&entry.source==='local'&&entry.previewUrl)URL.revokeObjectURL(entry.previewUrl);}
  function openPicker(fileInput){
    if(!fileInput)return false;
    fileInput.value='';
    try{
      if(typeof fileInput.showPicker==='function'){
        fileInput.showPicker();
        return true;
      }
    }catch{}
    fileInput.click();
    return true;
  }
  function renderItems(){
    if(clearButton)clearButton.disabled=items.length===0;
    if(!list)return;
    if(!items.length){list.innerHTML='<div class="material-empty">'+escValue(config.emptyText||'尚未选择素材。')+'</div>';return;}
    list.innerHTML=items.map((entry,index)=>'<div class="material-card"><div class="material-preview">'+previewHtml(entry)+'</div><div><b>'+escValue(entry.name||entry.originalFilename||'素材')+'</b><p class="muted">'+escValue(entry.mimeType||'未知类型')+' · '+formatBytes(Number(entry.sizeBytes||0))+'</p><p class="material-status '+(entry.status==='不可用'||entry.status==='重复'?'danger':'')+'">'+escValue(entry.status||'已上传')+'</p>'+(entry.error?'<p class="danger">'+escValue(entry.error)+'</p>':'')+'<div class="material-actions"><button type="button" class="secondary pvs-move-up" data-index="'+index+'" '+(index===0?'disabled':'')+'>上移</button><button type="button" class="secondary pvs-move-down" data-index="'+index+'" '+(index===items.length-1?'disabled':'')+'>下移</button><button type="button" class="secondary pvs-replace" data-index="'+index+'">替换</button><button type="button" class="secondary pvs-remove" data-index="'+index+'">删除</button></div></div></div>').join('');
    list.querySelectorAll('.pvs-remove').forEach(button=>button.addEventListener('click',()=>{const index=Number(button.dataset.index);const removed=items.splice(index,1)[0];release(removed);renderItems();}));
    list.querySelectorAll('.pvs-replace').forEach(button=>button.addEventListener('click',()=>{replaceIndex=Number(button.dataset.index);openPicker(replaceInput);}));
    list.querySelectorAll('.pvs-move-up').forEach(button=>button.addEventListener('click',()=>{const index=Number(button.dataset.index);if(index<=0)return;[items[index-1],items[index]]=[items[index],items[index-1]];renderItems();}));
    list.querySelectorAll('.pvs-move-down').forEach(button=>button.addEventListener('click',()=>{const index=Number(button.dataset.index);if(index<0||index>=items.length-1)return;[items[index],items[index+1]]=[items[index+1],items[index]];renderItems();}));
  }
  function renderLogo(){
    const has=Boolean(logo);
    if(logoReplace)logoReplace.disabled=!has;
    if(logoRemove)logoRemove.disabled=!has;
    if(!logoPreview)return;
    if(!logo){logoPreview.innerHTML='<div class="material-empty">'+escValue(config.logoEmptyText||'尚未选择 Logo。')+'</div>';return;}
    logoPreview.innerHTML='<div class="material-card"><div class="material-preview">'+previewHtml(logo)+'</div><div><b>'+escValue(logo.name||logo.originalFilename||'Logo')+'</b><p class="muted">'+escValue(logo.mimeType||'未知类型')+' · '+formatBytes(Number(logo.sizeBytes||0))+'</p><p class="material-status '+(logo.status==='不可用'?'danger':'')+'">'+escValue(logo.status||'已上传')+'</p>'+(logo.error?'<p class="danger">'+escValue(logo.error)+'</p>':'')+'</div></div>';
  }
  input?.addEventListener('change',()=>{for(const file of [...input.files])items.push(localEntry(file,false,-1));input.value='';renderItems();});
  replaceInput?.addEventListener('change',()=>{const file=replaceInput.files[0];if(!file||replaceIndex<0||replaceIndex>=items.length)return;const old=items[replaceIndex];release(old);items[replaceIndex]=localEntry(file,false,replaceIndex);replaceIndex=-1;replaceInput.value='';renderItems();});
  clearButton?.addEventListener('click',()=>{items.splice(0).forEach(release);renderItems();});
  logoInput?.addEventListener('change',()=>{const file=logoInput.files[0];if(!file)return;release(logo);logo=localEntry(file,true,-1);logoInput.value='';renderLogo();});
  logoReplace?.addEventListener('click',()=>openPicker(logoInput));
  logoRemove?.addEventListener('click',()=>{release(logo);logo=null;renderLogo();});
  renderItems();renderLogo();
  return {
    validate:function(){
      const errors=items.filter(item=>item.status==='不可用'||item.status==='重复').map(item=>(item.name||item.originalFilename||'素材')+'（'+item.status+'）');
      if(logo&&logo.status==='不可用')errors.push((logo.name||logo.originalFilename||'Logo')+'（不可用）');
      return errors;
    },
    getKeepArtifactIds:function(){
      const ids=items.filter(item=>item.source==='existing'&&item.artifactId).map(item=>item.artifactId);
      if(logo&&logo.source==='existing'&&logo.artifactId)ids.push(logo.artifactId);
      return ids;
    },
    getNewFiles:function(){return items.filter(item=>item.source==='local').map(item=>item.file);},
    getNewLogoFile:function(){return logo&&logo.source==='local'?logo.file:null;},
    pickFiles:function(){return openPicker(input);},
    pickLogo:function(){return openPicker(logoInput);},
    getItems:function(){return items.slice();},
    getLogo:function(){return logo;}
  };
};
</script>
</head>
<body>
${renderPvsGlobalHeader(title === "项目" ? "projects" : title === "任务中心" ? "tasks" : title === "系统诊断中心" ? "health" : title === "大模型设置" || title === "项目模型设置" ? "settings" : "studio", { advancedToggle: true, ...(project ? { project: { id: project.id, name: project.name } } : {}) })}
<main class="wrap">
${nav}
${workflowBanner}
${project ? '<section class="card" id="smart-return-card" hidden><b>当前步骤来自智能生成任务</b><p>检查或修改完成后，使用下方入口返回刚才的任务进度，不必重新创建任务。</p><a class="primary" id="smart-return-link" href="#">返回原智能生成任务</a></section>' : ""}
${project ? `<section class="card technical"><b>失效影响</b><p class="muted">${esc(staleImpact(project))}</p><p class="muted">恢复入口：重新打开当前项目会从本地数据库和素材记录恢复。</p></section>` : ""}
${blockerHtml}
${body}
</main>
<script>
(async()=>{
const projectId=${JSON.stringify(project?.id ?? "")};
const runId=new URLSearchParams(location.search).get("fromSmartRun");
if(!projectId||!runId||!/^[A-Za-z0-9_-]{6,128}$/.test(runId))return;
const card=document.querySelector("#smart-return-card"),link=document.querySelector("#smart-return-link");
if(!card||!link)return;
try{
const response=await fetch("/api/projects/"+encodeURIComponent(projectId)+"/smart-runs/"+encodeURIComponent(runId));
if(!response.ok)return;
const result=await response.json();
if(result.run?.id!==runId||result.run?.projectId!==projectId)return;
link.href="/projects/"+encodeURIComponent(projectId)+"/smart?activeRun="+encodeURIComponent(runId)+"#smart-run-"+encodeURIComponent(runId);
card.hidden=false;
}catch{ /* Unavailable history: do not display an unverified return link. */ }
})();
(()=>{const key=\'pvs-advanced-mode\';const button=document.querySelector(\'#advanced-toggle\');const apply=()=>{const on=localStorage.getItem(key)===\'1\';document.body.classList.toggle(\'advanced-mode\',on);if(button)button.textContent=on?\'隐藏高级信息\':\'高级信息\';};apply();button?.addEventListener(\'click\',()=>{localStorage.setItem(key,document.body.classList.contains(\'advanced-mode\')?\'0\':\'1\');apply();});})();
</script>
</body></html>`;
}

export function renderProjectsPage(
  projects: Project[],
  blockerCounts: Map<string, number>,
  workflows: ReadonlyMap<string, WorkflowReadModel> = new Map()
): string {
  const cards = projects.length
    ? projects
        .map(
          (project) => `<article class="card">
            <div class="head"><div><h3>${esc(project.name)}</h3><div class="muted technical">项目 ID：${esc(project.id)}</div></div><span class="status">${esc(statusLabel[project.status])}</span></div>
            <p>当前结果：产品事实 ${esc(refText(project.currentProductTruthRef))} · 脚本 ${esc(refText(project.currentScriptRef))}</p>
            <p class="muted">未解决阻塞：${blockerCounts.get(project.id) ?? 0} · 更新：${esc(project.updatedAt)}</p>
            ${workflows.get(project.id) ? `<p><b>当前工作流：</b>${esc(workflows.get(project.id)!.stageLabel)} · <b>下一步：</b>${esc(workflows.get(project.id)!.action.label)}</p>` : ""}
            ${workflows.get(project.id)?.publication.projectMarkedPublished && workflows.get(project.id)?.activeTaskCount ? '<p class="muted">历史项目状态标记：已发布（回执请在成片页核对）；当前制作任务仍未结束。</p>' : ""}
            <div class="row">
              <a class="primary" href="${esc(workflows.get(project.id)?.source === "SMART_RUN" ? `/projects/${encodeURIComponent(project.id)}/smart?activeRun=${encodeURIComponent(workflows.get(project.id)?.runId ?? "")}#smart-run-${encodeURIComponent(workflows.get(project.id)?.runId ?? "")}` : workflows.get(project.id)?.action.href ?? resumePath(project))}">${workflows.get(project.id)?.taskSelectionRequired ? "选择当前任务" : "继续项目"}</a>
              <button class="secondary delete-project" type="button" data-project-id="${esc(project.id)}" data-project-name="${esc(project.name)}">删除项目</button>
            </div>
            <div class="danger delete-error" role="alert"></div>
          </article>`
        )
        .join("")
    : `<div class="card"><p>还没有项目。</p></div>`;
  return layout(
    "项目",
    `<div class="head"><div><h1>项目</h1><p class="muted">从真实产品资料开始，不生成演示数据。</p></div></div>
     <section class="card">
       <h3>新建项目</h3>
       <form id="create-project"><div class="row">
         <label class="field">项目名称<input name="name" required placeholder="例如：SU-7 产品视频"></label>
         <label class="field">目标时长（秒）
           <input name="durationSeconds" id="duration-seconds" type="number" min="10" max="120" step="1" value="60" required>
           <span class="muted">可输入 10–120 秒整数。</span>
           <span class="quick" id="duration-quick">
             ${[10,15,30,45,60,90,120].map((seconds)=>`<button type="button" data-seconds="${seconds}">${seconds}秒</button>`).join("")}
           </span>
         </label>
       </div><p><button class="primary">开始填写产品资料</button></p></form>
       <div id="create-error" class="danger"></div>
     </section>
     <section class="grid">${cards}</section>
<script>
document.querySelectorAll('#duration-quick button').forEach(button=>button.addEventListener('click',()=>{document.querySelector('#duration-seconds').value=button.dataset.seconds;}));
document.querySelector('#create-project').addEventListener('submit',async(e)=>{
 e.preventDefault(); const f=new FormData(e.currentTarget);
 const targetDurationMs=Number(f.get('durationSeconds'))*1000;
 const r=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.get('name'),targetDurationMs})});
 const j=await r.json(); if(!r.ok){document.querySelector('#create-error').textContent=j.message||j.error;return;}
 location.href='/projects/'+j.project.id+'/product';
});
document.querySelectorAll('.delete-project').forEach(button=>button.addEventListener('click',async()=>{
 const projectId=button.dataset.projectId,projectName=button.dataset.projectName||'';
 const card=button.closest('.card'),error=card.querySelector('.delete-error');
 error.textContent='';
 if(!confirm('确定删除项目“'+projectName+'”？\\n\\n该项目的产品资料、生成记录、素材、剪辑和发布记录都会被删除。此操作不可撤销。'))return;
 const typed=prompt('第二次确认：请输入完整项目名称后才能删除。\\n\\n'+projectName,'');
 if(typed===null)return;
 if(typed!==projectName){error.textContent='项目名称不匹配，未执行删除。';return;}
 button.disabled=true;
 try{
   const r=await fetch('/api/projects/'+encodeURIComponent(projectId),{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmName:typed})});
   const j=await r.json();
   if(!r.ok)throw new Error(j.message||j.error||'删除项目失败');
   location.reload();
 }catch(err){
   error.textContent=err.message||String(err);
   button.disabled=false;
 }
}));
</script>`
  );
}


export function renderResearchPage(input: {
  workspace: ProjectWorkspace;
  productInput?: ProductInputSnapshot | null;
  runs: ResearchRun[];
  latestRun?: ResearchRun;
  evidence: ResearchEvidence[];
  brief?: ResearchBrief;
  navigation?: WorkflowNavigationState;
}): string {
  const { workspace, runs, latestRun, evidence, brief } = input;
  const mode = latestRun?.mode ?? "OFF";
  const sourceText = (
    sourceType: ResearchRun["sourceUrls"][number]["sourceType"]
  ): string =>
    latestRun?.sourceUrls
      .filter((item) => item.sourceType === sourceType)
      .map((item) => item.url)
      .join("\n") ?? "";
  const queryText = latestRun?.queries.join("\n") ?? "";
  const marketVideoResearch = latestRun?.browserState?.marketVideoResearch;
  const hasMarketVideoCandidates =
    marketVideoResearch?.status === "READY" &&
    marketVideoResearch.candidates.length > 0;
  const blockerHtml =
    latestRun?.status === "BLOCKED"
      ? `<section class="blocker">
          <h3>${latestRun.blockerCode==="BRIEF_GENERATION_NOT_AUTHORIZED"?"来源证据已保存，摘要尚未生成":latestRun.mode==="DEEP"?"深度研究需要你处理":"研究任务已暂停"}</h3>
          <p>${esc(latestRun.blockerMessage ?? "浏览器研究暂时阻塞。")}</p>
          <p><b>下一步：</b>${esc(latestRun.requiredUserAction ?? "完成浏览器接管后继续。")}</p>
          ${latestRun.mode==="DEEP"&&latestRun.blockerCode!=="BRIEF_GENERATION_NOT_AUTHORIZED"?`<p><button class="primary" id="research-resume" data-run="${esc(latestRun.id)}">继续深度研究</button></p>`:""}
          <div id="research-resume-error" class="danger"></div>
          <p class="technical">code=${esc(latestRun.blockerCode ?? "UNKNOWN")}${latestRun.browserState ? " · provider="+esc(latestRun.browserState.provider) : ""}</p>
        </section>`
      : latestRun?.status === "FAILED"
        ? hasMarketVideoCandidates
          ? `<section class="card">
              <h3>当前产品公开证据暂未找到</h3>
              <p>产品事实研究本轮没有形成可确认的证据，但抖音竞品 / 爆款视频研究已经独立取得候选，可以继续做视频拆解并作为创意结构参考。</p>
              <p class="muted">竞品视频不会进入当前产品事实，也不会替代产品身份校验。</p>
            </section>`
          : `<section class="blocker">
              <h3>研究失败</h3>
              <p>${esc(latestRun.blockerMessage ?? "没有获取到可用研究证据。")}</p>
              <p><b>下一步：</b>${esc(latestRun.requiredUserAction ?? "检查来源后重新运行。")}</p>
              <p class="technical">code=${esc(latestRun.blockerCode ?? "UNKNOWN")}</p>
            </section>`
      : "";

  const discoveryRounds = latestRun?.browserState?.discoveryRounds ?? [];
  const discoveryCandidates = discoveryRounds.flatMap(
    (round) => round.candidates
  );
  const rejectedDiscoveryCandidates = discoveryCandidates.filter(
    (candidate) =>
      candidate.decision === "REJECT" ||
      candidate.fetchOutcome === "REJECTED"
  );
  const failedDiscoveryCandidates = discoveryCandidates.filter(
    (candidate) => candidate.fetchOutcome === "FAILED"
  );
  const evidenceDiscoveryCandidates = discoveryCandidates.filter(
    (candidate) => candidate.fetchOutcome === "EVIDENCE"
  );
  const marketReferenceCandidates = discoveryCandidates.filter(
    (candidate) => candidate.pool === "MARKET_REFERENCE"
  );
  const discoveryFetchedCount = discoveryRounds.reduce(
    (sum, round) => sum + round.fetchedCount,
    0
  );
  const discoveryQualityHtml = discoveryRounds.length
    ? '<section class="card"><div class="head"><div><h3>搜索质量与淘汰记录</h3>' +
      '<p class="muted">系统会先筛掉明显不相关候选，再抓取正文做第二次产品身份检查；证据不足时最多自动加强搜索一次。</p>' +
      '</div><span class="status">' + discoveryRounds.length + ' 轮</span></div>' +
      '<div class="grid">' +
      '<div class="card"><b>搜索候选</b><p>' + discoveryCandidates.length + '</p></div>' +
      '<div class="card"><b>进入抓取</b><p>' + discoveryFetchedCount + '</p></div>' +
      '<div class="card"><b>形成证据</b><p>' + evidenceDiscoveryCandidates.length + '</p></div>' +
      '<div class="card"><b>市场 / 竞品候选</b><p>' + marketReferenceCandidates.length + '</p></div>' +
      '<div class="card"><b>淘汰 / 失败</b><p>' +
        (rejectedDiscoveryCandidates.length + failedDiscoveryCandidates.length) +
      '</p></div></div>' +
      (marketReferenceCandidates.length
        ? '<h4>市场 / 竞品候选（不会进入当前产品事实）</h4>' +
          marketReferenceCandidates.slice(0, 6).map((candidate) =>
            '<p><b>' + esc(candidate.title || candidate.url) + '</b><br>' +
            '<span class="muted">' +
              esc(candidate.reasons[candidate.reasons.length - 1] ?? "属于同类或市场参考") +
            '</span></p>'
          ).join("")
        : '') +
      (rejectedDiscoveryCandidates.length
        ? '<h4>典型淘汰原因</h4>' +
          rejectedDiscoveryCandidates.slice(0, 8).map((candidate) =>
            '<p><b>' + esc(candidate.title || candidate.url) + '</b><br>' +
            '<span class="muted">' +
              esc(candidate.reasons[candidate.reasons.length - 1] ?? "与当前产品相关性不足") +
            '</span><span class="technical"><br>score=' + candidate.finalScore +
              (candidate.semanticScore !== undefined ? ' · semantic=' + candidate.semanticScore : '') +
              ' · ' + esc(candidate.url) +
            '</span></p>'
          ).join("")
        : '<p class="muted">本轮没有记录到被淘汰的候选。</p>') +
      '<details class="technical"><summary>每轮搜索审计</summary>' +
      discoveryRounds.map((round) =>
        '<p>第 ' + round.round + ' 轮 · 候选 ' + round.candidateCount +
        ' · ACCEPT ' + round.acceptedCount +
        ' · HOLD ' + round.heldCount +
        ' · MARKET ' + (round.marketReferenceCount ?? 0) +
        ' · REJECT ' + round.rejectedCount +
        ' · 抓取 ' + round.fetchedCount +
        '<br>' + esc(round.queries.join(" / ")) + '</p>'
      ).join("") +
      '</details></section>'
    : "";

  const formatMarketMetric = (value?: number): string => {
    if (value === undefined) return "—";
    if (value >= 10000) return (value / 10000).toFixed(1) + "万";
    return String(value);
  };
  const marketVideoLoginRequired =
    marketVideoResearch?.status === "BLOCKED" &&
    marketVideoResearch.blockerCode === "LOGIN_REQUIRED";
  const marketVideoRiskControl =
    marketVideoResearch?.status === "BLOCKED" &&
    marketVideoResearch.blockerCode === "RISK_CONTROL";
  const marketVideoProviderUnavailable =
    marketVideoResearch?.status === "BLOCKED" &&
    marketVideoResearch.blockerCode === "PROVIDER_NOT_AVAILABLE";
  const marketVideoHtml = marketVideoResearch
    ? marketVideoResearch.status === "BLOCKED"
      ? `<section class="card">
          <div class="head"><div><h3>抖音爆款 / 竞品视频</h3><p class="muted">与产品事实研究独立运行，只用于学习结构、节奏、镜头、卖点组织和 CTA，不会写入 Product Truth。</p></div><span class="status">需要处理</span></div>
          <div class="blocker">
            <p><b>${esc(marketVideoResearch.message ?? "抖音视频搜索暂时不可用。")}</b></p>
            <p>下一步：${esc(marketVideoResearch.requiredUserAction ?? "检查抖音搜索运行时后重新运行深度研究。")}</p>
            ${marketVideoProviderUnavailable ? `<p>抖音研究连接尚未确认。请使用上方研究表单中的连接检测或“暂不搜索抖音”选项；这里不再重复显示第二套连接面板。此前研究结果不会删除。</p>` : ""}
            ${marketVideoLoginRequired ? `
              <p>
                <button class="primary" type="button" id="douyin-research-auth-open" data-query="${esc(marketVideoResearch.searchedQueries[0] ?? "护颈枕")}">打开抖音登录 / 搜索页</button>
                <button class="secondary" type="button" id="douyin-research-auth-rerun">我已登录，重新检测</button>
              </p>
              <div id="douyin-research-auth-status" class="muted"></div>
              <div id="douyin-research-auth-error" class="danger"></div>
            ` : ""}
            ${marketVideoRiskControl ? `
              <div class="notice">
                <p><b>当前不是“缺少登录”，而是抖音搜索本身仍被平台限制。</b></p>
                <p>如果打开搜索页后一直只有灰色骨架、没有验证码或滑块，说明平台当前没有提供可人工处理的验证入口；这不是你漏了某一步。</p>
                <p>这种情况下不要反复刷新或重复提交研究。可以稍后再试，或者先继续其他联网研究。</p>
              </div>
              <p>
                <button class="primary" type="button" id="douyin-research-auth-open" data-query="${esc(marketVideoResearch.searchedQueries[0] ?? "护颈枕")}">打开抖音搜索页查看</button>
                <button class="secondary" type="button" id="douyin-research-auth-rerun">重新检测风控状态</button>
              </p>
              <div id="douyin-research-auth-status" class="muted"></div>
              <div id="douyin-research-auth-error" class="danger"></div>
            ` : ""}
          </div>
          <p class="muted">本轮搜索词：${esc(marketVideoResearch.searchedQueries.join(" / ") || "未生成")}</p>
          <p class="technical">provider=${esc(marketVideoResearch.provider)} · code=${esc(marketVideoResearch.blockerCode ?? "UNKNOWN")}</p>
        </section>`
      : `<section class="card">
          <div class="head"><div><h3>抖音爆款 / 竞品视频</h3><p class="muted">这条链与当前产品证据独立：优先发现高点赞同类视频，只有你点击“拆解为创作参考”后才会获取素材并生成 ReferenceVideoProfile。</p></div><span class="status">${marketVideoResearch.candidates.length} 条候选</span></div>
          <p class="muted">搜索词：${esc(marketVideoResearch.searchedQueries.join(" / ") || "未生成")} · ${marketVideoResearch.sort === "MOST_LIKED" ? "高点赞优先" : marketVideoResearch.sort === "LATEST" ? "最新优先" : "综合相关"} · ${marketVideoResearch.timeRange === "DAY" ? "一天内" : marketVideoResearch.timeRange === "WEEK" ? "一周内" : marketVideoResearch.timeRange === "HALF_YEAR" ? "半年内" : "时间不限"}</p>
          ${marketVideoResearch.note ? `<p class="muted">${esc(marketVideoResearch.note)}</p>` : ""}
          ${marketVideoResearch.candidates.length
            ? `<div class="grid">${marketVideoResearch.candidates.map((candidate) => `<article class="card">
                <div class="head"><div><h4>${esc(candidate.title)}</h4><p class="muted">${candidate.authorName ? esc(candidate.authorName) : "作者未提供"}${candidate.publishedAt ? " · " + esc(candidate.publishedAt.slice(0, 10)) : ""}</p></div><span class="status">${candidate.status === "ANALYZED" ? "已拆解" : candidate.status === "FAILED" ? "拆解失败" : "待选择"}</span></div>
                <p><b>点赞 ${formatMarketMetric(candidate.metrics.likes)}</b> · 评论 ${formatMarketMetric(candidate.metrics.comments)} · 分享 ${formatMarketMetric(candidate.metrics.shares)} · 播放 ${formatMarketMetric(candidate.metrics.plays)}</p>
                <p class="muted">命中词：${esc(candidate.query)} · 搜索排名：${candidate.rank}</p>
                ${candidate.analysisError ? `<p class="danger">${esc(candidate.analysisError)}</p>` : ""}
                <p><a class="secondary" href="${esc(candidate.url)}" target="_blank" rel="noopener noreferrer">打开抖音原视频</a>
                ${candidate.status === "ANALYZED"
                  ? ` <a class="secondary" href="/projects/${encodeURIComponent(workspace.project.id)}/reference-video">查看拆解结果 v${candidate.referenceVideoProfileVersion ?? ""}</a>`
                  : ` <button class="primary" type="button" data-market-video-analyze data-run="${esc(latestRun?.id ?? "")}" data-candidate="${esc(candidate.id)}">拆解为创作参考</button>`}</p>
                <div class="danger" data-market-video-error="${esc(candidate.id)}"></div>
                <p class="technical">video=${esc(candidate.videoId)} · provider=${esc(candidate.sourceProvider)}</p>
              </article>`).join("")}</div>`
            : '<p>本轮没有发现可用的抖音竞品视频候选。可以调整品类关键词、时间范围后重新研究。</p>'}
        </section>`
    : mode === "DEEP"
      ? `<section class="card"><h3>抖音爆款 / 竞品视频</h3><p>本轮还没有抖音视频研究结果。</p><p class="muted">该能力与产品事实搜索独立，不会因为当前产品公开证据不足而停止竞品视频研究。</p></section>`
      : "";

  const evidenceHtml = evidence.length
    ? evidence
        .map(
          (item) => `<article class="card">
            <div class="head">
              <div><h3>${esc(item.title)}</h3><p class="muted">${esc(researchSourceLabel[item.sourceType])} · 置信度：${esc(confidenceLabel[item.confidence])} · ${esc(item.fetchedAt)}</p></div>
              <span class="status">研究证据</span>
            </div>
            <p>${esc(item.summary)}</p>
            ${item.sourceCapture&&["go-local-owned-fixture","ego-browser-research"].includes(item.sourceCapture.provider)?`<p><a class="secondary" href="/projects/${encodeURIComponent(workspace.project.id)}/research/runs/${encodeURIComponent(item.runId)}/evidence/${encodeURIComponent(item.id)}">查看已保存正文</a></p><p class="muted">打开时核验文件与正文哈希；查看不会重新采集或生成摘要。</p>`:""}
            ${item.mediaContext ? `<p class="muted"><b>${item.mediaContext.type === "IMAGE" ? "图片视觉证据" : item.mediaContext.type === "AUDIO" ? "视频音频证据" : "视频采样帧证据"}</b> · 分析方式：${item.mediaContext.analysisMethod === "VISION" ? "多模态视觉分析" : item.mediaContext.analysisMethod === "AUDIO_MULTIMODAL" ? "音频多模态分析" : "视频抽帧 + 多模态分析"}${item.mediaContext.timestampsMs?.length ? ` · 时间点：${item.mediaContext.timestampsMs.map((ms)=>`${(ms/1000).toFixed(1)}s`).join(" / ")}` : ""}${item.mediaContext.productIdentityMatch ? `<br>产品身份：${item.mediaContext.productIdentityMatch === "CONFIRMED" ? "已确认" : item.mediaContext.productIdentityMatch === "NOT_PRODUCT" ? "非当前产品" : "未确认"}${item.mediaContext.identityReason ? " · "+esc(item.mediaContext.identityReason) : ""}` : ""}<br>来源页面：${esc(item.mediaContext.parentSourceUrl)}</p>` : ""}
            <p><a class="secondary" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开来源</a></p>
            <p class="technical hash">evidence=${esc(item.id)}<br>contentHash=${esc(item.contentHash)}<br>relatedClaims=${esc(item.relatedClaims.join(","))}</p>
          </article>`
        )
        .join("")
    : '<div class="card"><p>当前还没有研究证据。</p></div>';

  const briefHtml = brief
    ? `<section class="card">
        <div class="head"><div><h3>研究报告</h3><p class="muted">只基于已保存的研究证据生成。</p></div><span class="status">${esc(researchBriefStatusLabel[brief.status])}</span></div>
        <p>${esc(brief.summary)}</p>
        ${brief.status === "READY" ? `<p><a class="primary" href="/projects/${encodeURIComponent(workspace.project.id)}/smart?useResearch=1">导入智能生成</a></p><p class="muted">把本研究报告的内容机会、结构方向和不确定项带入一键成片。研究中的新产品事实或使用规则仍必须先通过产品事实审核。</p>` : ""}
        <h4>有来源的发现</h4>
        ${brief.findings.length ? `<ul>${brief.findings.map((item)=>`<li>${esc(item.statement)} <span class="muted">· 置信度：${esc(confidenceLabel[item.confidence])}</span><span class="technical"> · evidence=${esc(item.evidenceIds.join(","))}</span></li>`).join("")}</ul>` : "<p>无。</p>"}
        <h4>内容机会</h4>
        ${brief.contentOpportunities.length ? `<ul>${brief.contentOpportunities.map((item)=>`<li>${esc(item)}</li>`).join("")}</ul>` : "<p>无。</p>"}
        <h4>不确定项</h4>
        ${brief.uncertainties.length ? `<ul>${brief.uncertainties.map((item)=>`<li>${esc(item)}</li>`).join("")}</ul>` : "<p>无。</p>"}
        <h4>产品事实候选</h4>
        ${(brief.candidateClaims.length || brief.usageRules.length)
          ? `<form id="research-claims-form">
              ${brief.candidateClaims.map((claim)=>`<label class="claim-card">
                <div class="claim-head">
                  <input class="claim-check" type="checkbox" name="claimId" value="${esc(claim.id)}" ${claim.status === "PROPOSED" ? "" : "disabled"}>
                  <div class="claim-body">
                    <div class="claim-title-row">
                      <span class="claim-title">${esc(claim.statement)}</span>
                      <span class="status">${claim.status === "PROPOSED" ? "待决定" : claim.status === "SENT_TO_TRUTH" ? "已送入事实审核" : "已忽略"}</span>
                    </div>
                    <p class="muted claim-meta">置信度：${esc(confidenceLabel[claim.confidence])} · 必须在产品事实审核中再次由你明确确认后，才能成为正式产品事实。</p>
                    <p class="technical">evidence=${esc(claim.evidenceIds.join(","))}</p>
                  </div>
                </div>
              </label>`).join("")}
              ${brief.candidateClaims.length ? "" : "<p>没有候选事实。</p>"}
              <h4>产品使用规则候选</h4>
              <p class="muted">这些规则重点约束使用方法、佩戴位置、注意事项、功能作用和使用场景。送入产品事实后仍需要你明确确认，确认后会成为剧本、分镜和生成前检查的硬约束。</p>
              ${brief.usageRules.length ? brief.usageRules.map((rule)=>`<label class="claim-card">
                <div class="claim-head">
                  <input class="claim-check" type="checkbox" name="usageRuleId" value="${esc(rule.id)}" ${rule.status === "PROPOSED" ? "" : "disabled"}>
                  <div class="claim-body">
                    <div class="claim-title-row">
                      <span class="claim-title">${esc(usageRuleCategoryLabel[rule.category])} · ${esc(rule.statement)}</span>
                      <span class="status">${rule.status === "PROPOSED" ? "待决定" : rule.status === "SENT_TO_TRUTH" ? "已送入事实审核" : "已忽略"}</span>
                    </div>
                    <p class="muted claim-meta">${esc(usageRulePolarityLabel[rule.polarity])} · 置信度：${esc(confidenceLabel[rule.confidence])}</p>
                    <p class="technical">evidence=${esc(rule.evidenceIds.join(","))}</p>
                  </div>
                </div>
              </label>`).join("") : "<p>没有产品使用规则候选。</p>"}
              <input type="hidden" name="briefId" value="${esc(brief.id)}">
              <p><button class="primary" type="submit" ${workspace.productTruth ? "" : "disabled"}>送入产品事实 / 使用规则审核</button></p>
              ${workspace.productTruth ? "" : '<p class="muted">请先完成产品资料并生成产品事实，才能送入事实审核。</p>'}
              <div id="research-claims-error" class="danger"></div>
            </form>`
          : "<p>没有候选事实或产品使用规则。</p>"}
        <p class="technical hash">brief=${esc(brief.id)}<br>contentHash=${esc(brief.contentHash)}${brief.aiExecution ? "<br>provider="+esc(brief.aiExecution.providerId)+" · model="+esc(brief.aiExecution.modelId)+" · config=v"+brief.aiExecution.configVersion : ""}</p>
      </section>`
    : latestRun?.status === "FAILED"
      ? '<section class="card"><p><b>本轮未生成研究报告。</b> 当前轮次没有形成可用产品证据；历史成功报告不会在这里冒充本轮结果。</p></section>'
      : '<section class="card"><p>还没有研究报告。</p></section>';

  const historyHtml = runs.length
    ? `<details class="card technical"><summary>研究任务历史（${runs.length}）</summary>${runs
        .map(
          (run) =>
            `<p>${esc(run.createdAt)} · ${esc(researchModeLabel[run.mode])} · ${esc(researchRunStatusLabel[run.status])} · ${esc(run.goal || "研究关闭")}</p>`
        )
        .join("")}</details>`
    : "";

  return layout(
    "联网研究",
    `${projectHeader(workspace, "联网研究 / 证据")}
    ${input.productInput && !workspace.productTruth ? `<section class="card" id="research-then-truth">
      <h3>完成可选研究后，确认产品事实</h3>
      <p>产品资料已经保存。你可以完成本页研究，也可以直接跳过研究；两条路径最终都需人工确认产品事实。</p>
      <p class="muted">生成事实草稿可能调用已配置的文本 AI 模型；研究中的竞品信息不会直接确认为本产品事实。</p>
      <button type="button" class="primary" id="research-finish-truth">研究完成或跳过：生成待确认产品事实</button>
      <p class="danger" id="research-finish-truth-error" role="alert"></p>
    </section>` : workspace.productTruth?.status === "DRAFT" ? `<section class="card" id="research-then-truth">
      <h3>下一步：${brief?.candidateClaims.some(item=>item.status==="PROPOSED") || brief?.usageRules.some(item=>item.status==="PROPOSED") ? "选择要送入事实审核的研究候选" : "核对产品事实"}</h3>
      <p>研究是可选的。研究中的候选不能自动升级成产品事实；只有你选中的内容才会进入待审核清单，随后仍需要人工逐条确认。</p>
      ${brief?.candidateClaims.some(item=>item.status==="PROPOSED") || brief?.usageRules.some(item=>item.status==="PROPOSED") ? '<a class="secondary" href="#research-claims-form">选择研究候选内容</a> · ' : ""}
      <a href="/projects/${encodeURIComponent(workspace.project.id)}/truth" class="primary">不采用研究候选，直接审核产品事实</a>
    </section>` : ""}
    <section class="card"><h3>创作参考素材池</h3><p>研究图片与视频帧需要单独审核，只有明确确认的参考才能进入创意、导演与视频生成；不会变成新的产品事实。</p><a href="/projects/${encodeURIComponent(workspace.project.id)}/creative-references">预览、筛选并确认创作参考</a></section>
    <section class="card">
      <h3>联网研究</h3>
      <p>默认关闭。基础研究只访问你明确提供的公开网页；深度研究会根据产品信息和研究目标自动搜索公开来源，并在可用时对网页图片、视频采样帧进行多模态分析。网络信息不会直接变成正式产品事实或使用规则。</p>
      <form id="research-form">
        <div class="row">
          <label class="field">研究模式
            <select name="mode">
              <option value="OFF" ${mode==="OFF"?"selected":""}>关闭</option>
              <option value="BASIC" ${mode==="BASIC"?"selected":""}>基础研究</option>
              <option value="DEEP" ${mode==="DEEP"?"selected":""}>深度研究</option>
            </select>
          </label>
          <label class="field">研究目标
            <input name="goal" value="${esc(latestRun?.goal ?? "")}" placeholder="例如：核实公开卖点、竞品表达和内容结构">
          </label>
        </div>
        <div class="grid">
          <label class="field">官方 / 品牌公开页面（每行一个网址）
            <textarea name="officialUrls" placeholder="https://brand.example.com/product">${esc(sourceText("OFFICIAL"))}</textarea>
          </label>
          <label class="field">公开商品页（每行一个网址）
            <textarea name="productUrls" placeholder="https://shop.example.com/item">${esc(sourceText("PUBLIC_PRODUCT"))}</textarea>
          </label>
          <label class="field">竞品 / 行业页面（每行一个网址）
            <textarea name="competitorUrls" placeholder="https://competitor.example.com/...">${esc(sourceText("COMPETITOR"))}</textarea>
          </label>
          <label class="field">其他指定公开网页（每行一个网址）
            <textarea name="userUrls">${esc(sourceText("USER_URL"))}</textarea>
          </label>
        </div>
        <label class="field">深度研究关键词（每行一个）
          <textarea name="queries" placeholder="只在深度模式使用；例如：Tonemay Q8 耳夹式蓝牙耳机">${esc(queryText)}</textarea>
          <span class="muted">需要登录、验证码或平台风控时，系统会明确暂停并要求人工接管，不会假装仍在处理中。</span>
        </label>
        <section class="card">
          <h4>抖音爆款 / 竞品视频研究</h4>
          <p class="muted">深度研究时独立搜索同类公开视频。默认高点赞优先；这条链只用于创作结构参考，不会把竞品卖点写入当前产品事实。</p>
          <div class="row">
            <label class="field"><span><input type="checkbox" name="marketVideoEnabled" checked> 同时搜索抖音竞品视频</span></label>
            <label class="field">排序
              <select name="marketVideoSort">
                <option value="MOST_LIKED" ${marketVideoResearch?.sort==="MOST_LIKED" || !marketVideoResearch ? "selected" : ""}>高点赞优先</option>
                <option value="LATEST" ${marketVideoResearch?.sort==="LATEST" ? "selected" : ""}>最新发布</option>
                <option value="RELEVANCE" ${marketVideoResearch?.sort==="RELEVANCE" ? "selected" : ""}>综合相关</option>
              </select>
            </label>
            <label class="field">发布时间
              <select name="marketVideoTimeRange">
                <option value="ANY" ${marketVideoResearch?.timeRange==="ANY" || !marketVideoResearch ? "selected" : ""}>不限</option>
                <option value="DAY" ${marketVideoResearch?.timeRange==="DAY" ? "selected" : ""}>一天内</option>
                <option value="WEEK" ${marketVideoResearch?.timeRange==="WEEK" ? "selected" : ""}>一周内</option>
                <option value="HALF_YEAR" ${marketVideoResearch?.timeRange==="HALF_YEAR" ? "selected" : ""}>半年内</option>
              </select>
            </label>
          </div>
        </section>
        ${douyinResearchPreflightControls}
        <p><button class="primary" type="submit">开始研究</button></p>
        <div id="research-progress" class="muted"></div>
        <div id="research-error" class="danger"></div>
      </form>
    </section>
    ${blockerHtml}
    ${discoveryQualityHtml}
    ${marketVideoHtml}
    <section><h2>研究证据</h2><div class="grid">${evidenceHtml}</div></section>
    ${briefHtml}
    ${historyHtml}
<script>
${douyinResearchPreflightBrowserScript}
document.querySelector('#research-finish-truth')?.addEventListener('click',async event=>{
  const button=event.currentTarget;
  const error=document.querySelector('#research-finish-truth-error');
  if(!confirm('准备生成产品事实草稿并进入人工审核吗？这可能使用已配置的文本模型，但不会直接确认任何事实或触发付费视频生成。'))return;
  button.disabled=true;error.textContent='';button.textContent='正在准备待审核事实…';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/truth/generate-from-input',{method:'POST'});
    const j=await r.json();
    if(!r.ok)throw new Error(j.message||j.error||'产品事实草稿未生成');
    const candidates=document.querySelector('#research-claims-form input[name="claimId"], #research-claims-form input[name="usageRuleId"]');
    location.href=candidates
      ? '/projects/${workspace.project.id}/research?afterTruth=1#research-claims-form'
      : '/projects/${workspace.project.id}/truth';
  }catch(cause){error.textContent=cause.message||String(cause);button.disabled=false;button.textContent='研究完成或跳过：生成待确认产品事实';}
});
const researchLines=(value)=>String(value||'').split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);
const researchPost=async(url,body)=>{
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok)throw new Error(j.message||j.error||'研究操作失败'); return j;
};
const researchPayload=(form)=>{
  const f=new FormData(form);
  const sources=[];
  for(const url of researchLines(f.get('officialUrls')))sources.push({url,sourceType:'OFFICIAL'});
  for(const url of researchLines(f.get('productUrls')))sources.push({url,sourceType:'PUBLIC_PRODUCT'});
  for(const url of researchLines(f.get('competitorUrls')))sources.push({url,sourceType:'COMPETITOR'});
  for(const url of researchLines(f.get('userUrls')))sources.push({url,sourceType:'USER_URL'});
  return {
    mode:f.get('mode'),goal:f.get('goal'),sourceUrls:sources,queries:researchLines(f.get('queries')),
    marketVideo:{
      enabled:f.get('marketVideoEnabled')==='on',
      sort:f.get('marketVideoSort'),
      timeRange:f.get('marketVideoTimeRange'),
      count:12
    }
  };
};
const runResearch=async(form,progress,error,buttons=[],progressText='正在获取来源并生成研究结果…')=>{
  buttons.forEach(button=>{if(button)button.disabled=true;});
  if(error)error.textContent='';
  if(progress)progress.textContent=progressText;
  try{
    await researchPost('/api/projects/${workspace.project.id}/research/run',researchPayload(form));
    if(progress)progress.textContent='研究完成，正在刷新结果…';
    location.reload();
  }catch(err){
    if(error)error.textContent=err.message||String(err);
    if(progress)progress.textContent='';
    buttons.forEach(button=>{if(button)button.disabled=false;});
  }
};
document.querySelector('#research-form')?.addEventListener('submit',async(e)=>{
  e.preventDefault();
  const form=e.currentTarget;
  const progress=document.querySelector('#research-progress'),error=document.querySelector('#research-error');
  const submit=form.querySelector('button[type="submit"]');
  await runResearch(form,progress,error,[submit],'正在获取来源并生成研究结果，请勿重复点击…');
});
document.querySelector('#research-resume')?.addEventListener('click',async(e)=>{
  const button=e.currentTarget,error=document.querySelector('#research-resume-error');button.disabled=true;
  try{await researchPost('/api/projects/${workspace.project.id}/research/runs/'+encodeURIComponent(button.dataset.run)+'/resume',{});location.reload();}
  catch(err){error.textContent=err.message||String(err);button.disabled=false;}
});
document.querySelector('#douyin-research-auth-open')?.addEventListener('click',async(e)=>{
  const button=e.currentTarget;
  const status=document.querySelector('#douyin-research-auth-status');
  const error=document.querySelector('#douyin-research-auth-error');
  button.disabled=true;error.textContent='';status.textContent='正在打开 PVS 抖音研究独立浏览器…';
  try{
    const result=await researchPost('/api/projects/${workspace.project.id}/research/douyin-auth/launch',{query:button.dataset.query||'护颈枕'});
    status.textContent=result.message||'验证窗口已打开。请完成验证后回到本页。';
  }catch(err){
    error.textContent=err.message||String(err);
    status.textContent='';
    button.disabled=false;
  }
});
document.querySelector('#douyin-research-auth-rerun')?.addEventListener('click',async(e)=>{
  const form=document.querySelector('#research-form');
  if(!form)return;
  const rerun=e.currentTarget;
  const open=document.querySelector('#douyin-research-auth-open');
  const status=document.querySelector('#douyin-research-auth-status');
  const error=document.querySelector('#douyin-research-auth-error');
  const oldText=rerun.textContent;
  const checkingRisk=oldText?.includes('检测')||oldText?.includes('风控');
  rerun.textContent=checkingRisk?'正在检测风控…':'正在重新研究…';
  rerun.disabled=true;if(open)open.disabled=true;
  error.textContent='';status.textContent=checkingRisk?'正在同步当前抖音搜索会话并检测风控状态…':'正在同步你刚刚完成的普通抖音登录会话…';
  try{
    const synced=await researchPost('/api/projects/${workspace.project.id}/research/douyin-auth/sync',{query:open?.dataset.query||'护颈枕'});
    status.textContent=synced.message||'抖音搜索限制已解除，正在重新研究…';
    await runResearch(form,status,error,[rerun,open],'抖音搜索限制已解除，正在重新研究，请勿重复点击…');
  }catch(err){
    error.textContent=err.message||String(err);
    status.textContent='';
    rerun.disabled=false;if(open)open.disabled=false;
  }
  if(document.body.contains(rerun))rerun.textContent=oldText;
});
document.querySelectorAll('[data-market-video-analyze]').forEach(button=>button.addEventListener('click',async()=>{
  const run=button.dataset.run,candidate=button.dataset.candidate;
  const error=document.querySelector('[data-market-video-error="'+CSS.escape(candidate||'')+'"]');
  button.disabled=true;if(error)error.textContent='';button.textContent='正在获取并拆解…';
  try{
    await researchPost('/api/projects/${workspace.project.id}/research/runs/'+encodeURIComponent(run)+'/market-videos/'+encodeURIComponent(candidate)+'/analyze',{});
    location.reload();
  }catch(err){
    if(error)error.textContent=err.message||String(err);
    button.disabled=false;button.textContent='重新拆解';
  }
}));
document.querySelector('#research-claims-form')?.addEventListener('submit',async(e)=>{
  e.preventDefault(); const f=new FormData(e.currentTarget),error=document.querySelector('#research-claims-error');
  const claimIds=f.getAll('claimId').map(String);
  const usageRuleIds=f.getAll('usageRuleId').map(String);
  if(!claimIds.length&&!usageRuleIds.length){error.textContent='至少选择 1 条研究候选事实或产品使用规则。';return;}
  try{
    await researchPost('/api/projects/${workspace.project.id}/research/claims/send-to-truth',{briefId:f.get('briefId'),claimIds,usageRuleIds});
    location.href='/projects/${workspace.project.id}/truth';
  }catch(err){error.textContent=err.message||String(err);}
});
</script>`,
    workspace.project,
    [],
    input.navigation ??
      resolveWorkflowNavigation({
        project: workspace.project,
        currentPage: "research"
      })
  );
}


export function renderReferenceVideoPage(input: {
  workspace: ProjectWorkspace;
  navigation?: WorkflowNavigationState;
  profile?: ReferenceVideoProfile | null;
  history: ReferenceVideoProfile[];
  previewArtifactId?: string;
}): string {
  const { workspace, profile, history, previewArtifactId } = input;
  const profileHtml =
    profile && profile.status === "ACTIVE"
      ? `<section class="card">
          <div class="head">
            <div>
              <h3>当前参考视频分析 · v${profile.version}</h3>
              <p class="muted">${esc(profile.originalFilename ?? "参考视频")} · ${(profile.media.durationMs / 1000).toFixed(1)}s${profile.media.width && profile.media.height ? " · " + profile.media.width + "×" + profile.media.height : ""} · 置信度 ${esc(profile.analysisConfidence)}</p>
            </div>
            <span class="status">已启用</span>
          </div>
          <video controls preload="metadata" style="width:100%;max-height:520px;background:#000" src="/api/artifacts/${esc(previewArtifactId ?? profile.videoArtifactId)}/content"></video>
          ${previewArtifactId ? '<p class="muted">网页播放使用 H.264 兼容预览；原始视频仍用于抽帧、分析与证据哈希。</p>' : ""}
          <div class="grid">
            <div class="card"><h4>前 3 秒钩子</h4><p>${esc(profile.hook.firstThreeSecondsPattern)}</p><p class="muted">${esc(profile.hook.structuralPurpose)}</p></div>
            <div class="card"><h4>节奏</h4><p>${esc(profile.pacing.overall)}</p><p class="muted">估计 ${profile.pacing.estimatedShotCount} 个镜头 · 平均 ${(profile.pacing.averageShotDurationMs/1000).toFixed(1)}s/镜头</p></div>
            <div class="card"><h4>产品露出</h4><p>${esc(profile.productAppearance.visibilityPattern)}</p><p class="muted">${esc(profile.productAppearance.showcasePattern)}</p></div>
            <div class="card"><h4>行动引导</h4><p>${esc(profile.ctaPattern)}</p></div>
          </div>
          <section class="card"><h4>镜头语言</h4>
            <p><b>景别：</b>${esc(profile.shotLanguage.shotSizes.join("、") || "未可靠识别")}</p>
            <p><b>机位：</b>${esc(profile.shotLanguage.cameraPositions.join("、") || "未可靠识别")}</p>
            <p><b>运镜：</b>${esc(profile.shotLanguage.cameraMovements.join("、") || "未可靠识别")}</p>
            <p><b>构图：</b>${esc(profile.shotLanguage.compositionPatterns.join("、") || "未可靠识别")}</p>
          </section>
          <section class="card"><h4>可复用结构</h4>
            <p><b>卖点植入：</b>${esc(profile.sellingPointPattern.join("；") || "未可靠识别")}</p>
            <p><b>旁白 / 对话：</b>${esc(profile.dialogueNarrationStructure)}</p>
            <p><b>背景音乐 / 环境声：</b>${esc(profile.audioBgMusicStructure)}</p>
            <p><b>可复用方法：</b>${esc(profile.reusableStylePrinciples.join("；"))}</p>
          </section>
          <section class="card" aria-label="实际观察范围"><h4>实际观察范围</h4>
            ${profile.observation?`<p>已保存 ${profile.observation.frames.length} 张真实采样帧；${profile.observation.audio.status==="NO_TRACK"?"源文件没有音轨":"音频未分析，不能据此判断对白或音乐"}。</p>
            <p>${esc(profile.observation.ocr.status==="SAMPLED_FRAMES_ONLY"?"字幕/文字识别仅覆盖所采帧，不是完整字幕转写。":"本次没有可靠的字幕/文字识别结果。")}</p>
            <p>${profile.observation.timing?.status==="DECODED_FRAME_PTS"?"时间来自实际解码帧，相对首个视频帧，按毫秒取整；不代表字幕的完整起止区间。":"历史采样时间为估算，尚未验证实际帧时间对齐。"}</p>
            ${profile.observation.frameObservations.length?`<table><thead><tr><th>采样时间</th><th>画面观察</th><th>帧内文字</th></tr></thead><tbody>${profile.observation.frameObservations.map(item=>`<tr><td>${item.frameArtifactId?`<a href="/api/artifacts/${encodeURIComponent(item.frameArtifactId)}/content" target="_blank" rel="noopener">${(item.timestampMs/1000).toFixed(3)}秒</a>`:esc((item.timestampMs/1000).toFixed(3)+"秒（历史估算）")}</td><td>${esc(item.observation)}</td><td>${esc(item.visibleText||"未返回可读文字")}${item.visibleText?(item.textStatus==="READABLE"?"（采样帧可读）":"（识别不确定）"):""}</td></tr>`).join("")}</tbody></table>`:"<p>本次没有返回逐帧画面识别，不能视为全部采样帧均已识别。</p>"}
            <p class="muted">${profile.observation.limitations.map(esc).join(" ")}</p>
            <details><summary>查看采样时间和原帧</summary><p>${profile.observation.frames.map(frame=>`<a target="_blank" rel="noopener" href="/api/artifacts/${encodeURIComponent(frame.artifactId)}/content">${(frame.timestampMs/1000).toFixed(2)}秒</a>`).join(" · ")}</p></details>`:
            '<p>历史分析未记录逐帧证据和音频观察范围；音轨存在不代表已经听取或验证对白。</p>'}
          </section>
          <p class="muted"><b>使用原则：</b>只学习结构、节奏和制作方法，不复制原视频台词、字幕、具体镜头内容、人物身份或品牌表达。</p>
          <p><button class="secondary" id="deactivate-reference-video" type="button">停用这份分析参考</button></p>
          <p class="technical hash">profile=${esc(profile.id)}<br>videoSha256=${esc(profile.videoArtifactHash)}<br>contentHash=${esc(profile.contentHash)}${profile.aiExecution ? "<br>provider="+esc(profile.aiExecution.providerId)+" · model="+esc(profile.aiExecution.modelId)+" · config=v"+profile.aiExecution.configVersion : ""}</p>
        </section>`
      : '<section class="card"><p>还没有启用的参考视频分析。</p></section>';

  const historyHtml = history.length > 1
    ? `<details class="card technical"><summary>历史参考视频分析（${history.length}）</summary>${history.map((item)=>`<p>v${item.version} · ${esc(item.status)} · ${esc(item.originalFilename ?? item.videoArtifactId)} · ${esc(item.createdAt)}</p>`).join("")}</details>`
    : "";

  return layout(
    "参考视频",
    `${projectHeader(workspace, "参考视频")}
    <section class="grid">
      <div class="card">
        <h3>分析参考</h3>
        <p>上传 MP4 / MOV 后，系统会抽取采样帧和媒体元数据，生成结构化参考视频分析结果，并作为后续创意、脚本、导演分镜的可选参考。</p>
        <form id="reference-video-form">
          <label class="field">参考视频<input name="video" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" required></label>
          <p><button class="primary" type="submit">上传并分析参考视频</button></p>
          <div id="reference-video-progress" class="muted"></div>
          <div id="reference-video-error" class="danger"></div>
        </form>
        <p class="muted">分析模型可在 <a href="/projects/${workspace.project.id}/models">模型设置 → 参考视频分析</a> 中单独指定。</p>
      </div>
      <div class="card">
        <h3>导入智能生成</h3>
        <p>参考视频分析用于学习钩子、节奏、镜头语言、产品露出方式、旁白 / 对话结构和可复用制作方法。</p>
        ${profile?.status === "ACTIVE"
          ? `<p><a class="primary" href="/projects/${workspace.project.id}/smart?useReference=1">把当前参考视频分析导入智能生成</a></p><p class="muted">当前启用的参考视频分析会进入本轮创意、脚本和导演分镜；不会复制原视频的具体台词、镜头内容、人物身份或品牌表达。</p>`
          : '<p class="muted">先上传并启用一份参考视频分析，之后即可导入智能生成。</p>'}
      </div>
    </section>
    ${profileHtml}
    ${historyHtml}
<script>
function referenceVideoPayload(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('读取参考视频失败'));
    reader.onload=()=>resolve({name:file.name,mimeType:file.type||(/\.mov$/i.test(file.name)?'video/quicktime':'video/mp4'),base64:String(reader.result||'')});
    reader.readAsDataURL(file);
  });
}
document.querySelector('#reference-video-form')?.addEventListener('submit',async(e)=>{
  e.preventDefault();
  const form=e.currentTarget,file=form.elements.video.files[0];
  const progress=document.querySelector('#reference-video-progress');
  const error=document.querySelector('#reference-video-error');
  const button=form.querySelector('button[type="submit"]');
  error.textContent='';
  button.disabled=true;
  progress.textContent='正在上传、抽帧并分析参考视频…';
  try{
    const payload=await referenceVideoPayload(file);
    const r=await fetch('/api/projects/${workspace.project.id}/reference-video/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({video:payload})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.message||j.error||'参考视频分析失败');
    location.reload();
  }catch(err){
    error.textContent=err.message||String(err);
    progress.textContent='';
    button.disabled=false;
  }
});
document.querySelector('#deactivate-reference-video')?.addEventListener('click',async()=>{
  const button=document.querySelector('#deactivate-reference-video');
  button.disabled=true;
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/reference-video/deactivate',{method:'POST'});
    const j=await r.json();
    if(!r.ok)throw new Error(j.message||j.error||'停用失败');
    location.reload();
  }catch(err){
    alert(err.message||String(err));
    button.disabled=false;
  }
});
</script>`,
    workspace.project,
    [],
    input.navigation
  );
}

const agentTaskStatusLabel: Record<AgentTask["status"], string> = {
  DRAFT: "待规划",
  NEEDS_MATERIAL: "需要补充/处理",
  READY_TO_CONFIRM: "等待生成确认",
  APPROVED: "已确认",
  SUBMITTED: "已提交",
  PROCESSING: "生成中",
  REVIEW_READY: "待审片",
  RECONCILE_REQUIRED: "需要恢复提交状态",
  ACCEPTED: "已采用",
  FAILED: "任务失败"
};

export function renderAgentHome(projects: Project[]): string {
  const cards = projects.length
    ? projects
        .map(
          (project) => `<article class="card">
            <div class="head"><div><h3>${esc(project.name)}</h3><p class="muted">目标 ${project.targetDurationMs / 1000} 秒</p></div><span class="status">${esc(statusLabel[project.status])}</span></div>
            <p>按项目目标 ${project.targetDurationMs / 1000} 秒自动生成创意、脚本和导演分镜，再按 Seedance 单镜头能力自动拆分，批量生成并进入自动剪辑。</p>
            <a class="primary" href="/projects/${project.id}/smart">进入智能生成</a>
          </article>`
        )
        .join("")
    : '<section class="card"><p>还没有项目。先创建一个项目作为智能生成任务容器。</p><a class="primary" href="/projects">新建项目</a></section>';
  return layout(
    "智能生成",
    `<div class="head"><div><h1>智能生成</h1><p class="muted">这里的时长是最终成片总时长。系统先写完整脚本，再依据 Dreamina / Seedance 当前单镜头时长限制自动拆分，不会把整段总时长直接提交给单次视频生成。</p></div></div><section class="grid">${cards}</section>`
  );
}

export function renderAgentProjectPage(input: {
  workspace: ProjectWorkspace;
  navigation?: WorkflowNavigationState;
  tasks: AgentTask[];
  artifacts?: ArtifactRecord[];
  prefillReference?: {
    artifactId: string;
    originalFilename: string;
    mimeType: string;
  };
}): string {
  const { workspace, tasks, prefillReference } = input;
  const artifactById = new Map(
    (input.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const)
  );
  const taskCards = tasks.length
    ? tasks.map((task) => {
        const plan = task.plan;
        const generationProfile = plan?.generationProfile;
        const missing = plan?.missingRequirements ?? [];
        const polling =
          task.status === "SUBMITTED" || task.status === "PROCESSING";
        const materialEditable =
          task.status === "DRAFT" ||
          task.status === "NEEDS_MATERIAL" ||
          task.status === "READY_TO_CONFIRM";
        const taskLogo = task.materials.find((item) => item.type === "logo");
        const taskMaterialState = {
          items: task.materials
            .filter((item) => item.type !== "logo")
            .map((item) => {
              const artifact = artifactById.get(item.artifactId);
              const ready =
                artifact?.integrityStatus === "READY" &&
                artifact.sha256 === item.sha256;
              return {
                artifactId: item.artifactId,
                type: item.type,
                name: item.originalFilename,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes,
                sha256: item.sha256,
                status: ready ? "已上传" : "不可用",
                ...(ready
                  ? {
                      previewUrl: `/api/artifacts/${encodeURIComponent(item.artifactId)}/content`
                    }
                  : {
                      error:
                        "历史素材文件已缺失或完整性异常，请删除或替换后再保存"
                    })
              };
            }),
          ...(taskLogo
            ? {
                logo: {
                  artifactId: taskLogo.artifactId,
                  type: "logo",
                  name: taskLogo.originalFilename,
                  mimeType: taskLogo.mimeType,
                  sizeBytes: taskLogo.sizeBytes,
                  sha256: taskLogo.sha256,
                  ...(() => {
                    const artifact = artifactById.get(taskLogo.artifactId);
                    const ready =
                      artifact?.integrityStatus === "READY" &&
                      artifact.sha256 === taskLogo.sha256;
                    return ready
                      ? {
                          status: "已上传",
                          previewUrl: `/api/artifacts/${encodeURIComponent(taskLogo.artifactId)}/content`
                        }
                      : {
                          status: "不可用",
                          error:
                            "历史 Logo 文件已缺失或完整性异常，请删除或替换后再保存"
                        };
                  })()
                }
              }
            : {})
        };
        const materialEditor = materialEditable
          ? `<details class="card agent-existing-material-editor" data-task-id="${esc(task.id)}" data-state="${esc(JSON.stringify(taskMaterialState))}">
              <summary><b>编辑本任务素材</b></summary>
              <p class="muted">仅在付费确认/提交前允许修改。保存后会重新检查能力、重建 GenerationRequest/requestHash，并自动让旧生成确认失效；历史 Artifact 保留审计。</p>
              <label class="field">追加参考素材
                <input class="agent-task-material-input" type="file" accept="image/*,video/*,audio/*" multiple>
              </label>
              <input class="agent-task-material-replace-input" type="file" accept="image/*,video/*,audio/*" hidden>
              <div class="agent-task-material-list material-list"></div>
              <p><button type="button" class="secondary agent-task-material-clear">清空普通参考素材</button></p>
              <h4>Logo（独立管理）</h4>
              <label class="field">选择 / 替换 Logo
                <input class="agent-task-logo-input" type="file" accept="image/*">
              </label>
              <div class="agent-task-logo-preview material-logo-box"></div>
              <p><button type="button" class="secondary agent-task-logo-replace">替换 Logo</button> <button type="button" class="secondary agent-task-logo-remove">删除 Logo</button></p>
              <p><button type="button" class="primary agent-task-material-save">保存素材并重新检查</button></p>
              <div class="agent-task-material-message muted"></div>
            </details>`
          : "";
        const adaptationHtml = plan?.referenceAdaptations?.length
          ? `<div class="card"><h4>长参考视频已自动适配</h4>
              <p class="muted">原视频没有修改。系统按当前 Dreamina 模型的输入时长/数量限制生成关键帧，仅作为外观、场景和构图参考；动作连续性与原视频声音不会被伪装成已保留。</p>
              ${plan.referenceAdaptations.map((adaptation) => `<div class="clip">
                <b>${esc(adaptation.sourceFilename)}</b>
                <p>${(adaptation.sourceDurationMs / 1000).toFixed(1)} 秒 → ${adaptation.derived.length} 张关键帧${adaptation.inputMediaMaxSeconds ? ` · 当前模型媒体时长上限 ${adaptation.inputMediaMaxSeconds} 秒` : ""}</p>
                <div class="material-list">${adaptation.derived.map((frame) => `<div class="material-card">
                  <div class="material-preview"><img src="/api/artifacts/${esc(frame.artifactId)}/content" alt="参考关键帧 ${frame.frameIndex + 1}"></div>
                  <div><b>关键帧 ${frame.frameIndex + 1}</b><p class="muted">原视频定位目标 ${(frame.timestampMs / 1000).toFixed(2)} 秒</p></div>
                </div>`).join("")}</div>
              </div>`).join("")}
              ${plan.effectiveMaterialSummary ? `<p class="muted">适配后实际提交素材：图片 ${plan.effectiveMaterialSummary.images} · 品牌标志 ${plan.effectiveMaterialSummary.logos} · 视频 ${plan.effectiveMaterialSummary.videos} · 音频 ${plan.effectiveMaterialSummary.audios}</p>` : ""}
            </div>`
          : "";
        const confirm =
          task.status === "READY_TO_CONFIRM" && plan
            ? `<div class="card">
                <h4>付费生成前确认</h4>
                <p>生成方式：<b>${esc(plan.operationLabel)}</b> · 计划模型：<b>${esc(plan.model)}</b></p>
                <p>用户选择模型：<b>${esc(task.model)}</b> · CLI model_version / 固定模型：<b>${esc(generationProfile?.modelVersion ?? generationProfile?.fixedModelLabel ?? "未解析")}</b></p>
                <p>时长：${plan.durationMs / 1000}s · 画幅：${esc(plan.aspectRatio)} · 分辨率：${esc(plan.videoResolution)}</p>
                <p>声音：参考音频输入 ${generationProfile?.referenceAudioInputCount ?? 0} 个 · 模型原生输出声音：${generationProfile?.nativeAudioOutputRequested ? "已请求" : "未请求"}${generationProfile ? ` · 当前命令支持：${generationProfile.nativeAudioOutputSupported ? "是" : "否"}` : ""}</p>
                <p>素材：图片 ${plan.materialSummary.images} · 品牌标志 ${plan.materialSummary.logos} · 视频 ${plan.materialSummary.videos} · 音频 ${plan.materialSummary.audios}</p>
                <p>${plan.availableCredits !== undefined ? `当前即梦余额：<b>${plan.availableCredits}</b> 积分 · ` : ""}成本：${plan.costEstimateStatus === "KNOWN"
                  ? esc(plan.estimatedCostText ?? String(plan.estimatedCredits ?? "已获取"))
                  : "暂时无法从命令行获取准确扣费估算"}</p>
                ${plan.costEstimateStatus === "UNKNOWN"
                  ? '<label><input type="checkbox" class="agent-unknown-cost"> 我理解本次会消耗即梦积分，即使当前无法显示准确扣费数</label>'
                  : ""}
                <p><button class="primary agent-confirm" data-task="${esc(task.id)}">确认并开始生成</button></p>
                <div class="agent-task-message muted"></div>
              </div>`
            : "";
        const review =
          task.status === "REVIEW_READY" && task.outputArtifactId
            ? `<div class="card">
                <h4>审片</h4>
                <video controls preload="metadata" style="width:100%;max-height:640px;background:#000" src="/api/artifacts/${esc(task.outputArtifactId)}/content"></video>
                <p><button class="primary agent-accept" data-task="${esc(task.id)}">采用这个结果</button>
                <button class="secondary agent-redo" data-task="${esc(task.id)}">按相同材料重新生成</button></p>
                <div class="agent-task-message muted"></div>
              </div>`
            : "";
        return `<section class="card agent-task" data-task-id="${esc(task.id)}" data-polling="${polling ? "1" : "0"}">
          <div class="head"><div><h3>${esc(task.requestText)}</h3><p class="muted">${esc(task.createdAt)}</p></div><span class="status">${esc(agentTaskStatusLabel[task.status])}</span></div>
          <p>生成能力：<b>Dreamina / Seedance</b> · 方式：${esc(plan?.operationLabel ?? task.requestedMethod)} · 模型：${esc(plan?.model ?? task.model)} · ${task.durationMs / 1000}s · ${esc(task.aspectRatio)} · ${esc(task.videoResolution)} · 原生声音：${task.nativeAudioOutputRequested ? "请求" : "关闭"}</p>
          ${plan ? `<p class="muted">${esc(plan.reason)}</p>` : ""}
          ${missing.length
            ? `<div class="blocker"><b>还不能提交生成</b>${missing.map((item) => `<p>${esc(item)}</p>`).join("")}<p><button class="secondary agent-recheck" data-task="${esc(task.id)}">重新检查生成能力 / 命令 / 登录状态</button></p></div>`
            : ""}
          ${plan?.warnings.length ? `<p class="muted">提示：${esc(plan.warnings.join("；"))}</p>` : ""}
          ${adaptationHtml}
          ${polling ? '<p class="ok agent-live-state">已确认并提交，系统正在自动检查生成状态…</p>' : ""}
          ${task.status === "RECONCILE_REQUIRED" ? `<div class="blocker"><b>提交结果未知</b><p>系统不会自动重复提交或再次扣费。请先尝试恢复即梦任务状态。</p><p><button class="secondary agent-reconcile" data-task="${esc(task.id)}">恢复提交状态</button></p><div class="agent-task-message muted"></div></div>` : ""}
          ${task.status === "FAILED" ? '<p class="danger">任务未完成。请展开高级信息检查生成记录；如果提交结果未知，不会自动重复付费提交。</p>' : ""}
          ${task.status === "ACCEPTED" && task.outputArtifactId ? `<p class="ok">已采用此结果。</p><video controls preload="metadata" style="width:100%;max-height:420px;background:#000" src="/api/artifacts/${esc(task.outputArtifactId)}/content"></video>` : ""}
          ${materialEditor}
          ${confirm}
          ${review}
          ${plan ? `<details class="technical"><summary>生成能力技术审计</summary><p class="hash">skill=${esc(plan.skillPath)}<br>skillSha256=${esc(plan.skillSha256)}<br>rootHelpSha256=${esc(plan.rootHelpSha256)}<br>commandHelpSha256=${esc(plan.commandHelpSha256)}<br>checkedAt=${esc(plan.capabilityCheckedAt)}</p></details>` : ""}
        </section>`;
      }).join("")
    : '<section class="card"><p>还没有智能生成任务。</p></section>';

  return layout(
    "单视频生成",
    `${projectHeader(workspace, "单视频生成")}
    <section class="card"><h3>这是单片段工具，不是完整成片入口</h3><p><a class="primary" href="/projects/${encodeURIComponent(workspace.project.id)}/smart">返回智能生成：按 ${workspace.project.targetDurationMs/1000} 秒总时长自动写脚本、拆分镜头并生成成片</a></p><p class="muted">本页只用于单独生成一个 Seedance 片段，所以单次时长必须服从当前模型上限；项目总时长不会在这里直接提交。</p></section>
    <section class="card">
      <h3>直接生成一个视频</h3>
      <p class="muted">系统会先检查材料和当前 Dreamina 官方生成能力。真实消耗积分前仍会要求你确认一次。</p>
      <form id="agent-create-form">
        ${prefillReference ? `<div class="card"><b>已从“参考视频”带入生成直参：</b>${esc(prefillReference.originalFilename)}<input type="hidden" name="existingReferenceArtifactId" value="${esc(prefillReference.artifactId)}"><p class="muted">这条视频将直接传给 Dreamina 全能参考；参考视频分析结果仍是另一条独立链路。</p></div>` : ""}
        <label class="field">我要做什么<textarea name="requestText" required placeholder="例如：用这张产品图做一个 9:16 的 10 秒广告，产品外观和品牌标志不要改变，镜头缓慢推进。"></textarea></label>
        <div class="row">
          <input type="hidden" name="skillId" value="dreamina-cli">
          <label class="field">即梦 Skill / 命令
            <select name="requestedMethod" id="agent-operation">
              <option value="AUTO">自动选择最合适的官方命令</option>
            </select>
          </label>
          <label class="field">视频模型
            <select name="model" id="agent-model" disabled>
              <option value="">正在读取当前 CLI 能力…</option>
            </select>
          </label>
          <label class="field">画幅
            <select name="aspectRatio" id="agent-aspect-ratio" disabled>
              <option value="">正在读取…</option>
            </select>
          </label>
          <label class="field">分辨率
            <select name="videoResolution" id="agent-resolution" disabled>
              <option value="">正在读取…</option>
            </select>
          </label>
          <label class="field">单个 Seedance 片段时长（秒）<input id="agent-duration" name="durationSeconds" type="number" min="2" max="120" step="1" value="10" required><span class="muted">这里只控制一个生成片段；完整成片请使用“智能生成”，系统会按项目总时长自动拆镜。</span></label>
        </div>
        <section class="card">
          <h4>声音</h4>
          <label><input type="checkbox" id="agent-native-audio" checked> 让模型原生输出声音</label>
          <p id="agent-native-audio-help" class="muted">正在检查当前 Seedance 生成方式是否能稳定返回音轨…</p>
          <p class="muted"><b>参考音频输入</b>与“模型原生输出声音”是两回事：需要参考音频时，请在下方参考素材中上传音频；BGM / 旁白 / 音效仍可在后期剪辑阶段补齐。</p>
        </section>
        <section class="card">
          <h4>参考素材</h4>
          <label class="field">选择图片 / 视频 / 音频（可多选、可继续追加）
            <input id="agent-material-input" name="materials" type="file" accept="image/*,video/*,audio/*" multiple>
            <span class="muted">再次选择文件会追加到当前列表，不会覆盖之前的选择。</span>
          </label>
          <input id="agent-material-replace-input" type="file" accept="image/*,video/*,audio/*" hidden>
          <div id="agent-material-list" class="agent-material-list"><div class="agent-material-empty">尚未选择参考素材。</div></div>
          <p><button type="button" class="secondary" id="agent-material-clear" disabled>清空全部参考素材</button></p>
        </section>
        <section class="card">
          <h4>品牌标志 Logo（独立管理）</h4>
          <label class="field">选择 / 替换 Logo
            <input id="agent-logo-input" name="logo" type="file" accept="image/*">
          </label>
          <div id="agent-logo-preview" class="agent-logo-box"><div class="agent-material-empty">尚未选择 Logo。</div></div>
          <p><button type="button" class="secondary" id="agent-logo-replace" disabled>替换 Logo</button> <button type="button" class="secondary" id="agent-logo-remove" disabled>删除 Logo</button></p>
        </section>
        <p id="agent-capability-status" class="muted">正在读取 Dreamina 官方 SKILL.md + CLI help…</p>
        <p><button class="primary" id="agent-create-submit" type="submit" disabled>检查材料并生成方案</button></p>
        <div id="agent-create-progress" class="muted"></div>
        <div id="agent-create-error" class="danger"></div>
      </form>
    </section>
    <section><h2>智能生成任务</h2>${taskCards}</section>
<script>
async function agentFilePayload(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('读取文件失败：'+file.name));
    reader.onload=()=>resolve({name:file.name,mimeType:file.type||'application/octet-stream',base64:String(reader.result||'')});
    reader.readAsDataURL(file);
  });
}
const agentMaterialManager=pvsCreateMaterialManager({
  input:document.querySelector('#agent-material-input'),
  replaceInput:document.querySelector('#agent-material-replace-input'),
  list:document.querySelector('#agent-material-list'),
  clearButton:document.querySelector('#agent-material-clear'),
  logoInput:document.querySelector('#agent-logo-input'),
  logoPreview:document.querySelector('#agent-logo-preview'),
  logoReplace:document.querySelector('#agent-logo-replace'),
  logoRemove:document.querySelector('#agent-logo-remove'),
  allowedTypes:['image','video','audio'],
  invalidTypeMessage:'只支持图片、视频或音频文件',
  emptyText:'尚未选择参考素材。',
  logoEmptyText:'尚未选择 Logo。'
});
const agentOperationSelect=document.querySelector('#agent-operation');
const agentModelSelect=document.querySelector('#agent-model');
const agentRatioSelect=document.querySelector('#agent-aspect-ratio');
const agentResolutionSelect=document.querySelector('#agent-resolution');
const agentDurationInput=document.querySelector('#agent-duration');
const agentNativeAudio=document.querySelector('#agent-native-audio');
const agentNativeAudioHelp=document.querySelector('#agent-native-audio-help');
const agentCapabilityStatus=document.querySelector('#agent-capability-status');
const agentCreateSubmit=document.querySelector('#agent-create-submit');
let agentCapabilityRegistry=null;
const uniq=values=>[...new Set(values.filter(Boolean))];
const modelLabel=value=>value==='AUTO'?'自动模型（仅使用命令明确声明的默认模型）':value==='FIXED'?'固定模型（当前 CLI / 后端决定）':String(value).replace(/^seedance/i,'Seedance ');
function fillSelect(select,items,selected){
  select.innerHTML=items.map(item=>'<option value="'+item.value+'">'+item.label+'</option>').join('');
  if(selected&&items.some(item=>item.value===selected))select.value=selected;
}
function selectedOperationCapability(){
  if(!agentCapabilityRegistry||agentOperationSelect.value==='AUTO')return null;
  return agentCapabilityRegistry.operations.find(item=>item.operation===agentOperationSelect.value)||null;
}
function refreshAgentGenerationControls(){
  const registry=agentCapabilityRegistry;
  if(!registry)return;
  const operation=selectedOperationCapability();
  const oldModel=agentModelSelect.value;
  let modelItems=[];
  if(operation?.fixedModel){
    modelItems=[{value:'FIXED',label:operation.fixedModelLabel||'固定模型（当前 CLI / 后端决定）'}];
  }else{
    const configurableOps=registry.operations.filter(item=>!item.fixedModel&&item.modelConfigurable);
    const models=operation
      ? operation.supportedModels
      : configurableOps.length
        ? configurableOps.map(item=>item.supportedModels||[]).reduce((acc,next)=>acc.filter(value=>next.includes(value)))
        : registry.models;
    const allowAuto=!operation||Boolean(operation.defaultModelVersion);
    modelItems=[
      ...(allowAuto?[{value:'AUTO',label:modelLabel('AUTO')}]:[]),
      ...models.map(value=>({value,label:modelLabel(value)}))
    ];
  }
  fillSelect(agentModelSelect,modelItems,oldModel);
  agentModelSelect.disabled=Boolean(operation?.fixedModel);
  const effectiveModel=agentModelSelect.value==='AUTO'
    ? operation?.defaultModelVersion
    : agentModelSelect.value==='FIXED'
      ? undefined
      : agentModelSelect.value;
  let candidateOps=[];
  let modelCaps=[];
  if(operation){
    candidateOps=[operation];
    modelCaps=operation.fixedModel
      ? [{supportedResolutions:operation.fixedResolutions||[],explicitRatioAllowed:false}]
      : effectiveModel
        ? operation.models.filter(item=>item.modelVersion===effectiveModel)
        : operation.models;
  }else if(agentModelSelect.value==='AUTO'){
    candidateOps=registry.operations;
    modelCaps=candidateOps.map(item=>
      item.fixedModel
        ? {supportedResolutions:item.fixedResolutions||[],explicitRatioAllowed:false}
        : item.models.find(model=>model.modelVersion===item.defaultModelVersion)
    ).filter(Boolean);
  }else if(effectiveModel){
    candidateOps=registry.operations.filter(item=>!item.fixedModel&&item.models.some(model=>model.modelVersion===effectiveModel));
    modelCaps=candidateOps.flatMap(item=>item.models.filter(model=>model.modelVersion===effectiveModel));
  }else{
    modelCaps=registry.operations.flatMap(item=>item.models);
  }
  const explicitRatioAllowed=
    operation?.fixedModel?false:
    modelCaps.length?modelCaps.every(item=>item.explicitRatioAllowed):true;
  const ratios=explicitRatioAllowed
    ? (candidateOps.length
        ? candidateOps.map(item=>item.supportedRatios||[]).reduce((acc,next)=>acc.filter(value=>next.includes(value)))
        : registry.ratios)
    : [];
  fillSelect(agentRatioSelect,[
    {value:'AUTO',label:operation?.fixedModel?'自动 / 跟随首帧（命令不接受显式画幅）':'自动 / 跟随素材'},
    ...ratios.map(value=>({value,label:value}))
  ],agentRatioSelect.value||'AUTO');
  agentRatioSelect.disabled=false;
  let resolutions=operation?.fixedModel
    ? operation.fixedResolutions
    : modelCaps.length
      ? modelCaps.map(item=>item.supportedResolutions||[]).reduce((acc,next)=>acc.filter(value=>next.includes(value)))
      : [];
  const resolutionItems=resolutions.map(value=>({value,label:value}));
  fillSelect(agentResolutionSelect,resolutionItems,agentResolutionSelect.value);
  if(!agentResolutionSelect.value&&resolutions.includes('720p'))agentResolutionSelect.value='720p';
  agentResolutionSelect.disabled=!resolutionItems.length;
  const mins=modelCaps.map(item=>item.durationMinSeconds).filter(value=>Number.isFinite(value));
  const maxs=modelCaps.map(item=>item.durationMaxSeconds).filter(value=>Number.isFinite(value));
  agentDurationInput.min=String(mins.length?Math.min(...mins):2);
  agentDurationInput.max=String(maxs.length?Math.max(...maxs):120);
  const nativeSupported=operation
    ? operation.supportsNativeAudioOutput===true
    : agentCapabilityRegistry.nativeAudioOutputSupported===true;
  agentNativeAudio.disabled=!nativeSupported;
  if(!nativeSupported)agentNativeAudio.checked=false;
  agentNativeAudioHelp.textContent=nativeSupported
    ? 'Seedance 当前链路会直接生成原生音轨；程序下载结果后还会检查音轨是否真实存在。'
    : '当前生成方式不能保证返回原生音轨；如需声音，请使用文生视频或全能参考。';
  agentCreateSubmit.disabled=!agentModelSelect.value||!agentResolutionSelect.value;
}
async function loadAgentCapabilityRegistry(){
  try{
    const response=await fetch('/api/dreamina/capabilities');
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.message||payload.error||'读取 Dreamina 能力失败');
    agentCapabilityRegistry=payload.registry;
    fillSelect(agentOperationSelect,[
      {value:'AUTO',label:'自动选择最合适的官方命令'},
      ...agentCapabilityRegistry.operations.map(item=>({value:item.operation,label:item.operationLabel}))
    ],agentOperationSelect.value||'AUTO');
    agentCapabilityStatus.textContent='能力来源：官方 SKILL.md + 当前 dreamina --help · 模型 '+agentCapabilityRegistry.models.join(' / ')+' · 画幅 '+agentCapabilityRegistry.ratios.join(' / ')+' · 检查时间 '+agentCapabilityRegistry.checkedAt;
    refreshAgentGenerationControls();
  }catch(err){
    agentCapabilityStatus.textContent='Dreamina 动态能力读取失败：'+(err.message||String(err));
    document.querySelector('#agent-create-error').textContent=agentCapabilityStatus.textContent;
    agentCreateSubmit.disabled=true;
  }
}
agentOperationSelect?.addEventListener('change',refreshAgentGenerationControls);
agentModelSelect?.addEventListener('change',refreshAgentGenerationControls);
loadAgentCapabilityRegistry();
async function agentPost(url,body){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok)throw new Error(j.message||j.error||'操作失败'); return j;
}
document.querySelectorAll('.agent-existing-material-editor').forEach(editor=>{
  let state={items:[]};
  try{state=JSON.parse(editor.dataset.state||'{"items":[]}');}catch{state={items:[]};}
  const manager=pvsCreateMaterialManager({
    input:editor.querySelector('.agent-task-material-input'),
    replaceInput:editor.querySelector('.agent-task-material-replace-input'),
    list:editor.querySelector('.agent-task-material-list'),
    clearButton:editor.querySelector('.agent-task-material-clear'),
    logoInput:editor.querySelector('.agent-task-logo-input'),
    logoPreview:editor.querySelector('.agent-task-logo-preview'),
    logoReplace:editor.querySelector('.agent-task-logo-replace'),
    logoRemove:editor.querySelector('.agent-task-logo-remove'),
    initialItems:state.items||[],
    initialLogo:state.logo||null,
    allowedTypes:['image','video','audio'],
    invalidTypeMessage:'只支持图片、视频或音频文件',
    emptyText:'当前没有普通参考素材。',
    logoEmptyText:'当前没有 Logo。'
  });
  const save=editor.querySelector('.agent-task-material-save');
  const message=editor.querySelector('.agent-task-material-message');
  save?.addEventListener('click',async()=>{
    save.disabled=true;message.textContent='正在保存素材并重新检查生成能力…';
    try{
      const invalid=manager.validate();
      if(invalid.length)throw new Error('请先删除或替换不可用素材：'+invalid.join('、'));
      const orderedMaterials=[];
      const readErrors=[];
      for(const entry of manager.getItems()){
        if(entry.source==='existing'){orderedMaterials.push({existingArtifactId:entry.artifactId});continue;}
        try{orderedMaterials.push({upload:await agentFilePayload(entry.file)});}
        catch(readError){readErrors.push('文件“'+entry.file.name+'”：'+(readError.message||String(readError)));}
      }
      const logoState=manager.getLogo();
      let logo,existingLogoArtifactId;
      if(logoState?.source==='existing')existingLogoArtifactId=logoState.artifactId;
      if(logoState?.source==='local'){
        try{logo=await agentFilePayload(logoState.file);}
        catch(readError){readErrors.push('Logo“'+logoState.file.name+'”：'+(readError.message||String(readError)));}
      }
      if(readErrors.length)throw new Error(readErrors.join('；'));
      await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(editor.dataset.taskId)+'/materials',{orderedMaterials,existingLogoArtifactId,logo});
      location.reload();
    }catch(err){message.textContent=err.message||String(err);save.disabled=false;}
  });
});
document.querySelector('#agent-create-form')?.addEventListener('submit',async(e)=>{
  e.preventDefault();const form=e.currentTarget,f=new FormData(form);
  const progress=document.querySelector('#agent-create-progress'),error=document.querySelector('#agent-create-error');
  error.textContent='';progress.textContent='正在保存材料并检查 Dreamina 当前生成能力…';
  const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{
    const invalid=agentMaterialManager.validate();
    if(invalid.length)throw new Error('请先删除或替换不可用素材：'+invalid.join('、'));
    const materials=[];
    const readErrors=[];
    for(const file of agentMaterialManager.getNewFiles()){
      try{materials.push(await agentFilePayload(file));}
      catch(readError){readErrors.push('文件“'+file.name+'”：'+(readError.message||String(readError)));}
    }
    const logoFile=agentMaterialManager.getNewLogoFile();
    let logo;
    if(logoFile){
      try{logo=await agentFilePayload(logoFile);}
      catch(readError){readErrors.push('Logo“'+logoFile.name+'”：'+(readError.message||String(readError)));}
    }
    if(readErrors.length)throw new Error(readErrors.join('；'));
    await agentPost('/api/projects/${workspace.project.id}/agent/tasks',{
      skillId:f.get('skillId'),
      requestText:f.get('requestText'),
      requestedMethod:agentOperationSelect.value,
      model:agentModelSelect.value,
      aspectRatio:agentRatioSelect.value,
      videoResolution:agentResolutionSelect.value,
      nativeAudioOutputRequested:Boolean(agentNativeAudio.checked),
      durationMs:Number(f.get('durationSeconds'))*1000,
      materials,
      existingArtifactIds:f.get('existingReferenceArtifactId')?[f.get('existingReferenceArtifactId')]:[],
      logo
    });
    location.reload();
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';button.disabled=false;}
});
document.querySelectorAll('.agent-recheck').forEach(button=>button.addEventListener('click',async()=>{
  button.disabled=true;try{await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(button.dataset.task)+'/plan',{});location.reload();}
  catch(err){alert(err.message||String(err));button.disabled=false;}
}));
document.querySelectorAll('.agent-confirm').forEach(button=>button.addEventListener('click',async()=>{
  const card=button.closest('.agent-task');
  const checkbox=card.querySelector('.agent-unknown-cost');
  const acceptedUnknownCostRisk=checkbox?checkbox.checked:true;
  if(checkbox&&!checkbox.checked){alert('当前无法显示准确积分消耗，请先勾选成本风险确认。');return;}
  button.disabled=true;
  try{await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(button.dataset.task)+'/confirm',{acceptedUnknownCostRisk});location.reload();}
  catch(err){const m=card.querySelector('.agent-task-message');m.textContent=err.message||String(err);button.disabled=false;}
}));
document.querySelectorAll('.agent-accept').forEach(button=>button.addEventListener('click',async()=>{
  button.disabled=true;try{await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(button.dataset.task)+'/accept',{});location.reload();}
  catch(err){alert(err.message||String(err));button.disabled=false;}
}));
document.querySelectorAll('.agent-redo').forEach(button=>button.addEventListener('click',async()=>{
  if(!confirm('按相同材料和要求创建一次新的生成任务？新任务仍会在扣费前再次确认。'))return;
  button.disabled=true;try{await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(button.dataset.task)+'/redo',{});location.reload();}
  catch(err){alert(err.message||String(err));button.disabled=false;}
}));
document.querySelectorAll('.agent-reconcile').forEach(button=>button.addEventListener('click',async()=>{
  const card=button.closest('.agent-task');
  button.disabled=true;
  try{await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(button.dataset.task)+'/reconcile',{});location.reload();}
  catch(err){const m=card.querySelector('.agent-task-message');if(m)m.textContent=err.message||String(err);button.disabled=false;}
}));
let agentPolling=false;
async function advanceAgentTasks(){
  if(agentPolling)return;agentPolling=true;
  const cards=[...document.querySelectorAll('.agent-task[data-polling="1"]')];
  let changed=false;
  try{
    for(const card of cards){
      const j=await agentPost('/api/projects/${workspace.project.id}/agent/tasks/'+encodeURIComponent(card.dataset.taskId)+'/advance',{});
      if(j.task.status!=='SUBMITTED'&&j.task.status!=='PROCESSING')changed=true;
    }
  }catch(err){console.warn('智能生成自动刷新失败',err);}
  agentPolling=false;
  if(changed){location.reload();return;}
  if(cards.length)setTimeout(advanceAgentTasks,4000);
}
if(document.querySelector('.agent-task[data-polling="1"]'))setTimeout(advanceAgentTasks,1200);
</script>`,
    workspace.project,
    [],
    input.navigation
  );
}

const aiStepLabel: Record<AiStep, string> = {
  PRODUCT_TRUTH: "产品事实",
  CREATIVE: "创意方案",
  SCRIPT: "脚本",
  DIRECTOR: "导演分镜",
  REFERENCE_VIDEO_ANALYSIS: "参考视频分析",
  AUTO_EDIT_VISUAL: "视觉审片 / 智能剪辑",
  RESEARCH: "联网研究",
  DOUYIN_OPS: "抖音运营"
};

const aiCapabilityLabel = {
  TEXT: "文本",
  VISION: "图片理解",
  AUDIO: "音频理解",
  VIDEO: "视频理解",
  OCR: "文字识别"
} as const;

function aiCapabilityText(values: AiModelConfig["capabilities"]): string {
  return values.map((item) => aiCapabilityLabel[item]).join(" / ");
}

function aiSelectionValue(providerId?: string, modelId?: string): string {
  return providerId && modelId ? providerId + "::" + modelId : "";
}

function aiModelOptions(
  providers: AiProviderWithModels[],
  selected: string,
  emptyLabel: string
): string {
  const options = [`<option value="" ${selected ? "" : "selected"}>${esc(emptyLabel)}</option>`];
  for (const provider of providers.filter((item) => item.enabled && item.hasSecret)) {
    for (const model of provider.models.filter((item) => item.enabled)) {
      const value = aiSelectionValue(provider.id, model.modelId);
      options.push(
        `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(provider.name)} · ${esc(model.displayName ?? model.modelId)} · ${esc(aiCapabilityText(model.capabilities))}</option>`
      );
    }
  }
  return options.join("");
}

export function renderAiSettingsPage(
  providers: AiProviderWithModels[],
  systemPreference: AiSystemPreference
): string {
  const systemSelected = aiSelectionValue(
    systemPreference.defaultProviderId,
    systemPreference.defaultModelId
  );
  const providerCards = providers.length
    ? providers.map((provider) => `
      <section class="card">
        <div class="head">
          <div>
            <h3>${esc(provider.name)}</h3>
            <p>连接状态：<b class="${provider.connectionStatus === "CONNECTED" ? "ok" : provider.connectionStatus === "FAILED" ? "danger" : ""}">${!provider.hasSecret ? "未配置" : provider.connectionStatus === "CONNECTED" ? "已连接" : provider.connectionStatus === "FAILED" ? "连接失败" : "待测试"}</b></p><p class="muted">API 密钥：${provider.hasSecret ? "已加密保存" : "未配置"}${provider.lastTestedAt ? ` · 最近测试：${esc(provider.lastTestedAt)}` : ""}<span class="technical"> · 配置版本 v${provider.configVersion}</span></p>
          </div>
          <span class="status">${provider.enabled ? "已启用" : "已停用"}</span>
        </div>
        <form class="provider-form" data-provider-id="${esc(provider.id)}">
          <input type="hidden" name="id" value="${esc(provider.id)}">
          <div class="row">
            <label class="field">名称<input name="name" required value="${esc(provider.name)}"></label>
            <label class="field">接口地址<input name="baseUrl" required value="${esc(provider.baseUrl)}"></label>
          </div>
          <div class="row">
            <label class="field">替换 API 密钥
              <input name="apiKey" type="password" autocomplete="new-password" placeholder="留空表示不修改">
              <span class="muted">密钥不会回显，也不会进入项目文件、日志或 Git。</span>
              <span><label><input name="clearApiKey" type="checkbox"> 清除已保存的 API 密钥</label></span>
            </label>
            <label class="field">服务商默认模型
              <input name="defaultModelId" value="${esc(provider.defaultModelId ?? "")}" placeholder="可选，例如 deepseek-v4.1-flash">
            </label>
          </div>
          <div class="row">
            <label class="field">超时（毫秒）<input name="timeoutMs" type="number" min="5000" max="600000" step="1000" value="${provider.timeoutMs}"></label>
            <label class="field">技术重试次数<input name="maxRetries" type="number" min="0" max="3" step="1" value="${provider.maxRetries}"></label>
          </div>
          <p><label><input name="enabled" type="checkbox" ${provider.enabled ? "checked" : ""}> 启用此服务商</label></p>
          <p>
            <button class="primary" type="submit">保存设置</button>
            <button class="secondary provider-test" type="button" data-provider-id="${esc(provider.id)}">测试连接</button>
            <button class="secondary provider-refresh" type="button" data-provider-id="${esc(provider.id)}">获取模型列表</button>
          </p>
          <div class="provider-message muted"></div>
        </form>
        <details>
          <summary>已登记模型（${provider.models.length}）</summary>
          ${provider.models.length ? provider.models.map((model)=>`<form class="model-capability-form clip" data-provider-id="${esc(provider.id)}" data-model-id="${esc(model.modelId)}">
            <div class="head"><div><b>${esc(model.displayName ?? model.modelId)}</b><p class="muted"><code>${esc(model.modelId)}</code> · ${model.source === "MANUAL" ? "手工添加" : "自动发现"}</p></div><span class="status">${esc(aiCapabilityText(model.capabilities))}</span></div>
            <p class="muted">模型能力决定程序是否可以自动把图片、视频抽帧等资料交给它分析。</p>
            <div class="row">
              ${(["TEXT","VISION","AUDIO","VIDEO","OCR"] as const).map((cap)=>`<label><input type="checkbox" name="capability" value="${cap}" ${model.capabilities.includes(cap)?"checked":""}> ${esc(aiCapabilityLabel[cap])}</label>`).join(" ")}
            </div>
            <p><button class="secondary" type="submit">保存模型能力</button></p>
            <div class="model-capability-message muted"></div>
          </form>`).join("") : "<p>尚无模型。可自动获取模型列表，或手工添加。</p>"}
          <form class="manual-model-form" data-provider-id="${esc(provider.id)}">
            <div class="row">
              <label class="field">手工模型编号<input name="modelId" required placeholder="例如 deepseek-v4.1-flash"></label>
              <label class="field">显示名称<input name="displayName" placeholder="可选"></label>
            </div>
            <p>模型能力：
              <label><input type="checkbox" name="capability" value="TEXT" checked> 文本</label>
              <label><input type="checkbox" name="capability" value="VISION"> 图片理解</label>
              <label><input type="checkbox" name="capability" value="AUDIO"> 音频理解</label>
              <label><input type="checkbox" name="capability" value="VIDEO"> 视频理解</label>
              <label><input type="checkbox" name="capability" value="OCR"> 文字识别</label>
            </p>
            <p><button class="secondary" type="submit">添加模型</button></p>
            <div class="manual-model-message muted"></div>
          </form>
        </details>
      </section>`).join("")
    : '<section class="card"><p>还没有大模型服务商。先添加一个兼容 OpenAI 接口格式的服务。</p></section>';

  return layout(
    "大模型设置",
    `<div class="head"><div><h1>大模型设置</h1><p class="muted">这里管理本程序用于分析、创意、脚本和导演的语言模型。即梦 / Seedance 视频模型与这里完全分开。</p></div></div>
    <section class="card">
      <h3>系统默认模型</h3>
      <form id="system-ai-default">
        <label class="field">默认模型
          <select name="selection">${aiModelOptions(providers, systemSelected, "Hermes 兼容模式（沿用外部配置）")}</select>
        </label>
        <p><button class="primary" type="submit">保存系统默认</button></p>
        <div id="system-ai-message" class="muted"></div>
      </form>
    </section>
    <section class="card">
      <h3>添加大模型服务商</h3><p class="muted">当前支持兼容 OpenAI 接口格式的服务。</p>
      <form id="new-provider-form">
        <div class="row">
          <label class="field">名称<input name="name" required placeholder="例如 AIHubMix"></label>
          <label class="field">接口地址<input name="baseUrl" required placeholder="https://example.com/v1"></label>
        </div>
        <div class="row">
          <label class="field">API 密钥<input name="apiKey" type="password" autocomplete="new-password" required></label>
          <label class="field">默认模型编号<input name="defaultModelId" placeholder="可选"></label>
        </div>
        <div class="row">
          <label class="field">超时（毫秒）<input name="timeoutMs" type="number" min="5000" max="600000" step="1000" value="180000"></label>
          <label class="field">技术重试次数<input name="maxRetries" type="number" min="0" max="3" step="1" value="1"></label>
        </div>
        <p><button class="primary" type="submit">保存服务商</button></p>
        <div id="new-provider-message" class="muted"></div>
      </form>
    </section>
    ${providerCards}
<script>
function splitSelection(value){
  if(!value)return {};
  const i=value.indexOf('::');
  return i<0?{}:{providerId:value.slice(0,i),modelId:value.slice(i+2)};
}
async function jsonPost(url,body){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(!r.ok)throw new Error(j.message||j.error||'操作失败');
  return j;
}
document.querySelector('#new-provider-form')?.addEventListener('submit',async(e)=>{
  e.preventDefault(); const f=new FormData(e.currentTarget),m=document.querySelector('#new-provider-message');
  try{
    m.textContent='正在保存…';
    await jsonPost('/api/ai/providers',{
      name:f.get('name'),baseUrl:f.get('baseUrl'),apiKey:f.get('apiKey'),
      defaultModelId:String(f.get('defaultModelId')||'').trim()||undefined,
      timeoutMs:Number(f.get('timeoutMs')),maxRetries:Number(f.get('maxRetries')),enabled:true
    });
    location.reload();
  }catch(err){m.textContent=err.message||String(err);}
});
document.querySelectorAll('.provider-form').forEach(form=>form.addEventListener('submit',async(e)=>{
  e.preventDefault(); const f=new FormData(form),m=form.querySelector('.provider-message');
  try{
    m.textContent='正在保存…';
    await jsonPost('/api/ai/providers',{
      id:f.get('id'),name:f.get('name'),baseUrl:f.get('baseUrl'),
      apiKey:String(f.get('apiKey')||'').trim()||undefined,
      clearApiKey:Boolean(f.get('clearApiKey')),
      defaultModelId:String(f.get('defaultModelId')||'').trim()||undefined,
      timeoutMs:Number(f.get('timeoutMs')),maxRetries:Number(f.get('maxRetries')),
      enabled:Boolean(f.get('enabled'))
    });
    location.reload();
  }catch(err){m.textContent=err.message||String(err);}
}));
document.querySelectorAll('.provider-test').forEach(button=>button.addEventListener('click',async()=>{
  const form=button.closest('.card').querySelector('.provider-form'),m=form.querySelector('.provider-message');
  try{m.textContent='正在测试连接…';const j=await jsonPost('/api/ai/providers/'+encodeURIComponent(button.dataset.providerId)+'/test',{});m.textContent='连接成功，可发现 '+j.modelCount+' 个模型。';}
  catch(err){m.textContent='连接失败：'+(err.message||String(err));}
}));
document.querySelectorAll('.provider-refresh').forEach(button=>button.addEventListener('click',async()=>{
  const form=button.closest('.card').querySelector('.provider-form'),m=form.querySelector('.provider-message');
  try{m.textContent='正在获取模型列表…';const j=await jsonPost('/api/ai/providers/'+encodeURIComponent(button.dataset.providerId)+'/models/refresh',{});m.textContent='已获取 '+j.models.length+' 个模型。';setTimeout(()=>location.reload(),500);}
  catch(err){m.textContent='获取失败：'+(err.message||String(err));}
}));
document.querySelectorAll('.manual-model-form').forEach(form=>form.addEventListener('submit',async(e)=>{
  e.preventDefault(); const f=new FormData(form),m=form.querySelector('.manual-model-message');
  try{await jsonPost('/api/ai/providers/'+encodeURIComponent(form.dataset.providerId)+'/models/manual',{modelId:f.get('modelId'),displayName:f.get('displayName'),capabilities:f.getAll('capability')});location.reload();}
  catch(err){m.textContent=err.message||String(err);}
}));
document.querySelectorAll('.model-capability-form').forEach(form=>form.addEventListener('submit',async(e)=>{
  e.preventDefault();const f=new FormData(form),m=form.querySelector('.model-capability-message');
  const capabilities=f.getAll('capability');
  if(!capabilities.length){m.textContent='至少保留一种能力。';return;}
  try{m.textContent='正在保存…';await jsonPost('/api/ai/providers/'+encodeURIComponent(form.dataset.providerId)+'/models/capabilities',{modelId:form.dataset.modelId,capabilities});m.textContent='已保存。';setTimeout(()=>location.reload(),300);}
  catch(err){m.textContent=err.message||String(err);}
}));
document.querySelector('#system-ai-default')?.addEventListener('submit',async(e)=>{
  e.preventDefault(); const f=new FormData(e.currentTarget),m=document.querySelector('#system-ai-message');
  try{m.textContent='正在保存…';await jsonPost('/api/ai/default',splitSelection(String(f.get('selection')||'')));location.reload();}
  catch(err){m.textContent=err.message||String(err);}
});
</script>`
  );
}

export function renderProjectModelSettingsPage(input: {
  workspace: ProjectWorkspace;
  navigation?: WorkflowNavigationState;
  providers: AiProviderWithModels[];
  systemPreference: AiSystemPreference;
  projectPreference: ProjectAiPreference;
  overrides: StepModelOverride[];
  executions: AiExecutionRecord[];
}): string {
  const { workspace, providers, systemPreference, projectPreference, overrides, executions } = input;
  const projectSelected = aiSelectionValue(
    projectPreference.defaultProviderId,
    projectPreference.defaultModelId
  );
  const overrideByStep = new Map(overrides.map((item) => [item.step, item]));
  const stepForms = (Object.keys(aiStepLabel) as AiStep[]).map((step) => {
    const selected = overrideByStep.get(step);
    return `<form class="step-model-form card" data-step="${esc(step)}">
      <h3>${esc(aiStepLabel[step])}</h3>
      <label class="field">本步骤模型
        <select name="selection">${aiModelOptions(
          providers,
          aiSelectionValue(selected?.providerId, selected?.modelId),
          "跟随项目默认"
        )}</select>
      </label>
      <p><button class="secondary" type="submit">保存此步骤</button></p>
      <div class="step-model-message muted"></div>
    </form>`;
  }).join("");
  const systemText =
    systemPreference.defaultProviderId && systemPreference.defaultModelId
      ? systemPreference.defaultProviderId + " / " + systemPreference.defaultModelId
      : "Hermes 兼容模式";
  const history = executions.length
    ? executions.slice(0, 30).map((item) => `<div class="clip">
        <b>${esc(aiStepLabel[item.step])} · ${item.status === "SUCCEEDED" ? "成功" : "失败"}</b>
        <p>${esc(item.providerId)} / ${esc(item.modelId)} · 配置 v${item.configVersion}</p>
        <p class="technical">execution=${esc(item.id)} · inputHash=${esc(item.inputHash)}${item.outputHash ? " · outputHash="+esc(item.outputHash) : ""}</p>
      </div>`).join("")
    : "<p>还没有模型调用历史。</p>";
  return layout(
    "模型设置",
    `${projectHeader(workspace, "项目模型设置")}
    <section class="card">
      <h3>解析规则</h3>
      <p>当前步骤指定模型 → 项目默认模型 → 系统默认模型。</p>
      <p class="muted">系统默认：${esc(systemText)}。切换只影响后续新生成，不会改写历史结果。</p>
    </section>
    <section class="card">
      <h3>项目默认模型</h3>
      <form id="project-ai-default">
        <label class="field">默认模型
          <select name="selection">${aiModelOptions(providers, projectSelected, "跟随系统默认")}</select>
        </label>
        <p><button class="primary" type="submit">保存项目默认</button></p>
        <div id="project-ai-message" class="muted"></div>
      </form>
    </section>
    <div class="grid">${stepForms}</div>
    <section class="card technical"><h3>模型调用历史</h3>${history}</section>
<script>
function splitProjectSelection(value){
  if(!value)return {};
  const i=value.indexOf('::');
  return i<0?{}:{providerId:value.slice(0,i),modelId:value.slice(i+2)};
}
async function projectJsonPost(url,body){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok)throw new Error(j.message||j.error||'操作失败'); return j;
}
document.querySelector('#project-ai-default')?.addEventListener('submit',async(e)=>{
  e.preventDefault();const f=new FormData(e.currentTarget),m=document.querySelector('#project-ai-message');
  try{m.textContent='正在保存…';await projectJsonPost('/api/projects/${workspace.project.id}/ai/default',splitProjectSelection(String(f.get('selection')||'')));location.reload();}
  catch(err){m.textContent=err.message||String(err);}
});
document.querySelectorAll('.step-model-form').forEach(form=>form.addEventListener('submit',async(e)=>{
  e.preventDefault();const f=new FormData(form),m=form.querySelector('.step-model-message');
  try{m.textContent='正在保存…';await projectJsonPost('/api/projects/${workspace.project.id}/ai/step',{step:form.dataset.step,...splitProjectSelection(String(f.get('selection')||''))});location.reload();}
  catch(err){m.textContent=err.message||String(err);}
}));
</script>`,
    workspace.project,
    [],
    input.navigation
  );
}

function projectHeader(workspace: ProjectWorkspace, title: string): string {
  return `<div class="head"><div><h1>${esc(title)}</h1><p><b>当前要做：</b>${esc(currentActionForPage(workspace.project, title))}</p><p class="muted">${esc(workspace.project.name)} · 目标 ${workspace.project.targetDurationMs/1000} 秒</p><p class="muted technical">项目 ID：${esc(workspace.project.id)}</p></div><span class="status">${esc(statusLabel[workspace.project.status])}</span></div>`;
}

function renderProduct(
  workspace: ProjectWorkspace,
  productInput?: ProductInputSnapshot
): string {
  const saved = productInput
    ? `<section class="card"><h3>已保存产品资料 v${productInput.version}</h3>
       <p><b>${esc(productInput.productName)}</b> · ${esc(productInput.brand ?? "无品牌")} · ${esc(productInput.category ?? "未分类")}</p>
       <p>${esc(productInput.featureDescription)}</p>
       <p class="muted">素材：${productInput.assets.length} 个</p><p class="technical hash">内容校验值：${esc(productInput.contentHash)}</p>
       <button class="secondary" id="retry-truth">使用已保存资料重新生成产品事实</button>
       <span id="retry-error" class="danger"></span>
       </section>`
    : "";

  return `${projectHeader(workspace, "产品输入")}
  <section class="card"><h3>当前结果</h3><p>产品事实：${esc(refText(workspace.project.currentProductTruthRef))}</p>
  <p class="muted">系统会保存原始素材和输入快照；生成失败时可从已保存资料恢复。</p></section>
  ${saved}
  <section class="card"><h3>产品资料</h3>
  <form id="product-form">
    <div class="row">
      <label class="field">产品名称*<input name="productName" required value="${esc(productInput?.productName ?? "")}"></label>
      <label class="field">品牌<input name="brand" value="${esc(productInput?.brand ?? "")}"></label>
      <label class="field">类别<input name="category" value="${esc(productInput?.category ?? "")}"></label>
    </div>
    <label class="field">产品功能介绍*<textarea name="featureDescription" required>${esc(productInput?.featureDescription ?? "")}</textarea></label>
    <section class="card">
      <h4>产品图片*（至少 1 张，单张≤10MB）</h4>
      <div class="field"><span>选择产品图片（可多选、可继续追加）</span>
        <div class="row"><button type="button" class="secondary file-picker-label" id="product-image-pick">选择产品图片</button><span class="muted">再次选择会追加；提交前可以逐张预览、替换或删除。</span></div>
        <input class="file-picker-input" id="product-image-input" name="images" type="file" accept="image/*" multiple>
      </div>
      <input id="product-image-replace-input" type="file" accept="image/*" hidden>
      <div id="product-image-list" class="material-list"><div class="material-empty">尚未选择产品图片。</div></div>
      <p><button type="button" class="secondary" id="product-image-clear" disabled>清空全部产品图片</button></p>
    </section>
    <section class="card">
      <h4>品牌标志 Logo（可选，独立管理）</h4>
      <div class="field"><span>选择 / 替换 Logo</span><div class="row"><button type="button" class="secondary file-picker-label" id="product-logo-pick">选择 Logo</button></div><input class="file-picker-input" id="product-logo-input" name="logo" type="file" accept="image/*"></div>
      <div id="product-logo-preview" class="material-logo-box"><div class="material-empty">尚未选择 Logo。</div></div>
      <p><button type="button" class="secondary" id="product-logo-replace" disabled>替换 Logo</button> <button type="button" class="secondary" id="product-logo-remove" disabled>删除 Logo</button></p>
    </section>
    <h3>禁改项（可选）</h3>
    <div class="row">
      <label class="field">字段<select name="forbiddenField">
        <option value="logo">品牌标志</option><option value="color">颜色</option><option value="shape">形状</option>
        <option value="packaging">包装</option><option value="text">文字</option><option value="model">型号</option>
        <option value="proportion">比例</option><option value="other">其他</option>
      </select></label>
      <label class="field">严重级别<select name="forbiddenSeverity"><option value="HARD">严格禁止修改</option><option value="SOFT">尽量保持不变</option></select></label>
      <label class="field">说明<input name="forbiddenDescription" placeholder="例如：不得改变品牌标志形状"></label>
    </div>
    <p class="muted">先保存产品资料，再决定是否进行联网研究。无论研究还是跳过，最后都需要人工确认产品事实，未经确认不得进入正式创作。</p>
    <p>${!workspace.productTruth ? `<button class="primary" type="submit" id="save-for-research">保存资料，先进行可选研究</button> <button class="secondary" type="submit" id="generate-truth">跳过研究，直接生成待审核事实</button>` : `<button class="primary" type="submit" id="generate-truth">保存资料并生成新版本产品事实</button>`}</p>
    <p id="product-progress" class="muted"></p>
    <div id="product-error" class="danger"></div>
  </form></section>
<script>
async function pvsFilePayload(file){
  return await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve({name:file.name,mimeType:file.type||'application/octet-stream',base64:String(reader.result)});
    reader.onerror=()=>reject(new Error('读取文件失败：'+file.name));
    reader.readAsDataURL(file);
  });
}
const productMaterialManager=pvsCreateMaterialManager({
  initialItems:${jsonForScript(productInput?.assets.filter(asset=>asset.type==='image').map(asset=>({...asset,name:asset.originalFilename,previewUrl:'/api/artifacts/'+encodeURIComponent(asset.artifactId)+'/content'}))??[])},
  initialLogo:${jsonForScript(productInput?.assets.find(asset=>asset.type==='logo')?((asset)=>({...asset,name:asset.originalFilename,previewUrl:'/api/artifacts/'+encodeURIComponent(asset.artifactId)+'/content'}))(productInput.assets.find(asset=>asset.type==='logo')!):null)},
  input:document.querySelector('#product-image-input'),
  replaceInput:document.querySelector('#product-image-replace-input'),
  list:document.querySelector('#product-image-list'),
  clearButton:document.querySelector('#product-image-clear'),
  logoInput:document.querySelector('#product-logo-input'),
  logoPreview:document.querySelector('#product-logo-preview'),
  logoReplace:document.querySelector('#product-logo-replace'),
  logoRemove:document.querySelector('#product-logo-remove'),
  allowedTypes:['image'],
  invalidTypeMessage:'只支持图片文件',
  maxImageBytes:10*1024*1024,
  emptyText:'尚未选择产品图片。',
  logoEmptyText:'尚未选择 Logo。'
});
document.querySelector('#product-image-pick')?.addEventListener('click',()=>productMaterialManager.pickFiles());
document.querySelector('#product-logo-pick')?.addEventListener('click',()=>productMaterialManager.pickLogo());

const savedProductInputHash=${jsonForScript(productInput?.contentHash??null)};
const savedForbiddenChanges=${jsonForScript(productInput?.forbiddenChanges??[])};
if(savedForbiddenChanges.length){
  const form=document.querySelector('#product-form'),rule=savedForbiddenChanges[0];
  form.elements.forbiddenField.value=rule.field;form.elements.forbiddenSeverity.value=rule.severity;form.elements.forbiddenDescription.value=rule.description;
}

document.querySelector('#product-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const form=e.currentTarget, f=new FormData(form);
  const button=e.submitter||document.querySelector('#generate-truth');
  const progress=document.querySelector('#product-progress');
  const error=document.querySelector('#product-error');
  const deferTruth=button.id==='save-for-research';
  error.textContent=''; button.disabled=true;
  progress.textContent=deferTruth?'正在保存原始资料，下一步可联网研究或直接跳过研究…':'正在保存素材并生成待确认的产品事实…';
  try{
    if(!productMaterialManager.getItems().length)throw new Error('请至少选择 1 张产品图片');
    const invalid=productMaterialManager.validate();
    if(invalid.length)throw new Error('请先删除或替换不可用产品图片：'+invalid.join('、'));
    const orderedImages=[];
    const readErrors=[];
    for(const item of productMaterialManager.getItems()){
      if(item.source==='existing'){orderedImages.push({existingArtifactId:item.artifactId});continue;}
      const file=item.file;
      try{orderedImages.push({upload:await pvsFilePayload(file)});}
      catch(readError){readErrors.push('文件“'+file.name+'”：'+(readError.message||String(readError)));}
    }
    const logoFile=productMaterialManager.getNewLogoFile();
    let logo;
    if(logoFile){
      try{logo=await pvsFilePayload(logoFile);}
      catch(readError){readErrors.push('Logo“'+logoFile.name+'”：'+(readError.message||String(readError)));}
    }
    if(readErrors.length)throw new Error(readErrors.join('；'));
    const description=String(f.get('forbiddenDescription')||'').trim();
    const forbiddenChanges=[...(description?[{field:f.get('forbiddenField'),severity:f.get('forbiddenSeverity'),description}]:[]),...savedForbiddenChanges.slice(1)];
    const payload={
      productName:f.get('productName'),
      featureDescription:f.get('featureDescription'),
      brand:f.get('brand'),
      category:f.get('category'),
      orderedImages,
      logo,
      existingLogoArtifactId:productMaterialManager.getLogo()?.source==='existing'?productMaterialManager.getLogo().artifactId:undefined,
      expectedInputHash:savedProductInputHash??undefined,
      forbiddenChanges,
      deferTruth
    };
    const r=await fetch('/api/projects/${workspace.project.id}/product-input/generate-truth',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)
    });
    const j=await r.json();
    if(!r.ok) throw new Error(j.message||j.error||'生成失败');
    location.href='/projects/${workspace.project.id}/'+(deferTruth?'research?fromProduct=1':'truth');
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';button.disabled=false;}
});
const retry=document.querySelector('#retry-truth');
if(retry) retry.addEventListener('click',async()=>{
  retry.disabled=true; document.querySelector('#retry-error').textContent=''; retry.textContent='正在重新生成…';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/truth/generate-from-input',{method:'POST'});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.href='/projects/${workspace.project.id}/truth';
  }catch(err){document.querySelector('#retry-error').textContent=err.message||String(err);retry.disabled=false;retry.textContent='使用已保存资料重新生成产品事实';}
});
</script>`;
}

function renderTruth(
  workspace: ProjectWorkspace,
  productInput?: ProductInputSnapshot,
  artifacts: ArtifactRecord[] = []
): string {
  const truth = workspace.productTruth;
  if (!truth) {
    return `${projectHeader(workspace, "产品事实确认")}<section class="card"><h3>尚未生成产品事实</h3><p>当前没有可审核版本。</p><a class="secondary" href="/projects/${workspace.project.id}/product">返回产品输入</a></section>`;
  }
  const canonicalAsset = productInput?.assets.find(
    (item) => item.id === truth.canonicalImageId
  );
  const canonicalArtifact = canonicalAsset
    ? artifacts.find((item) => item.id === canonicalAsset.artifactId)
    : undefined;
  const awaitingClaims = truth.uncertainClaims.filter(claim =>
    truth.status === "DRAFT" && !claim.dispositionConfirmedByUser
  ).length;
  const awaitingRules = (truth.usageRules ?? []).filter(rule =>
    truth.status === "DRAFT" && !rule.dispositionConfirmedByUser
  ).length;
  const verifiedImage = canonicalArtifact?.integrityStatus === "READY" &&
    canonicalArtifact.mimeType?.startsWith("image/");
  const hasResearchCandidates = truth.uncertainClaims.some(item => item.sourceType === "research") ||
    (truth.usageRules ?? []).some(item => item.sourceType === "research");
  const claimRows = truth.uncertainClaims.length
    ? truth.uncertainClaims.map(c=>`<li><b>${claimStatusLabel[c.status]}</b> · ${esc(c.statement)}<br><span class="muted">${esc(c.reason)}</span>${c.sourceType==="research"?`<br><span class="status">研究证据</span> <a href="/projects/${workspace.project.id}/research">查看来源</a>`:""}<span class="technical"> · ${esc(c.status)}${c.evidenceRefs?.length?` · evidence=${esc(c.evidenceRefs.join(","))}`:""}</span>${truth.status==="DRAFT"&&!c.dispositionConfirmedByUser?`<div><select class="claim-disposition" data-claim-id="${esc(c.id)}"><option value="KEEP_UNVERIFIED">保留为未验证</option><option value="REJECT">拒绝</option><option value="PROMOTE">提升为事实（用户明确确认）</option></select></div>`:truth.status==="DRAFT"?`<div class="muted">已在上一轮产品事实审核中处理，本轮无需重复确认。</div>`:""}</li>`).join("")
    : "<li>无不确定信息</li>";
  const usageRuleRows = (truth.usageRules ?? []).length
    ? (truth.usageRules ?? []).map(rule=>`<li><b>${rule.status==="CONFIRMED"?"已确认硬约束":rule.status==="REJECTED"?"已拒绝":"未验证"}</b> · ${esc(usageRuleCategoryLabel[rule.category])} · ${esc(rule.statement)}<br><span class="muted">${esc(usageRulePolarityLabel[rule.polarity])} · 置信度：${esc(confidenceLabel[rule.confidence])}</span>${rule.sourceType==="research"?`<br><span class="status">研究证据</span> <a href="/projects/${workspace.project.id}/research">查看来源</a>`:""}<span class="technical"> · ${esc(rule.status)}${rule.evidenceRefs?.length?` · evidence=${esc(rule.evidenceRefs.join(","))}`:""}</span>${truth.status==="DRAFT"&&!rule.dispositionConfirmedByUser?`<div><select class="usage-rule-disposition" data-rule-id="${esc(rule.id)}"><option value="KEEP_UNVERIFIED">保留为未验证</option><option value="REJECT">拒绝规则</option><option value="CONFIRM">确认并作为后续硬约束</option></select></div>`:truth.status==="DRAFT"?`<div class="muted">已在上一轮产品事实审核中处理，本轮无需重复确认。</div>`:""}</li>`).join("")
    : "<li>当前没有产品使用规则。</li>";
  const action = truth.status === "DRAFT"
    ? `<button class="primary" id="confirm-truth">确认产品事实并继续当前任务</button><span id="truth-progress" class="muted"></span><div id="truth-error" class="danger"></div>
<script>
document.querySelector('#confirm-truth').addEventListener('click',async()=>{
  const button=document.querySelector('#confirm-truth'), progress=document.querySelector('#truth-progress'), error=document.querySelector('#truth-error');
  button.disabled=true; error.textContent=''; progress.textContent=' 正在确认产品事实，随后返回当前制作任务…';
  try{
    const dispositions={};
    document.querySelectorAll('.claim-disposition').forEach(el=>{dispositions[el.dataset.claimId]=el.value;});
    const usageRuleDispositions={};
    document.querySelectorAll('.usage-rule-disposition').forEach(el=>{usageRuleDispositions[el.dataset.ruleId]=el.value;});
    const r=await fetch('/api/projects/${workspace.project.id}/truth/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'${workspace.project.id}',dispositions,usageRuleDispositions})});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    const currentRun=new URLSearchParams(location.search).get('fromSmartRun');
    location.href='/projects/${workspace.project.id}/smart'+(currentRun?'?activeRun='+encodeURIComponent(currentRun):'');
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';button.disabled=false;}
});
</script>`
    : `<a class="primary" href="/projects/${workspace.project.id}/smart">进入智能生成</a>`;
  return `${projectHeader(workspace, "产品事实确认")}
  <section class="card"><h3>产品事实审核 · ${versionStatusLabel[truth.status]}</h3><p><b>${esc(truth.productName)}</b> · ${esc(truth.brand ?? "无品牌")} · ${esc(truth.category ?? "未分类")}</p><p class="muted">版本 ${truth.version} · 待处理 ${awaitingClaims + awaitingRules} 项 · 研究引用：${hasResearchCandidates ? "包含待核查的研究候选" : "未引入研究候选或已跳过研究"}</p><p><a class="secondary" href="/projects/${encodeURIComponent(workspace.project.id)}/research">返回可选联网研究</a></p><details class="technical"><summary>展开技术版本信息</summary><p>${esc(truth.contentHash)}${truth.aiExecution ? " · 模型 "+esc(truth.aiExecution.modelId)+" / "+esc(truth.aiExecution.providerId) : ""}</p></details></section>
  <section class="card" id="truth-identity"><h3>产品身份基准</h3>
    <div style="display:grid;grid-template-columns:minmax(150px,280px) minmax(0,1fr);gap:16px;align-items:start">
      <div>
        ${verifiedImage && canonicalAsset
          ? `<img src="/api/artifacts/${encodeURIComponent(canonicalAsset.artifactId)}/content" alt="当前已保存的产品主图" loading="lazy" style="display:block;width:100%;height:auto;max-height:300px;object-fit:contain;background:#f5f7fa;border:1px solid #d6dce6;border-radius:10px">`
          : '<div style="padding:20px;background:#f7f8fa;border:1px solid #d9dfe5;border-radius:10px">当前主图不可预览，请检查素材状态</div>'}
      </div>
      <div>
        <p><b>当前主参考：</b>${esc(canonicalAsset?.originalFilename ?? "未解析")}</p>
        <p><b>素材状态：</b><span class="${canonicalArtifact?.integrityStatus==="READY"?"ok":"danger"}">${canonicalArtifact?.integrityStatus==="READY"?"可用":canonicalArtifact?.integrityStatus==="PENDING"?"处理中":canonicalArtifact?.integrityStatus==="MISSING"?"文件缺失":canonicalArtifact?.integrityStatus==="CORRUPT"?"文件损坏":"未知"}</span></p>
        <p><b>标准颜色：</b>${truth.standardColors.length ? esc(truth.standardColors.join(" / ")) : "未确认"}</p>
        <p class="muted">所有后续制作资产与视频中的产品外观必须遵循确认的主参考图。</p>
        <details class="technical"><summary>技术文件与校验信息</summary><p>产品参考：${esc(truth.canonicalImageId)}<br>素材：${esc(canonicalAsset?.artifactId ?? "UNKNOWN")}<br>文件校验：${esc(canonicalAsset?.sha256 ?? "UNKNOWN")}</p></details>
      </div>
    </div>
  </section>
  <div class="grid"><section class="card"><h3>已确认事实</h3><ul class="facts">${[...truth.confirmedFeatures,...truth.sellingPoints].map(f=>`<li><code class="technical">${esc(f.id)}</code> ${esc(f.statement)}</li>`).join("")||"<li>无</li>"}</ul></section>
  <section class="card"><h3>禁止修改项</h3><ul class="facts">${truth.forbiddenChanges.map(f=>`<li><b>${f.severity==="HARD"?"严格禁止修改":"尽量保持不变"}</b> · ${f.field==="logo"?"品牌标志":f.field==="color"?"颜色":f.field==="shape"?"形状":f.field==="packaging"?"包装":f.field==="text"?"文字":f.field==="model"?"型号":f.field==="proportion"?"比例":"其他"} · ${esc(f.description)}</li>`).join("")||"<li>无</li>"}</ul></section>
  <section class="card"><h3>待确认信息</h3><p class="muted">未验证的信息不会作为产品事实进入后续创作。</p><ul class="facts">${claimRows}</ul></section></div>
  <section class="card"><h3>产品使用规则</h3><p class="muted">确认后的规则会强制约束创意、脚本、导演分镜、生成提示词和生成前检查；例如佩戴位置、使用方法、防水/充电限制、功能作用和适用场景都不能被后续内容违反。</p><ul class="facts">${usageRuleRows}</ul></section>
  <section class="card"><h3>唯一下一步</h3>${action}</section>`;
}

function renderCreative(workspace: ProjectWorkspace): string {
  const batch = workspace.creativeBatch;
  if (!batch) {
    const canGenerate = workspace.productTruth?.status === "CONFIRMED";
    return `${projectHeader(workspace, "创意方案")}<section class="card"><h3>尚未生成创意方案</h3><p>必须先确认当前产品事实。</p><button class="primary" id="generate-creative" ${canGenerate?"":"disabled"}>生成 4–6 个创意</button><span id="creative-generate-progress" class="muted"></span><div id="creative-generate-error" class="danger"></div></section>
<script>
const cg=document.querySelector('#generate-creative');
if(cg) cg.addEventListener('click',async()=>{
 cg.disabled=true; document.querySelector('#creative-generate-progress').textContent=' 正在生成创意…';
 try{const r=await fetch('/api/projects/${workspace.project.id}/creative/generate',{method:'POST'});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}
 catch(err){document.querySelector('#creative-generate-error').textContent=err.message||String(err);document.querySelector('#creative-generate-progress').textContent='';cg.disabled=false;}
});
</script>`;
  }
  return `${projectHeader(workspace, "创意方案")}
  <section class="card"><h3>创意方案 v${batch.version}</h3>${batch.aiExecution ? `<p class="technical">模型：<b>${esc(batch.aiExecution.modelId)}</b></p>` : ""}<p class="hash">${esc(batch.contentHash)}${batch.aiExecution ? `<br>provider=${esc(batch.aiExecution.providerId)} · config=v${batch.aiExecution.configVersion}` : ""}</p><p class="muted">绑定产品事实：版本 ${batch.productTruthRef.version}</p><p class="technical hash">产品事实校验值：${esc(batch.productTruthRef.hash)}</p>${batch.referenceVideoProfileRef ? `<p class="muted">参考视频结构：v${batch.referenceVideoProfileRef.version}（仅学习结构/方法）</p>` : ""}
  <button class="secondary" id="regenerate-creative">重新生成全部创意</button><span id="regenerate-creative-progress" class="muted"></span><div id="regenerate-creative-error" class="danger"></div></section>
  <form id="creative-form"><div class="grid">${batch.concepts.map(c=>`<label class="card"><div><input type="radio" name="creative" value="${esc(c.id)}" ${workspace.project.selectedCreativeId===c.id?"checked":""}> <b>${esc(c.title)}</b></div><p>${esc(c.hook)}</p><p>${esc(c.coreSellingPoint)}</p><p class="muted">人群：${esc(c.targetAudience)} · 生成难度：${riskLabel[c.generationRisk]} · 目标 ${c.expectedDurationMs/1000}s</p><p class="hash">facts: ${esc(c.requiredFactIds.join(","))}</p></label>`).join("")}</div>
  <button class="primary">确认所选创意并生成脚本</button><span id="creative-error" class="danger"></span></form>
<script>
document.querySelector('#regenerate-creative').addEventListener('click',async()=>{
 const b=document.querySelector('#regenerate-creative'),p=document.querySelector('#regenerate-creative-progress'),e=document.querySelector('#regenerate-creative-error');
 b.disabled=true;e.textContent='';p.textContent=' 正在重新生成创意方案…';
 try{const r=await fetch('/api/projects/${workspace.project.id}/creative/generate',{method:'POST'});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}
 catch(err){e.textContent=err.message||String(err);p.textContent='';b.disabled=false;}
});
document.querySelector('#creative-form').addEventListener('submit',async(e)=>{
 e.preventDefault(); const f=new FormData(e.currentTarget); const id=f.get('creative');
 if(!id){document.querySelector('#creative-error').textContent='请选择一个创意';return;}
 const r=await fetch('/api/projects/${workspace.project.id}/creative/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({creativeId:id})});
 const j=await r.json(); if(!r.ok){document.querySelector('#creative-error').textContent=j.message||j.error;return;}
 location.href='/projects/${workspace.project.id}/script';
});
</script>`;
}

function renderScript(workspace: ProjectWorkspace): string {
  const script = workspace.script;
  if (!script) {
    const canGenerate = Boolean(
      workspace.project.selectedCreativeId &&
      workspace.productTruth?.status === "CONFIRMED" &&
      workspace.creativeBatch
    );
    return `${projectHeader(workspace, "脚本确认")}<section class="card"><h3>尚未生成脚本</h3><p>当前选择：${workspace.project.selectedCreativeId ? "已选择创意方案" : "尚未选择创意方案"}</p><button class="primary" id="generate-script" ${canGenerate?"":"disabled"}>生成脚本草稿</button><span id="script-generate-progress" class="muted"></span><div id="script-generate-error" class="danger"></div></section>
<script>
const sg=document.querySelector('#generate-script');
if(sg) sg.addEventListener('click',async()=>{
 sg.disabled=true; document.querySelector('#script-generate-progress').textContent=' 正在生成脚本…';
 try{const r=await fetch('/api/projects/${workspace.project.id}/script/generate',{method:'POST'});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}
 catch(err){document.querySelector('#script-generate-error').textContent=err.message||String(err);document.querySelector('#script-generate-progress').textContent='';sg.disabled=false;}
});
</script>`;
  }
  const beatPurposes = [
    "HOOK",
    "PAIN",
    "PRODUCT",
    "FEATURE",
    "PROOF",
    "RESULT",
    "CTA",
    "OTHER"
  ] as const;
  const revisionEditor = `<section class="card technical"><h3>高级：结构化编辑脚本</h3>
    <p class="muted">保存会创建新的脚本草稿版本，并使当前导演方案、生成提示词、生成前检查和确认记录失效；不会覆盖历史版本。</p>
    <form id="script-revise-form">
      ${script.beats
        .map(
          (beat) => `<div class="clip beat-editor" data-beat-id="${esc(beat.id)}">
            <div class="row">
              <label class="field">段落用途<select class="beat-purpose">${beatPurposes
                .map(
                  (purpose) =>
                    `<option value="${purpose}" ${purpose === beat.purpose ? "selected" : ""}>${purpose}</option>`
                )
                .join("")}</select></label>
              <label class="field">预计时长(ms)<input class="beat-duration" type="number" min="1" step="1" value="${beat.estimatedDurationMs}"></label>
            </div>
            <label class="field">段落文本<textarea class="beat-text">${esc(beat.text)}</textarea></label>
            <label class="field">产品事实编号（逗号分隔）<input class="beat-facts" value="${esc(beat.requiredFactIds.join(","))}"></label>
          </div>`
        )
        .join("")}
      <button class="secondary" type="submit">保存结构化修改为新版本</button>
      <span id="script-revise-progress" class="muted"></span>
      <div id="script-revise-error" class="danger"></div>
    </form>
  </section>
<script>
document.querySelector('#script-revise-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const button=e.currentTarget.querySelector('button[type="submit"]');
  const progress=document.querySelector('#script-revise-progress');
  const error=document.querySelector('#script-revise-error');
  button.disabled=true;error.textContent='';progress.textContent=' 正在验证并保存新脚本版本…';
  try{
    const beats=[...document.querySelectorAll('.beat-editor')].map((row)=>({
      id:row.dataset.beatId,
      purpose:row.querySelector('.beat-purpose').value,
      text:row.querySelector('.beat-text').value,
      estimatedDurationMs:Number(row.querySelector('.beat-duration').value),
      requiredFactIds:row.querySelector('.beat-facts').value.split(',').map(v=>v.trim()).filter(Boolean)
    }));
    const r=await fetch('/api/projects/${workspace.project.id}/script/revise',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({beats})
    });
    const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';button.disabled=false;}
});
</script>`;
  const action = script.status === "DRAFT"
    ? `<button class="primary" id="confirm-script">确认脚本并选择生成模型</button><span id="script-progress" class="muted"></span><div id="script-error" class="danger"></div>
<script>
document.querySelector('#confirm-script').addEventListener('click',async()=>{
 const b=document.querySelector('#confirm-script'),p=document.querySelector('#script-progress'),e=document.querySelector('#script-error');
 b.disabled=true;e.textContent='';p.textContent=' 正在确认脚本，随后选择导演目标模型…';
 try{const r=await fetch('/api/projects/${workspace.project.id}/script/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'${workspace.project.id}',confirmCurrent:true})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.href='/projects/${workspace.project.id}/director';}
 catch(err){e.textContent=err.message||String(err);p.textContent='';b.disabled=false;}
});
</script>`
    : `<a class="primary" href="/projects/${workspace.project.id}/director">继续导演分镜</a>`;
  return `${projectHeader(workspace, "脚本确认")}<section class="card"><h3>脚本 v${script.version} · ${versionStatusLabel[script.status]}</h3>${script.aiExecution ? `<p class="technical">模型：<b>${esc(script.aiExecution.modelId)}</b></p>` : ""}<p class="hash">${esc(script.contentHash)}${script.aiExecution ? `<br>provider=${esc(script.aiExecution.providerId)} · config=v${script.aiExecution.configVersion}` : ""}</p><p>目标时长：${script.targetDurationMs/1000}s</p>${script.referenceVideoProfileRef ? `<p class="muted">参考视频结构：v${script.referenceVideoProfileRef.version}（仅学习结构/方法）</p>` : ""}</section>
  <section class="card"><h3>脚本段落</h3>${script.beats.map(b=>`<div class="segment"><b>#${b.order} ${beatPurposeLabel[b.purpose]}</b><p>${esc(b.text)}</p><span class="muted">${b.estimatedDurationMs/1000}s</span><span class="technical"> · ${esc(b.purpose)} · facts: ${esc(b.requiredFactIds.join(","))}</span></div>`).join("")}</section>
  ${revisionEditor}
  <section class="card"><h3>唯一下一步</h3>${action}</section>`;
}

function renderDirector(
  workspace: ProjectWorkspace,
  compiledPrompts: CompiledPrompt[]
): string {
  const plan = workspace.productionPlan;
  const generationControls = renderDirectorGenerationControls({
    projectId: workspace.project.id,
    targetDurationMs: workspace.project.targetDurationMs,
    canGenerate: workspace.script?.status === "CONFIRMED",
    hasPlan: Boolean(plan),
    ...(plan?.generationTarget ? { target: plan.generationTarget } : {})
  });
  if (!plan) {
    return `${projectHeader(workspace, "导演分镜")}${generationControls}`;
  }
  const currentPrompts = compiledPrompts.filter(
    (prompt) =>
      prompt.status === "CURRENT" &&
      prompt.productionPlanRef.entityId === plan.id &&
      prompt.productionPlanRef.version === plan.version &&
      prompt.productionPlanRef.hash === plan.contentHash
  );
  const promptInspector = currentPrompts.length
    ? currentPrompts
        .map(
          (prompt) => `<details class="clip"><summary><b>Clip ${esc(prompt.clipId)}</b> · template=${esc(prompt.compilerTemplateVersion)}</summary>
            <p class="hash">compiledPromptHash=${esc(prompt.compiledPromptHash)}<br>
            truth=${esc(prompt.productTruthRef.hash)}<br>
            script=${esc(prompt.scriptRef.hash)}<br>
            plan=${esc(prompt.productionPlanRef.hash)}</p>
            <h4>实际提交给即梦的提示词（只读）</h4><pre>${esc(prompt.promptText)}</pre>
            <div class="technical"><h4>内部审计映射</h4>
            <p class="hash">auditContractHash=${esc(prompt.auditContractHash ?? "legacy")}</p>
            <h4>factMapping</h4><pre>${esc(JSON.stringify(prompt.factMapping, null, 2))}</pre>
            <h4>segmentMapping</h4><pre>${esc(JSON.stringify(prompt.segmentMapping, null, 2))}</pre>
            <h4>constraintMapping</h4><pre>${esc(JSON.stringify(prompt.constraintMapping, null, 2))}</pre></div>
          </details>`
        )
        .join("")
    : `<p class="muted">尚未编译生成提示词。进入视频生成并运行生成前检查后，这里会显示当前导演方案对应的只读提示词与映射。</p>`;

  const revisionEditor = `<section class="card technical"><h3>高级：编辑导演分镜计划</h3>
    <p class="muted">保存会创建新的导演方案草稿版本，并使生成提示词、生成请求、生成前检查和确认记录失效；历史版本保留。</p>
    <form id="plan-revise-form">
      <div class="row">
        <label class="field">视觉方向<textarea id="plan-visual-direction">${esc(plan.visualDirection)}</textarea></label>
        <label class="field">声音方向<textarea id="plan-sound-direction">${esc(plan.soundDirection)}</textarea></label>
      </div>
      <label class="field">产品展示规则（每行一条）<textarea id="plan-showcase-rules">${esc(plan.productShowcaseRules.join("\n"))}</textarea></label>
      ${plan.scenes
        .flatMap((scene) =>
          scene.clips.flatMap((clip) =>
            clip.segments.map((segment) => {
              const audio = segment.dialogueOrNarration;
              const ambient = segment.ambientSound;
              return `<details class="clip segment-editor" data-segment-id="${esc(segment.id)}">
                <summary><b>Scene ${scene.order} / Clip ${clip.order} / Segment ${segment.order}</b> · ${segment.startMs}-${segment.endMs}ms</summary>
                <div class="row">
                  <label class="field">startMs<input class="seg-start" type="number" step="1" value="${segment.startMs}"></label>
                  <label class="field">endMs<input class="seg-end" type="number" step="1" value="${segment.endMs}"></label>
                  <label class="field">景别<input class="seg-shot-size" value="${esc(segment.shotSize)}"></label>
                  <label class="field">机位<input class="seg-camera-position" value="${esc(segment.cameraPosition)}"></label>
                  <label class="field">角度<input class="seg-camera-angle" value="${esc(segment.cameraAngle)}"></label>
                  <label class="field">运镜<input class="seg-camera-movement" value="${esc(segment.cameraMovement)}"></label>
                </div>
                <label class="field">构图<input class="seg-composition" value="${esc(segment.composition)}"></label>
                <label class="field">主体动作<textarea class="seg-subject-action">${esc(segment.subjectAction)}</textarea></label>
                <label class="field">产品状态<textarea class="seg-product-state">${esc(segment.productState)}</textarea></label>
                <label class="field">灯光<input class="seg-lighting" value="${esc(segment.lighting)}"></label>
                <div class="row">
                  <label class="field">对白/旁白类型<select class="seg-audio-kind">
                    ${["NONE","DIALOGUE","NARRATION"].map(kind=>`<option value="${kind}" ${audio.kind===kind?"selected":""}>${kind}</option>`).join("")}
                  </select></label>
                  <label class="field">对白/旁白文本<input class="seg-audio-text" value="${esc(audio.kind==="NONE"?"":audio.text)}"></label>
                  <label class="field">语音估时(ms)<input class="seg-audio-duration" type="number" min="1" step="1" value="${audio.kind==="NONE"?"":audio.estimatedDurationMs}" data-estimator="${esc(audio.kind==="NONE"?"p0-ui-v1":audio.estimatorVersion)}"></label>
                  <label class="field">环境音类型<select class="seg-ambient-kind">
                    <option value="NONE" ${ambient.kind==="NONE"?"selected":""}>NONE</option>
                    <option value="AMBIENT" ${ambient.kind==="AMBIENT"?"selected":""}>AMBIENT</option>
                  </select></label>
                  <label class="field">环境音描述<input class="seg-ambient-description" value="${esc(ambient.kind==="NONE"?"":ambient.description)}"></label>
                </div>
                <h4>Continuity In</h4>
                <div class="row">
                  <label class="field">描述<input class="seg-ci-description" value="${esc(segment.continuityIn.description)}"></label>
                  <label class="field">产品状态<input class="seg-ci-product" value="${esc(segment.continuityIn.productState)}"></label>
                  <label class="field">环境状态<input class="seg-ci-environment" value="${esc(segment.continuityIn.environmentState)}"></label>
                </div>
                <h4>Continuity Out</h4>
                <div class="row">
                  <label class="field">描述<input class="seg-co-description" value="${esc(segment.continuityOut.description)}"></label>
                  <label class="field">产品状态<input class="seg-co-product" value="${esc(segment.continuityOut.productState)}"></label>
                  <label class="field">环境状态<input class="seg-co-environment" value="${esc(segment.continuityOut.environmentState)}"></label>
                </div>
              </details>`;
            })
          )
        )
        .join("")}
      <button class="secondary" type="submit">保存结构化修改为新版本</button>
      <span id="plan-revise-progress" class="muted"></span>
      <div id="plan-revise-error" class="danger"></div>
    </form>
  </section>
<script>
document.querySelector('#plan-revise-form').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const button=e.currentTarget.querySelector('button[type="submit"]');
  const progress=document.querySelector('#plan-revise-progress');
  const error=document.querySelector('#plan-revise-error');
  button.disabled=true;error.textContent='';progress.textContent=' 正在验证并保存新导演方案版本…';
  try{
    const segments=[...document.querySelectorAll('.segment-editor')].map((row)=>{
      const audioKind=row.querySelector('.seg-audio-kind').value;
      const ambientKind=row.querySelector('.seg-ambient-kind').value;
      return {
        id:row.dataset.segmentId,
        startMs:Number(row.querySelector('.seg-start').value),
        endMs:Number(row.querySelector('.seg-end').value),
        shotSize:row.querySelector('.seg-shot-size').value,
        cameraPosition:row.querySelector('.seg-camera-position').value,
        cameraAngle:row.querySelector('.seg-camera-angle').value,
        cameraMovement:row.querySelector('.seg-camera-movement').value,
        composition:row.querySelector('.seg-composition').value,
        subjectAction:row.querySelector('.seg-subject-action').value,
        productState:row.querySelector('.seg-product-state').value,
        lighting:row.querySelector('.seg-lighting').value,
        dialogueOrNarration:audioKind==='NONE'
          ? {kind:'NONE'}
          : {
              kind:audioKind,
              text:row.querySelector('.seg-audio-text').value,
              estimatedDurationMs:Number(row.querySelector('.seg-audio-duration').value),
              estimatorVersion:row.querySelector('.seg-audio-duration').dataset.estimator||'p0-ui-v1'
            },
        ambientSound:ambientKind==='NONE'
          ? {kind:'NONE'}
          : {kind:'AMBIENT',description:row.querySelector('.seg-ambient-description').value},
        continuityIn:{
          description:row.querySelector('.seg-ci-description').value,
          productState:row.querySelector('.seg-ci-product').value,
          environmentState:row.querySelector('.seg-ci-environment').value
        },
        continuityOut:{
          description:row.querySelector('.seg-co-description').value,
          productState:row.querySelector('.seg-co-product').value,
          environmentState:row.querySelector('.seg-co-environment').value
        }
      };
    });
    const payload={
      visualDirection:document.querySelector('#plan-visual-direction').value,
      soundDirection:document.querySelector('#plan-sound-direction').value,
      productShowcaseRules:document.querySelector('#plan-showcase-rules').value.split('\\n').map(v=>v.trim()).filter(Boolean),
      segments
    };
    const r=await fetch('/api/projects/${workspace.project.id}/production-plan/revise',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)
    });
    const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';button.disabled=false;}
});
</script>`;

  const action = plan.status === "DRAFT"
    ? `<button class="primary" id="confirm-plan">确认导演分镜并进入生成前检查</button><span id="plan-progress" class="muted"></span><div id="plan-error" class="danger"></div>
<script>
document.querySelector('#confirm-plan').addEventListener('click',async()=>{
 const b=document.querySelector('#confirm-plan'),p=document.querySelector('#plan-progress'),e=document.querySelector('#plan-error');
 b.disabled=true;e.textContent='';p.textContent=' 正在确认计划…';
 try{const r=await fetch('/api/projects/${workspace.project.id}/production-plan/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'${workspace.project.id}',confirmCurrent:true})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.href='/projects/${workspace.project.id}/generate';}
 catch(err){e.textContent=err.message||String(err);p.textContent='';b.disabled=false;}
});
</script>`
    : `<a class="primary" href="/projects/${workspace.project.id}/generate">进入视频生成</a>`;
  return `${projectHeader(workspace, "导演分镜")}<section class="card"><h3>导演分镜计划 v${plan.version} · ${versionStatusLabel[plan.status]}</h3>${plan.aiExecution ? `<p class="technical">模型：<b>${esc(plan.aiExecution.modelId)}</b></p>` : ""}<p class="hash">${esc(plan.contentHash)}${plan.aiExecution ? `<br>provider=${esc(plan.aiExecution.providerId)} · config=v${plan.aiExecution.configVersion}` : ""}</p><p>${esc(plan.visualDirection)}</p><p class="muted">声音方向：${esc(plan.soundDirection)}</p>${plan.referenceVideoProfileRef ? `<p class="muted">参考视频结构：v${plan.referenceVideoProfileRef.version}（仅学习结构/方法）</p>` : ""}</section>
  ${plan.scenes.map(scene=>`<section class="card scene"><h3>场景 ${scene.order} · ${esc(scene.purpose)}</h3><p class="technical">Beat: ${esc(scene.sourceBeatIds.join(","))} · Facts: ${esc(scene.requiredFactIds.join(","))}</p>${scene.clips.map(clip=>`<div class="clip"><b>镜头 ${clip.order} · ${clip.durationMs/1000}s · ${clipStatusLabel[clip.aggregateStatus]}</b><p>产品展示：${productVisibilityLabel[clip.productVisibility]}</p><p class="muted">生成风险：${riskLabel[clip.riskAssessment.level]} · 镜头内分段：${clip.segments.length}</p><p class="technical">clip=${esc(clip.id)} · strictIdentity=${clip.strictProductIdentity}</p>${clip.segments.map(s=>`<div class="segment">${s.startMs/1000}–${s.endMs/1000}s · ${esc(s.shotSize)} · ${esc(s.cameraPosition)} · ${esc(s.cameraMovement)}<br>${esc(s.subjectAction)}<br><span class="technical">audio=${esc(s.dialogueOrNarration.kind)} · ambient=${esc(s.ambientSound.kind)} · facts=${esc(s.requiredFactIds.join(","))}</span></div>`).join("")}</div>`).join("")}</section>`).join("")}
  ${revisionEditor}
  ${generationControls}
  <section class="card technical"><h3>高级：生成提示检查（只读）</h3><p class="muted">已编译的生成提示词不允许直接编辑；需要修改时请回到导演方案，再重新编译。</p>${promptInspector}</section>
  <section class="card"><h3>唯一下一步</h3>${action}</section>`;
}

function renderGenerate(
  workspace: ProjectWorkspace,
  blockers: WorkflowBlocker[],
  attempts: GenerationAttempt[],
  generationRequests: GenerationRequest[],
  preflights: PreflightReport[],
  approvals: UserApproval[],
  artifacts: ArtifactRecord[],
  reviewDecisions: ReviewDecision[],
  commandAttempts: Array<
    CommandAttemptRecord & {
      generationAttemptId?: string;
      argvRedacted?: string[];
    }
  >,
  probe: ProviderProbeResult
): string {
  const activeReports = preflights.filter((item) => item.status !== "STALE");
  const hasUnknownSubmission = attempts.some(
    (item) =>
      item.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
      item.status === "RECONCILING"
  );
  const requestById = new Map(generationRequests.map((item) => [item.id, item]));
  const blockedCount = activeReports.filter((item) => item.status === "BLOCKED").length;
  const passCount = activeReports.filter((item) => item.status === "PASS").length;
  const preflightCards = activeReports.length
    ? activeReports.map((report) => {
        const request = requestById.get(report.generationRequestId);
        const profile = request?.generationProfile;
        return `<div class="clip"><b>${esc(preflightStatusLabel[report.status])} · 镜头 ${esc(request?.clipId ?? "未知镜头")}</b>
          <span class="technical">${esc(report.status)}</span>
          <p class="hash">request=${esc(report.requestHash)}<br>preflight=${esc(report.reportHash)}</p>
          <p>时长：${report.totalGeneratedMs/1000}s · 成本信息：${report.costEstimate.status==="KNOWN"?"已获取":"暂无法确定"}</p>
          ${request ? `<p>生成命令：<b>${esc(request.dreaminaOperation ?? "旧式生成")}</b> · 用户/请求模型：<b>${esc(request.model)}</b> · CLI model_version / 固定模型：<b>${esc(profile?.modelVersion ?? profile?.fixedModelLabel ?? request.model)}</b></p>
          <p>画幅：${esc(request.aspectRatio)} · 分辨率：${esc(profile?.videoResolution ?? request.videoResolution ?? "未记录")} · 原生声音：${profile?.nativeAudioOutputRequested ? "已请求" : "未请求"}${profile ? ` · 命令支持：${profile.nativeAudioOutputSupported ? "是" : "否"}` : ""}</p>` : ""}
          ${report.blockers.length?`<p class="danger">发现需要处理的问题，请查看下方“需要处理的问题”。</p><p class="technical">blockers: ${esc(report.blockers.join(", "))}</p>`:"<p class=\"ok\">检查通过</p>"}
          ${report.warnings.length?`<p class="muted">提示：${esc(report.warnings.join(", "))}</p>`:""}
        </div>`;
      }).join("")
    : "<p>尚未运行生成前检查。</p>";
  const actionLabel = activeReports.length ? "重新检查" : "开始生成前检查";
  const activeApprovals = approvals.filter((item) => item.status === "ACTIVE");
  const allPass =
    activeReports.length > 0 &&
    passCount === activeReports.length &&
    blockedCount === 0;
  const approvalSummary = allPass
    ? `<div class="card"><p class="ok">生成前检查全部通过。当前有效授权：${activeApprovals.length}。</p>
       ${activeApprovals.length
         ? "<p class=\"muted\">生成授权已创建；每次授权只对应一次真实视频生成。</p>"
         : `<label><input type="checkbox" id="accept-unknown-cost"> 我理解当前无法确定准确成本/积分，仍授权本次生成</label>
            ${hasUnknownSubmission
              ? `<p class="danger"><b>重复扣费风险：</b>仍有提交结果未知或正在恢复的生成任务。创建新生成任务可能导致重复生成或重复扣费。</p>
                 <label><input type="checkbox" id="accept-duplicate-approval-risk"> 我明确接受可能重复扣费，并授权创建新的生成确认与生成任务</label>`
              : ""}
            <p><button class="primary" id="create-approval">确认本次生成</button></p>
            <div id="approval-error" class="danger"></div>`}
       </div>`
    : "";

  const artifactById = new Map(artifacts.map((item) => [item.id, item]));
  const currentClips = (workspace.productionPlan?.scenes ?? []).flatMap(
    (scene) => scene.clips
  );
  const requiredGenerationOperations = [
    ...new Set(
      currentClips.map((clip) =>
        clip.referenceAssets.length > 0
          ? ("multimodal2video" as const)
          : ("text2video" as const)
      )
    )
  ];
  const latestProfileRequest = [...generationRequests]
    .filter((item) => Boolean(item.generationProfile))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestProfile = latestProfileRequest?.generationProfile;
  const directorTarget = workspace.productionPlan?.generationTarget;
  const standardGenerationDefaults = {
    requiredOperations: requiredGenerationOperations,
    boundToDirector: Boolean(directorTarget),
    model:
      directorTarget?.requestedModelVersion ??
      latestProfile?.requestedModelVersion ??
      latestProfile?.modelVersion ??
      "AUTO",
    aspectRatio: directorTarget?.aspectRatio ?? latestProfile?.aspectRatio ?? "AUTO",
    videoResolution: directorTarget?.videoResolution ?? latestProfile?.videoResolution ?? "720p",
    nativeAudioOutputRequested:
      directorTarget?.nativeAudioOutputRequested ?? latestProfile?.nativeAudioOutputRequested ?? true
  };
  const clipHashById = new Map(
    currentClips.map((clip) => [clip.id, clip.contentHash] as const)
  );
  const latestUsageDecisionByClip = new Map<string, ReviewDecision>();
  for (const clip of currentClips) {
    const latest = reviewDecisions
      .filter(
        (decision) =>
          decision.clipId === clip.id &&
          decision.clipHash === clip.contentHash &&
          (decision.decision === "SKIP" || decision.decision === "USE")
      )
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
    if (latest) latestUsageDecisionByClip.set(clip.id, latest);
  }
  const latestSuccessfulAttemptByClip = new Map<string, GenerationAttempt>();
  for (const attempt of attempts) {
    if (
      attempt.status !== "SUCCEEDED" &&
      attempt.status !== "RECONCILED_SUCCEEDED"
    ) {
      continue;
    }
    const existing = latestSuccessfulAttemptByClip.get(attempt.clipId);
    if (!existing || attempt.attemptNumber > existing.attemptNumber) {
      latestSuccessfulAttemptByClip.set(attempt.clipId, attempt);
    }
  }
  const acceptedClipIds = new Set<string>();
  const skippedClipIds = new Set<string>();
  for (const clip of currentClips) {
    if (latestUsageDecisionByClip.get(clip.id)?.decision === "SKIP") {
      skippedClipIds.add(clip.id);
      continue;
    }
    const attempt = latestSuccessfulAttemptByClip.get(clip.id);
    const output = attempt?.outputArtifactId
      ? artifactById.get(attempt.outputArtifactId)
      : undefined;
    if (!attempt || !output?.sha256 || output.integrityStatus !== "READY") {
      continue;
    }
    const latestReview = reviewDecisions
      .filter(
        (decision) =>
          decision.clipId === clip.id &&
          decision.clipHash === clip.contentHash &&
          decision.generationAttemptId === attempt.id &&
          decision.outputArtifactId === output.id &&
          decision.outputArtifactHash === output.sha256 &&
          (decision.decision === "ACCEPT" || decision.decision === "REDO" || decision.decision === "STALE")
      )
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
    if (latestReview?.decision === "ACCEPT") acceptedClipIds.add(clip.id);
  }
  const plannedDurationMs = currentClips.reduce(
    (total, clip) => total + clip.durationMs,
    0
  );
  const generatedDurationMs = currentClips.reduce((total, clip) => {
    const attempt = latestSuccessfulAttemptByClip.get(clip.id);
    const output = attempt?.outputArtifactId
      ? artifactById.get(attempt.outputArtifactId)
      : undefined;
    return output?.integrityStatus === "READY"
      ? total + clip.durationMs
      : total;
  }, 0);
  const acceptedDurationMs = currentClips.reduce(
    (total, clip) =>
      acceptedClipIds.has(clip.id) ? total + clip.durationMs : total,
    0
  );
  const pendingClipCount = Math.max(
    0,
    currentClips.length - acceptedClipIds.size - skippedClipIds.size
  );
  const clipSelectionHtml = currentClips.length
    ? currentClips
        .map((clip, index) => {
          const skipped = skippedClipIds.has(clip.id);
          const accepted = acceptedClipIds.has(clip.id);
          const latestAttempt = attempts
            .filter((attempt) => attempt.clipId === clip.id)
            .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
          const state = skipped
            ? "已跳过"
            : accepted
              ? "已接受"
              : latestAttempt
                ? attemptStatusLabel[latestAttempt.status]
                : "未生成";
          const action = skipped
            ? `<button class="secondary clip-usage-action" data-clip="${esc(clip.id)}" data-decision="USE">恢复此镜头</button>`
            : `<button class="secondary clip-usage-action" data-clip="${esc(clip.id)}" data-decision="SKIP">跳过此镜头</button>`;
          return `<div class="clip"><b>镜头 ${index + 1} · ${esc(state)}</b>
            <p class="hash">${esc(clip.id)} · ${(clip.durationMs / 1000).toFixed(1)}s</p>
            <p>${accepted ? '<span class="ok">已纳入当前成片</span>' : skipped ? '<span class="muted">不纳入当前成片，也不要求生成</span>' : '<span class="muted">尚未决定是否采用</span>'} ${action}</p>
          </div>`;
        })
        .join("")
    : "<p>当前计划没有镜头。</p>";
  const commandsByAttempt = new Map<string, typeof commandAttempts>();
  for (const command of commandAttempts) {
    if (!command.generationAttemptId) continue;
    const list = commandsByAttempt.get(command.generationAttemptId) ?? [];
    list.push(command);
    commandsByAttempt.set(command.generationAttemptId, list);
  }
  const clipOrderById = new Map(
    currentClips.map((clip, index) => [clip.id, index] as const)
  );
  const currentPlanAttempts = attempts
    .filter((attempt) => clipOrderById.has(attempt.clipId))
    .sort((a, b) => {
      const clipDelta =
        clipOrderById.get(a.clipId)! - clipOrderById.get(b.clipId)!;
      return clipDelta || b.attemptNumber - a.attemptNumber;
    });
  const latestAttemptNumberByClip = new Map<string, number>();
  for (const attempt of currentPlanAttempts) {
    const latest = latestAttemptNumberByClip.get(attempt.clipId) ?? 0;
    if (attempt.attemptNumber > latest) {
      latestAttemptNumberByClip.set(attempt.clipId, attempt.attemptNumber);
    }
  }
  const supersededCreatedAttempts = currentPlanAttempts.filter(
    (attempt) =>
      attempt.status === "CREATED" &&
      attempt.attemptNumber <
        (latestAttemptNumberByClip.get(attempt.clipId) ?? attempt.attemptNumber)
  );
  const supersededCreatedAttemptIds = new Set(
    supersededCreatedAttempts.map((attempt) => attempt.id)
  );
  const visibleCurrentPlanAttempts = currentPlanAttempts.filter(
    (attempt) => !supersededCreatedAttemptIds.has(attempt.id)
  );
  const historicalAttempts = attempts
    .filter((attempt) => !clipOrderById.has(attempt.clipId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const renderAttemptCard = (
    attempt: GenerationAttempt,
    historical = false,
    superseded = false
  ): string => {
    const clipIndex = clipOrderById.get(attempt.clipId);
    const isSkipped = skippedClipIds.has(attempt.clipId);
    const output = attempt.outputArtifactId
      ? artifactById.get(attempt.outputArtifactId)
      : undefined;
    const currentClipHash = clipHashById.get(attempt.clipId);
    const matchingReviews = reviewDecisions
      .filter(
        (decision) =>
          decision.generationAttemptId === attempt.id &&
          decision.clipId === attempt.clipId &&
          decision.clipHash === currentClipHash &&
          decision.outputArtifactId === output?.id &&
          decision.outputArtifactHash === output?.sha256
      )
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    const latestReview = matchingReviews[0];
    const comparableVersions = currentPlanAttempts.filter(candidate => {
      if (
        candidate.clipId !== attempt.clipId ||
        !["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(candidate.status) ||
        !candidate.outputArtifactId
      ) return false;
      const artifact = artifactById.get(candidate.outputArtifactId);
      return Boolean(
        artifact?.integrityStatus === "READY" &&
        artifact.kind === "GENERATED_VIDEO" &&
        artifact.sha256
      );
    });
    const visualCompareControl =
      !historical &&
      !superseded &&
      !isSkipped &&
      comparableVersions.length >= 2 &&
      attempt.attemptNumber === latestAttemptNumberByClip.get(attempt.clipId)
        ? `<div class="card visual-version-compare">
            <h4>AI 多版本比较</h4>
            <p class="muted">当前镜头有 ${comparableVersions.length} 个成功版本。系统会逐个对照已确认产品主图和使用规则，比较产品稳定性、动作完整性、明显穿帮以及固定时长最佳区间。只给建议，不自动回退历史版本、不重新付费。</p>
            <button class="secondary visual-compare-action" data-clip="${esc(attempt.clipId)}">比较最近 ${Math.min(6, comparableVersions.length)} 个版本</button>
            <div class="visual-compare-result muted" role="status"></div>
          </div>`
        : "";
    const usedResearch = generationRequests.find(r=>r.id===attempt.generationRequestId)?.assetManifest.filter(a=>a.researchReference)??[];
    const researchHtml = usedResearch.length?`<details><summary>本次使用的研究参考（${usedResearch.length}）</summary>${usedResearch.map(a=>`<p>${esc(({PRODUCT_ANGLE:"产品外观 / 多角度",WEARING_REFERENCE:"佩戴参考",USAGE_ACTION_REFERENCE:"使用动作",SCENE_REFERENCE:"场景参考",LOGO_REFERENCE:"包装 / 标志参考"} as Record<string,string>)[a.role]??a.role)} · <a href="${esc(a.researchReference!.sourceUrl)}" target="_blank" rel="noopener noreferrer">来源网页</a>${a.researchReference!.timestampMs===undefined?"":" · 视频定位目标 "+(a.researchReference!.timestampMs!/1000).toFixed(2)+" 秒"}</p>`).join("")}</details>`:"";
    const actions: string[] = [];
    if (!historical && !superseded && !isSkipped && attempt.status === "CREATED") {
      actions.push(`<button class="primary attempt-action" data-attempt="${esc(attempt.id)}" data-action="submit">提交此镜头生成</button>`);
    }
    if (
      !historical &&
      !isSkipped &&
      (attempt.status === "SUBMITTED" || attempt.status === "PROCESSING")
    ) {
      actions.push(`<button class="secondary attempt-action" data-attempt="${esc(attempt.id)}" data-action="poll">刷新状态</button>`);
    }
    if (
      !historical &&
      !isSkipped &&
      (attempt.status === "SUCCEEDED" ||
        attempt.status === "RECONCILED_SUCCEEDED") &&
      !output
    ) {
      actions.push(`<button class="primary attempt-action" data-attempt="${esc(attempt.id)}" data-action="download">下载结果</button>`);
    }
    if (
      !historical &&
      !isSkipped &&
      (attempt.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
        attempt.status === "RECONCILING")
    ) {
      actions.push(`<button class="primary attempt-action" data-attempt="${esc(attempt.id)}" data-action="reconcile">调和提交结果</button>`);
    }
    const reviewControls =
      !historical &&
      !isSkipped &&
      output?.integrityStatus === "READY" &&
      output.kind === "GENERATED_VIDEO" &&
      (attempt.status === "SUCCEEDED" ||
        attempt.status === "RECONCILED_SUCCEEDED")
        ? `<div class="card">
            <video controls preload="metadata" style="width:100%;max-height:520px" src="/api/artifacts/${esc(output.id)}/content"></video>
            <p class="hash">video=${esc(output.id)} · sha256=${esc(output.sha256 ?? "UNKNOWN")}</p>
            ${latestReview
              ? `<p>最新审片：<b>${latestReview.source === "AI_VISUAL_GATE" ? "视觉 AI 高置信自动采用" : latestReview.decision === "ACCEPT" ? "采用" : latestReview.decision === "REDO" ? "重新生成" : latestReview.decision === "STALE" ? "因上游镜头重做需重新审核" : esc(latestReview.decision)}</b> · ${esc(latestReview.decidedAt)}</p>${latestReview.source === "AI_VISUAL_GATE" ? '<p class="muted">此结果来自用户在一键成片任务中预先启用的视觉门禁；不代表用户逐镜头手工点击采用。</p>' : ""}`
              : `<p><button class="primary review-action" data-attempt="${esc(attempt.id)}" data-clip="${esc(attempt.clipId)}" data-decision="ACCEPT">接受此结果</button>
                 <button class="secondary review-action" data-attempt="${esc(attempt.id)}" data-clip="${esc(attempt.clipId)}" data-decision="REDO">重新生成此镜头</button></p>`}
          </div>`
        : "";
    const redoControl =
      !historical && !isSkipped && latestReview?.decision === "REDO"
        ? `<p><button class="primary redo-preflight" data-clip="${esc(attempt.clipId)}">为此镜头重新运行生成前检查</button></p>`
        : "";
    const commands = commandsByAttempt.get(attempt.id) ?? [];
    const commandHtml = commands.length
      ? `<details><summary>命令审计（${commands.length}）</summary>${commands
          .map(
            (command) =>
              `<p class="hash">${esc(command.operation)} #${command.attemptNumber} · exit=${esc(command.exitCode ?? "pending")} · timeout=${command.timedOut}<br>argv=${esc((command.argvRedacted ?? []).join(" "))}<br>parser=${esc(command.parserVersion)} · redaction=${esc(command.redactionRulesVersion)}</p>`
          )
          .join("")}</details>`
      : "";
    const label = historical
      ? `旧计划 · 第 ${attempt.attemptNumber} 次`
      : superseded
        ? `镜头 ${(clipIndex ?? 0) + 1} · 第 ${attempt.attemptNumber} 次 · 已被替代`
        : `镜头 ${(clipIndex ?? 0) + 1} · 第 ${attempt.attemptNumber} 次`;
    const legacyLabel = historical
      ? `旧计划 · #${attempt.attemptNumber} · ${attempt.status}`
      : `Clip ${(clipIndex ?? 0) + 1} · Attempt #${attempt.attemptNumber} · ${attempt.status}${superseded ? " · SUPERSEDED" : ""}`;
    return `<div class="clip"><b>${label} · ${esc(attemptStatusLabel[attempt.status])}</b>
      <span class="technical">${esc(legacyLabel)}</span>
      <p class="hash">clip=${esc(attempt.clipId)}<br>attempt=${esc(attempt.id)}<br>request=${esc(attempt.requestHash)}<br>approval=${esc(attempt.approvalHash)}</p>
      ${attempt.providerHandle?.externalTaskId ? `<p class="technical">task=${esc(attempt.providerHandle.externalTaskId)}</p>` : ""}
      ${historical ? `<p class="muted">此记录不属于当前导演方案，仅保留为历史记录。</p>` : ""}
      ${superseded ? `<p class="muted">此待提交记录已被该镜头更新的一次尝试替代，仅保留审计，不能再提交。</p>` : ""}
      ${isSkipped ? `<p class="muted">此镜头已标记为跳过，不参与当前成片。${attempt.status === "SUBMITTED" || attempt.status === "PROCESSING" ? " 已提交的远端任务可能仍会继续完成。" : ""}</p>` : ""}
      ${attempt.errorMessage ? `<p class="danger">${esc(attempt.errorMessage)}</p><p class="technical">${esc(attempt.errorCode ?? "ERROR")}</p>` : ""}
      <p>${actions.join(" ")}</p>
      ${commandHtml}
      ${researchHtml}
      ${visualCompareControl}
      ${reviewControls}
      ${redoControl}
    </div>`;
  };

  const attemptCards = visibleCurrentPlanAttempts.length
    ? visibleCurrentPlanAttempts.map((attempt) => renderAttemptCard(attempt)).join("")
    : "<p>当前导演计划还没有视频生成记录。</p>";
  const supersededAttemptCards = supersededCreatedAttempts.length
    ? `<details><summary>同镜头已被替代的待提交记录（${supersededCreatedAttempts.length}）</summary>${supersededCreatedAttempts
        .map((attempt) => renderAttemptCard(attempt, false, true))
        .join("")}</details>`
    : "";
  const historicalAttemptCards = historicalAttempts.length
    ? `<details><summary>历史/旧计划生成记录（${historicalAttempts.length}）</summary><span class="technical">历史/旧计划生成任务（${historicalAttempts.length}）</span>${historicalAttempts
        .map((attempt) => renderAttemptCard(attempt, true))
        .join("")}</details>`
    : "";

  const autoPollAttemptIds = currentPlanAttempts
    .filter(
      (attempt) =>
        !skippedClipIds.has(attempt.clipId) &&
        (attempt.status === "SUBMITTED" || attempt.status === "PROCESSING")
    )
    .map((attempt) => attempt.id);
  const autoDownloadAttemptIds = currentPlanAttempts
    .filter(
      (attempt) =>
        !skippedClipIds.has(attempt.clipId) &&
        (attempt.status === "SUCCEEDED" ||
          attempt.status === "RECONCILED_SUCCEEDED") &&
        !attempt.outputArtifactId
    )
    .map((attempt) => attempt.id);

  return `${projectHeader(workspace, "视频生成")}
  <section class="card"><h3>即梦生成服务</h3>
    <p>连接状态：<b class="${probe.code==="READY"?"ok":"danger"}">${probe.code === "READY" ? "可用" : "需要处理"}</b></p>
    <p class="hash">providerIdentityHash: ${esc(probe.providerIdentityHash)}<br>capabilityFingerprint: ${esc(probe.capabilityFingerprint)}</p>
    ${probe.code==="READY"?`<p>可用模型：${esc(probe.supportedModels.join(", "))}<span class="technical"> · 即梦命令行版本：${esc(probe.cliVersion)}</span></p><p class="technical">operations: ${esc(probe.supportedOperations.join(", "))}</p>`:""}
    <p>当前计划：${esc(refText(workspace.project.currentProductionPlanRef))}</p>
  </section>
  <section class="card"><h3>本轮选片</h3>
    <p>已接受 <b class="ok">${acceptedClipIds.size}</b> · 已跳过 <b>${skippedClipIds.size}</b> · 待决定 <b>${pendingClipCount}</b></p>\n    <p>目标：<b>${workspace.project.targetDurationMs/1000}s</b> · 计划：${plannedDurationMs/1000}s · 已生成：${generatedDurationMs/1000}s · 已采用：<b class="ok">${acceptedDurationMs/1000}s</b></p>
    <p class="muted">不需要的镜头可以直接跳过，无需生成。只要至少保留 1 个已接受镜头，就可以结束本轮并进入下一步。</p>
    <div>${clipSelectionHtml}</div>
    ${acceptedClipIds.size > 0 && pendingClipCount > 0
      ? `<p><button class="primary" id="finalize-selection">使用当前已接受片段进入下一步</button></p>
         <p class="muted">此操作会把其余尚未采用的镜头明确标记为“跳过”；不会静默删除历史任务。</p>
         <div id="finalize-selection-error" class="danger"></div>`
      : acceptedClipIds.size > 0 && pendingClipCount === 0
        ? workspace.project.status === "READY_TO_ASSEMBLE"
          ? `<p class="ok">当前所有镜头已完成“采用或跳过”决策。</p>
             <p><a class="primary" id="enter-timeline" href="/projects/${workspace.project.id}/timeline">进入视频剪辑</a></p>`
          : `<p class="muted">镜头决策已完成，但当前仍有流程条件未满足；请先处理页面中的“需要处理的问题”。</p>`
        : `<p class="muted">至少先接受 1 个生成结果，才能用部分镜头进入下一步。</p>`}
  </section>
  <section class="card" id="standard-generation-config" data-state="${esc(JSON.stringify(standardGenerationDefaults))}">
    <h3>本次生成设置</h3>
    ${directorTarget ? `<p>以下设置已绑定当前导演分镜；更改模型或画幅需要重新适配并审核。<a href="/projects/${workspace.project.id}/director">返回导演分镜更改</a></p>` : ""}
    <p class="muted">标准模式与智能生成共用同一 DreaminaCapabilityRegistry。这里的选择会写入 GenerationProfile，并绑定到每个 GenerationRequest；模型不一致会在提交前阻断。</p>
    <div class="row">
      <label class="field">视频模型
        <select id="standard-model" disabled><option>正在读取当前 CLI 能力…</option></select>
      </label>
      <label class="field">画幅
        <select id="standard-ratio" disabled><option>正在读取…</option></select>
      </label>
      <label class="field">分辨率
        <select id="standard-resolution" disabled><option>正在读取…</option></select>
      </label>
    </div>
    <p><label><input type="checkbox" id="standard-native-audio" disabled> 让模型原生输出声音</label></p>
    <p id="standard-native-audio-help" class="muted">正在检查当前命令的原生声音能力…</p>
    <p id="standard-capability-status" class="muted">正在读取 Dreamina 官方 SKILL.md + CLI help…</p>
  </section>
  <section class="card"><h3>生成前检查</h3>
    <p>当前：通过 ${passCount} · 需要处理 ${blockedCount}<span class="technical"> · 历史/失效 ${preflights.length-activeReports.length}</span></p>
    <div>${preflightCards}</div>
    ${hasUnknownSubmission
      ? `<div class="card"><p class="danger"><b>存在未决提交：</b>当前不能直接再次提交。只有明确接受可能重复扣费，才能创建新的生成请求；原任务仍保留等待恢复。</p>
         <label><input type="checkbox" id="accept-duplicate-preflight-risk"> 我明确接受可能重复扣费，并允许创建新的生成请求</label></div>`
      : ""}
    ${approvalSummary}
    <p><button class="primary" id="run-preflight" data-plan-confirmed="${workspace.productionPlan?.status==="CONFIRMED"?"1":"0"}" ${workspace.productionPlan?.status==="CONFIRMED"?"":"disabled"}>${actionLabel}</button>
    <span id="preflight-progress" class="muted"></span></p>
    <div id="preflight-error" class="danger"></div>
  </section>
  <section class="card"><h3>需要处理的问题</h3>${blockers.length?blockers.map(b=>`<p>${esc(b.requiredUserAction)}<br><code class="technical">${esc(b.reasonCode)} · resume=${esc(b.resumeCheckpoint)}</code></p>`).join(""):"<p class=\"ok\">当前没有需要你处理的问题。</p>"}</section>
  <section class="card"><h3>视频生成记录</h3><p id="auto-generation-status" class="muted">${autoPollAttemptIds.length ? "系统会自动刷新正在生成的任务，无需手动点刷新。" : autoDownloadAttemptIds.length ? "生成已完成，正在自动下载结果…" : ""}</p>${attemptCards}${supersededAttemptCards}${historicalAttemptCards}</section>
  ${renderBatchGenerationPanel(workspace.project.id)}
<script>
const standardConfig=document.querySelector('#standard-generation-config');
const standardModel=document.querySelector('#standard-model');
const standardRatio=document.querySelector('#standard-ratio');
const standardResolution=document.querySelector('#standard-resolution');
const standardNativeAudio=document.querySelector('#standard-native-audio');
const standardNativeAudioHelp=document.querySelector('#standard-native-audio-help');
const standardCapabilityStatus=document.querySelector('#standard-capability-status');
let standardRegistry=null;
let standardState={requiredOperations:[],model:'AUTO',aspectRatio:'AUTO',videoResolution:'720p',nativeAudioOutputRequested:true};
try{standardState=JSON.parse(standardConfig?.dataset.state||JSON.stringify(standardState));}catch{}
const standardUniq=values=>[...new Set(values.filter(Boolean))];
const standardIntersection=arrays=>arrays.length?arrays.reduce((acc,next)=>acc.filter(value=>next.includes(value))):[];
const standardModelLabel=value=>value==='AUTO'?'自动模型（按各命令明确声明的默认模型）':String(value).replace(/^seedance/i,'Seedance ');
function standardFillSelect(select,items,selected){
  select.innerHTML=items.map(item=>'<option value="'+item.value+'">'+item.label+'</option>').join('');
  if(selected&&items.some(item=>item.value===selected))select.value=selected;
  else if(items.length)select.value=items[0].value;
}
function standardOperationCaps(){
  if(!standardRegistry)return [];
  return (standardState.requiredOperations||[]).map(name=>standardRegistry.operations.find(item=>item.operation===name)).filter(Boolean);
}
function refreshStandardGenerationControls(){
  if(!standardRegistry)return;
  const ops=standardOperationCaps();
  if(!ops.length){standardCapabilityStatus.textContent='当前导演方案没有可生成镜头。';return;}
  const explicitModels=standardIntersection(ops.map(op=>op.supportedModels||[]));
  const allowAuto=ops.every(op=>Boolean(op.defaultModelVersion));
  const modelItems=[...(allowAuto?[{value:'AUTO',label:standardModelLabel('AUTO')}]:[]),...explicitModels.map(value=>({value,label:standardModelLabel(value)}))];
  const requestedModel=modelItems.some(item=>item.value===standardModel.value)?standardModel.value:standardState.model;
  standardFillSelect(standardModel,modelItems,requestedModel);
  standardModel.disabled=!modelItems.length;
  const selectedModel=standardModel.value;
  const modelCaps=ops.map(op=>{
    const effective=selectedModel==='AUTO'?op.defaultModelVersion:selectedModel;
    return op.models.find(model=>model.modelVersion===effective);
  });
  const explicitRatioAllowed=modelCaps.every(model=>model?.explicitRatioAllowed!==false);
  const ratioIntersection=explicitRatioAllowed?standardIntersection(ops.map(op=>op.supportedRatios||[])):[];
  standardFillSelect(standardRatio,[{value:'AUTO',label:explicitRatioAllowed?'自动 / 跟随素材':'自动 / 跟随首帧（当前模型不接受显式画幅）'},...ratioIntersection.map(value=>({value,label:value}))],standardState.aspectRatio);
  standardRatio.disabled=false;
  const resolutionIntersection=standardIntersection(modelCaps.map((model,index)=>model?.supportedResolutions?.length?model.supportedResolutions:(ops[index].fixedResolutions||[])));
  standardFillSelect(standardResolution,resolutionIntersection.map(value=>({value,label:value})),standardState.videoResolution);
  if(resolutionIntersection.includes('720p')&&!resolutionIntersection.includes(standardResolution.value))standardResolution.value='720p';
  standardResolution.disabled=!resolutionIntersection.length;
  const nativeSupported=ops.every(op=>op.supportsNativeAudioOutput===true);
  standardNativeAudio.disabled=!nativeSupported;
  standardNativeAudio.checked=nativeSupported&&Boolean(standardState.nativeAudioOutputRequested);
  standardNativeAudioHelp.textContent=nativeSupported?'Seedance 当前链路会直接生成原生音轨；下载后程序会再次检查音轨是否真实存在。':'当前计划包含不能保证音轨的生成方式；请返回导演分镜重新适配。';
  const pfButton=document.querySelector('#run-preflight');
  if(pfButton)pfButton.disabled=!modelItems.length||!resolutionIntersection.length||pfButton.dataset.planConfirmed==='0';
  standardCapabilityStatus.textContent='当前计划命令：'+ops.map(op=>op.operationLabel).join(' / ')+' · 共同模型：'+(explicitModels.join(' / ')||'无')+' · 能力来源：官方 SKILL.md + 当前 dreamina --help · '+standardRegistry.checkedAt;
  if(standardState.boundToDirector){
    standardModel.disabled=true;standardRatio.disabled=true;standardResolution.disabled=true;standardNativeAudio.disabled=true;
    if(standardModel.value!==standardState.model||standardRatio.value!==standardState.aspectRatio||standardResolution.value!==standardState.videoResolution||standardNativeAudio.checked!==standardState.nativeAudioOutputRequested){
      if(pfButton)pfButton.disabled=true;
      standardCapabilityStatus.textContent='当前能力已不能满足绑定的导演设置，请返回导演分镜重新适配，不能静默改用其他模型或参数。';
    }
  }
}
async function loadStandardGenerationRegistry(){
  const pfButton=document.querySelector('#run-preflight');if(pfButton)pfButton.disabled=true;
  try{
    const response=await fetch('/api/dreamina/capabilities');
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.message||payload.error||'读取 Dreamina 能力失败');
    standardRegistry=payload.registry;
    refreshStandardGenerationControls();
  }catch(err){
    standardCapabilityStatus.textContent='Dreamina 动态能力读取失败：'+(err.message||String(err));
    document.querySelector('#preflight-error').textContent=standardCapabilityStatus.textContent;
  }
}
standardModel?.addEventListener('change',()=>{standardState.model=standardModel.value;refreshStandardGenerationControls();});
standardRatio?.addEventListener('change',()=>{standardState.aspectRatio=standardRatio.value;});
standardResolution?.addEventListener('change',()=>{standardState.videoResolution=standardResolution.value;});
standardNativeAudio?.addEventListener('change',()=>{standardState.nativeAudioOutputRequested=standardNativeAudio.checked;});
function currentStandardGenerationSettings(){
  return {requestedModelVersion:standardModel.value,aspectRatio:standardRatio.value,videoResolution:standardResolution.value,nativeAudioOutputRequested:Boolean(standardNativeAudio.checked)};
}
loadStandardGenerationRegistry();
const pf=document.querySelector('#run-preflight');
if(pf) pf.addEventListener('click',async()=>{
  pf.disabled=true;
  const progress=document.querySelector('#preflight-progress'), error=document.querySelector('#preflight-error');
  error.textContent=''; progress.textContent=' 正在编译生成提示词、建立生成请求并执行生成前检查…';
  try{
    const acceptedDuplicateSubmissionRisk=Boolean(document.querySelector('#accept-duplicate-preflight-risk')?.checked);
    if(!standardRegistry||!standardModel.value||!standardResolution.value)throw new Error('Dreamina 动态生成设置尚未准备好');
    const generationSettings=currentStandardGenerationSettings();
    const r=await fetch('/api/projects/${workspace.project.id}/preflight/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acceptedDuplicateSubmissionRisk,generationSettings})});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);progress.textContent='';pf.disabled=false;}
});

const approvalButton=document.querySelector('#create-approval');
if(approvalButton) approvalButton.addEventListener('click',async()=>{
  approvalButton.disabled=true;
  const error=document.querySelector('#approval-error');
  error.textContent='';
  try{
    const acceptedUnknownCostRisk=Boolean(document.querySelector('#accept-unknown-cost')?.checked);
    const acceptedDuplicateSubmissionRisk=Boolean(document.querySelector('#accept-duplicate-approval-risk')?.checked);
    const r=await fetch('/api/projects/${workspace.project.id}/approval',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({acceptedUnknownCostRisk,acceptedDuplicateSubmissionRisk})
    });
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);approvalButton.disabled=false;}
});

document.querySelectorAll('.attempt-action').forEach(button=>{
  button.addEventListener('click',async()=>{
    const attemptId=button.dataset.attempt, action=button.dataset.action;
    button.disabled=true;
    try{
      const r=await fetch('/api/projects/${workspace.project.id}/attempts/'+encodeURIComponent(attemptId)+'/'+encodeURIComponent(action),{method:'POST'});
      const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
      location.reload();
    }catch(err){alert(err.message||String(err));button.disabled=false;}
  });
});

const autoPollAttemptIds=${JSON.stringify(autoPollAttemptIds)};
const autoDownloadAttemptIds=${JSON.stringify(autoDownloadAttemptIds)};
const autoGenerationStatus=document.querySelector('#auto-generation-status');
let autoGenerationRunning=false;
async function callAttemptAction(attemptId,action){
  const r=await fetch('/api/projects/${workspace.project.id}/attempts/'+encodeURIComponent(attemptId)+'/'+encodeURIComponent(action),{method:'POST'});
  const j=await r.json();
  if(!r.ok) throw new Error(j.message||j.error);
  return j.attempt;
}
async function autoWatchGeneration(){
  if(autoGenerationRunning)return;
  autoGenerationRunning=true;
  let shouldReload=false;
  let keepPolling=false;
  try{
    for(const attemptId of autoDownloadAttemptIds){
      if(autoGenerationStatus)autoGenerationStatus.textContent='生成完成，正在自动下载视频…';
      await callAttemptAction(attemptId,'download');
      shouldReload=true;
    }
    if(!shouldReload){
      for(const attemptId of autoPollAttemptIds){
        if(autoGenerationStatus)autoGenerationStatus.textContent='视频正在生成，系统会自动刷新状态…';
        const attempt=await callAttemptAction(attemptId,'poll');
        const status=attempt?.status;
        if(status==='SUCCEEDED'||status==='RECONCILED_SUCCEEDED'){
          if(!attempt.outputArtifactId){
            if(autoGenerationStatus)autoGenerationStatus.textContent='生成完成，正在自动下载视频…';
            await callAttemptAction(attemptId,'download');
          }
          shouldReload=true;
        }else if(status==='SUBMITTED'||status==='PROCESSING'){
          keepPolling=true;
        }else{
          shouldReload=true;
        }
      }
    }
  }catch(err){
    if(autoGenerationStatus)autoGenerationStatus.textContent='自动刷新暂时失败：'+(err.message||String(err))+'。你仍可使用手动按钮。';
    autoGenerationRunning=false;
    return;
  }
  autoGenerationRunning=false;
  if(shouldReload){location.reload();return;}
  if(keepPolling)setTimeout(autoWatchGeneration,4000);
}
if(autoPollAttemptIds.length||autoDownloadAttemptIds.length)setTimeout(autoWatchGeneration,900);

document.querySelectorAll('.visual-compare-action').forEach(button=>{
  button.addEventListener('click',async()=>{
    const clipId=button.dataset.clip;
    const box=button.closest('.visual-version-compare');
    const result=box?.querySelector('.visual-compare-result');
    button.disabled=true;
    if(result)result.textContent='正在逐个分析成功版本并比较产品稳定性与最佳区间…';
    try{
      const r=await fetch('/api/projects/${workspace.project.id}/clips/'+encodeURIComponent(clipId)+'/visual-compare',{method:'POST'});
      const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error||'多版本比较失败');
      if(result){
        result.replaceChildren();
        const summary=document.createElement('p');
        summary.textContent=(j.comparison.recommendedAttemptId?'存在更安全的推荐版本。':'没有足够证据区分唯一更优版本。')+' '+j.comparison.recommendationReason;
        result.append(summary);
        for(const item of j.comparison.candidates){
          const p=document.createElement('p');
          const recommended=j.comparison.recommendedAttemptId===item.attemptId?' · 建议优先查看':'';
          p.textContent='第 '+item.attemptNumber+' 次 · '+item.status+'/'+item.confidence+' · 建议区间 '+(item.selectedWindow.inMs/1000).toFixed(2)+'–'+(item.selectedWindow.outMs/1000).toFixed(2)+' 秒'+recommended+' · '+item.reasons.join('；');
          result.append(p);
        }
        const note=document.createElement('p');
        note.textContent='比较建议不会自动采用历史版本，也不会触发新的 Dreamina 生成。最终请播放完整视频确认。';
        result.append(note);
      }
    }catch(err){if(result)result.textContent=err.message||String(err);}
    finally{button.disabled=false;}
  });
});

document.querySelectorAll('.review-action').forEach(button=>{
  button.addEventListener('click',async()=>{
    const attemptId=button.dataset.attempt, clipId=button.dataset.clip, decision=button.dataset.decision;
    button.disabled=true;
    try{
      const r=await fetch('/api/projects/${workspace.project.id}/clips/'+encodeURIComponent(clipId)+'/review',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({generationAttemptId:attemptId,decision})
      });
      const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
      location.reload();
    }catch(err){alert(err.message||String(err));button.disabled=false;}
  });
});

document.querySelectorAll('.clip-usage-action').forEach(button=>{
  button.addEventListener('click',async()=>{
    const clipId=button.dataset.clip, decision=button.dataset.decision;
    button.disabled=true;
    try{
      const r=await fetch('/api/projects/${workspace.project.id}/clips/'+encodeURIComponent(clipId)+'/review',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({decision})
      });
      const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
      location.reload();
    }catch(err){alert(err.message||String(err));button.disabled=false;}
  });
});

const finalizeSelection=document.querySelector('#finalize-selection');
if(finalizeSelection) finalizeSelection.addEventListener('click',async()=>{
  if(!confirm('确认使用当前已接受片段进入下一步？其余尚未采用的镜头将被明确标记为跳过。')) return;
  finalizeSelection.disabled=true;
  const error=document.querySelector('#finalize-selection-error');
  error.textContent='';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/review/finalize-selection',{method:'POST'});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);finalizeSelection.disabled=false;}
});

document.querySelectorAll('.redo-preflight').forEach(button=>{
  button.addEventListener('click',async()=>{
    const clipId=button.dataset.clip;
    button.disabled=true;
    try{
      const r=await fetch('/api/projects/${workspace.project.id}/preflight/run',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          clipIds:[clipId],
          acceptedDuplicateSubmissionRisk:Boolean(document.querySelector('#accept-duplicate-preflight-risk')?.checked),
          generationSettings:currentStandardGenerationSettings()
        })
      });
      const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
      location.reload();
    }catch(err){alert(err.message||String(err));button.disabled=false;}
  });
});
</script>`;
}

function renderFinal(
  workspace: ProjectWorkspace,
  timeline: Timeline | undefined,
  renderJob: RenderJob | undefined,
  assembly: FinalAssembly | undefined,
  finalQc: FinalQcReport | undefined,
  artifacts: ArtifactRecord[],
  publishAttempts: PublishAttempt[],
  publishProbe: DouyinPublishProbe | undefined,
  publishBridge:
    | {
        preference: PublishPreference;
        probes: PublishProviderProbe[];
        packages: PublicPublishPackage[];
        receipts: PublishReceipt[];
        browserPreparationSupported?:boolean;
        browserCheckpoints?:Array<import("../application/ports/browser-publish-preparation.js").BrowserPublishCheckpoint|null>;
      }
    | undefined
): string {
  const finalArtifact = assembly
    ? artifacts.find((item) => item.id === assembly.outputArtifactId)
    : undefined;
  const finalArtifactReady = Boolean(
    assembly &&
    finalArtifact?.integrityStatus === "READY" &&
    finalArtifact.sha256 &&
    finalArtifact.sha256 === assembly.outputArtifactHash
  );
  const finalDeliverableReady = Boolean(
    assembly?.status === "ACCEPTED" && finalArtifactReady
  );
  const finalQcReady = Boolean(finalQc && finalQc.overall !== "BLOCK");
  const finalPublishReady = finalDeliverableReady && finalQcReady;
  const finalQcStatusLabel = finalQc
    ? finalQc.overall === "PASS"
      ? "通过"
      : finalQc.overall === "WARN"
        ? "有警告"
        : "阻止发布"
    : "尚未运行";
  const currentClips = (workspace.productionPlan?.scenes ?? []).flatMap(
    (scene) => scene.clips
  );
  const selectedPlannedDurationMs = assembly
    ? currentClips
        .filter((clip) => assembly.selectedClipIds.includes(clip.id))
        .reduce((total, clip) => total + clip.durationMs, 0)
    : 0;
  const isAgentAssembly = Boolean(
    assembly?.selectedClipIds.some((clipId) => clipId.startsWith("agent-"))
  );
  const isTimelineAssembly = Boolean(assembly?.timelineHash);
  const renderableStatus =
    workspace.project.status === "READY_TO_ASSEMBLE" ||
    workspace.project.status === "FINAL_REVIEW" ||
    workspace.project.status === "READY_TO_PUBLISH" ||
    workspace.project.status === "PUBLISHING" ||
    workspace.project.status === "PUBLISHED" ||
    workspace.project.status === "COMPLETED";
  const canRender = workspace.productionPlan
    ? timeline?.status === "CONFIRMED"
    : renderableStatus;
  const requiresTimelineConfirm = Boolean(
    workspace.productionPlan && timeline?.status !== "CONFIRMED"
  );
  const timelineAuditHtml =
    assembly?.timelineHash && assembly.renderJobId
      ? `<p class="hash">timeline=${esc(assembly.timelineId ?? "UNKNOWN")}<br>timeline_sha256=${esc(assembly.timelineHash)}<br>render_job=${esc(assembly.renderJobId)}<br>inputs=${assembly.inputArtifactHashes.map((hash) => esc(hash)).join("<br>")}</p>
         <p class="muted technical">渲染参数：${esc(
           assembly.renderConfig
             ? `${assembly.renderConfig.width}×${assembly.renderConfig.height} · ${assembly.renderConfig.fps}fps · ${assembly.renderConfig.videoCodec}/${assembly.renderConfig.audioCodec}`
             : "UNKNOWN"
         )}</p>`
      : "";
  const renderJobStatusHtml = renderJob
    ? `<p class="${renderJob.status === "FAILED" ? "danger" : "muted"}">渲染任务：<b>${esc(renderJobStatusLabel[renderJob.status])}</b>${renderJob.errorMessage ? " · " + esc(renderJob.errorMessage) : ""}</p>`
    : "";
  const finalQcHtml =
    assembly && finalArtifactReady
      ? `<section class="card"><div class="head"><div><h3>发布前质检</h3><p class="muted">检查文件、媒体流、时长、尺寸、音轨、黑帧/冻结帧、长静音、字幕/CTA 和已有视觉审片证据。</p></div><span class="status">${esc(finalQcStatusLabel)}</span></div>
          ${finalQc
            ? `<div class="grid">${finalQc.checks
                .map(
                  (check) =>
                    `<div class="card"><b>${esc(check.label)}</b><p>${esc(check.severity === "PASS" ? "通过" : check.severity === "WARN" ? "警告" : "阻止")}</p><p class="muted">${esc(check.message)}</p><p class="technical"><code>${esc(check.code)}</code></p></div>`
                )
                .join("")}</div><p class="muted">报告绑定：artifact ${esc(finalQc.artifactId)} · ${esc(finalQc.artifactHash.slice(0, 12))}…</p>`
            : `<p>当前成片还没有发布前 QC 报告。</p>`}
          <p><button class="secondary" type="button" id="run-final-qc">${finalQc ? "重新运行发布前质检" : "运行发布前质检"}</button></p>
          <div id="final-qc-error" class="danger"></div></section>`
      : "";
  const assemblyHtml =
    assembly && assembly.status !== "STALE" && finalArtifact?.integrityStatus === "READY"
      ? `<div class="card">
          <p><b>当前成片：</b>${assembly.status === "ACCEPTED" ? "已确认" : assembly.status === "READY" ? "待确认" : "已失效"} · ${isAgentAssembly ? "智能生成直出" : assembly.selectedClipIds.length + " 个已采用镜头"}</p>
          <p>目标时长：<b>${workspace.project.targetDurationMs/1000}s</b>${isAgentAssembly ? "" : " · 镜头合计：" + selectedPlannedDurationMs/1000 + "s"} · 成片实际：<b id="final-actual-duration">读取中…</b></p>
          <p class="hash">assembly=${esc(assembly.id)}<br>artifact=${esc(finalArtifact.id)}<br>sha256=${esc(finalArtifact.sha256 ?? "UNKNOWN")}</p>
          ${timelineAuditHtml}
          <video id="final-video-player" controls preload="metadata" style="width:100%;max-height:720px;background:#000" src="/api/artifacts/${esc(finalArtifact.id)}/content"></video>
          <p><a class="secondary" href="/api/artifacts/${esc(finalArtifact.id)}/content" download="product-video-${esc(assembly.id)}.mp4">下载成片 MP4</a></p>
          <p class="muted">${isAgentAssembly ? "此成片来自智能生成直出；确认后可进入发布。" : isTimelineAssembly ? "此成片由已确认的视频剪辑方案进行非破坏式渲染生成。" : "此成片来自兼容的旧式成片链路。"}</p>
          ${assembly.status === "READY"
            ? `<p><button class="primary" id="accept-final" ${finalQcReady ? "" : "disabled"}>接受成片</button></p><p class="muted">${finalQc ? finalQc.overall === "BLOCK" ? "QC 存在阻止项，修复并重新质检后才能接受成片。" : "QC 已完成，可以接受成片。" : "请先运行发布前质检。"}</p><div id="accept-final-error" class="danger"></div>`
            : `<p class="ok">成片已确认。你可以直接下载 MP4，或在发布中心选择当前可用的发布方式。</p>`}
        </div>`
      : `<div class="card">
          <p>尚未生成最终成片。</p>
          ${renderJobStatusHtml}
          <p class="muted">${workspace.productionPlan ? "标准项目将按已确认的视频剪辑顺序、裁剪、转场、音量、字幕、行动引导与背景音乐渲染 MP4。" : "兼容模式将使用现有成片链路。"}</p>
          ${requiresTimelineConfirm
            ? `<p class="danger">请先完成并确认视频剪辑。</p><p><a class="primary" href="/projects/${workspace.project.id}/timeline">返回视频剪辑</a></p>`
            : `<p><button class="primary" id="render-final" ${canRender ? "" : "disabled"}>${workspace.productionPlan ? "按剪辑方案渲染 MP4" : "生成成片"}</button></p>`}
          <div id="render-final-error" class="danger"></div>
        </div>`;

  const publishHistory = publishAttempts.length
    ? `<details><summary>发布记录（${publishAttempts.length}）</summary>${publishAttempts
        .slice()
        .reverse()
        .map(
          (attempt) =>
            `<div class="clip"><b>${esc(publishAttemptStatusLabel[attempt.status])} · ${esc(attempt.title)}</b>
              <p class="hash">publish=${esc(attempt.id)}${attempt.externalVideoId ? `<br>video_id=${esc(attempt.externalVideoId)}` : ""}${attempt.externalItemId ? `<br>item_id=${esc(attempt.externalItemId)}` : ""}</p>
              ${attempt.errorMessage ? `<p class="danger">${esc(attempt.errorCode ?? "ERROR")} · ${esc(attempt.errorMessage)}</p>` : ""}
            </div>`
        )
        .join("")}</details>`
    : "";

  const publishCenter = publishBridge
    ? renderPublishCenter({
        projectId: workspace.project.id,
        projectName: workspace.project.name,
        acceptedFinal: finalPublishReady,
        preference: publishBridge.preference,
        probes: publishBridge.probes,
        packages: publishBridge.packages,
        receipts: publishBridge.receipts,
        browserPreparationSupported:publishBridge.browserPreparationSupported,
        browserCheckpoints:publishBridge.browserCheckpoints
      })
    : `<section class="card"><h3>发布中心</h3><p class="muted">发布方式状态尚未加载；最终 MP4 仍可手动下载。</p></section>`;
  const showPublishedDouyinOperations = Boolean(
    publishBridge && hasTrustedDouyinPublication({
      projectId: workspace.project.id,
      finalAssemblyId: assembly?.id,
      finalArtifactId: assembly?.outputArtifactId,
      finalArtifactHash: assembly?.outputArtifactHash,
      finalArtifactReady: finalDeliverableReady,
      packages: publishBridge.packages,
      receipts: publishBridge.receipts
    })
  );

  const selectedPublishProbe = publishBridge?.probes.find(
    (probe) => probe.providerType === publishBridge.preference.providerType
  );
  const manualPublishReady = Boolean(
    publishBridge?.probes.some(
      (probe) => probe.providerType === "MANUAL_EXPORT" && probe.code === "READY"
    )
  );
  const deliveryStatus = `<section class="card"><h3>最终交付状态</h3>
    <p>最终 MP4：<b>${finalArtifactReady ? "可下载" : "尚未就绪"}</b> · 成片确认：<b>${assembly?.status === "ACCEPTED" ? "已确认" : assembly?.status === "READY" ? "待确认" : "尚未就绪"}</b> · 发布前 QC：<b>${esc(finalQcStatusLabel)}</b></p>
    <p>当前发布方式：<b>${esc(selectedPublishProbe?.displayName ?? "尚未读取")}</b> · ${esc(selectedPublishProbe ? selectedPublishProbe.code === "READY" ? "可用" : "当前不可用" : "未知")}</p>
    <p class="muted">${finalDeliverableReady && manualPublishReady
      ? "下载 MP4 / 手动发布兜底可用。外部发布资质或授权缺失不会阻断最终成片交付。"
      : !finalArtifactReady
        ? "当前最终 MP4 文件不可用或校验未通过；发布能力即使 READY 也不能创建发布包。请先恢复文件或重新渲染成片。"
      : "尚未确认手动导出兜底状态，请检查发布能力。"}</p>
    <p class="muted">交接、扫码或唤起发布页都不等于平台已发布；只有可信平台回执才会显示“已发布”。</p>
  </section>`;

  return `${projectHeader(workspace, "成片与发布")}
  ${deliveryStatus}
  <section class="card"><h3>成片</h3>${assemblyHtml}</section>
${finalQcHtml}
${publishCenter}
${publishHistory ? `<section class="card"><h3>兼容的旧发布记录（只读）</h3>${publishHistory}</section>` : ""}
${showPublishedDouyinOperations
  ? `<section class="card" id="post-publish-ops-entry"><h3>发布已确认 · 下一步</h3>
       <p class="muted">当前成片已有抖音可信发布回执。可以进入该项目运营页查看作品绑定、播放数据、评论和复盘。</p>
       <p><a class="primary" href="/projects/${encodeURIComponent(workspace.project.id)}/douyin">进入抖音运营</a></p>
       <p class="muted">进入运营页面仅执行导航，不会重复发布或自动回复评论。</p></section>`
  : ""}
<script>
const finalVideoPlayer=document.querySelector('#final-video-player');
if(finalVideoPlayer){
  const updateFinalDuration=()=>{
    const target=document.querySelector('#final-actual-duration');
    if(target&&Number.isFinite(finalVideoPlayer.duration))target.textContent=finalVideoPlayer.duration.toFixed(1)+'s';
  };
  finalVideoPlayer.addEventListener('loadedmetadata',updateFinalDuration);
  if(finalVideoPlayer.readyState>=1)updateFinalDuration();
}
const renderFinal=document.querySelector('#render-final');
if(renderFinal) renderFinal.addEventListener('click',async()=>{
  renderFinal.disabled=true;
  const error=document.querySelector('#render-final-error'); error.textContent='';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/final/render',{method:'POST'});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);renderFinal.disabled=false;}
});

const runFinalQc=document.querySelector('#run-final-qc');
if(runFinalQc) runFinalQc.addEventListener('click',async()=>{
  runFinalQc.disabled=true;
  const error=document.querySelector('#final-qc-error'); if(error) error.textContent='';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/final/qc',{method:'POST'});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){if(error)error.textContent=err.message||String(err);runFinalQc.disabled=false;}
});

const acceptFinal=document.querySelector('#accept-final');
if(acceptFinal) acceptFinal.addEventListener('click',async()=>{
  acceptFinal.disabled=true;
  const error=document.querySelector('#accept-final-error'); error.textContent='';
  try{
    const r=await fetch('/api/projects/${workspace.project.id}/final/accept',{method:'POST'});
    const j=await r.json(); if(!r.ok) throw new Error(j.message||j.error);
    location.reload();
  }catch(err){error.textContent=err.message||String(err);acceptFinal.disabled=false;}
});

</script>`;
}

export function renderProjectPage(input: {
  kind: PageKind;
  workspace: ProjectWorkspace;
  navigation?: WorkflowNavigationState;
  productInput?: ProductInputSnapshot;
  blockers: WorkflowBlocker[];
  attempts: GenerationAttempt[];
  generationRequests: GenerationRequest[];
  preflights: PreflightReport[];
  approvals: UserApproval[];
  compiledPrompts: CompiledPrompt[];
  artifacts: ArtifactRecord[];
  reviewDecisions: ReviewDecision[];
  commandAttempts: Array<
    CommandAttemptRecord & {
      generationAttemptId?: string;
      argvRedacted?: string[];
    }
  >;
  probe?: ProviderProbeResult;
  timeline?: Timeline;
  renderJob?: RenderJob;
  finalAssembly?: FinalAssembly;
  finalQc?: FinalQcReport;
  publishAttempts?: PublishAttempt[];
  publishProbe?: DouyinPublishProbe;
  publishBridge?: {
    preference: PublishPreference;
    probes: PublishProviderProbe[];
    packages: PublicPublishPackage[];
    receipts: PublishReceipt[];
    browserPreparationSupported?:boolean;
    browserCheckpoints?:Array<import("../application/ports/browser-publish-preparation.js").BrowserPublishCheckpoint|null>;
  };
}): string {
  const {
    kind,
    workspace,
    blockers,
    attempts,
    generationRequests,
    preflights,
    approvals,
    compiledPrompts,
    artifacts,
    reviewDecisions,
    commandAttempts
  } = input;
  let body = "";
  if (kind === "product") body = renderProduct(workspace, input.productInput);
  if (kind === "truth") {
    body = renderTruth(workspace, input.productInput, artifacts);
  }
  if (kind === "creative") body = renderCreative(workspace);
  if (kind === "script") body = renderScript(workspace);
  if (kind === "director") body = renderDirector(workspace, compiledPrompts);
  if (kind === "generate") {
    if (!input.probe) throw new Error("generate page requires provider probe");
    body = renderGenerate(
      workspace,
      blockers,
      attempts,
      generationRequests,
      preflights,
      approvals,
      artifacts,
      reviewDecisions,
      commandAttempts,
      input.probe
    );
  }
  if (kind === "timeline") {
    if (!input.timeline) {
      throw new Error("timeline page requires Timeline");
    }
    body =
      projectHeader(workspace, "视频剪辑") +
      renderTimelineEditor(workspace, input.timeline, input.renderJob);
  }
  if (kind === "final") {
    body = renderFinal(
      workspace,
      input.timeline,
      input.renderJob,
      input.finalAssembly,
      input.finalQc,
      artifacts,
      input.publishAttempts ?? [],
      input.publishProbe,
      input.publishBridge
    );
  }
  const pageBlockers =
    kind === "final" && input.publishBridge
      ? blockers.filter(
          (blocker) =>
            !(
              blocker.scope === "PROVIDER" &&
              blocker.resumeCheckpoint === "publish.douyin.oauth"
            )
        )
      : blockers;
  const navigation =
    input.navigation ??
    resolveWorkflowNavigation({
      project: workspace.project,
      currentPage: kind,
      blockers: pageBlockers,
      ...(input.timeline ? { timeline: input.timeline } : {}),
      ...(input.finalAssembly
        ? { finalAssemblyStatus: input.finalAssembly.status }
        : {})
    });
  return layout(
    pageKindLabel[kind],
    body,
    workspace.project,
    pageBlockers,
    navigation
  );
}
