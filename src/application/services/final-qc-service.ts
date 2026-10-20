import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { FinalOutputRepository } from "../ports/final-output-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import type { TimelineService } from "./timeline-service.js";
import type { Timeline } from "../../domain/schemas.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {
  finalQcReportSchema,
  type FinalQcCheck,
  type FinalQcReport,
  type FinalQcSeverity
} from "../../domain/final-qc.js";
import { timelineDurationMs } from "./timeline-service.js";

const QC_VERSION = "final-qc-v1";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

type ScanRange = {
  start: number;
  end: number;
  duration: number;
};

function severityRank(value: FinalQcSeverity): number {
  return value === "BLOCK" ? 3 : value === "WARN" ? 2 : 1;
}

function overall(checks: FinalQcCheck[]): FinalQcSeverity {
  return [...checks].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  )[0]?.severity ?? "WARN";
}

function weightedTextLength(text: string): number {
  return Math.max(
    0,
    ...text.split("\n").map((line) =>
      Array.from(line).reduce(
        (sum, char) => sum + (/[ -~]/.test(char) ? 0.6 : 1),
        0
      )
    )
  );
}

function invalidText(text: string): boolean {
  if (text.includes(String.fromCharCode(0xfffd))) return true;
  return Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31)
    );
  });
}

function expectedRatio(value: string): number | undefined {
  if (value === "9:16") return 9 / 16;
  if (value === "16:9") return 16 / 9;
  if (value === "1:1") return 1;
  return undefined;
}

function parseRangeEvents(
  text: string,
  kind: "silence" | "black" | "freeze",
  totalSeconds: number
): ScanRange[] {
  if (kind === "black") {
    const ranges: ScanRange[] = [];
    const regex =
      /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
    for (const match of text.matchAll(regex)) {
      ranges.push({
        start: Number(match[1]),
        end: Number(match[2]),
        duration: Number(match[3])
      });
    }
    return ranges.filter((item) => Number.isFinite(item.duration));
  }

  const startKey = kind === "silence" ? "silence_start" : "freeze_start";
  const endKey = kind === "silence" ? "silence_end" : "freeze_end";
  const durationKey =
    kind === "silence" ? "silence_duration" : "freeze_duration";
  const startRegex = new RegExp(startKey + ":\\s*([0-9.]+)", "g");
  const endRegex = new RegExp(
    endKey + ":\\s*([0-9.]+)(?:\\s*\\|\\s*" +
      durationKey +
      ":\\s*([0-9.]+))?",
    "g"
  );
  const starts = [...text.matchAll(startRegex)].map((item) => Number(item[1]));
  const ends = [...text.matchAll(endRegex)].map((item) => ({
    end: Number(item[1]),
    duration: item[2] ? Number(item[2]) : undefined
  }));
  const result: ScanRange[] = [];
  const count = Math.max(starts.length, ends.length);
  for (let index = 0; index < count; index += 1) {
    const start = starts[index] ?? 0;
    const end = ends[index]?.end ?? totalSeconds;
    const duration = ends[index]?.duration ?? Math.max(0, end - start);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Number.isFinite(duration)
    ) {
      result.push({ start, end, duration });
    }
  }
  return result;
}

function rangeMetrics(ranges: ScanRange[], totalSeconds: number) {
  const total = ranges.reduce((sum, item) => sum + item.duration, 0);
  const max = ranges.reduce(
    (value, item) => Math.max(value, item.duration),
    0
  );
  return {
    count: ranges.length,
    maxSeconds: Number(max.toFixed(3)),
    totalSeconds: Number(total.toFixed(3)),
    ratio: totalSeconds > 0 ? Number((total / totalSeconds).toFixed(4)) : 0
  };
}

function checkFromRange(
  code: FinalQcCheck["code"],
  label: string,
  metrics: ReturnType<typeof rangeMetrics>,
  warn: { maxSeconds: number; ratio: number },
  block: { maxSeconds: number; ratio: number },
  noun: string
): FinalQcCheck {
  const severity: FinalQcSeverity =
    metrics.maxSeconds >= block.maxSeconds || metrics.ratio >= block.ratio
      ? "BLOCK"
      : metrics.maxSeconds >= warn.maxSeconds || metrics.ratio >= warn.ratio
        ? "WARN"
        : "PASS";
  return {
    code,
    severity,
    label,
    message:
      severity === "PASS"
        ? `未发现明显${noun}问题`
        : `检测到${noun}：最长 ${metrics.maxSeconds.toFixed(1)}s，占比 ${(
            metrics.ratio * 100
          ).toFixed(1)}%`,
    technical: {
      rangeCount: metrics.count,
      maxSeconds: metrics.maxSeconds,
      totalSeconds: metrics.totalSeconds,
      ratio: metrics.ratio
    }
  };
}

