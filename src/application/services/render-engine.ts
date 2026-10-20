import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type {
  FinalAssembly,
  FinalOutputRepository
} from "../ports/final-output-repository.js";
import type { TimelineRepository } from "../ports/timeline-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import type {
  RenderJob,
  Timeline,
  TimelineClipEdit,
  TimelineAudioItem,
  TimelineTextItem
} from "../../domain/schemas.js";
import { sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { audioVolumeFilter, renderableText } from "./render-audio.js";
import { timelineDurationMs, timelineDecisionHash } from "./timeline-service.js";
import { withSerialOperation } from "./serial-operation.js";
import type { RenderExecution, RenderRecoveryResult } from "../../domain/render-execution.js";

export type RenderRecoveryOptions = {
  processState?: (pid: number) => "ALIVE" | "DEAD" | "UNKNOWN";
  inspectMedia?: typeof inspectMedia;
  validateDecodedMedia?: (file: string) => Promise<void>;
};

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 900_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              file +
                " failed: " +
                error.message +
                "\n" +
                String(stderr).slice(-8000)
            )
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function escapeDrawtext(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n");
}

function positionExpression(position: "TOP" | "CENTER" | "BOTTOM"): string {
  if (position === "TOP") return "h*0.08";
  if (position === "CENTER") return "(h-text_h)/2";
  return "h-text_h-h*0.08";
}

type VideoInput = {
  clip: TimelineClipEdit;
  absolutePath: string;
  hasAudio: boolean;
};

