import type { V8PaidRequestGuard } from "./v8-paid-request-guard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { ProviderAuditRepository } from "../ports/provider-audit-repository.js";
import type {
  ProviderCommandEvidenceSource,
  ProviderCommandOperation,
  VideoProvider
} from "../ports/video-provider.js";
import { SubmissionOutcomeUnknownError } from "../ports/video-provider.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import {
  commandAttemptRecordSchema,
  type CommandAttemptRecord,
  type GenerationAttempt,
  type GenerationRequest,
  type WorkflowBlocker
} from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { assessGeneratedMediaAspectRatio } from "./generated-media-spec-qc.js";
import { captureActualClipTailFrame } from "./actual-tail-frame-capture.js";
import { sha256Bytes } from "../../domain/hashing.js";
import { withSerialOperation } from "./serial-operation.js";
import { assertAttemptBinding } from "./submission-service.js";
import type {CreativeReferenceGuard} from "./creative-reference-binding.js";
import type { ReviewRepository } from "../ports/review-repository.js";

const REDACTION_RULES_VERSION = "p0-redact-v1";
const PARSER_VERSION = "p0-provider-v1";

export class GenerationExecutionService {
  constructor(
    private readonly generation: GenerationRepository,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly providerAudit: ProviderAuditRepository,
    private readonly provider: VideoProvider,
    private readonly projectsRoot: string,
    private readonly review?: Pick<ReviewRepository, "listDecisions">,
    private readonly references?: CreativeReferenceGuard,
    private readonly inspectOutputMedia: typeof inspectMedia = inspectMedia,
    private readonly sanitizeOutputAudio: (
      file: string,
      request: GenerationRequest,
      tempDir: string
    ) => Promise<{
      path: string;
      nativeAudioState:
        | "NOT_REQUESTED"
        | "PRESERVED_VERIFIED_NO_MUSIC"
        | "PRESERVED_V3_NATIVE_BGM_SUSPECTED"
        | "STRIPPED_MUSIC_OR_UNCERTAIN"
        | "ABSENT";
      reason?: string;
    }> = async (file, request) => ({
      path: file,
      nativeAudioState: request.generateAudio
        ? "PRESERVED_VERIFIED_NO_MUSIC"
        : "NOT_REQUESTED"
    }),
    private readonly v8Guard?: V8PaidRequestGuard
  ) {}

  private async requireAttempt(id: string): Promise<GenerationAttempt> {
    const attempt = await this.workflow.getGenerationAttempt(id);
    if (!attempt) throw new DomainValidationError(`Attempt not found: ${id}`);
    return attempt;
  }

  private async beginCommand(
    attempt: GenerationAttempt,
    operation: CommandAttemptRecord["operation"]
  ): Promise<CommandAttemptRecord> {
    const commandAttemptNumber =
      attempt.commandAttempts.filter((item) => item.operation === operation).length + 1;
    const record = commandAttemptRecordSchema.parse({
      id: randomUUID(),
      operation,
      attemptNumber: commandAttemptNumber,
      startedAt: new Date().toISOString(),
      timedOut: false,
      redactionRulesVersion: REDACTION_RULES_VERSION,
      parserVersion: PARSER_VERSION
    });
    await this.providerAudit.createCommandAttempt({
      ...record,
      projectId: attempt.projectId,
      generationAttemptId: attempt.id,
      argvRedacted: ["dreamina", `<verified-${operation.toLowerCase()}-command>`]
    });
    await this.workflow.updateGenerationAttemptStatus(attempt.id, {
      status: attempt.status,
      commandAttempts: [...attempt.commandAttempts, record]
    });
    return record;
  }

