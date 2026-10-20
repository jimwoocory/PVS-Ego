import { randomUUID } from "node:crypto";
import path from "node:path";
import { hashValue } from "../../domain/hashing.js";
import type {CanvasVideoResultService} from "./canvas-video-result-service.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { SmartGenerationRun, WorkspaceBinding } from "../../domain/smart-generation.js";
import { SmartFlowPause, type SmartProduction } from "../ports/smart-production.js";
import type { ProductInputStore } from "../ports/product-input-store.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { FinalOutputRepository } from "../ports/final-output-repository.js";
import type { ProductFlowService, ProjectWorkspace } from "./product-flow.js";
import type { AiGenerationService } from "./ai-generation.js";
import type { ProductDirectorService } from "./product-director.js";
import type { ResearchService } from "./research-service.js";
import type { ReferenceVideoAnalysisService } from "./reference-video-analysis.js";
import type { GenerationPreflightService, RunPreflightResult } from "./generation-preflight.js";
import type { DreaminaAgentCapabilityService } from "./dreamina-agent-capability.js";
import type { ApprovalService } from "./approval-service.js";
import type { GenerationExecutionService } from "./generation-execution.js";
import type { BatchGenerationService } from "./batch-generation-service.js";
import type { RenderEngine } from "./render-engine.js";
import type { TimelineService } from "./timeline-service.js";
import { assertCanonicalProductArtifactReady, confirmProductionPlanDraft, confirmScriptDraft, reviseScriptDraft } from "./review-actions.js";
import { resolveDirectorGenerationTarget, assertDirectorSettingsMatch } from "./director-generation-target.js";
import { validateReferenceImagesForPreflight } from "../../adapters/media/reference-image-validator.js";
import { AutoEditBlocked } from "../../domain/auto-edit.js";
import {CreativeReferenceService} from "./creative-reference-service.js";
import {referenceSetRef} from "./creative-reference-binding.js";
import type { ReviewService } from "./review-service.js";
import type { VisualEditAssessmentService } from "./visual-edit-assessment.js";
import type { ProductionPlannerService } from "./production-planner.js";
import type { ProductionAssetService } from "./production-asset-service.js";
import type { ScriptFeasibilityService } from "./script-feasibility-service.js";
import { reviseV8DetailedProposal, type V8DetailedScreenplayService } from "./v8-detailed-screenplay-service.js";
import type { DirectorV3PlannerService } from "./director-v3-planner-service.js";
import {
  buildSeedancePromptV3,
  createSeedancePromptV3Draft
} from "./seedance-model-prompt-v3.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import {
  productionAssetSetRef,
  type ProductionAssetSet
} from "../../domain/production-strategy.js";
import { sealV8, type V8PromptRecord } from "../../domain/v8-production.js";
import { buildV8DirectorDecision } from "./v8-director-decision.js";
import { compileV8AuthoritativePrompts } from "./v8-authoritative-prompt.js";
import { firstSourceIndependentClipIds } from "./clip-continuity-engine.js";
import { planNextContinuityWave } from "./continuity-wave-planner.js";
import { loadReviewedContinuitySource } from "./reviewed-continuity-source.js";
import { bindReviewedContinuitySource, appendReviewedContinuityInstruction, type SourceBinding } from "./continuity-request-compiler.js";
import { assertV8DecisionBinding, assertV8PlanBinding, assertV8PromptBinding } from "./v8-production-binding.js";
import { directorClipBounds } from "./director-generation-target.js";
import { assertV8TimelineConformance } from "./v8-timeline-conformance.js";
import { scriptDraftSchema, productionPlanSchema } from "../../domain/schemas.js";
import { readSavedProductionPlanning, compileExistingDirector } from "./production-continuation.js";
import type {CanvasProductionService} from "./canvas-production-service.js";
import type {CanvasProductionBinding} from "../../domain/canvas-production.js";
import {CanvasVideoPreflightService} from "./canvas-video-preflight.js";
import {CanvasShortPreviewService} from "./canvas-short-preview-service.js";
import type {CanvasShortProductionService} from "./canvas-short-production.js";
import {CanvasShortDeliveryService} from "./canvas-short-delivery.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import type {CanvasShortPreview} from "../../domain/canvas-short-preview.js";

type Ref = NonNullable<SmartGenerationRun["truthRef"]>;
function ref(entityType: string, value: { id: string; version: number; contentHash: string }): Ref {
  return { entityType, entityId: value.id, version: value.version, hash: value.contentHash };
}
export function workspaceBinding(workspace: ProjectWorkspace): WorkspaceBinding {
  const p = workspace.project;
  return { productTruthRef: p.currentProductTruthRef, creativeBatchRef: p.currentCreativeBatchRef,
    selectedCreativeId: p.selectedCreativeId, scriptRef: p.currentScriptRef, productionPlanRef: p.currentProductionPlanRef };
}
function equal(a: unknown, b: unknown) { return hashValue(a ?? null) === hashValue(b ?? null); }
function scopeHash(scope: NonNullable<SmartGenerationRun["paidScope"]>) { return hashValue({ planRef: scope.planRef, requests: scope.requests, ...(scope.v8Binding ? { v8Binding: scope.v8Binding } : {}), ...(scope.continuityBatch ? {continuityBatch:scope.continuityBatch} : {}) }); }
function bindScriptProductionAssets(
  script: ReturnType<typeof scriptDraftSchema.parse>,
  set?: ProductionAssetSet
) {
  if (!set) return script;
  const { contentHash: _oldHash, ...base } = script;
  const next = {
    ...base,
    productionAssetSetRef: productionAssetSetRef(set)
  };
  return scriptDraftSchema.parse({
    ...next,
    contentHash: hashValue(next)
  });
}

export type SmartProductionDependencies = {
  canvasShortProduction?:CanvasShortProductionService;
  canvasProduction?:CanvasProductionService;
  canvasVideoResults?:CanvasVideoResultService;
  productFlow: ProductFlowService; productInput: ProductInputStore; artifacts: ArtifactRepository;
  aiGeneration: AiGenerationService; productDirector: ProductDirectorService;
  referenceVideo: ReferenceVideoAnalysisService; research: ResearchService;
  generation: GenerationRepository; workflow: WorkflowRepository; review: ReviewRepository;
  dreaminaCapability: DreaminaAgentCapabilityService; preflight: GenerationPreflightService;
  approval: ApprovalService; execution: GenerationExecutionService; batchGeneration: BatchGenerationService;
  finalOutput: FinalOutputRepository; renderEngine: RenderEngine; projectsRoot: string;
  timeline?: Pick<TimelineService, "latestTimeline">;
  creativeReferences?: CreativeReferenceService;
  reviewService?: Pick<ReviewService, "decide">;
  visualReview?: VisualEditAssessmentService;
  productionPlanner?: ProductionPlannerService;
  productionAssets?: ProductionAssetService;
  scriptFeasibility?: ScriptFeasibilityService;
  v8Screenplay?: V8DetailedScreenplayService;
  directorV3Planner?: DirectorV3PlannerService;
  preflightAudit: (projectId: string, result: RunPreflightResult) => Promise<void>;
  autoEdit?: (run: SmartGenerationRun) => ReturnType<SmartProduction["autoEdit"]>;
};

