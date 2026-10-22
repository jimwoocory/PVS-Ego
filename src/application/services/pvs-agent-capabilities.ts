import {adaptiveCadenceSchema} from "../../domain/operations-cadence.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {canvasShortPreviewInput} from "../../domain/canvas-short-preview.js";
import {CanvasShortDeliveryService} from "./canvas-short-delivery.js";
import type { AgentCapability, AgentCapabilityCatalog, AgentCapabilityContext } from "../ports/agent-capability.js";
import type {EgoLiteDouyinReadPort,EgoDouyinReadInput} from "../ports/ego-lite-douyin-read.js";
import type { BusinessStage, CapabilityEffect, CapabilityResult, CycleEvidence } from "../../domain/agent-cycle.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {assertSavedMetricSnapshot} from "./douyin-read-evidence-audit.js";
import { creativeBatchSchema, type CreativeBatch } from "../../domain/schemas.js";
import { smartRunOptionsSchema, type SmartGenerationRun } from "../../domain/smart-generation.js";
import { publishProviderTypeSchema } from "../../domain/publish.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ProductFlowRepository } from "../ports/product-flow-repository.js";
import type { ProductInputStore } from "../ports/product-input-store.js";
import type { ResearchRepository } from "../ports/research-repository.js";
import type { FinalOutputRepository } from "../ports/final-output-repository.js";
import type { PublishRepository } from "../ports/publish-repository.js";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import type { ResearchService } from "./research-service.js";
import type { AiGenerationService } from "./ai-generation.js";
import type { SmartGenerationService } from "./smart-generation-service.js";
import type { FinalAssemblyService } from "./final-assembly-service.js";
import type { FinalQcService } from "./final-qc-service.js";
import type { ReviewService } from "./review-service.js";
import type { ReferenceVideoAnalysisService } from "./reference-video-analysis.js";
import type { PublishBridgeService } from "./publish-bridge-service.js";
import type { DouyinOpsDashboardService } from "./douyin-ops-dashboard-service.js";
import type { DouyinMetricService } from "./douyin-metric-service.js";
import type { DouyinCommentService } from "./douyin-comment-service.js";
import type { DouyinCollectionService } from "./douyin-collection-service.js";
import type { DouyinOperationsScheduleService } from "./douyin-operations-schedule-service.js";
import type { DouyinCommentClassificationService } from "./douyin-comment-classification-service.js";
import type { DouyinRetrospectiveService } from "./douyin-retrospective-service.js";
import type { DouyinCreativeFeedbackService } from "./douyin-creative-feedback-service.js";
import { assertCanonicalProductArtifactReady, confirmProductTruthDraft } from "./review-actions.js";
import type { StructuredAiRequest } from "../ports/structured-ai-runtime.js";
import { readSavedProductionPlanning } from "./production-continuation.js";
import { assertCurrentQuote } from "./production-quote-service.js";

export type PvsAgentCapabilityDependencies = {
  productFlow: ProductFlowService; productRepo: ProductFlowRepository; productInput: ProductInputStore;
  research: ResearchService; researchRepo: ResearchRepository; aiGeneration: AiGenerationService;
  collectEgoLiteEvidence?: (context:AgentCapabilityContext,input:{goal:string;sourceUrls:Array<{url:string;sourceType:"USER_URL"}>})=>Promise<Awaited<ReturnType<ResearchService["startRun"]>>>;
  ownedEgoLiteSourceUrl?: string;
  egoLiteDouyinRead?:EgoLiteDouyinReadPort;
  smartGeneration: SmartGenerationService; referenceVideo: ReferenceVideoAnalysisService;
  finalOutput: FinalOutputRepository; finalAssembly: FinalAssemblyService; finalQc: FinalQcService; review: ReviewService;
  publishBridge: PublishBridgeService; publishRepo: PublishRepository;
  opsDashboard: DouyinOpsDashboardService; opsRepo: DouyinOpsRepository; metrics: DouyinMetricService;
  comments: DouyinCommentService; classifier: DouyinCommentClassificationService;
  retrospective: DouyinRetrospectiveService; feedback: DouyinCreativeFeedbackService;
  collections?: DouyinCollectionService;
  schedules?: DouyinOperationsScheduleService;
  /** Explicit account inspection only; this is the operations UID, not publishing open_id. */
  readOpsAccount?(): Promise<{ uid: string }>;
  artifacts: ArtifactRepository; projectsRoot: string; publicBaseUrl: string;
  /** Called only for a concrete publication preview/submit, never by snapshots. */
  readPublishAccount(projectId: string): Promise<{ accountId: string; displayName: string }>;
};
const id = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const empty = z.object({}).strict();
const runInput = z.object({ runId: id }).strict();
const runStepInput = z.object({ runId: id, expectedRevision: z.number().int().positive() }).strict();
const source = z.enum(["OFFICIAL", "USER_URL", "PUBLIC_PRODUCT", "COMPETITOR", "INDUSTRY", "TREND", "PLATFORM"]);
function assertOwnedEgoLiteSources(baseUrl: string, sources: Array<{ url: string; sourceType: string }>, ownedUrl?: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port) throw new DomainValidationError("Ego Lite 本机来源尚未配置");
  for (const item of sources) {
    const url = new URL(item.url);
    if (item.sourceType !== "USER_URL" || url.origin !== base.origin || url.username || url.password || url.search || url.hash ||
        !/^\/bridge-fixture\/[A-Za-z0-9-]{1,80}$/.test(url.pathname))
      throw new DomainValidationError("当前仅允许明确绑定的本机合成来源");
  }
  if(ownedUrl && (sources.length!==1 || sources[0]!.url!==ownedUrl))throw new DomainValidationError("本机合成来源已经变化，请重新准备并确认当前动作");
}
const receiptSchema = z.object({
  projectId: id, cycleId: id, actionId: id, kind: z.string(), createdAt: z.string(), payload: z.record(z.string(), z.unknown())
}).strict();