  private async collectProviderEvidence(
    attempt: GenerationAttempt,
    record: CommandAttemptRecord,
    operation: ProviderCommandOperation
  ): Promise<
    Partial<
      Pick<
        CommandAttemptRecord,
        "stdoutArtifactId" | "stderrArtifactId" | "exitCode" | "timedOut"
      >
    > & { argvRedacted?: string[] }
  > {
    const candidate = this.provider as VideoProvider &
      Partial<ProviderCommandEvidenceSource>;
    if (typeof candidate.drainCommandEvidence !== "function") return {};
    const evidence = candidate.drainCommandEvidence(operation);
    if (!evidence.length) return {};

    const projectRoot = path.join(this.projectsRoot, attempt.projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const stdoutText = evidence
      .map((item) => item.stdoutRedacted)
      .join("\n--- provider command boundary ---\n");
    const stderrText = evidence
      .map((item) => item.stderrRedacted)
      .join("\n--- provider command boundary ---\n");
    const base = `logs/provider/${attempt.id}/${record.id}-${operation.toLowerCase()}`;
    const [stdoutArtifact, stderrArtifact] = await Promise.all([
      store.writeImmutable({
        id: randomUUID(),
        projectId: attempt.projectId,
        kind: "STDOUT",
        relativePath: base + "-stdout.txt",
        immutable: true,
        bytes: Buffer.from(stdoutText, "utf8"),
        mimeType: "text/plain"
      }),
      store.writeImmutable({
        id: randomUUID(),
        projectId: attempt.projectId,
        kind: "STDERR",
        relativePath: base + "-stderr.txt",
        immutable: true,
        bytes: Buffer.from(stderrText, "utf8"),
        mimeType: "text/plain"
      })
    ]);
    const last = evidence[evidence.length - 1]!;
    return {
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      exitCode: last.exitCode,
      // A logical provider operation may contain a bounded recovery fallback.
      // Preserve all intermediate evidence in the artifacts above, but the
      // command record reflects the final outcome of that logical operation.
      timedOut: last.timedOut,
      argvRedacted: last.argvRedacted
    };
  }

  private async finishCommand(
    attemptId: string,
    record: CommandAttemptRecord,
    update: Partial<
      Pick<
        CommandAttemptRecord,
        | "completedAt"
        | "exitCode"
        | "signal"
        | "timedOut"
        | "stdoutArtifactId"
        | "stderrArtifactId"
        | "errorCode"
      >
    > & { argvRedacted?: string[] }
  ): Promise<void> {
    const { argvRedacted: _argvRedacted, ...recordUpdate } = update;
    const completed = commandAttemptRecordSchema.parse({
      ...record,
      ...recordUpdate
    });
    await this.providerAudit.updateCommandAttempt(record.id, update);
    const attempt = await this.requireAttempt(attemptId);
    const commandAttempts = attempt.commandAttempts.map((item) =>
      item.id === record.id ? completed : item
    );
    await this.workflow.updateGenerationAttemptStatus(attemptId, {
      status: attempt.status,
      commandAttempts
    });
  }

  private async ensureReconcileBlocker(
    attempt: GenerationAttempt
  ): Promise<WorkflowBlocker> {
    const open = await this.workflow.listOpenBlockers(attempt.projectId);
    const existing = open.find(
      (item) =>
        item.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED" &&
        item.relatedEntityId === attempt.id
    );
    if (existing) return existing;
    return this.workflow.createBlocker({
      id: randomUUID(),
      projectId: attempt.projectId,
      scope: "GENERATION_ATTEMPT",
      relatedEntityId: attempt.id,
      reasonCode: "SUBMISSION_RECONCILIATION_REQUIRED",
      message:
        "提交结果未知，可能已经产生生成任务或费用，禁止自动重提。",
      requiredUserAction:
        "先执行调和；若仍无结论，明确接受可能重复扣费后再发起新的重做流程。",
      resumeCheckpoint: "generation.reconcile",
      createdAt: new Date().toISOString()
    });
  }

  private async resolveReconcileBlocker(attempt: GenerationAttempt): Promise<void> {
    const open = await this.workflow.listOpenBlockers(attempt.projectId);
    for (const blocker of open) {
      if (
        blocker.reasonCode === "SUBMISSION_RECONCILIATION_REQUIRED" &&
        blocker.relatedEntityId === attempt.id
      ) {
        await this.workflow.resolveBlocker(
          blocker.id,
          new Date().toISOString()
        );
      }
    }
  }

  private async ensureProviderChangedBlocker(
    attempt: GenerationAttempt,
    message: string
  ): Promise<WorkflowBlocker> {
    const open = await this.workflow.listOpenBlockers(attempt.projectId);
    const existing = open.find(
      (item) =>
        item.reasonCode === "PROVIDER_CHANGED" &&
        item.scope === "PROVIDER" &&
        !item.resolvedAt
    );
    if (existing) return existing;
    return this.workflow.createBlocker({
      id: randomUUID(),
      projectId: attempt.projectId,
      scope: "PROVIDER",
      relatedEntityId: attempt.id,
      reasonCode: "PROVIDER_CHANGED",
      message,
      requiredUserAction:
        "重新运行 Provider probe 与 Preflight；必须基于当前 ProviderIdentity/Capability 创建新的 Request、Preflight、Approval 和 Attempt。",
      resumeCheckpoint: "preflight.provider-refresh",
      createdAt: new Date().toISOString()
    });
  }

  private async assertProviderStillMatchesApprovedRequest(
    attempt: GenerationAttempt,
    request: GenerationRequest
  ): Promise<void> {
    const command = await this.beginCommand(attempt, "PROBE");
    try {
      const probe = await this.provider.probe();
      let agentHelpChanged = false;
      if (
        probe.code === "READY" &&
        request.dreaminaOperation &&
        request.agentCapabilityHelpHash
      ) {
        if (typeof this.provider.inspectCommandHelp !== "function") {
          agentHelpChanged = true;
        } else {
          const inspected = await this.provider.inspectCommandHelp(
            request.dreaminaOperation
          );
          const helpText = [inspected.stdout, inspected.stderr]
            .filter(Boolean)
            .join("\n");
          const helpHash = createHash("sha256")
            .update(helpText, "utf8")
            .digest("hex");
          agentHelpChanged =
            helpHash !== request.agentCapabilityHelpHash;
        }
      }
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "PROBE"
      );
      const changed =
        probe.code !== "READY" ||
        probe.providerIdentityHash !== request.providerIdentityHash ||
        probe.capabilityFingerprint !== request.capabilityFingerprint ||
        agentHelpChanged;

      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? (probe.code === "READY" ? 0 : 1),
        ...(changed ? { errorCode: "PROVIDER_CHANGED" } : {})
      });

