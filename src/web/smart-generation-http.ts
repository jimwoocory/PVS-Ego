import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DomainValidationError } from "../domain/validation.js";
import type { SmartGenerationService } from "../application/services/smart-generation-service.js";
import type { SmartWorkerPolicy } from "../application/services/smart-generation-worker.js";
import type { BatchGenerationService } from "../application/services/batch-generation-service.js";
import type { ProductFlowService } from "../application/services/product-flow.js";
import type { ProductInputStore } from "../application/ports/product-input-store.js";
import type { TimelineService } from "../application/services/timeline-service.js";
import type { FinalOutputRepository } from "../application/ports/final-output-repository.js";
import { renderSmartGenerationPage } from "./smart-generation-ui.js";
import { v8VoiceBindingsSchema } from "../domain/v8-production.js";
import { scriptBeatSchema } from "../domain/schemas.js";
import { compileV8ShotShadow } from "../application/services/v8-shot-prompt-shadow.js";
import { planV8ShotFirstShadow } from "../application/services/v8-shot-first-shadow.js";
import { buildV8ScreenplayShadow } from "../application/services/v8-screenplay-shadow.js";
import { resolveWorkflowReadModel } from "../application/services/workflow-read-model.js";
import { closedSmartStatuses } from "../domain/smart-generation.js";
import type { WorkflowInlineData } from "./workflow-inline-panels.js";
import type { WorkflowRepository } from "../application/ports/workflow-repository.js";
import type { ReviewRepository } from "../application/ports/review-repository.js";
import type { ArtifactRepository } from "../application/ports/artifact-repository.js";
import type { CreativeReferenceService } from "../application/services/creative-reference-service.js";
import type { ResearchService } from "../application/services/research-service.js";
import {referenceVideoBrowserPreviewRelativePath, type ReferenceVideoAnalysisService} from "../application/services/reference-video-analysis.js";
import type { FinalQcService } from "../application/services/final-qc-service.js";
import type { VisualEditAssessmentService } from "../application/services/visual-edit-assessment.js";
const batchSchema = z.object({ attemptIds: z.array(z.string().min(1)).min(1).max(120), scopeHash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); count += b.length; if (count > 100_000) throw new DomainValidationError("请求内容过大"); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new DomainValidationError("请求必须是有效 JSON"); }
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
export async function handleSmartGenerationHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  smartGeneration?: SmartGenerationService;
  smartWorkerPolicy?: SmartWorkerPolicy;
  batchGeneration?: BatchGenerationService;
  productFlow: ProductFlowService;
  productInput?: ProductInputStore;
  timeline?: Pick<TimelineService, "latestTimeline">;
  finalOutput?: Pick<FinalOutputRepository, "latestAssembly">;
  workflow?: Pick<WorkflowRepository, "listGenerationAttempts">;
  artifacts?: Pick<ArtifactRepository, "listByProject">;
  review?: Pick<ReviewRepository, "listDecisions">;
  creativeReferences?: Pick<CreativeReferenceService, "pageData">;
  research?: Pick<ResearchService, "pageData">;
  referenceVideo?: Pick<ReferenceVideoAnalysisService, "latest">;
  finalQc?: Pick<FinalQcService, "latest">;
  visualEditAssessment?: Pick<VisualEditAssessmentService, "readCurrentSummaries">;
}): Promise<boolean> {
  const page = url.pathname.match(/^\/projects\/([^/]+)\/smart$/);
  const workflow = url.pathname.match(/^\/api\/projects\/([^/]+)\/workflow$/);
  const batch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generation-batch$/);
  const preview = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/director-v3-preview$/
  );
  const smart = url.pathname.match(/^\/api\/projects\/([^/]+)\/smart-runs(?:\/([^/]+)(?:\/([a-z0-9-]+))?)?$/);
  if (!page && !batch && !preview && !smart && !workflow) return false;
  if (workflow) {
    if (req.method !== "GET") { json(res, 405, { message: "工作流状态仅允许读取" }); return true; }
    if (!deps.smartGeneration) { json(res, 503, { message: "工作流编排服务尚未配置" }); return true; }
    const projectId = decodeURIComponent(workflow[1]!);
    const [workspace, productInput, runs, timeline, assembly] = await Promise.all([
      deps.productFlow.getWorkspace(projectId),
      deps.productInput?.latest(projectId),
      deps.smartGeneration.list(projectId),
      deps.timeline?.latestTimeline(projectId),
      deps.finalOutput?.latestAssembly(projectId)
    ]);
    if (!workspace) { json(res, 404, { message: "项目不存在" }); return true; }
    json(res, 200, {
      workflow: resolveWorkflowReadModel({
        project: workspace.project,
        productInputPresent: Boolean(productInput),
        productImagePresent: Boolean(productInput?.assets.some(asset => asset.type === "image")),
        productTruthConfirmed: workspace.productTruth?.status === "CONFIRMED",
        productTruthDraftPresent: Boolean(workspace.productTruth),
        selectedRunId: url.searchParams.get("activeRun"),
        runs,
        timelineStatus: timeline?.status,
        timelinePlanHash: timeline?.productionPlanHash,
        finalAssemblyStatus: assembly?.status,
        finalAssemblyPlanHash: assembly?.productionPlanHash,
        projectPlanHash: workspace.project.currentProductionPlanRef?.hash
      })
    });
    return true;
  }
  if (page && req.method === "GET") {
    if (!deps.smartGeneration) { json(res, 503, { message: "一键成片服务尚未配置" }); return true; }
    const projectId = decodeURIComponent(page[1]!);
    const [workspace, productInput, timeline, assembly] = await Promise.all([
      deps.productFlow.getWorkspace(projectId),
      deps.productInput?.latest(projectId),
      deps.timeline?.latestTimeline(projectId),
      deps.finalOutput?.latestAssembly(projectId)
    ]);
    if (!workspace) { json(res, 404, { message: "项目不存在" }); return true; }
    const runs = await deps.smartGeneration.list(projectId);
    const liveRuns = runs.filter(run => run.projectId === projectId && !closedSmartStatuses.includes(run.status));
    const chosenRun = liveRuns.find(run => run.id === url.searchParams.get("activeRun")) ?? (liveRuns.length === 1 ? liveRuns[0] : undefined);
    const [attempts, decisions, artifacts, referenceData, research, referenceVideo, finalQc] = await Promise.all([
      chosenRun ? deps.workflow?.listGenerationAttempts(projectId) : undefined,
      chosenRun ? deps.review?.listDecisions(projectId) : undefined,
      deps.artifacts?.listByProject(projectId),
      deps.creativeReferences?.pageData(projectId).catch(() => undefined),
      deps.research?.pageData(projectId).catch(() => undefined),
      deps.referenceVideo?.latest(projectId).catch(() => null),
      chosenRun?.status === "REVIEW_READY" ? deps.finalQc?.latest(projectId) : undefined
    ]);
    const visualSummaries = chosenRun?.status === "WAITING_FOR_CLIP_REVIEW" &&
      workspace.productTruth && deps.visualEditAssessment
      ? await deps.visualEditAssessment.readCurrentSummaries({
          projectId,
          truthHash: workspace.productTruth.contentHash,
          clips: (chosenRun.productionPlan ?? workspace.productionPlan)?.scenes.flatMap(s=>s.clips) ?? [],
          attempts: (attempts ?? []).filter(a=>chosenRun.attemptIds.includes(a.id))
        }).catch(() => undefined)
      : undefined;
    const previewArtifactId=referenceVideo && artifacts
      ? artifacts.find(a=>a.projectId===projectId&&a.integrityStatus==="READY"&&a.mimeType==="video/mp4"&&
          a.relativePath===referenceVideoBrowserPreviewRelativePath(referenceVideo.videoArtifactHash))?.id
      : undefined;
    const inline: Partial<Omit<WorkflowInlineData, "workspace" | "run">> = {
      ...(productInput ? { productInput } : {}),
      ...(attempts ? { attempts } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(decisions ? { decisions } : {}),
      ...(visualSummaries ? { visualSummaries } : {}),
      ...(referenceData ? { referenceData } : {}),
      ...(research ? { research } : {}),
      ...(referenceVideo ? { referenceVideo } : {}),
      ...(previewArtifactId ? { referenceVideoPreviewArtifactId: previewArtifactId } : {}),
      ...(assembly ? { finalAssembly: assembly } : {}),
      ...(finalQc ? { finalQc } : {})
    };
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderSmartGenerationPage(workspace, runs, {
      useResearch: url.searchParams.get("useResearch") === "1",
      fromReference: url.searchParams.get("useReference") === "1",
      productInput: productInput ?? null,
      inline,
      selectedRunId: url.searchParams.get("activeRun"),
      timelineStatus: timeline?.status,
      timelinePlanHash: timeline?.productionPlanHash,
      finalAssemblyStatus: assembly?.status,
      finalAssemblyPlanHash: assembly?.productionPlanHash,
      projectPlanHash: workspace.project.currentProductionPlanRef?.hash,
      workerPolicy: deps.smartWorkerPolicy
    })); return true;
  }
  if (batch) {
    if (!deps.batchGeneration) { json(res, 503, { message: "批量生成服务尚未配置" }); return true; }
    const projectId = decodeURIComponent(batch[1]!);
    if (req.method === "GET") json(res, 200, { selection: await deps.batchGeneration.preview(projectId) });
    else if (req.method === "POST") json(res, 200, { result: await deps.batchGeneration.submit({ projectId, ...batchSchema.parse(await body(req)) }) });
    else json(res, 405, { message: "不支持此请求方法" });
    return true;
  }
  if (preview) {
    if (!deps.smartGeneration) {
      json(res, 503, {
        message: "Director V3 影子预演服务尚未配置"
      });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { message: "不支持此请求方法" });
      return true;
    }
    const projectId = decodeURIComponent(preview[1]!);
    json(res, 200, {
      preview:
        await deps.smartGeneration.previewDirectorV3(
          projectId
        )
    });
    return true;
  }
  if (!smart) { json(res, 405, { message: "不支持此请求方法" }); return true; }
  if (!deps.smartGeneration) { json(res, 503, { message: "一键成片服务尚未配置" }); return true; }
  const service = deps.smartGeneration;
  const projectId = decodeURIComponent(smart[1]!), runId = smart[2] ? decodeURIComponent(smart[2]) : undefined, action = smart[3];
  // PVS-V8 shadow audit is strictly read-only: never creates/installs versions,
  // reuses paid approvals, runs models, or triggers any generation provider.
  if (action === "v8-shadow") {
    if (req.method !== "GET") { json(res, 405, { message: "导演对照预览只允许读取" }); return true; }
    if (!runId) { json(res, 400, { message: "请指定当前任务" }); return true; }
    const run = await service.get(projectId, runId);
    if (!run) { json(res, 404, { message: "任务不存在或不属于此项目" }); return true; }
    if (!run.script || !run.productionPlan) {
      json(res, 409, { message: "当前任务尚无完整剧本和正式分镜，无法进行导演对照预览" });
      return true;
    }
    const serialized = url.searchParams.get("bindings");
    let speakerBindings: Record<string, string> = {};
    if (serialized) {
      if (serialized.length > 3000) throw new DomainValidationError("人物绑定参数过长");
      try {
        speakerBindings = z.record(z.string().min(1).max(40), z.string().min(1).max(90))
          .parse(JSON.parse(serialized));
      } catch { throw new DomainValidationError("人物绑定格式无效，未修改任何任务"); }
    }
    const capabilities = run.productionPlan.generationTarget?.operationConstraints
      ?.filter(item => ["text2video", "multimodal2video"].includes(item.operation)) ?? [];
    const mins = capabilities.map(item => item.durationMinSeconds).filter((value): value is number => typeof value === "number");
    const maxes = capabilities.map(item => item.durationMaxSeconds).filter((value): value is number => typeof value === "number");
    if (!mins.length || !maxes.length) {
      json(res, 409, { message: "当前正式分镜缺少经过验证的模型时长能力，请先核实模型设置" });
      return true;
    }
    const fidelity = compileV8ShotShadow({
      script: run.script,
      plan: run.productionPlan,
      ...(run.directorV3Plan ? { director: run.directorV3Plan } : {}),
      ...(run.productionAssetSet ? { productionAssetSet: run.productionAssetSet } : {}),
      speakerBindings
    });
    const shotFirst = planV8ShotFirstShadow({
      script: run.script,
      modelMinSeconds: Math.max(...mins),
      modelMaxSeconds: Math.min(...maxes)
    });
    res.setHeader("cache-control", "no-store");
    json(res, 200, { preview: { screenplay: buildV8ScreenplayShadow(run.script), fidelity, shotFirst }, readOnly: true, paidSubmissions: 0 });
    return true;
  }
  if (req.method === "GET" && !action) {
    if (!runId) json(res, 200, { runs: await service.list(projectId) });
    else { const run = await service.get(projectId, runId); json(res, run ? 200 : 404, run ? { run } : { message: "任务不存在" }); }
    return true;
  }
  if (req.method !== "POST") { json(res, 405, { message: "不支持此请求方法" }); return true; }
  if (!runId) {
    const input = z.object({ requestKey: z.string().min(1).max(120), options: z.unknown() }).strict().parse(await body(req));
    json(res, 201, { run: await service.create(projectId, input.requestKey, input.options, 2) }); return true;
  }
  switch (action) {
    case "authorize-worker": json(res, 200, { run: await service.authorizeAutoAdvance(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      confirmCurrentTask: z.literal(true)
    }).strict().parse(await body(req))) }); break;
    case "director-v8": json(res, 200, { run: await service.updateDirectorV8(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(), visualGuidance: z.record(z.string().min(1), z.string().trim().min(1).max(1200))
    }).strict().parse(await body(req))) }); break;
    case "plan-v8": json(res, 200, { run: await service.updatePlanV8(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(), segments: z.array(z.object({ id: z.string().min(1),
        shotSize: z.string().trim().min(1).optional(), cameraPosition: z.string().trim().min(1).optional(),
        cameraAngle: z.string().trim().min(1).optional(), cameraMovement: z.string().trim().min(1).optional(),
        composition: z.string().trim().min(1).optional(), lighting: z.string().trim().min(1).optional()
      }).strict()).min(1).max(120)
    }).strict().parse(await body(req))) }); break;
    case "prompts-v8": json(res, 200, { run: await service.compilePromptV8(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(), voiceBindings: v8VoiceBindingsSchema, packages: z.unknown().optional()
    }).strict().parse(await body(req))) }); break;
    case "script-v8": json(res, 200, { run: await service.updateV8Screenplay(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      screenplay: z.unknown()
    }).strict().parse(await body(req))) }); break;
    case "repair-script-v3": json(res, 200, { run: await service.repairScriptV3(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      confirmScriptRepair: z.literal(true)
    }).strict().parse(await body(req))) }); break;
    case "script-v3": json(res, 200, { run: await service.updateScriptV3(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      beats: z.array(scriptBeatSchema).min(1).max(30)
    }).strict().parse(await body(req))) }); break;
    case "storyboard-v3": json(res, 200, { run: await service.updateClipContractV3(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      clipId: z.string().min(1),
      purpose: z.string().trim().min(1).max(2000),
      location: z.string().trim().min(1).max(300),
      actionDescriptions: z.array(z.string().trim().min(1).max(1000)).min(1).max(5),
      camera: z.object({
        shotSize: z.string().trim().min(1).max(300),
        position: z.string().trim().min(1).max(500),
        angle: z.string().trim().min(1).max(300),
        movement: z.string().trim().min(1).max(500)
      }).strict(),
      audio: z.object({
        ambience: z.array(z.string().trim().min(1).max(500)).max(10),
        sfx: z.array(z.string().trim().min(1).max(500)).max(10),
        dialogueOrOs: z.array(z.object({
          kind: z.enum(["DIALOGUE", "OS"]),
          text: z.string().trim().min(1).max(1000)
        }).strict()).max(10)
      }).strict()
    }).strict().parse(await body(req))) }); break;
    case "prompt-v3": json(res, 200, { run: await service.updatePromptV3(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      clipId: z.string().min(1),
      prompt: z.string().trim().min(1).max(12000)
    }).strict().parse(await body(req))) }); break;
    case "retry-asset": json(res, 200, { run: await service.retryAsset(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      assetKey: z.string().min(1),
      prompt: z.string().trim().min(1).max(12000).optional()
    }).strict().parse(await body(req))) }); break;
    case "asset-prompt": json(res, 200, { run: await service.updateAssetPrompt(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      assetKey: z.string().min(1),
      prompt: z.string().trim().min(1).max(12000)
    }).strict().parse(await body(req))) }); break;
    case "regenerate-asset": json(res, 200, { run: await service.regenerateAsset(projectId, runId, z.object({
      expectedRevision: z.number().int().positive(),
      assetKey: z.string().min(1),
      prompt: z.string().trim().min(1).max(12000).optional()
    }).strict().parse(await body(req))) }); break;
    case "asset-paid": json(res, 200, { run: await service.confirmAssetPaid(projectId, runId, z.object({
      scopeHash: z.string().regex(/^[a-f0-9]{64}$/i),
      confirmPaidAssetGeneration: z.boolean(),
      acceptedUnknownCostRisk: z.boolean()
    }).strict().parse(await body(req))) }); break;
    case "paid": json(res, 200, { run: await service.confirmPaid(projectId, runId, z.object({ scopeHash: z.string().regex(/^[a-f0-9]{64}$/i), confirmPaidGeneration: z.boolean(), acceptedUnknownCostRisk: z.boolean() }).strict().parse(await body(req))) }); break;
    case "review": json(res, 200, { run: await service.review(projectId, runId, z.object({
      action: z.enum(["SELECT_CREATIVE", "CONFIRM_ASSET", "CONFIRM_SCRIPT", "CONFIRM_PLAN", "CONFIRM_V8_DIRECTOR", "CONFIRM_V8_PROMPTS"]),
      expectedRevision: z.number().int().positive(),
      creativeId: z.string().optional(),
      assetKey: z.string().optional(),
      confirmV8Screenplay: z.boolean().optional(),
      screenplayHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      confirmV8Review: z.boolean().optional(), artifactHash: z.string().regex(/^[a-f0-9]{64}$/i).optional()
    }).strict().parse(await body(req))) }); break;
    case "resume": json(res, 200, { run: await service.resume(projectId, runId, z.object({expectedRevision:z.number().int().positive().optional()}).strict().parse(await body(req)).expectedRevision) }); break;
    case "post-production": json(res, 200, { run: await service.configurePostProduction(projectId, runId, z.object({ expectedRevision: z.number().int().positive(), settings: z.unknown() }).strict().parse(await body(req))) }); break;
    case "adopt-timeline": json(res, 200, { run: await service.adoptTimeline(projectId, runId, z.object({ expectedRevision: z.number().int().positive(), timelineId: z.string().min(1), timelineHash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(await body(req))) }); break;
    case "cancel": json(res, 200, { run: await service.cancel(projectId, runId) }); break;
    case "final-confirmed": json(res, 200, { run: await service.confirmFinal(projectId, runId, z.object({expectedRevision:z.number().int().positive().optional()}).strict().parse(await body(req)).expectedRevision) }); break;
    default: json(res, 404, { message: "不存在的编排操作" });
  }
  return true;
}
