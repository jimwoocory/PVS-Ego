import { randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { GenerationRepository } from "../ports/generation-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import {
  reviewDecisionSchema,
  type Clip,
  type ReviewDecision
} from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";
import type { ProductFlowService } from "./product-flow.js";
import { buildClipContinuityGraph, affectedContinuationClipIds } from "./clip-continuity-engine.js";

export class ReviewService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly generation: GenerationRepository,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly review: ReviewRepository
  ) {}

  private latestSuccessfulAttemptForClip(
    attempts: Awaited<ReturnType<WorkflowRepository["listGenerationAttempts"]>>,
    projectId: string,
    clipId: string
  ) {
    return attempts
      .filter(
        (item) =>
          item.projectId === projectId &&
          item.clipId === clipId &&
          (item.status === "SUCCEEDED" ||
            item.status === "RECONCILED_SUCCEEDED")
      )
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  }

  private latestUsageDecisionForClip(
    decisions: ReviewDecision[],
    clip: Clip
  ): ReviewDecision | undefined {
    return decisions
      .filter(
        (item) =>
          item.clipId === clip.id &&
          item.clipHash === clip.contentHash &&
          (item.decision === "SKIP" || item.decision === "USE")
      )
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  }

  private async evaluateCurrentPlan(
    projectId: string,
    clips: Clip[]
  ): Promise<{
    projectStatus: string;
    acceptedClipIds: string[];
    skippedClipIds: string[];
    pendingClipIds: string[];
  }> {
    const attempts = await this.workflow.listGenerationAttempts(projectId);
    const allDecisions = await this.review.listDecisions(projectId);
    const acceptedClipIds: string[] = [];
    const skippedClipIds: string[] = [];
    const pendingClipIds: string[] = [];

    for (const currentClip of clips) {
      const usage = this.latestUsageDecisionForClip(allDecisions, currentClip);
      if (usage?.decision === "SKIP") {
        skippedClipIds.push(currentClip.id);
        continue;
      }

      const currentAttempt = this.latestSuccessfulAttemptForClip(
        attempts,
        projectId,
        currentClip.id
      );
      if (!currentAttempt?.outputArtifactId) {
        pendingClipIds.push(currentClip.id);
        continue;
      }
      const currentArtifact = await this.artifacts.findById(
        currentAttempt.outputArtifactId
      );
      if (
        !currentArtifact ||
        currentArtifact.projectId !== projectId ||
        currentArtifact.kind !== "GENERATED_VIDEO" ||
        currentArtifact.integrityStatus !== "READY" ||
        !currentArtifact.sha256
      ) {
        pendingClipIds.push(currentClip.id);
        continue;
      }
      const matchingReview = allDecisions
        .filter(
          (item) =>
            item.clipId === currentClip.id &&
            item.clipHash === currentClip.contentHash &&
            item.generationAttemptId === currentAttempt.id &&
            item.outputArtifactId === currentArtifact.id &&
            item.outputArtifactHash === currentArtifact.sha256 &&
            (item.decision === "ACCEPT" || item.decision === "REDO" ||
              item.decision === "STALE")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (matchingReview?.decision === "ACCEPT") {
        acceptedClipIds.push(currentClip.id);
      } else {
        pendingClipIds.push(currentClip.id);
      }
    }

    const openBlockers = await this.workflow.listOpenBlockers(projectId);
    const hasUnknownSubmission = attempts.some(
      (item) =>
        item.status === "SUBMISSION_OUTCOME_UNKNOWN" ||
        item.status === "RECONCILING"
    );
    const allResolved = pendingClipIds.length === 0;
    const canComplete =
      acceptedClipIds.length > 0 &&
      allResolved &&
      !openBlockers.length &&
      !hasUnknownSubmission;
    const project = await this.productFlow.setProjectStatus(
      projectId,
      canComplete ? "READY_TO_ASSEMBLE" : "GENERATION_REVIEW"
    );
    return {
      projectStatus: project.status,
      acceptedClipIds,
      skippedClipIds,
      pendingClipIds
    };
  }

  async decide(input: {
    projectId: string;
    clipId: string;
    generationAttemptId?: string;
    decision: "ACCEPT" | "REDO" | "SKIP" | "USE";
    source?: "USER" | "AI_VISUAL_GATE";
    visualAssessment?: {
      artifactId: string;
      artifactHash: string;
      assessmentContentHash: string;
      evaluatorVersion: string;
    };
    note?: string;
    now?: Date;
  }): Promise<{
    decision: ReviewDecision;
    projectStatus: string;
    redoClipId?: string;
  }> {
    const now = input.now ?? new Date();
    const source = input.source ?? "USER";
    if (source === "AI_VISUAL_GATE" && input.decision !== "ACCEPT") {
      throw new DomainValidationError(
        "视觉 AI 只能在高置信安全门通过时自动采用，不能自动跳过或触发重做"
      );
    }
    const workspace = await this.productFlow.getWorkspace(input.projectId);
    if (!workspace?.productionPlan) {
      throw new DomainValidationError("需要先生成当前导演方案");
    }
    const clips = workspace.productionPlan.scenes.flatMap((scene) => scene.clips);
    const clip = clips.find((item) => item.id === input.clipId);
    if (!clip) {
      throw new DomainValidationError("当前导演方案中找不到该镜头");
    }

    if (input.decision === "SKIP" || input.decision === "USE") {
      const decision = reviewDecisionSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        clipId: clip.id,
        clipHash: clip.contentHash,
        decision: input.decision,
        source,
        ...(input.visualAssessment
          ? { visualAssessment: input.visualAssessment }
          : {}),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        decidedAt: now.toISOString()
      });
      await this.review.createDecision(decision);
      const state = await this.evaluateCurrentPlan(input.projectId, clips);
      return { decision, projectStatus: state.projectStatus };
    }

    if (!input.generationAttemptId) {
      throw new DomainValidationError(
        `${input.decision} requires generationAttemptId`
      );
    }

    const attempt = await this.workflow.getGenerationAttempt(
      input.generationAttemptId
    );
    if (!attempt || attempt.projectId !== input.projectId) {
      throw new DomainValidationError("GenerationAttempt not found in project");
    }
    if (attempt.clipId !== clip.id) {
      throw new DomainValidationError("GenerationAttempt clip mismatch");
    }
    if (
      attempt.status !== "SUCCEEDED" &&
      attempt.status !== "RECONCILED_SUCCEEDED"
    ) {
      throw new DomainValidationError(
        `Only successful attempt can be reviewed, got ${attempt.status}`
      );
    }
    if (!attempt.outputArtifactId) {
      throw new DomainValidationError("生成任务已完成，但没有可用输出视频");
    }
    if (source === "AI_VISUAL_GATE" && attempt.errorCode === "OUTPUT_RATIO_MISMATCH") {
      throw new DomainValidationError("生成视频真实画幅与项目要求不一致，禁止AI自动采用；请人工审片后决定是否重做。");
    }
    const artifact = await this.artifacts.findById(attempt.outputArtifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.kind !== "GENERATED_VIDEO" ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256
    ) {
      throw new DomainValidationError("输出视频尚不可用");
    }

    const attempts = await this.workflow.listGenerationAttempts(input.projectId);
    const currentSuccessfulAttempt = this.latestSuccessfulAttemptForClip(
      attempts,
      input.projectId,
      clip.id
    );
    if (
      !currentSuccessfulAttempt ||
      currentSuccessfulAttempt.id !== attempt.id ||
      currentSuccessfulAttempt.outputArtifactId !== artifact.id
    ) {
      throw new DomainValidationError(
        "ReviewDecision must target the current latest successful output for this Clip"
      );
    }

    const decision = reviewDecisionSchema.parse({
      id: randomUUID(),
      projectId: input.projectId,
      clipId: clip.id,
      clipHash: clip.contentHash,
      generationAttemptId: attempt.id,
      outputArtifactId: artifact.id,
      outputArtifactHash: artifact.sha256,
      decision: input.decision,
      source,
      ...(input.visualAssessment
        ? { visualAssessment: input.visualAssessment }
        : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      decidedAt: now.toISOString()
    });
    await this.review.createDecision(decision);

    if (input.decision === "REDO") {
      // A local redo must not revoke unrelated clips that already succeeded.
      await this.generation.markRequestChainStale(
        attempt.generationRequestId,
        now.toISOString()
      );
      // V8 continuity opt-in: redo of a source invalidates only descendants
      // that actually depend on it. Preserve the immutable MP4s and audit trail.
      if (process.env.PVS_SCENE_CONTINUITY_V1 === "1" &&
          workspace.productionPlan.v8Source) {
        const graph=buildClipContinuityGraph(workspace.productionPlan);
        const affected=affectedContinuationClipIds(graph,clip.id);
        const decisions=await this.review.listDecisions(input.projectId);
        for (const affectedId of affected) {
          const nextClip=clips.find(c=>c.id===affectedId);
          if (!nextClip) continue;
          const output=this.latestSuccessfulAttemptForClip(
            attempts,input.projectId,affectedId
          );
          if (!output?.outputArtifactId) continue;
          const outputArtifact=await this.artifacts.findById(output.outputArtifactId);
          if (!outputArtifact || outputArtifact.integrityStatus!=="READY" ||
              !outputArtifact.sha256) continue;
          const latest=decisions.filter(d=>d.clipId===affectedId &&
            d.clipHash===nextClip.contentHash &&
            d.generationAttemptId===output.id)
            .sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt))[0];
          if (latest?.decision!=="ACCEPT") continue;
          const decidedAt=new Date(Math.max(
            now.getTime(),Date.parse(latest.decidedAt)+1
          )).toISOString();
          const stale=reviewDecisionSchema.parse({
            id:randomUUID(),projectId:input.projectId,clipId:affectedId,
            clipHash:nextClip.contentHash,
            generationAttemptId:output.id,
            outputArtifactId:outputArtifact.id,
            outputArtifactHash:outputArtifact.sha256,
            decision:"STALE",source:"CONTINUITY_DEPENDENCY",
            note:"上游镜头 "+clip.id+" 已重新制作，本片段继承的连续性证据需要重新审核",
            decidedAt
          });
          await this.review.createDecision(stale);
          await this.generation.markRequestChainStale(
            output.generationRequestId, decidedAt
          );
        }
      }
      const project = await this.productFlow.setProjectStatus(
        input.projectId,
        "GENERATION_REVIEW"
      );
      return {
        decision,
        projectStatus: project.status,
        redoClipId: clip.id
      };
    }
    const state = await this.evaluateCurrentPlan(input.projectId, clips);
    return { decision, projectStatus: state.projectStatus };
  }

  async finalizeUsingAcceptedClips(input: {
    projectId: string;
    now?: Date;
  }): Promise<{
    projectStatus: string;
    acceptedClipIds: string[];
    skippedClipIds: string[];
    pendingClipIds: string[];
  }> {
    const now = input.now ?? new Date();
    const workspace = await this.productFlow.getWorkspace(input.projectId);
    if (!workspace?.productionPlan) {
      throw new DomainValidationError("Current ProductionPlan is required");
    }
    const clips = workspace.productionPlan.scenes.flatMap((scene) => scene.clips);
    const before = await this.evaluateCurrentPlan(input.projectId, clips);
    if (!before.acceptedClipIds.length) {
      throw new DomainValidationError(
        "At least one accepted Clip is required before continuing with a partial selection"
      );
    }

    const decisions = await this.review.listDecisions(input.projectId);
    for (const clip of clips) {
      if (before.acceptedClipIds.includes(clip.id)) continue;
      const latestUsage = this.latestUsageDecisionForClip(decisions, clip);
      if (latestUsage?.decision === "SKIP") continue;
      await this.review.createDecision(
        reviewDecisionSchema.parse({
          id: randomUUID(),
          projectId: input.projectId,
          clipId: clip.id,
          clipHash: clip.contentHash,
          decision: "SKIP",
          note: "用户选择使用当前已接受片段进入下一步；此 Clip 不纳入当前成片。",
          decidedAt: now.toISOString()
        })
      );
    }

    return this.evaluateCurrentPlan(input.projectId, clips);
  }
}