      if (!changed) return;

      await this.generation.markSubmissionChainStale(
        attempt.projectId,
        new Date().toISOString()
      );
      await this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: attempt.status,
        errorCode: "PROVIDER_CHANGED_BEFORE_SUBMIT",
        errorMessage:
          probe.code === "READY"
            ? agentHelpChanged
              ? "Dreamina command help changed after Agent approval; external submit was blocked."
              : "Provider identity/capability changed after approval; external submit was blocked."
            : `Provider is no longer READY (${probe.code}); external submit was blocked.`
      });
      await this.ensureProviderChangedBlocker(
        attempt,
        probe.code === "READY"
          ? "ProviderIdentity 或 CapabilityFingerprint 在审批后发生变化，旧审批链已失效。"
          : `Provider 在审批后变为 ${probe.code}，旧审批链已失效。`
      );
      throw new DomainValidationError(
        "Provider changed after approval; submission chain was marked STALE and external submit was blocked"
      );
    } catch (error) {
      if (
        error instanceof DomainValidationError &&
        /Provider changed after approval/.test(error.message)
      ) {
        throw error;
      }
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "PROBE"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 1,
        errorCode: "PROVIDER_REPROBE_FAILED"
      });
      await this.generation.markSubmissionChainStale(
        attempt.projectId,
        new Date().toISOString()
      );
      await this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: attempt.status,
        errorCode: "PROVIDER_REPROBE_FAILED",
        errorMessage:
          error instanceof Error ? error.message : String(error)
      });
      await this.ensureProviderChangedBlocker(
        attempt,
        "提交前重新核验 Provider 失败，旧审批链已失效。"
      );
      throw new DomainValidationError(
        "Provider re-probe failed before submit; submission chain was marked STALE"
      );
    }
  }

  async submitAttempt(attemptId: string): Promise<GenerationAttempt> {
    return withSerialOperation("dreamina:submit", () =>
      withSerialOperation("generation:" + attemptId, () => this.submitExclusive(attemptId)));
  }

  private async submitExclusive(attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.requireAttempt(attemptId);
    if (attempt.status !== "CREATED") {
      throw new DomainValidationError(
        `Attempt must be CREATED before submit, got ${attempt.status}`
      );
    }

    const siblingAttempts = await this.workflow.listGenerationAttempts(
      attempt.projectId
    );
    const newerAttempt = siblingAttempts.find(
      (item) =>
        item.clipId === attempt.clipId &&
        item.attemptNumber > attempt.attemptNumber
    );
    if (newerAttempt) {
      throw new DomainValidationError(
        "此生成尝试已被更新的尝试替代，请提交该镜头最新一次记录，避免重复生成或重复扣费"
      );
    }

    const [request, preflight, approval] = await Promise.all([
      this.generation.getGenerationRequest(attempt.generationRequestId),
      this.generation.getPreflightReport(attempt.preflightReportId),
      this.generation.getUserApproval(attempt.userApprovalId)
    ]);
    if (!request || !preflight || !approval) {
      throw new DomainValidationError("本次生成确认链不完整");
    }
    if(request.provider==="dreamina-canvas")throw new DomainValidationError("Canvas请求必须由原任务的Canvas预算执行通道处理，禁止回退旧CLI");
    assertAttemptBinding({ attempt, request, preflight, approval });
    if (request.v8Binding) {
      if (!this.v8Guard) throw new DomainValidationError("V8 提交校验器未配置，禁止付费提交");
      await this.v8Guard(request);
    }
    if(!request.agentTaskId)await this.references?.assertExpected(attempt.projectId,request.inputVersionRefs.find(r=>r.entityType==="CreativeReferenceSet"));

    const allArtifacts = await this.artifacts.listByProject(attempt.projectId);
    if (request.agentTaskId) {
      const adapted = request.assetManifest.filter(
        (entry) => entry.agentReferenceAdaptation
      );
      if (adapted.length) {
        const store = new LocalArtifactStore(
          path.resolve(this.projectsRoot, attempt.projectId),
          this.artifacts
        );
        const verifiedSources = new Set<string>();
        for (const entry of adapted) {
          const provenance = entry.agentReferenceAdaptation!;
          const key =
            provenance.sourceArtifactId + ":" + provenance.sourceArtifactHash;
          if (verifiedSources.has(key)) continue;
          const source = allArtifacts.find(
            (artifact) => artifact.id === provenance.sourceArtifactId
          );
          if (
            !source ||
            source.projectId !== attempt.projectId ||
            source.integrityStatus !== "READY" ||
            source.sha256 !== provenance.sourceArtifactHash
          ) {
            throw new DomainValidationError(
              "长参考视频来源已变化或不可用；派生关键帧不能脱离已确认来源提交"
            );
          }
          const sourcePath = store.resolveArtifactPath(source.relativePath);
          const sourceBytes = await fs.readFile(sourcePath).catch(() => null);
          if (
            !sourceBytes ||
            sha256Bytes(sourceBytes) !== provenance.sourceArtifactHash
          ) {
            throw new DomainValidationError(
              "长参考视频来源文件缺失或校验失败；不会只提交缓存关键帧"
            );
          }
          verifiedSources.add(key);
        }
      }
    }
    const gates = request.assetManifest.map((entry) => {
      const match = allArtifacts.find(
        (artifact) =>
          artifact.integrityStatus === "READY" &&
          artifact.sha256 === entry.artifactHash
      );
      return {
        artifactId: match?.id ?? entry.assetId,
        integrityStatus: match?.integrityStatus ?? ("MISSING" as const)
      };
    });

    const { assertSubmissionGate } = await import("../../domain/validation.js");
    assertSubmissionGate({
      request,
      preflight,
      approval,
      artifacts: gates
    });

    const claimed = this.workflow.claimCreatedAttempt
      ? await this.workflow.claimCreatedAttempt(attempt.id)
      : await this.workflow.updateGenerationAttemptStatus(attempt.id, { status: "SUBMITTING" });
    if (!claimed) throw new DomainValidationError("该镜头已被其他执行器领取，禁止重复提交");
    attempt = claimed;
    try {
      await this.assertProviderStillMatchesApprovedRequest(attempt, request);
      // A probe can be slow: an intervening re-plan/review must invalidate this submit too.
      const [freshReports, freshApprovals, currentRequests, siblings] = await Promise.all([
        this.generation.getPreflightReport(attempt.preflightReportId),
        this.generation.getUserApproval(attempt.userApprovalId),
        this.generation.listCurrentGenerationRequests(attempt.projectId),
        this.workflow.listGenerationAttempts(attempt.projectId)
      ]);
      if (!currentRequests.some((item) => item.id === request.id && item.requestHash === request.requestHash) ||
          !freshReports || !freshApprovals ||
          siblings.some((item) => item.clipId === attempt.clipId && item.attemptNumber > attempt.attemptNumber)) {
        throw new DomainValidationError("提交前计划或审批已更新，旧镜头不能继续提交");
      }
      assertSubmissionGate({ request, preflight: freshReports, approval: freshApprovals, artifacts: gates });
      assertAttemptBinding({ attempt, request, preflight: freshReports, approval: freshApprovals });
      if(!request.agentTaskId)await this.references?.assertExpected(attempt.projectId,request.inputVersionRefs.find(r=>r.entityType==="CreativeReferenceSet"));
      if (this.review) {
        const decision = (await this.review.listDecisions(attempt.projectId))
          .filter(item => item.clipId === attempt.clipId && (item.decision === "SKIP" || item.decision === "USE"))
          .sort((a,b) => b.decidedAt.localeCompare(a.decidedAt))[0];
        if (decision?.decision === "SKIP") throw new DomainValidationError("镜头在提交前已被用户跳过，不执行付费生成");
      }
    } catch (error) {
      // No paid submit has run. A hard crash here stays SUBMITTING and recovery fails closed.
      await this.workflow.updateGenerationAttemptStatus(attempt.id, { status: "CREATED" });
      throw error;
    }
    attempt = await this.requireAttempt(attempt.id);
    const command = await this.beginCommand(attempt, "SUBMIT");

    let providerReturned = false;
    try {
      const handle = await this.provider.submit(request);
      providerReturned = true;
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "SUBMIT"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 0,
        timedOut: evidence.timedOut ?? false
      });
      return this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: "SUBMITTED",
        providerHandle: handle,
        submittedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof SubmissionOutcomeUnknownError || providerReturned) {
        const evidence = await this.collectProviderEvidence(
          attempt,
          command,
          "SUBMIT"
        );
        await this.finishCommand(attempt.id, command, {
          ...evidence,
          completedAt: new Date().toISOString(),
          exitCode: evidence.exitCode ?? 1,
          errorCode: "SUBMISSION_OUTCOME_UNKNOWN"
        });
        const unknown = await this.workflow.updateGenerationAttemptStatus(
          attempt.id,
          {
            status: "SUBMISSION_OUTCOME_UNKNOWN",
            errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
            errorMessage: error instanceof Error ? error.message : String(error)
          }
        );
        await this.ensureReconcileBlocker(unknown);
        return unknown;
      }

      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "SUBMIT"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 1,
        errorCode: "SUBMIT_FAILED"
      });
      return this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: "FAILED",
        errorCode: "SUBMIT_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async pollAttempt(attemptId: string): Promise<GenerationAttempt> {
    return withSerialOperation("generation:" + attemptId, () => this.pollExclusive(attemptId));
  }

  private async pollExclusive(attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.requireAttempt(attemptId);
    const request=await this.generation.getGenerationRequest(attempt.generationRequestId);
    if(request?.provider==="dreamina-canvas")throw new DomainValidationError("Canvas状态必须按原任务的Canvas提交编号查询，禁止回退旧CLI");
    if (
      attempt.status !== "SUBMITTED" &&
      attempt.status !== "PROCESSING"
    ) {
      throw new DomainValidationError(
        `Attempt is not pollable: ${attempt.status}`
      );
    }
    if (!attempt.providerHandle) {
      throw new DomainValidationError("生成任务缺少平台任务信息");
    }

    const command = await this.beginCommand(attempt, "STATUS");
    try {
      const status = await this.provider.status(attempt.providerHandle);
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "STATUS"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 0
      });
      const mapped =
        status.status === "PROCESSING"
          ? "PROCESSING"
          : status.status === "SUCCEEDED"
            ? "SUCCEEDED"
            : status.status === "FAILED"
              ? "FAILED"
              : attempt.status;
      return this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: mapped,
        ...(mapped === "SUCCEEDED" || mapped === "FAILED"
          ? { completedAt: new Date().toISOString() }
          : {})
      });
    } catch (error) {
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "STATUS"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 1,
        errorCode: "STATUS_FAILED"
      });
      // Technical status failure never creates a new generation task and never
      // discards the durable handle.
      return this.requireAttempt(attempt.id);
    }
  }

  async downloadAttempt(attemptId: string): Promise<GenerationAttempt> {
    return withSerialOperation("generation:" + attemptId, () => this.downloadExclusive(attemptId));
  }

  private async downloadExclusive(attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.requireAttempt(attemptId);
    if (attempt.outputArtifactId) {
      const output = await this.artifacts.findById(attempt.outputArtifactId);
      if (output?.projectId === attempt.projectId && output.kind === "GENERATED_VIDEO" && output.integrityStatus === "READY") return attempt;
      throw new DomainValidationError("已记录的下载产物完整性异常，请先恢复产物，不创建重复下载记录");
    }
    if (
      attempt.status !== "SUCCEEDED" &&
      attempt.status !== "RECONCILED_SUCCEEDED"
    ) {
      throw new DomainValidationError(
        `Attempt is not downloadable: ${attempt.status}`
      );
    }
    if (!attempt.providerHandle) {
      throw new DomainValidationError("Attempt has no provider handle");
    }
    const request = await this.generation.getGenerationRequest(
      attempt.generationRequestId
    );
    if (!request) {
      throw new DomainValidationError(
        "Attempt has no GenerationRequest"
      );
    }
    if(request.provider==="dreamina-canvas")throw new DomainValidationError("Canvas视频必须通过原Canvas资源下载通道交付");

    const command = await this.beginCommand(attempt, "DOWNLOAD");
    const projectRoot = path.join(this.projectsRoot, attempt.projectId);
    const tempDir = path.join(
      projectRoot,
      ".tmp",
      `download-${attempt.id}-${command.id}`
    );
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${attempt.id}.mp4`);

    try {
      const downloaded = await this.provider.download(attempt.providerHandle, tempPath);
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "DOWNLOAD"
      );
      const sanitized = await this.sanitizeOutputAudio(
        downloaded.path,
        request,
        tempDir
      );
      const artifactSourcePath = sanitized.path;
      const mediaSpecification = request.imageBindings?.length
        ? assessGeneratedMediaAspectRatio(request, await this.inspectOutputMedia(artifactSourcePath))
        : undefined;
      const strictV2Audio = request.inputVersionRefs.some(
        ref => ref.entityType === "ProductionAssetSet"
      );
      const strictV3NativeAudio =
        request.audioPolicy === "V3_NATIVE_NO_BGM";
      if (
        request.generateAudio &&
        !(await this.inspectOutputMedia(artifactSourcePath)).hasAudio &&
        (!strictV2Audio || strictV3NativeAudio)
      ) {
        await this.finishCommand(attempt.id, command, {
          ...evidence,
          completedAt: new Date().toISOString(),
          exitCode: evidence.exitCode ?? 1,
          errorCode: "OUTPUT_AUDIO_MISSING"
        });
        return this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "FAILED",
          completedAt: new Date().toISOString(),
          errorCode: "OUTPUT_AUDIO_MISSING",
          errorMessage:
            "已要求模型原生声音，但下载的视频没有音轨；该结果不会进入审片或剪辑。"
        });
      }
      const bytes = await fs.readFile(artifactSourcePath);
      const artifact = await new LocalArtifactStore(
        projectRoot,
        this.artifacts
      ).writeImmutable({
        id: randomUUID(),
        projectId: attempt.projectId,
        kind: "GENERATED_VIDEO",
        relativePath: `outputs/${attempt.clipId}/${attempt.id}.mp4`,
        immutable: true,
        bytes,
        mimeType: "video/mp4"
      });
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 0
      });
      // This is a zero-credit, local read of the actual downloaded video.
      // No generated frame is marked reviewed without a human/visual QC gate.
      let tailCaptureProblem: string | undefined;
      if (request.v8Binding && request.imageBindings?.length) {
        try {
          await captureActualClipTailFrame({
            projectId: attempt.projectId, projectsRoot: this.projectsRoot,
            attempt: { ...attempt, outputArtifactId: artifact.id },
            videoArtifact: artifact, artifacts: this.artifacts
          });
        } catch (error) {
          tailCaptureProblem = error instanceof Error ? error.message : String(error);
        }
      }
      const ratioWarning = mediaSpecification?.status === "RATIO_MISMATCH" ||
        mediaSpecification?.status === "RATIO_UNVERIFIED";
      const v3AudioWarning =
        sanitized.nativeAudioState ===
        "PRESERVED_V3_NATIVE_BGM_SUSPECTED";
      return this.workflow.updateGenerationAttemptStatus(attempt.id, {
        status: attempt.status,
        outputArtifactId: artifact.id,
        completedAt: new Date().toISOString(),
        ...(ratioWarning
          ? {
              errorCode: "OUTPUT_RATIO_MISMATCH",
              errorMessage: mediaSpecification!.detail
            }
          : tailCaptureProblem
          ? {
              errorCode: "CONTINUITY_TAILFRAME_UNAVAILABLE",
              errorMessage: "生成视频已保存，但无法提取可核验的真实尾帧：" + tailCaptureProblem + "。强连续的下一段必须暂停。"
            }
          : v3AudioWarning
          ? {
              errorCode:
                "V3_NATIVE_BGM_REVIEW_REQUIRED",
              errorMessage:
                sanitized.reason ??
                "原生音轨疑似包含 BGM；已保留对白/OS/环境声/音效，请审听后决定是否重做本镜头。"
            }
          : {})
      });
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "DOWNLOAD"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 1,
        errorCode: "DOWNLOAD_FAILED"
      });
      return this.requireAttempt(attempt.id);
    } finally {
      // The verified CLI may create one or more provider-named files when
      // download operates on a directory. Keep every attempt isolated and
      // remove the entire transient directory on both success and failure so
      // Recovery never mistakes a provider-side download residue for a new
      // user Artifact.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async reconcileAttempt(attemptId: string): Promise<GenerationAttempt> {
    return withSerialOperation("generation:" + attemptId, () => this.reconcileExclusive(attemptId));
  }

  private async reconcileExclusive(attemptId: string): Promise<GenerationAttempt> {
    let attempt = await this.requireAttempt(attemptId);
    if (
      attempt.status !== "SUBMISSION_OUTCOME_UNKNOWN" &&
      attempt.status !== "RECONCILING"
    ) {
      throw new DomainValidationError(
        `Attempt is not reconcilable: ${attempt.status}`
      );
    }

    attempt = await this.workflow.updateGenerationAttemptStatus(attempt.id, {
      status: "RECONCILING"
    });
    const command = await this.beginCommand(attempt, "RECONCILE");
    try {
      const result = await this.provider.reconcileSubmission({
        requestHash: attempt.requestHash,
        submissionFingerprint: attempt.submissionFingerprint,
        ...(attempt.providerHandle
          ? { knownHandle: attempt.providerHandle }
          : {})
      });
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "RECONCILE"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 0
      });

      if (result.outcome === "FOUND_ACTIVE") {
        await this.resolveReconcileBlocker(attempt);
        return this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "PROCESSING",
          providerHandle: result.handle
        });
      }
      if (result.outcome === "FOUND_SUCCEEDED") {
        await this.resolveReconcileBlocker(attempt);
        return this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "RECONCILED_SUCCEEDED",
          providerHandle: result.handle,
          completedAt: new Date().toISOString()
        });
      }
      if (result.outcome === "FOUND_FAILED") {
        await this.resolveReconcileBlocker(attempt);
        return this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "RECONCILED_FAILED",
          ...(result.handle ? { providerHandle: result.handle } : {}),
          completedAt: new Date().toISOString(),
          errorCode: "RECONCILED_FAILED",
          errorMessage: result.reason
        });
      }
      if (result.outcome === "NOT_FOUND") {
        await this.resolveReconcileBlocker(attempt);
        return this.workflow.updateGenerationAttemptStatus(attempt.id, {
          status: "RECONCILED_FAILED",
          completedAt: new Date().toISOString(),
          errorCode: "RECONCILED_NOT_FOUND",
          errorMessage: "Provider confirmed no matching task exists"
        });
      }

      const unknown = await this.workflow.updateGenerationAttemptStatus(
        attempt.id,
        {
          status: "SUBMISSION_OUTCOME_UNKNOWN",
          errorCode: "RECONCILIATION_INCONCLUSIVE",
          errorMessage: result.reason
        }
      );
      await this.ensureReconcileBlocker(unknown);
      return unknown;
    } catch (error) {
      const evidence = await this.collectProviderEvidence(
        attempt,
        command,
        "RECONCILE"
      );
      await this.finishCommand(attempt.id, command, {
        ...evidence,
        completedAt: new Date().toISOString(),
        exitCode: evidence.exitCode ?? 1,
        errorCode: "RECONCILE_FAILED"
      });
      const unknown = await this.workflow.updateGenerationAttemptStatus(
        attempt.id,
        {
          status: "SUBMISSION_OUTCOME_UNKNOWN",
          errorCode: "RECONCILE_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      );
      await this.ensureReconcileBlocker(unknown);
      return unknown;
    }
  }
}
