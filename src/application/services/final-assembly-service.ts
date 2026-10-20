import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { FinalAssembly, FinalOutputRepository } from "../ports/final-output-repository.js";
import type { ReviewRepository } from "../ports/review-repository.js";
import type { WorkflowRepository } from "../ports/workflow-repository.js";
import type { ProductFlowService } from "./product-flow.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { DomainValidationError } from "../../domain/validation.js";

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
        timeout: options.timeout ?? 180_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} failed: ${error.message}\n${String(stderr).slice(-4000)}`
            )
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function concatPathLine(absolutePath: string): string {
  const normalized = absolutePath.replaceAll("\\", "/").replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}

export class FinalAssemblyService {
  constructor(
    private readonly productFlow: ProductFlowService,
    private readonly workflow: WorkflowRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly review: ReviewRepository,
    private readonly finalOutput: FinalOutputRepository,
    private readonly projectsRoot: string,
    private readonly ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg"
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

  async render(projectId: string): Promise<FinalAssembly> {
    const workspace = await this.productFlow.getWorkspace(projectId);
    if (!workspace?.productionPlan) {
      throw new DomainValidationError("需要先生成当前导演方案");
    }

    const clips = workspace.productionPlan.scenes.flatMap((scene) => scene.clips);
    const attempts = await this.workflow.listGenerationAttempts(projectId);
    const decisions = await this.review.listDecisions(projectId);
    const selected: Array<{
      clipId: string;
      artifactId: string;
      artifactHash: string;
      absolutePath: string;
    }> = [];
    const unresolvedClipIds: string[] = [];

    const projectRoot = path.resolve(this.projectsRoot, projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);

    for (const clip of clips) {
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
      if (!attempt?.outputArtifactId) {
        unresolvedClipIds.push(clip.id);
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
        unresolvedClipIds.push(clip.id);
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
            (item.decision === "ACCEPT" || item.decision === "REDO" || item.decision === "STALE")
        )
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
      if (accept?.decision !== "ACCEPT") {
        unresolvedClipIds.push(clip.id);
        continue;
      }

      selected.push({
        clipId: clip.id,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        absolutePath: store.resolveArtifactPath(artifact.relativePath)
      });
    }

    if (unresolvedClipIds.length) {
      throw new DomainValidationError(
        `Final assembly requires every current Clip to be explicitly ACCEPT or SKIP; unresolved: ${unresolvedClipIds.join(", ")}`
      );
    }

    if (!selected.length) {
      throw new DomainValidationError(
        "At least one accepted Clip is required to create the final video"
      );
    }

    await this.finalOutput.markAssembliesStale(projectId);
    const assemblyId = randomUUID();
    const tempDir = path.join(projectRoot, ".tmp", `assembly-${assemblyId}`);
    const listPath = path.join(tempDir, "concat.txt");
    const tempOutput = path.join(tempDir, "final.mp4");
    await fs.mkdir(tempDir, { recursive: true });

    try {
      await fs.writeFile(
        listPath,
        selected.map((item) => concatPathLine(item.absolutePath)).join("\n") + "\n",
        "utf8"
      );

      let copyError: Error | undefined;
      try {
        await execFileAsync(
          this.ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listPath,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-y",
            tempOutput
          ],
          { timeout: 180_000 }
        );
      } catch (error) {
        copyError = error instanceof Error ? error : new Error(String(error));
      }

      if (copyError) {
        await fs.rm(tempOutput, { force: true }).catch(() => undefined);
        await execFileAsync(
          this.ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listPath,
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-y",
            tempOutput
          ],
          { timeout: 300_000 }
        );
      }

      const bytes = await fs.readFile(tempOutput);
      if (!bytes.length) {
        throw new Error("FFmpeg produced an empty final video");
      }
      const artifact = await store.writeImmutable({
        id: randomUUID(),
        projectId,
        kind: "FINAL_VIDEO",
        relativePath: `final/${assemblyId}.mp4`,
        immutable: true,
        bytes,
        mimeType: "video/mp4"
      });
      if (!artifact.sha256) {
        throw new Error("Final video Artifact did not become READY");
      }

      const assembly = await this.finalOutput.createAssembly({
        id: assemblyId,
        projectId,
        productionPlanHash: workspace.productionPlan.contentHash,
        selectedClipIds: selected.map((item) => item.clipId),
        inputArtifactIds: selected.map((item) => item.artifactId),
        inputArtifactHashes: selected.map((item) => item.artifactHash),
        outputArtifactId: artifact.id,
        outputArtifactHash: artifact.sha256,
        status: "READY",
        createdAt: new Date().toISOString()
      });
      await this.productFlow.setProjectStatus(projectId, "FINAL_REVIEW");
      return assembly;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async accept(projectId: string): Promise<FinalAssembly> {
    const assembly = await this.finalOutput.latestAssembly(projectId);
    if (!assembly || assembly.status !== "READY") {
      throw new DomainValidationError(
        "A current READY final video is required before final acceptance"
      );
    }
    const artifact = await this.artifacts.findById(assembly.outputArtifactId);
    if (
      !artifact ||
      artifact.projectId !== projectId ||
      artifact.kind !== "FINAL_VIDEO" ||
      artifact.integrityStatus !== "READY" ||
      artifact.sha256 !== assembly.outputArtifactHash
    ) {
      throw new DomainValidationError("最终成片尚不可用");
    }
    const accepted = await this.finalOutput.updateAssembly(assembly.id, {
      status: "ACCEPTED",
      acceptedAt: new Date().toISOString()
    });
    await this.productFlow.setProjectStatus(projectId, "READY_TO_PUBLISH");
    return accepted;
  }
}
