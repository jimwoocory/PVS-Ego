import type { ProductFlowService } from "./product-flow.js";
import type { PublishRepository } from "../ports/publish-repository.js";
import type {
  DouyinOpsRuntime,
  DouyinOpsWork
} from "../ports/douyin-ops-runtime.js";
import type {
  DouyinOpsLauncher,
  DouyinOpsLaunchResult
} from "../ports/douyin-ops-launcher.js";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import type {
  DouyinCreativeFeedback,
  DouyinInsight,
  DouyinMetricSnapshot,
  DouyinReplyDraft,
  DouyinWorkBinding,
  DouyinComment
} from "../../domain/douyin-ops.js";
import type {
  PublishPackage,
  PublishReceipt
} from "../../domain/publish.js";
import {
  DouyinAccountBindingService,
  type DouyinAccountMatchResult
} from "./douyin-account-binding-service.js";
import {
  DouyinWorkBindingService
} from "./douyin-work-binding-service.js";
import { DouyinMetricService } from "./douyin-metric-service.js";
import { DouyinCommentService } from "./douyin-comment-service.js";
import { DouyinCommentClassificationService } from "./douyin-comment-classification-service.js";
import { DouyinReplyDraftService } from "./douyin-reply-draft-service.js";
import { DouyinReplyPublishService, type DouyinReplyPublishResult } from "./douyin-reply-publish-service.js";
import { DouyinRetrospectiveService } from "./douyin-retrospective-service.js";
import { DouyinCreativeFeedbackService } from "./douyin-creative-feedback-service.js";
import { DouyinOpsRuntimeError } from "../ports/douyin-ops-runtime.js";
import { DomainValidationError } from "../../domain/validation.js";
import { randomUUID } from "node:crypto";
import { hashValue } from "../../domain/hashing.js";
import { douyinWorkBindingSchema } from "../../domain/douyin-ops.js";
import { checkDouyinResearchReadiness, type DouyinResearchReadiness } from "./douyin-research-readiness.js";

export type DouyinOpsGlobalView = {
  runtime: Awaited<ReturnType<DouyinOpsRuntime["probe"]>>;
  account: DouyinAccountMatchResult;
  works: DouyinOpsWork[];
  worksStatus: "READY" | "AUTH_REQUIRED" | "OFFLINE" | "FAILED";
  worksMessage?: string;
  linkedProjects: Array<{
    projectId: string;
    projectName: string;
    binding: DouyinWorkBinding;
  }>;
};

export type DouyinOpsProjectView = {
  project: {
    id: string;
    name: string;
  };
  runtime: Awaited<ReturnType<DouyinOpsRuntime["probe"]>>;
  account: DouyinAccountMatchResult;
  publishPackage: PublishPackage | null;
  publishReceipt: PublishReceipt | null;
  binding: DouyinWorkBinding | null;
  snapshots: DouyinMetricSnapshot[];
  comments: DouyinComment[];
  replyDrafts: DouyinReplyDraft[];
  latestInsight: DouyinInsight | null;
  creativeFeedback: DouyinCreativeFeedback[];
  candidates: DouyinOpsWork[];
  candidatesStatus: "READY" | "AUTH_REQUIRED" | "OFFLINE" | "FAILED";
  candidatesMessage?: string;
  retrospectiveMode?: "MODEL" | "LOCAL";
};

function latestTrustedReceipt(
  receipts: PublishReceipt[]
): PublishReceipt | null {
  for (let i = receipts.length - 1; i >= 0; i -= 1) {
    const receipt = receipts[i]!;
    if (
      receipt.kind === "PUBLISHED_CONFIRMED" &&
      receipt.trusted === true
    ) {
      return receipt;
    }
  }
  return null;
}

function candidateFailure(error: unknown): {
  status: DouyinOpsProjectView["candidatesStatus"];
  message: string;
} {
  if (
    error instanceof DouyinOpsRuntimeError &&
    error.code === "AUTH_REQUIRED"
  ) {
    return {
      status: "AUTH_REQUIRED",
      message: "抖音运营账号需要重新登录。"
    };
  }
  if (error instanceof DouyinOpsRuntimeError) {
    return {
      status: "OFFLINE",
      message: error.message
    };
  }
  return {
    status: "FAILED",
    message:
      error instanceof Error
        ? error.message
        : String(error)
  };
}

