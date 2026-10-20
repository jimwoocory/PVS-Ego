import { randomUUID } from "node:crypto";
import { ProductionQuoteService, buildProductionQuoteRequest, assertCurrentQuote } from "./production-quote-service.js";
import { ConfiguredGenerationQuoteProvider } from "../../adapters/video/configured-generation-quote-provider.js";
import { hashValue } from "../../domain/hashing.js";
import { auditNarrativeTiming, isScriptDurationWithinTolerance } from "./script-narrative-timing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {
  smartRunOptionsSchema, smartRunSchema, runnableSmartStatuses, closedSmartStatuses,
  type SmartGenerationRun, type SmartStage
} from "../../domain/smart-generation.js";
import type { SmartRunRepository } from "../ports/smart-run-repository.js";
import { SmartFlowPause, type SmartProduction } from "../ports/smart-production.js";
import { withSerialOperation } from "./serial-operation.js";
import { postProductionSettingsSchema } from "../../domain/auto-edit.js";
import {
  directorV3ClipContractSchema,
  directorV3PlanSchema,
  seedancePromptV3DraftSchema
} from "../../domain/director-v3.js";
import { assertSeedancePromptV3 } from "./seedance-model-prompt-v3.js";
import { sealV8, v8VoiceBindingsSchema, type V8PromptRecord } from "../../domain/v8-production.js";
import { assertV8DecisionBinding, assertV8PlanBinding, assertV8PromptBinding } from "./v8-production-binding.js";
import { reviseProductionPlanDraft, type ProductionPlanSegmentRevision } from "./review-actions.js";
import { v8DetailedProposalSchema } from "../../domain/v8-screenplay.js";

export type SmartReviewAction =
  | "SELECT_CREATIVE"
  | "CONFIRM_ASSET"
  | "CONFIRM_SCRIPT"
  | "CONFIRM_PLAN"
  | "CONFIRM_V8_DIRECTOR"
  | "CONFIRM_V8_PROMPTS";

