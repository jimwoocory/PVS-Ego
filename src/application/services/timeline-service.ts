import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { TimelineRepository } from "../ports/timeline-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import {
  renderConfigSchema,
  renderJobSchema,
  timelineAudioItemSchema,
  timelineSchema,
  timelineTextItemSchema,
  type Timeline,
  type TimelineClipEdit,
  type TimelineTextItem
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { probeMediaDurationMs } from "../../adapters/media/probe-media-duration.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { resolveRenderTarget } from "./render-target.js";
import type { ProductFlowService } from "./product-flow.js";

export type TimelineClipUpdate = {
  inMs?: number;
  outMs?: number;
  deleted?: boolean;
  volume?: number;
  muted?: boolean;
  transitionType?: "CUT" | "CROSSFADE" | "FADE";
  transitionDurationMs?: number;
};

export type TimelineTextInput = {
  kind: "CAPTION" | "CTA";
  text: string;
  startMs: number;
  endMs: number;
  position?: "TOP" | "CENTER" | "BOTTOM";
  fontScale?: number;
};

export type TimelineReadiness =
  | {
      allowed: true;
      acceptedCount: number;
      skippedCount: number;
      unresolvedCount: number;
      existingTimeline: boolean;
    }
  | {
      allowed: false;
      reasonCode:
        | "TIMELINE_PLAN_MISSING"
        | "TIMELINE_NO_ACCEPTED_VIDEO"
        | "TIMELINE_DECISION_INCOMPLETE";
      message: string;
      requiredAction: string;
      actionHref: string;
      acceptedCount: number;
      skippedCount: number;
      unresolvedCount: number;
      existingTimeline: false;
    };

export function timelineDecisionHash(input: {
  productionPlanHash: string;
  tracks: Timeline["tracks"];
  clips: Timeline["clips"];
  audioItems: Timeline["audioItems"];
  textItems: Timeline["textItems"];
  repairMasks: Timeline["repairMasks"];
  renderConfig?: Timeline["renderConfig"];
}): string {
  return hashValue({
    productionPlanHash: input.productionPlanHash,
    tracks: input.tracks,
    clips: input.clips,
    audioItems: input.audioItems,
    textItems: input.textItems,
    repairMasks: input.repairMasks,
    ...(input.renderConfig ? { renderConfig: input.renderConfig } : {})
  });
}

function withHash(
  timeline: Omit<Timeline, "contentHash"> & { contentHash?: string }
): Timeline {
  return timelineSchema.parse({
    ...timeline,
    contentHash: timelineDecisionHash(timeline)
  });
}

export function timelineDurationMs(timeline: Timeline): number {
  const clips = timeline.clips
    .filter((clip) => !clip.deleted)
    .sort((a, b) => a.order - b.order);
  if (!clips.length) return 0;
  let total = clips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
  for (let index = 0; index < clips.length - 1; index += 1) {
    const transition = clips[index]!.transition;
    if (transition.type !== "CUT") total -= transition.durationMs;
  }
  return Math.max(0, total);
}

