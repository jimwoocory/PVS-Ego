import "../isolation/require-isolation.js";
import {deniedPort} from "../isolation/denied-port.js";
import http from "node:http";
import { installChineseResponse, validationMessage } from "./chinese-response.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import {CanvasVideoDownloadMcp} from "../adapters/video/canvas-video-download-mcp.js";
import {CanvasCliVideoDownload} from "../adapters/video/canvas-cli-video-download.js";
import {CanvasShortProductionService} from "../application/services/canvas-short-production.js";
import {CanvasVideoResultService} from "../application/services/canvas-video-result-service.js";
import {DreaminaCanvasRuntime,canvasRuntimeConfigSchema} from "../adapters/video/dreamina-canvas-runtime.js";
import {CanvasProductionService} from "../application/services/canvas-production-service.js";
import path from "node:path";
import { ZodError, z } from "zod";
import { DomesticJimengCliProvider, type ResolveGenerationAssets } from "../adapters/video/domestic-jimeng-cli-provider.js";
import { createConfiguredDomesticJimengProvider } from "../adapters/video/verified-dreamina-runtime-loader.js";
import { blockerFromProviderProbe } from "../application/services/provider-blocker.js";
import { PrismaProductFlowRepository } from "../adapters/db/prisma-product-flow-repository.js";
import { PrismaWorkflowRepository } from "../adapters/db/prisma-workflow-repository.js";
import { PrismaArtifactRepository } from "../adapters/db/prisma-artifact-repository.js";
import { PrismaGenerationRepository } from "../adapters/db/prisma-generation-repository.js";
import { PrismaReviewRepository } from "../adapters/db/prisma-review-repository.js";
import { PrismaProviderAuditRepository } from "../adapters/db/prisma-provider-audit-repository.js";
import { PrismaFinalOutputRepository } from "../adapters/db/prisma-final-output-repository.js";
import { PrismaAiSettingsRepository } from "../adapters/db/prisma-ai-settings-repository.js";
import { PrismaAgentTaskRepository } from "../adapters/db/prisma-agent-task-repository.js";
import { PrismaReferenceVideoRepository } from "../adapters/db/prisma-reference-video-repository.js";
import { PrismaResearchRepository } from "../adapters/db/prisma-research-repository.js";
import { PrismaTimelineRepository } from "../adapters/db/prisma-timeline-repository.js";
import { PrismaPublishRepository } from "../adapters/db/prisma-publish-repository.js";
import { PrismaDouyinOpsRepository } from "../adapters/db/prisma-douyin-ops-repository.js";
import { PrismaProjectDeletionService } from "../adapters/db/prisma-project-deletion-service.js";
import { prisma } from "../adapters/db/prisma-client.js";
import { LocalArtifactStore } from "../adapters/store/local-artifact-store.js";
import { LocalProductInputStore } from "../adapters/store/local-product-input-store.js";
import { HermesStructuredAiRuntime } from "../adapters/ai/hermes-structured-ai-runtime.js";
import { AiRuntimeRouter } from "../adapters/ai/ai-runtime-router.js";
import { WindowsDpapiSecretStore } from "../adapters/store/windows-dpapi-secret-store.js";
import { validateReferenceImagesForPreflight } from "../adapters/media/reference-image-validator.js";
import { probeMediaDurationMs } from "../adapters/media/probe-media-duration.js";
import { HermesProductDirectorGenerator } from "../adapters/ai/hermes-product-director-generator.js";
import { OfficialDouyinOpenApiProvider } from "../adapters/publish/official-douyin-openapi-provider.js";
import { DouyinOpenApiDirectProviderAdapter } from "../adapters/publish/douyin-openapi-direct-provider.js";
import { DouyinSdkHandoffProvider } from "../adapters/publish/douyin-sdk-handoff-provider.js";
import { DouyinH5HandoffProvider } from "../adapters/publish/douyin-h5-handoff-provider.js";
import { DouyinBrowserAutomationProvider } from "../adapters/publish/douyin-browser-automation-provider.js";
import { SocialAutoUploadRuntime } from "../adapters/publish/social-auto-upload-runtime.js";
import { YhtDouyinOpsRuntime } from "../adapters/douyin/yht-douyin-ops-runtime.js";
import { YhtDouyinReplyWriterRuntime } from "../adapters/douyin/yht-douyin-reply-writer-runtime.js";
import { WindowsDouyinOpsLauncher } from "../adapters/douyin/windows-douyin-ops-launcher.js";
import { ManualExportProvider } from "../adapters/publish/manual-export-provider.js";
import { HttpWebResearchProvider } from "../adapters/research/http-web-research-provider.js";
import { ExternalBrowserResearchProvider } from "../adapters/research/external-browser-research-provider.js";
import { HybridBrowserResearchProvider } from "../adapters/research/public-search-research-provider.js";
import {configuredResearchProviders} from "../adapters/research/configured-research-providers.js";
import { DefaultResearchMediaAnalyzer } from "../adapters/research/research-media-analyzer.js";
import { YhtDouyinOpsMarketVideoMediaFetcher, YhtDouyinOpsMarketVideoSearchProvider } from "../adapters/research/yht-douyin-ops-market-video-provider.js";
import {
  DouyinBrowserMarketVideoSearchProvider,
  DouyinBrowserMarketVideoMediaFetcher,
  FallbackMarketVideoMediaFetcher,
  FallbackMarketVideoSearchProvider,
  SystemChromeDouyinSearchRuntime
} from "../adapters/research/douyin-browser-market-video-provider.js";
import {
  WindowsDouyinResearchAuthLauncher,
  type DouyinResearchAuthLauncher
} from "../adapters/research/douyin-research-auth-launcher.js";
import { ProductFlowService, type ProjectWorkspace } from "../application/services/product-flow.js";
import { loadGenerationConfig } from "../application/config/generation-config.js";
import { AiGenerationService } from "../application/services/ai-generation.js";
import { AiSettingsService, p1AiSteps } from "../application/services/ai-settings-service.js";
import { DreaminaAgentCapabilityService } from "../application/services/dreamina-agent-capability.js";
import { directorGenerationSettingsSchema, resolveDirectorGenerationTarget } from "../application/services/director-generation-target.js";
import { AgentModeService } from "../application/services/agent-mode-service.js";
import {CreativeReferenceService} from "../application/services/creative-reference-service.js";
import {PrismaCreativeReferenceRepository} from "../adapters/db/prisma-creative-reference-repository.js";
import {collectResearchReferences} from "../application/services/collect-research-references.js";
import {handleCreativeReferenceHttp} from "./creative-reference-http.js";
import { BatchGenerationService } from "../application/services/batch-generation-service.js";
import { SmartGenerationService } from "../application/services/smart-generation-service.js";
import { ApplicationSmartProduction } from "../application/services/smart-production-adapter.js";
import { createV8PaidRequestGuard } from "../application/services/v8-paid-request-guard.js";
import { PrismaSmartRunRepository } from "../adapters/db/prisma-smart-run-repository.js";
import { resolveSmartWorkerPolicy, startSmartGenerationWorker } from "../application/services/smart-generation-worker.js";
import { handleSmartGenerationHttp } from "./smart-generation-http.js";
import { handleAutoEditHttp } from "./auto-edit-http.js";
import { handleDouyinOpsHttp } from "./douyin-ops-http.js";
import { handleAgentCycleHttp } from "./agent-cycle-http.js";
import { AgentCycleService, startAgentCycleWorker } from "../application/services/agent-cycle-service.js";
import { PvsAgentCapabilities } from "../application/services/pvs-agent-capabilities.js";
import { DouyinOperationsScheduleService, startDouyinOperationsScheduleWorker } from "../application/services/douyin-operations-schedule-service.js";
import { PrismaDouyinOperationsScheduleRepository } from "../adapters/db/prisma-douyin-operations-schedule-repository.js";
import { PrismaAgentCycleRepository } from "../adapters/db/prisma-agent-cycle-repository.js";
import { DouyinCollectionService } from "../application/services/douyin-collection-service.js";
import { PrismaDouyinCollectionRepository } from "../adapters/db/prisma-douyin-collection-repository.js";
import { publicApiError } from "./public-api-error.js";
import { AutoEditService } from "../application/services/auto-edit-service.js";
import { VisualEditAssessmentService } from "../application/services/visual-edit-assessment.js";
import { WindowsSpeechSynthesis } from "../adapters/media/windows-speech-synthesis.js";
import { inspectMedia } from "../adapters/media/inspect-media.js";
import { GeneratedAudioQcService } from "../application/services/generated-audio-qc.js";
import { DomesticJimengImageProvider } from "../adapters/image/domestic-jimeng-image-provider.js";
import { ProductionPlannerService } from "../application/services/production-planner.js";
import { ProductionAssetService } from "../application/services/production-asset-service.js";
import { assertProductionAssetBinding, findProductionRunForPlan, findProductionSetForRequest } from "../application/services/production-asset-context.js";
import { ScriptFeasibilityService } from "../application/services/script-feasibility-service.js";
import { V8DetailedScreenplayService } from "../application/services/v8-detailed-screenplay-service.js";
import { DirectorV3PlannerService } from "../application/services/director-v3-planner-service.js";
import {
  ReferenceVideoAnalysisService,
  referenceVideoBrowserPreviewRelativePath
} from "../application/services/reference-video-analysis.js";
import { ResearchService } from "../application/services/research-service.js";
import { ResearchEvidenceReader } from "../application/services/research-evidence-reader.js";
import { handleResearchEvidenceHttp } from "./research-evidence-http.js";
import {OperationsEvidenceReader} from "../application/services/operations-evidence-reader.js";
import {handleOperationsEvidenceHttp} from "./operations-evidence-http.js";
import type { MarketVideoSearchProvider } from "../application/ports/market-video-provider.js";
import { TaskCenterService } from "../application/services/task-center-service.js";
import { SystemHealthService } from "../application/services/system-health-service.js";
import { ProductDirectorService } from "../application/services/product-director.js";
import { GenerationPreflightService } from "../application/services/generation-preflight.js";
import { ApprovalService } from "../application/services/approval-service.js";
import { GenerationExecutionService } from "../application/services/generation-execution.js";
import { ReviewService } from "../application/services/review-service.js";
import { ProjectSnapshotService } from "../application/services/project-snapshot.js";
import { RecoveryService } from "../application/services/recovery-service.js";
import { resolveWorkflowNavigation } from "../application/services/workflow-navigation.js";
import { resolveWorkflowReadModel } from "../application/services/workflow-read-model.js";
import { inspectFinalAccess, inspectTimelineAccess } from "../application/services/workflow-step-access.js";
import { FinalAssemblyService } from "../application/services/final-assembly-service.js";
import { FinalQcService } from "../application/services/final-qc-service.js";
import {
  TimelineService,
  timelineDurationMs
} from "../application/services/timeline-service.js";
import { RenderEngine } from "../application/services/render-engine.js";
import { PublishProviderRegistry } from "../application/services/publish-provider-registry.js";
import { PublishBridgeService } from "../application/services/publish-bridge-service.js";
import {PrismaBrowserPublishCheckpoints} from "../adapters/db/prisma-browser-publish-checkpoints.js";
import { DouyinAccountBindingService } from "../application/services/douyin-account-binding-service.js";
import { DouyinWorkBindingService } from "../application/services/douyin-work-binding-service.js";
import { DouyinMetricService } from "../application/services/douyin-metric-service.js";
import { DouyinCommentService } from "../application/services/douyin-comment-service.js";
import { DouyinCommentClassificationService } from "../application/services/douyin-comment-classification-service.js";
import { DouyinReplyDraftService } from "../application/services/douyin-reply-draft-service.js";
import { DouyinReplyPublishService } from "../application/services/douyin-reply-publish-service.js";
import { DouyinRetrospectiveService } from "../application/services/douyin-retrospective-service.js";
import { DouyinCreativeFeedbackService } from "../application/services/douyin-creative-feedback-service.js";
import { DouyinOpsDashboardService } from "../application/services/douyin-ops-dashboard-service.js";
import { DouyinPublishService } from "../application/services/douyin-publish-service.js";
import {
  assertCanonicalProductArtifactReady,
  confirmProductTruthDraft,
  confirmProductionPlanDraft,
  confirmScriptDraft,
  reviseProductionPlanDraft,
  reviseScriptDraft,
  type ClaimDisposition,
  type UsageRuleDisposition,
  type ProductionPlanClipRevision,
  type ProductionPlanSegmentRevision,
  type ScriptBeatRevision
} from "../application/services/review-actions.js";
import type { WorkflowRepository } from "../application/ports/workflow-repository.js";
import type { ArtifactRepository } from "../application/ports/artifact-repository.js";
import type { GenerationRepository } from "../application/ports/generation-repository.js";
import type { ProductInputStore, ProductInputSnapshot } from "../application/ports/product-input-store.js";
import type { ReviewRepository } from "../application/ports/review-repository.js";
import type { ProviderAuditRepository } from "../application/ports/provider-audit-repository.js";
import type { FinalOutputRepository } from "../application/ports/final-output-repository.js";
import type { DouyinBrowserPublisherRuntime } from "../application/ports/douyin-browser-publisher-runtime.js";
import type { ProviderCommandEvidence } from "../application/ports/video-provider.js";
import { DomainValidationError } from "../domain/validation.js";
import {
  commandAttemptRecordSchema,
  providerIdentitySchema,
  projectSchema
} from "../domain/schemas.js";
import { sha256Bytes } from "../domain/hashing.js";
import { publishProviderTypeSchema } from "../domain/publish.js";
import type { TaskCenterStatus } from "../domain/task-center.js";
import { qrCodeSvg } from "./qr-code.js";
import { canServeArtifactContent } from "./artifact-media-policy.js";
import { renderBlockedStepPage, renderSafeRequestErrorPage } from "./blocked-step-ui.js";
import { renderTaskCenterPage } from "./task-center-ui.js";
import { renderHealthCenterPage } from "./health-center-ui.js";
import {
  renderMobilePublishPage,
  renderPublishSettingsPage
} from "./publish-ui.js";
import { renderAgentHome, renderAgentProjectPage, renderAiSettingsPage, renderProjectPage, renderProjectModelSettingsPage, renderProjectsPage, renderReferenceVideoPage, renderResearchPage } from "./workbench-ui.js";
import type {
  AssetRef,
  CreativeBatch,
  ForbiddenChange,
  ProductTruth,
  ProductionPlan,
  Project,
  ScriptDraft
} from "../domain/schemas.js";

export type WebDependencies = {
  agentCycles?: AgentCycleService;
  douyinCollection?: DouyinCollectionService;
  douyinSchedules?: DouyinOperationsScheduleService;
  productFlow: ProductFlowService;
  workflow: WorkflowRepository;
  artifacts: ArtifactRepository;
  generation: GenerationRepository;
  review: ReviewRepository;
  providerAudit: ProviderAuditRepository;
  finalOutput: FinalOutputRepository;
  aiSettings: AiSettingsService;
  dreaminaCapability: DreaminaAgentCapabilityService;
  agentMode: AgentModeService;
  smartGeneration?: SmartGenerationService;
  productionAssets?: ProductionAssetService;
  batchGeneration?: BatchGenerationService;
  creativeReferences?: CreativeReferenceService;
  collectCreativeReferences?: (projectId:string)=>Promise<{mediaCount:number;failures:string[]}>;
  autoEdit?: AutoEditService;
  visualEditAssessment?: VisualEditAssessmentService;
  referenceVideo: ReferenceVideoAnalysisService;
  research: ResearchService;
  researchEvidence?: ResearchEvidenceReader;
  operationsEvidence?:OperationsEvidenceReader;
  douyinResearchAuth?: DouyinResearchAuthLauncher;
  douyinMarketVideoSearch?: MarketVideoSearchProvider;
  taskCenter: TaskCenterService;
  health: SystemHealthService;
  productInput: ProductInputStore;
  aiGeneration: AiGenerationService;
  productDirector: ProductDirectorService;
  preflight: GenerationPreflightService;
  approval: ApprovalService;
  execution: GenerationExecutionService;
  reviewService: ReviewService;
  timeline: TimelineService;
  renderEngine: RenderEngine;
  publishBridge: PublishBridgeService;
  douyinBrowserRuntime?: DouyinBrowserPublisherRuntime;
  douyinOpsDashboard?: DouyinOpsDashboardService;
  finalAssembly: FinalAssemblyService;
  finalQc: FinalQcService;
  douyinPublish: DouyinPublishService;
  snapshots: ProjectSnapshotService;
  recovery: RecoveryService;
  projectDeletion: PrismaProjectDeletionService;
  projectsRoot: string;
  provider: DomesticJimengCliProvider;
};