export class DouyinOpsDashboardService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly publishRepo: PublishRepository,
    private readonly opsRepo: DouyinOpsRepository,
    private readonly opsRuntime: DouyinOpsRuntime,
    private readonly accountBinding: DouyinAccountBindingService,
    private readonly workBinding: DouyinWorkBindingService,
    private readonly metrics: DouyinMetricService,
    private readonly comments: DouyinCommentService,
    private readonly classifier: DouyinCommentClassificationService,
    private readonly replyDrafts: DouyinReplyDraftService,
    private readonly replyPublisher: DouyinReplyPublishService,
    private readonly retrospective: DouyinRetrospectiveService,
    private readonly creativeFeedbackService: DouyinCreativeFeedbackService,
    private readonly launcher?: DouyinOpsLauncher,
    private readonly retrospectiveMode: "MODEL" | "LOCAL" = "MODEL"
  ) {}

  private async requireProject(projectId: string) {
    const workspace =
      await this.productFlow.getWorkspace(projectId);
    if (!workspace) {
      throw new DomainValidationError("项目不存在");
    }
    return workspace.project;
  }

  private async packageState(projectId: string): Promise<{
    pkg: PublishPackage | null;
    receipt: PublishReceipt | null;
  }> {
    const pkg = await this.publishRepo.latestPackage(projectId);
    if (!pkg) return { pkg: null, receipt: null };
    const receipts =
      await this.publishRepo.listReceiptsForPackage(pkg.id);
    return {
      pkg,
      receipt: latestTrustedReceipt(receipts)
    };
  }

  private async ensureBinding(input: {
    projectId: string;
    account: DouyinAccountMatchResult;
  }): Promise<{
    pkg: PublishPackage | null;
    receipt: PublishReceipt | null;
    binding: DouyinWorkBinding | null;
  }> {
    const state = await this.packageState(input.projectId);
    const existing = state.pkg
      ? await this.opsRepo.findWorkBindingByPackage(
          state.pkg.id
        )
      : await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true });

    if (!state.pkg) {
      return {
        ...state,
        binding: existing
      };
    }

    if (
      existing?.status === "BOUND" &&
      existing.awemeId
    ) {
      return {
        ...state,
        binding: await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true }) ?? existing
      };
    }

    // An unpublished new package is a draft, not a replacement for the work
    // already being monitored. All operational commands prefer the same BOUND work.
    if (!state.receipt) {
      const bound = await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true });
      if (bound?.status === "BOUND" && bound.awemeId) return { ...state, binding: bound };
    }

    const decision =
      this.workBinding.fromPublishReceipt({
        pkg: state.pkg,
        receipt: state.receipt,
        accountMatch: input.account
      });

    const binding = await this.metrics.persistBinding({
      projectId: input.projectId,
      decision,
      ...(input.account.ops.uid?{opsAccountUid:input.account.ops.uid}:{}),
      ...(state.pkg.publishedConfirmedAt
        ? { publishedAt: state.pkg.publishedConfirmedAt }
        : {})
    });

    return {
      ...state,
      binding: await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true }) ?? binding
    };
  }

  private async candidates(): Promise<{
    works: DouyinOpsWork[];
    status: DouyinOpsProjectView["candidatesStatus"];
    message?: string;
  }> {
    try {
      return {
        works: await this.opsRuntime.listMyWorks(30),
        status: "READY"
      };
    } catch (error) {
      const failure = candidateFailure(error);
      return {
        works: [],
        status: failure.status,
        message: failure.message
      };
    }
  }

  async launch(): Promise<DouyinOpsLaunchResult> {
    if (!this.launcher) {
      return {
        ok: false,
        status: "UNAVAILABLE",
        message: "抖音运营启动器尚未配置。"
      };
    }
    return this.launcher.launch();
  }

  /** Account-owned historical works are observations, never a publication receipt for this project. */
  async existingWorks() {
    const account = await this.opsRuntime.identity();
    if (!account.uid || account.uid === "0") throw new DomainValidationError("请先登录并核对运营账号");
    const works = (await this.opsRuntime.listMyWorks(30)).filter(work => work.author.uid === account.uid);
    return { account: { uid: account.uid, nickname: account.nickname }, works: works.map(work => ({ ...work,
      workHash: hashValue({ awemeId: work.awemeId, description: work.description, authorUid: work.author.uid, publishedAt: work.publishedAt }) })) };
  }

  async observeExistingWork(input: { projectId: string; awemeId: string; expectedAccountUid: string; expectedWorkHash: string }) {
    await this.requireProject(input.projectId);
    const account = await this.opsRuntime.identity();
    if (account.uid !== input.expectedAccountUid || !account.uid || account.uid === "0")
      throw new DomainValidationError("运营账号已变化，不能关联历史作品");
    const listed = (await this.opsRuntime.listMyWorks(30)).find(work => work.awemeId === input.awemeId && work.author.uid === account.uid);
    if (!listed) throw new DomainValidationError("该作品不在当前账号的实际作品列表中");
    const work = await this.opsRuntime.getWork(input.awemeId);
    if (work.awemeId !== input.awemeId || work.author.uid !== account.uid || hashValue({ awemeId: work.awemeId,
      description: work.description, authorUid: work.author.uid, publishedAt: work.publishedAt }) !== input.expectedWorkHash)
      throw new DomainValidationError("历史作品身份或内容已变化，请重新读取作品列表");
    const current = await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true });
    if (current?.status === "BOUND" && (current.awemeId !== work.awemeId || current.source !== "HISTORICAL_WORK"))
      throw new DomainValidationError("项目已有其他运营作品，不能静默替换");
    if (current?.awemeId === work.awemeId) return current;
    const now = new Date().toISOString();
    return this.opsRepo.upsertWorkBinding(douyinWorkBindingSchema.parse({ id: randomUUID(), projectId: input.projectId,
      awemeId: work.awemeId, source: "HISTORICAL_WORK", confidence: "HIGH", status: "BOUND", opsAccountUid: account.uid,
      workDescription: work.description, externalUrl: work.externalUrl, ...(work.publishedAt ? { publishedAt: work.publishedAt } : {}),
      boundAt: now, createdAt: now, updatedAt: now }));
  }

  /** Fast research-only check: never lists published works or checks the publishing account. */
  async researchReadiness(): Promise<DouyinResearchReadiness> {
    return checkDouyinResearchReadiness(this.opsRuntime);
  }

  async global(): Promise<DouyinOpsGlobalView> {
    // 复用同一次探测，避免多个 Bridge eval 并发导致虚假 SITE_OFFLINE。
    const [runtime, projects] = await Promise.all([
      this.opsRuntime.probe(),
      this.productFlow.listProjects()
    ]);
    const account = await this.accountBinding.inspect(runtime);

    const candidateState =
      runtime.ready &&
      account.ops.available &&
      account.ops.runtimeStatus === "READY"
        ? await this.candidates()
        : {
            works: [] as DouyinOpsWork[],
            status:
              runtime.ready
                ? ("AUTH_REQUIRED" as const)
                : ("OFFLINE" as const),
            message:
              runtime.ready
                ? "请先在专用抖音浏览器完成运营账号登录。"
                : runtime.message ??
                  "抖音运营连接当前不可用。"
          };

    const linkedProjects = (
      await Promise.all(
        projects.map(async (project) => {
          const binding =
            await this.opsRepo.latestWorkBinding(project.id, { preferBound: true });
          return binding
            ? {
                projectId: project.id,
                projectName: project.name,
                binding
              }
            : null;
        })
      )
    ).filter(
      (
        item
      ): item is {
        projectId: string;
        projectName: string;
        binding: DouyinWorkBinding;
      } => Boolean(item)
    );

    return {
      runtime,
      account,
      works: candidateState.works,
      worksStatus: candidateState.status,
      ...(candidateState.message
        ? { worksMessage: candidateState.message }
        : {}),
      linkedProjects
    };
  }

  async project(
    projectId: string
  ): Promise<DouyinOpsProjectView> {
    const project = await this.requireProject(projectId);
    const runtime = await this.opsRuntime.probe();
    const account = await this.accountBinding.inspect(runtime);
    const state = await this.ensureBinding({
      projectId,
      account
    });

    const [snapshots, comments, replyDrafts, latestInsight, creativeFeedback, candidateState] =
      await Promise.all([
        this.metrics.history({
          projectId,
          ...(state.binding?.awemeId
            ? { awemeId: state.binding.awemeId }
            : {})
        }),
        this.comments.listComments({
          projectId,
          ...(state.binding?.awemeId
            ? { awemeId: state.binding.awemeId }
            : {}),
          parentCid: null,
          limit: 500,
          order: "desc"
        }),
        state.binding?.awemeId
          ? this.replyDrafts.latestForWork({
              projectId,
              awemeId: state.binding.awemeId
            })
          : Promise.resolve([] as DouyinReplyDraft[]),
        state.binding?.awemeId
          ? this.retrospective.latest({
              projectId,
              awemeId: state.binding.awemeId
            })
          : Promise.resolve(null as DouyinInsight | null),
        this.creativeFeedbackService.active(projectId),
        runtime.ready &&
        account.ops.available &&
        account.ops.runtimeStatus === "READY"
          ? this.candidates()
          : Promise.resolve({
              works: [] as DouyinOpsWork[],
              status:
                runtime.ready
                  ? ("AUTH_REQUIRED" as const)
                  : ("OFFLINE" as const),
              message:
                runtime.ready
                  ? "请先在专用抖音浏览器完成运营账号登录。"
                  : runtime.message ??
                    "抖音运营连接当前不可用。"
            })
      ]);

    return {
      project: {
        id: project.id,
        name: project.name
      },
      runtime,
      account,
      publishPackage: state.pkg,
      publishReceipt: state.receipt,
      binding: state.binding,
      snapshots,
      comments,
      replyDrafts,
      latestInsight,
      retrospectiveMode: this.retrospectiveMode,
      creativeFeedback,
      candidates: candidateState.works,
      candidatesStatus: candidateState.status,
      ...(candidateState.message
        ? { candidatesMessage: candidateState.message }
        : {})
    };
  }


  async promoteCreativeFeedback(input: {
    projectId: string;
    insightId: string;
    actionIndex: number;
    confirmed: boolean;
  }): Promise<DouyinCreativeFeedback> {
    await this.requireProject(input.projectId);
    return this.creativeFeedbackService.promote(
      input
    );
  }

  async deactivateCreativeFeedback(input: {
    projectId: string;
    feedbackId: string;
    confirmed: boolean;
  }): Promise<DouyinCreativeFeedback> {
    await this.requireProject(input.projectId);
    return this.creativeFeedbackService.deactivate(
      input
    );
  }

  async generateRetrospective(
    projectId: string
  ): Promise<DouyinInsight> {
    await this.requireProject(projectId);
    return this.retrospectiveMode === "LOCAL" ? this.retrospective.prepareLocalReview({projectId}) : this.retrospective.generate({
      projectId
    });
  }

  async refreshMetrics(
    projectId: string
  ): Promise<DouyinMetricSnapshot> {
    await this.requireProject(projectId);
    return this.metrics.refresh({ projectId });
  }

  async syncComments(
    projectId: string
  ) {
    await this.requireProject(projectId);
    return this.comments.syncComments({
      projectId,
      maxPages: 5,
      pageSize: 20
    });
  }

  async syncReplies(
    projectId: string,
    cid: string
  ) {
    await this.requireProject(projectId);
    return this.comments.syncReplies({
      projectId,
      cid,
      maxPages: 5,
      pageSize: 20
    });
  }

  /** Reads saved replies only; opening a thread never contacts the platform. */
  async savedReplies(projectId: string, cid: string, offset = 0, limit = 50) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainValidationError("回复分页参数无效");
    await this.requireProject(projectId);
    const binding = await this.opsRepo.latestWorkBinding(projectId, { preferBound: true });
    if (!binding || binding.status !== "BOUND" || !binding.awemeId)
      throw new DomainValidationError("请先确认当前项目的作品绑定");
    const parent = await this.opsRepo.findComment({ awemeId: binding.awemeId, cid });
    if (!parent || parent.projectId !== projectId || parent.awemeId !== binding.awemeId || parent.parentCid)
      throw new DomainValidationError("父评论不属于当前项目的已绑定作品");
    const items = await this.opsRepo.listComments({
      projectId, awemeId: binding.awemeId, parentCid: cid, offset, limit: limit + 1, order: "desc"
    });
    return { projectId, awemeId: binding.awemeId, parentCid: cid,
      items: items.slice(0, limit), hasMore: items.length > limit,
      nextOffset: offset + Math.min(items.length, limit) };
  }

  async savedCommentEvidence(projectId:string,cid:string){
    await this.requireProject(projectId);
    const binding=await this.opsRepo.latestWorkBinding(projectId,{preferBound:true});
    if(!binding?.awemeId||binding.status!=="BOUND")throw new DomainValidationError("请先确认当前作品绑定");
    const comment=await this.opsRepo.findComment({awemeId:binding.awemeId,cid});
    if(!comment||comment.projectId!==projectId||comment.bindingId!==binding.id)throw new DomainValidationError("评论不属于当前项目作品");
    const ref=comment.observation?.pageEvidenceId;
    const evidence=ref&&this.opsRepo.findCommentPageEvidence?await this.opsRepo.findCommentPageEvidence(projectId,ref):null;
    if(evidence&&(evidence.awemeId!==binding.awemeId||evidence.bindingId!==binding.id))throw new DomainValidationError("原始页证据不属于当前作品");
    return {commentId:comment.cid,observation:comment.observation,evidence,sourceStatus:evidence?"SAVED_RAW_PAGE_COMPARISON":"UNKNOWN_NO_RAW_PAGE",completePlatformCoverage:false};
  }

  async classifyComments(input: {
    projectId: string;
    cids?: string[];
    force?: boolean;
  }) {
    await this.requireProject(input.projectId);
    const binding =
      await this.opsRepo.latestWorkBinding(input.projectId, { preferBound: true });
    if (
      !binding ||
      binding.status !== "BOUND" ||
      !binding.awemeId
    ) {
      throw new DomainValidationError(
        "当前项目尚未确认抖音作品绑定，不能进行评论 AI 分类"
      );
    }
    return this.classifier.classify({
      projectId: input.projectId,
      awemeId: binding.awemeId,
      ...(input.cids ? { cids: input.cids } : {}),
      ...(input.force !== undefined
        ? { force: input.force }
        : {}),
      limit: 20
    });
  }

  async generateReplyDraft(input: {
    projectId: string;
    cid: string;
  }): Promise<DouyinReplyDraft> {
    await this.requireProject(input.projectId);
    return this.replyDrafts.generate({
      projectId: input.projectId,
      cid: input.cid
    });
  }


  async editReplyDraft(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
    currentText: string;
  }): Promise<DouyinReplyDraft> {
    await this.requireProject(input.projectId);
    return this.replyDrafts.edit(input);
  }

  async rejectReplyDraft(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
  }): Promise<DouyinReplyDraft> {
    await this.requireProject(input.projectId);
    return this.replyDrafts.reject(input);
  }

  async publishReplyDraft(input: {
    projectId: string;
    draftId: string;
    expectedRevision: number;
    writeIntentId: string;
    confirmed: boolean;
  }): Promise<DouyinReplyPublishResult> {
    await this.requireProject(input.projectId);
    return this.replyPublisher.publish(input);
  }

  async confirmBinding(input: {
    projectId: string;
    awemeId: string;
    externalUrl?: string;
    confirmed: boolean;
  }): Promise<DouyinWorkBinding> {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "需要明确确认后才能绑定抖音作品"
      );
    }
    await this.requireProject(input.projectId);
    const state = await this.packageState(input.projectId);
    if (!state.pkg) {
      throw new DomainValidationError(
        "当前项目还没有发布包，无法绑定抖音作品"
      );
    }
    const decision =
      this.workBinding.confirmUserSelection({
        pkg: state.pkg,
        receipt: state.receipt,
        awemeId: input.awemeId,
        ...(input.externalUrl
          ? { externalUrl: input.externalUrl }
          : {})
      });
    return this.metrics.persistBinding({
      projectId: input.projectId,
      decision,
      ...(state.pkg.publishedConfirmedAt
        ? { publishedAt: state.pkg.publishedConfirmedAt }
        : {})
    });
  }
}