export class RenderEngine {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly artifacts: ArtifactRepository,
    private readonly timelines: TimelineRepository,
    private readonly finalOutput: FinalOutputRepository,
    private readonly projectsRoot: string,
    private readonly ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe",
    private readonly recoveryOptions: RenderRecoveryOptions = {}
  ) {}

  private processState(pid: number): "ALIVE" | "DEAD" | "UNKNOWN" {
    if (!Number.isSafeInteger(pid) || pid <= 0) return "UNKNOWN";
    if (this.recoveryOptions.processState) return this.recoveryOptions.processState(pid);
    try { process.kill(pid, 0); return "ALIVE"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "DEAD" : "UNKNOWN"; }
  }

  private async saveExecution(execution: RenderExecution): Promise<void> {
    execution.updatedAt = new Date().toISOString();
    if (!await this.timelines.updateRenderExecution?.(execution)) {
      throw new DomainValidationError("渲染执行权已变化，旧执行器不能写入进度");
    }
  }

  private async runTrackedFfmpeg(args: string[], cwd: string, execution: RenderExecution): Promise<void> {
    // A crash between spawn and PID persistence is intentionally UNKNOWN.
    execution.phase = "STARTING";
    await this.saveExecution(execution);
    await new Promise<void>((resolve, reject) => {
      let registered: Promise<void> = Promise.resolve();
      const child = execFile(this.ffmpegPath, args, { cwd, timeout: 900_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          void registered.then(() => {
            if (error) reject(new Error("FFmpeg 渲染失败：" + error.message + "\n" + String(stderr).slice(-8000)));
            else resolve();
          }, reject);
        });
      if (child.pid) {
        execution.childPid = child.pid;
        execution.phase = "RUNNING";
        registered = this.saveExecution(execution);
        void registered.catch(() => { child.kill(); });
      }
    });
  }

  private async commitRenderedOutput(job: RenderJob, timeline: Timeline, execution: RenderExecution, sourcePath: string, recovering: boolean) {
    const projectId = job.projectId;
    const store = new LocalArtifactStore(path.resolve(this.projectsRoot, projectId), this.artifacts);
    if (execution.data.version !== 1 || execution.data.timelineId !== job.timelineId || execution.data.timelineHash !== job.timelineHash ||
        execution.data.productionPlanHash !== timeline.productionPlanHash || !execution.data.outputRelativePath.startsWith("final/timeline-" + job.id + "-")) {
      throw new DomainValidationError("渲染恢复记录与时间线不匹配");
    }
    this.assertJobInputs(timeline, job);
    for (let index = 0; index < job.inputArtifactIds.length; index++) {
      await this.verifyArtifact({ projectId, artifactId: job.inputArtifactIds[index]!, artifactHash: job.inputArtifactHashes[index]!, store });
    }
    const measured = await (this.recoveryOptions.inspectMedia ?? inspectMedia)(sourcePath, this.ffprobePath);
    if (!measured.hasVideo || !measured.hasAudio || measured.width !== job.renderConfig.width || measured.height !== job.renderConfig.height ||
        Math.abs(measured.durationMs - timelineDurationMs(timeline)) > Math.max(120, 2000 / job.renderConfig.fps)) {
      throw new DomainValidationError("最终视频的实际画幅、音轨或时长不符合本次时间线，未标记成功");
    }
    if (recovering) {
      // Metadata alone cannot prove an interrupted MP4 is decodable through its end.
      if (this.recoveryOptions.validateDecodedMedia) await this.recoveryOptions.validateDecodedMedia(sourcePath);
      else await execFileAsync(this.ffmpegPath, ["-v", "error", "-xerror", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { timeout: 900_000 });
    }
    const bytes = await fs.readFile(sourcePath);
    if (!bytes.length) throw new DomainValidationError("渲染结果为空");
    const hash = sha256Bytes(bytes);
    if (execution.data.outputArtifactHash && execution.data.outputArtifactHash !== hash) throw new DomainValidationError("渲染输出校验值已改变");
    const latest = await this.timelines.latestTimeline(projectId);
    if (latest?.id !== timeline.id || latest.contentHash !== timeline.contentHash || latest.status !== "CONFIRMED") {
      throw new DomainValidationError("渲染期间时间线发生变化，旧结果不会覆盖当前成片");
    }
    await this.assertCurrentPlan(projectId, timeline.productionPlanHash);
    execution.data.outputArtifactHash = hash;
    execution.phase = "OUTPUT_READY";
    await this.saveExecution(execution);
    let output = await this.artifacts.findById(execution.data.outputArtifactId);
    if (output) {
      if (output.projectId !== projectId || output.kind !== "FINAL_VIDEO" || output.relativePath !== execution.data.outputRelativePath) {
        throw new DomainValidationError("恢复产物归属与原渲染记录不一致");
      }
      const target = store.resolveArtifactPath(output.relativePath);
      let persisted: Buffer;
      try { persisted = await fs.readFile(target); }
      catch (error) {
        if (output.integrityStatus !== "PENDING" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Resume an interrupted immutable publication without creating another
        // Artifact or overwriting a target that appeared in the meantime.
        await fs.mkdir(path.dirname(target), { recursive: true });
        try { await fs.link(sourcePath, target); }
        catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
        persisted = await fs.readFile(target);
      }
      if (sha256Bytes(persisted) !== hash) throw new DomainValidationError("已登记成片与恢复结果不一致，不覆盖历史产物");
      if (output.integrityStatus === "PENDING") output = await this.artifacts.markReady(output.id, { sha256: hash, sizeBytes: persisted.length, mimeType: "video/mp4" });
      if (output.integrityStatus !== "READY" || output.sha256 !== hash) throw new DomainValidationError("已登记成片完整性异常，不覆盖历史产物");
    } else {
      output = await store.writeImmutable({ id: execution.data.outputArtifactId, projectId, kind: "FINAL_VIDEO",
        relativePath: execution.data.outputRelativePath, immutable: true, bytes, mimeType: "video/mp4" });
    }
    let assembly = await this.finalOutput.latestAssembly(projectId);
    if (!assembly || assembly.status === "STALE" || assembly.renderJobId !== job.id || assembly.timelineHash !== timeline.contentHash ||
        assembly.outputArtifactId !== output.id || assembly.outputArtifactHash !== hash) {
      await this.finalOutput.markAssembliesStale(projectId);
      assembly = await this.finalOutput.createAssembly({ id: execution.data.assemblyId, projectId, productionPlanHash: timeline.productionPlanHash,
        selectedClipIds: timeline.clips.filter(clip => !clip.deleted).sort((a, b) => a.order - b.order).map(clip => clip.sourceClipId),
        inputArtifactIds: job.inputArtifactIds, inputArtifactHashes: job.inputArtifactHashes,
        outputArtifactId: output.id, outputArtifactHash: hash, timelineId: timeline.id, timelineHash: timeline.contentHash,
        renderJobId: job.id, renderConfig: job.renderConfig, status: "READY", createdAt: new Date().toISOString() });
    }
    const renderJob = await this.timelines.finishRenderExecution?.(job.id, execution.ownerToken, {
      status: "SUCCEEDED", outputArtifactId: output.id, outputArtifactHash: hash, completedAt: new Date().toISOString()
    });
    if (!renderJob) throw new DomainValidationError("渲染执行权已变化，旧结果不能标记成功");
    await this.productFlow.setProjectStatus(projectId, "FINAL_REVIEW");
    return { assembly, renderJob };
  }

  /** Only positively dead owners are recovered. No elapsed-time lock stealing. */
  async recoverAbandoned(projectId?: string): Promise<RenderRecoveryResult[]> {
    const projects = projectId ? [{ id: projectId }] : await this.productFlow.listProjects();
    const results: RenderRecoveryResult[] = [];
    for (const project of projects) {
      await withSerialOperation("render:" + project.id, async () => {
        const jobs = (await this.timelines.listRenderJobs(project.id)).filter(job => job.status === "RENDERING");
        for (const job of jobs) {
          const result = (outcome: RenderRecoveryResult["outcome"], message: string) => results.push({ projectId: project.id, renderJobId: job.id, outcome, message });
          let previous: RenderExecution | null | undefined;
          try { previous = await this.timelines.getRenderExecution?.(job.id); }
          catch { result("OWNER_UNKNOWN", "无法核验渲染归属记录，未修改任务；请检查迁移与记录完整性。"); continue; }
          if (!previous) { result("OWNER_UNKNOWN", "历史渲染没有执行归属记录；请人工核对进程和输出后恢复，系统不会自动清零或重试。"); continue; }
          const owner = this.processState(previous.ownerPid);
          const child = previous.childPid ? this.processState(previous.childPid) : undefined;
          if (owner === "ALIVE" || child === "ALIVE") { result("LIVE_OWNER", "原渲染进程仍存活，未接管。"); continue; }
          if (owner !== "DEAD" || child === "UNKNOWN" || (!previous.childPid && ["STARTING", "RUNNING"].includes(previous.phase))) {
            result("OWNER_UNKNOWN", "无法确定原渲染或子进程已退出；保留执行记录，需人工核对。"); continue;
          }
          const execution: RenderExecution = { ...previous, ownerToken: randomUUID(), ownerPid: process.pid,
            childPid: undefined, phase: "RECOVERING", updatedAt: new Date().toISOString(),
            data: { ...previous.data, recoveredFromToken: previous.ownerToken } };
          if (!await this.timelines.claimRenderExecution?.(execution, previous.ownerToken)) { result("LEASE_CHANGED", "执行权已改变，未写入旧恢复结果。"); continue; }
          try {
            const timeline = await this.timelines.findTimelineById(job.timelineId);
            if (!timeline || timeline.status !== "CONFIRMED" || timeline.contentHash !== job.timelineHash) throw new DomainValidationError("原时间线已变化，不能接回旧成片");
            const store = new LocalArtifactStore(path.resolve(this.projectsRoot, project.id), this.artifacts);
            const existing = await this.artifacts.findById(execution.data.outputArtifactId);
            if (!execution.data.stagingRelativePath.startsWith(".recovery/render-executions/")) throw new DomainValidationError("渲染暂存路径无效");
            let candidate = store.resolveArtifactPath(execution.data.stagingRelativePath);
            if (existing) {
              const published = store.resolveArtifactPath(existing.relativePath);
              try { await fs.stat(published); candidate = published; }
              catch (error) { if (existing.integrityStatus !== "PENDING" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
            await this.commitRenderedOutput(job, timeline, execution, candidate, true);
            result("RECOVERED", "完整输出已通过文件、媒体、输入和时间线校验，并接回本次成片。");
          } catch (error) {
            const finished = await this.timelines.finishRenderExecution?.(job.id, execution.ownerToken, {
              status: "FAILED", errorCode: "RENDER_INTERRUPTED_RETRYABLE",
              errorMessage: "原渲染已中断，输出未通过恢复校验；可重新渲染，历史产物保留。" + (error instanceof Error ? error.message : String(error)),
              completedAt: new Date().toISOString()
            });
            result(finished ? "RETRYABLE" : "LEASE_CHANGED", finished ? "原进程已退出，未找到可校验完整输出；已标记可重新渲染，未自动重试。" : "恢复执行权已改变，未覆盖新状态。");
          }
        }
      });
    }
    return results;
  }

  private async hasAudioStream(absolutePath: string): Promise<boolean> {
    try {
      const result = await execFileAsync(
        this.ffprobePath,
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=index",
          "-of",
          "csv=p=0",
          absolutePath
        ],
        { timeout: 30_000 }
      );
      return Boolean(result.stdout.trim());
    } catch {
      return false;
    }
  }

  private async resolveFontFile(): Promise<string | undefined> {
    const candidates = [
      "C:\\Windows\\Fonts\\msyh.ttc",
      "C:\\Windows\\Fonts\\msyhbd.ttc",
      "C:\\Windows\\Fonts\\simhei.ttf",
      "C:\\Windows\\Fonts\\arial.ttf"
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Continue to the next installed font.
      }
    }
    return undefined;
  }

  private async verifyArtifact(input: {
    projectId: string;
    artifactId: string;
    artifactHash: string;
    expectedVideo?: boolean;
    expectedAudio?: boolean;
    store: LocalArtifactStore;
  }): Promise<{ absolutePath: string; mimeType?: string }> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256 ||
      artifact.sha256 !== input.artifactHash
    ) {
      throw new DomainValidationError(
        "Timeline input Artifact is not READY or hash changed: " +
          input.artifactId
      );
    }
    if (input.expectedVideo && artifact.kind !== "GENERATED_VIDEO") {
      throw new DomainValidationError(
        "Timeline video input must reference GENERATED_VIDEO: " +
          input.artifactId
      );
    }
    if (
      input.expectedAudio &&
      (!artifact.mimeType || !artifact.mimeType.startsWith("audio/"))
    ) {
      throw new DomainValidationError(
        "Timeline BGM input must reference an audio Artifact: " +
          input.artifactId
      );
    }
    const absolutePath = input.store.resolveArtifactPath(artifact.relativePath);
    const bytes = await fs.readFile(absolutePath);
    const actualHash = sha256Bytes(bytes);
    if (actualHash !== input.artifactHash) {
      throw new DomainValidationError(
        "Timeline input Artifact bytes changed: " + input.artifactId
      );
    }
    return {
      absolutePath,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
    };
  }

  private assertJobInputs(timeline: Timeline, job: RenderJob): void {
    const expected = new Map<string, string>();
    for (const clip of timeline.clips) {
      if (!clip.deleted) {
        expected.set(clip.sourceArtifactId, clip.sourceArtifactHash);
      }
    }
    for (const item of timeline.audioItems) {
      if (!item.deleted) {
        expected.set(item.sourceArtifactId, item.sourceArtifactHash);
      }
    }
    for (const mask of timeline.repairMasks) {
      if (mask.deleted) continue;
      if (expected.get(mask.sourceArtifactId) !== mask.sourceArtifactHash) {
        throw new DomainValidationError(
          "Repair mask source no longer matches confirmed Timeline video: " +
            mask.sourceArtifactId
        );
      }
    }
    const actual = new Map<string, string>();
    job.inputArtifactIds.forEach((id, index) => {
      actual.set(id, job.inputArtifactHashes[index] ?? "");
    });
    if (actual.size !== expected.size) {
      throw new DomainValidationError(
        "RenderJob input Artifact set no longer matches confirmed Timeline"
      );
    }
    for (const [id, hash] of expected) {
      if (actual.get(id) !== hash) {
        throw new DomainValidationError(
          "RenderJob input Artifact hash mismatch: " + id
        );
      }
    }
  }

  private buildFilterGraph(input: {
    timeline: Timeline;
    job: RenderJob;
    videos: VideoInput[];
    audioInputs: Array<{ item: TimelineAudioItem; index: number }>;
    texts: TimelineTextItem[];
    textFiles: Map<string, string>;
    fontFile?: string;
  }): { filter: string; videoLabel: string; audioLabel: string } {
    const { timeline, job, videos } = input;
    const config = job.renderConfig;
    const filters: string[] = [];
    const durationsMs = videos.map(
      (item) => item.clip.outMs - item.clip.inMs
    );

    videos.forEach((item, index) => {
      const clip = item.clip;
      const inSec = seconds(clip.inMs);
      const outSec = seconds(clip.outMs);
      filters.push(
        "[" +
          index +
          ":v]trim=start=" +
          inSec +
          ":end=" +
          outSec +
          ",setpts=PTS-STARTPTS" +
          ",scale=" +
          config.width +
          ":" +
          config.height +
          ":force_original_aspect_ratio=decrease" +
          ",pad=" +
          config.width +
          ":" +
          config.height +
          ":(ow-iw)/2:(oh-ih)/2:black" +
          ",setsar=1,fps=" +
          config.fps +
          ",format=yuv420p,settb=AVTB[v" +
          index +
          "]"
      );
      const volumeFilter = audioVolumeFilter(clip.audio, durationsMs[index]!, timeline.tracks.find(t => t.id === clip.trackId)?.muted);
      if (item.hasAudio) {
        filters.push(
          "[" +
            index +
            ":a]atrim=start=" +
            inSec +
            ":end=" +
            outSec +
            ",asetpts=PTS-STARTPTS" +
            ",aresample=48000" +
            ",aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo" +
            ",apad,atrim=duration=" + seconds(durationsMs[index]!) + "," + volumeFilter +
            "[a" +
            index +
            "]"
        );
      } else {
        filters.push(
          "anullsrc=channel_layout=stereo:sample_rate=48000" +
            ",atrim=duration=" +
            seconds(durationsMs[index]!) +
            ",asetpts=PTS-STARTPTS[a" +
            index +
            "]"
        );
      }
    });

    let videoLabel = "v0";
    let audioLabel = "a0";
    let accumulatedMs = durationsMs[0] ?? 0;

    for (let index = 1; index < videos.length; index += 1) {
      const previous = videos[index - 1]!.clip;
      const nextVideo = "v" + index;
      const nextAudio = "a" + index;
      const joinedVideo = "vj" + index;
      const joinedAudio = "aj" + index;

      if (previous.transition.type === "CUT") {
        filters.push(
          "[" +
            videoLabel +
            "][" +
            nextVideo +
            "]concat=n=2:v=1:a=0[" +
            joinedVideo +
            "]"
        );
        filters.push(
          "[" +
            audioLabel +
            "][" +
            nextAudio +
            "]concat=n=2:v=0:a=1[" +
            joinedAudio +
            "]"
        );
        accumulatedMs += durationsMs[index]!;
      } else {
        const transitionMs = previous.transition.durationMs;
        const transitionSec = seconds(transitionMs);
        const offsetSec = seconds(accumulatedMs - transitionMs);
        const transitionName =
          previous.transition.type === "FADE" ? "fadeblack" : "fade";
        filters.push(
          "[" +
            videoLabel +
            "][" +
            nextVideo +
            "]xfade=transition=" +
            transitionName +
            ":duration=" +
            transitionSec +
            ":offset=" +
            offsetSec +
            "[" +
            joinedVideo +
            "]"
        );
        filters.push(
          "[" +
            audioLabel +
            "][" +
            nextAudio +
            "]acrossfade=d=" +
            transitionSec +
            ":c1=tri:c2=tri[" +
            joinedAudio +
            "]"
        );
        accumulatedMs += durationsMs[index]! - transitionMs;
      }

      videoLabel = joinedVideo;
      audioLabel = joinedAudio;
    }

    const activeMasks = timeline.repairMasks.filter((item) => !item.deleted);
    activeMasks.forEach((item, index) => {
      const nextLabel = "vm" + index;
      const x = Math.round(config.width * item.xRatio);
      const y = Math.round(config.height * item.yRatio);
      const width = Math.max(1, Math.round(config.width * item.widthRatio));
      const height = Math.max(1, Math.round(config.height * item.heightRatio));
      const color = item.color === "BLACK" ? "black" : "white";
      filters.push(
        "[" + videoLabel + "]drawbox=" +
          "x=" + x + ":y=" + y + ":w=" + width + ":h=" + height +
          ":color=" + color + "@" + item.opacity.toFixed(3) + ":t=fill" +
          ":enable='between(t," + seconds(item.startMs) + "," + seconds(item.endMs) + ")'[" + nextLabel + "]"
      );
      videoLabel = nextLabel;
    });

    const activeText = input.texts;
    activeText.forEach((item, index) => {
      const nextLabel = "vt" + index;
      const baseFontSize = Math.max(
        20,
        Math.round(
          (item.kind === "CTA" ? 58 : 44) *
            item.fontScale *
            (config.height / 1280)
        )
      );
      const widestLine = Math.max(1, ...item.text.split("\n").map(line => Array.from(line).reduce((n,c) => n + (/[\u0020-\u007e]/.test(c) ? 0.6 : 1), 0)));
      const fontSize = Math.max(12, Math.min(baseFontSize, Math.floor(config.width * 0.86 / widestLine)));
      const textFile = input.textFiles.get(item.id);
      if (!textFile) throw new DomainValidationError("字幕临时文件未准备完成");
      const fontOption = input.fontFile
        ? "fontfile='" +
          input.fontFile.replaceAll("\\", "/").replace(":", "\\:") +
          "':"
        : "";
      filters.push(
        "[" +
          videoLabel +
          "]drawtext=" +
          fontOption +
          "textfile='" + textFile + "':expansion=none:fix_bounds=1:fontcolor=white" +
          ":fontsize=" +
          fontSize +
          ":box=1:boxcolor=black@0.48:boxborderw=" +
          Math.max(8, Math.round(fontSize * 0.28)) +
          ":x=(w-text_w)/2:y=" +
          positionExpression(item.position) +
          ":enable='between(t," +
          seconds(item.startMs) +
          "," +
          seconds(item.endMs) +
          ")'[" +
          nextLabel +
          "]"
      );
      videoLabel = nextLabel;
    });

    const totalMs = Math.max(1, accumulatedMs);
    const mixLabels = [audioLabel];
    for (let i = 0; i < input.audioInputs.length; i++) {
      const { item, index } = input.audioInputs[i]!;
      const label = "postaudio" + i;
      const volume = audioVolumeFilter(item.audio, item.outMs - item.inMs, timeline.tracks.find(t => t.id === item.trackId)?.muted);
      filters.push(`[${index}:a]atrim=start=${seconds(item.inMs)}:end=${seconds(item.outMs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,${volume},adelay=${item.startMs}|${item.startMs},apad,atrim=duration=${seconds(totalMs)}[${label}]`);
      mixLabels.push(label);
    }
    if (mixLabels.length > 1) {
      filters.push(mixLabels.map(label => `[${label}]`).join("") + `amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[postmix]`);
      audioLabel = "postmix";
    }
    // Peak limiting with latency compensation; never normalizes a silent source into fake audio.
    filters.push(`[${audioLabel}]alimiter=limit=0.95:level=0:latency=1,apad,atrim=duration=${seconds(totalMs)}[finalaudio]`);
    audioLabel = "finalaudio";

    return {
      filter: filters.join(";"),
      videoLabel,
      audioLabel
    };
  }

  async render(projectId: string): Promise<{
    assembly: FinalAssembly;
    renderJob: RenderJob;
  }> {
    return withSerialOperation("render:" + projectId, () => this.renderExclusive(projectId));
  }

  private async assertCurrentPlan(projectId: string, planHash: string): Promise<void> {
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (!workspace?.productionPlan || workspace.productionPlan.status !== "CONFIRMED" || workspace.productionPlan.contentHash !== planHash ||
        (workspace.project.currentProductionPlanRef && workspace.project.currentProductionPlanRef.hash !== planHash)) {
      throw new DomainValidationError("导演方案已变化，旧时间线不能生成或复用为当前成片");
    }
  }

  private async renderExclusive(projectId: string): Promise<{
    assembly: FinalAssembly;
    renderJob: RenderJob;
  }> {
    const timeline = await this.timelines.latestTimeline(projectId);
    if (!timeline || timeline.status !== "CONFIRMED") {
      throw new DomainValidationError(
        "A confirmed Timeline is required before rendering"
      );
    }
    await this.assertCurrentPlan(projectId, timeline.productionPlanHash);
    const job = await this.timelines.latestRenderJob(projectId);
    if (
      !job ||
      job.timelineId !== timeline.id ||
      job.timelineHash !== timeline.contentHash
    ) {
      throw new DomainValidationError(
        "Current confirmed Timeline has no matching RenderJob"
      );
    }

    if (job.status === "SUCCEEDED") {
      const existing = await this.finalOutput.latestAssembly(projectId);
      if (
        existing &&
        existing.status !== "STALE" &&
        existing.renderJobId === job.id &&
        existing.timelineHash === timeline.contentHash &&
        existing.outputArtifactId === job.outputArtifactId &&
        existing.outputArtifactHash === job.outputArtifactHash
      ) {
        const source = await this.verifyArtifact({ projectId, artifactId: existing.outputArtifactId,
          artifactHash: existing.outputArtifactHash, store: new LocalArtifactStore(path.resolve(this.projectsRoot, projectId), this.artifacts) });
        const measured = await inspectMedia(source.absolutePath, this.ffprobePath);
        if (!measured.hasVideo || !measured.hasAudio || measured.width !== job.renderConfig.width || measured.height !== job.renderConfig.height ||
            Math.abs(measured.durationMs - timelineDurationMs(timeline)) > Math.max(120, 2000 / job.renderConfig.fps)) {
          throw new DomainValidationError("既有成片的实际媒体校验失败，不把旧成功状态当作可用产物");
        }
        return { assembly: existing, renderJob: job };
      }
      throw new DomainValidationError(
        "RenderJob is SUCCEEDED but matching FinalAssembly is missing"
      );
    }
    if (job.status === "RENDERING") {
      throw new DomainValidationError("当前渲染任务正在执行中");
    }

    const activeClips = timeline.clips
      .filter((clip) => !clip.deleted)
      .sort((a, b) => a.order - b.order);
    if (!activeClips.length) {
      throw new DomainValidationError(
        "Confirmed Timeline has no active video clips"
      );
    }
    this.assertJobInputs(timeline, job);
    if (timeline.autoEditOrigin && timelineDecisionHash(timeline) !== timeline.contentHash) {
      throw new DomainValidationError("自动时间线内容校验失败");
    }

    const projectRoot = path.resolve(this.projectsRoot, projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const videoInputs: VideoInput[] = [];
    for (const clip of activeClips) {
      const source = await this.verifyArtifact({
        projectId,
        artifactId: clip.sourceArtifactId,
        artifactHash: clip.sourceArtifactHash,
        expectedVideo: true,
        store
      });
      videoInputs.push({
        clip,
        absolutePath: source.absolutePath,
        hasAudio: await this.hasAudioStream(source.absolutePath)
      });
    }

    const activeAudio = timeline.audioItems.filter(item => !item.deleted).sort((a,b) => a.order-b.order);
    const audioInputs: Array<{ item: TimelineAudioItem; index: number; absolutePath: string }> = [];
    for (const item of activeAudio) {
      const source = await this.verifyArtifact({
        projectId,
        artifactId: item.sourceArtifactId,
        artifactHash: item.sourceArtifactHash,
        expectedAudio: true,
        store
      });
      if (!(await this.hasAudioStream(source.absolutePath))) {
        throw new DomainValidationError("后期音频文件中没有可用音轨");
      }
      audioInputs.push({ item, index: videoInputs.length + audioInputs.length, absolutePath: source.absolutePath });
    }

    const startedAt = new Date().toISOString();
    const ownerToken = randomUUID();
    const execution: RenderExecution = {
      renderJobId: job.id, projectId, ownerToken, ownerPid: process.pid, phase: "PREPARING", startedAt, updatedAt: startedAt,
      data: { version: 1, timelineId: timeline.id, timelineHash: timeline.contentHash, productionPlanHash: timeline.productionPlanHash,
        stagingRelativePath: ".recovery/render-executions/" + job.id + "/" + ownerToken + "/final.mp4",
        outputRelativePath: "final/timeline-" + job.id + "-" + ownerToken + ".mp4", outputArtifactId: randomUUID(), assemblyId: randomUUID() }
    };
    if (!this.timelines.claimRenderExecution || !this.timelines.updateRenderExecution || !this.timelines.finishRenderExecution ||
        !await this.timelines.claimRenderExecution(execution)) {
      throw new DomainValidationError("渲染持久执行权不可用或已被其他执行器领取，未启动 FFmpeg");
    }
    const currentJob: RenderJob = { ...job, status: "RENDERING", startedAt };
    const tempOutput = store.resolveArtifactPath(execution.data.stagingRelativePath);
    const tempDir = path.dirname(tempOutput);

    try {
      await fs.mkdir(tempDir, { recursive: true });
      const args: string[] = ["-hide_banner", "-loglevel", "error"];
      for (const item of videoInputs) {
        args.push("-i", item.absolutePath);
      }
      for (const input of audioInputs) args.push("-i", input.absolutePath);
      const texts = renderableText(timeline);
      const textFiles = new Map<string, string>();
      for (let i = 0; i < texts.length; i++) {
        const file = "caption-" + i + ".txt";
        await fs.writeFile(path.join(tempDir, file), texts[i]!.text, "utf8");
        textFiles.set(texts[i]!.id, file);
      }

      const graph = this.buildFilterGraph({
        timeline,
        job: currentJob,
        videos: videoInputs,
        audioInputs,
        texts,
        textFiles,
        ...(await this.resolveFontFile().then((fontFile) =>
          fontFile ? { fontFile } : {}
        ))
      });
      await fs.writeFile(path.join(tempDir, "filter-graph.txt"), graph.filter, "utf8");
      args.push(
        "-/filter_complex",
        "filter-graph.txt",
        "-map",
        "[" + graph.videoLabel + "]",
        "-map",
        "[" + graph.audioLabel + "]",
        "-c:v",
        currentJob.renderConfig.videoCodec,
        "-preset",
        "medium",
        "-crf",
        "18",
        "-r",
        String(currentJob.renderConfig.fps),
        "-c:a",
        currentJob.renderConfig.audioCodec,
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-y",
        tempOutput
      );

      if (process.platform === "win32" && args.join(" ").length > 28000) throw new DomainValidationError("音轨数量或路径过长，请合并音轨后再渲染");
      await this.runTrackedFfmpeg(args, tempDir, execution);
      return await this.commitRenderedOutput(currentJob, timeline, execution, tempOutput, false);
    } catch (error) {
      await this.timelines.finishRenderExecution(currentJob.id, execution.ownerToken, {
        status: "FAILED",
        errorCode: "RENDER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