function execFfmpeg(
  executable: string,
  args: string[],
  timeout = 120_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const text = String(stdout) + "\n" + String(stderr);
        if (error) {
          reject(new Error(error.message + "\n" + text.slice(-4000)));
          return;
        }
        resolve(text);
      }
    );
  });
}

export class FinalQcService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly artifacts: ArtifactRepository,
    private readonly finalOutput: FinalOutputRepository,
    private readonly timelines: Pick<TimelineService, "latestTimeline">,
    private readonly review: ReviewRepository,
    private readonly projectsRoot: string,
    private readonly ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
  ) {}

  private store(projectId: string) {
    return new LocalArtifactStore(
      path.resolve(this.projectsRoot, projectId),
      this.artifacts
    );
  }

  async latest(projectId: string): Promise<FinalQcReport | null> {
    const assembly = await this.finalOutput.latestAssembly(projectId);
    if (!assembly || assembly.status === "STALE") return null;
    const candidates = (await this.artifacts.listByProject(projectId, "OTHER"))
      .filter(
        (item) =>
          item.integrityStatus === "READY" &&
          item.relativePath.startsWith("final-qc/") &&
          item.mimeType === "application/json"
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const store = this.store(projectId);
    for (const artifact of candidates) {
      try {
        const bytes = await fs.readFile(
          store.resolveArtifactPath(artifact.relativePath)
        );
        if (
          !artifact.sha256 ||
          sha256Bytes(bytes) !== artifact.sha256
        ) {
          continue;
        }
        const report = finalQcReportSchema.parse(
          JSON.parse(bytes.toString("utf8"))
        );
        if (
          report.assemblyId === assembly.id &&
          report.artifactId === assembly.outputArtifactId &&
          report.artifactHash === assembly.outputArtifactHash
        ) {
          return report;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async run(projectId: string): Promise<FinalQcReport> {
    const [workspace, assembly] = await Promise.all([
      this.productFlow.getWorkspace(projectId),
      this.finalOutput.latestAssembly(projectId)
    ]);
    if (!workspace || !assembly || assembly.status === "STALE") {
      throw new DomainValidationError("当前没有可质检的最终成片");
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
      throw new DomainValidationError("最终成片 Artifact 不可用或完整性记录不一致");
    }

    const store = this.store(projectId);
    const filePath = store.resolveArtifactPath(artifact.relativePath);
    const checks: FinalQcCheck[] = [];
    let fileBytes: Buffer;
    try {
      fileBytes = await fs.readFile(filePath);
      const actualHash = sha256Bytes(fileBytes);
      checks.push({
        code: "ARTIFACT_INTEGRITY",
        severity:
          actualHash === artifact.sha256 ? "PASS" : "BLOCK",
        label: "文件完整性",
        message:
          actualHash === artifact.sha256
            ? "最终成片文件与 Artifact SHA256 一致"
            : "最终成片文件与 Artifact SHA256 不一致",
        technical: {
          expectedHash: artifact.sha256,
          actualHash
        }
      });
      if (actualHash !== artifact.sha256) {
        return this.persistReport({
          projectId,
          workspace,
          assembly,
          artifactHash: artifact.sha256,
          checks
        });
      }
    } catch (error) {
      checks.push({
        code: "ARTIFACT_INTEGRITY",
        severity: "BLOCK",
        label: "文件完整性",
        message: "最终成片文件无法读取",
        technical: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return this.persistReport({
        projectId,
        workspace,
        assembly,
        artifactHash: artifact.sha256,
        checks
      });
    }

    let media:
      | Awaited<ReturnType<typeof inspectMedia>>
      | undefined;
    try {
      media = await inspectMedia(filePath, this.ffprobePath);
      checks.push({
        code: "FILE_PLAYABLE",
        severity: "PASS",
        label: "文件可播放性",
        message: "FFprobe 可读取最终成片媒体信息",
        technical: {
          durationMs: media.durationMs,
          hasVideo: media.hasVideo,
          hasAudio: media.hasAudio,
          ...(media.width ? { width: media.width } : {}),
          ...(media.height ? { height: media.height } : {})
        }
      });
    } catch (error) {
      checks.push({
        code: "FILE_PLAYABLE",
        severity: "BLOCK",
        label: "文件可播放性",
        message: "最终成片无法通过 FFprobe 验证",
        technical: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return this.persistReport({
        projectId,
        workspace,
        assembly,
        artifactHash: artifact.sha256,
        checks
      });
    }

    checks.push({
      code: "VIDEO_STREAM",
      severity: media.hasVideo ? "PASS" : "BLOCK",
      label: "视频轨",
      message: media.hasVideo ? "视频轨存在" : "最终成片没有视频轨"
    });

    const timeline = await this.timelines.latestTimeline(projectId);
    const currentTimeline: Timeline | undefined =
      timeline &&
      assembly.timelineId === timeline.id &&
      assembly.timelineHash === timeline.contentHash
        ? timeline
        : undefined;
    const expectedDurationMs = currentTimeline
      ? timelineDurationMs(currentTimeline)
      : workspace.project.targetDurationMs;
    const durationDiff = Math.abs(media.durationMs - expectedDurationMs);
    const warnTolerance = Math.max(750, expectedDurationMs * 0.05);
    const blockTolerance = Math.max(2500, expectedDurationMs * 0.15);
    checks.push({
      code: "DURATION",
      severity:
        durationDiff > blockTolerance
          ? "BLOCK"
          : durationDiff > warnTolerance
            ? "WARN"
            : "PASS",
      label: "成片时长",
      message:
        durationDiff <= warnTolerance
          ? `成片时长 ${(media.durationMs / 1000).toFixed(2)}s 与预期一致`
          : `成片时长 ${(media.durationMs / 1000).toFixed(
              2
            )}s，与预期 ${(expectedDurationMs / 1000).toFixed(2)}s 偏差 ${(
              durationDiff / 1000
            ).toFixed(2)}s`,
      technical: {
        actualDurationMs: media.durationMs,
        expectedDurationMs,
        differenceMs: durationDiff
      }
    });

    if (
      assembly.renderConfig &&
      media.width &&
      media.height
    ) {
      const exact =
        media.width === assembly.renderConfig.width &&
        media.height === assembly.renderConfig.height;
      checks.push({
        code: "RESOLUTION",
        severity: exact ? "PASS" : "BLOCK",
        label: "分辨率",
        message: exact
          ? `分辨率 ${media.width}×${media.height} 与渲染配置一致`
          : `实际分辨率 ${media.width}×${media.height}，预期 ${assembly.renderConfig.width}×${assembly.renderConfig.height}`,
        technical: {
          actualWidth: media.width,
          actualHeight: media.height,
          expectedWidth: assembly.renderConfig.width,
          expectedHeight: assembly.renderConfig.height
        }
      });
    } else {
      checks.push({
        code: "RESOLUTION",
        severity:
          media.width && media.height ? "PASS" : "BLOCK",
        label: "分辨率",
        message:
          media.width && media.height
            ? `实际分辨率 ${media.width}×${media.height}`
            : "无法确认最终成片分辨率"
      });
    }

    if (media.width && media.height) {
      const expected = expectedRatio(workspace.project.aspectRatio);
      if (expected === undefined) {
        checks.push({
          code: "ASPECT_RATIO",
          severity: "PASS",
          label: "画幅比例",
          message: `项目使用 AUTO；实际画幅 ${media.width}:${media.height}`
        });
      } else {
        const actual = media.width / media.height;
        const deviation = Math.abs(actual - expected) / expected;
        checks.push({
          code: "ASPECT_RATIO",
          severity:
            deviation > 0.03 ? "BLOCK" : deviation > 0.01 ? "WARN" : "PASS",
          label: "画幅比例",
          message:
            deviation <= 0.01
              ? `实际画幅符合项目 ${workspace.project.aspectRatio}`
              : `实际画幅与项目 ${workspace.project.aspectRatio} 有偏差`,
          technical: {
            actualRatio: Number(actual.toFixed(5)),
            expectedRatio: Number(expected.toFixed(5)),
            deviation: Number(deviation.toFixed(5))
          }
        });
      }
    }

    checks.push({
      code: "AUDIO_STREAM",
      severity: media.hasAudio ? "PASS" : "BLOCK",
      label: "音轨",
      message: media.hasAudio
        ? "最终成片包含音轨"
        : "最终成片没有音轨，不能通过发布前质检"
    });

    await this.addSignalChecks(checks, filePath, media.durationMs, media.hasAudio);
    this.addTextChecks(
      checks,
      currentTimeline,
      media.durationMs,
      workspace.project.aspectRatio
    );
    await this.addVisualEvidenceCheck(
      checks,
      projectId,
      assembly.selectedClipIds
    );

    return this.persistReport({
      projectId,
      workspace,
      assembly,
      artifactHash: artifact.sha256,
      checks
    });
  }

  async assertPublishable(projectId: string): Promise<FinalQcReport> {
    const report = await this.run(projectId);
    if (report.overall === "BLOCK") {
      const blockers = report.checks
        .filter((item) => item.severity === "BLOCK")
        .map((item) => item.label + "：" + item.message)
        .join("；");
      throw new DomainValidationError(
        "最终成片未通过发布前质检：" + blockers
      );
    }
    return report;
  }

  private async addSignalChecks(
    checks: FinalQcCheck[],
    filePath: string,
    durationMs: number,
    hasAudio: boolean
  ) {
    const totalSeconds = durationMs / 1000;
    try {
      const visual = await execFfmpeg(this.ffmpegPath, [
        "-hide_banner",
        "-nostats",
        "-i",
        filePath,
        "-vf",
        "blackdetect=d=0.5:pic_th=0.98:pix_th=0.10,freezedetect=n=0.003:d=2",
        "-an",
        "-f",
        "null",
        NULL_DEVICE
      ]);
      const black = rangeMetrics(
        parseRangeEvents(visual, "black", totalSeconds),
        totalSeconds
      );
      const freeze = rangeMetrics(
        parseRangeEvents(visual, "freeze", totalSeconds),
        totalSeconds
      );
      checks.push(
        checkFromRange(
          "BLACK_FRAMES",
          "黑帧 / 黑屏",
          black,
          { maxSeconds: 0.6, ratio: 0.1 },
          { maxSeconds: 2, ratio: 0.25 },
          "黑屏"
        )
      );
      checks.push(
        checkFromRange(
          "FREEZE_FRAMES",
          "冻结帧",
          freeze,
          { maxSeconds: 2.5, ratio: 0.25 },
          { maxSeconds: 6, ratio: 0.6 },
          "长时间冻结画面"
        )
      );
    } catch (error) {
      checks.push({
        code: "BLACK_FRAMES",
        severity: "WARN",
        label: "黑帧 / 冻结帧扫描",
        message: "FFmpeg 视觉异常扫描未完成，不能确认黑帧与冻结帧",
        technical: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }

    if (!hasAudio) return;
    try {
      const audio = await execFfmpeg(this.ffmpegPath, [
        "-hide_banner",
        "-nostats",
        "-i",
        filePath,
        "-af",
        "silencedetect=noise=-50dB:d=1.5",
        "-vn",
        "-f",
        "null",
        NULL_DEVICE
      ]);
      const silence = rangeMetrics(
        parseRangeEvents(audio, "silence", totalSeconds),
        totalSeconds
      );
      checks.push(
        checkFromRange(
          "LONG_SILENCE",
          "长静音",
          silence,
          { maxSeconds: 2.5, ratio: 0.25 },
          { maxSeconds: 8, ratio: 0.5 },
          "静音"
        )
      );
    } catch (error) {
      checks.push({
        code: "LONG_SILENCE",
        severity: "WARN",
        label: "长静音",
        message: "FFmpeg 静音扫描未完成，不能确认长静音",
        technical: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private addTextChecks(
    checks: FinalQcCheck[],
    timeline: Timeline | undefined,
    durationMs: number,
    aspectRatio: string
  ) {
    if (!timeline) {
      checks.push({
        code: "TEXT_INTEGRITY",
        severity: "WARN",
        label: "字幕 / CTA",
        message: "当前成片没有可绑定的 Timeline，无法自动核对字幕与 CTA 元数据"
      });
      return;
    }
    const active = timeline.textItems.filter((item) => !item.deleted);
    const broken = active.filter(
      (item) =>
        invalidText(item.text) ||
        item.startMs < 0 ||
        item.endMs > durationMs + 500 ||
        item.endMs <= item.startMs
    );
    checks.push({
      code: "TEXT_INTEGRITY",
      severity: broken.length ? "BLOCK" : "PASS",
      label: "文字完整性",
      message: broken.length
        ? `发现 ${broken.length} 条字幕/CTA 含异常字符或时间越界`
        : `已核对 ${active.length} 条字幕/CTA，未发现异常字符或时间越界`,
      technical: {
        activeTextItems: active.length,
        brokenTextItems: broken.length
      }
    });

    const longItems = active.filter(
      (item) => weightedTextLength(item.text) > 32
    );
    const bottomCtas = active.filter(
      (item) =>
        item.kind === "CTA" &&
        item.position === "BOTTOM" &&
        aspectRatio === "9:16"
    );
    const risky = longItems.length + bottomCtas.length;
    checks.push({
      code: "TEXT_SAFE_AREA",
      severity: risky ? "WARN" : "PASS",
      label: "字幕 / CTA 安全区",
      message: risky
        ? `发现 ${longItems.length} 条较长文字、${bottomCtas.length} 条 9:16 底部 CTA；渲染会自动缩字，但建议人工预览短视频平台安全区`
        : "字幕/CTA 元数据未发现明显安全区风险",
      technical: {
        longTextItems: longItems.length,
        bottomCtaItems: bottomCtas.length
      }
    });
  }

  private async addVisualEvidenceCheck(
    checks: FinalQcCheck[],
    projectId: string,
    selectedClipIds: string[]
  ) {
    const standardClipIds = selectedClipIds.filter(
      (clipId) => !clipId.startsWith("agent-")
    );
    if (!standardClipIds.length) {
      checks.push({
        code: "VISUAL_PRODUCT_IDENTITY",
        severity: "WARN",
        label: "产品视觉一致性",
        message:
          "当前成片没有可绑定的标准镜头视觉审片证据；请人工确认产品外观、佩戴/使用位置与关键细节"
      });
      return;
    }

    const decisions = await this.review.listDecisions(projectId);
    let verified = 0;
    for (const clipId of standardClipIds) {
      const accepted = decisions
        .filter(
          (item) =>
            item.clipId === clipId &&
            item.decision === "ACCEPT"
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (accepted?.visualAssessment) verified += 1;
    }
    checks.push({
      code: "VISUAL_PRODUCT_IDENTITY",
      severity:
        verified === standardClipIds.length ? "PASS" : "WARN",
      label: "产品视觉一致性",
      message:
        verified === standardClipIds.length
          ? `全部 ${verified} 个入选镜头都有持久化视觉审片证据`
          : `仅 ${verified}/${standardClipIds.length} 个入选镜头有持久化视觉审片证据；其余需人工确认产品身份与外观一致性`,
      technical: {
        selectedStandardClips: standardClipIds.length,
        visualEvidenceClips: verified
      }
    });
  }

  private async persistReport(input: {
    projectId: string;
    workspace: NonNullable<
      Awaited<ReturnType<ProductFlowService["getWorkspace"]>>
    >;
    assembly: NonNullable<
      Awaited<ReturnType<FinalOutputRepository["latestAssembly"]>>
    >;
    artifactHash: string;
    checks: FinalQcCheck[];
  }): Promise<FinalQcReport> {
    const createdAt = new Date().toISOString();
    const body = {
      id: "",
      projectId: input.projectId,
      assemblyId: input.assembly.id,
      artifactId: input.assembly.outputArtifactId,
      artifactHash: input.artifactHash,
      ...(input.assembly.timelineId
        ? { timelineId: input.assembly.timelineId }
        : {}),
      ...(input.assembly.timelineHash
        ? { timelineHash: input.assembly.timelineHash }
        : {}),
      evaluatorVersion: QC_VERSION,
      overall: overall(input.checks),
      checks: input.checks,
      createdAt
    };
    const cacheKey = hashValue({
      evaluatorVersion: QC_VERSION,
      createdAt,
      projectId: input.projectId,
      assemblyId: input.assembly.id,
      artifactId: input.assembly.outputArtifactId,
      artifactHash: input.artifactHash,
      timelineHash: input.assembly.timelineHash ?? null,
      projectAspectRatio: input.workspace.project.aspectRatio,
      targetDurationMs: input.workspace.project.targetDurationMs,
      checks: input.checks
    });
    const id = "final-qc-" + cacheKey;
    const contentHash = hashValue({ ...body, id });
    const report = finalQcReportSchema.parse({
      ...body,
      id,
      contentHash
    });
    const existing = await this.artifacts.findById(id);
    const store = this.store(input.projectId);
    if (!existing) {
      const bytes = Buffer.from(
        JSON.stringify(report, null, 2) + "\n",
        "utf8"
      );
      await store.writeImmutable({
        id,
        projectId: input.projectId,
        kind: "OTHER",
        relativePath: `final-qc/${input.assembly.id}-${cacheKey}.json`,
        immutable: true,
        bytes,
        mimeType: "application/json"
      });
    }
    return report;
  }
}
