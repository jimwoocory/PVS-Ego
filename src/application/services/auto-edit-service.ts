import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hashValue } from "../../domain/hashing.js";
import { AutoEditBlocked, autoEditPlanSchema, postProductionSettingsSchema, type AutoEditPlan, type PostProductionSettings } from "../../domain/auto-edit.js";
import type { ArtifactRecord, Timeline } from "../../domain/schemas.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { TimelineRepository } from "../ports/timeline-repository.js";
import type { SpeechSynthesisProvider } from "../ports/speech-synthesis.js";
import type { ProductFlowService } from "./product-flow.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { AUTO_EDIT_PLANNER_VERSION, planAutoEdit, type AutoEditSource, type PreparedAudio } from "./auto-edit-planner.js";
import { timelineDecisionHash } from "./timeline-service.js";
import { assertPlanTraceability } from "../../domain/validation.js";
import { withSerialOperation } from "./serial-operation.js";
import type { VisualEditAssessmentService } from "./visual-edit-assessment.js";

async function hashFile(file: string): Promise<string> {
  const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex");
}
export type AutoEditInput = { projectId: string; settings: unknown; expectedPlanHash?: string; attemptIds?: string[];
  replaceTimeline?: { id: string; hash: string } };
export type AutoEditResult = { plan: AutoEditPlan; planArtifactId: string; timeline: Timeline };

/** Owns automatic edit decisions only. It never confirms facts, selects unreviewed videos or submits a paid generation. */
export class AutoEditService {
  constructor(private readonly d: { productFlow: ProductFlowService; workflow: WorkflowRepository; review: ReviewRepository;
    artifacts: ArtifactRepository; timelines: TimelineRepository; projectsRoot: string; speech?: SpeechSynthesisProvider;
    visualReview?: VisualEditAssessmentService }) {}

