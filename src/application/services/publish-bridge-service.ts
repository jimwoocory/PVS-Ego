import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { FinalOutputRepository } from "../ports/final-output-repository.js";
import type { PublishRepository } from "../ports/publish-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import { PublishProviderRegistry } from "./publish-provider-registry.js";
import type {
  PublishPackage,
  PublishProviderType,
  PublishReceipt
} from "../../domain/publish.js";
import {
  publishPackageSchema,
  publishPlatformIdentitySchema,
  publishProviderTypeSchema,
  publishReceiptSchema
} from "../../domain/publish.js";
import { sha256Bytes, sha256Text } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { PublishSubmissionUnknownError } from "../ports/publish-provider.js";
import type {DouyinBrowserPublisherRuntime} from "../ports/douyin-browser-publisher-runtime.js";
import type {BrowserPublishCheckpointRepository,BrowserPublishScope} from "../ports/browser-publish-preparation.js";
import {BrowserPublishPreparationService} from "./browser-publish-preparation-service.js";
import {extractBrowserTopics} from "../../adapters/publish/douyin-browser-automation-provider.js";

const DEFAULT_PROVIDER: PublishProviderType = "DOUYIN_BROWSER_AUTOMATION";
const PACKAGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const MEDIA_TTL_MS = 15 * 60 * 1000;

export type PublicPublishPackage = Omit<
  PublishPackage,
  "singleUseTokenHash" | "sessionTokenHash" | "mediaTokenHash"
>;

function publicPackage(input: PublishPackage): PublicPublishPackage {
  const {
    singleUseTokenHash: _singleUseTokenHash,
    sessionTokenHash: _sessionTokenHash,
    mediaTokenHash: _mediaTokenHash,
    ...safe
  } = input;
  return safe;
}

function absoluteBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainValidationError("Public base URL must use http/https");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function expiryWithin(parentExpiry: string, maxMs: number, now: number): string {
  const parent = Date.parse(parentExpiry);
  return new Date(Math.min(parent, now + maxMs)).toISOString();
}