function answer(summary: string, data?: unknown, evidence: CycleEvidence[] = [], status: CapabilityResult["status"] = "COMPLETE"): CapabilityResult {
  return { status, summary, ...(data !== undefined ? { data } : {}), evidence };
}
function evidence(stage: BusinessStage, kind: string, value: string, detail?: string): CycleEvidence {
  return { stage, kind, id: value, ...(detail ? { detail } : {}) };
}
function writeIntentId(context: AgentCapabilityContext) {
  const value = hashValue({ projectId: context.projectId, cycleId: context.cycleId, actionId: context.actionId });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

/** Application-service adapters, not browser automation and not an alternative business state store. */
export class PvsAgentCapabilities implements AgentCapabilityCatalog {
  private readonly capabilities = new Map<string, AgentCapability>();
  constructor(private readonly d: PvsAgentCapabilityDependencies) { this.install(); }
  list() { return [...this.capabilities.values()]; }
  get(name: string) {
    const found = this.capabilities.get(name);
    if (!found) throw new DomainValidationError("未知的后台能力：" + name);
    return found;
  }
  private add<S extends z.ZodType>(definition: {
    id: string; title: string; description: string; stage?: BusinessStage; effect: CapabilityEffect; inputSchema: S;
    run(context: AgentCapabilityContext, input: z.output<S>): Promise<CapabilityResult>;
    preview?(projectId: string, input: z.output<S>): Promise<string>;
  }) {
    const { run: execute, preview, ...metadata } = definition;
    this.capabilities.set(definition.id, {
      ...metadata,
      run: async (context, input) => {
        const parsed = definition.inputSchema.parse(input);
        // Do not trust model-supplied confirmation flags. The runtime owns context.
        if (["HUMAN_DECISION", "EXTERNAL_WRITE", "PAID_GENERATION"].includes(definition.effect) && !context.confirmed)
          throw new DomainValidationError("当前操作需要用户针对具体内容确认");
        return execute(context, parsed);
      },
      ...(preview ? { preview: async (projectId: string, input: Record<string, unknown>) =>
        preview(projectId, definition.inputSchema.parse(input)) } : {})
    });
  }
  private async workspace(projectId: string) {
    const workspace = await this.d.productFlow.getWorkspace(projectId);
    if (!workspace) throw new DomainValidationError("项目不存在");
    return workspace;
  }
  private async run(projectId: string, runId: string) {
    const run = await this.d.smartGeneration.get(projectId, runId);
    if (!run || run.projectId !== projectId) throw new DomainValidationError("制作任务不属于当前项目");
    return run;
  }
  private async selectionBatch(projectId: string, input: { creativeId: string; batch?: { id: string; version: number; contentHash: string } }) {
    const workspace = await this.workspace(projectId);
    const ref = input.batch;
    const value = ref ? await this.d.productRepo.getVersion<CreativeBatch>(projectId, "CreativeBatch", ref.id, ref.version) : workspace.creativeBatch;
    const parsed = creativeBatchSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.status !== "ACTIVE" ||
        (ref && (parsed.data.id !== ref.id || parsed.data.version !== ref.version || parsed.data.contentHash !== ref.contentHash)))
      throw new DomainValidationError("创意候选批次不存在、已失效或版本已改变");
    const batch = parsed.data, truth = workspace.productTruth;
    if (!truth || truth.status !== "CONFIRMED" || batch.productTruthRef.entityId !== truth.id ||
        batch.productTruthRef.version !== truth.version || batch.productTruthRef.hash !== truth.contentHash)
      throw new DomainValidationError("创意依据的产品事实已改变，请重新生成方案");
    if (!batch.concepts.some(concept => concept.id === input.creativeId))
      throw new DomainValidationError("所选创意不属于此批次");
    return batch;
  }
  private runResult(run: SmartGenerationRun): CapabilityResult {
    const unknown = /UNKNOWN|RECONCILE_REQUIRED/.test(run.blocker?.code ?? "");
    const status = unknown ? "OUTCOME_UNKNOWN" : ["BLOCKED", "FAILED", "CANCELLED"].includes(run.status) ? "BLOCKED"
      : /WAITING|READY_FOR_.*CONFIRM|REVIEW_READY/.test(run.status) ? "WAITING_USER" : run.status === "COMPLETED" ? "COMPLETE" : "RUNNING";
    return { ...answer("制作任务：" + run.status, run, [evidence("PRODUCTION", "SMART_RUN", run.id)], status),
      resumeHref: `/projects/${encodeURIComponent(run.projectId)}/smart?activeRun=${encodeURIComponent(run.id)}` };
  }
  private store(projectId: string) { return new LocalArtifactStore(path.resolve(this.d.projectsRoot, projectId), this.d.artifacts); }
  private async record(context: AgentCapabilityContext, kind: string, payload: Record<string, unknown>) {
    const key = hashValue({ projectId: context.projectId, cycleId: context.cycleId, actionId: context.actionId, kind });
    const existing = await this.d.artifacts.findById("agent-evidence-" + key);
    if (existing) {
      const saved = await this.readRecord(context.projectId, existing.id);
      if (!saved || saved.kind !== kind || hashValue(saved.payload) !== hashValue(payload))
        throw new DomainValidationError("同一操作已有不同的证据记录，禁止覆盖");
      return existing;
    }
    return this.store(context.projectId).writeImmutable({ id: "agent-evidence-" + key, projectId: context.projectId,
      kind: "STRUCTURED_SNAPSHOT", relativePath: "agent-evidence/" + key + ".json", immutable: true, mimeType: "application/json",
      bytes: Buffer.from(JSON.stringify({ projectId: context.projectId, cycleId: context.cycleId, actionId: context.actionId,
        kind, createdAt: new Date().toISOString(), payload }), "utf8") });
  }
  private async readRecord(projectId: string, artifactId: string) {
    const artifact = await this.d.artifacts.findById(artifactId);
    if (!artifact || artifact.projectId !== projectId || artifact.integrityStatus !== "READY" ||
        artifact.kind !== "STRUCTURED_SNAPSHOT" || !artifact.relativePath.startsWith("agent-evidence/")) return null;
    try {
      const bytes = await fs.readFile(this.store(projectId).resolveArtifactPath(artifact.relativePath));
      if (sha256Bytes(bytes) !== artifact.sha256) return null;
      const parsed = receiptSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      return parsed.success && parsed.data.projectId === projectId ? parsed.data : null;
    } catch { return null; }
  }
  private async bound(projectId: string) {
    const binding = await this.d.opsRepo.latestWorkBinding(projectId, { preferBound: true });
    if (!binding || binding.status !== "BOUND" || !binding.awemeId) throw new DomainValidationError("请先关联当前项目的已发布作品");
    if (binding.source === "HISTORICAL_WORK") {
      if (!this.d.readOpsAccount || (await this.d.readOpsAccount()).uid !== binding.opsAccountUid)
        throw new DomainValidationError("历史作品运营账号已改变，请恢复原账号后继续");
    }
    return binding;
  }
  private async publication(projectId: string, packageId: string) {
    const pkg = await this.d.publishRepo.findPackageById(packageId);
    if (!pkg || pkg.projectId !== projectId) throw new DomainValidationError("发布包不属于当前项目");
    return pkg;
  }
  private async publishPreview(projectId: string, input: { packageId: string; expectedAccountId: string }) {
    const pkg = await this.publication(projectId, input.packageId);
    const account = await this.d.readPublishAccount(projectId);
    if (!account.accountId || account.accountId !== input.expectedAccountId) throw new DomainValidationError("发布账号已改变或未确认，请重新核对账号");
    const preference = await this.d.publishBridge.getPreference(projectId);
    if (preference.providerType !== pkg.providerType) throw new DomainValidationError("当前发布方式与发布包不一致");
    const channels = { DOUYIN_BROWSER_AUTOMATION: "抖音浏览器自动发布", DOUYIN_SDK_HANDOFF: "抖音客户端唤起发布",
      DOUYIN_H5_HANDOFF: "抖音扫码投稿", DOUYIN_OPENAPI_DIRECT: "抖音开放平台直接发布", MANUAL_EXPORT: "下载成片后手动发布" };
    return [`发布账号：${account.displayName || "未提供昵称"}（账号 ID：${account.accountId}）`, `发布渠道：${channels[pkg.providerType]}`,
      `标题：${pkg.titleDraft}`, `说明：${pkg.descriptionDraft || "未填写"}`, `成片版本：${pkg.finalAssemblyId}`,
      `视频文件：${pkg.finalArtifactId}`, `文件校验值：${pkg.finalArtifactHash}`].join("\n");
  }
  private async scheduleScope(projectId: string, input: { bindingId: string; awemeId: string; expectedAccountId: string }) {
    const binding = await this.d.opsRepo.findWorkBindingById(input.bindingId);
    if (!binding || binding.projectId !== projectId || binding.status !== "BOUND" || binding.awemeId !== input.awemeId)
      throw new DomainValidationError("运营计划的项目、作品与关联记录不一致，请重新核对");
    if (!this.d.readOpsAccount) throw new DomainValidationError("当前未配置运营账号 UID 核验能力");
    const account = await this.d.readOpsAccount();
    if (!account.uid || account.uid === "0" || account.uid !== input.expectedAccountId)
      throw new DomainValidationError("实际运营账号 UID 与本次确认不一致，请重新核对");
    return binding;
  }
  private install() {
    for(const operation of ["open","identity","works"] as const){
      const label={open:"打开独立抖音登录会话",identity:"核验 Ego Lite 当前抖音账号",works:"读取已核验账号的本人作品指标"}[operation];
      const schema=operation==="works"?z.object({epoch:z.string().min(1).max(120),expectedAccountUid:z.string().regex(/^[1-9]\d{0,39}$/),count:z.number().int().min(1).max(20),cursor:z.string().regex(/^(0|[1-9]\d{0,19})$/).default("0"),expectedPageToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict():z.object({epoch:z.string().min(1).max(120)}).strict();
      this.add({id:"operations.ego-lite-"+operation,title:label,description:"具体确认后通过独立 Ego Lite 执行；只读本人账号/已确认单页作品，不发布、不回复、不调用模型。",stage:"OPERATIONS",effect:"HUMAN_DECISION",inputSchema:schema,
        preview:async(projectId,input)=>{const port=this.d.egoLiteDouyinRead;if(!port||port.peek().epoch!==input.epoch)throw new DomainValidationError("当前 Ego Lite 运营会话已变化或未配置，请重新准备");return JSON.stringify({projectId,operation:label,source:port.peek().source,url:port.peek().source==="LIVE_DOUYIN"?"https://www.douyin.com/user/self":"本机合成夹具",...input,limits:"每页单独确认，绑定上页回执及游标；每页最多20条，每条链最多5页，不读取其他账号、不发布、不回复；登录与控制归还由用户手动完成"},null,2);},
        run:async(context,input)=>{const port=this.d.egoLiteDouyinRead;if(!port)throw new DomainValidationError("Ego Lite 运营读取器尚未配置");
          const value=await port.perform(context,{...input,operation} as EgoDouyinReadInput);
          const artifact=await this.record(context,"EGO_LITE_DOUYIN_READ",value as unknown as Record<string,unknown>);
          return answer(label+"："+value.status+"；"+value.message,value,[evidence("OPERATIONS","EGO_LITE_DOUYIN_READ",artifact.id)],"WAITING_USER");}
      });
    }
    this.add({ id: "project.inspect", title: "查看当前项目", description: "只读本地事实、任务、作品和已保存成果。", effect: "READ", inputSchema: empty,
      run: async c => answer("当前项目状态", await this.snapshot(c.projectId)) });
    this.add({ id: "project.confirm-truth", title: "确认产品事实", description: "核对具体产品事实、使用规则及产品主图后才能确认。", effect: "HUMAN_DECISION", inputSchema: z.object({ expectedHash: hash,
      dispositions: z.record(z.string(), z.enum(["KEEP_UNVERIFIED", "REJECT", "PROMOTE"])),
      usageRuleDispositions: z.record(z.string(), z.enum(["KEEP_UNVERIFIED", "REJECT", "CONFIRM"])) }).strict(),
      preview: async (p, i) => JSON.stringify({ truth: (await this.workspace(p)).productTruth, dispositions: i.dispositions, usageRuleDispositions: i.usageRuleDispositions }, null, 2),
      run: async (c, i) => { const w = await this.workspace(c.projectId); const truth = w.productTruth;
        if (!truth || truth.contentHash !== i.expectedHash) throw new DomainValidationError("产品事实版本已改变");
        const material = await this.d.productInput.latest(c.projectId);
        if (!material) throw new DomainValidationError("请先保存产品资料");
        assertCanonicalProductArtifactReady(truth, material.assets, await this.d.artifacts.listByProject(c.projectId));
        const confirmed = truth.status === "CONFIRMED" ? truth : confirmProductTruthDraft(truth, i.dispositions, new Date(), i.usageRuleDispositions);
        await this.d.productFlow.confirmProductTruth(confirmed);
        return answer("产品事实已确认", confirmed); } });
    this.add({ id: "research.inspect", title: "查看行业视频研究", description: "读取本项目已保存研究与候选视频，未实际搜索。", stage: "RESEARCH", effect: "READ", inputSchema: empty,
      run: async c => answer("已保存研究", await this.d.research.pageData(c.projectId)) });
    this.add({ id: "research.collect-evidence", title: "只读采集本机合成来源", description: "经具体来源确认后仅保存本机合成页面证据；不搜索、不生成摘要、不调用模型。", stage: "RESEARCH", effect: "HUMAN_DECISION",
      inputSchema: z.object({ goal: z.string().trim().min(3).max(3000), sourceUrls: z.array(z.object({ url: z.string().url(), sourceType: source }).strict()).min(1).max(6) }).strict(),
      preview: async (_projectId, input) => { assertOwnedEgoLiteSources(this.d.publicBaseUrl, input.sourceUrls,this.d.ownedEgoLiteSourceUrl); return JSON.stringify({ goal: input.goal, sourceUrls: input.sourceUrls, operation: "仅采集来源证据，不运行搜索或模型" }, null, 2); },
      run: async (context, input) => {
        assertOwnedEgoLiteSources(this.d.publicBaseUrl, input.sourceUrls,this.d.ownedEgoLiteSourceUrl);
        if(!this.d.collectEgoLiteEvidence)throw new DomainValidationError("Ego Lite 本机执行器尚未接入，未开始采集");
        const result = await this.d.collectEgoLiteEvidence(context,{goal:input.goal,sourceUrls:input.sourceUrls.map(item=>({url:item.url,sourceType:"USER_URL"}))});
        return answer("只读来源采集：" + result.run.status+(result.run.blockerMessage?"；"+result.run.blockerMessage:""), result, [evidence("RESEARCH", "RESEARCH_RUN", result.run.id)], result.run.status === "BLOCKED" ? "WAITING_USER" : result.run.status === "FAILED" ? "BLOCKED" : "COMPLETE");
      } });
    this.add({ id: "research.start", title: "搜索行业与同类视频", description: "启动真实行业视频搜索与资料研究；遇登录或风控保留原任务。", stage: "RESEARCH", effect: "MODEL", inputSchema: z.object({
      goal: z.string().trim().min(3).max(3000), queries: z.array(z.string().trim().min(1).max(200)).max(12),
      sourceUrls: z.array(z.object({ url: z.string().url(), sourceType: source }).strict()).max(30).default([]),
      sort: z.enum(["RELEVANCE", "MOST_LIKED", "LATEST"]).default("MOST_LIKED"), timeRange: z.enum(["ANY", "DAY", "WEEK", "HALF_YEAR"]).default("WEEK"), count: z.number().int().min(1).max(30).default(12)
    }).strict(), run: async (c, i) => {
      const material = await this.d.productInput.latest(c.projectId);
      const data = await this.d.research.startRun({ projectId: c.projectId, mode: "DEEP", goal: i.goal, queries: i.queries, sourceUrls: i.sourceUrls,
        ...(material ? { productInput: { productName: material.productName, brand: material.brand, category: material.category } } : {}),
        marketVideo: { enabled: true, sort: i.sort, timeRange: i.timeRange, count: i.count } });
      const status = data.run.status === "BLOCKED" ? "WAITING_USER" : data.run.status === "FAILED" ? "PARTIAL" : "COMPLETE";
      return answer("研究任务：" + data.run.status, data, [evidence("RESEARCH", "RESEARCH_RUN", data.run.id)], status); } });
    this.add({ id: "research.resume", title: "续接原研究任务", description: "处理登录等前置后复用已有研究任务。", stage: "RESEARCH", effect: "MODEL", inputSchema: runInput,
      run: async (c, i) => { const data = await this.d.research.resumeRun(c.projectId, i.runId); return answer("研究任务：" + data.run.status, data,
        [evidence("RESEARCH", "RESEARCH_RUN", data.run.id)], data.run.status === "BLOCKED" ? "WAITING_USER" : "COMPLETE"); } });
    this.add({ id: "research.analyze", title: "分析行业参考视频", description: "下载被选候选并调用既有视频分析，不把竞品描述提升为产品事实。", stage: "RESEARCH", effect: "MODEL", inputSchema: z.object({ runId: id, candidateId: id }).strict(),
      run: async (c, i) => { const data = await this.d.research.analyzeMarketVideo({ projectId: c.projectId, runId: i.runId, candidateId: i.candidateId });
        return answer("行业视频已拆解", data, [evidence("RESEARCH", "REFERENCE_VIDEO_PROFILE", data.profile.id)]); } });
    this.add({id:"research.search-more",title:"在原研究中补充行业视频搜索",description:"按明确关键词搜索并补充真实候选，保留原研究、已下载媒体和已有分析。",stage:"RESEARCH",effect:"LOCAL",inputSchema:z.object({runId:id,queries:z.array(z.string().trim().min(1).max(200)).min(1).max(12),count:z.number().int().min(1).max(30).default(6)}).strict(),
      run:async(c,i)=>{const data=await this.d.research.searchMoreMarketVideos({projectId:c.projectId,...i});return answer("补充行业视频搜索："+data.search.status,data,[evidence("RESEARCH","RESEARCH_RUN",i.runId)],data.search.status==="READY"?"COMPLETE":"BLOCKED");}});
    this.add({ id: "strategy.generate", title: "生成营销策略与下一轮方案", description: "使用已确认事实、研究和同项目已采用运营反馈。activate=false只保存候选，不改已发布作品指针。", stage: "STRATEGY", effect: "MODEL", inputSchema: z.object({ requestText: z.string().trim().min(1).max(4000), activate: z.boolean().default(false) }).strict(),
      run: async (c, i) => this.generateStrategy(c, i) });
    this.add({ id: "strategy.select", title: "采用具体创意方案", description: "明确选择当前方案，或用batch的id/version/contentHash采用已保存的候选批次；有runId时确认原制作任务中的创意。", stage: "STRATEGY", effect: "HUMAN_DECISION", inputSchema: z.object({ creativeId: id, batch: z.object({ id, version: z.number().int().positive(), contentHash: hash }).strict().optional(), runId: id.optional(), expectedRevision: z.number().int().positive().optional() }).strict().refine(i => !(i.batch && i.runId), "候选批次和制作任务不能混用"),
      preview: async (p, i) => JSON.stringify(i.runId ? (await this.run(p, i.runId)).creativeBatch : await this.selectionBatch(p, i), null, 2),
      run: async (c, i) => { if (i.runId) { if (!i.expectedRevision) throw new DomainValidationError("需要原任务版本");
          return this.runResult(await this.d.smartGeneration.review(c.projectId, i.runId, { action: "SELECT_CREATIVE", creativeId: i.creativeId, expectedRevision: i.expectedRevision })); }
        const batch = await this.selectionBatch(c.projectId, i);
        const current = (await this.workspace(c.projectId)).project.currentCreativeBatchRef;
        if (i.batch && (current?.entityId !== batch.id || current.version !== batch.version || current.hash !== batch.contentHash))
          await this.d.productFlow.activateCreativeBatch(batch);
        const project = await this.d.productFlow.selectCreative(c.projectId, i.creativeId); return answer("已采用创意", project, [evidence("STRATEGY", "SELECTED_CREATIVE", i.creativeId)]); } });
    this.add({ id: "production.draft-script", title: "为已采用创意编写待审脚本", description: "直接复用当前用户已选创意、已确认事实和已保存参考视频分析；不重建创意，不确认脚本，不生成收费图片或视频。", stage: "PRODUCTION", effect: "MODEL", inputSchema: z.object({ creativeId: id, requestText: z.string().trim().min(1).max(6000) }).strict(),
      run: async (c, i) => {
        const w = await this.workspace(c.projectId);
        if (!w.productTruth || !w.creativeBatch || w.project.selectedCreativeId !== i.creativeId)
          throw new DomainValidationError("请先采用这条具体创意");
        await this.selectionBatch(c.projectId, { creativeId: i.creativeId });
        const material = await this.d.productInput.latest(c.projectId);
        const visualMedia: NonNullable<StructuredAiRequest["media"]> = [];
        const visualRefs: Array<{ assetId: string; artifactId: string; sha256: string }> = [];
        let totalBytes = 0;
        for (const asset of (material?.assets ?? []).slice(0, 4)) {
          const artifact = await this.d.artifacts.findById(asset.artifactId);
          if (!artifact || artifact.projectId !== c.projectId || artifact.integrityStatus !== "READY" || artifact.sha256 !== asset.sha256)
            throw new DomainValidationError("脚本参考图片版本或完整性已改变");
          if (!["image/png", "image/jpeg", "image/webp"].includes(artifact.mimeType ?? "")) continue;
          const bytes = await fs.readFile(this.store(c.projectId).resolveArtifactPath(artifact.relativePath));
          totalBytes += bytes.length;
          if (sha256Bytes(bytes) !== artifact.sha256 || totalBytes > 8 * 1024 * 1024)
            throw new DomainValidationError("脚本参考图片内容已改变或超过读取上限");
          visualMedia.push({ type: "image", mimeType: artifact.mimeType as "image/png" | "image/jpeg" | "image/webp", dataBase64: bytes.toString("base64"), label: "本项目现有图片 " + asset.id });
          visualRefs.push({ assetId: asset.id, artifactId: artifact.id, sha256: artifact.sha256 });
        }
        const script = await this.d.aiGeneration.generateScriptDraft({ truth: w.productTruth, batch: w.creativeBatch,
          selectedCreativeId: i.creativeId, version: await this.d.productFlow.nextVersion(c.projectId, "ScriptDraft", "script"),
          targetDurationMs: w.project.targetDurationMs, referenceVideoProfile: await this.d.referenceVideo.latest(c.projectId),
          creativeContext: { requestText: i.requestText }, directorVersion: 3, ...(visualMedia.length ? { visualMedia } : {}) });
        if (script.projectId !== c.projectId || script.selectedCreativeId !== i.creativeId || script.status !== "DRAFT")
          throw new DomainValidationError("脚本结果与当前待审范围不一致");
        const project = await this.d.productFlow.saveScriptDraft(script);
        if (visualRefs.length) await this.record(c, "SCRIPT_VISUAL_INPUT", { scriptId: script.id, scriptHash: script.contentHash, visualRefs });
        return answer("脚本已保存，等待用户审阅", { project, script }, [evidence("PRODUCTION", "SCRIPT_DRAFT", script.id)], "WAITING_USER");
      } });
    this.add({ id: "production.create", title: "建立可续接制作任务", description: "调用现有V2制作编排；不包含未确认付费生成。", stage: "PRODUCTION", effect: "LOCAL", inputSchema: z.object({ options: smartRunOptionsSchema }).strict(),
      run: async (c, i) => {
        const w = await this.workspace(c.projectId);
        if (w.script?.status === "CONFIRMED" && w.productionPlan) throw new DomainValidationError("当前已有确认脚本和分镜，请先查看productionPlanning并用production.continue-current续接；不能重新创作覆盖现有成果");
        return this.runResult(await this.d.smartGeneration.create(c.projectId, "agent-" + hashValue({ cycle: c.cycleId, action: c.actionId }).slice(0, 60), i.options, 2));
      } });
    this.add({ id: "production.continue-current", title: "接续当前脚本、分镜和制作规划", description: "按当前脚本及分镜哈希，接入本项目已有不可变规划资料。保留剧情和资产ID，建立真正的制作检查点；不重写创意、不切换模型、不授权或提交生成。先查看project.inspect中的productionPlanning。", stage: "PRODUCTION", effect: "LOCAL",
      inputSchema: z.object({ artifactId: id, artifactHash: hash, scriptHash: hash, planHash: hash, requestText: z.string().trim().min(1).max(6000) }).strict(),
      run: async (c, i) => ({ ...this.runResult(await this.d.smartGeneration.continueWorkspace(c.projectId, "agent-" + hashValue({ cycle: c.cycleId, action: c.actionId }).slice(0, 60), i)),
        status: "COMPLETE", summary: "当前脚本、分镜与规划已接入原项目执行任务；尚未生成。下一步核查production.readiness，费用未核实前不请求授权。" }) });
    this.add({ id: "production.readiness", title: "核查后台生成通道与本次费用范围", description: "只读检查当前制作任务版本、Skill/CLI通道和实际费用范围。未知费用显示阻断，不使用网页报价或余额代替，不生成。", stage: "PRODUCTION", effect: "READ", inputSchema: runInput,
      run: async (c, i) => { const data = await this.d.smartGeneration.inspectReadiness(c.projectId, i.runId);
        return { ...answer(data.alreadyAuthorized ? "三张设定图已生成，等待审核；视频生成与发布尚未授权" : data.canRequestPaidConfirmation ? "后台生成前检查通过，仍待费用确认" : "后台生成前检查有阻断，尚未生成", data, [], data.alreadyAuthorized ? "WAITING_USER" : data.canRequestPaidConfirmation ? "COMPLETE" : "BLOCKED"), resumeHref: `/projects/${encodeURIComponent(c.projectId)}/smart?activeRun=${encodeURIComponent(i.runId)}` }; } });
    this.add({ id: "production.quote", title: "后台核实完整制作费用", description: "沿用原任务逐项核价。Canvas仅在后台存在与本次内容完全匹配的用户发送授权时上传指定主图、保存报价草稿；没有授权立即阻断。报价不授权生成，缺项不按0积分计算。先inspect取得expectedRevision。", stage: "PRODUCTION", effect: "LOCAL", inputSchema: runStepInput,
      run: async (c, i) => {
        const data = await this.d.smartGeneration.quoteCurrent(c.projectId, i.runId, i.expectedRevision);
        const receipt = await this.record(c, "PRODUCTION_QUOTE", data);
        return answer(data.status === "QUOTED" ? "后台逐项报价已保存，需先核查通道再请用户确认费用" : "后台已逐项核价，仍有项目无法取得费用；具体服务端原因已保存，不能据此确认总预算，未生成或扣费", data,
          [evidence("PRODUCTION", "QUOTE_RECEIPT", receipt.id)], data.status === "QUOTED" ? "COMPLETE" : "BLOCKED");
      } });
    this.add({ id: "production.inspect", title: "查看原制作任务", description: "读取本项目原任务，不提交或新建。", stage: "PRODUCTION", effect: "READ", inputSchema: runInput,
      run: async (c, i) => ({ ...this.runResult(await this.run(c.projectId, i.runId)), status: "COMPLETE", summary: "已读取原制作任务及最新版本，未申请或授予费用权限" }) });
    this.add({id:"production.authorize-zero-images",title:"授权原三张设定图最高0积分",description:"先重新核实原女儿、父亲、客厅三张设定图全部为0积分。必须用户明确确认，任何项超过0即停；不授权视频生成或发布。",stage:"PRODUCTION",effect:"PAID_GENERATION",
      inputSchema:runStepInput.extend({creditCeiling:z.literal(0)}).strict(),
      preview:async(p,i)=>JSON.stringify(await this.d.smartGeneration.previewZeroCanvasImages(p,i.runId,i.expectedRevision),null,2),
      run:async(c,i)=>this.runResult(await this.d.smartGeneration.authorizeZeroCanvasImages(c.projectId,i.runId,{expectedRevision:i.expectedRevision,creditCeiling:i.creditCeiling,confirmed:c.confirmed}))});
    this.add({id:"production.recover-canvas-images",title:"只读恢复原Canvas图片结果",description:"仅按原submit ID查询已明确授权的三张图片，恢复回执、下载和入库；不调用confirm/run，不重新生图。",stage:"PRODUCTION",effect:"LOCAL",inputSchema:runStepInput,
      run:async(c,i)=>this.runResult(await this.d.smartGeneration.recoverCanvasImages(c.projectId,i.runId,i.expectedRevision))});
    this.add({id:"production.canvas-video-delivery",title:"检查Canvas视频下载与交付能力",description:"实际验证同账号本机Canvas CLI视频下载或显式登记的只读本地MCP，不提交生成。下载能力以真实MP4、SHA与字节数为准，不能只凭命令摘要推断。",stage:"PRODUCTION",effect:"READ",inputSchema:runInput,
      run:async(c,i)=>{const result=await this.d.smartGeneration.inspectCanvasVideoDelivery(c.projectId,i.runId);return answer(result.ready?"视频文件交付接口检查通过；仍需生成许可和人工审片":"视频文件交付接口仍有阻断",result,[],result.ready?"COMPLETE":"BLOCKED");}});
    this.add({id:"production.canvas-preflight",title:"检查Canvas视频请求及付费前完整绑定",description:"只读构建Canvas原生请求预检，核查同账号、节点提示词、报价、参考图实际文件和人工审核、视频下载能力；不创建许可、不生成。阻断项目全部返回。",stage:"PRODUCTION",effect:"READ",inputSchema:runInput,
      run:async(c,i)=>{const data=await this.d.smartGeneration.inspectCanvasPreflight(c.projectId,i.runId) as {ready:boolean};
        return answer(data.ready?"Canvas原生预检通过，仍需明确费用确认":"Canvas视频预检阻断，尚未授权或生成",data,[],data.ready?"COMPLETE":"BLOCKED");}});
    this.add({id:"production.prepare-canvas-paid",title:"保存Canvas视频原生请求与预检",description:"沿用当前已确认的原剧本和分镜，绑定已人工审核的实际素材及有效报价，原子保存GenerationRequest/Preflight并准备独立费用范围；不授予费用许可、不生成。所有阻断排除后才能调用；报价过期时重新核价并重建此范围。",stage:"PRODUCTION",effect:"LOCAL",inputSchema:runStepInput,
      run:async(c,i)=>this.runResult(await this.d.smartGeneration.prepareCanvasPaidScope(c.projectId,i.runId,i.expectedRevision))});
    this.add({id:"production.quote-short-preview",title:"15秒漫剧省积分方案后台比价",description:"用户要求15秒方案后，发送本项目压缩剧情提示词到同账号Canvas，仅新建独立报价草稿，复用现有4个参考节点，比较3模型的12秒加3秒本地尾卡与15秒方案。保留原任务与60秒方案，不授权或生成；采用短片还需新制作计划与付费确认。",stage:"PRODUCTION",effect:"LOCAL",inputSchema:runStepInput.extend({plan:canvasShortPreviewInput}).strict(),
      run:async(c,i)=>{const data=await this.d.smartGeneration.quoteCanvasShort(c.projectId,i.runId,i.expectedRevision,i.plan);
        const receipt=await this.record(c,"SHORT_VIDEO_QUOTE",data);
        return answer("15秒独立方案后台报价已保存；未生成，原方案保留",data,[evidence("PRODUCTION","SHORT_VIDEO_QUOTE",receipt.id)],"WAITING_USER");}});
    this.add({id:"production.sync-canvas-video",title:"下载与检查原Canvas视频结果",description:"仅处理已明确授权并受理的原视频submit ID，绑定原GenerationAttempt，下载原MP4并检查完整性、画幅、时长及音轨后进入原人工审片流程。失败保留文件，不生成或重提。",stage:"PRODUCTION",effect:"LOCAL",inputSchema:runStepInput.extend({clipId:id}).strict(),
      run:async(c,i)=>answer("已同步原Canvas视频结果，采用与交付仍须原人工审核",await this.d.smartGeneration.syncCanvasVideoResult(c.projectId,i.runId,i.expectedRevision,i.clipId))});
    this.add({ id: "production.advance", title: "推进已授权制作任务", description: "先inspect取得最新revision，再以expectedRevision推进这一个检查点；后续检查点必须使用新revision。复用原服务已确认范围和审批，不产生新的付费许可；未知提交先核对。", stage: "PRODUCTION", effect: "LOCAL", inputSchema: runStepInput,
      preview: async (p, i) => JSON.stringify(await this.run(p, i.runId), null, 2),
      run: async (c, i) => { const run = await this.run(c.projectId, i.runId); if (run.revision !== i.expectedRevision) throw new DomainValidationError("制作任务版本已改变，请inspect读取新revision后重新规划"); return this.runResult(await this.d.smartGeneration.advance(c.projectId, i.runId)); } });
    this.add({ id: "production.resume", title: "恢复原任务检查点", description: "先inspect取得expectedRevision，调用现有resume；新检查点需使用新revision，不替代人工审核或扩大付费范围。", stage: "PRODUCTION", effect: "LOCAL", inputSchema: runStepInput,
      run: async (c, i) => { const run = await this.run(c.projectId, i.runId); if (run.revision !== i.expectedRevision) throw new DomainValidationError("制作任务版本已改变，请inspect读取新revision后重新规划"); return this.runResult(await this.d.smartGeneration.resume(c.projectId, i.runId)); } });
    this.add({ id: "production.confirm-paid", title: "确认具体图片或视频费用范围", description: "必须确认原run的scopeHash及未知成本风险，不能由模型自授权。", stage: "PRODUCTION", effect: "PAID_GENERATION", inputSchema: z.object({ runId: id, kind: z.enum(["ASSETS", "VIDEO"]), scopeHash: hash, acceptedUnknownCostRisk: z.boolean().default(false) }).strict(),
      preview: async (p, i) => { const run = await this.run(p, i.runId); const scope = i.kind === "ASSETS" ? run.assetPaidScope : run.paidScope;
        const items = i.kind === "ASSETS" ? run.assetPaidScope?.assets : run.paidScope?.requests;
        if (!items?.length || items.some(item => item.costStatus !== "KNOWN")) throw new DomainValidationError("后台生成费用尚未核实，不能请求付费确认；先调用production.readiness，不得用网页报价或接受未知成本绕过");
        if (run.workspaceContinuation) assertCurrentQuote(run, i.kind === "ASSETS" ? "IMAGE" : "VIDEO");
        return JSON.stringify({ kind: i.kind, scope, options: run.options, assets: run.productionAssetSet }, null, 2); },
      run: async (c, i) => { const run = await this.run(c.projectId, i.runId);
        const items = i.kind === "ASSETS" ? run.assetPaidScope?.assets : run.paidScope?.requests;
        if (!items?.length || items.some(item => item.costStatus !== "KNOWN")) throw new DomainValidationError("后台生成费用尚未核实，旧动作不能授权未知价格生成");
        return this.runResult(i.kind === "ASSETS"
        ? await this.d.smartGeneration.confirmAssetPaid(c.projectId, i.runId, { scopeHash: i.scopeHash, confirmPaidAssetGeneration: c.confirmed, acceptedUnknownCostRisk: i.acceptedUnknownCostRisk })
        : await this.d.smartGeneration.confirmPaid(c.projectId, i.runId, { scopeHash: i.scopeHash, confirmPaidGeneration: c.confirmed, acceptedUnknownCostRisk: i.acceptedUnknownCostRisk })); } });
    this.add({ id: "production.review", title: "审核制作资产、剧本与分镜", description: "使用现有版本校验确认原任务，V8仍要求其完整审核参数。", stage: "PRODUCTION", effect: "HUMAN_DECISION", inputSchema: z.object({ runId: id, expectedRevision: z.number().int().positive(),
      action: z.enum(["CONFIRM_ASSET", "CONFIRM_SCRIPT", "CONFIRM_PLAN", "CONFIRM_V8_DIRECTOR", "CONFIRM_V8_PROMPTS"]), assetKey: id.optional(),
      screenplayHash: hash.optional(), artifactHash: hash.optional() }).strict(),
      preview: async (p, i) => JSON.stringify({ review: i, run: await this.run(p, i.runId) }, null, 2),
      run: async (c, i) => { const { runId, ...review } = i; await this.run(c.projectId, runId);
        return this.runResult(await this.d.smartGeneration.review(c.projectId, runId, { ...review, confirmV8Screenplay: c.confirmed, confirmV8Review: c.confirmed })); } });
    this.add({ id: "production.review-clip", title: "审看并决定单个镜头", description: "明确采用、重做或跳过具体原镜头；重做仍需新的费用授权。", stage: "PRODUCTION", effect: "HUMAN_DECISION", inputSchema: z.object({ clipId: id, generationAttemptId: id.optional(), decision: z.enum(["ACCEPT", "REDO", "SKIP", "USE"]), note: z.string().max(1000).optional() }).strict(),
      preview: async p => JSON.stringify((await this.workspace(p)).productionPlan, null, 2),
      run: async (c, i) => answer("镜头审核已保存", await this.d.review.decide({ projectId: c.projectId, ...i, source: "USER" })) });
    this.add({ id: "production.accept-final", title: "确认实际成片", description: "先经现有最终质检，再接受真实MP4；可同步对应制作任务完成。", stage: "PRODUCTION", effect: "HUMAN_DECISION", inputSchema: z.object({ expectedArtifactHash: hash, runId: id.optional() }).strict(),
      preview: async p => JSON.stringify(await this.d.finalOutput.latestAssembly(p), null, 2),
      run: async (c, i) => { const final = await this.d.finalOutput.latestAssembly(c.projectId); if (final?.outputArtifactHash !== i.expectedArtifactHash) throw new DomainValidationError("最终视频版本已改变");
        await this.d.finalQc.assertPublishable(c.projectId); const accepted = final.status === "ACCEPTED" ? final : await this.d.finalAssembly.accept(c.projectId);
        if (i.runId) { await this.run(c.projectId, i.runId); await this.d.smartGeneration.confirmFinal(c.projectId, i.runId); }
        return answer("最终成片已确认", accepted, [evidence("PRODUCTION", "ACCEPTED_FINAL", accepted.id)]); } });
    this.installShortProduction();this.installPublication(); this.installOperations();
  }
  private installShortProduction(){
    const base=runStepInput.extend({planId:id}).strict();
    const definitions:Array<{id:string;action:string;title:string;effect:CapabilityEffect;schema:z.ZodType<any>}>= [
      {id:"production.short-draft",action:"draft",title:"保存72积分15秒独立制作规划",effect:"LOCAL",schema:runStepInput.extend({previewId:id,rejectedPlanId:id.optional()}).strict()},
      {id:"production.short-inspect",action:"inspect",title:"查看15秒计划与审核阻断",effect:"READ",schema:base},
      {id:"production.short-revise-style",action:"revise-style",title:"保存仿真人15秒脚本分镜和人物场景修订稿",effect:"LOCAL",schema:base},
      {id:"production.short-edit-visual",action:"edit-visual",title:"另存15秒创意与视觉候选稿（保留历史、不授权生成）",effect:"LOCAL",schema:base.extend({expectedHeadHash:hash,proposal:z.record(z.string(),z.unknown())}).strict()},
      {id:"production.short-review-visual",action:"review-visual",title:"审核仿真人15秒脚本与文字设定（不授权生成）",effect:"HUMAN_DECISION",schema:base.extend({revisionId:id,contentHash:hash}).strict()},
      {id:"production.short-review-plan",action:"review-plan",title:"审阅15秒脚本分镜与尾卡",effect:"HUMAN_DECISION",schema:base.extend({contentHash:hash}).strict()},
      {id:"production.short-quote",action:"quote",title:"后台刷新15秒单段积分报价",effect:"LOCAL",schema:base},
      {id:"production.short-reference-quote",action:"reference-quote",title:"准备最少参考与同账号报价草稿（禁止生成）",effect:"LOCAL",schema:base.extend({revisionHash:hash,imagePrompt:z.string().trim().min(1).max(2000)}).strict()},
      {id:"production.short-generate-zero-reference",action:"generate-zero-reference",title:"仅生成已确认同框参考图1张最高0积分（不授权视频）",effect:"PAID_GENERATION",schema:base.extend({revisionHash:hash,requestHash:hash,creditCeiling:z.literal(0)}).strict()},
      {id:"production.short-sync-reference",action:"sync-reference",title:"只读查询原同框图提交并下载待审核图片",effect:"LOCAL",schema:base},
      {id:"production.short-adopt-reference",action:"adopt-reference",title:"采用用户已审核的精确同框参考图（不授权视频）",effect:"HUMAN_DECISION",schema:base.extend({revisionHash:hash,artifactId:id,sha256:hash}).strict()},
      {id:"production.short-quote-bound-video",action:"quote-bound-video",title:"核实真实产品与已采用同框图的视频实际报价",effect:"LOCAL",schema:base},
      {id:"production.short-prepare",action:"prepare",title:"准备15秒独立原生请求与预检",effect:"LOCAL",schema:base},
      {id:"production.short-authorize",action:"authorize",title:"明确确认15秒视频最高72积分",effect:"PAID_GENERATION",schema:base.extend({scopeHash:hash,creditCeiling:z.literal(72)}).strict()},
      {id:"production.short-advance",action:"advance",title:"接续已授权15秒视频原提交",effect:"LOCAL",schema:base},
      {id:"production.short-review-clip",action:"review-clip",title:"审核12秒实际视频内容",effect:"HUMAN_DECISION",schema:base.extend({attemptId:id,sha256:hash,decision:z.enum(["ACCEPT","REDO"])}).strict()},
      {id:"production.short-tail-preview",action:"tail-preview",title:"生成本地3秒产品尾卡预览",effect:"LOCAL",schema:base},
      {id:"production.short-assemble",action:"assemble",title:"合成并质检15秒交付文件",effect:"LOCAL",schema:base},
      {id:"production.short-accept-final",action:"accept-final",title:"审阅并接受15秒实际成片",effect:"HUMAN_DECISION",schema:base.extend({sha256:hash}).strict()}
    ];
    for(const d of definitions)this.add({id:d.id,title:d.title,stage:"PRODUCTION",effect:d.effect,inputSchema:d.schema,
      description:d.title+"。保留原60秒方案和数据；15秒独立计划、审核、请求、预算与原submit编号，不能复用原任务费用许可。付费、采用视频和接受成片都由用户分别确认。尾卡预览不代表完整成片。",
      preview:async(p,i)=>{const run=await this.run(p,i.runId),plan=run.canvasShortPlans?.find(v=>v.id===i.planId);
        const active=plan?.realisticExecution??plan;
        if(d.effect==="PAID_GENERATION"&&d.action!=="generate-zero-reference"){
          if(!plan||!active||plan.status!=="REQUEST_READY"||active.paidScope?.hash!==i.scopeHash||!active.feeQuote?.expiresAt||Date.parse(active.feeQuote.expiresAt)<=Date.now())throw new DomainValidationError("15秒尚未准备完整有效的独立审核、报价和付费范围");
          const result=await this.d.smartGeneration.shortPlanAction(p,i.runId,i.expectedRevision,"inspect",{planId:i.planId});
          const checked=result.result as {blockers:string[]};if(checked.blockers.length)throw new DomainValidationError("15秒付费前仍有阻断："+checked.blockers.join("、"));
          if(plan.realisticExecution){const e=plan.realisticExecution;
            return JSON.stringify({action:"请确认这一项视频生成；当前尚未授权或提交",title:e.payload.title,model:e.payload.model,resolution:"720p",ratio:"9:16",generatedSeconds:12,count:1,localProductTailSeconds:3,totalSeconds:15,
              references:["原真实产品图","用户已采用的人物与书房同框图"],audio:"仅自然放笔、衣料和轻触声；无对白、旁白、配音或BGM",imageCredits:0,videoMaxCredits:e.feeQuote?.grandTotal?.credits,totalCreditCeiling:72,
              scopeHash:e.paidScope?.hash,nativeRequest:e.paidScope?.requests[0],revisionHash:e.sourceRevisionHash,videoNode:e.payload.nodeId,submitId:e.payload.submitId,
              priceMustBeRevalidatedBeforeSubmission:true,unknownOrOverBudgetStops:true,automaticResubmissionAllowed:false,publishAuthorized:false},null,2);
          }
        }
        return JSON.stringify({action:d.title,planId:plan?.id,contentHash:plan?.visualRevisions?.at(-1)?.contentHash??plan?.contentHash,plan:plan?.realisticExecution?.payload??plan?.visualRevisions?.at(-1)?.payload??plan?.payload,paidScope:active?.paidScope,feeQuote:plan?.realisticExecution?active?.feeQuote:plan?.visualRevisions?.length?undefined:plan?.feeQuote,
          referenceImage:d.action==="generate-zero-reference"?{node:plan?.referenceQuote?.nodes.find(n=>n.key==="SETTING"),quoteRequestHash:plan?.referenceQuote?.requestHash,
            imagePrompt:plan?.referenceQuote?.imagePrompt,model:"seedream_5.0_lite",count:1,creditCeiling:0,videoAuthorized:false}:plan?.referenceImage,
          actualClip:plan?.clipReview,final:plan?.final,requested:i,notPublishAuthorization:true},null,2);},
      run:async(c,i)=>{const {runId,expectedRevision,...input}=i;
        const data=await this.d.smartGeneration.shortPlanAction(c.projectId,runId,expectedRevision,d.action,input,c.confirmed);
        const receipt=d.action!=="inspect"?await this.record(c,"SHORT_PRODUCTION_"+d.action.toUpperCase().replaceAll("-","_"),data):null;
        const final=d.action==="accept-final"?data.result as {status:string;final?:{artifactId:string;acceptedAt?:string}}:undefined;
        const reviewPending=d.action==="inspect"&&((data.result as {blockers?:string[]}).blockers??[]).some(b=>b==="SHORT_PLAN_REVIEW_REQUIRED"||b.startsWith("ASSET_REVIEW_REQUIRED:")||b.startsWith("REALISTIC_"));
        const summary=d.action==="revise-style"?"已在原任务保存仿真人15秒修订稿；脚本分镜和三份文字设定待审核，新图未生成，付费和发布未授权":reviewPending?"15秒计划已检查：脚本分镜或设定仍待你审核，尚未授权生成":d.title+"已处理；以实际审核和文件回执为准";
        return answer(summary,data,[...(receipt?[evidence("PRODUCTION","SHORT_PRODUCTION",receipt.id)]:[]),
          ...(final?.status==="DELIVERED"&&final.final?.acceptedAt?[evidence("PRODUCTION","SHORT_ACCEPTED_FINAL",final.final.artifactId)]:[])],
          reviewPending||["draft","inspect","prepare","authorize","advance","revise-style","edit-visual","review-visual","reference-quote","generate-zero-reference","sync-reference","adopt-reference","quote-bound-video","review-plan","review-clip","tail-preview","assemble"].includes(d.action)?"WAITING_USER":"COMPLETE");
      }});
  }

  private async generateStrategy(c: AgentCapabilityContext, i: { requestText: string; activate: boolean }) {
    if(i.activate&&!c.confirmed)throw new DomainValidationError("替换当前创意批次需要用户针对具体内容明确确认");
    const w = await this.workspace(c.projectId);
    if (!w.productTruth || w.productTruth.status !== "CONFIRMED") throw new DomainValidationError("请先确认产品事实");
    const [reference, research, availableFeedback, productInput, productionRuns] = await Promise.all([this.d.referenceVideo.latest(c.projectId), this.d.research.pageData(c.projectId), this.d.feedback.context(c.projectId),
      this.d.productInput.latest(c.projectId), this.d.smartGeneration.list(c.projectId)]);
    const productImages = await Promise.all((productInput?.assets.filter(asset => asset.type === "image").slice(0, 100) ?? []).map(async asset => {
      const artifact = await this.d.artifacts.findById(asset.artifactId);
      let fileVerified = false;
      if (artifact?.projectId === c.projectId && artifact.integrityStatus === "READY" && artifact.sha256 === asset.sha256) {
        try { fileVerified = sha256Bytes(await fs.readFile(this.store(c.projectId).resolveArtifactPath(artifact.relativePath))) === asset.sha256; } catch { /* Presence is never invented. */ }
      }
      return { artifactId: asset.artifactId, fileVerified };
    }));
    const materialInventory = { productImages, generatedSettings: productionRuns.flatMap(run => run.productionAssetSet?.entries.filter(entry => entry.source === "DREAMINA_GENERATED")
      .map(entry => ({ key: entry.key, label: entry.label, status: entry.status, artifactIds: entry.artifactIds })) ?? []).slice(0, 100), rule: "AVAILABLE_DOES_NOT_MEAN_HUMAN_APPROVED" as const };
    const feedback: typeof availableFeedback = [];
    for (const item of [...availableFeedback].reverse()) {
      if (i.requestText.length + JSON.stringify([...feedback, item]).length + 100 <= 6000) feedback.unshift(item);
    }
    const context = { materialInventory, requestText: i.requestText + (feedback.length ? "\n已由用户采用的运营反馈（仅创作方向，不作为产品事实）：\n" + JSON.stringify(feedback) : ""),
      ...(research.brief?.status === "READY" ? { research: { briefId: research.brief.id, contentHash: research.brief.contentHash, contentOpportunities: research.brief.contentOpportunities, uncertainties: research.brief.uncertainties, rule: "STRUCTURE_ONLY_NOT_PRODUCT_FACTS" as const } } : {}) };
    const version = await this.d.productFlow.nextVersion(c.projectId, "CreativeBatch", "creative-batch");
    const batch = await this.d.aiGeneration.generateCreativeBatch(w.productTruth, version, w.project.targetDurationMs, reference, context, 3);
    if (batch.projectId !== c.projectId) throw new DomainValidationError("策略结果所属项目错误");
    if (i.activate) await this.d.productFlow.activateCreativeBatch(batch);
    else await this.d.productRepo.commitVersion({ version: { id: batch.id, projectId: c.projectId, entityType: "CreativeBatch", entityKey: "creative-batch", version: batch.version, status: batch.status, contentHash: batch.contentHash, data: batch }, staleEntityTypes: [], projectPatch: {} });
    const consumedFeedback=batch.douyinFeedbackReceipt?.items??feedback;
    const receipt = await this.record(c, "STRATEGY_INPUT", { batchId: batch.id, version: batch.version, batchHash: batch.contentHash,
      truthHash: w.productTruth.contentHash, context, inputHash: hashValue(context), feedback:consumedFeedback, feedbackInputReceipt:batch.douyinFeedbackReceipt, contextFeedback:feedback, activate: i.activate });
    return answer("创意方案已生成" + (i.activate ? "并设为当前批次" : "，保留为下一轮候选"), { batch, activated: i.activate, inputReceiptId: receipt.id },
      [evidence("STRATEGY", "CREATIVE_BATCH", batch.id, String(batch.version)), ...(consumedFeedback.length ? [evidence("FEEDBACK", "NEXT_STRATEGY_INPUT", receipt.id)] : [])]);
  }
  private installPublication() {
    this.add({ id: "publication.account", title: "核对当前发布账号", description: "只读探测现有发布服务，返回明确账号ID用于后续具体发布授权；不会发布。", stage: "PUBLICATION", effect: "READ", inputSchema: empty,
      run: async c => { const account = await this.d.readPublishAccount(c.projectId); if (!account.accountId) throw new DomainValidationError("当前无法确认发布账号"); return answer("已核对发布账号", account); } });
    this.add({ id: "publication.inspect", title: "查看发布包与平台回执", description: "只读本地已保存的发布状态，不查询平台、不重新发送。", stage: "PUBLICATION", effect: "READ", inputSchema: empty,
      run: async c => answer("本地发布状态", (await this.snapshot(c.projectId)).publication) });
    this.add({ id: "publication.prepare", title: "准备具体成片发布包", description: "使用已确认成片和既有发布前检查；准备不等于发布。", stage: "PUBLICATION", effect: "LOCAL", inputSchema: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), providerType: publishProviderTypeSchema.optional() }).strict(),
      run: async (c, i) => { await this.d.finalQc.assertPublishable(c.projectId); const prepared = await this.d.publishBridge.createPackage({ projectId: c.projectId, ...i, publicBaseUrl: this.d.publicBaseUrl });
        return answer("发布包已准备，尚未发送", { package: prepared.package }, [evidence("PUBLICATION", "PUBLISH_PACKAGE", prepared.package.id)]); } });
    const submit = z.object({ packageId: id, expectedAccountId: id }).strict();
    this.add({ id: "publication.submit", title: "向明确账号发布成片", description: "核对具体账号、标题与视频，调用现有直发服务；未知结果先对账。", stage: "PUBLICATION", effect: "EXTERNAL_WRITE", inputSchema: submit,
      preview: (p, i) => this.publishPreview(p, i), run: async (c, i) => { await this.publishPreview(c.projectId, i); const pkg = await this.publication(c.projectId, i.packageId);
        if (pkg.status === "SUBMISSION_UNKNOWN" || pkg.status === "DIRECT_PUBLISHING") return answer("发布结果尚未确认，禁止再次发送", { packageId: pkg.id }, [], "OUTCOME_UNKNOWN");
        const result = await this.d.publishBridge.directPublish({ projectId: c.projectId, packageId: i.packageId, expectedAccountId: i.expectedAccountId, confirmed: c.confirmed });
        return answer("平台发布已确认", result, [evidence("PUBLICATION", "PUBLISHED_RECEIPT", result.receipt.id)]); } });
    this.add({ id: "publication.bind", title: "确认平台作品与本项目关联", description: "用户明确选择已发布作品；人工绑定不伪造可信平台发布回执。", stage: "PUBLICATION", effect: "HUMAN_DECISION", inputSchema: z.object({ awemeId: z.string().regex(/^\d{8,30}$/), externalUrl: z.string().url().optional() }).strict(),
      preview: async (p, i) => JSON.stringify({ projectId: p, ...i, publication: (await this.snapshot(p)).publication }, null, 2),
      run: async (c, i) => { const binding = await this.d.opsDashboard.confirmBinding({ projectId: c.projectId, ...i, confirmed: c.confirmed });
        const receipt = await this.record(c, "USER_WORK_BINDING", { bindingId: binding.id, packageId: binding.packageId, awemeId: binding.awemeId });
        return answer("用户已确认作品关联", binding, [evidence("PUBLICATION", "WORK_BINDING", binding.id), evidence("PUBLICATION", "USER_BINDING_RECEIPT", receipt.id)]); } });
  }
  private installOperations() {
    this.add({ id: "operations.works", title: "读取当前账号已有发布作品", description: "读取当前运营账号实际作品和稳定内容哈希，不绑定、不发布。", stage: "OPERATIONS", effect: "READ", inputSchema: empty,
      run: async () => answer("当前账号已有作品", await this.d.opsDashboard.existingWorks()) });
    this.add({ id: "operations.observe-existing", title: "观察同账号历史作品", description: "在用户要求验证已有作品的范围内核对账号及作品内容，建立独立历史运营观察；无需伪造发布包，不证明当前新片已发布。", stage: "OPERATIONS", effect: "LOCAL",
      inputSchema: z.object({ awemeId: z.string().regex(/^\d{8,30}$/), expectedAccountUid: id, expectedWorkHash: hash }).strict(),
      run: async (c, i) => { const binding = await this.d.opsDashboard.observeExistingWork({ projectId: c.projectId, ...i });
        const receipt = await this.record(c, "HISTORICAL_WORK_OBSERVATION", { bindingId: binding.id, awemeId: binding.awemeId, opsAccountUid: binding.opsAccountUid, workDescription: binding.workDescription, currentProductionPublished: false });
        return answer("已关联历史作品用于运营验证；当前新片未发布", binding, [evidence("OPERATIONS", "HISTORICAL_WORK_OBSERVATION", receipt.id)]); } });
    this.add({ id: "operations.account", title: "核对实际运营账号", description: "明确探测采集运行时的真实账号 UID；不使用发布账号标识或昵称代替。", stage: "OPERATIONS", effect: "READ", inputSchema: empty,
      run: async () => { if (!this.d.readOpsAccount) return answer("当前未配置运营账号 UID 核验能力", undefined, [], "BLOCKED");
        const account = await this.d.readOpsAccount();
        return !account.uid || account.uid === "0" ? answer("当前无法核验实际运营账号 UID", undefined, [], "BLOCKED") : answer("已核对实际运营账号 UID", account); } });
    const scheduleInput = z.object({ bindingId: id, awemeId: z.string().regex(/^\d{8,30}$/), expectedAccountId: z.string().trim().min(1).max(100),
      startAt: z.string().datetime(), intervalSeconds: z.number().int().min(60).max(86400).default(3600),
      maxCaptures: z.number().int().min(1).max(30).default(3), maxReplyParents: z.number().int().min(1).max(10).default(5),
      pageSize: z.number().int().min(1).max(20).default(20),cadence:adaptiveCadenceSchema.optional() }).strict().superRefine((value,ctx)=>{if(value.cadence&&(value.intervalSeconds<value.cadence.minIntervalSeconds||value.intervalSeconds>value.cadence.maxIntervalSeconds))ctx.addIssue({code:"custom",path:["cadence"],message:"基准间隔超出确认范围"});});
    this.add({ id: "operations.schedule-create", title: "确认创建有界运营观察计划", description: "确认具体作品、实际运营 UID、开始时间、间隔和次数后，在后台观察指标、顶层评论与选定父评论楼中楼；计划本身不代表采集完成。", stage: "OPERATIONS", effect: "HUMAN_DECISION", inputSchema: scheduleInput,
      preview: async (p, i) => { if (!this.d.schedules) throw new DomainValidationError("当前未配置运营计划服务"); const binding=await this.scheduleScope(p,i);
        return [`运营账号 UID：${i.expectedAccountId}`, `作品编号：${i.awemeId}`, `作品关联：${i.bindingId}`, `开始时间：${i.startAt}`,
          `基准观察间隔：${i.intervalSeconds} 秒`, ...(i.cadence?[`自适应节奏：${i.cadence.version}；最短 ${i.cadence.minIntervalSeconds} 秒，最长 ${i.cadence.maxIntervalSeconds} 秒`,`观察时间上限：从开始时间起 ${i.cadence.maxDurationSeconds} 秒（${new Date(Date.parse(i.startAt)+i.cadence.maxDurationSeconds*1000).toISOString()} 截止）`,`阶段依据：创建时已保存的发布时间 ${binding.publishedAt??"未提供，保留未知"}；24小时内、24–168小时、168小时后`,`增长阈值：至少增加 ${i.cadence.minAbsoluteGrowth} 且相对增长至少 ${i.cadence.growthThresholdPercent}%；原值明确为零时仅用绝对阈值。缺失或不可见不补零、不加快。`]:["固定间隔；不自动升级成自适应计划。"]),`最多观察：${i.maxCaptures} 次`, `每次楼中楼父评论上限：${i.maxReplyParents} 条`, `每页最多：${i.pageSize} 条`,
          "只读取指标、评论和楼中楼，不自动回复或发布；实际覆盖范围以采集检查点为准。"].join("\n"); },
      run: async (c, i) => { if (!this.d.schedules || !this.d.readOpsAccount) return answer("当前未配置运营计划或账号 UID 核验能力", undefined, [], "BLOCKED");
        await this.scheduleScope(c.projectId, i); const { expectedAccountId, ...settings } = i;
        const value = await this.d.schedules.create({ ...settings, projectId: c.projectId, opsAccountUid: expectedAccountId,
          requestKey: "agent-" + hashValue({ cycle: c.cycleId, action: c.actionId }) });
        return answer("运营观察计划已保存；尚不代表实际采集或运营闭环完成", value, [evidence("OPERATIONS", "OPERATIONS_SCHEDULE", value.id)], "PARTIAL"); } });
    this.add({ id: "operations.schedule-list", title: "查看已保存运营计划", description: "只读本项目计划、进度与实际覆盖记录，不触发平台采集。", stage: "OPERATIONS", effect: "READ", inputSchema: empty,
      run: async c => this.d.schedules ? answer("本项目运营观察计划", await this.d.schedules.list(c.projectId)) : answer("当前未配置运营计划服务", undefined, [], "BLOCKED") });
    this.add({ id: "operations.schedule-pause", title: "暂停原运营观察计划", description: "按原项目、计划和确切版本暂停后续观察，不删除已有数据。", stage: "OPERATIONS", effect: "LOCAL", inputSchema: z.object({ scheduleId: id, expectedRevision: z.number().int().positive() }).strict(),
      run: async (c, i) => this.d.schedules ? answer("运营观察计划已暂停", await this.d.schedules.pause(c.projectId, i.scheduleId, i.expectedRevision)) : answer("当前未配置运营计划服务", undefined, [], "BLOCKED") });
    this.add({id:"operations.schedule-resume",title:"确认续接原运营观察计划",description:"核对当前版本、原范围哈希与实际账号后续接；不扩展次数、时间窗或解除未知读取结果。",stage:"OPERATIONS",effect:"HUMAN_DECISION",
      inputSchema:z.object({scheduleId:id,expectedRevision:z.number().int().positive(),inputHash:hash,expectedAccountId:id}).strict(),
      preview:async(p,i)=>{const run=await this.d.schedules?.get(p,i.scheduleId);if(!run||run.revision!==i.expectedRevision||run.inputHash!==i.inputHash||run.input.opsAccountUid!==i.expectedAccountId)throw new DomainValidationError("原计划版本或账号已变化");return `续接原计划 ${run.id}；账号 ${i.expectedAccountId}；作品 ${run.input.awemeId}；最多 ${run.input.maxCaptures} 次，已完成 ${run.completedCaptures} 次。保留原游标、时间窗和未知结果，不自动重读。`;},
      run:async(c,i)=>this.d.schedules?answer("已保存原范围续接；不代表采集完成",await this.d.schedules.resume({projectId:c.projectId,id:i.scheduleId,expectedRevision:i.expectedRevision,inputHash:i.inputHash,expectedAccountId:i.expectedAccountId,confirmed:c.confirmed===true}),[],"PARTIAL"):answer("当前未配置运营计划服务",undefined,[],"BLOCKED")});
    this.add({ id: "operations.inspect", title: "查看已保存运营数据", description: "只读作品绑定、指标、评论和草稿，不访问平台。", stage: "OPERATIONS", effect: "READ", inputSchema: empty,
      run: async c => answer("本地运营数据", (await this.snapshot(c.projectId)).operations) });
    this.add({ id: "operations.metrics", title: "采集已绑定作品指标", description: "从实际平台读取当前指标并保存快照，不生成历史缺失指标。", stage: "OPERATIONS", effect: "READ", inputSchema: empty,
      run: async c => { const binding = await this.bound(c.projectId); const value = await this.d.metrics.refresh({ projectId: c.projectId, packageId: binding.packageId, captureKey: "agent:" + c.cycleId + ":" + c.actionId });
        const receipt = await this.record(c, "METRICS_CAPTURE", { bindingId: binding.id, awemeId: binding.awemeId, snapshotId: value.id });
        return answer("作品指标已保存", value, [evidence("OPERATIONS", "METRIC_SNAPSHOT", value.id), evidence("OPERATIONS", "METRICS_CAPTURE", receipt.id)]); } });
    const collection = z.object({ maxPages: z.number().int().min(1).max(5).default(5), pageSize: z.number().int().min(1).max(20).default(20) }).strict();
    this.add({ id: "operations.comments", title: "采集顶层评论并记录覆盖范围", description: "使用现有平台只读采集；返回分页覆盖，截断不冒充全部采完。", stage: "OPERATIONS", effect: "READ", inputSchema: collection,
      run: async (c, i) => { const binding = await this.bound(c.projectId);
        if (this.d.collections) return this.collectionResult(c, await this.d.collections.start({ projectId: c.projectId,
          requestKey: "agent-" + hashValue({ cycle: c.cycleId, action: c.actionId }), bindingId: binding.id, awemeId: binding.awemeId, kind: "COMMENTS", batchPages: i.maxPages, pageSize: i.pageSize }));
        const result = await this.d.comments.syncComments({ projectId: c.projectId, packageId: binding.packageId, ...i });
        const receipt = await this.record(c, "COMMENTS_CAPTURE", { bindingId: binding.id, collectionMode: "SINGLE_BATCH", ...result });
        return answer("本次顶层评论采样已保存；当前未配置持久游标采集，不代表持续采集或完整闭环", result, [evidence("OPERATIONS", "COMMENTS_CAPTURE", receipt.id)], "PARTIAL"); } });
    this.add({ id: "operations.replies", title: "采集指定父评论的楼中楼", description: "采集当前作品已保存父评论的回复，保留父子关系及分页覆盖。", stage: "OPERATIONS", effect: "READ", inputSchema: collection.extend({ cid: z.string().regex(/^\d{1,40}$/) }).strict(),
      run: async (c, i) => { const binding = await this.bound(c.projectId);
        if (this.d.collections) return this.collectionResult(c, await this.d.collections.start({ projectId: c.projectId,
          requestKey: "agent-" + hashValue({ cycle: c.cycleId, action: c.actionId }), bindingId: binding.id, awemeId: binding.awemeId, kind: "REPLIES", parentCid: i.cid, batchPages: i.maxPages, pageSize: i.pageSize }));
        const result = await this.d.comments.syncReplies({ projectId: c.projectId, packageId: binding.packageId, ...i });
        const receipt = await this.record(c, "REPLIES_CAPTURE", { bindingId: binding.id, parentCid: i.cid, collectionMode: "SINGLE_BATCH", ...result });
        return answer("本次楼中楼采样已保存；当前未配置持久游标采集，不代表持续采集或完整闭环", result, [evidence("OPERATIONS", "REPLIES_CAPTURE", receipt.id)], "PARTIAL"); } });
    this.add({ id: "operations.collection-advance", title: "从持久游标继续原采集任务", description: "复用原作品、父评论和分页游标；每页保存检查点。", stage: "OPERATIONS", effect: "READ", inputSchema: runInput,
      run: async (c, i) => { if (!this.d.collections) throw new DomainValidationError("当前未配置持久采集服务"); return this.collectionResult(c, await this.d.collections.advance({ projectId: c.projectId, runId: i.runId })); } });
    this.add({ id: "operations.collection-inspect", title: "查看已保存采集检查点", description: "只读本地持久采集状态，不推进、不重新采集。", stage: "OPERATIONS", effect: "READ", inputSchema: runInput,
      run: async (c, i) => { if (!this.d.collections) throw new DomainValidationError("当前未配置持久采集服务"); const run = await this.d.collections.get(c.projectId, i.runId); if (!run) throw new DomainValidationError("采集任务不存在"); return answer("已保存采集检查点", run, [], run.status === "COMPLETED" ? "COMPLETE" : "PARTIAL"); } });
    this.add({ id: "operations.classify", title: "分析已保存评论", description: "调用现有评论分类；批次受限，不将部分分类冒充总体分析。", stage: "OPERATIONS", effect: "MODEL", inputSchema: z.object({ cids: z.array(z.string().regex(/^\d{1,40}$/)).min(1).max(20).optional() }).strict(),
      run: async (c, i) => { const binding = await this.bound(c.projectId); const result = await this.d.classifier.classify({ projectId: c.projectId, awemeId: binding.awemeId, cids: i.cids, limit: 20 });
        return answer("评论分类已保存", result, result.commentIds.map(value => evidence("OPERATIONS", "CLASSIFIED_COMMENT", value))); } });
    this.add({ id: "operations.reply-draft", title: "准备单条评论回复草稿", description: "只创建本地草稿，不向平台发送。", stage: "OPERATIONS", effect: "MODEL", inputSchema: z.object({ cid: z.string().regex(/^\d{1,40}$/) }).strict(),
      run: async (c, i) => { const draft = await this.d.opsDashboard.generateReplyDraft({ projectId: c.projectId, cid: i.cid }); return answer("回复草稿已保存，尚未发送", draft, [evidence("OPERATIONS", "REPLY_DRAFT", draft.id)]); } });
    const reply = z.object({ draftId: id, expectedRevision: z.number().int().positive(), expectedAccountId: id }).strict();
    this.add({ id: "operations.reply-publish", title: "确认并发送这一条具体回复", description: "明确正文、作品与父评论；原服务重新检查账号、版本与幂等，未知状态不自动重试。", stage: "OPERATIONS", effect: "EXTERNAL_WRITE", inputSchema: reply,
      preview: async (p, i) => { if (!this.d.readOpsAccount) throw new DomainValidationError("当前未配置运营账号 UID 核验能力，不能确认回复");
        const draft = await this.d.opsRepo.findReplyDraftById(i.draftId); if (!draft || draft.projectId !== p || draft.revision !== i.expectedRevision) throw new DomainValidationError("回复草稿不存在或版本已改变");
        const comment = await this.d.opsRepo.findComment({ awemeId: draft.awemeId, cid: draft.cid }); const binding = await this.bound(p);
        if (!comment) throw new DomainValidationError("找不到原目标评论，请先核对草稿来源");
        const account = await this.d.readOpsAccount(); if (!account.uid || account.uid === "0" || account.uid !== i.expectedAccountId) throw new DomainValidationError("实际运营账号 UID 已改变或与本次确认不一致，请重新确认回复");
        return [`运营账号 UID：${account.uid}`, `目标作品：${binding.awemeId}`, `目标评论：${draft.cid}`, `评论正文：${comment.text}`,
          `回复草稿正文：${draft.currentText}`, `草稿版本：${draft.revision}`].join("\n"); },
      run: async (c, i) => { if (!this.d.readOpsAccount) return answer("当前未配置运营账号 UID 核验能力，不能发送回复", undefined, [], "BLOCKED");
        const draft = await this.d.opsRepo.findReplyDraftById(i.draftId); if (!draft || draft.projectId !== c.projectId) throw new DomainValidationError("回复草稿不属于当前项目");
        const account = await this.d.readOpsAccount(); if (!account.uid || account.uid === "0" || account.uid !== i.expectedAccountId) throw new DomainValidationError("实际运营账号 UID 已改变或与本次确认不一致，请重新确认回复");
        const result = await this.d.opsDashboard.publishReplyDraft({ projectId: c.projectId, draftId: i.draftId, expectedRevision: i.expectedRevision, writeIntentId: writeIntentId(c), confirmed: c.confirmed });
        const posted = result.intent.status === "REPLY_POSTED_CONFIRMED";
        return answer(posted ? "平台已确认回复发送" : "回复发送结果：" + result.intent.status, result, [evidence("OPERATIONS", "REPLY_WRITE_INTENT", result.intent.id)], posted ? "COMPLETE" : result.intent.status === "SUBMISSION_UNKNOWN" ? "OUTCOME_UNKNOWN" : "BLOCKED"); } });
    this.add({ id: "feedback.generate", title: "基于作品指标和评论复盘", description: "调用真实证据复盘并验证引用，不编造完播率、转化率或因果结论。", stage: "FEEDBACK", effect: "MODEL", inputSchema: empty,
      run: async c => {
        if (this.d.collections) {
          const binding = await this.d.opsRepo.latestWorkBinding(c.projectId, { preferBound: true });
          if (binding?.awemeId) {
            const [jobs, parents] = await Promise.all([this.d.collections.list(c.projectId), this.d.opsRepo.listComments({ projectId: c.projectId, awemeId: binding.awemeId, parentCid: null })]);
            const complete = jobs.filter(job => job.bindingId === binding.id && job.awemeId === binding.awemeId && job.status === "COMPLETED" && !job.hasMore && !job.partial);
            const topLevelComplete = complete.some(job => job.kind === "COMMENTS");
            const missingParentCids = parents.filter(parent => (parent.replyCount===undefined||parent.replyCount > 0) && !complete.some(job => job.kind === "REPLIES" && job.parentCid === parent.cid)).map(parent => parent.cid);
            if (!topLevelComplete || missingParentCids.length) return answer("暂未生成复盘：先补齐原作品的评论与楼中楼采集", { awemeId: binding.awemeId, topLevelComplete, missingParentCids }, [], "PARTIAL");
          }
        }
        const insight = await this.d.retrospective.generate({ projectId: c.projectId }); return answer("运营复盘已保存", insight, [evidence("FEEDBACK", "DOUYIN_INSIGHT", insight.id)]); } });
    this.add({ id: "feedback.promote", title: "采用有证据的下一轮创意建议", description: "用户明确采用某一条复盘建议；不更改产品事实。", stage: "FEEDBACK", effect: "HUMAN_DECISION", inputSchema: z.object({ insightId: id, actionIndex: z.number().int().min(0).max(100) }).strict(),
      preview: async (p, i) => { const insight = await this.d.opsRepo.findInsightById(i.insightId); if (!insight || insight.projectId !== p) throw new DomainValidationError("复盘不属于当前项目"); const action = insight.nextCreativeActions[i.actionIndex]; if (!action) throw new DomainValidationError("复盘建议不存在"); return JSON.stringify(action, null, 2); },
      run: async (c, i) => { const feedback = await this.d.feedback.promote({ projectId: c.projectId, ...i, confirmed: c.confirmed }); return answer("下一轮建议已采用", feedback, [evidence("FEEDBACK", "CREATIVE_FEEDBACK", feedback.id)]); } });
    this.add({ id: "feedback.inspect", title: "查看已采用反馈与复盘", description: "读取同项目真实反馈，尚未生成下一轮输入时不宣称闭环完成。", stage: "FEEDBACK", effect: "READ", inputSchema: empty,
      run: async c => answer("本项目反馈记录", { feedback: await this.d.feedback.context(c.projectId), insights: await this.d.opsRepo.listInsights({ projectId: c.projectId, limit: 20 }) }) });
  }

  private async collectionResult(c: AgentCapabilityContext, run: Awaited<ReturnType<DouyinCollectionService["start"]>>) {
    if (run.projectId !== c.projectId) throw new DomainValidationError("采集任务不属于当前项目");
    const kind = run.kind === "REPLIES" ? "REPLIES_CAPTURE" : "COMMENTS_CAPTURE";
    const receipt = await this.record(c, kind, { ...run, collectionId: run.id });
    const done = run.status === "COMPLETED" && !run.hasMore && !run.partial;
    return answer("持久采集任务：" + run.status, run, [evidence("OPERATIONS", kind, receipt.id)], done ? "COMPLETE" : run.status === "BLOCKED" ? "BLOCKED" : "PARTIAL");
  }

  async snapshot(projectId: string): Promise<Record<string, unknown>> {
    const w = await this.workspace(projectId);
    let feedbackReadError=false,insightReadError=false,scheduleReadError=false,artifactReadError=false,metricReadError=false;
    const [research, runs, final, preference, packages, receipts, binding, artifacts, feedback] = await Promise.all([
      this.d.research.pageData(projectId), this.d.smartGeneration.list(projectId), this.d.finalOutput.latestAssembly(projectId), this.d.publishRepo.getPreference(projectId),
      this.d.publishRepo.listPackages(projectId), this.d.publishRepo.listReceipts(projectId), this.d.opsRepo.latestWorkBinding(projectId, { preferBound: true }),
      this.d.artifacts.listByProject(projectId).catch(()=>{artifactReadError=true;return [];}), this.d.feedback.context(projectId).catch(()=>{feedbackReadError=true;return [];})
    ]);
    const [snapshots, comments, drafts, insight] = binding?.awemeId ? await Promise.all([
      (async()=>{try{
        if(!binding.opsAccountUid)throw new DomainValidationError("原指标账号范围缺失");
        const saved=await this.d.opsRepo.listMetricSnapshots({projectId,awemeId:binding.awemeId!,limit:30});
        for(const item of saved)assertSavedMetricSnapshot(item,{projectId,bindingId:binding.id,awemeId:binding.awemeId!,opsAccountUid:binding.opsAccountUid});
        return saved;
      }catch{metricReadError=true;return [];}})(), this.d.opsRepo.listComments({ projectId, awemeId: binding.awemeId, limit: 50, order: "desc" }),
      this.d.opsRepo.listLatestReplyDrafts({ projectId, awemeId: binding.awemeId }), this.d.opsRepo.latestInsight(projectId, binding.awemeId).catch(()=>{insightReadError=true;return null;})
    ]) : [[], [], [], null] as const;
    const collections = this.d.collections ? await this.d.collections.list(projectId) : [];
    const schedules = this.d.schedules ? await this.d.schedules.list(projectId).catch(()=>{scheduleReadError=true;return [];}) : [];
    // The short comment preview must not hide older parents with unread replies.
    const savedParents = binding?.awemeId ? await this.d.opsRepo.listComments({ projectId, awemeId: binding.awemeId,
      parentCid: null, limit: 1000, order: "desc" }) : [];
    const productionPlanning = [];
    if (w.script && w.productionPlan) for (const artifact of artifacts.filter(a => a.kind === "STRUCTURED_SNAPSHOT" && a.relativePath.startsWith("production-planning/")).slice(-30)) {
      if (!artifact.sha256) continue;
      try {
        const saved = await readSavedProductionPlanning({ projectId, artifactId: artifact.id, artifactHash: artifact.sha256,
          artifacts: this.d.artifacts, store: this.store(projectId), script: w.script, plan: w.productionPlan });
        productionPlanning.push({ artifactId: artifact.id, artifactHash: artifact.sha256, scriptHash: w.script.contentHash,
          planHash: w.productionPlan.contentHash, contentType: saved.assets.strategy.contentType,
          assets: saved.assets.set.entries.map(e => ({ key: e.key, label: e.label, status: e.status, source: e.source })),
          costStatus: saved.assets.paidScope?.assets.every(a => a.costStatus === "KNOWN") ? "KNOWN" : "UNKNOWN", generationAuthorized: false });
      } catch { /* Quotes and unrelated planning records cannot seed execution. */ }
    }
    return { workspace: w, research, production: runs, productionPlanning, final,
      publication: { preference, packages: packages.map(p => ({ id: p.id, status: p.status, providerType: p.providerType, title: p.titleDraft, description: p.descriptionDraft,
        finalAssemblyId: p.finalAssemblyId, finalArtifactId: p.finalArtifactId, finalArtifactHash: p.finalArtifactHash })), receipts },
      operations: { binding, replyParents: savedParents.filter(c => (c.replyCount===undefined||c.replyCount > 0)).map(c => ({ cid: c.cid, replyCount: c.replyCount })),
        replyParentIndex: { savedTopLevelCount: savedParents.length, limit: 1000, truncated: savedParents.length === 1000 },
        snapshots, collections, schedules,scheduleReadError,insightReadError,metricReadError, comments: comments.map(c => ({ id: c.id, cid: c.cid, parentCid: c.parentCid, text: c.text, replyCount: c.replyCount, category: c.category, contentHash: c.contentHash })), drafts, insight },
      feedback,feedbackReadError,artifactReadError, evidenceArtifacts: artifacts.filter(a => a.relativePath.startsWith("agent-evidence/")).map(a => ({ id: a.id, sha256: a.sha256, integrityStatus: a.integrityStatus })) };
  }
  async fingerprint(projectId: string, capabilityId?: string, input?: Record<string, unknown>) {
    const egoDouyin=capabilityId?.startsWith("operations.ego-lite-")?this.d.egoLiteDouyinRead?.peek():undefined;
    // Authorization depends on business versions, not independent observations.
    // Never probe accounts/platforms, scan research progress or read collection,
    // metric and scheduling checkpoints when checking a user's authorization.
    const [workspace, runs, final, preference, packages, receipts, binding, feedback] = await Promise.all([
      this.workspace(projectId), this.d.smartGeneration.list(projectId), this.d.finalOutput.latestAssembly(projectId),
      this.d.publishRepo.getPreference(projectId), this.d.publishRepo.listPackages(projectId), this.d.publishRepo.listReceipts(projectId),
      this.d.opsRepo.latestWorkBinding(projectId, { preferBound: true }), this.d.feedback.active(projectId)
    ]);
    let reply: unknown;
    if (capabilityId === "operations.reply-publish") {
      const { draftId } = z.object({ draftId: id }).passthrough().parse(input);
      const draft = await this.d.opsRepo.findReplyDraftById(draftId);
      if (draft && draft.projectId !== projectId) throw new DomainValidationError("回复草稿不属于当前项目");
      const comment = draft ? await this.d.opsRepo.findComment({ awemeId: draft.awemeId, cid: draft.cid }) : null;
      if (comment && comment.projectId !== projectId) throw new DomainValidationError("回复对象不属于当前项目");
      reply = { draft, parentComment: comment ? { id: comment.id, projectId: comment.projectId, awemeId: comment.awemeId,
        cid: comment.cid, parentCid: comment.parentCid, contentHash: comment.contentHash, text: comment.text } : null };
    }
    return hashValue({ workspace, ...(capabilityId==="research.collect-evidence"?{egoLiteSourceUrl:this.d.ownedEgoLiteSourceUrl}:{}), production: runs.map(run => ({ id: run.id, projectId: run.projectId, revision: run.revision })).sort((a, b) => a.id.localeCompare(b.id)), final,
      ...(egoDouyin?{egoDouyin:{epoch:egoDouyin.epoch,uid:egoDouyin.identity?.uid,checkedAt:egoDouyin.checkedAt,pagination:egoDouyin.pagination}}:{}),publication: { preference, packages: packages.map(p => ({ id: p.id, status: p.status, providerType: p.providerType, title: p.titleDraft, description: p.descriptionDraft,
        finalAssemblyId: p.finalAssemblyId, finalArtifactId: p.finalArtifactId, finalArtifactHash: p.finalArtifactHash })), receipts }, binding, feedback, reply });
  }
  async validateCompletion(projectId: string, stages: BusinessStage[], supplied: CycleEvidence[]) {
    const errors: string[] = [];
    const [w, runs, researchRuns, final, packages, receipts, binding, feedback] = await Promise.all([
      this.workspace(projectId), this.d.smartGeneration.list(projectId), this.d.researchRepo.listRuns(projectId), this.d.finalOutput.latestAssembly(projectId),
      this.d.publishRepo.listPackages(projectId), this.d.publishRepo.listReceipts(projectId), this.d.opsRepo.latestWorkBinding(projectId, { preferBound: true }), this.d.feedback.active(projectId)
    ]);
    const records = (await Promise.all(supplied.map(e => this.readRecord(projectId, e.id)))).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (stages.includes("RESEARCH") && !researchRuns.some(r => r.projectId === projectId && r.browserState?.marketVideoResearch?.searchedQueries.length &&
        r.browserState.marketVideoResearch.candidates.some(c => c.status === "ANALYZED" && c.referenceVideoProfileId))) errors.push("行业视频搜索与实际视频拆解尚未完成");
    if (stages.includes("STRATEGY") && !(w.creativeBatch?.concepts.some(c => c.id === w.project.selectedCreativeId) || runs.some(r => r.projectId === projectId && r.creativeBatch?.concepts.some(c => c.id === r.selectedCreativeId))))
      errors.push("尚未形成并采用真实营销策略/创意方案");
    const artifact = final ? await this.d.artifacts.findById(final.outputArtifactId) : null;
    let finalValid = Boolean(final?.status === "ACCEPTED" && artifact?.projectId === projectId && artifact.integrityStatus === "READY" && artifact.sha256 === final.outputArtifactHash);
    if (finalValid && artifact) {
      try { finalValid = sha256Bytes(await fs.readFile(this.store(projectId).resolveArtifactPath(artifact.relativePath))) === artifact.sha256; } catch { finalValid = false; }
    }
    if(stages.includes("PRODUCTION")&&!finalValid){
      const acceptedRefs=new Set(supplied.filter(e=>e.stage==="PRODUCTION"&&e.kind==="SHORT_ACCEPTED_FINAL").map(e=>e.id));
      for(const p of runs.flatMap(r=>r.canvasShortPlans??[]))if(p.final&&acceptedRefs.has(p.final.artifactId)&&
        await new CanvasShortDeliveryService(this.d.artifacts,this.d.projectsRoot).verifyAccepted(p)){finalValid=true;break;}
    }
    if (stages.includes("PRODUCTION") && !finalValid) errors.push("尚无已确认、文件实际完整的最终成片");
    const matchingPackage = final && binding ? packages.find(p => p.id === binding.packageId && p.projectId === projectId && p.finalAssemblyId === final.id && p.finalArtifactId === final.outputArtifactId && p.finalArtifactHash === final.outputArtifactHash) : undefined;
    const published = matchingPackage && receipts.some(r => r.packageId === matchingPackage.id && r.trusted && r.kind === "PUBLISHED_CONFIRMED");
    const explicitlyBound = matchingPackage && binding?.source === "USER_CONFIRMED" && records.some(r => r.kind === "USER_WORK_BINDING" && r.payload.bindingId === binding.id && r.payload.awemeId === binding.awemeId);
    if (stages.includes("PUBLICATION") && !(binding?.status === "BOUND" && binding.awemeId && matchingPackage && (published || explicitlyBound))) errors.push("尚无与当前成片一致的真实发布作品绑定及可信回执或用户明确关联记录");
    if (stages.includes("OPERATIONS")) {
      if (!binding?.awemeId) errors.push("缺少运营作品绑定");
      else {
        const [snapshots, saved] = await Promise.all([this.d.opsRepo.listMetricSnapshots({ projectId, awemeId: binding.awemeId }), this.d.opsRepo.listComments({ projectId, awemeId: binding.awemeId })]);
        const collections = this.d.collections ? await this.d.collections.list(projectId) : [];
        const coverage = records.filter(r => r.payload.awemeId === binding.awemeId && r.payload.bindingId === binding.id &&
          (r.kind === "METRICS_CAPTURE" || collections.some(job => job.id === r.payload.collectionId && job.bindingId === binding.id && job.awemeId === binding.awemeId &&
            job.projectId === projectId && job.status === "COMPLETED" && !job.hasMore && !job.partial)));
        if (!snapshots.some(s => coverage.some(r => r.kind === "METRICS_CAPTURE" && r.payload.snapshotId === s.id))) errors.push("本周期尚未保存该作品的真实指标采集记录");
        if (!coverage.some(r => r.kind === "COMMENTS_CAPTURE" && r.payload.hasMore === false && r.payload.truncated === false)) errors.push("顶层评论采集尚未完整结束，不能将截断样本视为全量");
        for (const parent of saved.filter(c => !c.parentCid && (c.replyCount===undefined||c.replyCount > 0))) if (!coverage.some(r => r.kind === "REPLIES_CAPTURE" && r.payload.parentCid === parent.cid && r.payload.hasMore === false && r.payload.truncated === false)) { errors.push("仍有父评论的楼中楼缺少明确采集覆盖：" + parent.cid); break; }
        if (saved.length && !saved.some(c => c.category && c.sentiment && c.priority)) errors.push("已保存评论尚未完成有效分类分析");
      }
    }
    if (stages.includes("FEEDBACK")) {
      let consumed = false;
      for (const record of records.filter(r => r.kind === "STRATEGY_INPUT")) {
        const input = record.payload;
        const parse = z.object({ batchId: id, version: z.number().int().positive(), batchHash: hash, context: z.record(z.string(), z.unknown()), inputHash: hash,
          feedback: z.array(z.object({ feedbackId: id, insightId: id, text: z.string(), evidenceRefs: z.array(z.string()) })) }).safeParse(input);
        if (!parse.success || hashValue(parse.data.context) !== parse.data.inputHash) continue;
        const candidate = await this.d.productRepo.getVersion<CreativeBatch>(projectId, "CreativeBatch", parse.data.batchId, parse.data.version);
        if (!candidate || !creativeBatchSchema.safeParse(candidate).success || candidate.contentHash !== parse.data.batchHash || candidate.projectId !== projectId) continue;
        for (const item of parse.data.feedback) {
          const saved = feedback.find(f => f.id === item.feedbackId && f.insightId === item.insightId && f.actionText === item.text && hashValue(f.evidenceRefs) === hashValue(item.evidenceRefs));
          const insight = saved ? await this.d.opsRepo.findInsightById(saved.insightId) : null;
          if (saved && insight?.projectId === projectId && insight.awemeId === binding?.awemeId && candidate.createdAt >= saved.confirmedAt &&
              typeof parse.data.context.requestText === "string" && parse.data.context.requestText.includes(JSON.stringify(item))) consumed = true;
        }
      }
      if (!consumed) errors.push("尚未验证真实运营复盘反馈已进入同项目下一轮实际创意输入");
    }
    return errors;
  }
}