export function createDefaultDependencies(): WebDependencies {
  const artifacts = new PrismaArtifactRepository(prisma);
  const generation = new PrismaGenerationRepository(prisma);
  const workflow = new PrismaWorkflowRepository(prisma);
  const review = new PrismaReviewRepository(prisma);
  const providerAudit = new PrismaProviderAuditRepository(prisma);
  const finalOutput = new PrismaFinalOutputRepository(prisma);
  const aiSettingsRepo = new PrismaAiSettingsRepository(prisma);
  const agentTasks = new PrismaAgentTaskRepository(prisma);
  const referenceVideos = new PrismaReferenceVideoRepository(prisma);
  const researchRepo = new PrismaResearchRepository(prisma);
  const timelineRepo = new PrismaTimelineRepository(prisma);
  const publishRepo = new PrismaPublishRepository(prisma);
  const secretStore = deniedPort<WindowsDpapiSecretStore>("SECRET_STORE");
  const hermesRuntime = deniedPort<HermesStructuredAiRuntime>("HERMES");
  const aiSettings = new AiSettingsService(aiSettingsRepo, secretStore, undefined, required=>hermesRuntime.supportsCapabilities(required));
  let creativeReferences: CreativeReferenceService;
  const productFlowRepo = new PrismaProductFlowRepository(prisma);
  const productFlow = new ProductFlowService(
    productFlowRepo,
    {assertExpected:(projectId,expected)=>creativeReferences.assertExpected(projectId,expected)}
  );
  const projectsRoot = path.resolve(process.env.PROJECTS_ROOT ?? "projects");
  const projectDeletion = new PrismaProjectDeletionService(prisma, projectsRoot);
  const productInput = new LocalProductInputStore(projectsRoot, artifacts);
  const resolveGenerationAssets: ResolveGenerationAssets = async (request) => {
    const snapshot = await productInput.latest(request.projectId);
    const referenceSet=request.agentTaskId?null:await creativeReferences.assertExpected(request.projectId,request.inputVersionRefs.find(r=>r.entityType==="CreativeReferenceSet"));
    const generatedReferences = request.assetManifest.filter(item => item.assetId.startsWith("production-asset:"));
    let boundProductionAssets: AssetRef[] = [];
    if (generatedReferences.length) {
      const setRef = request.inputVersionRefs.find(ref => ref.entityType === "ProductionAssetSet");
      const set = findProductionSetForRequest(
        request.projectId, setRef, await smartGeneration.list(request.projectId)
      );
      assertProductionAssetBinding(request.projectId, set ?? undefined, generatedReferences.map(item => item.assetId));
      if (!set) throw new DomainValidationError("本轮制作资产版本不存在，无法继续该镜头；原视频未改变");
      boundProductionAssets = await productionAssets.toAssetRefs(
        set, new Set(generatedReferences.map(item => item.assetId))
      );
    }
    const availableAssets=[...(snapshot?.assets??[]),...CreativeReferenceService.assets(referenceSet),...boundProductionAssets];
    const projectRoot = path.resolve(projectsRoot, request.projectId);
    const resolved = [];
    for (const manifest of [...request.assetManifest].sort(
      (a, b) =>
        a.priority - b.priority ||
        a.assetId.localeCompare(b.assetId)
    )) {
      const asset = availableAssets.find(
        (item) => item.id === manifest.assetId
      );
      const artifact = asset
        ? await artifacts.findById(asset.artifactId)
        : await artifacts.findById(manifest.assetId);
      if (!artifact && !manifest.required) {
        continue;
      }
      if (
        !artifact ||
        artifact.projectId !== request.projectId ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256 ||
        (asset ? artifact.sha256 !== asset.sha256 : false) ||
        artifact.sha256 !== manifest.artifactHash
      ) {
        throw new DomainValidationError(
          `video asset integrity mismatch: ${manifest.assetId}`
        );
      }
      const absolutePath = path.resolve(
        projectRoot,
        artifact.relativePath
      );
      const prefix = projectRoot.endsWith(path.sep)
        ? projectRoot
        : projectRoot + path.sep;
      if (
        absolutePath !== projectRoot &&
        !absolutePath.startsWith(prefix)
      ) {
        throw new DomainValidationError(
          `video asset path escapes project root: ${manifest.assetId}`
        );
      }
      const bytes = await fs.readFile(absolutePath);
      if (sha256Bytes(bytes) !== manifest.artifactHash) {
        throw new DomainValidationError(
          `video asset bytes changed after approval: ${manifest.assetId}`
        );
      }
      resolved.push({
        assetId: manifest.assetId,
        absolutePath,
        artifactHash: manifest.artifactHash,
        role: manifest.role,
        priority: manifest.priority,
        required: manifest.required,
        ...(manifest.inputType ? { inputType: manifest.inputType } : {})
      });
    }
    return resolved;
  };
  const provider = deniedPort<DomesticJimengCliProvider>("PAID_VIDEO");
  const aiRuntime = deniedPort<AiRuntimeRouter>("MODEL");
  const visualEditAssessment = new VisualEditAssessmentService({
    artifacts,
    productInput,
    runtime: aiRuntime,
    projectsRoot
  });
  creativeReferences=new CreativeReferenceService({repo:new PrismaCreativeReferenceRepository(prisma),artifacts,productInput,productFlow,runtime:aiRuntime,projectsRoot});
  const generatedAudioQc = new GeneratedAudioQcService(aiRuntime);
  const researchMediaAnalyzer=new DefaultResearchMediaAnalyzer(aiRuntime,{allowPrivateNetwork:process.env.PVS_RESEARCH_ALLOW_PRIVATE==="1"},creativeReferences);
  const referenceVideo = new ReferenceVideoAnalysisService(
    referenceVideos,
    artifacts,
    aiRuntime,
    projectsRoot
  );
  const douyinResearchOpsRuntime =
    deniedPort<YhtDouyinOpsRuntime>("DOUYIN_RESEARCH");
  const douyinBrowserResearchRuntime =
    deniedPort<SystemChromeDouyinSearchRuntime>("BROWSER_RESEARCH");
  const douyinMarketVideoSearch = new FallbackMarketVideoSearchProvider(
    new YhtDouyinOpsMarketVideoSearchProvider(
      douyinResearchOpsRuntime
    ),
    new DouyinBrowserMarketVideoSearchProvider(
      douyinBrowserResearchRuntime
    )
  );
  const douyinMarketVideoMediaFetcher =
    new FallbackMarketVideoMediaFetcher(
      new YhtDouyinOpsMarketVideoMediaFetcher(
        douyinResearchOpsRuntime
      ),
      new DouyinBrowserMarketVideoMediaFetcher(
        douyinBrowserResearchRuntime
      )
    );
  const researchProviders={web:deniedPort<ReturnType<typeof configuredResearchProviders>["web"]>("WEB_RESEARCH"),browser:deniedPort<ReturnType<typeof configuredResearchProviders>["browser"]>("BROWSER_RESEARCH")};
  const research = new ResearchService(
    researchRepo,
    researchProviders.web,
    researchProviders.browser,
    aiRuntime,
    productFlow,
    researchMediaAnalyzer,
    {
      searchProvider: douyinMarketVideoSearch,
      mediaFetcher: douyinMarketVideoMediaFetcher,
      artifacts,
      referenceVideo,
      projectsRoot
    }
  );
  const researchEvidence = new ResearchEvidenceReader(researchRepo,artifacts,projectsRoot);
  const douyinResearchAuth = deniedPort<WindowsDouyinResearchAuthLauncher>("BROWSER_AUTH");
  const generationConfig = loadGenerationConfig();
  const dreaminaCapability = new DreaminaAgentCapabilityService(provider);
  const preflight = new GenerationPreflightService(
    generation,
    workflow,
    provider,
    (projectId, entityKey) =>
      productFlow.nextVersion(projectId, "CompiledPrompt", entityKey),
    generationConfig.model,
    aiRuntime,
    dreaminaCapability,
    creativeReferences
  );
  const smartRunRepository = new PrismaSmartRunRepository(prisma);
  const v8PaidGuard = createV8PaidRequestGuard(smartRunRepository);
  const approval = new ApprovalService(generation, workflow, v8PaidGuard);
  const execution = new GenerationExecutionService(
    generation,
    workflow,
    artifacts,
    providerAudit,
    provider,
    projectsRoot,
    review,
    creativeReferences,
    inspectMedia,
    (file, request, tempDir) =>
      generatedAudioQc.sanitize(file, request, tempDir),
    v8PaidGuard
  );
  const agentMode = new AgentModeService(
    agentTasks,
    generation,
    workflow,
    artifacts,
    provider,
    approval,
    execution,
    dreaminaCapability,
    finalOutput,
    productFlow,
    projectsRoot
  );
  const reviewService = new ReviewService(
    productFlow,
    generation,
    workflow,
    artifacts,
    review
  );
  const timeline = new TimelineService(
    productFlow,
    workflow,
    artifacts,
    review,
    timelineRepo,
    projectsRoot
  );
  const renderEngine = new RenderEngine(
    productFlow,
    artifacts,
    timelineRepo,
    finalOutput,
    projectsRoot
  );
  const finalAssembly = new FinalAssemblyService(
    productFlow,
    workflow,
    artifacts,
    review,
    finalOutput,
    projectsRoot
  );
  const finalQc = new FinalQcService(
    productFlow,
    artifacts,
    finalOutput,
    timeline,
    review,
    projectsRoot
  );
  const douyinProvider = deniedPort<OfficialDouyinOpenApiProvider>("OFFICIAL_PUBLISH");
  const douyinBrowserRuntime = deniedPort<SocialAutoUploadRuntime>("UPLOAD_PUBLISH");
  const douyinOpsRepo = new PrismaDouyinOpsRepository(prisma);
  const douyinOpsRuntime = deniedPort<YhtDouyinOpsRuntime>("DOUYIN_OPS");
  const douyinAccountBinding = new DouyinAccountBindingService(
    douyinBrowserRuntime,
    douyinOpsRuntime
  );
  const douyinWorkBinding = new DouyinWorkBindingService();
  const douyinMetricService = new DouyinMetricService(
    douyinOpsRepo,
    douyinOpsRuntime
  );
  const douyinCommentService = new DouyinCommentService(
    douyinOpsRepo,
    douyinOpsRuntime
  );
  const douyinCollection = new DouyinCollectionService(new PrismaDouyinCollectionRepository(prisma), douyinOpsRepo, douyinCommentService);
  const douyinSchedules = new DouyinOperationsScheduleService(new PrismaDouyinOperationsScheduleRepository(prisma), {
    ops:douyinOpsRepo,metrics:douyinMetricService,collections:douyinCollection,identity:()=>douyinOpsRuntime.identity()
  });
  const douyinCommentClassifier =
    new DouyinCommentClassificationService(
      douyinOpsRepo,
      aiRuntime
    );
  const douyinReplyDraftService =
    new DouyinReplyDraftService(
      douyinOpsRepo,
      productFlow,
      aiRuntime
    );
  const douyinReplyWriter =
    deniedPort<YhtDouyinReplyWriterRuntime>("COMMENT_REPLY");
  const douyinReplyPublishService =
    new DouyinReplyPublishService(
      douyinOpsRepo,
      douyinOpsRuntime,
      douyinAccountBinding,
      douyinReplyWriter
    );
  const douyinRetrospectiveService =
    new DouyinRetrospectiveService(
      douyinOpsRepo,
      productFlow,
      aiRuntime,
      douyinCollection
    );
  const douyinCreativeFeedbackService =
    new DouyinCreativeFeedbackService(
      douyinOpsRepo,productFlow
    );
  const douyinOpsDashboard = new DouyinOpsDashboardService(
    productFlow,
    publishRepo,
    douyinOpsRepo,
    douyinOpsRuntime,
    douyinAccountBinding,
    douyinWorkBinding,
    douyinMetricService,
    douyinCommentService,
    douyinCommentClassifier,
    douyinReplyDraftService,
    douyinReplyPublishService,
    douyinRetrospectiveService,
    douyinCreativeFeedbackService,
    deniedPort<WindowsDouyinOpsLauncher>("OPS_BROWSER_LAUNCH"),
    "LOCAL"
  );
  const publishProviders = new PublishProviderRegistry([
    new DouyinBrowserAutomationProvider(douyinBrowserRuntime),
    new DouyinSdkHandoffProvider(),
    new DouyinH5HandoffProvider(),
    new DouyinOpenApiDirectProviderAdapter(douyinProvider),
    new ManualExportProvider()
  ]);
  const publishBridge = new PublishBridgeService(
    productFlow,
    artifacts,
    finalOutput,
    publishRepo,
    publishProviders,
    projectsRoot,
    {runtime:douyinBrowserRuntime,checkpoints:new PrismaBrowserPublishCheckpoints(prisma)}
  );
  const health = new SystemHealthService({
    aiSettings,
    hermesFallbackAvailable: () => hermesRuntime.available(),
    productFlow,
    provider,
    publishBridge,
    dreaminaRegistry: () => dreaminaCapability.registry(),
    databasePing: async () => {
      await prisma.$queryRawUnsafe("SELECT 1");
    },
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    browserResearchUrl: process.env.PVS_BROWSER_RESEARCH_URL?.trim() ?? ""
  });
  const douyinPublish = new DouyinPublishService(
    productFlow,
    workflow,
    artifacts,
    finalOutput,
    douyinProvider,
    projectsRoot
  );
  const snapshots = new ProjectSnapshotService(
    projectsRoot,
    productFlow,
    productInput,
    artifacts,
    generation,
    workflow,
    review,
    providerAudit,
    referenceVideos,
    researchRepo,
    timelineRepo,
    publishBridge
  );
  const recovery = new RecoveryService(
    projectsRoot,
    productFlow,
    artifacts,
    workflow,
    snapshots,
    renderEngine
  );
  const aiGeneration = new AiGenerationService(
    aiRuntime,
    creativeReferences,
    (projectId) =>
      douyinCreativeFeedbackService.context(
        projectId
      ),
    (profile,projectId)=>referenceVideo.assertCurrentEvidence(profile,projectId)
  );
  const verifyReferenceVideo=(profile:Parameters<ReferenceVideoAnalysisService["assertCurrentEvidence"]>[0],projectId:string)=>referenceVideo.assertCurrentEvidence(profile,projectId);
  const productDirector = new ProductDirectorService(new HermesProductDirectorGenerator(aiRuntime,verifyReferenceVideo), aiRuntime,creativeReferences,verifyReferenceVideo);
  const scriptFeasibility = new ScriptFeasibilityService(aiRuntime);
  const v8Screenplay = new V8DetailedScreenplayService(aiRuntime);
  const directorV3Planner = new DirectorV3PlannerService();
  const productionPlanner = new ProductionPlannerService(aiRuntime);
  const canvasProduction=process.env.PVS_CANVAS_RUNTIME_CONFIG?new CanvasProductionService(new DreaminaCanvasRuntime(
    canvasRuntimeConfigSchema.parse(JSON.parse(readFileSync(process.env.PVS_CANVAS_RUNTIME_CONFIG,"utf8"))))):undefined;
  const canvasVideoDownload=canvasProduction?(process.env.PVS_CANVAS_VIDEO_DELIVERY_MCP_CONFIG?new CanvasVideoDownloadMcp():new CanvasCliVideoDownload(canvasProduction.runtime,projectsRoot)):undefined;
  const canvasVideoResults=canvasProduction&&canvasVideoDownload?new CanvasVideoResultService(canvasProduction,canvasVideoDownload,artifacts,generation,workflow,projectsRoot):undefined;
  const canvasShortProduction=canvasProduction&&canvasVideoDownload?new CanvasShortProductionService(canvasProduction,canvasVideoDownload,artifacts,generation,workflow,review,projectsRoot):undefined;
  const productionAssets = new ProductionAssetService(
    artifacts,
    deniedPort<DomesticJimengImageProvider>("PAID_IMAGE"),
    aiRuntime,
    projectsRoot
  );
  const batchGeneration = new BatchGenerationService(productFlow, generation, workflow, review, execution);
  const autoEdit = new AutoEditService({ productFlow, workflow, review, artifacts, timelines: timelineRepo, projectsRoot, speech: deniedPort<WindowsSpeechSynthesis>("SPEECH"), visualReview: visualEditAssessment });
  const smartGeneration = new SmartGenerationService(smartRunRepository, new ApplicationSmartProduction({
    productFlow, productInput, artifacts, aiGeneration, productDirector, referenceVideo, research,
    generation, workflow, review, dreaminaCapability, preflight, approval, execution, batchGeneration,
    finalOutput, renderEngine, timeline, projectsRoot, creativeReferences,
    reviewService, visualReview: visualEditAssessment,
    productionPlanner, productionAssets, scriptFeasibility, directorV3Planner, v8Screenplay, canvasProduction,canvasVideoResults,canvasShortProduction,
    autoEdit: async run => {
      const result = await autoEdit.create({ projectId: run.projectId, attemptIds: run.attemptIds, expectedPlanHash: run.productionPlan!.contentHash,
        settings: run.postProduction ?? run.options.postProduction ?? { bgmArtifactId: run.options.bgmArtifactId, allowSilentOutput: run.options.allowSilentOutput } });
      const confirmed = await timeline.confirm(run.projectId, { id: result.timeline.id, hash: result.timeline.contentHash });
      return { timelineRef: { id: confirmed.id, hash: confirmed.contentHash }, autoEditArtifactId: result.planArtifactId };
    },
    preflightAudit: async (projectId, result) => { await persistPreflightProviderAudit(dependencies, projectId, result.probe); }
  }));
  const taskCenter = new TaskCenterService({
    productFlow,
    research,
    agentMode,
    smartGeneration,
    workflow,
    generation,
    review,
    timeline,
    finalOutput,
    publishBridge
  });
  const agentCapabilities = new PvsAgentCapabilities({
    productFlow,productRepo:productFlowRepo,productInput,research,researchRepo,aiGeneration,smartGeneration,referenceVideo,collections:douyinCollection,
    schedules:douyinSchedules,readOpsAccount:()=>douyinOpsRuntime.identity(),
    finalOutput,finalAssembly,finalQc,review:reviewService,publishBridge,publishRepo,
    opsDashboard:douyinOpsDashboard,opsRepo:douyinOpsRepo,metrics:douyinMetricService,comments:douyinCommentService,
    classifier:douyinCommentClassifier,retrospective:douyinRetrospectiveService,feedback:douyinCreativeFeedbackService,
    artifacts,projectsRoot,publicBaseUrl:process.env.PVS_PUBLIC_BASE_URL?.trim()||`http://127.0.0.1:${process.env.PORT??3090}`,
    readPublishAccount:async(projectId)=>{
      const state=await publishBridge.providerStatus(projectId);
      const selected=state.probes.find(probe=>probe.providerType===state.preference.providerType);
      if(!selected||selected.code!=="READY"||!selected.platformUserId)throw new DomainValidationError("尚不能确认目标发布账号，请先在发布设置中验证账号");
      return {accountId:selected.platformUserId,displayName:selected.accountDisplayName??selected.platformUserId};
    }
  });
  const agentCycles = new AgentCycleService(new PrismaAgentCycleRepository(prisma),agentCapabilities,aiRuntime);
  const dependencies: WebDependencies = {
    agentCycles,
    douyinCollection,
    douyinSchedules,
    operationsEvidence:new OperationsEvidenceReader(new PrismaDouyinOperationsScheduleRepository(prisma),new PrismaDouyinCollectionRepository(prisma),douyinOpsRepo,productFlowRepo,artifacts,projectsRoot),
    creativeReferences,
    visualEditAssessment,
    collectCreativeReferences:(projectId)=>collectResearchReferences(projectId,research,productFlow,researchMediaAnalyzer),
    productFlow,
    workflow,
    artifacts,
    generation,
    review,
    providerAudit,
    finalOutput,
    aiSettings,
    dreaminaCapability,
    agentMode,
    referenceVideo,
    research,
    douyinResearchAuth,
    researchEvidence,
    douyinMarketVideoSearch,
    taskCenter,
    health,
    productInput,
    aiGeneration,
    productDirector,
    smartGeneration,
    productionAssets,
    batchGeneration,
    autoEdit,
    preflight,
    approval,
    execution,
    reviewService,
    timeline,
    renderEngine,
    publishBridge,
    douyinBrowserRuntime,
    douyinOpsDashboard,
    finalAssembly,
    finalQc,
    douyinPublish,
    snapshots,
    recovery,
    projectDeletion,
    projectsRoot,
    provider
  };
  return dependencies;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0"
  });
  res.end(body);
}

async function readJson(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new DomainValidationError("Request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainValidationError("Invalid JSON body");
  }
}

function assertProjectBody(projectId: string, body: unknown): void {
  if (!body || typeof body !== "object" || (body as { projectId?: unknown }).projectId !== projectId) {
    throw new DomainValidationError("Body projectId must match URL project id");
  }
}

function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base || "upload.bin";
}

function decodeBase64(
  value: string,
  maxBytes = 10 * 1024 * 1024
): Buffer {
  const raw = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) throw new DomainValidationError("Uploaded file is empty");
  if (bytes.byteLength > maxBytes) {
    throw new DomainValidationError(
      "Uploaded file exceeds the allowed size"
    );
  }
  return bytes;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainValidationError(`${label} is required`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DomainValidationError(label + " must be a finite number");
  }
  return value;
}

function requestPublicBaseUrl(req: http.IncomingMessage): string {
  const configured = process.env.PVS_PUBLIC_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DomainValidationError(
        "PVS_PUBLIC_BASE_URL must use http/https"
      );
    }
    return url.toString().replace(/\/$/, "");
  }
  const forwardedProto = String(
    req.headers["x-forwarded-proto"] ?? ""
  )
    .split(",")[0]
    ?.trim();
  const proto = forwardedProto === "https" ? "https" : "http";
  const forwardedHost = String(
    req.headers["x-forwarded-host"] ?? ""
  )
    .split(",")[0]
    ?.trim();
  const host = forwardedHost || req.headers.host;
  if (!host || /[\r\n]/.test(host)) {
    throw new DomainValidationError("Request host is required");
  }
  return new URL(proto + "://" + host).toString().replace(/\/$/, "");
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const value = req.headers.authorization?.trim();
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function requireBearerToken(req: http.IncomingMessage): string {
  const token = bearerToken(req);
  if (!token) {
    throw new DomainValidationError("Bearer publish session is required");
  }
  return token;
}