/** Bridge to the established P1 services, not a second generation/approval implementation. */
export class ApplicationSmartProduction implements SmartProduction {
  constructor(private readonly d: SmartProductionDependencies) {}
  private canvasPreflight(){
    if(!this.d.canvasProduction)throw new DomainValidationError("Canvas后台未配置");
    return new CanvasVideoPreflightService(this.d.canvasProduction,this.d.generation,this.d.artifacts,this.d.projectsRoot,()=>this.canvasVideoDeliveryReadiness());
  }
  async inspectCanvasPreflight(run:SmartGenerationRun){
    await this.assertCurrent(run);const result=await this.canvasPreflight().inspect(run);
    return {...result,requiresPaidConfirmation:true,requiresHumanReview:true};
  }
  async quoteCanvasShort(run:SmartGenerationRun,input:unknown,checkpoint:(p:CanvasShortPreview)=>Promise<void>){
    await this.assertCurrent(run);
    if(!this.d.canvasProduction)throw new DomainValidationError("Canvas后台未配置");
    return new CanvasShortPreviewService(this.d.canvasProduction).quote(run,input,checkpoint);
  }
  async shortPlanAction(run:SmartGenerationRun,action:string,input:Record<string,any>,confirmed:boolean,save:(p:CanvasShortPlan)=>Promise<void>){
    const service=this.d.canvasShortProduction;if(!service)throw new DomainValidationError("15秒制作服务未配置");
    if(!["advance","assemble","inspect"].includes(action))await this.assertCurrent(run);
    if(action==="draft"){const p=await service.createDraft(run,input.previewId,input.rejectedPlanId);await save(p);return p;}
    const p=run.canvasShortPlans?.find(p=>p.id===input.planId);if(!p)throw new DomainValidationError("找不到本任务的15秒计划");
    switch(action){
      case "revise-style":return service.reviseStyle(run,p,save);
      case "edit-visual":return service.editVisualDraft(run,p,input.expectedHeadHash,input.proposal,save);
      case "review-visual":return service.reviewVisualDesign(run,p,input.revisionId,input.contentHash,confirmed,save);
      case "inspect":return service.inspect(run,p);
      case "review-plan":return service.reviewPlan(run,p,input.contentHash,confirmed,save);
      case "quote":return service.quote(run,p,save);
      case "reference-quote":return service.quoteReferences(run,p,input.revisionHash,input.imagePrompt,save);
      case "generate-zero-reference":return service.generateZeroReference(run,p,input.revisionHash,input.requestHash,confirmed,save);
      case "sync-reference":return service.syncReference(run,p,save);
      case "adopt-reference":return service.adoptReference(run,p,input.revisionHash,input.artifactId,input.sha256,confirmed,save);
      case "quote-bound-video":return service.quoteBoundVideo(run,p,save);
      case "prepare":return service.prepare(run,p,save);
      case "authorize":return service.authorize(run,p,input.scopeHash,confirmed,save);
      case "advance":return service.advance(run,p,save);
      case "review-clip":return service.reviewClip(run,p,input.attemptId,input.sha256,input.decision,confirmed,save);
      case "assemble":return service.assemble(run,p,save);
      case "accept-final":return service.acceptFinal(run,p,input.sha256,confirmed,save);
      case "tail-preview":{if(p.visualRevisions?.length)throw new DomainValidationError("仿真人修订稿尚待审核，请勿沿用旧版尾卡或参考绑定");
        const result=await new CanvasShortDeliveryService(this.d.artifacts,this.d.projectsRoot).previewTail(p);
        p.tailPreview={artifactId:result.artifactId,sha256:result.sha256!,durationMs:3000};await save(p);return result;}
      default:throw new DomainValidationError("未知15秒制作动作");
    }
  }
  async canvasVideoDeliveryReadiness(){
    return this.d.canvasVideoResults?this.d.canvasVideoResults.readiness():{ready:false,code:"CANVAS_VIDEO_RESULT_SERVICE_MISSING",message:"Canvas视频结果适配尚未配置"};
  }
  async syncCanvasVideoResult(run:SmartGenerationRun,clipId:string,checkpoint:(binding:CanvasProductionBinding)=>Promise<void>){
    if(!this.d.canvasVideoResults)throw new DomainValidationError("Canvas视频结果服务尚未配置");
    await this.assertCurrent(run);return this.d.canvasVideoResults.sync(run,clipId,checkpoint);
  }
  async quoteCanvasImages(run:SmartGenerationRun){
    if(!this.d.canvasProduction)throw new DomainValidationError("Canvas后台尚未配置");
    await this.assertCurrent(run);return this.d.canvasProduction.quoteSaved(run,"IMAGE");
  }
  async recoverCanvasImages(run:SmartGenerationRun,checkpoint:(binding:CanvasProductionBinding)=>Promise<void>){
    if(!this.d.canvasProduction)throw new DomainValidationError("Canvas后台尚未配置");
    await this.assertCurrent(run);return this.d.canvasProduction.recoverImages(run,checkpoint);
  }
  async quoteCurrent(run:SmartGenerationRun,checkpoint:(binding:CanvasProductionBinding)=>Promise<void>){
    if(!this.d.canvasProduction)return undefined;
    if(run.canvasBinding?.imageBudgetGrant&&run.canvasBinding.originalQuoteRequest){
      if(run.canvasBinding.sourcePlanHash!==run.productionPlan?.contentHash){
        const w=await this.workspace(run.projectId);
        if(!w.productTruth||!run.script||!run.productionPlan||!run.productionAssetSet)throw new DomainValidationError("Canvas分镜重新绑定缺少当前资料");
        const compiled=compileExistingDirector({truth:w.productTruth,script:run.script,plan:run.productionPlan,assets:run.productionAssetSet});
        await this.d.canvasProduction.rebindUnspentPlan(run,compiled.seedancePromptDrafts,checkpoint);
      }
      const quote=await this.d.canvasProduction.quoteSaved(run),priced=quote.items.filter(i=>i.result.status==="QUOTED");
      const first=priced[0]?.result;
      if(first?.status==="QUOTED"&&first.canvas&&first.sourceRequestId){
        const binding={...run.canvasBinding,draftVersion:first.canvas.draftVersion,checkedAt:new Date().toISOString(),quoteObservation:{requestId:first.sourceRequestId,draftVersion:first.canvas.draftVersion,
          confirmable:quote.status==="QUOTED",totalMaxCredits:priced.reduce((s,i)=>s+(i.result.status==="QUOTED"?i.result.credits:0),0),
          items:quote.items.map(i=>i.result.status==="QUOTED"?{nodeId:i.result.canvas!.nodeId,maxCredits:i.result.credits}:{nodeId:run.canvasBinding!.nodes.find(n=>n.key===i.request.key)!.nodeId,reason:i.result.code})}};
        await checkpoint(binding);
      }
      return quote;
    }
    const workspace=await this.d.productFlow.getWorkspace(run.projectId);
    const product=run.productionAssetSet?.entries.find(e=>e.kind==="PRODUCT"&&e.source==="PRODUCT_INPUT");
    const artifact=product?.artifactIds[0]?await this.d.artifacts.findById(product.artifactIds[0]):null;
    if(!workspace?.productTruth||!artifact?.sha256||artifact.projectId!==run.projectId||artifact.integrityStatus!=="READY")
      throw new DomainValidationError("Canvas报价缺少原项目已验证的产品资料或主图");
    const root=path.resolve(this.d.projectsRoot,run.projectId),file=path.resolve(root,artifact.relativePath);
    if(!file.startsWith(root+path.sep))throw new DomainValidationError("产品参考图路径不属于当前项目");
    return this.d.canvasProduction.quote(run,{truth:workspace.productTruth,product:{path:file,sha256:artifact.sha256}},checkpoint);
  }
  private async workspace(projectId: string) {
    const workspace = await this.d.productFlow.getWorkspace(projectId);
    if (!workspace) throw new DomainValidationError("项目不存在");
    return workspace;
  }
  async initial(projectId: string) {
    const w = await this.workspace(projectId);
    return { targetDurationMs: w.project.targetDurationMs, binding: workspaceBinding(w) };
  }
  async continueWorkspace(projectId: string, input: { artifactId: string; artifactHash: string; scriptHash: string; planHash: string; requestText: string }) {
    const w = await this.workspace(projectId);
    if (!w.script || !w.productionPlan || !w.creativeBatch || !w.productTruth ||
        w.script.contentHash !== input.scriptHash || w.productionPlan.contentHash !== input.planHash ||
        w.project.selectedCreativeId !== w.script.selectedCreativeId) throw new DomainValidationError("当前脚本或分镜已变化，不能续接旧版本");
    const saved = await readSavedProductionPlanning({ ...input, projectId, artifacts: this.d.artifacts,
      store: new LocalArtifactStore(path.resolve(this.d.projectsRoot, projectId), this.d.artifacts), script: w.script, plan: w.productionPlan });
    const target = w.productionPlan.generationTarget;
    if (!target) throw new DomainValidationError("当前分镜没有明确模型和规格");
    const options: SmartGenerationRun["options"] = { requestText: input.requestText,
      generationSettings: { requestedModelVersion: target.requestedModelVersion, aspectRatio: target.aspectRatio, videoResolution: target.videoResolution,
        nativeAudioOutputRequested: target.nativeAudioOutputRequested }, directorVersion: 3, reviewMode: "MANUAL",
      autoSelectLowRiskClips: false, useExistingResearch: false, useResearchReferences: false, allowSilentOutput: false };
    const sources = await this.sources({ projectId, options } as SmartGenerationRun);
    return { ...sources, options, targetDurationMs: w.project.targetDurationMs, creativeBatch: w.creativeBatch,
      selectedCreativeId: w.project.selectedCreativeId, script: w.script, productionPlan: w.productionPlan,
      productionStrategy: saved.assets.strategy, productionAssetSet: saved.assets.set, assetPaidScope: saved.assets.paidScope,
      workspaceContinuation: { sourceArtifactId: input.artifactId, sourceArtifactHash: input.artifactHash,
        scriptRef: ref("ScriptDraft", w.script), planRef: ref("ProductionPlan", w.productionPlan), assetsBound: false,
        localPostProductionPending: Boolean(saved.ending?.mode === "LOCAL_COMPOSITION") } };
  }
  async bindContinuationPlan(run: SmartGenerationRun) {
    await this.assertCurrent(run);
    const w = await this.workspace(run.projectId);
    if (!run.workspaceContinuation || !run.productionPlan || !run.script || !w.productTruth || run.productionAssetSet?.status !== "READY")
      throw new DomainValidationError("实际角色场景尚未审核齐全，不能绑定现有分镜");
    const { contentHash: _hash, ...previous } = run.productionPlan;
    const body = { ...previous, id: randomUUID(), version: await this.d.productFlow.nextVersion(run.projectId, "ProductionPlan", "production-plan"),
      status: "DRAFT" as const, productionAssetSetRef: productionAssetSetRef(run.productionAssetSet) };
    const productionPlan = productionPlanSchema.parse({ ...body, contentHash: hashValue(body) });
    return { productionPlan, ...compileExistingDirector({ truth: w.productTruth, script: run.script, plan: productionPlan, assets: run.productionAssetSet }) };
  }
  async sources(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    const truth = w.productTruth;
    if (!truth || truth.status !== "CONFIRMED") throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW", "TRUTH_REVIEW_REQUIRED", "请先在产品事实页确认事实与使用规则，再恢复本任务");
    if ((truth.usageRules ?? []).some((r) => r.status === "UNVERIFIED" && !r.dispositionConfirmedByUser)) throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW", "USAGE_REVIEW_REQUIRED", "存在尚未处理的使用规则，需要用户审核");
    const material = await this.d.productInput.latest(run.projectId);
    if (!material) throw new SmartFlowPause("BLOCKED", "PRODUCT_INPUT_MISSING", "请先保存产品资料和产品主图");
    assertCanonicalProductArtifactReady(truth, material.assets, await this.d.artifacts.listByProject(run.projectId));
    const references=await this.d.creativeReferences?.current(run.projectId);
    if (run.options.useResearchReferences&&!references) throw new SmartFlowPause("WAITING_FOR_REFERENCE_REVIEW", "CREATIVE_REFERENCE_SET_NOT_READY", "请先在创作参考素材池明确确认本轮参考；未审核图片不能进入生成");
    const profile = await this.d.referenceVideo.latest(run.projectId);
    const brief = run.options.useExistingResearch ? (await this.d.research.pageData(run.projectId)).brief : undefined;
    if (run.options.useExistingResearch && (!brief || brief.status !== "READY")) throw new SmartFlowPause("BLOCKED", "RESEARCH_NOT_READY", "已选择使用研究内容，但当前没有可用研究简报");
    if (brief) {
      const reviewedStatements = new Set([
        ...truth.confirmedFeatures.map((f) => f.statement), ...truth.sellingPoints.map((f) => f.statement),
        ...truth.uncertainClaims.filter((c) => c.dispositionConfirmedByUser).map((c) => c.statement),
        ...(truth.usageRules ?? []).filter((r) => r.dispositionConfirmedByUser || r.status === "CONFIRMED").map((r) => r.statement)
      ]);
      if ([...brief.candidateClaims, ...brief.usageRules].some((c) => c.status !== "REJECTED" && !reviewedStatements.has(c.statement))) {
        throw new SmartFlowPause("WAITING_FOR_TRUTH_REVIEW", "RESEARCH_CANDIDATES_UNREVIEWED", "研究含新事实或使用规则候选；请送入产品事实审核并明确处理后再恢复，不会静默提升为事实");
      }
    }
    return { truthRef: ref("ProductTruth", truth), assetsHash: material.contentHash,
      ...(profile?.status === "ACTIVE" ? { referenceVideoProfile: profile } : {}),
      creativeContext: { requestText: run.options.requestText, ...(references?{references}:{}), ...(brief ? { research: {
        briefId: brief.id, contentHash: brief.contentHash, contentOpportunities: brief.contentOpportunities,
        uncertainties: brief.uncertainties, rule: "STRUCTURE_ONLY_NOT_PRODUCT_FACTS" as const
      } } : {}) }, expectedWorkspace: workspaceBinding(w) };
  }
  private async assertSources(run: SmartGenerationRun, w: ProjectWorkspace) {
    await this.d.creativeReferences?.assertExpected(run.projectId,referenceSetRef(run.creativeContext?.references));
    if (!w.productTruth || w.productTruth.status !== "CONFIRMED" || !equal(run.truthRef, ref("ProductTruth", w.productTruth)) || w.project.targetDurationMs !== run.targetDurationMs) {
      throw new SmartFlowPause("BLOCKED", "SOURCE_CHANGED", "产品事实或目标时长已改变；请取消旧任务并重新规划，旧付费范围不扩展", false);
    }
    const input = await this.d.productInput.latest(run.projectId);
    if (input?.contentHash !== run.assetsHash) throw new SmartFlowPause("BLOCKED", "ASSETS_CHANGED", "产品素材已变化，旧任务不可继续使用旧审批", false);
    const profile = await this.d.referenceVideo.latest(run.projectId);
    if (!equal(run.referenceVideoProfile?.contentHash, profile?.status === "ACTIVE" ? profile.contentHash : undefined)) throw new SmartFlowPause("BLOCKED", "REFERENCE_CHANGED", "参考视频已变化，请重新规划", false);
    if (run.creativeContext?.research) {
      const brief = (await this.d.research.pageData(run.projectId)).brief;
      if (!brief || brief.status !== "READY" || brief.id !== run.creativeContext.research.briefId || brief.contentHash !== run.creativeContext.research.contentHash) throw new SmartFlowPause("BLOCKED", "RESEARCH_CHANGED", "研究来源已变化，需要重新审核与规划", false);
    }
  }
  async assertCurrent(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    await this.assertSources(run, w);
    if (!equal(workspaceBinding(w), run.expectedWorkspace)) throw new SmartFlowPause("BLOCKED", "WORKSPACE_CHANGED", "标准流程已更新创意、脚本或分镜；本任务暂停，避免覆盖新版本", false);
    if (run.workflowVersion === 2 && run.productionAssetSet) {
      const assetRef = productionAssetSetRef(run.productionAssetSet);
      if (
        run.script?.productionAssetSetRef &&
        !equal(run.script.productionAssetSetRef, assetRef)
      ) {
        throw new SmartFlowPause(
          "BLOCKED",
          "PRODUCTION_ASSET_SET_CHANGED",
          "脚本绑定的角色/场景制作资产已经变化，需要重新规划",
          false
        );
      }
      if (
        run.productionPlan?.productionAssetSetRef &&
        !(run.workspaceContinuation && !run.workspaceContinuation.assetsBound) &&
        !equal(run.productionPlan.productionAssetSetRef, assetRef)
      ) {
        throw new SmartFlowPause(
          "BLOCKED",
          "PRODUCTION_ASSET_SET_CHANGED",
          "导演分镜绑定的角色/场景制作资产已经变化，需要重新规划",
          false
        );
      }
    }
  }
  async creative(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    return this.d.aiGeneration.generateCreativeBatch(
      w.productTruth!,
      await this.d.productFlow.nextVersion(
        run.projectId,
        "CreativeBatch",
        "creative-batch"
      ),
      run.targetDurationMs,
      run.referenceVideoProfile,
      run.creativeContext,
      run.options.directorVersion ?? 2
    );
  }
  async planProduction(run: SmartGenerationRun) {
    if (!this.d.productionPlanner) {
      throw new SmartFlowPause(
        "BLOCKED",
        "PRODUCTION_PLANNER_NOT_READY",
        "制作策略规划器尚未配置"
      );
    }
    const w = await this.workspace(run.projectId);
    if (!w.productTruth || !run.creativeBatch || !run.selectedCreativeId) {
      throw new DomainValidationError("创意尚未选择，不能制定制作策略");
    }
    return this.d.productionPlanner.plan({
      projectId: run.projectId,
      version: 1,
      truth: w.productTruth,
      creativeBatch: run.creativeBatch,
      selectedCreativeId: run.selectedCreativeId,
      targetDurationMs: run.targetDurationMs,
      referenceVideoProfile: run.referenceVideoProfile,
      creativeContext: run.creativeContext
    });
  }
  async prepareProductionAssets(run: SmartGenerationRun) {
    if (!this.d.productionAssets) {
      throw new SmartFlowPause(
        "BLOCKED",
        "PRODUCTION_ASSET_SERVICE_NOT_READY",
        "制作资产服务尚未配置"
      );
    }
    const w = await this.workspace(run.projectId);
    const material = await this.d.productInput.latest(run.projectId);
    if (!w.productTruth || !material || !run.productionStrategy) {
      throw new DomainValidationError("制作资产准备所需的产品事实或制作策略不完整");
    }
    return this.d.productionAssets.prepare({
      strategy: run.productionStrategy,
      truth: w.productTruth,
      productInput: material,
      creativeReferences: run.creativeContext?.references
    });
  }
  async validateAssetPaidScope(run: SmartGenerationRun) {
    if (!this.d.productionAssets || !run.productionStrategy || !run.productionAssetSet || !run.assetPaidScope) {
      throw new DomainValidationError("制作资产付费范围尚未准备");
    }
    await this.assertCurrent(run);
    if(run.canvasBinding){
      if(!this.d.canvasProduction)throw new DomainValidationError("当前任务绑定Canvas，不能退回旧图片通道");
      await this.d.canvasProduction.validateBudget(run,"IMAGE");return;
    }
    await this.d.productionAssets.validatePaidScope({
      strategy: run.productionStrategy,
      set: run.productionAssetSet,
      scope: run.assetPaidScope
    });
  }
  async advanceProductionAssets(run: SmartGenerationRun,checkpoint?:(binding:CanvasProductionBinding)=>Promise<void>) {
    if (!this.d.productionAssets || !run.productionStrategy || !run.productionAssetSet) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    const material = await this.d.productInput.latest(run.projectId);
    if (!material) throw new DomainValidationError("产品输入不存在");
    if(run.canvasBinding&&(!this.d.canvasProduction||!checkpoint))throw new DomainValidationError("Canvas执行缺少持久预算检查点，不能退回旧生成通道");
    const service=run.canvasBinding?this.d.productionAssets.withImageProvider(this.d.canvasProduction!.imageProvider(run,checkpoint!)):this.d.productionAssets;
    return service.advance({
      ...(run.canvasBinding?{concurrency:1}:{}),
      set: run.productionAssetSet,
      strategy: run.productionStrategy,
      productInput: material,
      creativeReferences: run.creativeContext?.references
    });
  }
  async acceptProductionAsset(run: SmartGenerationRun, key: string) {
    if (!this.d.productionAssets || !run.productionAssetSet) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.acceptReview(run.productionAssetSet, key);
  }
  async reconcileProductionAssetReview(run: SmartGenerationRun) {
    if (!this.d.productionAssets || !run.productionAssetSet) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.reconcileHumanReview(run.productionAssetSet);
  }
  async recoverProductionAssetResults(run: SmartGenerationRun) {
    if (!this.d.productionAssets || !run.productionAssetSet) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.recoverResultProcessing(run.productionAssetSet);
  }
  async updateProductionAssetPrompt(run: SmartGenerationRun, key: string, prompt: string) {
    if (
      !this.d.productionAssets ||
      !run.productionStrategy ||
      !run.productionAssetSet
    ) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.updatePrompt(
      run.productionAssetSet,
      run.productionStrategy,
      key,
      prompt
    );
  }
  async regenerateProductionAsset(run: SmartGenerationRun, key: string, prompt?: string) {
    if (
      !this.d.productionAssets ||
      !run.productionStrategy ||
      !run.productionAssetSet
    ) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.regenerateReview(
      run.productionAssetSet,
      run.productionStrategy,
      key,
      prompt
    );
  }
  async retryProductionAsset(run: SmartGenerationRun, key: string, prompt?: string) {
    if (
      !this.d.productionAssets ||
      !run.productionStrategy ||
      !run.productionAssetSet
    ) {
      throw new DomainValidationError("制作资产尚未准备");
    }
    return this.d.productionAssets.retryUnknown(
      run.productionAssetSet,
      run.productionStrategy,
      key,
      prompt
    );
  }
  async script(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    const draft = await this.d.aiGeneration.generateScriptDraft({ truth: w.productTruth!, batch: run.creativeBatch!,
      selectedCreativeId: run.selectedCreativeId!, version: await this.d.productFlow.nextVersion(run.projectId, "ScriptDraft", "script"),
      targetDurationMs: run.targetDurationMs, referenceVideoProfile: run.referenceVideoProfile, creativeContext: run.creativeContext,
      directorVersion: run.options.directorVersion ?? 2 });
    return bindScriptProductionAssets(
      draft,
      run.workflowVersion === 2 ? run.productionAssetSet : undefined
    );
  }
  async scriptV8(run: SmartGenerationRun) {
    if (!this.d.v8Screenplay || run.options.directorPipeline !== "V8") {
      throw new DomainValidationError("当前任务未启用 V8 详细剧本生成器");
    }
    const w = await this.workspace(run.projectId);
    if (!w.productTruth || !run.creativeBatch || !run.selectedCreativeId) {
      throw new DomainValidationError("V8 剧本必须先确认产品事实、创意方案及制作资产");
    }
    const generated = await this.d.v8Screenplay.propose({
      truth: w.productTruth,
      batch: run.creativeBatch,
      selectedCreativeId: run.selectedCreativeId,
      userBrief: run.options.requestText,
      targetDurationMs: run.targetDurationMs,
      version: await this.d.productFlow.nextVersion(run.projectId, "ScriptDraft", "script"),
      researchPatterns: run.creativeContext?.research?.contentOpportunities
    });
    const script = bindScriptProductionAssets(
      generated.legacyScriptDraft,
      run.productionAssetSet
    );
    return { script, screenplay: generated.screenplay };
  }

