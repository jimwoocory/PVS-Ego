import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { DouyinPublishProvider } from "../ports/douyin-publish-provider.js";
import type {
  FinalOutputRepository,
  PublishAttempt
} from "../ports/final-output-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { DomainValidationError } from "../../domain/validation.js";

const PUBLISH_RESUME = "publish.douyin.oauth";

export class DouyinPublishService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly finalOutput: FinalOutputRepository,
    private readonly provider: DouyinPublishProvider,
    private readonly projectsRoot: string
  ) {}

  async probe(projectId: string) {
    const probe = await this.provider.probe(projectId);
    const open = await this.workflow.listOpenBlockers(projectId);
    if (probe.code === "READY") {
      for (const blocker of open) {
        if (
          blocker.scope === "PROVIDER" &&
          blocker.resumeCheckpoint === PUBLISH_RESUME &&
          !blocker.resolvedAt
        ) {
          await this.workflow.resolveBlocker(
            blocker.id,
            new Date().toISOString()
          );
        }
      }
      return probe;
    }

    const existing = open.find(
      (item) =>
        item.scope === "PROVIDER" &&
        item.resumeCheckpoint === PUBLISH_RESUME &&
        !item.resolvedAt
    );
    if (!existing) {
      await this.workflow.createBlocker({
        id: randomUUID(),
        projectId,
        scope: "PROVIDER",
        reasonCode:
          probe.code === "AUTH_REQUIRED"
            ? "AUTHENTICATION_REQUIRED"
            : "OTHER",
        message: `抖音发布暂不可用：${probe.reason}`,
        requiredUserAction:
          probe.code === "AUTH_REQUIRED"
            ? "点击“连接抖音账号”，在抖音官方授权页完成 video.create 授权后返回。"
            : "先配置抖音开放平台 ClientKey、ClientSecret、回调地址并申请 video.create 权限。",
        resumeCheckpoint: PUBLISH_RESUME,
        createdAt: new Date().toISOString()
      });
    }
    return probe;
  }

  async beginOAuth(projectId: string): Promise<{ authorizationUrl: string }> {
    return this.provider.beginOAuth(projectId);
  }

  async completeOAuth(input: { code: string; state: string }) {
    const result = await this.provider.completeOAuth(input);
    await this.probe(result.projectId);
    return result;
  }

  async publish(input: {
    projectId: string;
    title: string;
    description?: string;
    confirmed: boolean;
  }): Promise<PublishAttempt> {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "Publishing to Douyin requires explicit user confirmation for this publish action"
      );
    }
    const title = input.title.trim();
    if (!title) {
      throw new DomainValidationError("Douyin publish title is required");
    }

    const assembly = await this.finalOutput.latestAssembly(input.projectId);
    if (!assembly || assembly.status !== "ACCEPTED") {
      throw new DomainValidationError(
        "An ACCEPTED final video is required before publishing"
      );
    }
    const artifact = await this.artifacts.findById(assembly.outputArtifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.kind !== "FINAL_VIDEO" ||
      artifact.integrityStatus !== "READY" ||
      artifact.sha256 !== assembly.outputArtifactHash
    ) {
      throw new DomainValidationError("Final video Artifact is not READY");
    }

    const probe = await this.probe(input.projectId);
    const now = new Date().toISOString();
    if (probe.code !== "READY") {
      return this.finalOutput.createPublishAttempt({
        id: randomUUID(),
        projectId: input.projectId,
        finalAssemblyId: assembly.id,
        platform: "douyin",
        status: "AUTH_REQUIRED",
        title,
        ...(input.description?.trim()
          ? { description: input.description.trim() }
          : {}),
        errorCode: probe.code,
        errorMessage: probe.reason,
        createdAt: now,
        confirmedAt: now
      });
    }

    let attempt = await this.finalOutput.createPublishAttempt({
      id: randomUUID(),
      projectId: input.projectId,
      finalAssemblyId: assembly.id,
      platform: "douyin",
      status: "UPLOADING",
      title,
      ...(input.description?.trim()
        ? { description: input.description.trim() }
        : {}),
      createdAt: now,
      confirmedAt: now
    });
    await this.productFlow.setProjectStatus(input.projectId, "PUBLISHING");

    try {
      const store = new LocalArtifactStore(
        path.resolve(this.projectsRoot, input.projectId),
        this.artifacts
      );
      const videoPath = store.resolveArtifactPath(artifact.relativePath);
      const result = await this.provider.publish({
        projectId: input.projectId,
        videoPath,
        title,
        ...(input.description?.trim()
          ? { description: input.description.trim() }
          : {})
      });
      attempt = await this.finalOutput.updatePublishAttempt(attempt.id, {
        status: "PUBLISHED",
        externalVideoId: result.videoId,
        externalItemId: result.itemId,
        completedAt: new Date().toISOString()
      });
      await this.productFlow.setProjectStatus(input.projectId, "PUBLISHED");
      return attempt;
    } catch (error) {
      attempt = await this.finalOutput.updatePublishAttempt(attempt.id, {
        status: "FAILED",
        errorCode: "DOUYIN_PUBLISH_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      await this.productFlow.setProjectStatus(
        input.projectId,
        "READY_TO_PUBLISH"
      );
      return attempt;
    }
  }
}