/** Durable orchestrator. Planning/review can never manufacture permission to spend credits. */
export class SmartGenerationService {
  constructor(private readonly repo: SmartRunRepository, private readonly production: SmartProduction,
    private readonly quotes = new ProductionQuoteService(new ConfiguredGenerationQuoteProvider())) {}
  async shortPlanAction(projectId:string,id:string,expectedRevision:number,action:string,input:Record<string,unknown>,confirmed=false){
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==expectedRevision||!this.production.shortPlanAction)throw new DomainValidationError("原任务版本变化或15秒制作服务未配置");
      const result=await this.production.shortPlanAction(run,action,input,confirmed,async p=>{
        p.updatedAt=new Date().toISOString();run=await this.save(run,owner,{canvasShortPlans:[...(run.canvasShortPlans??[]).filter(v=>v.id!==p.id),p]},
          "保存15秒独立制作检查点："+action+"；原60秒方案和费用授权保留");
      });return {runId:run.id,revision:run.revision,result};
    });
  }

  async create(
    projectId: string,
    requestKey: string,
    rawOptions: unknown,
    workflowVersion: 1 | 2 = 1
  ): Promise<SmartGenerationRun> {
    const options = smartRunOptionsSchema.parse(rawOptions);
    if (options.directorPipeline === "V8" && (
      process.env.PVS_V8_UNIFIED_DIRECTOR_AUTHORING !== "1" ||
      workflowVersion !== 2 ||
      options.reviewMode !== "MANUAL" ||
      options.directorVersion !== 3
    )) {
      throw new DomainValidationError(
        "V8 详细创作只允许在显式试点开关开启后，使用全新 V2 任务及逐阶段人工确认；旧项目不会自动切换"
      );
    }
    const initial = await this.production.initial(projectId);
    const now = new Date().toISOString();
    const id = randomUUID();
    const autoAdvanceGrant = process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS === "1" && workflowVersion === 2
      ? { projectId, runId: id, authorizedAt: now, source: "USER_CREATED" as const }
      : undefined;
    return this.repo.create(smartRunSchema.parse({
      id, projectId, requestKey, revision: 1,
      ...(autoAdvanceGrant ? { autoAdvanceGrant } : {}),
      workflowVersion,
      inputHash: hashValue({ projectId, options, targetDurationMs: initial.targetDurationMs }),
      status: "PLANNING", stage: "SOURCES", options,
      targetDurationMs: initial.targetDurationMs, expectedWorkspace: initial.binding,
      attemptIds: [], notes: [], createdAt: now, updatedAt: now
    }));
  }

  /** Explicitly allow ONE existing, still-unpaid task to use managed scheduling. */
  async authorizeAutoAdvance(projectId: string, id: string, input: {
    expectedRevision: number; confirmCurrentTask: boolean;
  }): Promise<SmartGenerationRun> {
    if (process.env.PVS_SMART_WORKER_MANAGED_NEW_RUNS !== "1")
      throw new DomainValidationError("当前没有启用安全的新任务自动调度");
    if (input.confirmCurrentTask !== true)
      throw new DomainValidationError("请明确授权当前这条任务继续非付费规划");
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision)
        throw new DomainValidationError("任务版本已改变，请刷新后重新确认");
      if (run.autoAdvanceGrant) return run;
      if (run.workflowVersion !== 2 || run.status !== "PLANNING" ||
          run.stage !== "SOURCES" || run.pendingInstall ||
          run.paidScope || run.consent || run.assetConsent ||
          run.attemptIds.length > 0)
        throw new DomainValidationError("仅允许当前尚未生成、尚未付费的新制作任务恢复后台规划，历史生成授权不得继承");
      return this.save(run, owner, {
        autoAdvanceGrant: { projectId, runId: run.id,
          authorizedAt: new Date().toISOString(), source: "USER_RESUMED" }
      }, "用户明确授权本条新制作任务继续后台规划；图片和视频付费仍须逐项确认");
    });
  }

  get(projectId: string, id: string) { return this.repo.get(projectId, id); }
  list(projectId?: string) { return this.repo.list(projectId); }

  private async zeroImageQuote(run:SmartGenerationRun){
    if(!this.production.quoteCanvasImages||!run.canvasBinding||!run.script||!run.productionPlan||!run.assetPaidScope||
      run.status!=="READY_FOR_ASSET_PAID_CONFIRM"||run.assetConsent||run.consent||run.attemptIds.length)
      throw new DomainValidationError("仅允许原任务尚未生成的三张Canvas设定图授权");
    await this.production.assertCurrent(run);
    const quote=await this.production.quoteCanvasImages(run);
    const keys=["DAUGHTER","FATHER","LIVING_ROOM"];
    if(quote.status!=="QUOTED"||quote.grandTotal?.credits!==0||quote.items.length!==3||
      keys.some(key=>!quote.items.some(i=>i.request.key===key&&i.request.kind==="IMAGE"&&i.result.status==="QUOTED"&&i.result.credits===0&&i.result.canvas?.canonicalModel==="seedream_5.0_lite"))||
      run.assetPaidScope.assets.length!==3||run.assetPaidScope.assets.some(a=>!keys.includes(a.key)||!run.productionAssetSet?.entries.some(e=>e.key===a.key&&e.status==="PLANNED"&&e.generationRequestHash===a.requestHash)))
      throw new DomainValidationError("三张设定图的完整实时报价不是0积分，已停止，未确认或提交生成");
    return quote;
  }
  async previewZeroCanvasImages(projectId:string,id:string,expectedRevision:number){
    const run=await this.require(projectId,id);if(run.revision!==expectedRevision)throw new DomainValidationError("任务版本变化，请重新核对");
    const quote=await this.zeroImageQuote(run);
    return {runId:run.id,revision:run.revision,creditCeiling:0,images:quote.items.map(i=>({key:i.request.key,label:i.request.label,model:i.result.status==="QUOTED"?i.result.canvas?.canonicalModel:undefined,
      resolution:i.request.resolution,ratio:i.request.aspectRatio,credits:i.result.status==="QUOTED"?i.result.credits:undefined})),videoGenerationAuthorized:false,publicationAuthorized:false};
  }
  async authorizeZeroCanvasImages(projectId:string,id:string,input:{expectedRevision:number;creditCeiling:0;confirmed:boolean}){
    if(input.confirmed!==true||input.creditCeiling!==0)throw new DomainValidationError("必须由用户明确授权这三张设定图，积分上限只能为0");
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==input.expectedRevision)throw new DomainValidationError("任务版本变化，请重新核对");
      const imageQuote=await this.zeroImageQuote(run),binding=run.canvasBinding!;
      const original=run.feeQuote;
      if(!original||original.scopeHash!==binding.scopeHash)throw new DomainValidationError("原始九项报价范围缺失");
      const assets=run.assetPaidScope!.assets.map(a=>({...a,costStatus:"KNOWN" as const,estimatedCredits:0,costText:"用户明确批准本次设定图最高0积分，超过即停"}));
      const base={strategyHash:run.assetPaidScope!.strategyHash,assets,...(run.assetPaidScope!.authorizationNonce?{authorizationNonce:run.assetPaidScope!.authorizationNonce}:{})};
      const assetPaidScope={...run.assetPaidScope!,assets,hash:hashValue(base)},approvedAt=new Date().toISOString();
      const grant={source:"EXPLICIT_USER_ZERO_CREDIT_IMAGES" as const,creditCeiling:0 as const,projectId,runId:run.id,scopeHash:assetPaidScope.hash,quoteScopeHash:imageQuote.scopeHash,
        keys:imageQuote.items.map(i=>i.request.key),approvedAt};
      const canvasBinding={...binding,originalQuoteRequest:{contract:original.contract,projectId,runId:run.id,scopeHash:original.scopeHash,items:original.items.map(i=>i.request)},
        sourceScriptHash:run.script!.contentHash,sourcePlanHash:run.productionPlan!.contentHash,imageQuote,imageBudgetGrant:{...grant,grantHash:hashValue(grant)}};
      const candidate={...run,assetPaidScope,canvasBinding};
      await this.production.validateAssetPaidScope!(candidate);
      return this.save(run,owner,{assetPaidScope,canvasBinding,assetConsent:{scopeHash:assetPaidScope.hash,approvedAt,acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_ASSET_PAID_CONFIRMATION"},
        status:"ASSET_PREPARING",stage:"ASSET_PREP",blocker:undefined},"用户明确授权原三张设定图最高0积分；不授权视频生成或发布，超过0即停");
    });
  }
  async recoverCanvasImages(projectId:string,id:string,expectedRevision:number){
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==expectedRevision||!run.canvasBinding?.imageBudgetGrant||!run.assetConsent||run.consent||run.attemptIds.length||
        !["BLOCKED","ASSET_PREPARING"].includes(run.status)||!this.production.recoverCanvasImages)throw new DomainValidationError("当前不是可恢复的原Canvas图片检查点");
      const set=await this.production.recoverCanvasImages(run,async canvasBinding=>{run=await this.save(run,owner,{canvasBinding},"只读核对原Canvas提交并保存回执，没有重新生成");});
      const unknown=set.entries.some(e=>e.status==="SUBMISSION_UNKNOWN");
      return this.save(run,owner,{productionAssetSet:set,status:unknown?"BLOCKED":"ASSET_PREPARING",blocker:unknown?run.blocker:undefined},"已核对原三图提交，只恢复已受理任务的查询与下载；不创建新提交");
    });
  }
  async inspectCanvasVideoDelivery(projectId:string,id:string){
    const run=await this.require(projectId,id);await this.production.assertCurrent(run);
    return {...(await this.production.canvasVideoDeliveryReadiness?.()??{ready:false,code:"CANVAS_VIDEO_RESULT_SERVICE_MISSING"}),runId:run.id,
      note:"只检查原视频的文件交付能力，不批准或提交视频生成；真实MP4下载后仍需媒体检查和人工审片"};
  }
  async inspectCanvasPreflight(projectId:string,id:string){
    const run=await this.require(projectId,id);
    if(!this.production.inspectCanvasPreflight)throw new DomainValidationError("Canvas视频预检接口未配置");
    return this.production.inspectCanvasPreflight(run);
  }
  async prepareCanvasPaidScope(projectId:string,id:string,expectedRevision:number){
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==expectedRevision||!run.canvasBinding||run.consent||run.attemptIds.length||run.pendingInstall||
        !["ASSET_PREP","SCRIPT","DIRECTOR","PREFLIGHT"].includes(run.stage)||run.script?.status!=="CONFIRMED"||run.productionPlan?.status!=="CONFIRMED")
        throw new DomainValidationError("Canvas请求准备要求当前已确认的原剧本和分镜，且没有视频授权、尝试或待安装版本");
      await this.production.assertCurrent(run);
      const paidScope=await this.production.preparePaidScope(run);
      return this.save(run,owner,{paidScope,stage:"PREFLIGHT",status:"READY_FOR_PAID_CONFIRM",blocker:undefined},"按已确认原分镜和实际审核素材建立Canvas原生请求与预检；保留原方案，尚未授予付费许可");
    });
  }
  async quoteCanvasShort(projectId:string,id:string,expectedRevision:number,input:unknown){
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==expectedRevision||run.consent||run.attemptIds.length||!this.production.quoteCanvasShort)throw new DomainValidationError("15秒报价要求原任务尚未授权视频，且版本必须一致");
      const result=await this.production.quoteCanvasShort(run,input,async preview=>{
        const existing=run.canvasShortPreviews??[];
        run=await this.save(run,owner,{canvasShortPreviews:[...existing.filter(p=>p.id!==preview.id),preview]},"保存15秒独立报价草稿，保留原60秒脚本与全部资产；未授权视频生成");
      });
      return {result,runId:run.id,revision:run.revision};
    });
  }
  async syncCanvasVideoResult(projectId:string,id:string,expectedRevision:number,clipId:string){
    return this.exclusive(projectId,id,async(run,owner)=>{
      if(run.revision!==expectedRevision||!this.production.syncCanvasVideoResult)throw new DomainValidationError("原视频结果任务版本变化或适配服务缺失");
      const attempt=await this.production.syncCanvasVideoResult(run,clipId,async canvasBinding=>{run=await this.save(run,owner,{canvasBinding},"已保存原Canvas视频下载与媒体检查点，没有重新提交生成");});
      return {runId:run.id,revision:run.revision,attemptId:attempt.id,status:attempt.status,outputArtifactId:attempt.outputArtifactId,requiresHumanReview:true};
    });
  }

  /** Refresh a quote on this run; does not install a spend grant or advance production. */
  async quoteCurrent(projectId: string, id: string, expectedRevision: number) {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== expectedRevision) throw new DomainValidationError("制作任务版本已变化，请读取原任务后重新报价");
      const repriceSaved=Boolean(run.canvasBinding?.imageBudgetGrant&&(["WAITING_FOR_ASSET_REVIEW","ASSET_PREPARING","READY_FOR_PAID_CONFIRM"].includes(run.status)||
        run.stage==="PREFLIGHT"&&!run.pendingInstall&&["PLANNING","BLOCKED"].includes(run.status)));
      if (run.consent || (run.stage === "ASSET_PREP" && run.assetConsent&&!repriceSaved) || run.attemptIds.length || (!repriceSaved&&!["READY_FOR_ASSET_PAID_CONFIRM", "READY_FOR_PAID_CONFIRM"].includes(run.status)))
        throw new DomainValidationError("只允许在尚未付费的原任务确认点核价，不能修改已授权或执行中的范围");
      await this.production.assertCurrent(run);
      let feeQuote;
      try{feeQuote=await this.production.quoteCurrent?.(run,async canvasBinding=>{
          run=await this.save(run,owner,{canvasBinding},"已保存原制作任务的Canvas节点绑定；未授权或提交付费生成");
        }) ?? await this.quotes.quote(buildProductionQuoteRequest(run));
      }catch(error){
        const code=error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"?error.code:"QUOTE_BACKEND_FAILED";
        feeQuote=await new ProductionQuoteService({quote:async()=>({status:"UNAVAILABLE",code,message:"后台报价调用未完成："+code+"；旧报价已失效，未提交生成"})}).quote(buildProductionQuoteRequest(run));
      }
      await this.production.assertCurrent(run);
      // An unavailable refresh also invalidates any previous KNOWN prices.
      const price = (key: string) => feeQuote.items.find(i => i.request.key === key)?.result;
      const patch: Partial<SmartGenerationRun> = { feeQuote };
      if (run.stage === "ASSET_PREP" && !run.assetConsent && run.assetPaidScope && (feeQuote.status === "QUOTED" || run.assetPaidScope.assets.some(a => a.costStatus === "KNOWN"))) {
        const assets = run.assetPaidScope.assets.map(a => {
          const q = price(a.key);
          return { key: a.key, requestHash: a.requestHash, costStatus: q?.status === "QUOTED" ? "KNOWN" as const : "UNKNOWN" as const,
            ...(q?.status === "QUOTED" ? { estimatedCredits: q.credits, costText: `后台${q.kind === "CREDIT_CEILING" ? "最高消耗" : "报价"}：${q.credits}积分，有效至${q.expiresAt}` } : { costText: "后台报价未取得，不能确认付费" }) };
        });
        const base = { strategyHash: run.assetPaidScope.strategyHash, assets, ...(run.assetPaidScope.authorizationNonce ? { authorizationNonce: run.assetPaidScope.authorizationNonce } : {}) };
        patch.assetPaidScope = { ...run.assetPaidScope, assets, hash: hashValue(base) };
      }
      if (run.stage !== "ASSET_PREP" && run.paidScope && (feeQuote.status === "QUOTED" || run.paidScope.requests.some(r => r.costStatus === "KNOWN"))) {
        const requests = run.paidScope.requests.map(r => {
          const q = r.clipId ? price(r.clipId) : undefined;
          return { ...r, costStatus: q?.status === "QUOTED" ? "KNOWN" as const : "UNKNOWN" as const,
            estimatedCredits: q?.status === "QUOTED" ? q.credits : undefined,
            costText: q?.status === "QUOTED" ? `后台${q.kind === "CREDIT_CEILING" ? "最高消耗" : "报价"}：${q.credits}积分，有效至${q.expiresAt}` : "缺少当前镜头的后台报价绑定" };
        });
        const { planRef, v8Binding, continuityBatch } = run.paidScope;
        patch.paidScope = { ...run.paidScope, requests, hash: hashValue({ planRef, requests,
          ...(v8Binding ? { v8Binding } : {}), ...(continuityBatch ? { continuityBatch } : {}) }) };
      }
      const saved = await this.save(run, owner, patch, feeQuote.status === "QUOTED" ? "已保存后台逐项报价；尚未授权生成，付费前仍需用户确认" : "后台逐项核价完成检查，但上游报价接口缺失或不可用；原制作任务保留，未生成");
      return { ...feeQuote, revision: saved.revision, canRequestPaidConfirmation: false };
    });
  }

  async inspectReadiness(projectId: string, id: string) {
    const run = await this.require(projectId, id);
    await this.production.assertCurrent(run);
    if(run.status==="WAITING_FOR_ASSET_REVIEW"&&run.canvasBinding?.imageBudgetGrant&&run.assetConsent){
      return {runId:run.id,revision:run.revision,phase:"ASSETS",scopeHash:run.assetPaidScope?.hash,providerReady:true,costStatus:"KNOWN",items:run.assetPaidScope?.assets??[],
        alreadyAuthorized:true,canRequestPaidConfirmation:false,feeQuote:run.feeQuote,
        note:"三张设定图已按用户确认的0积分上限生成，当前等待图片审核；不能再次请求图片生成授权，也不授权视频生成或发布"};
    }
    const assets = run.stage === "ASSET_PREP";
    const scope = assets ? run.assetPaidScope : run.paidScope;
    let providerReady = false, providerError: string | undefined;
    try {
      if (assets && this.production.validateAssetPaidScope) await this.production.validateAssetPaidScope(run);
      else if (!assets && scope) await this.production.validatePaidScope(run);
      else throw new DomainValidationError("没有可检查的生成范围");
      providerReady = true;
    } catch (error) { providerError = error instanceof Error ? error.message : "生成通道检查失败"; }
    const items = assets ? run.assetPaidScope?.assets : run.paidScope?.requests;
    let quoteValid = !run.workspaceContinuation;
    if (run.workspaceContinuation) { try { assertCurrentQuote(run, assets ? "IMAGE" : "VIDEO"); quoteValid = true; } catch {} }
    const known = Boolean(quoteValid && items?.length && items.every(item => item.costStatus === "KNOWN"));
    return { runId: run.id, revision: run.revision, phase: assets ? "ASSETS" : "VIDEO", scopeHash: scope?.hash,
      providerReady, providerError, costStatus: known ? "KNOWN" : "UNKNOWN", items: items ?? [],
      canRequestPaidConfirmation: providerReady && known, feeQuote: run.feeQuote,
      note: !known ? "当前范围尚未取得完整、有效的后台报价。"+(run.feeQuote?.missingInterfaces.map(m=>m.message).join("；")??"")+"网页促销、余额和外部文档报价不能替代；未提交生成或申请未知价格授权。" : "仅代表预检通过，仍需用户确认具体费用范围" };
  }

  /** Attach existing reviewed work; never re-run ideation or inherit a spend grant. */
  async continueWorkspace(projectId: string, requestKey: string, input: {
    artifactId: string; artifactHash: string; scriptHash: string; planHash: string; requestText: string;
  }): Promise<SmartGenerationRun> {
    return withSerialOperation("smart-continuation:" + projectId, async () => {
      const inputHash = hashValue({ projectId, continuation: input });
      const prior = await this.repo.findByRequestKey(projectId, requestKey);
      if (prior) {
        if (prior.inputHash !== inputHash) throw new DomainValidationError("同一续接请求不能更换项目成果");
        return prior;
      }
      const active = (await this.repo.list(projectId)).find(r => !closedSmartStatuses.includes(r.status));
      if (active) throw new DomainValidationError("项目已有制作任务，请继续原任务，不能另建任务绕过检查点");
      if (!this.production.continueWorkspace) throw new DomainValidationError("当前未配置已有项目成果续接能力");
      const seed = await this.production.continueWorkspace(projectId, input);
      const now = new Date().toISOString();
      return this.repo.create(smartRunSchema.parse({
        ...seed, id: randomUUID(), projectId, requestKey, inputHash, revision: 1, workflowVersion: 2,
        status: seed.assetPaidScope ? "READY_FOR_ASSET_PAID_CONFIRM" : "PLANNING", stage: "ASSET_PREP",
        attemptIds: [], notes: [{ at: now, stage: "ASSET_PREP", message: "已接入当前已确认脚本、分镜及制作规划；未重写创意，未继承付费或发布授权" }], createdAt: now, updatedAt: now
      }));
    });
  }

  async previewDirectorV3(projectId: string) {
    if (!this.production.previewV3) {
      throw new DomainValidationError(
        "Director V3 影子预演服务尚未配置"
      );
    }
    const runs = await this.repo.list(projectId);
    const candidates = runs
      .filter(
        (run) =>
          Boolean(
            run.script &&
            run.creativeBatch &&
            run.selectedCreativeId
          )
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() -
          new Date(a.updatedAt).getTime()
      );
    const source =
      candidates.find(
        (run) => run.attemptIds.length > 0
      ) ?? candidates[0];
    if (!source) {
      throw new DomainValidationError(
        "当前项目没有可用于 Director V3 A/B 的真实脚本任务"
      );
    }
    return withSerialOperation(
      "director-v3-preview:" + projectId,
      () => this.production.previewV3!(source)
    );
  }

  private async require(projectId: string, id: string): Promise<SmartGenerationRun> {
    const run = await this.repo.get(projectId, id);
    if (!run) throw new DomainValidationError("找不到当前项目的一键成片任务");
    return run;
  }

  private async exclusive<T = SmartGenerationRun>(projectId: string, id: string, operation: (run: SmartGenerationRun, owner: string) => Promise<T>): Promise<T> {
    return withSerialOperation("smart-run:" + id, async () => {
      const owner = randomUUID();
      if (!await this.repo.acquire(projectId, id, owner, process.pid)) {
        throw new DomainValidationError("任务正在由另一个执行器处理，请等待当前步骤完成");
      }
      try { return await operation(await this.require(projectId, id), owner); }
      finally { await this.repo.release(projectId, id, owner); }
    });
  }

  private save(run: SmartGenerationRun, owner: string, patch: Partial<SmartGenerationRun>, message: string) {
    const stage = patch.stage ?? run.stage;
    return this.repo.save({ ...run, ...patch, notes: [...run.notes, { at: new Date().toISOString(), stage, message }].slice(-200) }, run.revision, owner);
  }

  private runnable(stage: SmartStage): SmartGenerationRun["status"] {
    return stage === "ASSET_PREP" ? "ASSET_PREPARING"
      : stage === "APPROVAL" ? "APPROVING" : stage === "GENERATION" ? "GENERATING"
      : stage === "AUTO_EDIT" ? "AUTO_EDITING" : stage === "RENDER" ? "RENDERING" : "PLANNING";
  }

  private assertDirectorV3Editable(
    run: SmartGenerationRun,
    expectedRevision: number
  ): void {
    if (run.revision !== expectedRevision) {
      throw new DomainValidationError(
        "任务已更新，请刷新页面后重新修改"
      );
    }
    if (run.options.directorVersion !== 3 ||
        run.options.directorPipeline === "V8") {
      throw new DomainValidationError(
        "V8 与 Director V3 编辑入口互斥，不能用旧 V3 编辑器覆盖 V8 剧本或导演结果"
      );
    }
    if (
      run.pendingInstall ||
      run.attemptIds.length > 0 ||
      [
        "GENERATION",
        "CLIP_REVIEW",
        "AUTO_EDIT",
        "RENDER",
        "FINAL_REVIEW",
        "DONE"
      ].includes(run.stage)
    ) {
      throw new DomainValidationError(
        "当前任务已经进入真实生成或下游阶段，不能覆盖导演内容；请新建一轮重做"
      );
    }
  }

  /** A single bounded step. The web worker repeatedly calls this; GET endpoints never run work. */
  async advance(projectId: string, id: string): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (!runnableSmartStatuses.includes(run.status)) return run;
      try {
        if (run.pendingInstall) {
          const pending = run.pendingInstall;
          const expectedWorkspace = await this.production.install(run);
          let stage = run.stage;
          let status: SmartGenerationRun["status"] = "PLANNING";
          if (pending === "CREATIVE") {
            status =
              run.workflowVersion === 2 ||
              run.options.reviewMode === "MANUAL"
                ? "WAITING_FOR_CREATIVE_REVIEW"
                : "PLANNING";
          }
          if (pending === "SELECT_CREATIVE") {
            stage =
              run.workflowVersion === 2
                ? "PRODUCTION_PLANNING"
                : "SCRIPT";
          }
          if (pending === "SCRIPT") {
            status =
              run.options.directorPipeline === "V8" ||
              (run.workflowVersion !== 2 && run.options.reviewMode === "MANUAL")
                ? "WAITING_FOR_SCRIPT_REVIEW"
                : "PLANNING";
          }
          if (pending === "CONFIRM_SCRIPT") stage = "DIRECTOR";
          if (pending === "DIRECTOR") {
            status =
              (run.options.directorPipeline === "V8" || run.workflowVersion !== 2) &&
              run.options.reviewMode === "MANUAL"
                ? "WAITING_FOR_PLAN_REVIEW"
                : "PLANNING";
          }
          if (pending === "CONFIRM_PLAN") {
            stage = "PREFLIGHT";
            if (run.options.directorPipeline === "V8") status = "WAITING_FOR_PROMPT_REVIEW";
          }
          return this.save(run, owner, { expectedWorkspace, pendingInstall: undefined, stage, status, blocker: undefined }, "已将本阶段结果接入现有版本链，历史版本保留");
        }
        if (run.stage !== "SOURCES") await this.production.assertCurrent(run);
        if (run.workspaceContinuation && run.stage === "ASSET_PREP" && run.assetConsent &&
            run.productionAssetSet?.entries.some(e => e.source === "DREAMINA_GENERATED" && e.status === "PLANNED")) assertCurrentQuote(run, "IMAGE");
        if (run.workspaceContinuation && ["APPROVAL", "GENERATION"].includes(run.stage) && run.consent) assertCurrentQuote(run, "VIDEO");
        switch (run.stage) {
          case "SOURCES":
            return this.save(run, owner, { ...await this.production.sources(run), stage: "CREATIVE", status: "PLANNING", blocker: undefined }, "产品事实及素材来源检查通过，未执行付费生成");
          case "CREATIVE":
            if (!run.creativeBatch) return this.save(run, owner, { creativeBatch: await this.production.creative(run), pendingInstall: "CREATIVE" }, "创意结果已持久化，准备接入版本链");
            if (run.workflowVersion === 2) {
              return this.save(
                run,
                owner,
                { status: "WAITING_FOR_CREATIVE_REVIEW" },
                "V2 主链等待用户选择一个创意方向"
              );
            }
            if (run.options.reviewMode !== "AUTO") return this.save(run, owner, { status: "WAITING_FOR_CREATIVE_REVIEW" }, "等待选择创意");
            // AUTO is an explicit user option. The deterministic choice is recorded, not represented as a human decision.
            const selected = run.creativeBatch.concepts.find((c) => c.generationRisk === "LOW") ?? run.creativeBatch.concepts[0]!;
            return this.save(run, owner, { selectedCreativeId: selected.id, pendingInstall: "SELECT_CREATIVE" }, "按已启用的自动创作模式选择首个低生成风险方案；不代表效果评分");
          case "PRODUCTION_PLANNING":
            if (run.workflowVersion !== 2) {
              throw new DomainValidationError("旧任务不能进入 V2 制作策略阶段");
            }
            if (!run.productionStrategy) {
              if (!this.production.planProduction) {
                throw new SmartFlowPause(
                  "BLOCKED",
                  "PRODUCTION_PLANNER_NOT_READY",
                  "制作策略规划器尚未配置"
                );
              }
              return this.save(
                run,
                owner,
                { productionStrategy: await this.production.planProduction(run) },
                "已根据所选创意分析角色、场景、道具与产品参考需求"
              );
            }
            return this.save(
              run,
              owner,
              { stage: "ASSET_PREP", status: "PLANNING" },
              "制作策略已锁定，开始准备本轮所需固定资产"
            );
          case "ASSET_PREP": {
            if (run.workflowVersion !== 2) {
              throw new DomainValidationError("旧任务不能进入 V2 制作资产阶段");
            }
            if (!this.production.prepareProductionAssets || !this.production.advanceProductionAssets) {
              throw new SmartFlowPause(
                "BLOCKED",
                "PRODUCTION_ASSET_SERVICE_NOT_READY",
                "制作资产服务尚未配置"
              );
            }
            if (!run.productionAssetSet) {
              const prepared = await this.production.prepareProductionAssets(run);
              if (prepared.set.status === "FAILED") {
                return this.save(
                  run,
                  owner,
                  {
                    productionAssetSet: prepared.set,
                    assetPaidScope: prepared.paidScope,
                    status: "BLOCKED",
                    blocker: {
                      code: "PRODUCTION_ASSET_PREP_FAILED",
                      message: prepared.set.entries
                        .filter(item => item.status === "FAILED")
                        .map(item => item.errorMessage ?? item.label)
                        .join("；") || "制作资产准备失败",
                      retryable: true
                    }
                  },
                  "制作资产准备遇到阻塞"
                );
              }
              if (prepared.set.status === "NEEDS_REVIEW") {
                return this.save(
                  run,
                  owner,
                  {
                    productionAssetSet: prepared.set,
                    assetPaidScope: prepared.paidScope,
                    status: "WAITING_FOR_ASSET_REVIEW"
                  },
                  "现有制作参考需要用户确认"
                );
              }
              if (prepared.paidScope) {
                return this.save(
                  run,
                  owner,
                  {
                    productionAssetSet: prepared.set,
                    assetPaidScope: prepared.paidScope,
                    assetConsent: undefined,
                    status: "READY_FOR_ASSET_PAID_CONFIRM"
                  },
                  "需要生成新的角色/场景制作资产，等待一次明确积分确认"
                );
              }
              return this.save(
                run,
                owner,
                {
                  productionAssetSet: prepared.set,
                  stage: "SCRIPT",
                  status: "PLANNING"
                },
                "本轮无需新增付费制作资产，直接进入脚本"
              );
            }
            if (
              run.productionAssetSet.status === "PLANNED" &&
              run.assetPaidScope &&
              !run.assetConsent
            ) {
              return this.save(
                run,
                owner,
                { status: "READY_FOR_ASSET_PAID_CONFIRM" },
                "等待制作资产付费确认"
              );
            }
            if (
              run.assetPaidScope &&
              (!run.assetConsent ||
                run.assetConsent.scopeHash !== run.assetPaidScope.hash)
            ) {
              throw new SmartFlowPause(
                "READY_FOR_ASSET_PAID_CONFIRM",
                "ASSET_PAID_CONFIRM_REQUIRED",
                "需要先明确确认本轮角色/场景制作资产的积分生成"
              );
            }
            const nextSet = await this.production.advanceProductionAssets(run,async canvasBinding=>{
              run=await this.save(run,owner,{canvasBinding},"已保存Canvas预算执行检查点及稳定提交编号；不会自动重复提交");
            });
            if (nextSet.contentHash === run.productionAssetSet.contentHash) {
              return run;
            }
            if (nextSet.status === "FAILED") {
              // Keep receiving already-paid independent assets even if another
              // asset has a local result failure. No new submit is triggered here.
              const otherInFlight = nextSet.entries.some(item =>
                item.source === "DREAMINA_GENERATED" &&
                ["SUBMITTED", "PROCESSING"].includes(item.status)
              );
              const unsafeUnknown = nextSet.entries.some(item =>
                item.status === "SUBMISSION_UNKNOWN"
              );
              if (otherInFlight && !unsafeUnknown) {
                return this.save(
                  run, owner,
                  { productionAssetSet: nextSet, status: "ASSET_PREPARING", blocker: undefined },
                  "有制作资产接收失败，但继续查询其他已提交的图片；不会重复付费生图"
                );
              }
              const stale = nextSet.entries.find(
                item =>
                  item.status === "SUBMISSION_UNKNOWN" &&
                  item.errorCode === "ASSET_REMOTE_RESULT_STALE"
              );
              const unknown = nextSet.entries.some(
                item => item.status === "SUBMISSION_UNKNOWN"
              );
              return this.save(
                run,
                owner,
                {
                  productionAssetSet: nextSet,
                  status: "BLOCKED",
                  blocker: {
                    code: stale
                      ? "ASSET_REMOTE_RESULT_STALE"
                      : unknown
                        ? "ASSET_SUBMISSION_OUTCOME_UNKNOWN"
                      : "PRODUCTION_ASSET_GENERATION_FAILED",
                    message: stale
                      ? stale.errorMessage ??
                        "即梦制作资产任务长时间没有返回产物；不会自动重提，需要重新授权后才能生成。"
                      : unknown
                        ? "有制作资产提交结果未知；禁止自动重提，需先核查即梦任务"
                      : nextSet.entries
                          .filter(item => item.status === "FAILED")
                          .map(item => item.errorMessage ?? item.label)
                          .join("；") || "制作资产生成失败",
                    retryable: !unknown
                  }
                },
                "制作资产生成暂停"
              );
            }
            if (nextSet.status === "NEEDS_REVIEW") {
              const assetByKey = new Map(nextSet.entries.map(item => [item.key, item] as const));
              const stillPreparing = nextSet.entries.some(
                item =>
                  item.source === "DREAMINA_GENERATED" &&
                  (
                    ["SUBMITTED", "PROCESSING"].includes(item.status) ||
                    (
                      item.status === "PLANNED" &&
                      item.dependsOnAssetKeys.every(
                        key => assetByKey.get(key)?.status === "READY"
                      )
                    )
                  )
              );
              if (stillPreparing) {
                return this.save(
                  run,
                  owner,
                  {
                    productionAssetSet: nextSet,
                    status: "ASSET_PREPARING"
                  },
                  "已有制作资产图片返回，继续完成本轮其余已授权资产；全部返回后统一给用户看图确认"
                );
              }
              return this.save(
                run,
                owner,
                {
                  productionAssetSet: nextSet,
                  status: "WAITING_FOR_ASSET_REVIEW"
                },
                "本轮制作资产图片已准备完成，等待用户逐项看图确认或重新生成"
              );
            }
            if (nextSet.status === "READY") {
              return this.save(
                run,
                owner,
                {
                  productionAssetSet: nextSet,
                  stage: "SCRIPT",
                  status: "PLANNING",
                  blocker: undefined
                },
                "本轮角色、场景和产品制作资产已准备完成，进入脚本"
              );
            }
            return this.save(
              run,
              owner,
              {
                productionAssetSet: nextSet,
                status: "ASSET_PREPARING"
              },
              "制作资产生成正在推进；不会重复提交已创建任务"
            );
          }
          case "SCRIPT":
            if (run.workspaceContinuation && run.script?.status === "CONFIRMED") {
              return this.save(run, owner, { stage: "DIRECTOR", status: "PLANNING" }, "复用当前已确认剧本，不重新编写或代签确认");
            }
            if (!run.script) {
              if (run.options.directorPipeline === "V8") {
                if (!this.production.scriptV8) {
                  throw new SmartFlowPause("BLOCKED", "V8_SCREENPLAY_SERVICE_MISSING",
                    "V8 详细剧本生成能力未配置，未改动旧版本或调用即梦", false);
                }
                const result = await this.production.scriptV8(run);
                const record = {
                  format: "PVS_V8_SCREENPLAY_V1" as const,
                  status: "DRAFT" as const,
                  screenplay: result.screenplay,
                  screenplayHash: hashValue(result.screenplay),
                  sourceScriptHash: result.script.contentHash,
                  brief: run.options.requestText
                };
                return this.save(run, owner, {
                  script: result.script,
                  v8Screenplay: record,
                  pendingInstall: "SCRIPT"
                }, "V8 详细剧本和兼容 ScriptDraft 已分别保存且绑定同一版本，等待人工阅读确认");
              }
              if (run.options.directorVersion === 3) {
                if (!this.production.scriptV3) {
                  throw new SmartFlowPause(
                    "BLOCKED",
                    "DIRECTOR_V3_SCRIPT_UNAVAILABLE",
                    "Director V3 脚本 QA 服务尚未配置",
                    false
                  );
                }
                const result = await this.production.scriptV3(run);
                return this.save(
                  run,
                  owner,
                  {
                    script: result.script,
                    scriptFeasibility: result.feasibility,
                    pendingInstall: "SCRIPT"
                  },
                  "Director V3 脚本已通过可生成性 QA 并持久化"
                );
              }
              return this.save(run, owner, { script: await this.production.script(run), pendingInstall: "SCRIPT" }, "脚本草稿已持久化");
            }
            if (run.options.directorPipeline === "V8") {
              return this.save(run, owner, { status: "WAITING_FOR_SCRIPT_REVIEW" },
                "V8 详细剧本必须人工确认，不能由自动模式代签");
            }
            if (run.workflowVersion !== 2 && run.options.reviewMode !== "AUTO") return this.save(run, owner, { status: "WAITING_FOR_SCRIPT_REVIEW" }, "等待确认脚本");
            return this.save(run, owner, { script: await this.production.confirmScript(run), pendingInstall: "CONFIRM_SCRIPT" }, "自动模式：脚本约束检查通过，准备保存确认版本");
          case "DIRECTOR":
            if (run.workspaceContinuation) {
              if (!run.workspaceContinuation.assetsBound) {
                if (!this.production.bindContinuationPlan) throw new DomainValidationError("已有分镜与实际资产的绑定服务未配置");
                const bound = await this.production.bindContinuationPlan(run);
                return this.save(run, owner, { ...bound, workspaceContinuation: { ...run.workspaceContinuation, assetsBound: true }, pendingInstall: "DIRECTOR" }, "只更新实际素材绑定并编译当前分镜，原剧情、镜头和对白保留，等待用户审核");
              }
              return this.save(run, owner, { status: "WAITING_FOR_PLAN_REVIEW" }, "当前分镜及实际素材已接入，等待用户审阅后再准备视频费用");
            }
            if (run.options.directorPipeline === "V8") {
              if (!this.production.buildDirectorV8 || !this.production.directorV8) {
                throw new SmartFlowPause("BLOCKED", "V8_DIRECTOR_ADOPTION_NOT_READY",
                  "V8 正式导演执行器未配置，请核实部署；不会回退 V3 或复用付费许可", false);
              }
              if (!run.v8Director) {
                return this.save(run, owner, { v8Director: await this.production.buildDirectorV8(run),
                  status: "WAITING_FOR_DIRECTOR_REVIEW", paidScope: undefined, consent: undefined },
                  "V8 Shot-first 镜头及可变时长已保存，等待人工采用导演约束");
              }
              assertV8DecisionBinding(run);
              if (run.v8Director.status !== "CONFIRMED") return this.save(run, owner,
                { status: "WAITING_FOR_DIRECTOR_REVIEW" }, "等待明确采用 V8 导演镜头表");
              if (!run.productionPlan) return this.save(run, owner,
                { productionPlan: await this.production.directorV8(run), pendingInstall: "DIRECTOR" },
                "ProductDirector 按已采用 V8 镜头细化正式分镜，语义 Gate 通过后等待人工审核");
              return this.save(run, owner, { status: "WAITING_FOR_PLAN_REVIEW" }, "V8 正式分镜必须人工审核");
            }
            if (!run.productionPlan) {
              if (run.options.directorVersion === 3) {
                if (!this.production.directorV3) {
                  throw new SmartFlowPause(
                    "BLOCKED",
                    "DIRECTOR_V3_PLANNER_UNAVAILABLE",
                    "Director V3 分镜规划器尚未配置",
                    false
                  );
                }
                const result = await this.production.directorV3(run);
                return this.save(
                  run,
                  owner,
                  {
                    productionPlan: result.productionPlan,
                    directorV3Plan: result.directorV3Plan,
                    seedancePromptDrafts:
                      result.seedancePromptDrafts,
                    pendingInstall: "DIRECTOR"
                  },
                  "Director V3 Clip Contract 与正式分镜已持久化"
                );
              }
              return this.save(run, owner, { productionPlan: await this.production.director(run), pendingInstall: "DIRECTOR" }, "模型感知分镜已持久化");
            }
            if (run.workflowVersion !== 2 && run.options.reviewMode !== "AUTO") return this.save(run, owner, { status: "WAITING_FOR_PLAN_REVIEW" }, "等待确认分镜");
            return this.save(run, owner, { productionPlan: await this.production.confirmPlan(run), pendingInstall: "CONFIRM_PLAN" }, "自动模式：分镜约束检查通过，准备保存确认版本");
          case "PREFLIGHT":
            if (run.options.directorPipeline === "V8") {
              if (run.v8Prompts?.status !== "CONFIRMED") return this.save(run, owner,
                { status: "WAITING_FOR_PROMPT_REVIEW" }, "请绑定角色声线、查看逐镜提示词后明确采用");
              assertV8PromptBinding(run);
              if (!this.production.validatePromptsV8) throw new DomainValidationError("V8 Prompt 语义校验未配置，禁止进入付费检查");
              await this.production.validatePromptsV8(run);
            }
            return this.save(run, owner, { paidScope: await this.production.preparePaidScope(run), consent: undefined, status: "READY_FOR_PAID_CONFIRM", blocker: undefined }, "精确镜头和费用范围已准备；必须明确确认后才能提交");
          case "APPROVAL":
            await this.production.validatePaidScope(run);
            {
              const approvedIds=await this.production.approve(run);
              const staged=run.options.directorPipeline==="V8" &&
                run.v8Prompts?.imageBindingMode==="V1";
              return this.save(run, owner, {
                attemptIds:staged ? [...run.attemptIds,...approvedIds] : approvedIds,
                ...(staged ? {activeBatchAttemptIds:approvedIds} : {}),
                status:"GENERATING", stage:"GENERATION", blocker:undefined
              }, "按当前已确认费用范围建立本批独立尝试；历史批次不重复授权或提交");
            }
          case "GENERATION": {
            const result = await this.production.generate(run,async canvasBinding=>{
              run=await this.save(run,owner,{canvasBinding},"保存原Canvas视频提交及下载检查点；未知结果不重提");
            });
            const batch=run.paidScope?.continuityBatch;
            if (result.done && batch && run.paidScope && run.activeBatchAttemptIds) {
              const previous=run.completedContinuityWaves ?? [];
              if (previous.some(item=>item.scopeHash===run.paidScope!.hash)) {
                return this.save(run,owner,{stage:"CLIP_REVIEW",status:"PLANNING"}, "本批已归档，进入逐镜审核");
              }
              return this.save(run,owner,{
                stage:"CLIP_REVIEW",status:"PLANNING",
                completedContinuityWaves:[...previous,{
                  scopeHash:run.paidScope.hash,clipIds:batch.clipIds,
                  attemptIds:run.activeBatchAttemptIds
                }]
              },"本批已生成并保留审批凭据；只允许用户审核后准备下一批");
            }
            return this.save(run, owner, result.done ? { stage: "CLIP_REVIEW", status: "PLANNING" } : {}, result.done ? "已完成本轮提交、查询与下载，准备选片检查" : "本轮生成推进完成，等待下次查询；不重复提交");
          }
          case "CLIP_REVIEW":
            if (run.options.directorPipeline==="V8" &&
                run.v8Prompts?.imageBindingMode==="V1" && run.productionPlan) {
              const attemptedCount=(run.completedContinuityWaves??[])
                .flatMap(wave=>wave.clipIds).filter((id,i,ids)=>ids.indexOf(id)===i).length;
              if (attemptedCount < run.v8Prompts.packages.length) {
                const next=await this.production.preparePaidScope(run);
                return this.save(run,owner,{
                  paidScope:next,consent:undefined,activeBatchAttemptIds:[],
                  status:"READY_FOR_PAID_CONFIRM",stage:"PREFLIGHT",blocker:undefined
                },"已核对上一批人工审核，生成新的镜头与积分范围；需重新明确授权后才会生成");
              }
            }
            await this.production.reviewClips(run);
            return this.save(run, owner, { stage: "AUTO_EDIT", status: "AUTO_EDITING", blocker: undefined }, "选片约束通过，进入自动剪辑");
          case "AUTO_EDIT":
            if (run.workspaceContinuation?.localPostProductionPending) throw new SmartFlowPause("BLOCKED", "LOCAL_POST_PRODUCTION_NOT_BOUND", "规划中的本地片尾和剪辑尚未绑定实际时间线；保留原素材，不能将53秒生成素材冒充60秒成片", false);
            return this.save(run, owner, { ...await this.production.autoEdit(run), stage: "RENDER", status: "RENDERING", blocker: undefined }, "剪辑决策和时间线已保存");
          case "RENDER":
            return this.save(run, owner, { finalOutput: await this.production.render(run), stage: "FINAL_REVIEW", status: "REVIEW_READY", blocker: undefined }, "真实渲染产物已就绪，等待最终确认；不等于已发布");
          default: return run;
        }
      } catch (error) {
        const pause = error instanceof SmartFlowPause ? error : null;
        const v8SemanticError = run.options.directorPipeline === "V8";
        return this.save(run, owner, { status: pause?.status ?? (v8SemanticError ? "BLOCKED" : "FAILED"), blocker: {
          code: pause?.code ?? (v8SemanticError ? "V8_PRODUCTION_GATE_BLOCKED" : "SMART_STAGE_FAILED"), message: error instanceof Error ? error.message : String(error), retryable: pause?.retryable ?? true
        } }, "当前步骤已暂停，未将失败标记为完成");
      }
    });
  }

  async review(projectId: string, id: string, input: {
    action: SmartReviewAction;
    expectedRevision: number;
    creativeId?: string;
    assetKey?: string;
    confirmV8Screenplay?: boolean;
    screenplayHash?: string;
    confirmV8Review?: boolean;
    artifactHash?: string;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) throw new DomainValidationError("任务版本已更新，请刷新后再审核");
      await this.production.assertCurrent(run);
      if (input.action === "SELECT_CREATIVE" && run.status === "WAITING_FOR_CREATIVE_REVIEW") {
        if (!run.creativeBatch?.concepts.some((c) => c.id === input.creativeId)) throw new DomainValidationError("请选择本轮创意方案");
        return this.save(run, owner, { selectedCreativeId: input.creativeId, pendingInstall: "SELECT_CREATIVE", status: "PLANNING" }, "用户明确选择创意");
      }
      if (
        input.action === "CONFIRM_ASSET" &&
        run.status === "WAITING_FOR_ASSET_REVIEW"
      ) {
        if (!input.assetKey || !this.production.acceptProductionAsset) {
          throw new DomainValidationError("请选择需要确认的制作资产");
        }
        const set = await this.production.acceptProductionAsset(
          run,
          input.assetKey
        );
        const nextPatch =
          set.status === "READY"
            ? {
                productionAssetSet: set,
                stage: "SCRIPT" as const,
                status: "PLANNING" as const,
                blocker: undefined
              }
            : set.status === "PLANNED" && run.assetPaidScope
              ? run.assetConsent &&
                  run.assetConsent.scopeHash === run.assetPaidScope.hash
                ? {
                    productionAssetSet: set,
                    status: "ASSET_PREPARING" as const,
                    blocker: undefined
                  }
                : {
                    productionAssetSet: set,
                    status: "READY_FOR_ASSET_PAID_CONFIRM" as const,
                    blocker: undefined
                  }
              : set.status === "PREPARING"
                ? {
                    productionAssetSet: set,
                    status: "ASSET_PREPARING" as const,
                    blocker: undefined
                  }
                : {
                    productionAssetSet: set,
                    status: "WAITING_FOR_ASSET_REVIEW" as const
                  };
        return this.save(
          run,
          owner,
          nextPatch,
          set.status === "READY"
            ? "用户确认最后一个低置信制作资产，进入脚本"
            : set.status === "PLANNED" && run.assetPaidScope
              ? run.assetConsent
                ? "低置信制作资产已确认，继续生成本轮剩余已授权角色/场景资产"
                : "已有参考资产已确认，等待本轮新增角色/场景资产的积分确认"
              : "用户确认一个制作资产，继续处理剩余资产"
        );
      }
      if (input.action === "CONFIRM_SCRIPT" && run.status === "WAITING_FOR_SCRIPT_REVIEW") {
        if (run.options.directorPipeline === "V8") {
          if (!run.script || !run.v8Screenplay ||
              run.v8Screenplay.status !== "DRAFT" ||
              run.v8Screenplay.sourceScriptHash !== run.script.contentHash ||
              run.v8Screenplay.screenplayHash !== hashValue(run.v8Screenplay.screenplay)) {
            throw new DomainValidationError("V8 详细剧本的版本/来源已变化，不能确认；请重新审核");
          }
          if (input.confirmV8Screenplay !== true ||
              input.screenplayHash !== run.v8Screenplay.screenplayHash) {
            throw new DomainValidationError(
              "必须在查看 V8 全场次与逐句台词后，明确确认当前剧本版本；旧版点击或旧哈希不得代替确认"
            );
          }
          const confirmed = await this.production.confirmScript(run);
          return this.save(run, owner, {
            script: confirmed,
            v8Screenplay: {
              ...run.v8Screenplay,
              status: "CONFIRMED" as const,
              sourceScriptHash: confirmed.contentHash,
              approvedAt: new Date().toISOString()
            },
            pendingInstall: "CONFIRM_SCRIPT",
            status: "PLANNING"
          }, "用户明确确认完整 V8 剧本，同步确认同源 ScriptDraft；正式导演仍待独立验收");
        }
        return this.save(run, owner, { script: await this.production.confirmScript(run), pendingInstall: "CONFIRM_SCRIPT", status: "PLANNING" }, "用户明确确认脚本");
      }
      if (input.action === "CONFIRM_V8_DIRECTOR" && run.status === "WAITING_FOR_DIRECTOR_REVIEW" && run.options.directorPipeline === "V8") {
        assertV8DecisionBinding(run);
        if (input.confirmV8Review !== true || input.artifactHash !== run.v8Director?.contentHash) throw new DomainValidationError("请明确审核并采用当前 V8 导演版本；旧哈希无效");
        const { contentHash: _hash, ...base } = run.v8Director!;
        return this.save(run, owner, { v8Director: sealV8({ ...base, status: "CONFIRMED" as const, approvedAt: new Date().toISOString() }),
          stage: "DIRECTOR", status: "PLANNING", paidScope: undefined, consent: undefined }, "用户明确采用 V8 导演，锁定镜头、台词及揭晓时机");
      }
      if (input.action === "CONFIRM_V8_PROMPTS" && run.status === "WAITING_FOR_PROMPT_REVIEW" && run.options.directorPipeline === "V8") {
        assertV8PromptBinding(run, false);
        if (input.confirmV8Review !== true || input.artifactHash !== run.v8Prompts?.contentHash || !this.production.validatePromptsV8) throw new DomainValidationError("请阅读全部镜头提示词及角色声线后明确采用当前版本；旧哈希无效");
        await this.production.validatePromptsV8(run);
        const { contentHash: _hash, ...base } = run.v8Prompts!;
        return this.save(run, owner, { v8Prompts: sealV8({ ...base, status: "CONFIRMED" as const, approvedAt: new Date().toISOString() }),
          stage: "PREFLIGHT", status: "PLANNING", paidScope: undefined, consent: undefined }, "用户明确采用逐镜 PromptPackage；重新准备独立的本轮付费范围");
      }
      if (input.action === "CONFIRM_PLAN" && run.status === "WAITING_FOR_PLAN_REVIEW") {
        if (run.options.directorPipeline === "V8") {
          assertV8PlanBinding(run);
          if (input.confirmV8Review !== true || input.artifactHash !== run.productionPlan?.contentHash) throw new DomainValidationError("请明确审核当前 V8 正式分镜及表演、揭晓时机；旧哈希无效");
        }
        return this.save(run, owner, { productionPlan: await this.production.confirmPlan(run), pendingInstall: "CONFIRM_PLAN", status: "PLANNING" }, "用户明确确认分镜");
      }
      throw new DomainValidationError("当前任务阶段不接受此审核操作");
    });
  }

  /** Edit a new V8 detailed screenplay before user sign-off; no paid effects. */
  async updateV8Screenplay(projectId: string, id: string, input: {
    expectedRevision: number;
    screenplay: unknown;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) {
        throw new DomainValidationError("V8 剧本已经更新，请刷新后重试");
      }
      const draftReview = run.status === "WAITING_FOR_SCRIPT_REVIEW" && run.stage === "SCRIPT" &&
        run.v8Screenplay?.status === "DRAFT" && run.script?.status === "DRAFT";
      const reopen = ["DIRECTOR", "PREFLIGHT"].includes(run.stage) &&
        ["WAITING_FOR_DIRECTOR_REVIEW", "WAITING_FOR_PLAN_REVIEW", "WAITING_FOR_PROMPT_REVIEW", "READY_FOR_PAID_CONFIRM", "BLOCKED", "FAILED"].includes(run.status);
      if (run.options.directorPipeline !== "V8" || (!draftReview && !reopen) || run.pendingInstall ||
          !run.v8Screenplay || !run.script || run.attemptIds.length > 0 || run.consent) {
        throw new DomainValidationError(
          "只能在 V8 生成前审核阶段修改，已提交或正在审批的任务请新建一轮；已确认剧本将保存为新版本"
        );
      }
      const proposal = v8DetailedProposalSchema.parse(input.screenplay);
      if (hashValue(proposal) === run.v8Screenplay.screenplayHash) return run;
      if (!this.production.reviseV8Screenplay) {
        throw new DomainValidationError("V8 剧本人工编辑服务尚未配置");
      }
      await this.production.assertCurrent(run);
      const revised = await this.production.reviseV8Screenplay(run, proposal);
      return this.save(run, owner, {
        script: revised,
        v8Screenplay: {
          format: "PVS_V8_SCREENPLAY_V1",
          status: "DRAFT",
          screenplay: proposal,
          screenplayHash: hashValue(proposal),
          sourceScriptHash: revised.contentHash,
          brief: run.options.requestText
        },
        productionPlan: undefined,
        v8Director: undefined, v8Prompts: undefined,
        directorV3Plan: undefined,
        seedancePromptDrafts: undefined,
        paidScope: undefined,
        consent: undefined,
        attemptIds: [],
        stage: "SCRIPT",
        status: "PLANNING",
        pendingInstall: "SCRIPT",
        blocker: undefined
      }, "用户修改 V8 详细剧本并创建新版本；原有剧本版本保留，导演和付费确认全部失效");
    });
  }

  private assertV8Editable(run: SmartGenerationRun, expectedRevision: number) {
    if (run.revision !== expectedRevision) throw new DomainValidationError("V8 任务版本已更新，请刷新后编辑");
    if (run.options.directorPipeline !== "V8" || run.pendingInstall || run.attemptIds.length ||
        !["WAITING_FOR_DIRECTOR_REVIEW", "WAITING_FOR_PLAN_REVIEW", "WAITING_FOR_PROMPT_REVIEW", "READY_FOR_PAID_CONFIRM", "BLOCKED", "FAILED"].includes(run.status) ||
        !["DIRECTOR", "PREFLIGHT"].includes(run.stage)) throw new DomainValidationError("当前阶段不能覆盖 V8 内容，请在生成前审核阶段编辑或新建一轮");
  }
  async updateDirectorV8(projectId: string, id: string, input: { expectedRevision: number; visualGuidance: Record<string, string> }) {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertV8Editable(run, input.expectedRevision);
      await this.production.assertCurrent(run);
      assertV8DecisionBinding(run);
      const decision = structuredClone(run.v8Director!.decision);
      const shots = decision.clips.flatMap(c => c.shots);
      for (const [shotId, guidance] of Object.entries(input.visualGuidance)) {
        const shot = shots.find(s => s.shotId === shotId);
        if (!shot || !guidance.trim() || guidance.length > 1200) throw new DomainValidationError("请填写当前来源镜头的构图、站位或视线指令，不能改写剧本约束");
        shot.visualGuidance = guidance.trim();
      }
      const { contentHash: _d, ...decisionBase } = decision;
      const record = sealV8({ revision: run.v8Director!.revision + 1, status: "DRAFT" as const,
        generationTarget: run.v8Director!.generationTarget, decision: sealV8(decisionBase) });
      return this.save(run, owner, { v8Director: record, productionPlan: undefined, v8Prompts: undefined,
        paidScope: undefined, consent: undefined, stage: "DIRECTOR", status: "WAITING_FOR_DIRECTOR_REVIEW", blocker: undefined },
        "用户修改导演视觉/站位要求，新版需重新采用；正式分镜、Prompt 和付费范围失效");
    });
  }
  async updatePlanV8(projectId: string, id: string, input: { expectedRevision: number; segments: ProductionPlanSegmentRevision[] }) {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertV8Editable(run, input.expectedRevision);
      await this.production.assertCurrent(run);
      assertV8PlanBinding(run);
      const all = run.productionPlan!.scenes.flatMap(s => s.clips.flatMap(c => c.segments));
      const allowed = new Set(["id", "shotSize", "cameraPosition", "cameraAngle", "cameraMovement", "composition", "lighting"]);
      if (new Set(input.segments.map(s => s.id)).size !== input.segments.length || input.segments.some(s =>
        !all.some(a => a.id === s.id) || Object.keys(s).some(k => !allowed.has(k)))) throw new DomainValidationError("V8 正式分镜只能编辑当前镜头的构图、站位、机位与灯光，动作/台词/时长修改请返回剧本");
      const productionPlan = reviseProductionPlanDraft(run.productionPlan!, { segments: input.segments });
      assertV8PlanBinding({ ...run, productionPlan });
      return this.save(run, owner, { productionPlan, v8Prompts: undefined, paidScope: undefined, consent: undefined,
        pendingInstall: "DIRECTOR", stage: "DIRECTOR", status: "PLANNING", blocker: undefined },
        "用户创建正式分镜新版本，需重新审核分镜和 Prompt；原版本保留，付费范围失效");
    });
  }
  async compilePromptV8(projectId: string, id: string, input: { expectedRevision: number; voiceBindings: V8PromptRecord["voiceBindings"]; packages?: unknown }) {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertV8Editable(run, input.expectedRevision);
      await this.production.assertCurrent(run);
      assertV8PlanBinding(run);
      if (!this.production.compilePromptsV8) throw new DomainValidationError("V8 正式提示词编译器未配置");
      const record = await this.production.compilePromptsV8(run, v8VoiceBindingsSchema.parse(input.voiceBindings));
      if (input.packages !== undefined && hashValue(input.packages) !== hashValue(record.packages)) {
        throw new DomainValidationError("自由文本 Prompt 无法保证动作、台词、声线和揭晓一致；请编辑正式镜头或声线后重新编译，禁止直接删改硬约束");
      }
      return this.save(run, owner, { v8Prompts: record, paidScope: undefined, consent: undefined,
        stage: "PREFLIGHT", status: "WAITING_FOR_PROMPT_REVIEW", blocker: undefined },
        "声线及逐镜 Prompt 已保存新版本；请阅读原句、声音和后期文案并明确采用");
    });
  }

  /** Explicit AI rework of a saved, unspent V3 script.
   * Keeps the original ScriptDraft/plan history and invalidates all downstream
   * director prompts and approval scopes, requiring fresh script sign-off.
   */
  async repairScriptV3(projectId: string, id: string, input: {
    expectedRevision: number;
    confirmScriptRepair: boolean;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertDirectorV3Editable(run, input.expectedRevision);
      if (input.confirmScriptRepair !== true)
        throw new DomainValidationError("必须确认只重新编排当前剧本，并使旧分镜和费用范围失效");
      if (run.consent || run.assetConsent && run.status === "ASSET_PREPARING" ||
          run.attemptIds.length > 0 || !this.production.repairNarrativeScriptV3 || !run.script) {
        throw new DomainValidationError("当前任务已经授权真实生成或缺少剧本修订能力，不能自动重写旧付费范围");
      }
      const revised = await this.production.repairNarrativeScriptV3(run);
      if (revised.feasibility.status !== "PASS")
        throw new DomainValidationError("修订后的剧本必须先通过叙事与时长质检");
      return this.save(run, owner, {
        script: revised.script, scriptFeasibility: revised.feasibility,
        productionPlan: undefined, directorV3Plan: undefined,
        seedancePromptDrafts: undefined, paidScope: undefined,
        consent: undefined, pendingInstall: undefined,
        stage: "SCRIPT", status: "WAITING_FOR_SCRIPT_REVIEW",
        blocker: undefined
      }, "用户请求按剧情重编每段时长并补足叙事；创建新剧本版本，全部旧分镜与费用范围失效，待人工确认");
    });
  }

  async updateScriptV3(projectId: string, id: string, input: {
    expectedRevision: number;
    beats: NonNullable<SmartGenerationRun["script"]>["beats"];
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertDirectorV3Editable(run, input.expectedRevision);
      if (!run.script || !this.production.reviseScriptV3) {
        throw new DomainValidationError(
          "Director V3 脚本编辑服务尚未准备"
        );
      }
      const revised = await this.production.reviseScriptV3(
        run,
        input.beats
      );
      return this.save(
        run,
        owner,
        {
          script: revised.script,
          scriptFeasibility: revised.feasibility,
          productionPlan: undefined,
          directorV3Plan: undefined,
          seedancePromptDrafts: undefined,
          paidScope: undefined,
          consent: undefined,
          attemptIds: [],
          pendingInstall: "SCRIPT",
          stage: "SCRIPT",
          status: "PLANNING",
          blocker: undefined
        },
        "用户修改 Director V3 剧本；只使分镜、Prompt 与生成前检查失效，旧历史版本保留"
      );
    });
  }

  async updateClipContractV3(projectId: string, id: string, input: {
    expectedRevision: number;
    clipId: string;
    purpose: string;
    location: string;
    actionDescriptions: string[];
    camera: {
      shotSize: string;
      position: string;
      angle: string;
      movement: string;
    };
    audio: {
      ambience: string[];
      sfx: string[];
      dialogueOrOs: Array<{
        kind: "DIALOGUE" | "OS";
        text: string;
      }>;
    };
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertDirectorV3Editable(run, input.expectedRevision);
      if (!run.productionPlan || !run.directorV3Plan) {
        throw new DomainValidationError(
          "Director V3 分镜尚未准备"
        );
      }
      const clips = run.productionPlan.scenes.flatMap(
        (scene) => scene.clips
      );
      const index = clips.findIndex(
        (clip) => clip.id === input.clipId
      );
      if (index < 0) {
        throw new DomainValidationError(
          "找不到需要修改的当前分镜"
        );
      }
      const current =
        run.directorV3Plan.clipContracts[index];
      if (!current) {
        throw new DomainValidationError(
          "找不到分镜对应的 Clip Contract"
        );
      }
      if (
        input.actionDescriptions.length !==
        current.actions.length
      ) {
        throw new DomainValidationError(
          "动作数量不能在当前编辑中直接增删；如需重构动作数量，请先修改剧本"
        );
      }
      const updatedContract =
        directorV3ClipContractSchema.parse({
          ...current,
          purpose: input.purpose,
          location: input.location,
          actions: current.actions.map(
            (action, actionIndex) => ({
              ...action,
              description:
                input.actionDescriptions[actionIndex]
            })
          ),
          camera: input.camera,
          audio: {
            ...current.audio,
            mode: "NATIVE",
            ambience: input.audio.ambience,
            sfx: input.audio.sfx,
            dialogueOrOs: input.audio.dialogueOrOs,
            bgm: false
          }
        });
      const {
        contentHash: _oldHash,
        ...planWithoutHash
      } = run.directorV3Plan;
      const nextBase = {
        ...planWithoutHash,
        clipContracts:
          run.directorV3Plan.clipContracts.map(
            (contract, contractIndex) =>
              contractIndex === index
                ? updatedContract
                : contract
          ),
        createdAt: new Date().toISOString()
      };
      const nextPlan = directorV3PlanSchema.parse({
        ...nextBase,
        contentHash: hashValue(nextBase)
      });
      return this.save(
        run,
        owner,
        {
          directorV3Plan: nextPlan,
          productionPlan: undefined,
          seedancePromptDrafts: undefined,
          paidScope: undefined,
          consent: undefined,
          stage: "DIRECTOR",
          status: "PLANNING",
          blocker: undefined
        },
        "用户修改 Director V3 分镜；只重建正式分镜、Prompt 与生成前检查，剧本保持不变"
      );
    });
  }

  async updatePromptV3(projectId: string, id: string, input: {
    expectedRevision: number;
    clipId: string;
    prompt: string;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      this.assertDirectorV3Editable(run, input.expectedRevision);
      if (
        !run.productionPlan ||
        !run.directorV3Plan ||
        !run.seedancePromptDrafts
      ) {
        throw new DomainValidationError(
          "Director V3 最终 Prompt 尚未准备"
        );
      }
      const clips = run.productionPlan.scenes.flatMap(
        (scene) => scene.clips
      );
      const index = clips.findIndex(
        (clip) => clip.id === input.clipId
      );
      const contract =
        index >= 0
          ? run.directorV3Plan.clipContracts[index]
          : undefined;
      if (!contract) {
        throw new DomainValidationError(
          "找不到 Prompt 对应的 Clip Contract"
        );
      }
      assertSeedancePromptV3(input.prompt, contract);
      const draftIndex =
        run.seedancePromptDrafts.findIndex(
          (draft) => draft.clipId === input.clipId
        );
      if (draftIndex < 0) {
        throw new DomainValidationError(
          "找不到需要修改的 Seedance Prompt"
        );
      }
      const current =
        run.seedancePromptDrafts[draftIndex]!;
      const {
        contentHash: _contentHash,
        ...draftWithoutHash
      } = current;
      const nextBase = {
        ...draftWithoutHash,
        promptText: input.prompt,
        status: "DRAFT" as const,
        updatedAt: new Date().toISOString()
      };
      const updatedDraft =
        seedancePromptV3DraftSchema.parse({
          ...nextBase,
          contentHash: hashValue(nextBase)
        });
      const drafts = run.seedancePromptDrafts.map(
        (draft, itemIndex) =>
          itemIndex === draftIndex
            ? updatedDraft
            : draft
      );
      return this.save(
        run,
        owner,
        {
          seedancePromptDrafts: drafts,
          paidScope: undefined,
          consent: undefined,
          stage: "PREFLIGHT",
          status: "PLANNING",
          blocker: undefined
        },
        "用户只修改当前 Seedance Prompt；剧本与分镜保持不变，旧 Preflight/付费确认失效"
      );
    });
  }

  async updateAssetPrompt(projectId: string, id: string, input: {
    expectedRevision: number;
    assetKey: string;
    prompt: string;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) {
        throw new DomainValidationError("任务版本已更新，请刷新后再修改制作资产提示词");
      }
      if (run.status !== "READY_FOR_ASSET_PAID_CONFIRM") {
        throw new DomainValidationError("当前阶段不能修改待生成制作资产提示词");
      }
      const entry = run.productionAssetSet?.entries.find(item => item.key === input.assetKey);
      if (!entry || entry.source !== "DREAMINA_GENERATED" || entry.status !== "PLANNED") {
        throw new DomainValidationError("请选择尚未提交生成的制作资产");
      }
      const normalized = input.prompt.trim();
      if (!normalized) throw new DomainValidationError("制作资产提示词不能为空");
      if (entry.generationPrompt === normalized) return run;
      if (!this.production.updateProductionAssetPrompt) {
        throw new DomainValidationError("制作资产提示词修改能力尚未配置");
      }
      await this.production.assertCurrent(run);
      const updated = await this.production.updateProductionAssetPrompt(
        run,
        input.assetKey,
        normalized
      );
      return this.save(
        run,
        owner,
        {
          productionAssetSet: updated.set,
          assetPaidScope: updated.paidScope,
          assetConsent: undefined,
          stage: "ASSET_PREP",
          status: "READY_FOR_ASSET_PAID_CONFIRM",
          blocker: undefined
        },
        "用户修改制作资产提示词；已重新计算生成请求与积分确认范围，旧确认失效"
      );
    });
  }

  async regenerateAsset(projectId: string, id: string, input: {
    expectedRevision: number;
    assetKey: string;
    prompt?: string;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) {
        throw new DomainValidationError("任务版本已更新，请刷新后再重新生成制作资产");
      }
      if (run.status !== "WAITING_FOR_ASSET_REVIEW") {
        throw new DomainValidationError("当前阶段没有可重新生成的制作资产");
      }
      if (!this.production.regenerateProductionAsset) {
        throw new DomainValidationError("制作资产重新生成能力尚未配置");
      }
      await this.production.assertCurrent(run);
      const regenerated = await this.production.regenerateProductionAsset(
        run,
        input.assetKey,
        input.prompt
      );
      return this.save(
        run,
        owner,
        {
          productionAssetSet: regenerated.set,
          assetPaidScope: regenerated.paidScope,
          assetConsent: undefined,
          stage: "ASSET_PREP",
          status: "READY_FOR_ASSET_PAID_CONFIRM",
          blocker: undefined
        },
        "用户选择重新生成制作资产；已保留旧图片记录，并要求重新确认本次图片生成积分"
      );
    });
  }

  async confirmAssetPaid(projectId: string, id: string, input: {
    scopeHash: string;
    confirmPaidAssetGeneration: boolean;
    acceptedUnknownCostRisk: boolean;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.workspaceContinuation && run.assetPaidScope?.assets.some(item => item.costStatus !== "KNOWN"))
        throw new DomainValidationError("后台生成费用尚未核实，当前续接任务不接受未知费用授权；未生成或扣费");
      if (run.workspaceContinuation) assertCurrentQuote(run, "IMAGE");
      if (
        input.confirmPaidAssetGeneration !== true ||
        !run.assetPaidScope ||
        input.scopeHash !== run.assetPaidScope.hash
      ) {
        throw new DomainValidationError(
          "必须明确确认当前角色/场景资产与费用范围"
        );
      }
      if (run.assetConsent) {
        if (
          run.assetConsent.scopeHash !== input.scopeHash ||
          run.assetConsent.acceptedUnknownCostRisk !==
            input.acceptedUnknownCostRisk
        ) {
          throw new DomainValidationError("不能变更已保存的制作资产付费确认");
        }
        return run;
      }
      if (run.status !== "READY_FOR_ASSET_PAID_CONFIRM") {
        throw new DomainValidationError("当前任务尚未准备好制作资产付费确认");
      }
      if (
        run.assetPaidScope.assets.some(item => item.costStatus === "UNKNOWN") &&
        input.acceptedUnknownCostRisk !== true
      ) {
        throw new DomainValidationError(
          "制作资产成本未知，需要明确接受积分风险"
        );
      }
      if (!this.production.validateAssetPaidScope) {
        throw new DomainValidationError("制作资产付费校验服务尚未配置");
      }
      await this.production.validateAssetPaidScope(run);
      return this.save(
        run,
        owner,
        {
          assetConsent: {
            scopeHash: input.scopeHash,
            approvedAt: new Date().toISOString(),
            acceptedUnknownCostRisk: input.acceptedUnknownCostRisk,
            source: "EXPLICIT_SMART_RUN_ASSET_PAID_CONFIRMATION"
          },
          stage: "ASSET_PREP",
          status: "ASSET_PREPARING",
          blocker: undefined
        },
        "已保存本轮角色/场景制作资产的明确积分确认；不覆盖重做或新增资产"
      );
    });
  }

  async retryAsset(projectId: string, id: string, input: {
    expectedRevision: number;
    assetKey: string;
    prompt?: string;
  }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) {
        throw new DomainValidationError("任务版本已更新，请刷新后再处理制作资产");
      }
      if (
        run.status !== "BLOCKED" ||
        run.blocker?.code !== "ASSET_REMOTE_RESULT_STALE"
      ) {
        throw new DomainValidationError("当前任务没有可重新准备的悬挂制作资产");
      }
      if (!this.production.retryProductionAsset) {
        throw new DomainValidationError("制作资产恢复服务尚未配置");
      }
      await this.production.assertCurrent(run);
      const retried = await this.production.retryProductionAsset(
        run,
        input.assetKey,
        input.prompt
      );
      return this.save(
        run,
        owner,
        {
          productionAssetSet: retried.set,
          assetPaidScope: retried.paidScope,
          assetConsent: undefined,
          stage: "ASSET_PREP",
          status: "READY_FOR_ASSET_PAID_CONFIRM",
          blocker: undefined
        },
        "悬挂制作资产已重新准备；尚未提交新任务，必须重新确认本轮制作资产积分范围"
      );
    });
  }

  async confirmPaid(projectId: string, id: string, input: { scopeHash: string; confirmPaidGeneration: boolean; acceptedUnknownCostRisk: boolean }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.workspaceContinuation && run.paidScope?.requests.some(item => item.costStatus !== "KNOWN"))
        throw new DomainValidationError("后台生成费用尚未核实，当前续接任务不接受未知费用授权；未生成或扣费");
      if (run.workspaceContinuation) assertCurrentQuote(run, "VIDEO");
      if (input.confirmPaidGeneration !== true || !run.paidScope || input.scopeHash !== run.paidScope.hash) {
        throw new DomainValidationError("必须明确确认当前镜头与费用范围，旧页面或其他任务的确认无效");
      }
      if (run.consent) {
        if (run.consent.scopeHash !== input.scopeHash || run.consent.acceptedUnknownCostRisk !== input.acceptedUnknownCostRisk) throw new DomainValidationError("不能变更已保存的付费确认");
        return run;
      }
      if (run.status !== "READY_FOR_PAID_CONFIRM") throw new DomainValidationError("当前任务尚未准备好付费确认");
      if (run.paidScope.requests.some((r) => r.costStatus === "UNKNOWN") && input.acceptedUnknownCostRisk !== true) {
        throw new DomainValidationError("成本未知，需要明确接受积分风险");
      }
      await this.production.assertCurrent(run);
      await this.production.validatePaidScope(run);
      // A historical PASS report must not grandfather a mechanically divided
      // script into a new, irrevocable paid generation approval.
      if (run.options.directorVersion === 3 && run.options.directorPipeline !== "V8" && run.script) {
        const audit = auditNarrativeTiming(run.script);
        if (!isScriptDurationWithinTolerance(run.script.targetDurationMs, audit.totalMs) ||
            audit.issues.some(issue => issue.severity === "REVISE")) {
          throw new DomainValidationError(
            "当前剧本节奏或剧情衔接未通过最新质量审核。请先在剧本面板重新编排并审核；旧镜头和费用范围不能沿用。"
          );
        }
      }
      return this.save(run, owner, { consent: { scopeHash: input.scopeHash, approvedAt: new Date().toISOString(), acceptedUnknownCostRisk: input.acceptedUnknownCostRisk, source: "EXPLICIT_SMART_RUN_PAID_CONFIRMATION" }, stage: "APPROVAL", status: "APPROVING", blocker: undefined }, "已保存用户本次明确付费确认；只覆盖上述请求，不覆盖重做或新镜头");
    });
  }

  async resume(projectId: string, id: string, expectedRevision?: number): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      // A lost response may be retried. Never resume a newer checkpoint on behalf of an old review.
      if(expectedRevision!==undefined && run.revision!==expectedRevision)return run;
      if (closedSmartStatuses.includes(run.status) || run.status === "REVIEW_READY") return run;
      if (
        run.workflowVersion === 2 &&
        run.productionAssetSet &&
        this.production.reconcileProductionAssetReview
      ) {
        await this.production.assertCurrent(run);
        const reconciled = await this.production.reconcileProductionAssetReview(run);
        if (
          reconciled.contentHash !== run.productionAssetSet.contentHash &&
          reconciled.status === "NEEDS_REVIEW"
        ) {
          return this.save(
            run,
            owner,
            {
              productionAssetSet: reconciled,
              script: undefined,
              v8Screenplay: undefined, v8Director: undefined, v8Prompts: undefined,
              productionPlan: undefined,
              paidScope: undefined,
              consent: undefined,
              stage: "ASSET_PREP",
              status: "WAITING_FOR_ASSET_REVIEW",
              blocker: undefined
            },
            "检测到旧任务中有 AI 生成资产未记录人工确认；已退回制作资产看图确认，并使旧脚本/分镜失效"
          );
        }
      }
      if (
        run.workflowVersion === 2 &&
        run.stage === "ASSET_PREP" &&
        run.status === "BLOCKED" &&
        run.blocker?.code === "PRODUCTION_ASSET_GENERATION_FAILED" &&
        run.productionAssetSet
      ) {
        if (!this.production.recoverProductionAssetResults) {
          throw new DomainValidationError("原图片结果恢复功能尚未配置");
        }
        await this.production.assertCurrent(run);
        const recovered = await this.production.recoverProductionAssetResults(run);
        if (recovered.contentHash === run.productionAssetSet.contentHash) {
          throw new DomainValidationError(
            "当前失败不属于可直接接回的图片结果；请核查原即梦任务后再决定是否重新生成"
          );
        }
        return this.save(
          run,
          owner,
          {
            productionAssetSet: recovered,
            status: "ASSET_PREPARING",
            blocker: undefined
          },
          "仅重新查询、接收原即梦任务图片，保留原提交编号与积分确认，不产生新的图片生成请求"
        );
      }
      if ([
        "WAITING_FOR_CREATIVE_REVIEW",
        "WAITING_FOR_ASSET_REVIEW",
        "READY_FOR_ASSET_PAID_CONFIRM",
        "WAITING_FOR_SCRIPT_REVIEW",
        "WAITING_FOR_PLAN_REVIEW",
        "WAITING_FOR_DIRECTOR_REVIEW", "WAITING_FOR_PROMPT_REVIEW",
        "READY_FOR_PAID_CONFIRM"
      ].includes(run.status)) return run;
      if (run.blocker?.retryable === false) throw new DomainValidationError(run.blocker.message);
      return this.save(run, owner, { status: this.runnable(run.stage), blocker: undefined }, "用户恢复原检查点，不扩展付费范围或重提未知任务");
    });
  }

  async configurePostProduction(projectId: string, id: string, input: { expectedRevision: number; settings: unknown }): Promise<SmartGenerationRun> {
    const settings = postProductionSettingsSchema.parse(input.settings);
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision) throw new DomainValidationError("任务已更新，请刷新后修改后期设置");
      if (closedSmartStatuses.includes(run.status) || ["RENDER", "FINAL_REVIEW"].includes(run.stage)) throw new DomainValidationError("本轮后期已提交渲染，请到时间线创建新编辑版本");
      return this.save(run, owner, { postProduction: settings,
        ...(run.stage === "AUTO_EDIT" ? { status: "AUTO_EDITING" as const, blocker: undefined } : {}) },
        "用户更新后期音轨与字幕设置；付费范围、产品事实和视频生成审批均保持不变");
    });
  }

  async adoptTimeline(projectId: string, id: string, input: { expectedRevision: number; timelineId: string; timelineHash: string }): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.revision !== input.expectedRevision || !["AUTO_EDIT", "CLIP_REVIEW"].includes(run.stage) || closedSmartStatuses.includes(run.status)) throw new DomainValidationError("当前任务不能采用此时间线版本");
      await this.production.assertCurrent(run);
      await this.production.reviewClips(run);
      if (!this.production.adoptTimeline) throw new DomainValidationError("当前执行器不支持采用手工时间线");
      const chosen = { id: input.timelineId, hash: input.timelineHash };
      await this.production.adoptTimeline(run, chosen);
      return this.save(run, owner, { timelineRef: chosen, stage: "RENDER", status: "RENDERING", blocker: undefined }, "用户明确采用已确认的手工时间线，不覆盖其编辑，准备渲染");
    });
  }

  async cancel(projectId: string, id: string): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (closedSmartStatuses.includes(run.status)) return run;
      await this.production.cancel(run);
      return this.save(run, owner, { status: "CANCELLED", blocker: undefined }, "已停止本地后续编排并撤销未用请求；已提交远端任务不宣称已取消");
    });
  }

  async confirmFinal(projectId: string, id: string, expectedRevision?: number): Promise<SmartGenerationRun> {
    return this.exclusive(projectId, id, async (run, owner) => {
      if (run.status === "COMPLETED") return run;
      if(expectedRevision!==undefined && run.revision!==expectedRevision)throw new DomainValidationError("原任务版本已变化；成片审核已保存，请核对当前任务后确认同步");
      if (run.status !== "REVIEW_READY" || !await this.production.finalConfirmed(run)) throw new DomainValidationError("请在成片页确认当前视频后再结束任务");
      return this.save(run, owner, { status: "COMPLETED" }, "最终成片已确认；发布仍由独立发布流程处理");
    });
  }

  /**
   * Recover only one explicitly authorized SmartRun after an unclean process exit.
   * Never inspect or release any unrelated project lease. Existing owner matching
   * in releaseAbandoned prevents an observed lease race from stealing a new one.
   */
  async recoverAbandonedScoped(projectId: string, runId: string): Promise<boolean> {
    const run = await this.repo.get(projectId, runId);
    if (!run) return false;
    const lease = await this.repo.lease(projectId, runId);
    if (!lease) return false;
    let dead = false;
    try {
      process.kill(lease.pid, 0);
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (!dead) return false;
    await this.repo.releaseAbandoned(projectId, runId, lease.owner);
    return true;
  }

  /** Release only provably dead OS owners. A live/unknown owner is never displaced by a timeout. */
  async recoverAbandoned(): Promise<void> {
    for (const run of await this.repo.list()) {
      const lease = await this.repo.lease(run.projectId, run.id);
      if (!lease) continue;
      let dead = false;
      try { process.kill(lease.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (dead) await this.repo.releaseAbandoned(run.projectId, run.id, lease.owner);
    }
  }
}