  async reviseV8Screenplay(run: SmartGenerationRun, screenplay: unknown) {
    if (run.options.directorPipeline !== "V8" || !run.script || !run.creativeBatch ||
        !run.selectedCreativeId) {
      throw new DomainValidationError("只有未确认的 V8 详细剧本可以在此编辑");
    }
    const w = await this.workspace(run.projectId);
    if (!w.productTruth) throw new DomainValidationError("V8 剧本缺少本轮产品事实");
    const revised = reviseV8DetailedProposal({
      screenplay,
      existingScript: run.script,
      truth: w.productTruth,
      batch: run.creativeBatch,
      selectedCreativeId: run.selectedCreativeId,
      targetDurationMs: run.targetDurationMs
    });
    return bindScriptProductionAssets(revised, run.productionAssetSet);
  }

  async scriptV3(run: SmartGenerationRun) {
    if (!this.d.scriptFeasibility) {
      throw new SmartFlowPause(
        "BLOCKED",
        "DIRECTOR_V3_SCRIPT_QA_NOT_READY",
        "Director V3 脚本可生成性 QA 尚未配置",
        false
      );
    }
    const w = await this.workspace(run.projectId);
    if (!w.productTruth || !run.creativeBatch || !run.selectedCreativeId) {
      throw new DomainValidationError(
        "Director V3 脚本所需产品事实或创意尚未准备"
      );
    }
    let script = await this.d.aiGeneration.generateScriptDraft({
      truth: w.productTruth,
      batch: run.creativeBatch,
      selectedCreativeId: run.selectedCreativeId,
      version: await this.d.productFlow.nextVersion(
        run.projectId,
        "ScriptDraft",
        "script"
      ),
      targetDurationMs: run.targetDurationMs,
      referenceVideoProfile: run.referenceVideoProfile,
      creativeContext: run.creativeContext,
      directorVersion: 3
    });
    script = bindScriptProductionAssets(
      script,
      run.workflowVersion === 2
        ? run.productionAssetSet
        : undefined
    );
    let feasibility = this.d.scriptFeasibility.review(script);
    for (
      let repairPass = 0;
      repairPass < 2 && feasibility.status === "REVISE";
      repairPass += 1
    ) {
      script = await this.d.scriptFeasibility.repair({
        truth: w.productTruth,
        batch: run.creativeBatch,
        script,
        report: feasibility
      });
      script = bindScriptProductionAssets(
        script,
        run.workflowVersion === 2
          ? run.productionAssetSet
          : undefined
      );
      feasibility = this.d.scriptFeasibility.review(script);
    }
    if (feasibility.status !== "PASS") {
      throw new SmartFlowPause(
        "BLOCKED",
        "DIRECTOR_V3_SCRIPT_QA_FAILED",
        "Director V3 自动修复后脚本仍然过载，请人工修改脚本后再继续",
        false
      );
    }
    return { script, feasibility };
  }
  /** User-triggered regeneration of the saved script's deficient timing/detail.
   * Retains the approved story/characters and product assets; makes a fresh
   * ScriptDraft version, while the caller invalidates every downstream scope.
   */
  async repairNarrativeScriptV3(run: SmartGenerationRun) {
    if (!this.d.scriptFeasibility || !run.script || !run.creativeBatch || !run.selectedCreativeId) {
      throw new DomainValidationError("本轮剧本/创意尚未准备好，无法进行内容驱动的时长修订");
    }
    const workspace = await this.workspace(run.projectId);
    if (!workspace.productTruth || workspace.productTruth.status !== "CONFIRMED") {
      throw new DomainValidationError("剧本重新编排前必须有当前确认的产品事实");
    }
    await this.assertCurrent(run);
    const first = this.d.scriptFeasibility.review(run.script);
    if (first.status === "PASS") {
      throw new DomainValidationError("当前剧本已经通过时长与叙事质检，无需重复调用模型");
    }
    const nextVersion = await this.d.productFlow.nextVersion(
      run.projectId, "ScriptDraft", "script"
    );
    let draft = run.script;
    let report = first;
    for (let attempt = 0; attempt < 2 && report.status === "REVISE"; attempt++) {
      draft = await this.d.scriptFeasibility.repair({
        truth: workspace.productTruth,
        batch: run.creativeBatch,
        script: draft,
        report,
        outputVersion: nextVersion
      });
      draft = bindScriptProductionAssets(draft,
        run.workflowVersion === 2 ? run.productionAssetSet : undefined);
      report = this.d.scriptFeasibility.review(draft);
    }
    if (report.status !== "PASS") {
      throw new DomainValidationError("剧本自动重编排后仍不满足时长与叙事质量："+
        report.issues.map(issue => issue.message).join("；"));
    }
    await this.d.aiGeneration.assertScriptUsageCompliance(workspace.productTruth, draft);
    return { script: draft, feasibility: report };
  }