export class TimelineService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly review: ReviewRepository,
    private readonly timelines: TimelineRepository,
    private readonly projectsRoot: string,
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
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


  async readiness(projectId: string): Promise<TimelineReadiness> {
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (!workspace?.productionPlan) {
      return {
        allowed: false,
        reasonCode: "TIMELINE_PLAN_MISSING",
        message: "还没有可用于剪辑的当前导演分镜。",
        requiredAction: "先完成并确认导演分镜，再生成并审片。",
        actionHref: `/projects/${projectId}/director`,
        acceptedCount: 0,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: false
      };
    }

    const latest = await this.timelines.latestTimeline(projectId);
    if (
      latest &&
      latest.status !== "STALE" &&
      latest.productionPlanHash === workspace.productionPlan.contentHash
    ) {
      return {
        allowed: true,
        acceptedCount: latest.clips.filter((clip) => !clip.deleted).length,
        skippedCount: 0,
        unresolvedCount: 0,
        existingTimeline: true
      };
    }

    const [attempts, decisions] = await Promise.all([
      this.workflow.listGenerationAttempts(projectId),
      this.review.listDecisions(projectId)
    ]);
    const clips = workspace.productionPlan.scenes.flatMap((scene) => scene.clips);
    let acceptedCount = 0;
    let skippedCount = 0;
    let unresolvedCount = 0;

    for (const clip of clips) {
      const latestUsage = decisions
        .filter(
          (item) =>
            item.clipId === clip.id &&
            item.clipHash === clip.contentHash &&
            (item.decision === "SKIP" || item.decision === "USE")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (latestUsage?.decision === "SKIP") {
        skippedCount += 1;
        continue;
      }

      const attempt = this.latestSuccessfulAttemptForClip(
        attempts,
        projectId,
        clip.id
      );
      if (!attempt?.outputArtifactId) {
        unresolvedCount += 1;
        continue;
      }
      const artifact = await this.artifacts.findById(attempt.outputArtifactId);
      if (
        !artifact ||
        artifact.projectId !== projectId ||
        artifact.kind !== "GENERATED_VIDEO" ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256
      ) {
        unresolvedCount += 1;
        continue;
      }
      const review = decisions
        .filter(
          (item) =>
            item.clipId === clip.id &&
            item.clipHash === clip.contentHash &&
            item.generationAttemptId === attempt.id &&
            item.outputArtifactId === artifact.id &&
            item.outputArtifactHash === artifact.sha256 &&
            (item.decision === "ACCEPT" || item.decision === "REDO")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (review?.decision === "ACCEPT") acceptedCount += 1;
      else unresolvedCount += 1;
    }

    if (acceptedCount > 0) {
      return {
        allowed: true,
        acceptedCount,
        skippedCount,
        unresolvedCount,
        existingTimeline: false
      };
    }

    const incomplete = unresolvedCount > 0;
    return {
      allowed: false,
      reasonCode: incomplete
        ? "TIMELINE_DECISION_INCOMPLETE"
        : "TIMELINE_NO_ACCEPTED_VIDEO",
      message: incomplete
        ? "当前还没有已采用的视频可进入剪辑。"
        : "当前镜头都没有被采用，暂时不能建立视频剪辑。",
      requiredAction: incomplete
        ? "回到视频生成页，至少采用 1 个生成结果；不需要的镜头可以明确跳过。"
        : "回到视频生成页，至少采用 1 个镜头后再进入视频剪辑。",
      actionHref: `/projects/${projectId}/generate`,
      acceptedCount,
      skippedCount,
      unresolvedCount,
      existingTimeline: false
    };
  }

  private async acceptedSources(projectId: string): Promise<
    Array<{
      clipId: string;
      artifactId: string;
      artifactHash: string;
      sourceDurationMs: number;
      plannedOrder: number;
    }>
  > {
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (!workspace?.productionPlan) {
      throw new DomainValidationError("需要先生成当前导演方案");
    }
    const attempts = await this.workflow.listGenerationAttempts(projectId);
    const decisions = await this.review.listDecisions(projectId);
    const clips = workspace.productionPlan.scenes.flatMap((scene) => scene.clips);
    const projectRoot = path.resolve(this.projectsRoot, projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const selected: Array<{
      clipId: string;
      artifactId: string;
      artifactHash: string;
      sourceDurationMs: number;
      plannedOrder: number;
    }> = [];

    for (let plannedOrder = 0; plannedOrder < clips.length; plannedOrder += 1) {
      const clip = clips[plannedOrder]!;
      const latestUsage = decisions
        .filter(
          (item) =>
            item.clipId === clip.id &&
            item.clipHash === clip.contentHash &&
            (item.decision === "SKIP" || item.decision === "USE")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (latestUsage?.decision === "SKIP") continue;

      const attempt = this.latestSuccessfulAttemptForClip(
        attempts,
        projectId,
        clip.id
      );
      if (!attempt?.outputArtifactId) continue;
      const artifact = await this.artifacts.findById(attempt.outputArtifactId);
      if (
        !artifact ||
        artifact.projectId !== projectId ||
        artifact.kind !== "GENERATED_VIDEO" ||
        artifact.integrityStatus !== "READY" ||
        !artifact.sha256
      ) {
        continue;
      }
      const accept = decisions
        .filter(
          (item) =>
            item.clipId === clip.id &&
            item.clipHash === clip.contentHash &&
            item.generationAttemptId === attempt.id &&
            item.outputArtifactId === artifact.id &&
            item.outputArtifactHash === artifact.sha256 &&
            (item.decision === "ACCEPT" || item.decision === "REDO")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (accept?.decision !== "ACCEPT") continue;

      const absolute = store.resolveArtifactPath(artifact.relativePath);
      const sourceDurationMs = await probeMediaDurationMs(
        absolute,
        this.ffprobePath
      );
      if (!sourceDurationMs) {
        throw new DomainValidationError(
          "Cannot read duration for accepted video Artifact " + artifact.id
        );
      }
      selected.push({
        clipId: clip.id,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        sourceDurationMs,
        plannedOrder
      });
    }

    if (!selected.length) {
      throw new DomainValidationError(
        "At least one accepted generated video is required for Timeline"
      );
    }
    return selected;
  }

  private async createFromAccepted(projectId: string): Promise<Timeline> {
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (!workspace?.productionPlan) {
      throw new DomainValidationError("Current ProductionPlan is required");
    }
    const selected = await this.acceptedSources(projectId);
    const now = new Date().toISOString();
    const id = randomUUID();
    const version = await this.timelines.nextTimelineVersion(projectId);
    const videoTrackId = id + "-video";
    const audioTrackId = id + "-audio";
    const textTrackId = id + "-text";
    const clips: TimelineClipEdit[] = selected.map((source, index) => ({
      id: randomUUID(),
      sourceClipId: source.clipId,
      sourceArtifactId: source.artifactId,
      sourceArtifactHash: source.artifactHash,
      sourceDurationMs: source.sourceDurationMs,
      inMs: 0,
      outMs: source.sourceDurationMs,
      trackId: videoTrackId,
      order: index,
      deleted: false,
      transition: { type: "CUT", durationMs: 0 },
      audio: { muted: false, volume: 1, keyframes: [] },
      captions: []
    }));
    const timeline = withHash({
      id,
      projectId,
      version,
      status: "DRAFT",
      productionPlanHash: workspace.productionPlan.contentHash,
      tracks: [
        {
          id: videoTrackId,
          kind: "VIDEO",
          order: 0,
          label: "主视频",
          locked: false,
          muted: false
        },
        {
          id: audioTrackId,
          kind: "AUDIO",
          order: 1,
          label: "BGM",
          locked: false,
          muted: false
        },
        {
          id: textTrackId,
          kind: "TEXT",
          order: 2,
          label: "字幕 / CTA",
          locked: false,
          muted: false
        }
      ],
      clips,
      audioItems: [],
      textItems: [],
      repairMasks: [],
      createdAt: now,
      updatedAt: now
    });
    await this.timelines.markTimelinesStale(projectId);
    return this.timelines.saveTimeline(timeline);
  }

  async getOrCreate(projectId: string): Promise<Timeline> {
    const readiness = await this.readiness(projectId);
    if (!readiness.allowed) {
      throw new DomainValidationError(readiness.message);
    }
    const latest = await this.timelines.latestTimeline(projectId);
    if (readiness.existingTimeline && latest) return latest;
    return this.createFromAccepted(projectId);
  }

  async resetFromAccepted(projectId: string): Promise<Timeline> {
    return this.createFromAccepted(projectId);
  }

  private async editable(projectId: string): Promise<Timeline> {
    const current = await this.getOrCreate(projectId);
    if (current.status === "DRAFT") return current;

    const now = new Date().toISOString();
    const fork = withHash({
      ...current,
      id: randomUUID(),
      version: await this.timelines.nextTimelineVersion(projectId),
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
      confirmedAt: undefined
    });
    await this.timelines.markTimelinesStale(projectId);
    return this.timelines.saveTimeline(fork);
  }

  private async saveDraft(timeline: Timeline): Promise<Timeline> {
    const updated = withHash({
      ...timeline,
      status: "DRAFT",
      updatedAt: new Date().toISOString(),
      confirmedAt: undefined
    });
    return this.timelines.saveTimeline(updated);
  }

  async reorder(
    projectId: string,
    orderedClipEditIds: string[]
  ): Promise<Timeline> {
    const timeline = await this.editable(projectId);
    const active = timeline.clips.filter((clip) => !clip.deleted);
    if (
      orderedClipEditIds.length !== active.length ||
      new Set(orderedClipEditIds).size !== active.length ||
      active.some((clip) => !orderedClipEditIds.includes(clip.id))
    ) {
      throw new DomainValidationError(
        "Clip order must contain every active Timeline clip exactly once"
      );
    }
    const rank = new Map(orderedClipEditIds.map((id, index) => [id, index]));
    const clips = timeline.clips.map((clip) =>
      clip.deleted
        ? clip
        : { ...clip, order: rank.get(clip.id) ?? clip.order }
    );
    return this.saveDraft({ ...timeline, clips });
  }

  async updateClip(
    projectId: string,
    clipEditId: string,
    update: TimelineClipUpdate
  ): Promise<Timeline> {
    const timeline = await this.editable(projectId);
    const target = timeline.clips.find((clip) => clip.id === clipEditId);
    if (!target) throw new DomainValidationError("找不到要编辑的镜头");

    const transitionType = update.transitionType ?? target.transition.type;
    const transitionDurationMs =
      transitionType === "CUT"
        ? 0
        : (update.transitionDurationMs ?? target.transition.durationMs) || 300;
    const restoreOrder =
      target.deleted && update.deleted === false
        ? Math.max(
            -1,
            ...timeline.clips
              .filter((clip) => !clip.deleted)
              .map((clip) => clip.order)
          ) + 1
        : target.order;
    const clips = timeline.clips.map((clip) =>
      clip.id === clipEditId
        ? {
            ...clip,
            order: restoreOrder,
            ...(update.inMs !== undefined ? { inMs: update.inMs } : {}),
            ...(update.outMs !== undefined ? { outMs: update.outMs } : {}),
            ...(update.deleted !== undefined ? { deleted: update.deleted } : {}),
            transition: {
              type: transitionType,
              durationMs: transitionDurationMs
            },
            audio: {
              ...clip.audio,
              ...(update.volume !== undefined ? { volume: update.volume } : {}),
              ...(update.muted !== undefined ? { muted: update.muted } : {})
            }
          }
        : clip
    );
    return this.saveDraft({ ...timeline, clips });
  }

  async addTextItem(
    projectId: string,
    input: TimelineTextInput
  ): Promise<Timeline> {
    const timeline = await this.editable(projectId);
    const track = timeline.tracks.find((item) => item.kind === "TEXT");
    if (!track) throw new DomainValidationError("字幕轨道不存在");
    const item: TimelineTextItem = timelineTextItemSchema.parse({
      id: randomUUID(),
      kind: input.kind,
      text: input.text.trim(),
      startMs: input.startMs,
      endMs: input.endMs,
      trackId: track.id,
      order: timeline.textItems.length,
      position: input.position ?? "BOTTOM",
      fontScale: input.fontScale ?? 1,
      deleted: false
    });
    return this.saveDraft({
      ...timeline,
      textItems: [...timeline.textItems, item]
    });
  }

  async removeTextItem(projectId: string, itemId: string): Promise<Timeline> {
    const timeline = await this.editable(projectId);
    if (!timeline.textItems.some((item) => item.id === itemId)) {
      throw new DomainValidationError("找不到要编辑的字幕或行动引导");
    }
    return this.saveDraft({
      ...timeline,
      textItems: timeline.textItems.map((item) =>
        item.id === itemId ? { ...item, deleted: true } : item
      )
    });
  }

  async setBgm(input: {
    projectId: string;
    artifactId: string;
    startMs?: number;
    inMs?: number;
    outMs?: number;
    volume?: number;
  }): Promise<Timeline> {
    const timeline = await this.editable(input.projectId);
    const artifact = await this.artifacts.findById(input.artifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256 ||
      !artifact.mimeType?.startsWith("audio/")
    ) {
      throw new DomainValidationError("背景音乐文件不可用或尚未准备完成");
    }
    const projectRoot = path.resolve(this.projectsRoot, input.projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const sourceDurationMs = await probeMediaDurationMs(
      store.resolveArtifactPath(artifact.relativePath),
      this.ffprobePath
    );
    if (!sourceDurationMs) {
      throw new DomainValidationError("Cannot read BGM duration");
    }
    const track = timeline.tracks.find((item) => item.kind === "AUDIO" && /BGM|背景音乐/i.test(item.label)) ?? timeline.tracks.find((item) => item.kind === "AUDIO");
    if (!track) throw new DomainValidationError("背景音乐轨道不存在");
    const inMs = input.inMs ?? 0;
    const outMs = input.outMs ?? sourceDurationMs;
    const item = timelineAudioItemSchema.parse({
      id: randomUUID(),
      sourceArtifactId: artifact.id,
      sourceArtifactHash: artifact.sha256,
      sourceDurationMs,
      inMs,
      outMs,
      startMs: input.startMs ?? 0,
      trackId: track.id,
      order: timeline.audioItems.length,
      deleted: false,
      role: "BGM",
      audio: {
        muted: false,
        volume: input.volume ?? 0.35,
        keyframes: []
      }
    });
    return this.saveDraft({
      ...timeline,
      audioItems: [
        ...timeline.audioItems.map((existing) => ({
          ...existing,
          deleted: existing.role && existing.role !== "BGM" ? existing.deleted : true
        })),
        item
      ]
    });
  }

  async updateAudioItem(projectId: string, itemId: string, update: {
    expectedHash: string; inMs?: number; outMs?: number; startMs?: number; volume?: number; muted?: boolean; deleted?: boolean; clearKeyframes?: boolean
  }): Promise<Timeline> {
    const current = await this.getOrCreate(projectId);
    if (current.contentHash !== update.expectedHash) throw new DomainValidationError("时间线已被更新，请刷新后编辑音轨");
    const target = current.audioItems.find(item => item.id === itemId);
    if (!target) throw new DomainValidationError("找不到要编辑的后期音轨");
    const factor = update.volume !== undefined && target.audio.volume > 0 ? update.volume / target.audio.volume : 1;
    const changed = timelineAudioItemSchema.parse({ ...target,
      ...(update.inMs !== undefined ? { inMs: update.inMs } : {}), ...(update.outMs !== undefined ? { outMs: update.outMs } : {}),
      ...(update.startMs !== undefined ? { startMs: update.startMs } : {}), ...(update.deleted !== undefined ? { deleted: update.deleted } : {}),
      audio: { ...target.audio, ...(update.volume !== undefined ? { volume: update.volume } : {}), ...(update.muted !== undefined ? { muted: update.muted } : {}),
        keyframes: update.clearKeyframes ? [] : target.audio.keyframes.map(frame => ({ ...frame, volume: frame.volume * factor })) }
    });
    if (changed.audio.keyframes.some(frame => frame.atMs > changed.outMs - changed.inMs)) throw new DomainValidationError("裁剪后音量关键帧超出片段，请明确清除原关键帧或保留其范围");
    const timeline = await this.editable(projectId);
    if (timeline.contentHash !== current.contentHash) throw new DomainValidationError("编辑期间时间线已更新，未覆盖新内容");
    return this.saveDraft({ ...timeline, audioItems: timeline.audioItems.map(item => item.id === itemId ? changed : item) });
  }

  async removeBgm(projectId: string): Promise<Timeline> {
    const timeline = await this.editable(projectId);
    return this.saveDraft({
      ...timeline,
      audioItems: timeline.audioItems.map((item) => ({
        ...item,
        deleted: item.role && item.role !== "BGM" ? item.deleted : true
      }))
    });
  }

  async confirm(projectId: string, expected?: { id: string; hash: string }): Promise<Timeline> {
    let timeline = await this.getOrCreate(projectId);
    if (expected && (timeline.id !== expected.id || timeline.contentHash !== expected.hash)) {
      throw new DomainValidationError("时间线已更新，不能替换本次确认的剪辑版本");
    }
    if (!timeline.renderConfig) {
      const target = (await this.productFlow.getWorkspace(projectId))?.productionPlan?.generationTarget;
      if (target) {
        const first = timeline.clips.find(c => !c.deleted);
        const artifact = first ? await this.artifacts.findById(first.sourceArtifactId) : null;
        const source = artifact ? await inspectMedia(new LocalArtifactStore(path.resolve(this.projectsRoot, projectId), this.artifacts).resolveArtifactPath(artifact.relativePath), this.ffprobePath) : undefined;
        timeline = withHash({ ...timeline, renderConfig: resolveRenderTarget(target.aspectRatio, target.videoResolution, source) });
      }
    }
    if (!timeline.clips.some((clip) => !clip.deleted)) {
      throw new DomainValidationError(
        "At least one active Timeline clip is required before confirmation"
      );
    }
    const now = new Date().toISOString();
    const confirmed = withHash({
      ...timeline,
      status: "CONFIRMED",
      updatedAt: now,
      confirmedAt: now
    });
    const saved = await this.timelines.saveTimeline(confirmed);
    const existingJob = await this.timelines.latestRenderJob(projectId);
    if (
      !existingJob ||
      existingJob.timelineId !== saved.id ||
      existingJob.timelineHash !== saved.contentHash
    ) {
      const inputs = new Map<string, string>();
      for (const clip of saved.clips) {
        if (!clip.deleted) {
          inputs.set(clip.sourceArtifactId, clip.sourceArtifactHash);
        }
      }
      for (const item of saved.audioItems) {
        if (!item.deleted) {
          inputs.set(item.sourceArtifactId, item.sourceArtifactHash);
        }
      }
      await this.timelines.createRenderJob(
        renderJobSchema.parse({
          id: randomUUID(),
          projectId,
          timelineId: saved.id,
          timelineHash: saved.contentHash,
          status: "QUEUED",
          inputArtifactIds: [...inputs.keys()],
          inputArtifactHashes: [...inputs.values()],
          renderConfig: renderConfigSchema.parse(saved.renderConfig ?? {}),
          createdAt: now
        })
      );
    }
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (workspace?.project.status === "GENERATION_REVIEW") {
      const openBlockers = await this.workflow.listOpenBlockers(projectId);
      if (!openBlockers.length) {
        await this.productFlow.setProjectStatus(projectId, "READY_TO_ASSEMBLE");
      }
    }
    return saved;
  }

  async latestRenderJob(projectId: string) {
    return this.timelines.latestRenderJob(projectId);
  }

  async listRenderJobs(projectId: string) {
    return this.timelines.listRenderJobs(projectId);
  }

  async latestTimeline(projectId: string) {
    return this.timelines.latestTimeline(projectId);
  }
}