export class PublishBridgeService {
  readonly browserPreparation?:BrowserPublishPreparationService;
  readonly browserPreparationSupported:boolean;
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly artifacts: ArtifactRepository,
    private readonly finalOutput: FinalOutputRepository,
    private readonly publishRepo: PublishRepository,
    private readonly providers: PublishProviderRegistry,
    private readonly projectsRoot: string,
    browser?:{runtime:DouyinBrowserPublisherRuntime;checkpoints:BrowserPublishCheckpointRepository}
  ) {
    this.browserPreparationSupported=Boolean(browser?.runtime.staged);
    if(browser)this.browserPreparation=new BrowserPublishPreparationService(browser.checkpoints,browser.runtime.staged,async(projectId,packageId,expectedAccountId,previous)=>{
      const pkg=await this.publishRepo.findPackageById(packageId);
      if(!pkg||pkg.projectId!==projectId||pkg.providerType!=="DOUYIN_BROWSER_AUTOMATION"||!["PACKAGE_READY","AWAITING_USER_ACTION"].includes(pkg.status)||Date.parse(pkg.expiresAt)<=Date.now())throw new DomainValidationError("原发布包不存在、已提交/结果未知或许可已过期，禁止重提");
      const others=await this.publishRepo.listPackages(projectId);
      if(others.some(other=>other.id!==pkg.id&&(other.finalArtifactHash===pkg.finalArtifactHash||other.finalAssemblyId===pkg.finalAssemblyId)&&["DIRECT_PUBLISHING","SUBMISSION_UNKNOWN","PUBLISHED_CONFIRMED"].includes(other.status)))throw new DomainValidationError("该成片已有提交或未知结果，不能通过新发布包重新上传/提交");
      for(const other of others.filter(other=>other.id!==pkg.id&&(other.finalArtifactHash===pkg.finalArtifactHash||other.finalAssemblyId===pkg.finalAssemblyId))){const checkpoint=await browser.checkpoints.latest(projectId,other.id);if(checkpoint&&["SUBMITTING","SUBMISSION_UNKNOWN","PUBLISHED_CONFIRMED"].includes(checkpoint.phase))throw new DomainValidationError("该成片已有提交检查点或未知结果，不能通过新发布包重新上传/提交");}
      const {assembly,artifact}=await this.acceptedFinal(projectId);
      if(assembly.id!==pkg.finalAssemblyId||artifact.id!==pkg.finalArtifactId||artifact.sha256!==pkg.finalArtifactHash)throw new DomainValidationError("当前成片与原发布包不一致");
      const file=await this.verifyPackageArtifact(pkg),accountKey=await browser.runtime.resolveAccountName();
      if(previous&&accountKey!==previous.accountKey)throw new DomainValidationError("当前账号配置已改变，不能切换账号续接");
      // While the user owns the page, only local package/file/config checks run here. Actual page identity is checked after explicit return.
      if(!previous){const account=await browser.runtime.check(accountKey);if(!account.valid||account.account!==accountKey||!expectedAccountId?.trim()||account.platformUserId!==expectedAccountId)throw new DomainValidationError("预检需要明确匹配的账号强身份，不能用昵称或其他类型标识替代");}
      const copy=extractBrowserTopics(pkg.descriptionDraft);
      const scope:BrowserPublishScope={projectId,packageId,providerType:"DOUYIN_BROWSER_AUTOMATION",assemblyId:pkg.finalAssemblyId,artifactId:pkg.finalArtifactId,videoSha256:pkg.finalArtifactHash,title:pkg.titleDraft,description:copy.description,tags:copy.tags,declaration:"内容由AI生成",accountKey,account:{type:"DOUYIN_UNIQUE_ID",id:expectedAccountId},runtimeId:browser.runtime.staged?.identity??"UNSUPPORTED",expiresAt:pkg.expiresAt};
      return {scope,videoPath:file.absolutePath};
    },this.publishRepo);
  }

  async getPreference(projectId: string) {
    const stored = await this.publishRepo.getPreference(projectId);
    return (
      stored ?? {
        projectId,
        providerType: DEFAULT_PROVIDER,
        updatedAt: new Date(0).toISOString()
      }
    );
  }

  async setPreference(
    projectId: string,
    providerTypeInput: string
  ) {
    const providerType = publishProviderTypeSchema.parse(providerTypeInput);
    this.providers.get(providerType);
    const project = await this.productFlow.getProject(projectId);
    if (!project) throw new DomainValidationError("Project not found");
    return this.publishRepo.setPreference(
      projectId,
      providerType,
      new Date().toISOString()
    );
  }

  async providerStatus(projectId: string) {
    const [preference, probes] = await Promise.all([
      this.getPreference(projectId),
      this.providers.probes(projectId)
    ]);
    return { preference, probes };
  }

  private async acceptedFinal(projectId: string) {
    const assembly = await this.finalOutput.latestAssembly(projectId);
    if (!assembly || assembly.status !== "ACCEPTED") {
      throw new DomainValidationError(
        "An ACCEPTED final video is required before publishing"
      );
    }
    const artifact = await this.artifacts.findById(assembly.outputArtifactId);
    if (
      !artifact ||
      artifact.projectId !== projectId ||
      artifact.kind !== "FINAL_VIDEO" ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256 ||
      artifact.sha256 !== assembly.outputArtifactHash
    ) {
      throw new DomainValidationError("最终成片尚不可用");
    }
    return { assembly, artifact };
  }

  async createPackage(input: {
    projectId: string;
    title: string;
    description?: string;
    coverArtifactId?: string;
    providerType?: PublishProviderType;
    publicBaseUrl: string;
    ttlMs?: number;
  }): Promise<{
    package: PublicPublishPackage;
    claimToken: string;
    claimUrl: string;
  }> {
    const title = input.title.trim();
    if (!title) throw new DomainValidationError("Publish title is required");
    const { assembly, artifact } = await this.acceptedFinal(input.projectId);
    const preference = await this.getPreference(input.projectId);
    const providerType = input.providerType ?? preference.providerType;
    const provider = this.providers.get(providerType);
    const probe = await provider.probe(input.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        provider.displayName +
          " is not ready: " +
          (probe.reason ?? probe.code)
      );
    }

    if (input.coverArtifactId) {
      const cover = await this.artifacts.findById(input.coverArtifactId);
      if (
        !cover ||
        cover.projectId !== input.projectId ||
        cover.integrityStatus !== "READY" ||
        !cover.mimeType?.startsWith("image/")
      ) {
        throw new DomainValidationError("封面图片尚不可用");
      }
    }

    const now = Date.now();
    const token = randomToken();
    const id = randomUUID();
    const value = publishPackageSchema.parse({
      id,
      projectId: input.projectId,
      finalAssemblyId: assembly.id,
      finalArtifactId: artifact.id,
      finalArtifactHash: artifact.sha256,
      providerType,
      titleDraft: title,
      ...(input.description?.trim()
        ? { descriptionDraft: input.description.trim() }
        : {}),
      ...(input.coverArtifactId
        ? { coverArtifactId: input.coverArtifactId }
        : {}),
      expiresAt: new Date(
        now + Math.max(60_000, input.ttlMs ?? PACKAGE_TTL_MS)
      ).toISOString(),
      singleUseTokenHash: sha256Text(token),
      status: "PACKAGE_READY",
      createdAt: new Date(now).toISOString()
    });
    const stored = await this.publishRepo.createPackage(value);
    const base = absoluteBaseUrl(input.publicBaseUrl);
    const claimUrl =
      base +
      "/publish/mobile/" +
      encodeURIComponent(stored.id) +
      "#token=" +
      encodeURIComponent(token);
    return {
      package: publicPackage(stored),
      claimToken: token,
      claimUrl
    };
  }

  async claimPackage(input: {
    packageId: string;
    token: string;
  }): Promise<{
    package: PublicPublishPackage;
    sessionToken: string;
  }> {
    if (!input.token.trim()) {
      throw new DomainValidationError("缺少发布包领取凭证");
    }
    const now = Date.now();
    const existing = await this.publishRepo.findPackageById(input.packageId);
    if (!existing) throw new DomainValidationError("找不到该发布包");
    const sessionToken = randomToken();
    const claimed = await this.publishRepo.claimPackage({
      id: input.packageId,
      tokenHash: sha256Text(input.token),
      sessionTokenHash: sha256Text(sessionToken),
      sessionExpiresAt: expiryWithin(
        existing.expiresAt,
        SESSION_TTL_MS,
        now
      ),
      now: new Date(now).toISOString()
    });
    if (!claimed) {
      await this.publishRepo.expirePackages(new Date(now).toISOString());
      throw new DomainValidationError(
        "Publish claim token is invalid, expired, or already used"
      );
    }
    await this.publishRepo.createReceipt(
      publishReceiptSchema.parse({
        id: randomUUID(),
        projectId: claimed.projectId,
        packageId: claimed.id,
        providerType: claimed.providerType,
        kind: "PACKAGE_CLAIMED",
        trusted: false,
        note: "一次性 PublishPackage token 已消费。",
        createdAt: new Date(now).toISOString()
      })
    );
    return {
      package: publicPackage(claimed),
      sessionToken
    };
  }

  private async requireSession(
    packageId: string,
    sessionToken: string
  ): Promise<PublishPackage> {
    const value = await this.publishRepo.authorizeSession({
      id: packageId,
      sessionTokenHash: sha256Text(sessionToken),
      now: new Date().toISOString()
    });
    if (!value) {
      throw new DomainValidationError(
        "Publish session is invalid or expired"
      );
    }
    return value;
  }

  private async verifyPackageArtifact(pkg: PublishPackage) {
    const artifact = await this.artifacts.findById(pkg.finalArtifactId);
    if (
      !artifact ||
      artifact.projectId !== pkg.projectId ||
      artifact.kind !== "FINAL_VIDEO" ||
      artifact.integrityStatus !== "READY" ||
      artifact.sha256 !== pkg.finalArtifactHash
    ) {
      throw new DomainValidationError(
        "PublishPackage FINAL_VIDEO is not READY"
      );
    }
    const store = new LocalArtifactStore(
      path.resolve(this.projectsRoot, pkg.projectId),
      this.artifacts
    );
    const absolutePath = store.resolveArtifactPath(artifact.relativePath);
    const bytes = await fs.readFile(absolutePath);
    if (sha256Bytes(bytes) !== pkg.finalArtifactHash) {
      throw new DomainValidationError(
        "PublishPackage FINAL_VIDEO bytes changed"
      );
    }
    return { artifact, absolutePath };
  }

  async startHandoff(input: {
    packageId: string;
    sessionToken: string;
    publicBaseUrl: string;
  }) {
    const pkg = await this.requireSession(
      input.packageId,
      input.sessionToken
    );
    const provider = this.providers.get(pkg.providerType);
    if (!provider.prepareHandoff || provider.mode === "DIRECT") {
      throw new DomainValidationError(
        "Selected provider does not support handoff"
      );
    }
    const probe = await provider.probe(pkg.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        provider.displayName +
          " is not ready: " +
          (probe.reason ?? probe.code)
      );
    }
    await this.verifyPackageArtifact(pkg);

    const now = Date.now();
    const mediaToken = randomToken();
    const mediaExpiresAt = expiryWithin(
      pkg.expiresAt,
      MEDIA_TTL_MS,
      now
    );
    await this.publishRepo.updatePackage(pkg.id, {
      mediaTokenHash: sha256Text(mediaToken),
      mediaExpiresAt
    });

    const base = absoluteBaseUrl(input.publicBaseUrl);
    const mediaUrl =
      base +
      "/api/publish/packages/" +
      encodeURIComponent(pkg.id) +
      "/media?media_token=" +
      encodeURIComponent(mediaToken);
    const bridgeUrl =
      base + "/publish/mobile/" + encodeURIComponent(pkg.id);

    const handoff = await provider.prepareHandoff({
      projectId: pkg.projectId,
      packageId: pkg.id,
      title: pkg.titleDraft,
      ...(pkg.descriptionDraft
        ? { description: pkg.descriptionDraft }
        : {}),
      bridgeUrl,
      videoUrl: mediaUrl
    });
    const updated = await this.publishRepo.updatePackage(pkg.id, {
      status: handoff.awaitingUserAction
        ? "AWAITING_USER_ACTION"
        : "HANDOFF_STARTED",
      handoffReference: handoff.handoffReference ?? pkg.id,
      handoffStartedAt: new Date(now).toISOString()
    });
    await this.publishRepo.createReceipt(
      publishReceiptSchema.parse({
        id: randomUUID(),
        projectId: pkg.projectId,
        packageId: pkg.id,
        providerType: pkg.providerType,
        kind: "HANDOFF_STARTED",
        trusted: false,
        ...(handoff.handoffReference
          ? { externalReference: handoff.handoffReference }
          : {}),
        createdAt: new Date(now).toISOString()
      })
    );
    if (pkg.providerType !== "MANUAL_EXPORT") {
      await this.productFlow.setProjectStatus(pkg.projectId, "PUBLISHING");
    }
    return {
      package: publicPackage(updated),
      handoff
    };
  }

  async completeHandoff(input: {
    packageId: string;
    sessionToken: string;
    note?: string;
  }) {
    const pkg = await this.requireSession(
      input.packageId,
      input.sessionToken
    );
    if (
      pkg.status !== "AWAITING_USER_ACTION" &&
      pkg.status !== "HANDOFF_STARTED"
    ) {
      throw new DomainValidationError(
        "PublishPackage is not awaiting handoff completion"
      );
    }
    const now = new Date().toISOString();
    const updated = await this.publishRepo.updatePackage(pkg.id, {
      status: "HANDOFF_COMPLETED",
      completedAt: now
    });
    await this.publishRepo.createReceipt(
      publishReceiptSchema.parse({
        id: randomUUID(),
        projectId: pkg.projectId,
        packageId: pkg.id,
        providerType: pkg.providerType,
        kind: "HANDOFF_COMPLETED",
        trusted: false,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        createdAt: now
      })
    );
    await this.productFlow.setProjectStatus(
      pkg.projectId,
      "READY_TO_PUBLISH"
    );
    return publicPackage(updated);
  }

  async directPublish(input: {
    projectId: string;
    packageId: string;
    confirmed: boolean;
    expectedAccountId?: string;
    preparedScopeHash?:string;
    preparedRevision?:number;
  }) {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "Direct publishing requires explicit user confirmation"
      );
    }
    const pkg = await this.publishRepo.findPackageById(input.packageId);
    if (!pkg || pkg.projectId !== input.projectId) {
      throw new DomainValidationError("当前项目中找不到该发布包");
    }
    const replay = await this.replayDirectPublication(pkg);
    if (replay) return replay;
    const browserCheckpoint=await this.browserPreparation?.status(pkg.projectId,pkg.id);
    if(pkg.providerType==="DOUYIN_BROWSER_AUTOMATION"&&this.browserPreparationSupported&&!browserCheckpoint)throw new DomainValidationError("当前分阶段候选必须先完成本次预检，再单独确认提交");
    if(browserCheckpoint&&!["READY_FOR_CONFIRMATION","RESTORED_WAITING_CONTINUE"].includes(browserCheckpoint.phase))throw new DomainValidationError("当前正在等待验证/用户接管、执行中或结果未知，禁止直接提交和重复上传");
    if ((browserCheckpoint?pkg.status!=="AWAITING_USER_ACTION":pkg.status !== "PACKAGE_READY") || pkg.handoffStartedAt || pkg.publishedConfirmedAt) {
      throw new DomainValidationError(
        "该发布包已提交、结果待核对或已失效，禁止重复发布；请先核对已有发布记录"
      );
    }
    if (Date.parse(pkg.expiresAt) <= Date.now()) {
      throw new DomainValidationError("发布包已过期，请重新确认当前成片并创建发布包");
    }
    const { assembly, artifact } = await this.acceptedFinal(pkg.projectId);
    if (assembly.id !== pkg.finalAssemblyId || artifact.id !== pkg.finalArtifactId ||
        artifact.sha256 !== pkg.finalArtifactHash) {
      throw new DomainValidationError("发布包已不对应当前已确认成片，请重新创建发布包");
    }
    const provider = this.providers.get(pkg.providerType);
    if (provider.mode !== "DIRECT" || !provider.directPublish) {
      throw new DomainValidationError(
        "Selected provider is not a direct-publish provider"
      );
    }
    const probe = await provider.probe(pkg.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        provider.displayName +
          " is not ready: " +
          (probe.reason ?? probe.code)
      );
    }
    const expectedAccountId = input.expectedAccountId?.trim();
    if (input.expectedAccountId !== undefined && (!expectedAccountId ||
        expectedAccountId !== probe.platformUserId?.trim())) {
      throw new DomainValidationError("发布账号与本次确认的账号不一致，请刷新账号状态并重新确认");
    }
    const { absolutePath } = await this.verifyPackageArtifact(pkg);
    const prepared=browserCheckpoint?await this.browserPreparation!.authorizeSubmit({projectId:pkg.projectId,packageId:pkg.id,confirmed:input.confirmed,expectedAccountId,scopeHash:input.preparedScopeHash,revision:input.preparedRevision}):undefined;
    const startedAt = new Date().toISOString();
    const claimed = await this.publishRepo.claimDirectPublish({
      id: pkg.id, projectId: pkg.projectId, now: startedAt,
      ...(prepared?{preparedCheckpointId:prepared.id}:{})
    });
    if (!claimed) {
      const current = await this.publishRepo.findPackageById(pkg.id);
      const completed = current ? await this.replayDirectPublication(current) : null;
      if (completed) return completed;
      throw new DomainValidationError("该发布包正在提交、已过期或已提交，禁止重复发布；请先核对已有任务");
    }

    let providerReturned = false;
    let acceptedReference: string | undefined;
    try {
      await this.productFlow.setProjectStatus(pkg.projectId, "PUBLISHING");
      const result = await provider.directPublish({
        projectId: pkg.projectId,
        packageId: pkg.id,
        videoPath: absolutePath,
        title: pkg.titleDraft,
        ...(prepared?{browserPreparedSession:{binding:prepared.binding!,scope:prepared.scope}}:{}),
        ...((expectedAccountId || probe.platformUserId?.trim()) ? {
          expectedAccountId: expectedAccountId || probe.platformUserId!.trim()
        } : {}),
        ...(pkg.descriptionDraft
          ? { description: pkg.descriptionDraft }
          : {})
      });
      // Any subsequent local persistence error must not turn an accepted platform action into retryable failure.
      providerReturned = true;
      acceptedReference = result.externalReference;
      const rawIdentity = {
        ...(result.videoId ? { videoId: result.videoId } : {}),
        ...(result.itemId ? { itemId: result.itemId } : {}),
        ...result.platformIdentity
      };
      const platformIdentity = Object.keys(rawIdentity).length
        ? publishPlatformIdentitySchema.parse(rawIdentity) : undefined;
      const now = new Date().toISOString();
      const receipt = await this.publishRepo.createReceipt(
        publishReceiptSchema.parse({
          id: randomUUID(),
          projectId: pkg.projectId,
          packageId: pkg.id,
          providerType: pkg.providerType,
          kind: "PUBLISHED_CONFIRMED",
          trusted: true,
          externalReference: result.externalReference,
          ...(platformIdentity ? { platformIdentity } : {}),
          evidenceHash: sha256Text(
            JSON.stringify({
              providerType: pkg.providerType,
              externalReference: result.externalReference,
              videoId: result.videoId,
              itemId: result.itemId,
              platformIdentity
            })
          ),
          createdAt: now
        })
      );
      const updated = await this.applyTrustedPublishedReceipt(pkg, receipt);
      if(prepared)await this.browserPreparation!.finish(prepared,"PUBLISHED_CONFIRMED");
      return { package: publicPackage(updated), receipt };
    } catch (error) {
      const now = new Date().toISOString();
      if (prepared || providerReturned || error instanceof PublishSubmissionUnknownError) {
        const message = providerReturned
          ? "平台已返回发布结果，但本地确认记录未完整保存；请先核对平台作品，禁止重复发布。"
          : error instanceof Error ? error.message : "发布结果未知，禁止重复发布";
        const externalReference = acceptedReference ||
          (error instanceof PublishSubmissionUnknownError ? error.externalReference : undefined);
        // The durable DIRECT_PUBLISHING claim remains a no-resubmit fence even if the database is unavailable.
        await this.publishRepo.updatePackage(pkg.id, {
          status: "SUBMISSION_UNKNOWN",
          errorCode: "SUBMISSION_UNKNOWN",
          errorMessage: message,
          completedAt: now
        }).catch(() => undefined);
        if(prepared)await this.browserPreparation!.finish(prepared,"SUBMISSION_UNKNOWN").catch(()=>undefined);
        await this.publishRepo.createReceipt(
          publishReceiptSchema.parse({
            id: randomUUID(),
            projectId: pkg.projectId,
            packageId: pkg.id,
            providerType: pkg.providerType,
            kind: "SUBMISSION_UNKNOWN",
            trusted: false,
            ...(externalReference ? { externalReference } : {}),
            note:
              "无法可靠确认平台是否接受发布动作或作品结果。为避免重复发布，禁止自动重试。",
            createdAt: now
          })
        ).catch(() => undefined);
        await this.productFlow.setProjectStatus(
          pkg.projectId,
          "READY_TO_PUBLISH"
        ).catch(() => undefined);
        throw new DomainValidationError(
          message
        );
      }
      const updated = await this.publishRepo.updatePackage(pkg.id, {
        status: "FAILED",
        errorCode: "DIRECT_PUBLISH_FAILED",
        errorMessage:
          error instanceof Error ? error.message : String(error),
        completedAt: now
      });
      await this.publishRepo.createReceipt(
        publishReceiptSchema.parse({
          id: randomUUID(),
          projectId: pkg.projectId,
          packageId: pkg.id,
          providerType: pkg.providerType,
          kind: "FAILED",
          trusted: false,
          note:
            error instanceof Error ? error.message : String(error),
          createdAt: now
        })
      );
      await this.productFlow.setProjectStatus(
        pkg.projectId,
        "READY_TO_PUBLISH"
      );
      throw new DomainValidationError(
        updated.errorMessage ?? "Direct publish failed"
      );
    }
  }

  /** A trusted receipt is durable proof, even if a crash interrupted the following package/project updates. */
  private async replayDirectPublication(pkg: PublishPackage) {
    const receipt = (await this.publishRepo.listReceiptsForPackage(pkg.id)).reverse().find(item =>
      item.packageId === pkg.id && item.projectId === pkg.projectId && item.providerType === pkg.providerType &&
      item.kind === "PUBLISHED_CONFIRMED" && item.trusted === true
    );
    if (!receipt) return null;
    const updated = pkg.status === "PUBLISHED_CONFIRMED"
      ? pkg : await this.applyTrustedPublishedReceipt(pkg, receipt);
    return { package: publicPackage(updated), receipt };
  }

  private async applyTrustedPublishedReceipt(
    pkg: PublishPackage,
    receipt: PublishReceipt
  ): Promise<PublishPackage> {
    if (
      receipt.kind !== "PUBLISHED_CONFIRMED" ||
      receipt.trusted !== true ||
      receipt.packageId !== pkg.id
    ) {
      throw new DomainValidationError(
        "Only a trusted PUBLISHED_CONFIRMED receipt can confirm publication"
      );
    }
    const now = receipt.createdAt;
    const updated = await this.publishRepo.updatePackage(pkg.id, {
      status: "PUBLISHED_CONFIRMED",
      completedAt: now,
      publishedConfirmedAt: now,
      handoffReference:
        receipt.externalReference ?? pkg.handoffReference ?? pkg.id
    });
    await this.productFlow.setProjectStatus(pkg.projectId, "PUBLISHED");
    return updated;
  }

  async mediaBySession(input: {
    packageId: string;
    sessionToken: string;
  }) {
    const pkg = await this.requireSession(
      input.packageId,
      input.sessionToken
    );
    return this.verifyPackageArtifact(pkg);
  }

  async mediaByToken(input: {
    packageId: string;
    mediaToken: string;
  }) {
    const pkg = await this.publishRepo.authorizeMedia({
      id: input.packageId,
      mediaTokenHash: sha256Text(input.mediaToken),
      now: new Date().toISOString()
    });
    if (!pkg) {
      throw new DomainValidationError(
        "Publish media token is invalid or expired"
      );
    }
    return this.verifyPackageArtifact(pkg);
  }

  async packageForSession(input: {
    packageId: string;
    sessionToken: string;
  }) {
    return publicPackage(
      await this.requireSession(input.packageId, input.sessionToken)
    );
  }

  async audit(projectId: string) {
    await this.publishRepo.expirePackages(new Date().toISOString());
    const [preference, packages, receipts] = await Promise.all([
      this.getPreference(projectId),
      this.publishRepo.listPackages(projectId),
      this.publishRepo.listReceipts(projectId)
    ]);
    return {
      preference,
      packages: packages.map(publicPackage),
      receipts,
      browserPreparationSupported:this.browserPreparationSupported,
      browserCheckpoints:this.browserPreparation?await Promise.all(packages.map(pkg=>this.browserPreparation!.status(projectId,pkg.id))):[]
    };
  }
}