  async reviseScriptV3(
    run: SmartGenerationRun,
    beats: NonNullable<SmartGenerationRun["script"]>["beats"]
  ) {
    if (!run.script || !this.d.scriptFeasibility) {
      throw new DomainValidationError(
        "Director V3 脚本或脚本 QA 尚未准备"
      );
    }
    const w = await this.workspace(run.projectId);
    if (!w.productTruth) {
      throw new DomainValidationError(
        "当前项目缺少已确认产品事实"
      );
    }
    const revised = reviseScriptDraft(
      run.script,
      beats.map((beat) => ({
        id: beat.id,
        purpose: beat.purpose,
        text: beat.text,
        estimatedDurationMs: beat.estimatedDurationMs,
        requiredFactIds: beat.requiredFactIds,
        ...(beat.videoIntent
          ? { videoIntent: beat.videoIntent }
          : {})
      }))
    );
    const feasibility =
      this.d.scriptFeasibility.review(revised);
    if (feasibility.status !== "PASS") {
      throw new DomainValidationError(
        "修改后的脚本未通过 Director V3 可生成性 QA：" +
          feasibility.issues
            .map((issue) => issue.message)
            .join("；")
      );
    }
    await this.d.aiGeneration.assertScriptUsageCompliance(
      w.productTruth,
      revised
    );
    return {
      script: revised,
      feasibility
    };
  }
  async director(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    const generationTarget = resolveDirectorGenerationTarget(await this.d.dreaminaCapability.registry(), run.options.generationSettings);
    return this.d.productDirector.generate({ productTruth: w.productTruth!, creativeBatch: run.creativeBatch!,
      selectedCreativeId: run.selectedCreativeId!, script: run.script!, generationTarget,
      projectTargetDurationMs: run.targetDurationMs, productionPlanVersion: await this.d.productFlow.nextVersion(run.projectId, "ProductionPlan", "production-plan"),
      referenceVideoProfile: run.referenceVideoProfile, creativeContext: run.creativeContext,
      ...(run.workflowVersion === 2 && run.productionAssetSet
        ? { productionAssetSet: run.productionAssetSet }
        : {}) });
  }
  async buildDirectorV8(run: SmartGenerationRun) {
    if (run.options.directorPipeline !== "V8" || run.v8Screenplay?.status !== "CONFIRMED" || !run.script) {
      throw new DomainValidationError("请先人工确认当前 V8 详细剧本");
    }
    const generationTarget = resolveDirectorGenerationTarget(
      await this.d.dreaminaCapability.registry(), run.options.generationSettings
    );
    if (!generationTarget.nativeAudioOutputRequested || generationTarget.operationConstraints.some(c => !c.supportsNativeAudioOutput)) {
      throw new DomainValidationError("V8 当前生产链需要所选模型支持并启用原生对白声音；请核实模型能力，不能静默改成无声视频");
    }
    const bounds = directorClipBounds(generationTarget);
    return sealV8({ revision: (run.v8Director?.revision ?? 0) + 1, status: "DRAFT" as const, generationTarget,
      decision: buildV8DirectorDecision({ script: run.script, screenplay: run.v8Screenplay.screenplay,
        modelMinSeconds: bounds.minSeconds, modelMaxSeconds: bounds.maxSeconds }) });
  }
  async directorV8(run: SmartGenerationRun) {
    assertV8DecisionBinding(run);
    if (run.v8Director?.status !== "CONFIRMED") throw new DomainValidationError("请先明确采用 V8 导演镜头表");
    const w = await this.workspace(run.projectId);
    const productionPlan = await this.d.productDirector.generate({ productTruth: w.productTruth!, creativeBatch: run.creativeBatch!,
      selectedCreativeId: run.selectedCreativeId!, script: run.script!, generationTarget: run.v8Director.generationTarget,
      v8DirectorDecision: run.v8Director.decision, productionAssetSet: run.productionAssetSet,
      projectTargetDurationMs: run.targetDurationMs, productionPlanVersion: await this.d.productFlow.nextVersion(run.projectId, "ProductionPlan", "production-plan"),
      referenceVideoProfile: run.referenceVideoProfile, creativeContext: run.creativeContext });
    const { contentHash: _hash, ...base } = productionPlan;
    const boundPlan = sealV8({ ...base, v8Source: { screenplayHash: run.v8Screenplay!.screenplayHash,
      directorDecisionHash: run.v8Director.decision.contentHash, directorRecordHash: run.v8Director.contentHash } });
    assertV8PlanBinding({ ...run, productionPlan: boundPlan });
    return boundPlan;
  }
  async compilePromptsV8(run: SmartGenerationRun, voiceBindings: V8PromptRecord["voiceBindings"]) {
    assertV8PlanBinding(run);
    if (run.productionPlan?.status !== "CONFIRMED" || run.productionAssetSet?.status !== "READY") {
      throw new DomainValidationError("请先确认正式分镜及全部制作资产，再编译 V8 提示词");
    }
    const w = await this.workspace(run.projectId);
    const imageBindingMode = run.v8Prompts?.imageBindingMode ??
      (!run.v8Prompts && process.env.PVS_SCENE_CONTINUITY_V1 === "1" ? "V1" : undefined);
    const packages = compileV8AuthoritativePrompts({ script: run.script!, truth: w.productTruth!, decision: run.v8Director!.decision,
      plan: run.productionPlan, assets: run.productionAssetSet, speakerBindings: voiceBindings,
      includeImageReferences: imageBindingMode === "V1" });
    return sealV8({ revision: (run.v8Prompts?.revision ?? 0) + 1, status: "DRAFT" as const,
      screenplayHash: run.v8Screenplay!.screenplayHash, directorRecordHash: run.v8Director!.contentHash,
      assetSetHash: run.productionAssetSet.contentHash, voiceBindings, packages,
      ...(imageBindingMode ? { imageBindingMode } : {}) });
  }
  async validatePromptsV8(run: SmartGenerationRun) {
    assertV8PromptBinding(run, false);
    const compiled = await this.compilePromptsV8(run, run.v8Prompts!.voiceBindings);
    if (!equal(compiled.packages, run.v8Prompts!.packages)) {
      throw new DomainValidationError("V8 编辑 Prompt 无法证明保留全部声音、动作和揭晓约束；请修改正式分镜或声线，再重新编译采用");
    }
  }
  async directorV3(run: SmartGenerationRun) {
    if (!this.d.directorV3Planner) {
      throw new SmartFlowPause(
        "BLOCKED",
        "DIRECTOR_V3_PLANNER_NOT_READY",
        "Director V3 分镜规划器尚未配置",
        false
      );
    }
    const w = await this.workspace(run.projectId);
    if (
      !w.productTruth ||
      !run.creativeBatch ||
      !run.selectedCreativeId ||
      !run.script
    ) {
      throw new DomainValidationError(
        "Director V3 分镜所需脚本、创意或产品事实不完整"
      );
    }
    const generationTarget =
      resolveDirectorGenerationTarget(
        await this.d.dreaminaCapability.registry(),
        run.options.generationSettings
      );
    const directorV3Plan =
      run.directorV3Plan ??
      this.d.directorV3Planner.plan({
        script: run.script,
        generationTarget
      });
    const productionPlan =
      await this.d.productDirector.generate({
        productTruth: w.productTruth,
        creativeBatch: run.creativeBatch,
        selectedCreativeId: run.selectedCreativeId,
        script: run.script,
        generationTarget,
        directorV3Plan,
        projectTargetDurationMs: run.targetDurationMs,
        productionPlanVersion:
          await this.d.productFlow.nextVersion(
            run.projectId,
            "ProductionPlan",
            "production-plan"
          ),
        referenceVideoProfile: run.referenceVideoProfile,
        creativeContext: run.creativeContext,
        ...(run.workflowVersion === 2 &&
        run.productionAssetSet
          ? {
              productionAssetSet:
                run.productionAssetSet
            }
          : {})
      });
    const formalClips = productionPlan.scenes.flatMap(
      (scene) =>
        scene.clips.map((clip) => ({
          scene,
          clip
        }))
    );
    if (
      formalClips.length !==
      directorV3Plan.clipContracts.length
    ) {
      throw new DomainValidationError(
        "Director V3 正式分镜数量与 Clip Contract 不一致"
      );
    }
    const seedancePromptDrafts = formalClips.map(
      ({ scene, clip }, index) => {
        const contract =
          directorV3Plan.clipContracts[index]!;
        const promptText = buildSeedancePromptV3({
          truth: w.productTruth!,
          plan: productionPlan,
          scene,
          clip,
          contract,
          ...(run.productionAssetSet
            ? {
                productionAssetSet:
                  run.productionAssetSet
              }
            : {}),
          creativeReferences:
            run.creativeContext?.references,
          model:
            generationTarget.requestedModelVersion,
          aspectRatio: generationTarget.aspectRatio,
          videoResolution:
            generationTarget.videoResolution
        });
        return createSeedancePromptV3Draft({
          projectId: run.projectId,
          clipId: clip.id,
          contract,
          promptText
        });
      }
    );
    return {
      productionPlan,
      directorV3Plan,
      seedancePromptDrafts
    };
  }
  async previewV3(run: SmartGenerationRun) {
    if (
      !this.d.scriptFeasibility ||
      !this.d.directorV3Planner
    ) {
      throw new DomainValidationError(
        "Director V3 影子预演服务尚未配置完整"
      );
    }
    const w = await this.workspace(run.projectId);
    if (
      !w.productTruth ||
      !run.creativeBatch ||
      !run.selectedCreativeId ||
      !run.script
    ) {
      throw new DomainValidationError(
        "当前真实任务缺少 Director V3 预演所需的产品事实、创意或脚本"
      );
    }

    const scriptBefore =
      this.d.scriptFeasibility.review(run.script);
    let repairedScript = run.script;
    let scriptAfter = scriptBefore;
    for (
      let repairPass = 0;
      repairPass < 2 && scriptAfter.status === "REVISE";
      repairPass += 1
    ) {
      repairedScript =
        await this.d.scriptFeasibility.repair({
          truth: w.productTruth,
          batch: run.creativeBatch,
          script: repairedScript,
          report: scriptAfter
        });
      scriptAfter =
        this.d.scriptFeasibility.review(repairedScript);
    }
    if (scriptAfter.status !== "PASS") {
      throw new DomainValidationError(
        "Director V3 影子预演的修复脚本仍未通过可生成性 QA：" +
          scriptAfter.issues
            .map((issue) => issue.code + " " + issue.message)
            .join("；")
      );
    }
    const previewScript =
      repairedScript.status === "DRAFT"
        ? confirmScriptDraft(repairedScript)
        : repairedScript;
    scriptAfter =
      this.d.scriptFeasibility.review(previewScript);
    await this.d.aiGeneration.assertScriptUsageCompliance(
      w.productTruth,
      previewScript
    );

    const generationSettings = {
      ...run.options.generationSettings,
      nativeAudioOutputRequested: true
    };
    const generationTarget =
      resolveDirectorGenerationTarget(
        await this.d.dreaminaCapability.registry(),
        generationSettings
      );
    const directorV3Plan =
      this.d.directorV3Planner.plan({
        script: previewScript,
        generationTarget
      });

    const productionPlan =
      await this.d.productDirector.generate({
        productTruth: w.productTruth,
        creativeBatch: run.creativeBatch,
        selectedCreativeId: run.selectedCreativeId,
        script: previewScript,
        generationTarget,
        directorV3Plan,
        projectTargetDurationMs: run.targetDurationMs,
        productionPlanVersion:
          (run.productionPlan?.version ?? 0) + 1,
        referenceVideoProfile: run.referenceVideoProfile,
        creativeContext: run.creativeContext,
        ...(run.productionAssetSet?.status === "READY"
          ? {
              productionAssetSet:
                run.productionAssetSet
            }
          : {})
      });
    await this.d.productDirector.assertPlanUsageCompliance(
      w.productTruth,
      productionPlan
    );

    const formalClips = productionPlan.scenes.flatMap(
      (scene) =>
        scene.clips.map((clip) => ({
          scene,
          clip
        }))
    );
    if (
      formalClips.length !==
      directorV3Plan.clipContracts.length
    ) {
      throw new DomainValidationError(
        "Director V3 影子预演的正式分镜数量与 Clip Contract 不一致"
      );
    }
    const prompts = formalClips.map(
      ({ scene, clip }, index) => {
        const contract =
          directorV3Plan.clipContracts[index]!;
        const promptText = buildSeedancePromptV3({
          truth: w.productTruth!,
          plan: productionPlan,
          scene,
          clip,
          contract,
          ...(run.productionAssetSet?.status === "READY"
            ? {
                productionAssetSet:
                  run.productionAssetSet
              }
            : {}),
          creativeReferences:
            run.creativeContext?.references,
          model:
            generationTarget.requestedModelVersion,
          aspectRatio: generationTarget.aspectRatio,
          videoResolution:
            generationTarget.videoResolution
        });
        return createSeedancePromptV3Draft({
          projectId: run.projectId,
          clipId: clip.id,
          contract,
          promptText
        });
      }
    );

    const [requests, attempts] = await Promise.all([
      this.d.generation.listCurrentGenerationRequests(
        run.projectId
      ),
      this.d.workflow.listGenerationAttempts(
        run.projectId
      )
    ]);
    const baselineRequests = requests
      .map((request) => {
        const attempt = attempts
          .filter(
            (item) =>
              item.generationRequestId === request.id
          )
          .sort(
            (a, b) =>
              b.attemptNumber - a.attemptNumber
          )[0];
        return {
          clipId: request.clipId,
          durationMs: request.durationMs,
          generateAudio: request.generateAudio,
          ...(request.audioPolicy
            ? { audioPolicy: request.audioPolicy }
            : {}),
          promptText: request.promptText,
          ...(attempt?.outputArtifactId
            ? {
                outputArtifactId:
                  attempt.outputArtifactId
              }
            : {})
        };
      })
      .sort(
        (a, b) =>
          a.durationMs - b.durationMs ||
          a.clipId.localeCompare(b.clipId)
      );

    const createdAt = new Date().toISOString();
    const preview = {
      sourceRunId: run.id,
      ...(run.workflowVersion
        ? { sourceWorkflowVersion: run.workflowVersion }
        : {}),
      createdAt,
      baseline: {
        clipCount: baselineRequests.length,
        requests: baselineRequests
      },
      scriptBefore,
      repairedScript: previewScript,
      scriptAfter,
      directorV3Plan,
      productionPlan,
      prompts,
      noPaidVideoGeneration: true as const
    };
    const artifactId = randomUUID();
    const projectRoot = path.join(
      this.d.projectsRoot,
      run.projectId
    );
    const artifact =
      await new LocalArtifactStore(
        projectRoot,
        this.d.artifacts
      ).writeImmutable({
        id: artifactId,
        projectId: run.projectId,
        kind: "OTHER",
        immutable: true,
        relativePath:
          "director-v3-preview/" +
          createdAt
            .replace(/[:.]/g, "-") +
          "-" +
          artifactId +
          ".json",
        bytes: Buffer.from(
          JSON.stringify(preview, null, 2),
          "utf8"
        ),
        mimeType: "application/json"
      });
    return {
      ...preview,
      artifact
    };
  }
  async confirmScript(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    if (!run.script) throw new DomainValidationError("脚本尚未生成");
    if (run.options.directorVersion === 3 &&
        run.options.directorPipeline !== "V8") {
      if (!this.d.scriptFeasibility) {
        throw new DomainValidationError(
          "Director V3 脚本 QA 尚未配置"
        );
      }
      const feasibility =
        this.d.scriptFeasibility.review(run.script);
      if (feasibility.status !== "PASS") {
        throw new DomainValidationError(
          "脚本未通过 Director V3 可生成性 QA，不能确认"
        );
      }
    }
    await this.d.aiGeneration.assertScriptUsageCompliance(w.productTruth!, run.script);
    return confirmScriptDraft(run.script);
  }
  async confirmPlan(run: SmartGenerationRun) {
    const w = await this.workspace(run.projectId);
    if (!run.productionPlan?.generationTarget) throw new DomainValidationError("模型感知分镜尚未准备");
    if (run.options.directorPipeline === "V8") assertV8PlanBinding(run);
    await this.d.productDirector.assertPlanUsageCompliance(w.productTruth!, run.productionPlan);
    assertDirectorSettingsMatch(run.productionPlan.generationTarget, run.options.generationSettings);
    return confirmProductionPlanDraft(run.productionPlan);
  }
  async install(run: SmartGenerationRun): Promise<WorkspaceBinding> {
    const w = await this.workspace(run.projectId);
    await this.assertSources(run, w);
    const desired: WorkspaceBinding = { ...run.expectedWorkspace };
    switch (run.pendingInstall) {
      case "CREATIVE": desired.creativeBatchRef = ref("CreativeBatch", run.creativeBatch!); desired.selectedCreativeId = undefined; desired.scriptRef = undefined; desired.productionPlanRef = undefined; break;
      case "SELECT_CREATIVE": desired.selectedCreativeId = run.selectedCreativeId; desired.scriptRef = undefined; desired.productionPlanRef = undefined; break;
      case "SCRIPT": case "CONFIRM_SCRIPT": desired.scriptRef = ref("ScriptDraft", run.script!); desired.productionPlanRef = undefined; break;
      case "DIRECTOR": case "CONFIRM_PLAN": desired.productionPlanRef = ref("ProductionPlan", run.productionPlan!); break;
      default: throw new DomainValidationError("没有待接入的阶段结果");
    }
    const current = workspaceBinding(w);
    if (equal(current, desired)) return current; // Recover commit-before-checkpoint without duplicating versions.
    if (!equal(current, run.expectedWorkspace)) throw new SmartFlowPause("BLOCKED", "WORKSPACE_CHANGED", "版本链被其他操作更新，不会覆盖当前工作", false);
    switch (run.pendingInstall) {
      case "CREATIVE": await this.d.productFlow.activateCreativeBatch(run.creativeBatch!); break;
      case "SELECT_CREATIVE": await this.d.productFlow.selectCreative(run.projectId, run.selectedCreativeId!); break;
      case "SCRIPT": await this.d.productFlow.saveScriptDraft(run.script!); break;
      case "CONFIRM_SCRIPT": await this.d.productFlow.confirmScript(run.script!); break;
      case "DIRECTOR": await this.d.productFlow.saveProductionPlanDraft(run.productionPlan!); break;
      case "CONFIRM_PLAN": await this.d.productFlow.confirmProductionPlan(run.productionPlan!); break;
    }
    const installed = workspaceBinding(await this.workspace(run.projectId));
    if (!equal(installed, desired)) throw new SmartFlowPause("BLOCKED", "INSTALL_CONFLICT", "保存后的版本链不匹配，需要人工核查", false);
    return installed;
  }