  private store(projectId: string) { return new LocalArtifactStore(path.resolve(this.d.projectsRoot, projectId), this.d.artifacts); }
  private async verified(projectId: string, id: string, kind: "video" | "audio" | "json") {
    const artifact = await this.d.artifacts.findById(id);
    if (!artifact || artifact.projectId !== projectId || artifact.integrityStatus !== "READY" || !artifact.sha256) throw new AutoEditBlocked("ARTIFACT_NOT_READY", "剪辑素材缺失或尚未准备完成");
    if (kind === "video" && artifact.kind !== "GENERATED_VIDEO") throw new AutoEditBlocked("UNREVIEWABLE_VIDEO", "自动剪辑视频必须来自已采用的生成产物");
    if (kind === "audio" && !artifact.mimeType?.startsWith("audio/")) throw new AutoEditBlocked("NOT_AUDIO", "选择的音频素材类型不正确", true);
    const file = this.store(projectId).resolveArtifactPath(artifact.relativePath);
    if (await hashFile(file) !== artifact.sha256) throw new AutoEditBlocked("ARTIFACT_CHANGED", "剪辑素材实际文件校验失败，原产物不会被覆盖");
    return { artifact: artifact as ArtifactRecord & { sha256: string }, file };
  }
  private async selection(projectId: string, allowedAttempts?: string[]) {
    const w = await this.d.productFlow.getWorkspace(projectId);
    if (!w?.productTruth || !w.script || !w.productionPlan || [w.productTruth.status, w.script.status, w.productionPlan.status].some(s => s !== "CONFIRMED")) {
      throw new AutoEditBlocked("CONFIRMED_PLAN_REQUIRED", "请先完成产品事实、脚本和导演方案确认");
    }
    assertPlanTraceability(w.productTruth, w.script, w.productionPlan);
    const attempts = await this.d.workflow.listGenerationAttempts(projectId), decisions = await this.d.review.listDecisions(projectId);
    const clips = [...w.productionPlan.scenes].sort((a,b) => a.order-b.order).flatMap(s => [...s.clips].sort((a,b) => a.order-b.order));
    const sources: AutoEditSource[] = [], selectionAudit: unknown[] = [];
    for (const clip of clips) {
      const usage = decisions.filter(d => d.clipId === clip.id && d.clipHash === clip.contentHash && ["SKIP", "USE"].includes(d.decision)).sort((a,b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (usage?.decision === "SKIP") { selectionAudit.push({ clipId: clip.id, decision: usage.id, skipped: true }); continue; }
      const attempt = attempts.filter(a => a.clipId === clip.id).sort((a,b) => b.attemptNumber-a.attemptNumber)[0];
      if (!attempt || !["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(attempt.status) || !attempt.outputArtifactId || (allowedAttempts && !allowedAttempts.includes(attempt.id))) {
        throw new AutoEditBlocked("OUTPUT_REVIEW_REQUIRED", "仍有镜头没有本轮可用结果，请在生成页明确采用或跳过");
      }
      const output = await this.verified(projectId, attempt.outputArtifactId, "video");
      const review = decisions.filter(d => d.clipId === clip.id && d.clipHash === clip.contentHash && d.generationAttemptId === attempt.id && d.outputArtifactId === output.artifact.id && d.outputArtifactHash === output.artifact.sha256 && ["ACCEPT", "REDO", "STALE"].includes(d.decision)).sort((a,b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (review?.decision !== "ACCEPT") throw new AutoEditBlocked("OUTPUT_REVIEW_REQUIRED", "自动剪辑只使用与当前镜头、尝试和产物哈希绑定的已采用结果");
      const media = await inspectMedia(output.file);
      let visualAssessment;
      let visualWarning: string | undefined;
      if (this.d.visualReview) {
        try {
          visualAssessment = await this.d.visualReview.assess({
            projectId,
            truth: w.productTruth,
            clip,
            attemptId: attempt.id,
            outputArtifactId: output.artifact.id
          });
        } catch (error) {
          visualWarning = error instanceof Error ? error.message : String(error);
        }
      }
      sources.push({
        clip,
        attemptId: attempt.id,
        artifact: output.artifact,
        media,
        ...(visualAssessment ? { visualAssessment } : {}),
        ...(visualWarning ? { visualWarning } : {})
      });
      selectionAudit.push({
        clipId: clip.id,
        clipHash: clip.contentHash,
        attemptId: attempt.id,
        artifactHash: output.artifact.sha256,
        decisionId: review.id,
        usage: usage?.id,
        ...(visualAssessment ? {
          visualAssessmentArtifactId: visualAssessment.artifactId,
          visualAssessmentArtifactHash: visualAssessment.artifactHash,
          visualAssessmentStatus: visualAssessment.assessment.status,
          visualWindow: visualAssessment.selectedWindow
        } : {}),
        ...(visualWarning ? { visualWarning } : {})
      });
    }
    if (!sources.length) throw new AutoEditBlocked("NO_ACCEPTED_VIDEO", "至少采用一个镜头后才能自动剪辑");
    return { w, sources, stamp: hashValue({ truth: w.productTruth.contentHash, script: w.script.contentHash, plan: w.productionPlan.contentHash, selectionAudit }) };
  }
  async voices() {
    try { return { available: Boolean(this.d.speech), voices: await this.d.speech?.voices() ?? [], message: "仅使用本机已安装系统音色；不调用付费语音服务" }; }
    catch (error) { return { available: false, voices: [], message: error instanceof Error ? error.message : String(error) }; }
  }
  private async prepareAudio(projectId: string, settings: PostProductionSettings, sources: AutoEditSource[]): Promise<PreparedAudio[]> {
    const prepared: PreparedAudio[] = [];
    const segments = new Map(sources.flatMap(s => s.clip.segments.map(segment => [segment.id, segment] as const)));
    const bindings = new Set<string>();
    for (const binding of settings.audioBindings) {
      const segment = segments.get(binding.segmentId), key = binding.kind + ":" + binding.segmentId;
      if (!segment || bindings.has(key)) throw new AutoEditBlocked("AUDIO_BINDING_INVALID", "音轨绑定不属于已采用分镜，或一个分段出现重复配音绑定", true);
      bindings.add(key);
      if (binding.kind === "NARRATION" && segment.dialogueOrNarration.kind === "NONE") throw new AutoEditBlocked("UNSCRIPTED_NARRATION", "不能给没有确认台词的分段加入旁白", true);
      const { artifact, file } = await this.verified(projectId, binding.artifactId, "audio");
      const media = await inspectMedia(file);
      prepared.push({ segmentId: binding.segmentId, kind: binding.kind, artifact, media, inMs: binding.inMs,
        outMs: binding.outMs ?? media.durationMs, volume: binding.volume });
    }
    if (settings.bgmArtifactId) {
      const { artifact, file } = await this.verified(projectId, settings.bgmArtifactId, "audio");
      const media = await inspectMedia(file);
      prepared.push({ kind: "BGM", artifact, media, inMs: 0, outMs: media.durationMs, volume: settings.bgmVolume });
    }
    for (const source of sources) for (const segment of source.clip.segments) {
      if (segment.dialogueOrNarration.kind === "NONE" || prepared.some(a => a.kind === "NARRATION" && a.segmentId === segment.id)) continue;
      const synthesize = settings.narrationMode === "LOCAL_TTS" || (settings.narrationMode === "SOURCE_OR_LOCAL_TTS" && (!source.media.hasAudio || settings.sourceVolume === 0));
      if (!synthesize) continue;
      if (!this.d.speech) throw new AutoEditBlocked("LOCAL_SPEECH_UNAVAILABLE", "当前没有本地语音引擎，请提供旁白音频", true);
      const voices = await this.d.speech.voices();
      const text = segment.dialogueOrNarration.text;
      const locale = /\p{Script=Han}/u.test(text) ? "zh" : "en";
      const voice = settings.voiceName ? voices.find(v => v.name === settings.voiceName) : voices.find(v => v.locale.startsWith(locale));
      if (!voice) throw new AutoEditBlocked("VOICE_UNAVAILABLE", "没有匹配文本语言的系统音色，请提供配音或选择已安装音色", true);
      const key = hashValue({ projectId, engine: this.d.speech.id, voice: voice.name, rate: settings.speechRate, text });
      const artifactId = "speech-" + key;
      let existing = await this.d.artifacts.findById(artifactId);
      if (!existing) {
        const directory = path.join(this.d.projectsRoot, projectId, ".tmp", "speech-" + randomUUID());
        await fs.mkdir(directory, { recursive: true });
        try {
          const file = path.resolve(directory, "narration.wav");
          await this.d.speech.synthesize({ text, voiceName: voice.name, rate: settings.speechRate, outputPath: file });
          const media = await inspectMedia(file);
          if (!media.hasAudio) throw new AutoEditBlocked("SPEECH_EMPTY", "本地语音没有生成有效音轨", true);
          existing = await this.store(projectId).writeImmutable({ id: artifactId, projectId, kind: "OTHER", immutable: true,
            relativePath: "post-production/speech/" + key + ".wav", bytes: await fs.readFile(file), mimeType: "audio/wav" });
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
      const { artifact, file } = await this.verified(projectId, artifactId, "audio");
      const media = await inspectMedia(file);
      prepared.push({ segmentId: segment.id, kind: "NARRATION", artifact, media, inMs: 0, outMs: media.durationMs, volume: 1, synthesized: true, voiceName: voice.name });
    }
    return prepared;
  }
  async create(input: AutoEditInput): Promise<AutoEditResult> {
    return withSerialOperation("auto-edit:" + input.projectId, async () => {
      const settings = postProductionSettingsSchema.parse(input.settings);
      const current = await this.d.timelines.latestTimeline(input.projectId);
      const selected = await this.selection(input.projectId, input.attemptIds);
      const { w, sources, stamp } = selected;
      if (input.expectedPlanHash && input.expectedPlanHash !== w.productionPlan!.contentHash) throw new AutoEditBlocked("PLAN_CHANGED", "本次编排的导演计划已失效，不能替换时间线");
      const audio = await this.prepareAudio(input.projectId, settings, sources);
      const key = hashValue({ source: "RULE_BASED_AUTO_EDIT_V1", plannerVersion: AUTO_EDIT_PLANNER_VERSION,
        fallbackAspectRatio: w.project.aspectRatio, projectId: input.projectId, stamp, settings,
        audio: audio.map(a => ({ segmentId: a.segmentId, kind: a.kind, id: a.artifact.id, sha256: a.artifact.sha256, voiceName: a.voiceName })), replacement: input.replaceTimeline });
      const artifactId = "auto-edit-plan-" + key;
      let plan: AutoEditPlan;
      const previous = await this.d.artifacts.findById(artifactId);
      if (previous) {
        const { file } = await this.verified(input.projectId, artifactId, "json");
        plan = autoEditPlanSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
        const { contentHash, ...body } = plan;
        if (hashValue(body) !== contentHash || plan.inputHash !== key) throw new AutoEditBlocked("AUTO_EDIT_CORRUPT", "自动剪辑决策校验失败，不能覆盖历史记录");
      } else {
        plan = planAutoEdit({ operationKey: key, truth: w.productTruth!, script: w.script!, plan: w.productionPlan!, sources, audio, settings,
          targetDurationMs: w.project.targetDurationMs, fallbackAspectRatio: w.project.aspectRatio,
          referenceVideoProfileHash: w.productionPlan!.referenceVideoProfileRef?.hash });
        await this.store(input.projectId).writeImmutable({ id: artifactId, projectId: input.projectId, kind: "STRUCTURED_SNAPSHOT", immutable: true,
          relativePath: "post-production/auto-edit/" + key + ".json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(plan, null, 2)) });
      }
      if ((await this.selection(input.projectId, input.attemptIds)).stamp !== stamp) throw new AutoEditBlocked("SELECTION_CHANGED", "审片或计划在剪辑期间已更新，本次自动决策不覆盖新进度");
      if (current?.autoEditOrigin?.operationKey === key) {
        if (current.status === "STALE" || current.contentHash !== plan.timeline.contentHash || timelineDecisionHash(current) !== current.contentHash) {
          throw new AutoEditBlocked("TIMELINE_MANUALLY_CHANGED", "自动时间线已被人工修改，保留手工版本；请确认当前时间线或明确重新剪辑");
        }
        const latest = await this.d.timelines.latestTimeline(input.projectId);
        if (latest?.id !== current.id || latest.contentHash !== current.contentHash || latest.status === "STALE") throw new AutoEditBlocked("TIMELINE_CHANGED", "时间线已经更新");
        return { plan, planArtifactId: artifactId, timeline: current };
      }
      if (current && current.status !== "STALE" && current.productionPlanHash === w.productionPlan!.contentHash &&
          (input.replaceTimeline?.id !== current.id || input.replaceTimeline?.hash !== current.contentHash)) {
        throw new AutoEditBlocked("EXISTING_TIMELINE", "当前已有时间线，自动剪辑不会覆盖；请在剪辑页明确确认重新剪辑，或采用现有时间线");
      }
      if (input.replaceTimeline && (current?.id !== input.replaceTimeline.id || current.contentHash !== input.replaceTimeline.hash)) throw new AutoEditBlocked("TIMELINE_CHANGED", "确认替换的时间线已改变，请刷新");
      if (!this.d.timelines.installAutoTimeline) throw new AutoEditBlocked("ATOMIC_EDIT_STORE_REQUIRED", "当前时间线存储不支持安全安装自动剪辑结果");
      const timeline = await this.d.timelines.installAutoTimeline({ ...plan.timeline, autoEditOrigin: { operationKey: key, planArtifactId: artifactId, planHash: plan.contentHash, initialContentHash: plan.timeline.contentHash } },
        current ? { id: current.id, hash: current.contentHash, status: current.status } : null);
      return { plan, planArtifactId: artifactId, timeline };
    });
  }
}