async function refreshProjectSnapshot(
  deps: WebDependencies,
  projectId: string
): Promise<void> {
  await deps.snapshots.refresh(projectId);
}

function sameArgs(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export async function persistPreflightProviderAudit(
  deps: WebDependencies,
  projectId: string,
  probe: Awaited<ReturnType<DomesticJimengCliProvider["probe"]>>
): Promise<{ providerIdentityId?: string; commandAttemptIds: string[] }> {
  const evidence = deps.provider.drainCommandEvidence();
  if (!evidence.length) return { commandAttemptIds: [] };

  const existing = await deps.providerAudit.listCommandAttempts(projectId);
  const counts = new Map<string, number>();
  for (const item of existing) {
    counts.set(item.operation, Math.max(counts.get(item.operation) ?? 0, item.attemptNumber));
  }

  const store = new LocalArtifactStore(
    path.join(deps.projectsRoot, projectId),
    deps.artifacts
  );
  const persisted: Array<{
    evidence: ProviderCommandEvidence;
    commandAttemptId: string;
    stdoutArtifactId: string;
    stderrArtifactId: string;
  }> = [];

  for (const item of evidence) {
    const commandAttemptId = randomUUID();
    const operation = item.operation;
    const attemptNumber = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, attemptNumber);
    const base =
      "provider/commands/" +
      commandAttemptId +
      "-" +
      operation.toLowerCase();

    const [stdoutArtifact, stderrArtifact] = await Promise.all([
      store.writeImmutable({
        id: randomUUID(),
        projectId,
        kind: "STDOUT",
        relativePath: base + "-stdout.txt",
        immutable: true,
        bytes: Buffer.from(item.stdoutRedacted, "utf8"),
        mimeType: "text/plain"
      }),
      store.writeImmutable({
        id: randomUUID(),
        projectId,
        kind: "STDERR",
        relativePath: base + "-stderr.txt",
        immutable: true,
        bytes: Buffer.from(item.stderrRedacted, "utf8"),
        mimeType: "text/plain"
      })
    ]);

    const record = commandAttemptRecordSchema.parse({
      id: commandAttemptId,
      operation,
      attemptNumber,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      exitCode: item.exitCode,
      timedOut: item.timedOut,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      redactionRulesVersion: "p0-redact-v1",
      parserVersion: "p0-provider-v1",
      ...(item.exitCode !== 0
        ? { errorCode: operation + "_FAILED" }
        : {})
    });
    await deps.providerAudit.createCommandAttempt({
      ...record,
      projectId,
      argvRedacted: item.argvRedacted
    });
    persisted.push({
      evidence: item,
      commandAttemptId,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id
    });
  }

  if (probe.code !== "READY") {
    return {
      commandAttemptIds: persisted.map((item) => item.commandAttemptId)
    };
  }

  const identityContract = deps.provider.getVerifiedIdentityContract();
  const probeArgs = deps.provider.getVerifiedProbeArgs();
  if (!identityContract || !probeArgs) {
    throw new DomainValidationError(
      "READY provider must expose verified identity and probe contract"
    );
  }
  const executableName =
    probe.executablePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "dreamina";
  const findProbeEvidence = (args: string[]) =>
    persisted.find(
      (item) =>
        item.evidence.operation === "PROBE" &&
        sameArgs(item.evidence.argvRedacted, [executableName, ...args])
    );
  const versionEvidence = findProbeEvidence(probeArgs.versionArgs);
  const helpEvidence = findProbeEvidence(probeArgs.helpArgs);
  if (!versionEvidence || !helpEvidence) {
    throw new DomainValidationError(
      "READY provider is missing separately auditable version/help command evidence"
    );
  }

  const rawVersionArtifactId = versionEvidence.evidence.stdoutRedacted.trim()
    ? versionEvidence.stdoutArtifactId
    : versionEvidence.stderrArtifactId;
  const rawHelpArtifactId = helpEvidence.evidence.stdoutRedacted.trim()
    ? helpEvidence.stdoutArtifactId
    : helpEvidence.stderrArtifactId;

  const identity = providerIdentitySchema.parse({
    ...identityContract,
    executablePath: probe.executablePath,
    executableSha256: probe.executableSha256,
    cliVersion: probe.cliVersion,
    rawVersionArtifactId,
    rawHelpArtifactId,
    capabilityFingerprint: probe.capabilityFingerprint,
    verificationStatus: "VERIFIED"
  });
  await deps.providerAudit.saveIdentity(projectId, identity);

  return {
    providerIdentityId: identity.id,
    commandAttemptIds: persisted.map((item) => item.commandAttemptId)
  };
}