  async preparePaidScope(run: SmartGenerationRun) {
    await this.assertCurrent(run);
    if(run.canvasBinding)return this.canvasPreflight().prepare(run);
    const w = await this.workspace(run.projectId), material = await this.d.productInput.latest(run.projectId);
    if (!w.productTruth || !w.creativeBatch || !w.script || !w.productionPlan || !material) throw new DomainValidationError("生产链不完整");
    if (
      run.options.directorVersion === 3 && run.options.directorPipeline !== "V8" &&
      (
        !run.directorV3Plan ||
        !run.seedancePromptDrafts ||
        run.seedancePromptDrafts.length !==
          w.productionPlan.scenes.flatMap((scene) => scene.clips).length
      )
    ) {
      throw new DomainValidationError(
        "Director V3 的 Clip Contract 或最终 Seedance Prompt 尚未准备完整"
      );
    }
    if (
      run.workflowVersion === 2 &&
      (!run.productionAssetSet || run.productionAssetSet.status !== "READY")
    ) {
      throw new SmartFlowPause(
        "WAITING_FOR_ASSET_REVIEW",
        "PRODUCTION_ASSETS_NOT_READY",
        "角色、场景或其他制作资产尚未全部准备完成"
      );
    }
    if (run.options.directorPipeline === "V8") {
      assertV8PromptBinding(run);
      await this.validatePromptsV8(run);
    }
    const stagedContinuity = run.options.directorPipeline === "V8" &&
      run.v8Prompts?.imageBindingMode === "V1";
    let waveClipIds: string[] | undefined;
    const continuitySources: Record<string, SourceBinding> = {};
    if (stagedContinuity && run.v8Prompts) {
      const attempts = await this.d.workflow.listGenerationAttempts(run.projectId);
      const decisions = await this.d.review.listDecisions(run.projectId);
      const clips = w.productionPlan.scenes.flatMap(s=>s.clips);
      const attemptedClipIds = new Set(attempts.filter(a=>run.attemptIds.includes(a.id)).map(a=>a.clipId));
      const acceptedClipIds = new Set<string>();
      for (const clip of clips) {
        const latest = attempts.filter(a=>a.clipId===clip.id &&
            ["SUCCEEDED","RECONCILED_SUCCEEDED"].includes(a.status))
          .sort((a,b)=>b.attemptNumber-a.attemptNumber)[0];
        if (!latest?.outputArtifactId || !run.attemptIds.includes(latest.id)) continue;
        const accepted = decisions.filter(d=>d.clipId===clip.id && d.clipHash===clip.contentHash)
          .sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt))[0];
        if (accepted?.source==="USER" && accepted.decision==="ACCEPT" &&
            accepted.generationAttemptId===latest.id &&
            accepted.outputArtifactId===latest.outputArtifactId) acceptedClipIds.add(clip.id);
      }
      const wave = planNextContinuityWave({
        packages:run.v8Prompts.packages, attemptedClipIds, acceptedClipIds
      });
      if (wave.status !== "READY") {
        throw new SmartFlowPause(
          wave.status==="WAITING_FOR_REVIEW" || wave.status==="WAIT_SOURCE"
            ? "WAITING_FOR_CLIP_REVIEW" : "BLOCKED",
          wave.status==="COMPLETE" ? "CONTINUITY_ALL_CLIPS_GENERATED" : "CONTINUITY_SOURCE_REVIEW_REQUIRED",
          wave.message, true);
      }
      waveClipIds=wave.clipIds;
      for (const targetId of wave.clipIds) {
        const incoming=run.v8Prompts.packages.find(p=>p.clipId===targetId)?.incomingContinuity;
        if (!incoming || incoming.relationship==="SCENE_OR_TIME_JUMP") continue;
        const sourceClip=clips.find(c=>c.id===incoming.sourceClipId);
        if (!sourceClip) throw new DomainValidationError("本轮转场缺少合法的来源镜头。");
        const reviewed=await loadReviewedContinuitySource({
          projectId:run.projectId, projectsRoot:this.d.projectsRoot,
          clip:sourceClip, attempts, runAttemptIds:run.attemptIds,
          decisions, artifacts:this.d.artifacts
        });
        continuitySources[targetId]=bindReviewedContinuitySource({source:reviewed,incoming});
      }
    }
    const generatedProductionAssets =
      run.workflowVersion === 2 && run.productionAssetSet && this.d.productionAssets
        ? await this.d.productionAssets.toAssetRefs(run.productionAssetSet)
        : [];
    const ids = w.productionPlan.scenes.flatMap((s) => s.clips.flatMap((c) => c.referenceAssets.map((a) => a.assetId)));
    const valid = await validateReferenceImagesForPreflight({ projectsRoot: this.d.projectsRoot, projectId: run.projectId,
      confirmedReferenceAssets: [
        ...CreativeReferenceService.assets(await this.d.creativeReferences?.assertExpected(run.projectId,w.productionPlan.creativeReferenceSetRef)??null),
        ...generatedProductionAssets
      ],
      snapshot: material, artifacts: this.d.artifacts, requiredAssetIds: ids });
    const result = await this.d.preflight.run({ projectId: run.projectId, productTruth: w.productTruth, creativeBatch: w.creativeBatch,
      script: w.script, productionPlan: w.productionPlan, assets: [...material.assets, ...generatedProductionAssets],
      ...(run.workflowVersion === 2 && run.productionAssetSet
        ? { productionAssetSet: run.productionAssetSet }
        : {}),
      ...(run.options.directorVersion === 3 && run.directorV3Plan
        ? {
            directorV3Plan: run.directorV3Plan,
            promptV3Overrides: Object.fromEntries(
              (run.seedancePromptDrafts ?? []).map(
                (draft) => [draft.clipId, draft.promptText]
              )
            )
          }
        : {}),
      ...(run.options.directorPipeline === "V8" ? { v8Run: run } : {}),
      generationSettings: run.options.generationSettings,
      ...(waveClipIds ? {clipIds:waveClipIds} : {}),
      ...(Object.keys(continuitySources).length ? {continuitySources} : {}),
      inputBlockers: valid.blockers, acceptedDuplicateSubmissionRisk: false });
    await this.d.preflightAudit(run.projectId, result);
    if (result.reports.some((r) => r.status !== "PASS")) throw new SmartFlowPause("BLOCKED", "PREFLIGHT_BLOCKED", result.reports.flatMap((r) => r.blockers).join("；") || "生成前检查未通过");
    const requests = result.requests.map((r) => {
      const report = result.reports.find((p) => p.generationRequestId === r.id)!;
      return { requestId: r.id, clipId: r.clipId, requestHash: r.requestHash, preflightId: report.id, preflightHash: report.reportHash,
        costStatus: report.costEstimate.status, estimatedCredits: report.costEstimate.estimatedCredits, costText: report.costEstimate.estimatedCostText };
    }).sort((a, b) => a.requestId.localeCompare(b.requestId));
    const scope = { hash: "0".repeat(64), planRef: ref("ProductionPlan", w.productionPlan), requests, preparedAt: new Date().toISOString() };
    const boundScope = { ...scope,
      ...(waveClipIds ? {continuityBatch:{wave:(run.completedContinuityWaves?.length??0)+1,clipIds:waveClipIds}} : {}),
      ...(run.options.directorPipeline === "V8" ? { v8Binding: { runId: run.id,
      screenplayHash: run.v8Screenplay!.screenplayHash, directorRecordHash: run.v8Director!.contentHash, promptRecordHash: run.v8Prompts!.contentHash } } : {}) };
    return { ...boundScope, hash: scopeHash(boundScope) };
  }
  async validatePaidScope(run: SmartGenerationRun) {
    await this.assertCurrent(run);
    if(run.canvasBinding){
      if(!this.d.canvasProduction)throw new DomainValidationError("当前任务绑定Canvas，不能退回旧视频通道");
      await this.canvasPreflight().validate(run);
      return;
    }
    if (run.options.directorPipeline === "V8") {
      assertV8PromptBinding(run);
      await this.validatePromptsV8(run);
      if (!equal(run.paidScope?.v8Binding, { runId: run.id, screenplayHash: run.v8Screenplay!.screenplayHash,
        directorRecordHash: run.v8Director!.contentHash, promptRecordHash: run.v8Prompts!.contentHash })) throw new DomainValidationError("V8 付费范围绑定已失效");
    }
    const scope = run.paidScope;
    if (!scope || scopeHash(scope) !== scope.hash || !run.productionPlan || !equal(scope.planRef, ref("ProductionPlan", run.productionPlan))) throw new DomainValidationError("付费范围校验失败");
    const [requests, reports, registry] = await Promise.all([this.d.generation.listCurrentGenerationRequests(run.projectId), this.d.generation.listPreflightReports(run.projectId), this.d.dreaminaCapability.registry()]);
    if (registry.registryFingerprint !== run.productionPlan.generationTarget?.registryFingerprint) throw new SmartFlowPause("BLOCKED", "CAPABILITY_CHANGED", "即梦能力在确认前后发生变化，请重新规划，不复用旧授权", false);
    const planned = new Set(run.productionPlan.scenes.flatMap((s) => s.clips.map((c) => c.id)));
    const found = new Set<string>();
    for (const bound of scope.requests) {
      const request = requests.find((r) => r.id === bound.requestId), report = reports.find((r) => r.id === bound.preflightId);
      if (!request || !report || report.status !== "PASS" || request.requestHash !== bound.requestHash || report.reportHash !== bound.preflightHash || report.requestHash !== request.requestHash || report.generationRequestId !== request.id ||
          !request.inputVersionRefs.some((r) => equal(r, scope.planRef)) || !planned.has(request.clipId) || found.has(request.clipId) ||
          (report.costEstimate.expiresAt && Date.parse(report.costEstimate.expiresAt) <= Date.now())) throw new SmartFlowPause("BLOCKED", "PAID_SCOPE_STALE", "镜头、预检或成本范围已失效；不会使用旧确认执行新请求", false);
      if (run.options.directorPipeline === "V8") {
        const p = run.v8Prompts!.packages.find(p => p.clipId === request.clipId);
        const source=request.continuitySource;
        const expectedText=p ? source
          ? appendReviewedContinuityInstruction(p.promptText,source) : p.promptText : undefined;
        if (!p || request.promptText !== expectedText || !request.generateAudio ||
            request.v8Binding?.promptPackageHash !== p.contentHash || request.v8Binding.promptRecordHash !== run.v8Prompts!.contentHash ||
            request.v8Binding.runId !== run.id) throw new DomainValidationError("V8 实际生成请求未保留当前采用提示词，禁止付费提交");
        const incoming=p.incomingContinuity;
        if (source) {
          if (incoming?.sourceClipId!==source.sourceClipId ||
              incoming.contractHash!==source.contractHash ||
              incoming.relationship!==source.relationship ||
              (incoming.requiresHardFirstFrame &&
                (request.dreaminaOperation!=="image2video" ||
                 request.assetManifest[0]?.assetId!==source.tailFrameArtifactId ||
                 request.assetManifest[0]?.artifactHash!==source.tailFrameSha256 ||
                 request.imageBindings?.[0]?.providerSlot!=="FIRST_FRAME"))) {
            throw new DomainValidationError("当前付款镜头的真实尾帧/专用首帧槽位绑定不正确。");
          }
          const latestAttempts=await this.d.workflow.listGenerationAttempts(run.projectId);
          const sourceClip=run.productionPlan!.scenes.flatMap(s=>s.clips)
            .find(c=>c.id===source.sourceClipId);
          if (!sourceClip) throw new DomainValidationError("连续性来源镜头已失效。");
          const reviewed=await loadReviewedContinuitySource({
            projectId:run.projectId,projectsRoot:this.d.projectsRoot,clip:sourceClip,
            attempts:latestAttempts,runAttemptIds:run.attemptIds,
            decisions:await this.d.review.listDecisions(run.projectId),artifacts:this.d.artifacts
          });
          if (!equal(bindReviewedContinuitySource({source:reviewed,incoming}),source)) {
            throw new DomainValidationError("上一段视频或人工采用决定发生变化，必须重新预检并再次授权。");
          }
        } else if (run.v8Prompts?.imageBindingMode==="V1" && incoming &&
            incoming.relationship!=="SCENE_OR_TIME_JUMP") {
          throw new DomainValidationError("连续性依赖片段缺少审核过的来源，禁止复用第一批费用许可。");
        }
      }
      found.add(request.clipId);
    }
    if (run.options.directorPipeline === "V8" && run.v8Prompts?.imageBindingMode === "V1") {
      const expected = new Set(run.paidScope?.continuityBatch?.clipIds ??
        firstSourceIndependentClipIds(run.v8Prompts.packages));
      if (found.size !== expected.size || [...found].some(id=>!expected.has(id))) {
        throw new DomainValidationError("连续性首批付费范围不匹配；后续镜头不能复用本次授权。");
      }
    } else if (found.size !== planned.size) throw new DomainValidationError("付费范围没有精确覆盖当前导演镜头");
  }
  async approve(run: SmartGenerationRun) {
    if (!run.consent || run.consent.scopeHash !== run.paidScope?.hash) throw new DomainValidationError("缺少本次明确付费确认");
    await this.validatePaidScope(run);
    const approved = await this.d.approval.approveCurrentRequests({ projectId: run.projectId,
      generationRequestIds: run.paidScope.requests.map((r) => r.requestId), acceptedUnknownCostRisk: run.consent.acceptedUnknownCostRisk,
      acceptedDuplicateSubmissionRisk: false, reuseMatchingApprovals: run.options.directorPipeline !== "V8" });
    return approved.attempts.map((a) => a.id);
  }
  async generate(run: SmartGenerationRun,checkpoint?:(binding:CanvasProductionBinding)=>Promise<void>) {
    if (!run.consent || run.consent.scopeHash !== run.paidScope?.hash || !run.attemptIds.length) throw new DomainValidationError("生成任务缺少独立授权与尝试记录");
    if(run.canvasBinding){
      if(!checkpoint||!this.d.canvasProduction||!this.d.canvasVideoResults)throw new DomainValidationError("Canvas执行必须有原任务持久化检查点");
      const attempts=(await this.d.workflow.listGenerationAttempts(run.projectId)).filter(a=>run.attemptIds.includes(a.id));
      if(attempts.length!==run.attemptIds.length||attempts.length!==run.paidScope.requests.length)throw new DomainValidationError("Canvas生成尝试未完整绑定本次请求");
      for(let attempt of attempts){
        const request=await this.d.generation.getGenerationRequest(attempt.generationRequestId);
        const node=run.canvasBinding.nodes.find(n=>n.key===attempt.clipId&&n.kind==="VIDEO");
        const approval=await this.d.generation.getUserApproval(attempt.userApprovalId);
        if(!request?.canvasBinding||request.canvasBinding.runId!==run.id||request.canvasBinding.submitId!==node?.submitId||request.requestHash!==attempt.requestHash||
          !approval||approval.status!=="ACTIVE"||approval.requestHash!==attempt.requestHash||approval.approvalHash!==attempt.approvalHash||approval.generationRequestId!==request.id)
          throw new DomainValidationError("Canvas原请求、审核许可或提交编号不匹配");
        if(attempt.status==="CREATED"){
          await this.validatePaidScope(run);
          if(!this.d.workflow.claimCreatedAttempt)throw new DomainValidationError("Canvas需要数据库原子占用生成尝试");
          const claimed=await this.d.workflow.claimCreatedAttempt(attempt.id);if(!claimed)continue;
          await this.d.workflow.updateGenerationAttemptStatus(attempt.id,{status:"SUBMITTING",providerHandle:{submitId:node!.submitId}});
          try{
            const submitted=await this.d.canvasProduction.submitAuthorizedNode(run,attempt.clipId,checkpoint);
            attempt=await this.d.workflow.updateGenerationAttemptStatus(attempt.id,{status:submitted.state==="ACCEPTED"?"SUBMITTED":"SUBMISSION_OUTCOME_UNKNOWN",submittedAt:new Date().toISOString()});
          }catch(error){
            await this.d.workflow.updateGenerationAttemptStatus(attempt.id,{status:"SUBMISSION_OUTCOME_UNKNOWN",errorCode:"CANVAS_SUBMISSION_RECONCILE_REQUIRED",errorMessage:"先按原submit编号查询，禁止自动重新提交"});throw error;
          }
        }
        if(["SUBMITTING","SUBMISSION_OUTCOME_UNKNOWN","SUBMITTED","PROCESSING"].includes(attempt.status))
          await this.d.canvasVideoResults.sync(run,attempt.clipId,checkpoint);
      }
      const latest=(await this.d.workflow.listGenerationAttempts(run.projectId)).filter(a=>run.attemptIds.includes(a.id));
      if(latest.some(a=>["SUBMISSION_OUTCOME_UNKNOWN","SUBMITTING"].includes(a.status)))throw new SmartFlowPause("BLOCKED","RECONCILE_REQUIRED","原Canvas提交结果待核实，不会重提");
      if(latest.some(a=>a.status==="FAILED"))throw new SmartFlowPause("BLOCKED","CANVAS_RESULT_REVIEW_REQUIRED","原视频生成或媒体检查失败，已保留结果，需要处理后再继续");
      return {done:latest.every(a=>["SUCCEEDED","RECONCILED_SUCCEEDED"].includes(a.status)&&Boolean(a.outputArtifactId))};
    }
    const activeIds=run.options.directorPipeline==="V8" &&
      run.v8Prompts?.imageBindingMode==="V1"
      ? (run.activeBatchAttemptIds??run.attemptIds) : run.attemptIds;
    if (!activeIds.length || activeIds.some(id=>!run.attemptIds.includes(id))) {
      throw new DomainValidationError("本批次生成尝试与当前任务授权不匹配");
    }
    let attempts = await this.d.workflow.listGenerationAttempts(run.projectId);
    const scoped = attempts.filter((a) => activeIds.includes(a.id));
    if (scoped.length !== activeIds.length) throw new DomainValidationError("本批生成尝试记录不完整");
    const created = scoped.filter((a) => a.status === "CREATED");
    if (created.length) {
      await this.validatePaidScope(run);
      const preview = await this.d.batchGeneration.preview(run.projectId, created.map((a) => a.id));
      await this.d.batchGeneration.submit({ projectId: run.projectId, attemptIds: created.map((a) => a.id), scopeHash: preview.scopeHash });
    }
    for (const id of activeIds) {
      let attempt = await this.d.workflow.getGenerationAttempt(id);
      if (!attempt) continue;
      if (["SUBMITTED", "PROCESSING"].includes(attempt.status)) attempt = await this.d.execution.pollAttempt(id);
      if (["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(attempt.status) && !attempt.outputArtifactId) await this.d.execution.downloadAttempt(id);
    }
    attempts = (await this.d.workflow.listGenerationAttempts(run.projectId)).filter((a) => activeIds.includes(a.id));
    if (attempts.some((a) => ["SUBMITTED", "PROCESSING"].includes(a.status))) return { done: false };
    if (attempts.some((a) => ["SUBMITTING", "SUBMISSION_OUTCOME_UNKNOWN", "RECONCILING"].includes(a.status))) throw new SmartFlowPause("BLOCKED", "RECONCILE_REQUIRED", "有镜头提交结果未知，先在视频生成页调和；不会自动重提");
    if (attempts.some((a) => a.status === "CREATED")) throw new SmartFlowPause("BLOCKED", "SUBMISSION_BLOCKED", "部分镜头尚未提交，请查看视频生成页的审批或能力错误");
    if (attempts.some((a) => ["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(a.status) && !a.outputArtifactId)) throw new SmartFlowPause("BLOCKED", "DOWNLOAD_REQUIRED", "视频已生成但下载尚未成功，可恢复下载，不会重新付费生成");
    return { done: true };
  }
  async reviewClips(run: SmartGenerationRun) {
    if (run.options.directorPipeline === "V8" && run.v8Prompts?.imageBindingMode === "V1") {
      const expected=run.productionPlan?.scenes.flatMap(s=>s.clips).length ?? 0;
      const attempts=await this.d.workflow.listGenerationAttempts(run.projectId);
      const completed=new Set(attempts.filter(a=>run.attemptIds.includes(a.id) &&
        ["SUCCEEDED","RECONCILED_SUCCEEDED"].includes(a.status) && Boolean(a.outputArtifactId)).map(a=>a.clipId));
      if (completed.size < expected) {
        throw new SmartFlowPause("WAITING_FOR_CLIP_REVIEW", "CONTINUITY_NEXT_BATCH_REQUIRED",
          "首批视频已生成，请先审核。后续片段必须继承审核通过的真实尾帧并重新确认下一批费用；当前版本不自动复用首批授权或提前进入剪辑。", false);
      }
    }
    let w = await this.workspace(run.projectId);
    let decisions = await this.d.review.listDecisions(run.projectId);
    const acceptedRunOutput = () =>
      decisions.some(
        r =>
          r.decision === "ACCEPT" &&
          r.generationAttemptId &&
          run.attemptIds.includes(r.generationAttemptId)
      );
    if (w.project.status === "READY_TO_ASSEMBLE") {
      if (!acceptedRunOutput()) {
        throw new SmartFlowPause(
          "WAITING_FOR_CLIP_REVIEW",
          "NO_ACCEPTED_RUN_OUTPUT",
          "本任务没有已采用的生成结果"
        );
      }
      return;
    }
    if (!run.options.autoSelectLowRiskClips) {
      throw new SmartFlowPause(
        "WAITING_FOR_CLIP_REVIEW",
        "OUTPUT_REVIEW_REQUIRED",
        "请在视频生成页采用或跳过镜头。只有你在创建任务时明确启用“高置信视觉自动采用”，系统才会尝试自动审片"
      );
    }
    if (!this.d.visualReview || !this.d.reviewService || !w.productTruth || !w.productionPlan) {
      throw new SmartFlowPause(
        "WAITING_FOR_CLIP_REVIEW",
        "VISUAL_REVIEW_NOT_READY",
        "视觉审片服务未准备好，请改为人工审片"
      );
    }

    const allAttempts = (await this.d.workflow.listGenerationAttempts(run.projectId))
      .filter(a => run.attemptIds.includes(a.id));
    const planClips = w.productionPlan.scenes
      .flatMap(scene => scene.clips)
      .sort((a, b) => a.order - b.order);
    const reviewBlockers: Array<{ index: number; reason: string }> = [];
    const pending: Array<{
      clip: (typeof planClips)[number];
      attempt: (typeof allAttempts)[number];
      assessment: Awaited<ReturnType<VisualEditAssessmentService["assess"]>>;
    }> = [];

    for (const [clipIndex, clip] of planClips.entries()) {
      const videoNumber = clipIndex + 1;
      const usage = decisions
        .filter(
          d =>
            d.clipId === clip.id &&
            d.clipHash === clip.contentHash &&
            (d.decision === "SKIP" || d.decision === "USE")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (usage?.decision === "SKIP") continue;

      const attempt = allAttempts
        .filter(
          a =>
            a.clipId === clip.id &&
            ["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(a.status) &&
            Boolean(a.outputArtifactId)
        )
        .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
      if (!attempt?.outputArtifactId) {
        reviewBlockers.push({ index: videoNumber, reason: "没有已下载的成功视频" });
        continue;
      }
      const existing = decisions
        .filter(
          d =>
            d.clipId === clip.id &&
            d.clipHash === clip.contentHash &&
            d.generationAttemptId === attempt.id &&
            d.outputArtifactId === attempt.outputArtifactId &&
            (d.decision === "ACCEPT" || d.decision === "REDO")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (existing?.decision === "ACCEPT") continue;
      if (existing?.decision === "REDO") {
        reviewBlockers.push({ index: videoNumber, reason: "已有人工重做决定，等待处理" });
        continue;
      }

      let assessment;
      try {
        assessment = await this.d.visualReview.assess({
          projectId: run.projectId,
          truth: w.productTruth,
          clip,
          attemptId: attempt.id,
          outputArtifactId: attempt.outputArtifactId
        });
      } catch (error) {
        // An unavailable visual model or a broken evidence record must not
        // terminate diagnosis of the remaining independent clips.
        reviewBlockers.push({ index: videoNumber, reason: "视觉审核暂不可用，请人工复核" });
        continue;
      }
      if (!assessment.assessment.autoAcceptEligible) {
        reviewBlockers.push({
          index: videoNumber,
          reason: assessment.assessment.status === "BLOCKED"
            ? "画面或产品展示存在问题"
            : "视觉证据不足，不能安全自动采用"
        });
        continue;
      }
      pending.push({ clip, attempt, assessment });
    }

    if (reviewBlockers.length) {
      // Complete all independent visual checks before writing any AI ACCEPT.
      // Human decisions and all existing video artifacts remain unchanged.
      const summary = reviewBlockers.map(item =>
        "视频 " + item.index + "：" + item.reason).join("；");
      throw new SmartFlowPause(
        "WAITING_FOR_CLIP_REVIEW",
        "VISUAL_REVIEW_REQUIRED",
        "逐条视觉审核完成；" + summary +
        "。请在本轮镜头审片中播放对应视频并选择采用、重做或跳过。不会自动付费重提。"
      );
    }

    // Assess the full outstanding set first. Only then persist AI ACCEPT decisions.
    for (const item of pending) {
      await this.d.reviewService.decide({
        projectId: run.projectId,
        clipId: item.clip.id,
        generationAttemptId: item.attempt.id,
        decision: "ACCEPT",
        source: "AI_VISUAL_GATE",
        visualAssessment: {
          artifactId: item.assessment.artifactId,
          artifactHash: item.assessment.artifactHash,
          assessmentContentHash: item.assessment.assessment.contentHash,
          evaluatorVersion: item.assessment.assessment.evaluatorVersion
        },
        note:
          "用户已在一键成片任务中明确启用高置信视觉自动采用；产品身份、稳定性、使用约束、画质和剪辑窗口均通过视觉门禁"
      });
    }

    w = await this.workspace(run.projectId);
    decisions = await this.d.review.listDecisions(run.projectId);
    if (w.project.status !== "READY_TO_ASSEMBLE" || !acceptedRunOutput()) {
      throw new SmartFlowPause(
        "WAITING_FOR_CLIP_REVIEW",
        "OUTPUT_REVIEW_REQUIRED",
        "视觉门禁完成后仍有镜头未形成当前有效采用/跳过决定，请人工复核"
      );
    }
  }
  async autoEdit(run: SmartGenerationRun) {
    if (!this.d.autoEdit) throw new SmartFlowPause("BLOCKED", "AUTO_EDIT_NOT_READY", "自动剪辑、字幕和音轨集成尚未完成；现有手动时间线可用");
    try {
      const result = await this.d.autoEdit(run);
      if (run.options.directorPipeline === "V8") {
        assertV8PromptBinding(run);
        const timeline = await this.d.timeline?.latestTimeline(run.projectId);
        if (!timeline) throw new DomainValidationError("V8 时间线校验未配置或结果未保存，禁止进入渲染");
        assertV8TimelineConformance(run.productionPlan!, timeline);
      }
      return result;
    }
    catch (error) {
      if (error instanceof AutoEditBlocked) throw new SmartFlowPause(error.audioRequired ? "WAITING_FOR_AUDIO" : "BLOCKED", error.code, error.message);
      throw error;
    }
  }
  async adoptTimeline(run: SmartGenerationRun, input: { id: string; hash: string }) {
    const timeline = await this.d.timeline?.latestTimeline(run.projectId);
    if (!timeline || timeline.status !== "CONFIRMED" || timeline.id !== input.id || timeline.contentHash !== input.hash || timeline.productionPlanHash !== run.productionPlan?.contentHash) {
      throw new SmartFlowPause("BLOCKED", "TIMELINE_CHANGED", "请先确认本项目当前分镜对应的手工时间线，再明确采用此版本");
    }
    const outputs = new Set((await this.d.workflow.listGenerationAttempts(run.projectId)).filter(a => run.attemptIds.includes(a.id)).map(a => a.outputArtifactId));
    if (timeline.clips.some(c => !c.deleted && !outputs.has(c.sourceArtifactId))) throw new SmartFlowPause("BLOCKED", "TIMELINE_OTHER_OUTPUT", "手工时间线包含本任务以外的生成结果，请独立完成手工成片");
    if (run.options.directorPipeline === "V8") {
      assertV8PromptBinding(run);
      assertV8TimelineConformance(run.productionPlan!, timeline);
    }
  }
  async render(run: SmartGenerationRun) {
    const current = await this.d.timeline?.latestTimeline(run.projectId);
    if (!current || current.status !== "CONFIRMED" || current.id !== run.timelineRef?.id || current.contentHash !== run.timelineRef?.hash) {
      throw new SmartFlowPause("BLOCKED", "TIMELINE_CHANGED", "当前时间线不是本任务确认的版本，已在渲染前阻断", false);
    }
    if (run.options.directorPipeline === "V8") {
      assertV8PromptBinding(run);
      assertV8TimelineConformance(run.productionPlan!, current);
    }
    const result = await this.d.renderEngine.render(run.projectId);
    if (result.renderJob.status !== "SUCCEEDED" || result.assembly.timelineId !== run.timelineRef?.id || result.assembly.timelineHash !== run.timelineRef?.hash) throw new SmartFlowPause("BLOCKED", "RENDER_OUTPUT_MISMATCH", "渲染输出与本任务时间线不一致", false);
    return { artifactId: result.assembly.outputArtifactId, sha256: result.assembly.outputArtifactHash, renderJobId: result.renderJob.id };
  }
  async cancel(run: SmartGenerationRun) {
    for (const r of run.paidScope?.requests ?? []) await this.d.generation.markRequestChainStale(r.requestId, new Date().toISOString());
  }
  async finalConfirmed(run: SmartGenerationRun) {
    const a = await this.d.finalOutput.latestAssembly(run.projectId);
    return Boolean(a && a.status === "ACCEPTED" && a.outputArtifactId === run.finalOutput?.artifactId && a.outputArtifactHash === run.finalOutput?.sha256 && a.renderJobId === run.finalOutput?.renderJobId);
  }
}