export function createAppServer(
  deps: WebDependencies = createDefaultDependencies()
): http.Server {
  const activeResearchProjects = new Set<string>();
  const smartWorkerPolicy = resolveSmartWorkerPolicy();
  // UX-R1: all user-facing next actions are projected from existing project and
  // SmartRun facts; requesting the projection never creates or resumes a task.
  async function readWorkflow(
    workspace: ProjectWorkspace,
    input?: ProductInputSnapshot | null,
    selectedRunId?: string | null
  ) {
    if (!deps.smartGeneration) return undefined;
    const [runs, timeline, assembly] = await Promise.all([
      deps.smartGeneration.list(workspace.project.id),
      deps.timeline.latestTimeline(workspace.project.id),
      deps.finalOutput.latestAssembly(workspace.project.id)
    ]);
    return resolveWorkflowReadModel({
      project: workspace.project,
      runs,
      productInputPresent: Boolean(input),
      productImagePresent: Boolean(input?.assets.some(asset => asset.type === "image")),
      productTruthConfirmed: workspace.productTruth?.status === "CONFIRMED",
      productTruthDraftPresent: Boolean(workspace.productTruth),
      selectedRunId,
      timelineStatus: timeline?.status,
      timelinePlanHash: timeline?.productionPlanHash,
      finalAssemblyStatus: assembly?.status,
      finalAssemblyPlanHash: assembly?.productionPlanHash,
      projectPlanHash: workspace.project.currentProductionPlanRef?.hash
    });
  }
  const server = http.createServer(async (req, res) => {
    installChineseResponse(res);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await handleResearchEvidenceHttp(req,res,url,deps)) return;
      if (await handleOperationsEvidenceHttp(req,res,url,deps)) return;
      if (await handleAgentCycleHttp(req,res,url,deps)) return;
      if (await handleCreativeReferenceHttp(req,res,url,deps)) return;
      if (await handleSmartGenerationHttp(req, res, url, { ...deps, smartWorkerPolicy })) return;
      if (await handleAutoEditHttp(req, res, url, deps)) return;
      if (await handleDouyinOpsHttp(req, res, url, deps)) return;

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          status: "ok",
          service: "product-video-studio",
          specVersion: "P1-0.3.0-p1-final",
          localBuild: "agent-cycle-repair-20261016",
          agentWorkflowRevision: "canvas-authorized-single-video-20261019.1",
          uiLanguage: "zh-CN",
          sourceRevision: "9a94093"
        });
      }

      if (req.method === "GET" && url.pathname === "/api/health/report") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        return json(res, 200, {
          report: await deps.health.check(projectId)
        });
      }

      if (req.method === "GET" && url.pathname === "/health-center") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        const [report, projects] = await Promise.all([
          deps.health.check(projectId),
          deps.productFlow.listProjects()
        ]);
        return html(
          res,
          200,
          renderHealthCenterPage({ report, projects })
        );
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        return json(res, 200, { items: await deps.taskCenter.listAll() });
      }

      const projectTasksApiMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/tasks$/
      );
      if (req.method === "GET" && projectTasksApiMatch) {
        const projectId = decodeURIComponent(projectTasksApiMatch[1]!);
        return json(res, 200, {
          items: await deps.taskCenter.listProject(projectId)
        });
      }

      if (req.method === "GET" && url.pathname === "/tasks") {
        const allowedStatuses = new Set<TaskCenterStatus>([
          "WAITING",
          "RUNNING",
          "NEEDS_USER",
          "SUCCEEDED",
          "FAILED",
          "CANCELLED",
          "UNKNOWN"
        ]);
        const requestedStatus = url.searchParams.get("status");
        const status =
          requestedStatus &&
          allowedStatuses.has(requestedStatus as TaskCenterStatus)
            ? (requestedStatus as TaskCenterStatus)
            : undefined;
        const projectId = url.searchParams.get("projectId") ?? undefined;
        return html(
          res,
          200,
          renderTaskCenterPage({
            items: await deps.taskCenter.listAll(),
            ...(status ? { status } : {}),
            ...(projectId ? { projectId } : {})
          })
        );
      }

      if (req.method === "GET" && url.pathname === "/api/provider/probe") {
        const probe = await deps.provider.probe();
        const blocker = blockerFromProviderProbe(
          url.searchParams.get("projectId") ?? "local-probe",
          probe
        );
        return json(res, 200, { probe, blocker, waitingForUser: Boolean(blocker) });
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/dreamina/capabilities"
      ) {
        return json(res, 200, {
          registry: await deps.dreaminaCapability.registry()
        });
      }

      if (req.method === "POST" && url.pathname === "/api/ai/providers") {
        const body = await readJson(req);
        const provider = await deps.aiSettings.saveProvider(body);
        return json(res, 200, { provider });
      }

      const aiProviderTestMatch = url.pathname.match(
        /^\/api\/ai\/providers\/([^/]+)\/test$/
      );
      if (req.method === "POST" && aiProviderTestMatch) {
        const result = await deps.aiSettings.testProvider(
          decodeURIComponent(aiProviderTestMatch[1]!)
        );
        return json(res, 200, result);
      }

      const aiProviderRefreshMatch = url.pathname.match(
        /^\/api\/ai\/providers\/([^/]+)\/models\/refresh$/
      );
      if (req.method === "POST" && aiProviderRefreshMatch) {
        const models = await deps.aiSettings.refreshModels(
          decodeURIComponent(aiProviderRefreshMatch[1]!)
        );
        return json(res, 200, { models });
      }

      const aiProviderManualModelMatch = url.pathname.match(
        /^\/api\/ai\/providers\/([^/]+)\/models\/manual$/
      );
      if (req.method === "POST" && aiProviderManualModelMatch) {
        const body = (await readJson(req)) as {
          modelId?: unknown;
          displayName?: unknown;
          capabilities?: unknown;
        };
        const models = await deps.aiSettings.addManualModel(
          decodeURIComponent(aiProviderManualModelMatch[1]!),
          body.modelId,
          body.displayName,
          body.capabilities
        );
        return json(res, 200, { models });
      }

      const aiModelCapabilitiesMatch = url.pathname.match(
        /^\/api\/ai\/providers\/([^/]+)\/models\/capabilities$/
      );
      if (req.method === "POST" && aiModelCapabilitiesMatch) {
        const body = (await readJson(req)) as {
          modelId?: unknown;
          capabilities?: unknown;
        };
        const model = await deps.aiSettings.setModelCapabilities(
          decodeURIComponent(aiModelCapabilitiesMatch[1]!),
          body.modelId,
          body.capabilities
        );
        return json(res, 200, { model });
      }

      if (req.method === "POST" && url.pathname === "/api/ai/default") {
        const body = (await readJson(req)) as {
          providerId?: unknown;
          modelId?: unknown;
        };
        const preference = await deps.aiSettings.setSystemPreference({
          ...(typeof body.providerId === "string" && body.providerId
            ? { defaultProviderId: body.providerId }
            : {}),
          ...(typeof body.modelId === "string" && body.modelId
            ? { defaultModelId: body.modelId }
            : {})
        });
        return json(res, 200, { preference });
      }

      const projectAiDefaultMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/ai\/default$/
      );
      if (req.method === "POST" && projectAiDefaultMatch) {
        const projectId = projectAiDefaultMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const body = (await readJson(req)) as {
          providerId?: unknown;
          modelId?: unknown;
        };
        const preference = await deps.aiSettings.setProjectPreference(
          projectId,
          {
            ...(typeof body.providerId === "string" && body.providerId
              ? { defaultProviderId: body.providerId }
              : {}),
            ...(typeof body.modelId === "string" && body.modelId
              ? { defaultModelId: body.modelId }
              : {})
          }
        );
        return json(res, 200, { preference });
      }

      const projectAiStepMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/ai\/step$/
      );
      if (req.method === "POST" && projectAiStepMatch) {
        const projectId = projectAiStepMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const body = (await readJson(req)) as {
          step?: unknown;
          providerId?: unknown;
          modelId?: unknown;
        };
        if (
          typeof body.step !== "string" ||
          !p1AiSteps.some((item) => item.step === body.step)
        ) {
          throw new DomainValidationError("无效的 AI 生产步骤");
        }
        const selection =
          typeof body.providerId === "string" &&
          body.providerId &&
          typeof body.modelId === "string" &&
          body.modelId
            ? { providerId: body.providerId, modelId: body.modelId }
            : null;
        const override = await deps.aiSettings.setStepOverride(
          projectId,
          body.step as (typeof p1AiSteps)[number]["step"],
          selection
        );
        return json(res, 200, { override });
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        return json(res, 200, { projects: await deps.productFlow.listProjects() });
      }

      if (req.method === "POST" && url.pathname === "/api/projects") {
        const body = (await readJson(req)) as {
          name?: unknown;
          targetDurationMs?: unknown;
        };
        if (typeof body.name !== "string" || !body.name.trim()) {
          throw new DomainValidationError("Project name is required");
        }
        const targetDurationMs =
          typeof body.targetDurationMs === "number" ? body.targetDurationMs : 60000;
        const now = new Date().toISOString();
        const project = projectSchema.parse({
          id: randomUUID(),
          name: body.name.trim(),
          status: "DRAFT",
          targetPlatform: "douyin",
          targetDurationMs,
          aspectRatio: "9:16",
          createdAt: now,
          updatedAt: now
        });
        return json(res, 201, { project: await deps.productFlow.createProject(project) });
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === "GET" && projectMatch) {
        const project = await deps.productFlow.getProject(projectMatch[1]!);
        return project
          ? json(res, 200, { project })
          : json(res, 404, { error: "PROJECT_NOT_FOUND" });
      }

      const agentCreateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/agent\/tasks$/
      );
      if (req.method === "POST" && agentCreateMatch) {
        const projectId = agentCreateMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const body = (await readJson(req, 160_000_000)) as {
          skillId?: unknown;
          requestText?: unknown;
          requestedMethod?: unknown;
          model?: unknown;
          durationMs?: unknown;
          aspectRatio?: unknown;
          videoResolution?: unknown;
          nativeAudioOutputRequested?: unknown;
          materials?: unknown;
          existingArtifactIds?: unknown;
          logo?: unknown;
        };
        const requestText = requireString(
          body.requestText,
          "requestText"
        );
        const requestedMethod =
          typeof body.requestedMethod === "string"
            ? body.requestedMethod
            : "AUTO";
        const allowedMethods = new Set([
          "AUTO",
          "text2video",
          "image2video",
          "frames2video",
          "multiframe2video",
          "multimodal2video"
        ]);
        if (!allowedMethods.has(requestedMethod)) {
          throw new DomainValidationError("无效的智能生成方式");
        }
        const model =
          typeof body.model === "string" && body.model
            ? body.model
            : "seedance-2.0-mini";
        const durationMs =
          typeof body.durationMs === "number"
            ? body.durationMs
            : 10_000;
        const artifactStore = new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        );
        const storedMaterials: Array<{
          artifactId: string;
          type: "image" | "video" | "audio" | "logo";
          originalFilename: string;
          mimeType: string;
          sizeBytes: number;
          sha256: string;
          priority: number;
        }> = [];

        const storeAgentUpload = async (
          raw: unknown,
          forcedType?: "logo"
        ): Promise<void> => {
          if (!raw || typeof raw !== "object") {
            throw new DomainValidationError("智能生成素材格式无效");
          }
          const upload = raw as {
            name?: unknown;
            mimeType?: unknown;
            base64?: unknown;
          };
          const name = requireString(upload.name, "upload.name");
          const mimeType = requireString(
            upload.mimeType,
            "upload.mimeType"
          );
          const type =
            forcedType ??
            (mimeType.startsWith("image/")
              ? "image"
              : mimeType.startsWith("video/")
                ? "video"
                : mimeType.startsWith("audio/")
                  ? "audio"
                  : null);
          if (!type) {
            throw new DomainValidationError(
              `文件“${name}”：只支持图片、视频和音频素材`
            );
          }
          if (forcedType && !mimeType.startsWith("image/")) {
            throw new DomainValidationError(`Logo“${name}”：必须是图片文件`);
          }
          const maxBytes =
            type === "image" || type === "logo"
              ? 10 * 1024 * 1024
              : 80 * 1024 * 1024;
          let bytes: Buffer;
          try {
            bytes = decodeBase64(
              requireString(upload.base64, "upload.base64"),
              maxBytes
            );
          } catch (error) {
            throw new DomainValidationError(
              `文件“${name}”：内容无效或超过当前大小限制（${Math.round(maxBytes / 1024 / 1024)} MB）`
            );
          }
          const artifact = await artifactStore.writeImmutable({
            id: randomUUID(),
            projectId,
            kind: "USER_INPUT",
            relativePath:
              "agent/input/" +
              randomUUID() +
              "-" +
              safeFileName(name),
            immutable: true,
            bytes,
            mimeType
          });
          if (
            !artifact.sha256 ||
            artifact.sizeBytes === undefined
          ) {
            throw new DomainValidationError(
              `文件“${name}”：上传写入失败`
            );
          }
          let durationMs: number | undefined;
          if (type === "video" || type === "audio") {
            try {
              durationMs = await probeMediaDurationMs(
                artifactStore.resolveArtifactPath(artifact.relativePath)
              );
            } catch (error) {
              throw new DomainValidationError(
                `文件“${name}”：无法读取媒体时长，请检查文件是否损坏或格式不受支持`
              );
            }
          }
          storedMaterials.push({
            artifactId: artifact.id,
            type,
            originalFilename: name,
            mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            priority: storedMaterials.length,
            ...(durationMs !== undefined ? { durationMs } : {})
          });
        };

        const existingIds = Array.isArray(body.existingArtifactIds)
          ? [
              ...new Set(
                body.existingArtifactIds.map((value) =>
                  requireString(value, "existingArtifactId")
                )
              )
            ]
          : [];
        for (const artifactId of existingIds) {
          const artifact = await deps.artifacts.findById(artifactId);
          if (
            !artifact ||
            artifact.projectId !== projectId ||
            artifact.integrityStatus !== "READY" ||
            !artifact.sha256 ||
            !artifact.mimeType
          ) {
            throw new DomainValidationError(
              "带入 Agent 的已有素材不可用"
            );
          }
          const type = artifact.mimeType.startsWith("video/")
            ? "video"
            : artifact.mimeType.startsWith("audio/")
              ? "audio"
              : artifact.mimeType.startsWith("image/")
                ? "image"
                : null;
          if (!type) {
            throw new DomainValidationError(
              "Agent 已有素材只支持图片、视频和音频"
            );
          }
          const durationMs =
            type === "video" || type === "audio"
              ? await probeMediaDurationMs(
                  artifactStore.resolveArtifactPath(
                    artifact.relativePath
                  )
                )
              : undefined;
          storedMaterials.push({
            artifactId: artifact.id,
            type,
            originalFilename: path.basename(artifact.relativePath),
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes ?? 0,
            sha256: artifact.sha256,
            priority: storedMaterials.length,
            ...(durationMs !== undefined ? { durationMs } : {})
          });
        }

        for (const item of Array.isArray(body.materials)
          ? body.materials
          : []) {
          await storeAgentUpload(item);
        }
        if (body.logo && typeof body.logo === "object") {
          await storeAgentUpload(body.logo, "logo");
        }

        let task = await deps.agentMode.createTask({
          projectId,
          skillId:
            typeof body.skillId === "string"
              ? body.skillId
              : "dreamina-cli",
          requestText,
          requestedMethod:
            requestedMethod as
              | "AUTO"
              | "text2video"
              | "image2video"
              | "frames2video"
              | "multiframe2video"
              | "multimodal2video",
          model,
          durationMs,
          materials: storedMaterials,
          aspectRatio:
            typeof body.aspectRatio === "string"
              ? body.aspectRatio
              : "AUTO",
          videoResolution:
            typeof body.videoResolution === "string"
              ? body.videoResolution
              : "720p",
          nativeAudioOutputRequested:
            body.nativeAudioOutputRequested === true
        });
        task = await deps.agentMode.planTask(task.id);
        return json(res, 201, { task });
      }

      const agentMaterialsMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/agent\/tasks\/([^/]+)\/materials$/
      );
      if (req.method === "POST" && agentMaterialsMatch) {
        const projectId = agentMaterialsMatch[1]!;
        const taskId = agentMaterialsMatch[2]!;
        const task = await deps.agentMode.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          return json(res, 404, { error: "AGENT_TASK_NOT_FOUND" });
        }
        if (
          task.status !== "DRAFT" &&
          task.status !== "NEEDS_MATERIAL" &&
          task.status !== "READY_TO_CONFIRM"
        ) {
          throw new DomainValidationError(
            "当前任务已经进入生成确认或提交阶段，不能再修改素材"
          );
        }
        const body = (await readJson(req, 160_000_000)) as {
          orderedMaterials?: unknown;
          existingLogoArtifactId?: unknown;
          keepArtifactIds?: unknown;
          materials?: unknown;
          logo?: unknown;
        };
        const materialByArtifactId = new Map(
          task.materials.map((item) => [item.artifactId, item] as const)
        );
        const seenKeep = new Set<string>();
        const nextMaterials: typeof task.materials = [];
        const retainExisting = (artifactId: string) => {
          if (seenKeep.has(artifactId)) {
            throw new DomainValidationError(
              "任务素材列表包含重复项：" + artifactId
            );
          }
          seenKeep.add(artifactId);
          const material = materialByArtifactId.get(artifactId);
          if (!material) {
            throw new DomainValidationError(
              "不能保留不属于当前任务的素材：" + artifactId
            );
          }
          return material;
        };
        const artifactStore = new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        );
        const storeEditedUpload = async (
          raw: unknown,
          forcedType?: "logo"
        ): Promise<(typeof task.materials)[number]> => {
          if (!raw || typeof raw !== "object") {
            throw new DomainValidationError("智能生成素材格式无效");
          }
          const upload = raw as {
            name?: unknown;
            mimeType?: unknown;
            base64?: unknown;
          };
          const name = requireString(upload.name, "upload.name");
          const mimeType = requireString(
            upload.mimeType,
            "upload.mimeType"
          );
          const type =
            forcedType ??
            (mimeType.startsWith("image/")
              ? "image"
              : mimeType.startsWith("video/")
                ? "video"
                : mimeType.startsWith("audio/")
                  ? "audio"
                  : null);
          if (!type) {
            throw new DomainValidationError(
              `文件“${name}”：只支持图片、视频和音频素材`
            );
          }
          if (forcedType && !mimeType.startsWith("image/")) {
            throw new DomainValidationError(
              `Logo“${name}”：必须是图片文件`
            );
          }
          const maxBytes =
            type === "image" || type === "logo"
              ? 10 * 1024 * 1024
              : 80 * 1024 * 1024;
          let bytes: Buffer;
          try {
            bytes = decodeBase64(
              requireString(upload.base64, "upload.base64"),
              maxBytes
            );
          } catch {
            throw new DomainValidationError(
              `文件“${name}”：内容无效或超过当前大小限制（${Math.round(maxBytes / 1024 / 1024)} MB）`
            );
          }
          const artifact = await artifactStore.writeImmutable({
            id: randomUUID(),
            projectId,
            kind: "USER_INPUT",
            relativePath:
              "agent/input/" +
              randomUUID() +
              "-" +
              safeFileName(name),
            immutable: true,
            bytes,
            mimeType
          });
          if (!artifact.sha256 || artifact.sizeBytes === undefined) {
            throw new DomainValidationError(
              `文件“${name}”：上传写入失败`
            );
          }
          let mediaDurationMs: number | undefined;
          if (type === "video" || type === "audio") {
            try {
              mediaDurationMs = await probeMediaDurationMs(
                artifactStore.resolveArtifactPath(artifact.relativePath)
              );
            } catch {
              throw new DomainValidationError(
                `文件“${name}”：无法读取媒体时长，请检查文件是否损坏或格式不受支持`
              );
            }
          }
          return {
            artifactId: artifact.id,
            type,
            originalFilename: name,
            mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            priority: 0,
            ...(mediaDurationMs !== undefined
              ? { durationMs: mediaDurationMs }
              : {})
          };
        };
        if (Array.isArray(body.orderedMaterials)) {
          for (const [index, rawSlot] of body.orderedMaterials.entries()) {
            if (!rawSlot || typeof rawSlot !== "object") {
              throw new DomainValidationError(
                "任务素材顺序项格式无效"
              );
            }
            const slot = rawSlot as {
              existingArtifactId?: unknown;
              upload?: unknown;
            };
            if (
              typeof slot.existingArtifactId === "string" &&
              slot.existingArtifactId
            ) {
              const existing = retainExisting(slot.existingArtifactId);
              if (existing.type === "logo") {
                throw new DomainValidationError(
                  "Logo 必须通过独立 Logo 字段管理"
                );
              }
              nextMaterials.push({ ...existing, priority: index });
              continue;
            }
            if (slot.upload && typeof slot.upload === "object") {
              const uploaded = await storeEditedUpload(slot.upload);
              if (uploaded.type === "logo") {
                throw new DomainValidationError(
                  "Logo 必须通过独立 Logo 字段管理"
                );
              }
              nextMaterials.push({ ...uploaded, priority: index });
              continue;
            }
            throw new DomainValidationError(
              "任务素材顺序项缺少已有素材或新上传文件"
            );
          }
        } else {
          const requestedKeepIds = Array.isArray(body.keepArtifactIds)
            ? body.keepArtifactIds.map((value) =>
                requireString(value, "keepArtifactId")
              )
            : [];
          for (const artifactId of requestedKeepIds) {
            const existing = retainExisting(artifactId);
            nextMaterials.push({
              ...existing,
              priority: nextMaterials.length
            });
          }
          for (const item of Array.isArray(body.materials)
            ? body.materials
            : []) {
            const uploaded = await storeEditedUpload(item);
            nextMaterials.push({
              ...uploaded,
              priority: nextMaterials.length
            });
          }
        }
        if (
          typeof body.existingLogoArtifactId === "string" &&
          body.existingLogoArtifactId
        ) {
          const existingLogo = retainExisting(
            body.existingLogoArtifactId
          );
          if (existingLogo.type !== "logo") {
            throw new DomainValidationError(
              "指定的已有 Logo 不是 Logo 素材"
            );
          }
          nextMaterials.push({
            ...existingLogo,
            priority: nextMaterials.length
          });
        }
        if (body.logo && typeof body.logo === "object") {
          const uploadedLogo = await storeEditedUpload(body.logo, "logo");
          nextMaterials.push({
            ...uploadedLogo,
            priority: nextMaterials.length
          });
        }
        const updated = await deps.agentMode.replaceTaskMaterials({
          taskId,
          materials: nextMaterials
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { task: updated });
      }

      const agentActionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/agent\/tasks\/([^/]+)\/(plan|confirm|advance|reconcile|accept|redo)$/
      );
      if (req.method === "POST" && agentActionMatch) {
        const projectId = agentActionMatch[1]!;
        const taskId = agentActionMatch[2]!;
        const action = agentActionMatch[3]!;
        const task = await deps.agentMode.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          return json(res, 404, { error: "AGENT_TASK_NOT_FOUND" });
        }
        if (action === "plan") {
          return json(res, 200, {
            task: await deps.agentMode.planTask(taskId)
          });
        }
        if (action === "confirm") {
          const body = (await readJson(req)) as {
            acceptedUnknownCostRisk?: unknown;
          };
          return json(res, 200, {
            task: await deps.agentMode.confirmAndSubmit({
              taskId,
              acceptedUnknownCostRisk:
                body.acceptedUnknownCostRisk === true
            })
          });
        }
        if (action === "advance") {
          return json(res, 200, {
            task: await deps.agentMode.advance(taskId)
          });
        }
        if (action === "reconcile") {
          return json(res, 200, {
            task: await deps.agentMode.reconcile(taskId)
          });
        }
        if (action === "accept") {
          return json(res, 200, {
            task: await deps.agentMode.accept(taskId)
          });
        }
        const clone = await deps.agentMode.cloneForRedo(taskId);
        return json(res, 201, {
          task: await deps.agentMode.planTask(clone.id)
        });
      }

      const referenceVideoAnalyzeMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/reference-video\/analyze$/
      );
      if (req.method === "POST" && referenceVideoAnalyzeMatch) {
        const projectId = referenceVideoAnalyzeMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const body = (await readJson(req, 170_000_000)) as {
          video?: unknown;
        };
        if (!body.video || typeof body.video !== "object") {
          throw new DomainValidationError("请上传 MP4 / MOV 参考视频");
        }
        const upload = body.video as {
          name?: unknown;
          mimeType?: unknown;
          base64?: unknown;
        };
        const name = requireString(upload.name, "video.name");
        const mimeType = requireString(upload.mimeType, "video.mimeType");
        if (
          mimeType !== "video/mp4" &&
          mimeType !== "video/quicktime"
        ) {
          throw new DomainValidationError("参考视频当前只支持 MP4 / MOV");
        }
        if (!/\.(mp4|mov)$/i.test(name)) {
          throw new DomainValidationError("参考视频文件扩展名必须是 .mp4 或 .mov");
        }
        const bytes = decodeBase64(
          requireString(upload.base64, "video.base64"),
          120 * 1024 * 1024
        );
        const artifactStore = new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        );
        const uploadSha=sha256Bytes(bytes);
        const existingReference=(await deps.artifacts.listByProject(projectId,"USER_INPUT")).find(a=>a.sha256===uploadSha&&a.mimeType===mimeType&&a.integrityStatus==="READY");
        if(existingReference&&sha256Bytes(await fs.readFile(artifactStore.resolveArtifactPath(existingReference.relativePath)))!==uploadSha)
          throw new DomainValidationError("已保存参考视频实际文件SHA不一致，不能复用分析");
        const artifact = existingReference??await artifactStore.writeImmutable({
          id: randomUUID(),
          projectId,
          kind: "USER_INPUT",
          relativePath:
            "reference-video/" +
            randomUUID() +
            "-" +
            safeFileName(name),
          immutable: true,
          bytes,
          mimeType
        });
        const profile = await deps.referenceVideo.analyzeUpload({
          projectId,
          artifactId: artifact.id,
          originalFilename: name
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, { artifact, profile });
      }

      const referenceVideoDeactivateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/reference-video\/deactivate$/
      );
      if (req.method === "POST" && referenceVideoDeactivateMatch) {
        const projectId = referenceVideoDeactivateMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        await deps.referenceVideo.deactivate(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { active: false });
      }

      const researchRunMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/run$/
      );
      if (req.method === "POST" && researchRunMatch) {
        const projectId = researchRunMatch[1]!;
        if (activeResearchProjects.has(projectId)) {
          return json(res, 409, {
            error: "RESEARCH_ALREADY_RUNNING",
            message:
              "当前项目已有研究任务正在运行，请等待当前研究完成后再重试。"
          });
        }
        const body = (await readJson(req)) as {
          mode?: unknown;
          goal?: unknown;
          sourceUrls?: unknown;
          queries?: unknown;
          marketVideo?: unknown;
        };
        if (
          body.mode !== "OFF" &&
          body.mode !== "BASIC" &&
          body.mode !== "DEEP"
        ) {
          throw new DomainValidationError("无效的研究模式");
        }
        const sourceTypeSet = new Set([
          "OFFICIAL",
          "USER_URL",
          "PUBLIC_PRODUCT",
          "COMPETITOR",
          "INDUSTRY",
          "TREND",
          "PLATFORM"
        ]);
        const sourceUrls = Array.isArray(body.sourceUrls)
          ? body.sourceUrls.map((raw, index) => {
              if (!raw || typeof raw !== "object") {
                throw new DomainValidationError(
                  `research source #${index + 1} 无效`
                );
              }
              const item = raw as Record<string, unknown>;
              const sourceType = requireString(
                item.sourceType,
                "research.sourceType"
              );
              if (!sourceTypeSet.has(sourceType)) {
                throw new DomainValidationError(
                  "无效的 Research sourceType"
                );
              }
              return {
                url: requireString(item.url, "research.url"),
                sourceType: sourceType as
                  | "OFFICIAL"
                  | "USER_URL"
                  | "PUBLIC_PRODUCT"
                  | "COMPETITOR"
                  | "INDUSTRY"
                  | "TREND"
                  | "PLATFORM"
              };
            })
          : [];
        const queries = Array.isArray(body.queries)
          ? body.queries.map((item) =>
              requireString(item, "research.query")
            )
          : [];
        const marketVideoRaw =
          body.marketVideo && typeof body.marketVideo === "object"
            ? (body.marketVideo as Record<string, unknown>)
            : {};
        const marketSort =
          marketVideoRaw.sort === "RELEVANCE" ||
          marketVideoRaw.sort === "LATEST" ||
          marketVideoRaw.sort === "MOST_LIKED"
            ? marketVideoRaw.sort
            : "MOST_LIKED";
        const marketTimeRange =
          marketVideoRaw.timeRange === "DAY" ||
          marketVideoRaw.timeRange === "WEEK" ||
          marketVideoRaw.timeRange === "HALF_YEAR" ||
          marketVideoRaw.timeRange === "ANY"
            ? marketVideoRaw.timeRange
            : "ANY";
        const marketCount =
          typeof marketVideoRaw.count === "number" &&
          Number.isInteger(marketVideoRaw.count) &&
          marketVideoRaw.count >= 1 &&
          marketVideoRaw.count <= 30
            ? marketVideoRaw.count
            : 12;
        activeResearchProjects.add(projectId);
        try {
          const savedInput = await deps.productInput.latest(projectId);
          const result = await deps.research.startRun({
            projectId,
            ...(savedInput ? { productInput: {
              productName: savedInput.productName,
              ...(savedInput.brand ? { brand: savedInput.brand } : {}),
              ...(savedInput.category ? { category: savedInput.category } : {})
            } } : {}),
            mode: body.mode,
            goal:
              typeof body.goal === "string"
                ? body.goal
                : "",
            sourceUrls,
            queries,
            marketVideo: {
              enabled: marketVideoRaw.enabled !== false,
              sort: marketSort,
              timeRange: marketTimeRange,
              count: marketCount
            }
          });
          await refreshProjectSnapshot(deps, projectId);
          return json(res, 201, result);
        } finally {
          activeResearchProjects.delete(projectId);
        }
      }

      const researchDouyinAuthMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/douyin-auth\/launch$/
      );
      if (req.method === "POST" && researchDouyinAuthMatch) {
        const projectId = researchDouyinAuthMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        if (!deps.douyinResearchAuth) {
          return json(res, 503, {
            error: "DOUYIN_AUTH_LAUNCHER_UNAVAILABLE",
            message: "当前环境不能直接拉起抖音登录/验证窗口。"
          });
        }
        const body = (await readJson(req)) as { query?: unknown };
        const query =
          typeof body.query === "string" && body.query.trim()
            ? body.query.trim()
            : "护颈枕";
        const launched = await deps.douyinResearchAuth.launch(query);
        return json(res, 202, {
          started: launched.started,
          alreadyRunning: launched.alreadyRunning,
          message: launched.alreadyRunning
            ? "PVS 抖音研究独立浏览器已经打开，请在该窗口中完成登录/验证。"
            : "已打开 PVS 抖音研究独立浏览器。它与日常 Edge / Chrome Profile 隔离，不会关闭或重启你正在使用的浏览器。"
        });
      }

      const researchDouyinAuthSyncMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/douyin-auth\/sync$/
      );
      if (req.method === "POST" && researchDouyinAuthSyncMatch) {
        const projectId = researchDouyinAuthSyncMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        if (!deps.douyinResearchAuth) {
          return json(res, 503, {
            error: "DOUYIN_AUTH_LAUNCHER_UNAVAILABLE",
            message: "当前环境不能同步抖音搜索验证会话。"
          });
        }
        if (!deps.douyinMarketVideoSearch) {
          return json(res, 503, {
            error: "DOUYIN_SEARCH_PROVIDER_UNAVAILABLE",
            message: "当前环境不能验证抖音搜索风控是否已经解除。"
          });
        }
        const body = (await readJson(req)) as { query?: unknown };
        const query =
          typeof body.query === "string" && body.query.trim()
            ? body.query.trim()
            : "护颈枕";
        const synced = await deps.douyinResearchAuth.syncCookies();
        const probe = await deps.douyinMarketVideoSearch.search({
          projectId,
          queries: [query],
          sort: "MOST_LIKED",
          timeRange: "ANY",
          count: 1
        });
        if (probe.status === "BLOCKED") {
          return json(res, 409, {
            error:
              probe.code === "RISK_CONTROL"
                ? "DOUYIN_VERIFICATION_STILL_BLOCKED"
                : "DOUYIN_SEARCH_STILL_BLOCKED",
            code: probe.code,
            message:
              probe.code === "RISK_CONTROL"
                ? "验证尚未解除：抖音搜索仍然触发平台风控。请继续在打开的抖音搜索页完成人工验证，确认搜索结果可以正常显示后再重试。"
                : probe.message,
            requiredUserAction: probe.requiredUserAction
          });
        }
        return json(res, 200, {
          synced: true,
          cookieCount: synced.cookieCount,
          verified: true,
          message:
            "抖音搜索验证已解除，已同步当前搜索会话，准备重新研究。"
        });
      }

      const marketVideoSearchMoreMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/research\/runs\/([^/]+)\/market-videos\/search$/);
      if(req.method==="POST"&&marketVideoSearchMoreMatch){
        const body=z.object({queries:z.array(z.string().min(1).max(200)).min(1).max(12),count:z.number().int().min(1).max(30).optional()}).strict().parse(await readJson(req));
        const result=await deps.research.searchMoreMarketVideos({projectId:marketVideoSearchMoreMatch[1]!,runId:marketVideoSearchMoreMatch[2]!,...body});
        await refreshProjectSnapshot(deps,marketVideoSearchMoreMatch[1]!);
        return json(res,result.search.status==="READY"?200:409,result);
      }
      const marketVideoAnalyzeMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/runs\/([^/]+)\/market-videos\/([^/]+)\/analyze$/
      );
      if (req.method === "POST" && marketVideoAnalyzeMatch) {
        const projectId = marketVideoAnalyzeMatch[1]!;
        const runId = marketVideoAnalyzeMatch[2]!;
        const candidateId = marketVideoAnalyzeMatch[3]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const result = await deps.research.analyzeMarketVideo({
          projectId,
          runId,
          candidateId
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, result);
      }

      const researchResumeMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/runs\/([^/]+)\/resume$/
      );
      if (req.method === "POST" && researchResumeMatch) {
        const projectId = researchResumeMatch[1]!;
        const runId = researchResumeMatch[2]!;
        const result = await deps.research.resumeRun(
          projectId,
          runId
        );
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, result);
      }

      const researchClaimsMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/research\/claims\/send-to-truth$/
      );
      if (req.method === "POST" && researchClaimsMatch) {
        const projectId = researchClaimsMatch[1]!;
        const body = (await readJson(req)) as {
          briefId?: unknown;
          claimIds?: unknown;
          usageRuleIds?: unknown;
        };
        const result =
          await deps.research.sendClaimsToProductTruth({
            projectId,
            briefId: requireString(
              body.briefId,
              "briefId"
            ),
            claimIds: Array.isArray(body.claimIds)
              ? body.claimIds.map((item) =>
                  requireString(item, "claimId")
                )
              : [],
            usageRuleIds: Array.isArray(body.usageRuleIds)
              ? body.usageRuleIds.map((item) =>
                  requireString(item, "usageRuleId")
                )
              : []
          });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, result);
      }

      const productInputMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/product-input\/generate-truth$/
      );
      if (req.method === "POST" && productInputMatch) {
        const projectId = productInputMatch[1]!;
        const project = await deps.productFlow.getProject(projectId);
        if (!project) return json(res, 404, { error: "PROJECT_NOT_FOUND" });

        const body = (await readJson(req, 30_000_000)) as {
          productName?: unknown;
          featureDescription?: unknown;
          brand?: unknown;
          category?: unknown;
          images?: unknown;
          logo?: unknown;
          forbiddenChanges?: unknown;
          deferTruth?: unknown;
        };
        const deferTruth = body.deferTruth === true;
        if (body.deferTruth !== undefined && typeof body.deferTruth !== "boolean") {
          throw new DomainValidationError("产品事实审核顺序参数无效");
        }
        if (deferTruth && project.currentProductTruthRef) {
          throw new DomainValidationError("当前项目已有产品事实版本。请先处理原事实和已启动任务，不能跳过版本审核。");
        }
        const productName = requireString(body.productName, "productName");
        const featureDescription = requireString(
          body.featureDescription,
          "featureDescription"
        );
        const uploads = Array.isArray(body.images) ? body.images : [];
        if (!uploads.length) {
          throw new DomainValidationError("至少需要 1 张产品图片");
        }

        const artifactStore = new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        );
        const now = new Date().toISOString();
        const storedDetails: Array<{
          asset: AssetRef;
          artifactId: string;
          relativePath: string;
          sha256: string;
          mimeType?: string;
        }> = [];

        const storeUpload = async (
          raw: unknown,
          type: "image" | "logo"
        ): Promise<AssetRef> => {
          if (!raw || typeof raw !== "object") {
            throw new DomainValidationError("Invalid upload payload");
          }
          const upload = raw as {
            name?: unknown;
            mimeType?: unknown;
            base64?: unknown;
          };
          const name = requireString(upload.name, "upload.name");
          const mimeType = requireString(upload.mimeType, "upload.mimeType");
          if (!mimeType.startsWith("image/")) {
            throw new DomainValidationError(
              type === "logo"
                ? `Logo“${name}”：必须是图片文件`
                : `文件“${name}”：只支持图片文件`
            );
          }
          let bytes: Buffer;
          try {
            const base64 = requireString(upload.base64, "upload.base64");
            bytes = decodeBase64(base64, 10 * 1024 * 1024);
          } catch (error) {
            throw new DomainValidationError(
              type === "logo"
                ? `Logo“${name}”：内容无效或超过 10 MB`
                : `文件“${name}”：内容无效或超过 10 MB`
            );
          }
          const relativePath =
            "input/assets/" + randomUUID() + "-" + safeFileName(name);
          const artifact = await artifactStore.writeImmutable({
            id: randomUUID(),
            projectId,
            kind: "USER_INPUT",
            relativePath,
            immutable: true,
            bytes,
            mimeType
          });
          if (!artifact.sha256 || artifact.sizeBytes === undefined) {
            throw new DomainValidationError(
              type === "logo"
                ? `Logo“${name}”：上传写入失败`
                : `文件“${name}”：上传写入失败`
            );
          }
          const asset: AssetRef = {
            id: randomUUID(),
            artifactId: artifact.id,
            type,
            source: "user_upload",
            originalFilename: name,
            sha256: artifact.sha256,
            mimeType,
            sizeBytes: artifact.sizeBytes,
            provenance: "Product Input",
            createdAt: now
          };
          storedDetails.push({
            asset,
            artifactId: artifact.id,
            relativePath: artifact.relativePath,
            sha256: artifact.sha256,
            mimeType: artifact.mimeType
          });
          return asset;
        };

        const imageAssets: AssetRef[] = [];
        for (const upload of uploads) {
          imageAssets.push(await storeUpload(upload, "image"));
        }
        const logoAsset =
          body.logo && typeof body.logo === "object"
            ? await storeUpload(body.logo, "logo")
            : undefined;

        const allowedFields = new Set([
          "logo",
          "color",
          "shape",
          "packaging",
          "text",
          "model",
          "proportion",
          "other"
        ]);
        const forbiddenChanges: ForbiddenChange[] = [];
        if (Array.isArray(body.forbiddenChanges)) {
          for (const raw of body.forbiddenChanges) {
            if (!raw || typeof raw !== "object") continue;
            const item = raw as {
              field?: unknown;
              description?: unknown;
              severity?: unknown;
            };
            const field = requireString(item.field, "forbiddenChange.field");
            const description = requireString(
              item.description,
              "forbiddenChange.description"
            );
            const severity = requireString(
              item.severity,
              "forbiddenChange.severity"
            );
            if (!allowedFields.has(field)) {
              throw new DomainValidationError("Invalid ForbiddenChange field");
            }
            if (severity !== "HARD" && severity !== "SOFT") {
              throw new DomainValidationError("Invalid ForbiddenChange severity");
            }
            forbiddenChanges.push({
              id: randomUUID(),
              field: field as ForbiddenChange["field"],
              description,
              severity
            });
          }
        }

        const snapshot = await deps.productInput.save({
          projectId,
          productName,
          featureDescription,
          ...(typeof body.brand === "string" && body.brand.trim()
            ? { brand: body.brand.trim() }
            : {}),
          ...(typeof body.category === "string" && body.category.trim()
            ? { category: body.category.trim() }
            : {}),
          assets: [...imageAssets, ...(logoAsset ? [logoAsset] : [])],
          forbiddenChanges
        });

        // New-project user workflow: preserve input first, allow optional research,
        // then generate a truth DRAFT for explicit review. Never auto-confirm facts.
        // Existing projects use the original versioned truth workflow unchanged.
        if (deferTruth) {
          return json(res, 201, {
            project,
            productInput: snapshot,
            pendingTruth: true,
            nextStep: "RESEARCH_OPTIONAL_THEN_TRUTH_REVIEW"
          });
        }
        const truthVersion = await deps.productFlow.nextVersion(
          projectId,
          "ProductTruth",
          "product-truth"
        );
        const truth = await deps.aiGeneration.generateProductTruthDraft(
          {
            projectId,
            productName: snapshot.productName,
            featureDescription: snapshot.featureDescription,
            ...(snapshot.brand ? { brand: snapshot.brand } : {}),
            ...(snapshot.category ? { category: snapshot.category } : {}),
            referenceImageIds: imageAssets.map((asset) => asset.id),
            referenceImageArtifacts: storedDetails
              .filter((item) => item.asset.type === "image")
              .map((item) => ({
                id: item.artifactId,
                relativePath: item.relativePath,
                sha256: item.sha256,
                ...(item.mimeType ? { mimeType: item.mimeType } : {})
              })),
            ...(logoAsset ? { logoAssetId: logoAsset.id } : {}),
            forbiddenChanges
          },
          truthVersion
        );
        const updatedProject = await deps.productFlow.saveProductTruthDraft(truth);
        return json(res, 201, {
          project: updatedProject,
          productInput: snapshot,
          productTruth: truth
        });
      }

      const truthMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/truth\/confirm$/);
      if (req.method === "POST" && truthMatch) {
        const projectId = truthMatch[1]!;
        const body = (await readJson(req)) as {
          projectId?: unknown;
          dispositions?: unknown;
          usageRuleDispositions?: unknown;
        };
        assertProjectBody(truthMatch[1]!, body);
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productTruth) {
          throw new DomainValidationError("当前没有可确认的产品事实");
        }
        if (workspace.productTruth.status === "DRAFT") {
          if (!body.dispositions || typeof body.dispositions !== "object") {
            throw new DomainValidationError("UncertainClaim dispositions are required");
          }
          const [productInput, projectArtifacts] = await Promise.all([
            deps.productInput.latest(projectId),
            deps.artifacts.listByProject(projectId)
          ]);
          if (!productInput) {
            throw new DomainValidationError(
              "Saved Product Input is required before Product Truth confirmation"
            );
          }
          assertCanonicalProductArtifactReady(
            workspace.productTruth,
            productInput.assets,
            projectArtifacts
          );
          const confirmed = confirmProductTruthDraft(
            workspace.productTruth,
            body.dispositions as Record<string, ClaimDisposition>,
            new Date(),
            body.usageRuleDispositions &&
            typeof body.usageRuleDispositions === "object"
              ? (body.usageRuleDispositions as Record<
                  string,
                  UsageRuleDisposition
                >)
              : {}
          );
          const project = await deps.productFlow.confirmProductTruth(confirmed);
          return json(res, 200, { project, productTruth: confirmed });
        }
        return json(res, 200, {
          project: await deps.productFlow.confirmProductTruth(body as ProductTruth)
        });
      }

      const truthGenerateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/truth\/generate-from-input$/
      );
      if (req.method === "POST" && truthGenerateMatch) {
        const projectId = truthGenerateMatch[1]!;
        const snapshot = await deps.productInput.latest(projectId);
        if (!snapshot) {
          throw new DomainValidationError("No saved Product Input to retry");
        }
        const imageAssets = snapshot.assets.filter((asset) => asset.type === "image");
        const logoAsset = snapshot.assets.find((asset) => asset.type === "logo");
        const artifactDetails = [];
        for (const asset of imageAssets) {
          const artifact = await deps.artifacts.findById(asset.artifactId);
          if (!artifact || artifact.integrityStatus !== "READY" || !artifact.sha256) {
            throw new DomainValidationError(
              `Input artifact is not READY: ${asset.artifactId}`
            );
          }
          artifactDetails.push({
            id: artifact.id,
            relativePath: artifact.relativePath,
            sha256: artifact.sha256,
            ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
          });
        }
        const version = await deps.productFlow.nextVersion(
          projectId,
          "ProductTruth",
          "product-truth"
        );
        const truth = await deps.aiGeneration.generateProductTruthDraft(
          {
            projectId,
            productName: snapshot.productName,
            featureDescription: snapshot.featureDescription,
            ...(snapshot.brand ? { brand: snapshot.brand } : {}),
            ...(snapshot.category ? { category: snapshot.category } : {}),
            referenceImageIds: imageAssets.map((asset) => asset.id),
            referenceImageArtifacts: artifactDetails,
            ...(logoAsset ? { logoAssetId: logoAsset.id } : {}),
            forbiddenChanges: snapshot.forbiddenChanges
          },
          version
        );
        const project = await deps.productFlow.saveProductTruthDraft(truth);
        return json(res, 201, { project, productTruth: truth });
      }

      const creativeGenerateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/creative\/generate$/
      );
      if (req.method === "POST" && creativeGenerateMatch) {
        const projectId = creativeGenerateMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productTruth || workspace.productTruth.status !== "CONFIRMED") {
          throw new DomainValidationError("需要先确认当前产品事实");
        }
        const version = await deps.productFlow.nextVersion(
          projectId,
          "CreativeBatch",
          "creative-batch"
        );
        const referenceVideoProfile =
          await deps.referenceVideo.latest(projectId);
        const batch = await deps.aiGeneration.generateCreativeBatch(
          workspace.productTruth,
          version,
          workspace.project.targetDurationMs,
          referenceVideoProfile
        );
        const project = await deps.productFlow.activateCreativeBatch(batch);
        return json(res, 201, { project, creativeBatch: batch });
      }

      const creativeBatchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/creative-batches$/);
      if (req.method === "POST" && creativeBatchMatch) {
        const body = await readJson(req);
        assertProjectBody(creativeBatchMatch[1]!, body);
        return json(res, 200, {
          project: await deps.productFlow.activateCreativeBatch(body as CreativeBatch)
        });
      }

      const creativeSelectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/creative\/select$/);
      if (req.method === "POST" && creativeSelectMatch) {
        const projectId = creativeSelectMatch[1]!;
        const body = (await readJson(req)) as { creativeId?: unknown };
        if (typeof body.creativeId !== "string" || !body.creativeId.trim()) {
          throw new DomainValidationError("creativeId is required");
        }
        let project = await deps.productFlow.selectCreative(projectId, body.creativeId);
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productTruth || !workspace.creativeBatch) {
          throw new DomainValidationError("需要当前产品事实和创意方案");
        }
        const version = await deps.productFlow.nextVersion(
          projectId,
          "ScriptDraft",
          "script"
        );
        const referenceVideoProfile =
          await deps.referenceVideo.latest(projectId);
        const script = await deps.aiGeneration.generateScriptDraft({
          truth: workspace.productTruth,
          batch: workspace.creativeBatch,
          selectedCreativeId: body.creativeId,
          version,
          targetDurationMs: workspace.project.targetDurationMs,
          referenceVideoProfile
        });
        project = await deps.productFlow.saveScriptDraft(script);
        return json(res, 200, { project, script });
      }

      const scriptMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/script\/confirm$/);
      if (req.method === "POST" && scriptMatch) {
        const projectId = scriptMatch[1]!;
        const body = (await readJson(req)) as {
          projectId?: unknown;
          confirmCurrent?: unknown;
          generationSettings?: unknown;
        };
        assertProjectBody(projectId, body);
        if (body.confirmCurrent === true) {
          const workspace = await deps.productFlow.getWorkspace(projectId);
          if (
            !workspace?.productTruth ||
            !workspace.creativeBatch ||
            !workspace.script
          ) {
            throw new DomainValidationError("需要当前产品事实、创意方案和脚本");
          }
          await deps.aiGeneration.assertScriptUsageCompliance(
            workspace.productTruth,
            workspace.script
          );
          const confirmedScript = confirmScriptDraft(workspace.script);
          const generationTarget = body.generationSettings === undefined ? undefined
            : resolveDirectorGenerationTarget(await deps.dreaminaCapability.registry(), directorGenerationSettingsSchema.parse(body.generationSettings));
          let project = await deps.productFlow.confirmScript(confirmedScript);
          // Confirm the script first; new plans require a model selected before directing.
          if (!generationTarget) return json(res, 200, { project, script: confirmedScript });
          const planVersion = await deps.productFlow.nextVersion(
            projectId,
            "ProductionPlan",
            "production-plan"
          );
          const referenceVideoProfile =
            await deps.referenceVideo.latest(projectId);
          const plan = await deps.productDirector.generate({
            productTruth: workspace.productTruth,
            creativeBatch: workspace.creativeBatch,
            selectedCreativeId: confirmedScript.selectedCreativeId,
            script: confirmedScript,
            generationTarget,
            referenceVideoProfile,
            projectTargetDurationMs: workspace.project.targetDurationMs,
            productionPlanVersion: planVersion
          });
          project = await deps.productFlow.saveProductionPlanDraft(plan);
          return json(res, 200, { project, script: confirmedScript, productionPlan: plan });
        }
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productTruth) {
          throw new DomainValidationError("需要当前产品事实");
        }
        const manualScript = body as ScriptDraft;
        await deps.aiGeneration.assertScriptUsageCompliance(
          workspace.productTruth,
          manualScript
        );
        return json(res, 200, {
          project: await deps.productFlow.confirmScript(manualScript)
        });
      }

      const scriptGenerateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/script\/generate$/
      );
      if (req.method === "POST" && scriptGenerateMatch) {
        const projectId = scriptGenerateMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (
          !workspace?.productTruth ||
          !workspace.creativeBatch ||
          !workspace.project.selectedCreativeId
        ) {
          throw new DomainValidationError(
            "Current ProductTruth, CreativeBatch and selected creative are required"
          );
        }
        const version = await deps.productFlow.nextVersion(
          projectId,
          "ScriptDraft",
          "script"
        );
        const referenceVideoProfile =
          await deps.referenceVideo.latest(projectId);
        const script = await deps.aiGeneration.generateScriptDraft({
          truth: workspace.productTruth,
          batch: workspace.creativeBatch,
          selectedCreativeId: workspace.project.selectedCreativeId,
          version,
          targetDurationMs: workspace.project.targetDurationMs,
          referenceVideoProfile
        });
        const project = await deps.productFlow.saveScriptDraft(script);
        return json(res, 201, { project, script });
      }

      const scriptReviseMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/script\/revise$/
      );
      if (req.method === "POST" && scriptReviseMatch) {
        const projectId = scriptReviseMatch[1]!;
        const body = (await readJson(req)) as { beats?: unknown };
        if (!Array.isArray(body.beats) || !body.beats.length) {
          throw new DomainValidationError("修改脚本时至少需要一个脚本段落");
        }
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.script) {
          throw new DomainValidationError("当前没有可修改的脚本草稿");
        }
        const beats = body.beats.map((raw, index) => {
          if (!raw || typeof raw !== "object") {
            throw new DomainValidationError(`Invalid ScriptBeat at index ${index}`);
          }
          const item = raw as Record<string, unknown>;
          const purpose = requireString(item.purpose, "beat.purpose");
          const text = requireString(item.text, "beat.text");
          if (
            typeof item.estimatedDurationMs !== "number" ||
            !Number.isInteger(item.estimatedDurationMs)
          ) {
            throw new DomainValidationError(
              "beat.estimatedDurationMs must be an integer"
            );
          }
          if (!Array.isArray(item.requiredFactIds)) {
            throw new DomainValidationError("beat.requiredFactIds must be an array");
          }
          return {
            ...(typeof item.id === "string" && item.id.trim()
              ? { id: item.id.trim() }
              : {}),
            purpose,
            text,
            estimatedDurationMs: item.estimatedDurationMs,
            ...(item.videoIntent !== undefined ? { videoIntent: item.videoIntent } : {}),
            requiredFactIds: item.requiredFactIds.map((factId) =>
              requireString(factId, "beat.requiredFactId")
            )
          } as ScriptBeatRevision;
        });
        const revised = reviseScriptDraft(workspace.script, beats);
        const project = await deps.productFlow.saveScriptDraft(revised);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, { project, script: revised });
      }

      const planGenerateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/production-plan\/generate$/
      );
      if (req.method === "POST" && planGenerateMatch) {
        const projectId = planGenerateMatch[1]!;
        const body = await readJson(req) as { generationSettings?: unknown };
        if (!body || typeof body !== "object" || body.generationSettings === undefined) {
          throw new DomainValidationError("请先选择导演目标模型、画幅、分辨率和声音策略，再生成分镜");
        }
        const generationSettings = directorGenerationSettingsSchema.parse(body.generationSettings);
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (
          !workspace?.productTruth ||
          !workspace.creativeBatch ||
          !workspace.script ||
          workspace.script.status !== "CONFIRMED" ||
          !workspace.project.selectedCreativeId
        ) {
          throw new DomainValidationError(
            "Confirmed ProductTruth/Script and current CreativeBatch selection are required"
          );
        }
        const generationTarget = resolveDirectorGenerationTarget(await deps.dreaminaCapability.registry(), generationSettings);
        const planVersion = await deps.productFlow.nextVersion(
          projectId,
          "ProductionPlan",
          "production-plan"
        );
        const referenceVideoProfile =
          await deps.referenceVideo.latest(projectId);
        const plan = await deps.productDirector.generate({
          productTruth: workspace.productTruth,
          creativeBatch: workspace.creativeBatch,
          selectedCreativeId: workspace.project.selectedCreativeId,
          script: workspace.script,
          referenceVideoProfile,
          generationTarget,
          projectTargetDurationMs: workspace.project.targetDurationMs,
          productionPlanVersion: planVersion
        });
        const project = await deps.productFlow.saveProductionPlanDraft(plan);
        return json(res, 201, { project, productionPlan: plan });
      }

      const planReviseMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/production-plan\/revise$/
      );
      if (req.method === "POST" && planReviseMatch) {
        const projectId = planReviseMatch[1]!;
        const body = (await readJson(req)) as {
          visualDirection?: unknown;
          soundDirection?: unknown;
          productShowcaseRules?: unknown;
          clips?: unknown;
          segments?: unknown;
        };
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productionPlan) {
          throw new DomainValidationError(
            "No current ProductionPlan to revise"
          );
        }
        if (!Array.isArray(body.segments)) {
          throw new DomainValidationError(
            "ProductionPlan revision requires segments array"
          );
        }
        const segmentPatches = body.segments.map((raw, index) => {
          if (!raw || typeof raw !== "object") {
            throw new DomainValidationError(
              `Invalid Segment revision at index ${index}`
            );
          }
          const item = raw as Record<string, unknown>;
          return {
            ...item,
            id: requireString(item.id, "segment.id")
          } as ProductionPlanSegmentRevision;
        });
        const clipPatches = Array.isArray(body.clips)
          ? body.clips.map((raw, index) => {
              if (!raw || typeof raw !== "object") {
                throw new DomainValidationError(
                  `Invalid Clip revision at index ${index}`
                );
              }
              const item = raw as Record<string, unknown>;
              return {
                id: requireString(item.id, "clip.id"),
                ...(typeof item.durationMs === "number"
                  ? { durationMs: item.durationMs }
                  : {})
              } as ProductionPlanClipRevision;
            })
          : [];
        const revised = reviseProductionPlanDraft(workspace.productionPlan, {
          ...(typeof body.visualDirection === "string"
            ? { visualDirection: body.visualDirection }
            : {}),
          ...(typeof body.soundDirection === "string"
            ? { soundDirection: body.soundDirection }
            : {}),
          ...(Array.isArray(body.productShowcaseRules)
            ? {
                productShowcaseRules: body.productShowcaseRules.map((item) =>
                  requireString(item, "productShowcaseRule")
                )
              }
            : {}),
          clips: clipPatches,
          segments: segmentPatches
        });
        const project = await deps.productFlow.saveProductionPlanDraft(revised);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, { project, productionPlan: revised });
      }

      const planMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/production-plan\/confirm$/);
      if (req.method === "POST" && planMatch) {
        const projectId = planMatch[1]!;
        const body = (await readJson(req)) as {
          projectId?: unknown;
          confirmCurrent?: unknown;
        };
        assertProjectBody(projectId, body);
        if (body.confirmCurrent === true) {
          const workspace = await deps.productFlow.getWorkspace(projectId);
          if (!workspace?.productTruth || !workspace.productionPlan) {
            throw new DomainValidationError("当前没有可确认的产品事实或导演方案");
          }
          await deps.productDirector.assertPlanUsageCompliance(
            workspace.productTruth,
            workspace.productionPlan
          );
          const confirmedPlan = confirmProductionPlanDraft(workspace.productionPlan);
          const project = await deps.productFlow.confirmProductionPlan(confirmedPlan);
          return json(res, 200, { project, productionPlan: confirmedPlan });
        }
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace?.productTruth) {
          throw new DomainValidationError("需要当前产品事实");
        }
        const manualPlan = body as ProductionPlan;
        await deps.productDirector.assertPlanUsageCompliance(
          workspace.productTruth,
          manualPlan
        );
        return json(res, 200, {
          project: await deps.productFlow.confirmProductionPlan(manualPlan)
        });
      }

      const preflightRunMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/preflight\/run$/
      );
      if (req.method === "POST" && preflightRunMatch) {
        const projectId = preflightRunMatch[1]!;
        const body = (await readJson(req)) as {
          clipIds?: unknown;
          acceptedDuplicateSubmissionRisk?: unknown;
          generationSettings?: unknown;
        };
        const clipIds = Array.isArray(body.clipIds)
          ? body.clipIds.map((item) => requireString(item, "clipId"))
          : undefined;
        let generationSettings:
          | {
              requestedModelVersion: string;
              aspectRatio: string;
              videoResolution: string;
              nativeAudioOutputRequested: boolean;
            }
          | undefined;
        if (body.generationSettings !== undefined) {
          if (
            !body.generationSettings ||
            typeof body.generationSettings !== "object"
          ) {
            throw new DomainValidationError("生成参数格式无效");
          }
          const raw = body.generationSettings as {
            requestedModelVersion?: unknown;
            aspectRatio?: unknown;
            videoResolution?: unknown;
            nativeAudioOutputRequested?: unknown;
          };
          generationSettings = {
            requestedModelVersion: requireString(
              raw.requestedModelVersion,
              "generationSettings.requestedModelVersion"
            ),
            aspectRatio: requireString(
              raw.aspectRatio,
              "generationSettings.aspectRatio"
            ),
            videoResolution: requireString(
              raw.videoResolution,
              "generationSettings.videoResolution"
            ),
            nativeAudioOutputRequested:
              raw.nativeAudioOutputRequested === true
          };
        }
        const [workspace, productInput] = await Promise.all([
          deps.productFlow.getWorkspace(projectId),
          deps.productInput.latest(projectId)
        ]);
        if (
          !workspace?.productTruth ||
          !workspace.creativeBatch ||
          !workspace.script ||
          !workspace.productionPlan
        ) {
          throw new DomainValidationError(
            "Current ProductTruth, CreativeBatch, Script and ProductionPlan are required"
          );
        }
        if (
          workspace.productTruth.status !== "CONFIRMED" ||
          workspace.script.status !== "CONFIRMED" ||
          workspace.productionPlan.status !== "CONFIRMED"
        ) {
          throw new DomainValidationError(
            "ProductTruth, Script and ProductionPlan must be CONFIRMED"
          );
        }
        if (!productInput) {
          throw new DomainValidationError("Saved Product Input is required");
        }

        const selectedClips = workspace.productionPlan.scenes
          .flatMap((scene) => scene.clips)
          .filter((clip) => !clipIds?.length || clipIds.includes(clip.id));
        if (!selectedClips.length || (clipIds?.length && selectedClips.length !== new Set(clipIds).size)) {
          throw new DomainValidationError("选择的镜头已经改变或不存在，请刷新页面重新选择");
        }
        const referencedAssetIds = selectedClips.flatMap(clip => clip.referenceAssets.map(ref => ref.assetId));
        const smartRuns = await deps.smartGeneration?.list(projectId) ?? [];
        const savedRun = findProductionRunForPlan(projectId, workspace.productionPlan, smartRuns);
        const assetSet = savedRun?.productionAssetSet;
        assertProductionAssetBinding(projectId, assetSet, referencedAssetIds);
        if (referencedAssetIds.some(id => id.startsWith("production-asset:")) && !deps.productionAssets) {
          throw new DomainValidationError("当前程序没有制作资产读取服务，无法安全重新检查该镜头");
        }
        const generatedAssets = assetSet?.status === "READY" && deps.productionAssets
          ? await deps.productionAssets.toAssetRefs(assetSet, new Set(referencedAssetIds))
          : [];
        const referenceSet = await deps.creativeReferences?.assertExpected(
          projectId, workspace.productionPlan.creativeReferenceSetRef
        ) ?? null;
        const confirmedReferences = [
          ...CreativeReferenceService.assets(referenceSet),
          ...generatedAssets
        ];
        const knownAssets = [...productInput.assets, ...confirmedReferences];
        if (savedRun?.options.directorVersion === 3 && (
          !savedRun.directorV3Plan ||
          selectedClips.some(clip => !savedRun.seedancePromptDrafts?.some(draft => draft.clipId === clip.id))
        )) {
          throw new DomainValidationError("Director V3 镜头合同或最终提示词不完整，请返回原智能生成任务检查后重试");
        }
        const requiredReferenceAssetIds = selectedClips
          .flatMap((clip) => clip.referenceAssets)
          .filter(
            (usage) =>
              usage.required ||
              knownAssets.some((asset) => asset.id === usage.assetId)
          )
          .map((usage) => usage.assetId);
        const referenceImageValidation =
          await validateReferenceImagesForPreflight({
            projectsRoot: deps.projectsRoot,
            projectId,
            snapshot: productInput,
            confirmedReferenceAssets: confirmedReferences,
            artifacts: deps.artifacts,
            requiredAssetIds: requiredReferenceAssetIds
          });

        // Page rendering may probe the provider for display. Preflight evidence
        // must contain only commands executed by this explicit run.
        deps.provider.drainCommandEvidence();
        const result = await deps.preflight.run({
          projectId,
          productTruth: workspace.productTruth,
          creativeBatch: workspace.creativeBatch,
          script: workspace.script,
          productionPlan: workspace.productionPlan,
          assets: [...productInput.assets, ...generatedAssets],
          ...(assetSet?.status === "READY" ? { productionAssetSet: assetSet } : {}),
          ...(savedRun?.options.directorVersion === 3 && savedRun.directorV3Plan
            ? { directorV3Plan: savedRun.directorV3Plan,
                promptV3Overrides: Object.fromEntries(
                  (savedRun.seedancePromptDrafts ?? []).map(draft => [draft.clipId, draft.promptText])
                ) }
            : {}),
          ...(clipIds?.length ? { clipIds } : {}),
          inputBlockers: referenceImageValidation.blockers,
          ...(generationSettings ?? savedRun?.options.generationSettings
            ? { generationSettings: generationSettings ?? savedRun?.options.generationSettings }
            : {}),
          acceptedDuplicateSubmissionRisk:
            body.acceptedDuplicateSubmissionRisk === true
        });

        const providerAudit = await persistPreflightProviderAudit(
          deps,
          projectId,
          result.probe
        );

        const probeBytes = Buffer.from(
          JSON.stringify(
            {
              projectId,
              probedAt: new Date().toISOString(),
              probe: result.probe
            },
            null,
            2
          ) + "\n",
          "utf8"
        );
        const probeArtifact = await new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        ).writeImmutable({
          id: randomUUID(),
          projectId,
          kind: "PROVIDER_PROBE",
          relativePath:
            "provider/probe-" +
            Date.now() +
            "-" +
            result.probe.capabilityFingerprint.slice(0, 12) +
            ".json",
          immutable: true,
          bytes: probeBytes,
          mimeType: "application/json"
        });

        await deps.providerAudit.saveCapability(projectId, {
          provider: "domestic-jimeng-cli",
          ...(providerAudit.providerIdentityId
            ? { providerIdentityId: providerAudit.providerIdentityId }
            : {}),
          cliFound: result.probe.cliFound,
          authenticated: result.authenticated,
          supportedOperations:
            result.probe.code === "READY"
              ? result.probe.supportedOperations
              : [],
          supportedModels:
            result.probe.code === "READY"
              ? result.probe.supportedModels
              : [],
          ...(result.probe.code === "READY" &&
          result.probe.supportedDurationsMs
            ? { supportedDurationsMs: result.probe.supportedDurationsMs }
            : {}),
          rawProbeArtifactId: probeArtifact.id,
          capabilityFingerprint: result.probe.capabilityFingerprint,
          probedAt: new Date().toISOString()
        });
        await refreshProjectSnapshot(deps, projectId);

        return json(res, 200, {
          overallStatus: result.overallStatus,
          requestCount: result.requests.length,
          preflightCount: result.reports.length,
          probe: result.probe,
          blocker: result.blocker,
          reports: result.reports,
          referenceImageValidation,
          probeArtifact,
          providerAudit
        });
      }

      const approvalMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/approval$/
      );
      if (req.method === "POST" && approvalMatch) {
        const projectId = approvalMatch[1]!;
        const body = (await readJson(req)) as {
          acceptedUnknownCostRisk?: unknown;
          acceptedDuplicateSubmissionRisk?: unknown;
        };
        const result = await deps.approval.approveCurrentRequests({
          projectId,
          acceptedUnknownCostRisk: body.acceptedUnknownCostRisk === true,
          acceptedDuplicateSubmissionRisk:
            body.acceptedDuplicateSubmissionRisk === true
        });
        await deps.productFlow.setProjectStatus(projectId, "GENERATING");
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, result);
      }

      const attemptActionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/attempts\/([^/]+)\/(submit|poll|download|reconcile)$/
      );
      if (req.method === "POST" && attemptActionMatch) {
        const projectId = attemptActionMatch[1]!;
        const attemptId = attemptActionMatch[2]!;
        const action = attemptActionMatch[3]!;
        const attempt = await deps.workflow.getGenerationAttempt(attemptId);
        if (!attempt || attempt.projectId !== projectId) {
          return json(res, 404, { error: "ATTEMPT_NOT_FOUND" });
        }
        const updated =
          action === "submit"
            ? await deps.execution.submitAttempt(attemptId)
            : action === "poll"
              ? await deps.execution.pollAttempt(attemptId)
              : action === "download"
                ? await deps.execution.downloadAttempt(attemptId)
                : await deps.execution.reconcileAttempt(attemptId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { attempt: updated });
      }

      const visualCompareMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/clips\/([^/]+)\/visual-compare$/
      );
      if (req.method === "POST" && visualCompareMatch) {
        const projectId = visualCompareMatch[1]!;
        const clipId = visualCompareMatch[2]!;
        if (!deps.visualEditAssessment) {
          return json(res, 503, {
            error: "VISUAL_EDIT_NOT_CONFIGURED",
            message: "视觉审片 / 智能剪辑服务尚未配置"
          });
        }
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (
          !workspace?.productTruth ||
          workspace.productTruth.status !== "CONFIRMED" ||
          !workspace.productionPlan ||
          workspace.productionPlan.status !== "CONFIRMED"
        ) {
          throw new DomainValidationError(
            "多版本视觉比较需要已确认的产品事实和当前导演分镜"
          );
        }
        const clip = workspace.productionPlan.scenes
          .flatMap(scene => scene.clips)
          .find(item => item.id === clipId);
        if (!clip) {
          throw new DomainValidationError("当前导演方案中找不到该镜头");
        }
        const comparable = (await deps.workflow.listGenerationAttempts(projectId))
          .filter(
            attempt =>
              attempt.clipId === clipId &&
              ["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(attempt.status) &&
              Boolean(attempt.outputArtifactId)
          )
          .sort((a, b) => b.attemptNumber - a.attemptNumber)
          .slice(0, 6)
          .map(attempt => ({
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            outputArtifactId: attempt.outputArtifactId!
          }));
        if (comparable.length < 2) {
          throw new DomainValidationError(
            "当前镜头至少需要两个成功并已下载的视频版本才能进行 AI 多版本比较"
          );
        }
        const comparison = await deps.visualEditAssessment.compareVersions({
          projectId,
          truth: workspace.productTruth,
          clip,
          attempts: comparable
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { comparison });
      }

      const reviewMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/clips\/([^/]+)\/review$/
      );
      if (req.method === "POST" && reviewMatch) {
        const projectId = reviewMatch[1]!;
        const clipId = reviewMatch[2]!;
        const body = (await readJson(req)) as {
          generationAttemptId?: unknown;
          decision?: unknown;
          note?: unknown;
        };
        const decision = requireString(body.decision, "decision");
        if (
          decision !== "ACCEPT" &&
          decision !== "REDO" &&
          decision !== "SKIP" &&
          decision !== "USE"
        ) {
          throw new DomainValidationError(
            "decision must be ACCEPT, REDO, SKIP or USE"
          );
        }
        const generationAttemptId =
          decision === "ACCEPT" || decision === "REDO"
            ? requireString(body.generationAttemptId, "generationAttemptId")
            : undefined;
        const result = await deps.reviewService.decide({
          projectId,
          clipId,
          ...(generationAttemptId ? { generationAttemptId } : {}),
          decision,
          ...(typeof body.note === "string" && body.note.trim()
            ? { note: body.note.trim() }
            : {})
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, result);
      }

      const finalizeSelectionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/review\/finalize-selection$/
      );
      if (req.method === "POST" && finalizeSelectionMatch) {
        const projectId = finalizeSelectionMatch[1]!;
        const result = await deps.reviewService.finalizeUsingAcceptedClips({
          projectId
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, result);
      }

      const timelineGetMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline$/
      );
      if (req.method === "GET" && timelineGetMatch) {
        const projectId = timelineGetMatch[1]!;
        const timeline = await deps.timeline.getOrCreate(projectId);
        const renderJob = await deps.timeline.latestRenderJob(projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline),
          ...(renderJob ? { renderJob } : {})
        });
      }

      const timelineResetMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/reset$/
      );
      if (req.method === "POST" && timelineResetMatch) {
        const projectId = timelineResetMatch[1]!;
        const timeline = await deps.timeline.resetFromAccepted(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineReorderMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/reorder$/
      );
      if (req.method === "POST" && timelineReorderMatch) {
        const projectId = timelineReorderMatch[1]!;
        const body = (await readJson(req)) as {
          orderedClipEditIds?: unknown;
        };
        if (
          !Array.isArray(body.orderedClipEditIds) ||
          body.orderedClipEditIds.some(
            (item) => typeof item !== "string" || !item.trim()
          )
        ) {
          throw new DomainValidationError(
            "orderedClipEditIds must be an array of clip edit ids"
          );
        }
        const timeline = await deps.timeline.reorder(
          projectId,
          body.orderedClipEditIds as string[]
        );
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineClipMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/clips\/([^/]+)$/
      );
      if (req.method === "POST" && timelineClipMatch) {
        const projectId = timelineClipMatch[1]!;
        const clipEditId = timelineClipMatch[2]!;
        const body = (await readJson(req)) as Record<string, unknown>;
        const transitionType =
          body.transitionType === undefined
            ? undefined
            : body.transitionType === "CUT" ||
                body.transitionType === "CROSSFADE" ||
                body.transitionType === "FADE"
              ? body.transitionType
              : (() => {
                  throw new DomainValidationError(
                    "transitionType must be CUT, CROSSFADE or FADE"
                  );
                })();
        if (
          body.deleted !== undefined &&
          typeof body.deleted !== "boolean"
        ) {
          throw new DomainValidationError("deleted must be boolean");
        }
        if (body.muted !== undefined && typeof body.muted !== "boolean") {
          throw new DomainValidationError("muted must be boolean");
        }
        const timeline = await deps.timeline.updateClip(projectId, clipEditId, {
          ...(optionalNumber(body.inMs, "inMs") !== undefined
            ? { inMs: optionalNumber(body.inMs, "inMs") }
            : {}),
          ...(optionalNumber(body.outMs, "outMs") !== undefined
            ? { outMs: optionalNumber(body.outMs, "outMs") }
            : {}),
          ...(body.deleted !== undefined
            ? { deleted: body.deleted as boolean }
            : {}),
          ...(optionalNumber(body.volume, "volume") !== undefined
            ? { volume: optionalNumber(body.volume, "volume") }
            : {}),
          ...(body.muted !== undefined ? { muted: body.muted as boolean } : {}),
          ...(transitionType ? { transitionType } : {}),
          ...(optionalNumber(
            body.transitionDurationMs,
            "transitionDurationMs"
          ) !== undefined
            ? {
                transitionDurationMs: optionalNumber(
                  body.transitionDurationMs,
                  "transitionDurationMs"
                )
              }
            : {})
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineTextMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/text$/
      );
      if (req.method === "POST" && timelineTextMatch) {
        const projectId = timelineTextMatch[1]!;
        const body = (await readJson(req)) as Record<string, unknown>;
        const kind =
          body.kind === "CAPTION" || body.kind === "CTA"
            ? body.kind
            : (() => {
                throw new DomainValidationError(
                  "kind must be CAPTION or CTA"
                );
              })();
        const position =
          body.position === undefined
            ? undefined
            : body.position === "TOP" ||
                body.position === "CENTER" ||
                body.position === "BOTTOM"
              ? body.position
              : (() => {
                  throw new DomainValidationError(
                    "position must be TOP, CENTER or BOTTOM"
                  );
                })();
        const startMs = optionalNumber(body.startMs, "startMs");
        const endMs = optionalNumber(body.endMs, "endMs");
        if (startMs === undefined || endMs === undefined) {
          throw new DomainValidationError("startMs and endMs are required");
        }
        const timeline = await deps.timeline.addTextItem(projectId, {
          kind,
          text: requireString(body.text, "text"),
          startMs,
          endMs,
          ...(position ? { position } : {}),
          ...(optionalNumber(body.fontScale, "fontScale") !== undefined
            ? { fontScale: optionalNumber(body.fontScale, "fontScale") }
            : {})
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineTextDeleteMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/text\/([^/]+)\/delete$/
      );
      if (req.method === "POST" && timelineTextDeleteMatch) {
        const projectId = timelineTextDeleteMatch[1]!;
        const timeline = await deps.timeline.removeTextItem(
          projectId,
          timelineTextDeleteMatch[2]!
        );
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineBgmMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/bgm$/
      );
      if (req.method === "POST" && timelineBgmMatch) {
        const projectId = timelineBgmMatch[1]!;
        const body = (await readJson(req, 90 * 1024 * 1024)) as {
          artifactId?: unknown;
          audio?: unknown;
          startMs?: unknown;
          inMs?: unknown;
          outMs?: unknown;
          volume?: unknown;
        };
        let artifactId =
          typeof body.artifactId === "string" && body.artifactId.trim()
            ? body.artifactId.trim()
            : undefined;
        if (!artifactId) {
          if (!body.audio || typeof body.audio !== "object") {
            throw new DomainValidationError(
              "BGM requires artifactId or audio upload"
            );
          }
          const upload = body.audio as {
            name?: unknown;
            mimeType?: unknown;
            base64?: unknown;
          };
          const name = requireString(upload.name, "audio.name");
          const mimeType = requireString(upload.mimeType, "audio.mimeType");
          if (!mimeType.startsWith("audio/")) {
            throw new DomainValidationError("BGM upload must be audio");
          }
          const bytes = decodeBase64(
            requireString(upload.base64, "audio.base64"),
            80 * 1024 * 1024
          );
          const store = new LocalArtifactStore(
            path.join(deps.projectsRoot, projectId),
            deps.artifacts
          );
          const artifact = await store.writeImmutable({
            id: randomUUID(),
            projectId,
            kind: "USER_INPUT",
            relativePath:
              "timeline/bgm/" + randomUUID() + "-" + safeFileName(name),
            immutable: true,
            bytes,
            mimeType
          });
          if (!artifact.sha256) {
            throw new DomainValidationError(
              "BGM Artifact did not become READY"
            );
          }
          artifactId = artifact.id;
        }
        const timeline = await deps.timeline.setBgm({
          projectId,
          artifactId,
          ...(optionalNumber(body.startMs, "startMs") !== undefined
            ? { startMs: optionalNumber(body.startMs, "startMs") }
            : {}),
          ...(optionalNumber(body.inMs, "inMs") !== undefined
            ? { inMs: optionalNumber(body.inMs, "inMs") }
            : {}),
          ...(optionalNumber(body.outMs, "outMs") !== undefined
            ? { outMs: optionalNumber(body.outMs, "outMs") }
            : {}),
          ...(optionalNumber(body.volume, "volume") !== undefined
            ? { volume: optionalNumber(body.volume, "volume") }
            : {})
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineBgmRemoveMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/bgm\/remove$/
      );
      if (req.method === "POST" && timelineBgmRemoveMatch) {
        const projectId = timelineBgmRemoveMatch[1]!;
        const timeline = await deps.timeline.removeBgm(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline)
        });
      }

      const timelineConfirmMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/timeline\/confirm$/
      );
      if (req.method === "POST" && timelineConfirmMatch) {
        const projectId = timelineConfirmMatch[1]!;
        const timeline = await deps.timeline.confirm(projectId);
        const renderJob = await deps.timeline.latestRenderJob(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, {
          timeline,
          durationMs: timelineDurationMs(timeline),
          ...(renderJob ? { renderJob } : {})
        });
      }

      const finalRenderMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/final\/render$/
      );
      if (req.method === "POST" && finalRenderMatch) {
        const projectId = finalRenderMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        const latestTimeline = await deps.timeline.latestTimeline(projectId);
        if (workspace?.productionPlan || latestTimeline) {
          const timeline =
            latestTimeline ?? (await deps.timeline.getOrCreate(projectId));
          if (timeline.status !== "CONFIRMED") {
            throw new DomainValidationError(
              "请先在 Timeline 页面确认剪辑，再生成最终成片"
            );
          }
          const result = await deps.renderEngine.render(projectId);
          await refreshProjectSnapshot(deps, projectId);
          return json(res, 201, result);
        }
        const assembly = await deps.finalAssembly.render(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, { assembly });
      }

      const finalAcceptMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/final\/accept$/
      );
      if (req.method === "POST" && finalAcceptMatch) {
        const projectId = finalAcceptMatch[1]!;
        const qc = await deps.finalQc.assertPublishable(projectId);
        const assembly = await deps.finalAssembly.accept(projectId);
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { assembly, qc });
      }

      const finalQcMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/final\/qc$/
      );
      if (req.method === "GET" && finalQcMatch) {
        const projectId = finalQcMatch[1]!;
        return json(res, 200, {
          report: await deps.finalQc.latest(projectId)
        });
      }
      if (req.method === "POST" && finalQcMatch) {
        const projectId = finalQcMatch[1]!;
        const report = await deps.finalQc.run(projectId);
        return json(res, 200, { report });
      }

      const publishProvidersMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/providers$/
      );
      if (req.method === "GET" && publishProvidersMatch) {
        const projectId = publishProvidersMatch[1]!;
        return json(
          res,
          200,
          await deps.publishBridge.providerStatus(projectId)
        );
      }

      const douyinBrowserAccountMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/douyin-browser\/account$/
      );
      if (req.method === "GET" && douyinBrowserAccountMatch) {
        const projectId = douyinBrowserAccountMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          throw new DomainValidationError("Project not found");
        }
        if (!deps.douyinBrowserRuntime) {
          throw new DomainValidationError(
            "抖音浏览器发布引擎尚未配置"
          );
        }
        const accountName =
          await deps.douyinBrowserRuntime.resolveAccountName();
        const account =
          await deps.douyinBrowserRuntime.check(accountName);
        return json(res, 200, {
          account: {
            valid: account.valid,
            status: account.status,
            ...(account.displayName
              ? { displayName: account.displayName }
              : {}),
            ...(account.platformUserId
              ? { platformUserId: account.platformUserId }
              : {}),
            ...(account.message ? { message: account.message } : {})
          }
        });
      }

      const douyinBrowserLoginMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/douyin-browser\/login$/
      );
      if (req.method === "POST" && douyinBrowserLoginMatch) {
        const projectId = douyinBrowserLoginMatch[1]!;
        if (!(await deps.productFlow.getProject(projectId))) {
          throw new DomainValidationError("Project not found");
        }
        if (!deps.douyinBrowserRuntime) {
          throw new DomainValidationError(
            "抖音浏览器发布引擎尚未配置"
          );
        }
        await readJson(req);
        const accountName =
          await deps.douyinBrowserRuntime.resolveAccountName();
        const login = await deps.douyinBrowserRuntime.login(
          accountName,
          true
        );
        if (login.ok) {
          await deps.publishBridge.setPreference(
            projectId,
            "DOUYIN_BROWSER_AUTOMATION"
          );
          await refreshProjectSnapshot(deps, projectId);
        }
        return json(res, login.ok ? 200 : 409, {
          login: {
            ok: login.ok,
            status: login.status,
            ...(login.message ? { message: login.message } : {}),
            ...(login.currentUrl ? { currentUrl: login.currentUrl } : {})
          },
          ...(login.ok
            ? {
                providerStatus:
                  await deps.publishBridge.providerStatus(projectId)
              }
            : {})
        });
      }

      const publishProviderPreferenceMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/provider$/
      );
      if (req.method === "POST" && publishProviderPreferenceMatch) {
        const projectId = publishProviderPreferenceMatch[1]!;
        const body = (await readJson(req)) as { providerType?: unknown };
        const providerType = publishProviderTypeSchema.parse(body.providerType);
        const preference = await deps.publishBridge.setPreference(
          projectId,
          providerType
        );
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, { preference });
      }

      const publishPackageCreateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/packages$/
      );
      if (req.method === "POST" && publishPackageCreateMatch) {
        const projectId = publishPackageCreateMatch[1]!;
        const qc = await deps.finalQc.assertPublishable(projectId);
        const body = (await readJson(req)) as {
          title?: unknown;
          description?: unknown;
          coverArtifactId?: unknown;
        };
        const created = await deps.publishBridge.createPackage({
          projectId,
          title: requireString(body.title, "title"),
          ...(typeof body.description === "string" && body.description.trim()
            ? { description: body.description.trim() }
            : {}),
          ...(typeof body.coverArtifactId === "string" &&
          body.coverArtifactId.trim()
            ? { coverArtifactId: body.coverArtifactId.trim() }
            : {}),
          publicBaseUrl: requestPublicBaseUrl(req)
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 201, {
          package: created.package,
          claimUrl: created.claimUrl,
          qrSvg: qrCodeSvg(created.claimUrl),
          qc
        });
      }

      const browserPreparationMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/publish\/packages\/([^/]+)\/browser-preflight(?:\/(prepare|handoff|resume))?$/);
      if(browserPreparationMatch&&(req.method==="GET"||req.method==="POST")){
       try{
        const projectId=browserPreparationMatch[1]!,packageId=browserPreparationMatch[2]!,action=browserPreparationMatch[3];
        const service=deps.publishBridge.browserPreparation;
        if(!service)throw new DomainValidationError("分阶段浏览器发布未配置，停止，不自动使用组合发布");
        if(req.method==="GET"&&!action)return json(res,200,{checkpoint:await service.status(projectId,packageId),supported:deps.publishBridge.browserPreparationSupported});
        const body=await readJson(req) as {confirmedPreparation?:unknown;expectedAccountId?:unknown;confirmed?:unknown;confirmedReturnControl?:unknown;scopeHash?:unknown;revision?:unknown};
        const consent={expectedAccountId:typeof body.expectedAccountId==='string'?body.expectedAccountId:undefined,scopeHash:typeof body.scopeHash==='string'?body.scopeHash:undefined,revision:typeof body.revision==='number'?body.revision:undefined};
        const checkpoint=action==="prepare"?await service.prepare({projectId,packageId,expectedAccountId:requireString(body.expectedAccountId,"expectedAccountId"),confirmedPreparation:body.confirmedPreparation===true}):action==="handoff"?await service.handoff({projectId,packageId,confirmed:body.confirmed===true,...consent}):action==="resume"?await service.resume({projectId,packageId,confirmedReturnControl:body.confirmedReturnControl===true,...consent}):null;
        if(!checkpoint)throw new DomainValidationError("未知发布预检操作");
        return json(res,200,{checkpoint});
       }catch(error){
        if(error instanceof Error&&error.message==='BROWSER_CHECKPOINT_INTEGRITY_FAILED')throw new DomainValidationError('原发布检查点完整性无法核验，已停止。请检查原记录，不重新上传或提交。');
        throw error;
       }
      }

      const publishPackageDirectMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/packages\/([^/]+)\/direct$/
      );
      if (req.method === "POST" && publishPackageDirectMatch) {
        const projectId = publishPackageDirectMatch[1]!;
        const packageId = publishPackageDirectMatch[2]!;
        const body = (await readJson(req)) as { confirmed?: unknown; expectedAccountId?: unknown;preparedScopeHash?:unknown;preparedRevision?:unknown };
        if (typeof body.expectedAccountId !== "string" ||
            !body.expectedAccountId.trim() || body.expectedAccountId.length > 200) {
          throw new DomainValidationError("请刷新发布账号状态，并明确确认本次发布使用的账号");
        }
        const result = await deps.publishBridge.directPublish({
          projectId,
          packageId,
          confirmed: body.confirmed === true,
          expectedAccountId: body.expectedAccountId.trim(),
          ...(typeof body.preparedScopeHash==="string"?{preparedScopeHash:body.preparedScopeHash}:{}),
          ...(typeof body.preparedRevision==="number"&&Number.isSafeInteger(body.preparedRevision)?{preparedRevision:body.preparedRevision}:{})
        });
        await refreshProjectSnapshot(deps, projectId);
        return json(res, 200, result);
      }

      const publishClaimMatch = url.pathname.match(
        /^\/api\/publish\/packages\/([^/]+)\/claim$/
      );
      if (req.method === "POST" && publishClaimMatch) {
        const body = (await readJson(req)) as { token?: unknown };
        const result = await deps.publishBridge.claimPackage({
          packageId: publishClaimMatch[1]!,
          token: requireString(body.token, "token")
        });
        await refreshProjectSnapshot(deps, result.package.projectId);
        return json(res, 200, result);
      }

      const publishPackageSessionMatch = url.pathname.match(
        /^\/api\/publish\/packages\/([^/]+)$/
      );
      if (req.method === "GET" && publishPackageSessionMatch) {
        const result = await deps.publishBridge.packageForSession({
          packageId: publishPackageSessionMatch[1]!,
          sessionToken: requireBearerToken(req)
        });
        return json(res, 200, { package: result });
      }

      const publishHandoffStartMatch = url.pathname.match(
        /^\/api\/publish\/packages\/([^/]+)\/handoff\/start$/
      );
      if (req.method === "POST" && publishHandoffStartMatch) {
        const result = await deps.publishBridge.startHandoff({
          packageId: publishHandoffStartMatch[1]!,
          sessionToken: requireBearerToken(req),
          publicBaseUrl: requestPublicBaseUrl(req)
        });
        await refreshProjectSnapshot(deps, result.package.projectId);
        return json(res, 200, result);
      }

      const publishHandoffCompleteMatch = url.pathname.match(
        /^\/api\/publish\/packages\/([^/]+)\/handoff\/complete$/
      );
      if (req.method === "POST" && publishHandoffCompleteMatch) {
        const body = (await readJson(req)) as { note?: unknown };
        const result = await deps.publishBridge.completeHandoff({
          packageId: publishHandoffCompleteMatch[1]!,
          sessionToken: requireBearerToken(req),
          ...(typeof body.note === "string" && body.note.trim()
            ? { note: body.note.trim() }
            : {})
        });
        await refreshProjectSnapshot(deps, result.projectId);
        return json(res, 200, { package: result });
      }

      const publishMediaMatch = url.pathname.match(
        /^\/api\/publish\/packages\/([^/]+)\/media$/
      );
      if (req.method === "GET" && publishMediaMatch) {
        const packageId = publishMediaMatch[1]!;
        const mediaToken = url.searchParams.get("media_token")?.trim();
        const source = mediaToken
          ? await deps.publishBridge.mediaByToken({
              packageId,
              mediaToken
            })
          : await deps.publishBridge.mediaBySession({
              packageId,
              sessionToken: requireBearerToken(req)
            });
        const nodeFs = await import("node:fs");
        res.writeHead(200, {
          "content-type": source.artifact.mimeType ?? "video/mp4",
          ...(source.artifact.sizeBytes !== undefined
            ? { "content-length": String(source.artifact.sizeBytes) }
            : {}),
          "cache-control": "private, no-store"
        });
        return nodeFs.createReadStream(source.absolutePath).pipe(res);
      }

      const douyinOAuthStartMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/douyin\/oauth\/start$/
      );
      if (req.method === "GET" && douyinOAuthStartMatch) {
        if (process.env.PVS_DOUYIN_OPENAPI_DIRECT_ENABLED?.trim() !== "1") {
          throw new DomainValidationError(
            "OpenAPI direct publish is disabled by administrator"
          );
        }
        const projectId = douyinOAuthStartMatch[1]!;
        const { authorizationUrl } = await deps.douyinPublish.beginOAuth(
          projectId
        );
        res.writeHead(302, { location: authorizationUrl });
        return res.end();
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/douyin/oauth/callback"
      ) {
        if (process.env.PVS_DOUYIN_OPENAPI_DIRECT_ENABLED?.trim() !== "1") {
          throw new DomainValidationError(
            "OpenAPI direct publish is disabled by administrator"
          );
        }
        const code = url.searchParams.get("code")?.trim();
        const state = url.searchParams.get("state")?.trim();
        if (!code || !state) {
          throw new DomainValidationError(
            "Douyin OAuth callback requires code and state"
          );
        }
        const result = await deps.douyinPublish.completeOAuth({ code, state });
        await refreshProjectSnapshot(deps, result.projectId);
        res.writeHead(302, {
          location: `/projects/${encodeURIComponent(result.projectId)}/final`
        });
        return res.end();
      }

      const douyinPublishMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/publish\/douyin$/
      );
      if (req.method === "POST" && douyinPublishMatch) {
        return json(res, 410, {
          error: "LEGACY_PUBLISH_ENDPOINT_DISABLED",
          message:
            "P1-07 已停用旧式直接发布入口，请使用 PublishPackage / PublishProvider 流程。"
        });
      }

      const artifactContentMatch = url.pathname.match(
        /^\/api\/artifacts\/([^/]+)\/content$/
      );
      if (req.method === "GET" && artifactContentMatch) {
        const artifact = await deps.artifacts.findById(
          decodeURIComponent(artifactContentMatch[1]!)
        );
        if (
          !artifact ||
          !canServeArtifactContent(artifact)
        ) {
          return json(res, 404, { error: "MEDIA_ARTIFACT_NOT_FOUND" });
        }
        const store = new LocalArtifactStore(
          path.join(deps.projectsRoot, artifact.projectId),
          deps.artifacts
        );
        const absolute = store.resolveArtifactPath(artifact.relativePath);
        try {
          await fs.access(absolute);
        } catch {
          return json(res, 404, { error: "MEDIA_ARTIFACT_FILE_MISSING" });
        }
        const fsSync = await import("node:fs");
        res.writeHead(200, {
          "content-type": artifact.mimeType ?? "application/octet-stream",
          ...(artifact.sizeBytes !== undefined
            ? { "content-length": String(artifact.sizeBytes) }
            : {}),
          "cache-control": "no-store"
        });
        return fsSync.createReadStream(absolute).pipe(res);
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(302, { location: "/projects" });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/projects") {
        const projects = await deps.productFlow.listProjects();
        const blockerLists = await Promise.all(
          projects.map((project) => deps.workflow.listOpenBlockers(project.id))
        );
        const blockerCounts = new Map(
          projects.map((project, index) => [
            project.id,
            blockerLists[index]?.length ?? 0
          ])
        );
        const resumeStates = deps.smartGeneration
          ? await Promise.all(projects.map(async project => {
              const [runs, input, workspace, timeline, assembly] = await Promise.all([
                deps.smartGeneration!.list(project.id),
                deps.productInput.latest(project.id),
                deps.productFlow.getWorkspace(project.id),
                deps.timeline.latestTimeline(project.id),
                deps.finalOutput.latestAssembly(project.id)
              ]);
              return [project.id, resolveWorkflowReadModel({
                project, runs,
                productInputPresent: Boolean(input),
                productImagePresent: Boolean(input?.assets.some(asset => asset.type === "image")),
                productTruthConfirmed: workspace?.productTruth?.status === "CONFIRMED",
                productTruthDraftPresent: Boolean(workspace?.productTruth),
                timelineStatus: timeline?.status,
                timelinePlanHash: timeline?.productionPlanHash,
                finalAssemblyStatus: assembly?.status,
                finalAssemblyPlanHash: assembly?.productionPlanHash,
                projectPlanHash: project.currentProductionPlanRef?.hash
              })] as const;
            }))
          : [];
        return html(res, 200, renderProjectsPage(projects, blockerCounts, new Map(resumeStates)));
      }

      const deleteProjectMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)$/
      );
      if (req.method === "DELETE" && deleteProjectMatch) {
        const projectId = decodeURIComponent(deleteProjectMatch[1]!);
        const body = (await readJson(req)) as { confirmName?: unknown };
        if (
          typeof body.confirmName !== "string" ||
          !body.confirmName.trim()
        ) {
          throw new DomainValidationError("请输入项目名称完成二次确认");
        }
        const result = await deps.projectDeletion.deleteProject({
          projectId,
          confirmName: body.confirmName
        });
        return json(res, 200, {
          deleted: true,
          projectId: result.projectId,
          projectName: result.projectName,
          ...(result.fileCleanupPending
            ? {
                warning:
                  "项目记录已删除，但部分本地文件仍在删除暂存区等待系统清理。"
              }
            : {})
        });
      }

      if (req.method === "GET" && url.pathname === "/agent") {
        return html(
          res,
          200,
          renderAgentHome(await deps.productFlow.listProjects())
        );
      }

      const mobilePublishPageMatch = url.pathname.match(
        /^\/publish\/mobile\/([^/]+)$/
      );
      if (req.method === "GET" && mobilePublishPageMatch) {
        return html(
          res,
          200,
          renderMobilePublishPage(mobilePublishPageMatch[1]!)
        );
      }

      const legacyProjectAgentPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/agent$/
      );
      if (req.method === "GET" && legacyProjectAgentPageMatch) {
        const projectId = legacyProjectAgentPageMatch[1]!;
        const referenceArtifactId = url.searchParams.get("referenceArtifactId")?.trim();
        const location = referenceArtifactId
          ? `/projects/${projectId}/smart?useReference=1`
          : `/projects/${projectId}/smart`;
        res.writeHead(302, { location });
        return res.end();
      }

      const projectAgentPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/single-video$/
      );
      if (req.method === "GET" && projectAgentPageMatch) {
        const projectId = projectAgentPageMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const referenceArtifactId =
          url.searchParams.get("referenceArtifactId")?.trim();
        let prefillReference:
          | {
              artifactId: string;
              originalFilename: string;
              mimeType: string;
            }
          | undefined;
        if (referenceArtifactId) {
          const [artifact, profile] = await Promise.all([
            deps.artifacts.findById(referenceArtifactId),
            deps.referenceVideo.latest(projectId)
          ]);
          if (
            artifact &&
            artifact.projectId === projectId &&
            artifact.integrityStatus === "READY" &&
            artifact.mimeType?.startsWith("video/")
          ) {
            prefillReference = {
              artifactId: artifact.id,
              originalFilename:
                profile?.videoArtifactId === artifact.id &&
                profile.originalFilename
                  ? profile.originalFilename
                  : path.basename(artifact.relativePath),
              mimeType: artifact.mimeType
            };
          }
        }
        const [tasks, artifacts] = await Promise.all([
          deps.agentMode.listTasks(projectId),
          deps.artifacts.listByProject(projectId)
        ]);
        const referencedArtifactIds = new Set(
          tasks.flatMap((task) =>
            task.materials.map((material) => material.artifactId)
          )
        );
        const agentArtifactStore = new LocalArtifactStore(
          path.join(deps.projectsRoot, projectId),
          deps.artifacts
        );
        const verifiedArtifacts = await Promise.all(
          artifacts.map(async (artifact) => {
            if (
              !referencedArtifactIds.has(artifact.id) ||
              artifact.integrityStatus !== "READY"
            ) {
              return artifact;
            }
            try {
              await fs.access(
                agentArtifactStore.resolveArtifactPath(artifact.relativePath)
              );
              return artifact;
            } catch {
              return {
                ...artifact,
                integrityStatus: "MISSING" as const
              };
            }
          })
        );
        const workflow = await readWorkflow(workspace, await deps.productInput.latest(projectId), url.searchParams.get("fromSmartRun") ?? url.searchParams.get("activeRun"));
        return html(
          res,
          200,
          renderAgentProjectPage({
            workspace,
            navigation: resolveWorkflowNavigation({project:workspace.project,currentPage:null,...(workflow ? {workflow} : {})}),
            tasks,
            artifacts: verifiedArtifacts,
            ...(prefillReference ? { prefillReference } : {})
          })
        );
      }

      const referenceVideoPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/reference-video$/
      );
      if (req.method === "GET" && referenceVideoPageMatch) {
        const projectId = referenceVideoPageMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const [profile, history, projectArtifacts] = await Promise.all([
          deps.referenceVideo.latest(projectId),
          deps.referenceVideo.list(projectId),
          deps.artifacts.listByProject(projectId, "OTHER")
        ]);
        const workflow = await readWorkflow(workspace, await deps.productInput.latest(projectId), url.searchParams.get("fromSmartRun") ?? url.searchParams.get("activeRun"));
        const previewArtifactId = profile
          ? projectArtifacts.find(
              (artifact) =>
                artifact.relativePath ===
                  referenceVideoBrowserPreviewRelativePath(
                    profile.videoArtifactHash
                  ) &&
                artifact.integrityStatus === "READY" &&
                artifact.mimeType === "video/mp4"
            )?.id
          : undefined;
        return html(
          res,
          200,
          renderReferenceVideoPage({
            workspace,
            navigation: resolveWorkflowNavigation({
              project: workspace.project,
              currentPage: null,
              ...(workflow ? { workflow } : {})
            }),
            profile,
            history,
            ...(previewArtifactId ? { previewArtifactId } : {})
          })
        );
      }

      const researchPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/research$/
      );
      if (req.method === "GET" && researchPageMatch) {
        const projectId = researchPageMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const [researchData, blockers, projectInput] = await Promise.all([
          deps.research.pageData(projectId),
          deps.workflow.listOpenBlockers(projectId),
          deps.productInput.latest(projectId)
        ]);
        const workflow = await readWorkflow(workspace, projectInput, url.searchParams.get("fromSmartRun") ?? url.searchParams.get("activeRun"));
        return html(
          res,
          200,
          renderResearchPage({
            workspace,
            productInput: projectInput,
            ...researchData,
            navigation: resolveWorkflowNavigation({
              project: workspace.project,
              currentPage: "research",
              blockers,
              ...(workflow ? { workflow } : {})
            })
          })
        );
      }

      if (req.method === "GET" && url.pathname === "/settings/ai") {
        const [providers, systemPreference] = await Promise.all([
          deps.aiSettings.listProviders(),
          deps.aiSettings.getSystemPreference()
        ]);
        return html(
          res,
          200,
          renderAiSettingsPage(providers, systemPreference)
        );
      }

      const projectModelsPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/models$/
      );
      if (req.method === "GET" && projectModelsPageMatch) {
        const projectId = projectModelsPageMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const [
          providers,
          systemPreference,
          projectPreference,
          overrides,
          executions
        ] = await Promise.all([
          deps.aiSettings.listProviders(),
          deps.aiSettings.getSystemPreference(),
          deps.aiSettings.getProjectPreference(projectId),
          deps.aiSettings.listStepOverrides(projectId),
          deps.aiSettings.listExecutions(projectId)
        ]);
        const workflow = await readWorkflow(workspace, await deps.productInput.latest(projectId), url.searchParams.get("fromSmartRun") ?? url.searchParams.get("activeRun"));
        return html(
          res,
          200,
          renderProjectModelSettingsPage({
            workspace,
            navigation: resolveWorkflowNavigation({project:workspace.project,currentPage:null,...(workflow ? {workflow} : {})}),
            providers,
            systemPreference,
            projectPreference,
            overrides,
            executions
          })
        );
      }

      const publishSettingsPageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/publish-settings$/
      );
      if (req.method === "GET" && publishSettingsPageMatch) {
        const projectId = publishSettingsPageMatch[1]!;
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }
        const providerStatus = await deps.publishBridge.providerStatus(
          projectId
        );
        return html(
          res,
          200,
          renderPublishSettingsPage({
            workspace,
            preference: providerStatus.preference,
            probes: providerStatus.probes
          })
        );
      }

      const pageMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/(product|truth|creative|script|director|generate|timeline|final)$/
      );
      if (req.method === "GET" && pageMatch) {
        const projectId = pageMatch[1]!;
        const kind = pageMatch[2] as
          | "product"
          | "truth"
          | "creative"
          | "script"
          | "director"
          | "generate"
          | "timeline"
          | "final";
        const workspace = await deps.productFlow.getWorkspace(projectId);
        if (!workspace) {
          return json(res, 404, { error: "PROJECT_NOT_FOUND" });
        }

        const [
          persistedBlockers,
          attempts,
          productInput,
          generationRequests,
          preflights,
          approvals,
          compiledPrompts,
          artifacts,
          reviewDecisions,
          commandAttempts
        ] = await Promise.all([
          deps.workflow.listOpenBlockers(projectId),
          deps.workflow.listGenerationAttempts(projectId),
          deps.productInput.latest(projectId),
          deps.generation.listGenerationRequests(projectId),
          deps.generation.listPreflightReports(projectId),
          deps.generation.listUserApprovals(projectId),
          deps.generation.listCompiledPrompts(projectId),
          deps.artifacts.listByProject(projectId),
          deps.review.listDecisions(projectId),
          deps.providerAudit.listCommandAttempts(projectId)
        ]);
        const workflow = await readWorkflow(workspace, productInput, url.searchParams.get("fromSmartRun") ?? url.searchParams.get("activeRun"));
        let blockers = persistedBlockers;
        let probe;
        let timeline;
        let renderJob;
        let finalAssembly;
        let finalQcReport;
        let publishAttempts;
        let publishProbe;
        let publishBridge;
        if (kind === "generate") {
          probe = await deps.provider.probe();
          const providerBlocker = blockerFromProviderProbe(projectId, probe);
          if (
            providerBlocker &&
            !blockers.some(
              (item) =>
                item.scope === "PROVIDER" &&
                item.reasonCode === providerBlocker.reasonCode
            )
          ) {
            blockers = [...blockers, providerBlocker];
          }
        }
        if (kind === "timeline") {
          const access = await inspectTimelineAccess(deps.timeline, projectId);
          if (!access.allowed) {
            const navigation = resolveWorkflowNavigation({
              project: workspace.project,
              currentPage: "timeline",
              blockers,
              ...(workflow ? { workflow } : {})
            });
            return html(
              res,
              200,
              renderBlockedStepPage({
                pageTitle: "视频剪辑",
                project: workspace.project,
                navigation,
                access
              })
            );
          }
          timeline = await deps.timeline.getOrCreate(projectId);
          renderJob = (await deps.timeline.latestRenderJob(projectId)) ?? undefined;
        }
        if (kind === "final") {
          const access = await inspectFinalAccess(deps.timeline, projectId);
          if (!access.allowed) {
            const navigation = resolveWorkflowNavigation({
              project: workspace.project,
              currentPage: "final",
              blockers,
              ...(workflow ? { workflow } : {})
            });
            return html(
              res,
              200,
              renderBlockedStepPage({
                pageTitle: "成片与发布",
                project: workspace.project,
                navigation,
                access
              })
            );
          }
          timeline = (await deps.timeline.latestTimeline(projectId)) ?? undefined;
          renderJob = (await deps.timeline.latestRenderJob(projectId)) ?? undefined;
          finalAssembly =
            (await deps.finalOutput.latestAssembly(projectId)) ?? undefined;
          finalQcReport = (await deps.finalQc.latest(projectId)) ?? undefined;
          publishAttempts = await deps.finalOutput.listPublishAttempts(projectId);
          const [providerStatus, publishAudit] = await Promise.all([
            deps.publishBridge.providerStatus(projectId),
            deps.publishBridge.audit(projectId)
          ]);
          publishBridge = {
            preference: providerStatus.preference,
            probes: providerStatus.probes,
            packages: publishAudit.packages,
            receipts: publishAudit.receipts,
            browserPreparationSupported:publishAudit.browserPreparationSupported,
            browserCheckpoints:publishAudit.browserCheckpoints
          };
        }
        const navigation = resolveWorkflowNavigation({
          project: workspace.project,
          currentPage: kind,
          blockers,
          ...(workflow ? { workflow } : {}),
          ...(timeline ? { timeline } : {}),
          ...(finalAssembly ? { finalAssemblyStatus: finalAssembly.status } : {})
        });

        return html(
          res,
          200,
          renderProjectPage({
            kind,
            workspace,
            navigation,
            ...(productInput ? { productInput } : {}),
            blockers,
            attempts,
            generationRequests,
            preflights,
            approvals,
            compiledPrompts,
            artifacts,
            reviewDecisions,
            commandAttempts,
            ...(probe ? { probe } : {}),
            ...(timeline ? { timeline } : {}),
            ...(renderJob ? { renderJob } : {}),
            ...(finalAssembly ? { finalAssembly } : {}),
            ...(finalQcReport ? { finalQc: finalQcReport } : {}),
            ...(publishAttempts ? { publishAttempts } : {}),
            ...(publishProbe ? { publishProbe } : {}),
            ...(publishBridge ? { publishBridge } : {})
          })
        );
      }

      return json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const browserPageRequest =
        req.method === "GET" && !requestUrl.pathname.startsWith("/api/");
      const projectPageMatch = requestUrl.pathname.match(/^\/projects\/([^/]+)/);
      const backHref = projectPageMatch
        ? `/projects/${projectPageMatch[1]!}/smart`
        : "/projects";
      if (error instanceof DomainValidationError || error instanceof ZodError) {
        if (browserPageRequest) {
          return html(
            res,
            400,
            renderSafeRequestErrorPage({
              status: 400,
              message:
                "当前步骤条件未满足，或页面数据已经发生变化。请返回项目后继续操作。",
              technicalDetail: error.message,
              backHref
            })
          );
        }
        return json(res, 400, {
          error: "VALIDATION_ERROR",
          message: error instanceof ZodError ? validationMessage(error.issues) : error.message
        });
      }
      if (browserPageRequest) {
        return html(
          res,
          500,
          renderSafeRequestErrorPage({
            status: 500,
            title: "页面处理失败",
            message: "页面处理时遇到问题。请返回项目后重试；如果问题持续存在，再查看高级信息。",
            technicalDetail: error instanceof Error ? error.message : String(error),
            backHref
          })
        );
      }
      return json(res, 500, publicApiError(error));
    }
  });
  let stopSmartWorker: (() => void) | undefined;
  let stopAgentWorker: (() => void) | undefined;
  let stopOperationsWorker: (() => void) | undefined;
  server.once("listening", () => {
    if(deps.douyinSchedules && process.env.NODE_ENV!=="test" && process.env.PVS_OPERATIONS_WORKER_DISABLED!=="1"){
      let operationsWarned=false;
      stopOperationsWorker=startDouyinOperationsScheduleWorker(deps.douyinSchedules,()=>{
        if(!operationsWarned){operationsWarned=true;console.error("运营采集调度遇到阻断，已保留原计划和采集检查点。");}
      });
    }
    if(deps.agentCycles && process.env.NODE_ENV!=="test" && process.env.PVS_AGENT_WORKER_DISABLED!=="1"){
      let agentWarned=false;
      stopAgentWorker=startAgentCycleWorker(deps.agentCycles,(error)=>{if(!agentWarned){agentWarned=true;console.error("Agent工作台暂停了异常任务；不会自动重发未知操作。",error);}});
    }
    if (deps.smartGeneration && process.env.NODE_ENV !== "test" && smartWorkerPolicy.mode !== "DISABLED") {
      let warned = false;
      stopSmartWorker = startSmartGenerationWorker(deps.smartGeneration, {
        policy: smartWorkerPolicy,
        ...(smartWorkerPolicy.mode === "SCOPED" ? { scope: smartWorkerPolicy.scope } : {}),
        onError: (error) => {
          if (!warned) {
            warned = true;
            console.error("一键成片执行器遇到阻塞；不会自动重提失败生成。", error);
          }
        }
      });
    }
  });
  server.once("close", () => {stopSmartWorker?.();stopAgentWorker?.();stopOperationsWorker?.();});
  return server;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3090);
  const deps = createDefaultDependencies();
  void (async () => {
    try {
      const recovered = await deps.recovery.recoverAll();
      console.log(
        "Product Video Studio recovery complete: " +
          recovered.length +
          " project(s)"
      );
    } catch (error) {
      console.error(
        "Product Video Studio recovery failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    createAppServer(deps).listen(port, "127.0.0.1", () => {
      console.log(
        "Product Video Studio P1 listening on http://127.0.0.1:" + port
      );
    });
  })();
}
