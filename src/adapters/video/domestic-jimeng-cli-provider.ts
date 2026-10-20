import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AccountStatus,
  CostEstimateResult,
  DownloadedAsset,
  GenerationHandle,
  GenerationStatusResult,
  ProviderCommandEvidence,
  ProviderCommandEvidenceSource,
  ProviderCommandOperation,
  ProviderProbeResult,
  ReconcileResult,
  SubmitResult,
  VideoProvider
} from "../../application/ports/video-provider.js";
import { SubmissionOutcomeUnknownError } from "../../application/ports/video-provider.js";
import type {
  GenerationRequest,
  ProviderIdentity
} from "../../domain/schemas.js";
import { hashValue } from "../../domain/hashing.js";

export class ProviderNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNotReadyError";
  }
}

export type CommandExecution = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export type CommandRunner = (
  executablePath: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<CommandExecution>;

export type DirectHttpDownload = (
  url: string,
  outputPath: string,
  timeoutMs: number
) => Promise<void>;

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /(authorization\s*[:=]\s*)[^\r\n]+/gi,
      "$1<redacted>"
    )
    .replace(
      /((?:access|refresh)?[_-]?token|cookie|session(?:_id|key)?|password|secret)\s*[:=]\s*([^\s,;&]+)/gi,
      "$1=<redacted>"
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "<redacted-jwt>"
    );
}

function redactArgs(args: readonly string[]): string[] {
  const sensitiveFlag =
    /^(--?(?:access[-_]?token|refresh[-_]?token|token|cookie|authorization|password|secret|session(?:[-_]?id|[-_]?key)?))$/i;
  const result: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      result.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (sensitiveFlag.test(arg)) {
      result.push(arg);
      redactNext = true;
      continue;
    }
    const keyValue = arg.match(
      /^([^=]*(?:access[-_]?token|refresh[-_]?token|token|cookie|authorization|password|secret|session(?:[-_]?id|[-_]?key)?)[^=]*)=(.*)$/i
    );
    if (keyValue) {
      result.push(`${keyValue[1]}=<redacted>`);
      continue;
    }
    result.push(redactSensitiveText(arg));
  }
  return result;
}

export type VerifiedDreaminaIdentityContract = Omit<
  ProviderIdentity,
  "rawVersionArtifactId" | "rawHelpArtifactId" | "capabilityFingerprint"
>;

export type VerifiedDreaminaRuntime = {
  identity: VerifiedDreaminaIdentityContract;
  versionArgs: readonly string[];
  helpArgs: readonly string[];
  parseProbe(
    versionResult: CommandExecution,
    helpResult: CommandExecution
  ): {
    cliVersion: string;
    supportedOperations: string[];
    supportedModels: string[];
    supportedDurationsMs?: number[];
  };
  account?: {
    args: readonly string[];
    parse(result: CommandExecution): AccountStatus;
  };
  estimate?: {
    buildArgs(requests: GenerationRequest[]): readonly string[];
    parse(result: CommandExecution): CostEstimateResult;
  };
  submit?: {
    buildArgs(
      request: GenerationRequest,
      assets: readonly ResolvedGenerationAsset[]
    ): readonly string[];
    parse(result: CommandExecution): SubmitResult;
    classifyFailure?(result: CommandExecution): "FAILED" | "UNKNOWN";
  };
  status?: {
    buildArgs(handle: GenerationHandle): readonly string[];
    parse(result: CommandExecution): GenerationStatusResult;
  };
  download?: {
    buildArgs(handle: GenerationHandle, outputPath: string): readonly string[];
    outputMode?: "FILE" | "DIRECTORY";
  };
  reconcile?: {
    buildArgs(input: {
      requestHash: string;
      submissionFingerprint: string;
      knownHandle?: GenerationHandle;
    }): readonly string[];
    parse(result: CommandExecution): ReconcileResult;
  };
};

export type ResolvedGenerationAsset = {
  assetId: string;
  absolutePath: string;
  artifactHash: string;
  role: GenerationRequest["assetManifest"][number]["role"];
  priority: number;
  required: boolean;
  inputType?: "image" | "video" | "audio";
};

export type ResolveGenerationAssets = (
  request: GenerationRequest
) => Promise<ResolvedGenerationAsset[]>;

export type LocateExecutable = () => Promise<string | null>;

async function defaultLocateExecutable(): Promise<string | null> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(command, ["dreamina"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const first = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(first ?? null);
    });
  });
}

async function defaultCommandRunner(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number
): Promise<CommandExecution> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      [...args],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === "number"
            ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
            : error
              ? 1
              : 0;
        const timedOut = Boolean(
          error &&
            ((error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
              ((error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }).killed === true &&
                (error as NodeJS.ErrnoException & { signal?: string }).signal === "SIGTERM") ||
              /timed out|timeout/i.test(error.message))
        );
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr || error?.message || ""),
          exitCode: code,
          timedOut
        });
      }
    );
  });
}

async function defaultDirectHttpDownload(
  url: string,
  outputPath: string,
  timeoutMs: number
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Dreamina result URL must use HTTPS");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const temp = outputPath + ".http-" + Date.now() + ".tmp";
  try {
    const response = await fetch(parsed, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(
        "Dreamina result HTTP download failed: " + response.status
      );
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 512 * 1024 * 1024) {
      throw new Error("Dreamina result is unexpectedly large");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 512 * 1024 * 1024) {
      throw new Error("Dreamina result download returned invalid bytes");
    }
    await fs.writeFile(temp, bytes, { flag: "wx" });
    await fs.rename(temp, outputPath);
  } finally {
    clearTimeout(timer);
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function firstVideoUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.video_url === "string" && record.video_url.trim()) {
    return record.video_url.trim();
  }
  for (const item of Object.values(record)) {
    const found = firstVideoUrl(item);
    if (found) return found;
  }
  return null;
}

async function fileSha256(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeOperations(runtime: VerifiedDreaminaRuntime): string[] {
  return [
    "probe",
    ...(runtime.account ? ["accountStatus"] : []),
    ...(runtime.estimate ? ["estimate"] : []),
    ...(runtime.submit ? ["submit"] : []),
    ...(runtime.status ? ["status"] : []),
    ...(runtime.download ? ["download"] : []),
    ...(runtime.reconcile ? ["reconcileSubmission"] : [])
  ];
}

function assertVerifiedIdentity(
  runtime: VerifiedDreaminaRuntime,
  executablePath: string,
  executableSha256: string
): void {
  if (runtime.identity.verificationStatus !== "VERIFIED") {
    throw new ProviderNotReadyError("ProviderIdentity is not VERIFIED");
  }
  if (
    runtime.identity.executablePath !== executablePath ||
    runtime.identity.executableSha256.toLowerCase() !==
      executableSha256.toLowerCase()
  ) {
    throw new ProviderNotReadyError("Verified ProviderIdentity does not match discovered executable");
  }
}

export class DomesticJimengCliProvider
  implements VideoProvider, ProviderCommandEvidenceSource
{
  readonly id = "domestic-jimeng-cli" as const;
  private readonly commandEvidence: ProviderCommandEvidence[] = [];

  constructor(
    private readonly locateExecutable: LocateExecutable = defaultLocateExecutable,
    private readonly runtime?: VerifiedDreaminaRuntime,
    private readonly runCommand: CommandRunner = defaultCommandRunner,
    private readonly resolveGenerationAssets: ResolveGenerationAssets = async () => [],
    private readonly directHttpDownload: DirectHttpDownload = defaultDirectHttpDownload
  ) {}

  private async execute(
    operation: ProviderCommandOperation,
    executablePath: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<CommandExecution> {
    const startedAt = new Date().toISOString();
    const result = await this.runCommand(executablePath, args, timeoutMs);
    const completedAt = new Date().toISOString();
    const executableName =
      executablePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "dreamina";
    this.commandEvidence.push({
      operation,
      argvRedacted: [executableName, ...redactArgs(args)],
      stdoutRedacted: redactSensitiveText(result.stdout),
      stderrRedacted: redactSensitiveText(result.stderr),
      startedAt,
      completedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    });
    return result;
  }

  getVerifiedIdentityContract(): VerifiedDreaminaIdentityContract | null {
    return this.runtime ? structuredClone(this.runtime.identity) : null;
  }

  getVerifiedProbeArgs(): {
    versionArgs: string[];
    helpArgs: string[];
  } | null {
    return this.runtime
      ? {
          versionArgs: [...this.runtime.versionArgs],
          helpArgs: [...this.runtime.helpArgs]
        }
      : null;
  }

  drainCommandEvidence(
    operation?: ProviderCommandOperation
  ): ProviderCommandEvidence[] {
    if (!operation) {
      return this.commandEvidence.splice(0);
    }
    const selected: ProviderCommandEvidence[] = [];
    const retained: ProviderCommandEvidence[] = [];
    for (const item of this.commandEvidence) {
      if (item.operation === operation) selected.push(item);
      else retained.push(item);
    }
    this.commandEvidence.splice(0, this.commandEvidence.length, ...retained);
    return selected;
  }

  private async verifiedContext(): Promise<{
    executablePath: string;
    executableSha256: string;
    runtime: VerifiedDreaminaRuntime;
  }> {
    const executablePath = await this.locateExecutable();
    if (!executablePath) {
      throw new ProviderNotReadyError("DREAMINA_NOT_FOUND");
    }
    const executableSha256 = await fileSha256(executablePath);
    if (!this.runtime) {
      throw new ProviderNotReadyError("PROVIDER_IDENTITY_UNVERIFIED");
    }
    assertVerifiedIdentity(this.runtime, executablePath, executableSha256);
    return { executablePath, executableSha256, runtime: this.runtime };
  }

  async probe(): Promise<ProviderProbeResult> {
    const executablePath = await this.locateExecutable();
    if (!executablePath) {
      const providerIdentityHash = hashValue({
        provider: this.id,
        verificationStatus: "MISSING"
      });
      return {
        code: "DREAMINA_NOT_FOUND",
        cliFound: false,
        providerIdentityHash,
        capabilityFingerprint: hashValue({ provider: this.id, cliFound: false }),
        rawStdout: "",
        rawStderr: "dreamina executable was not found"
      };
    }

    const executableSha256 = await fileSha256(executablePath);
    if (!this.runtime) {
      const providerIdentityHash = hashValue({
        provider: this.id,
        executablePath,
        executableSha256,
        verificationStatus: "UNVERIFIED"
      });
      return {
        code: "PROVIDER_IDENTITY_UNVERIFIED",
        cliFound: true,
        executablePath,
        executableSha256,
        providerIdentityHash,
        capabilityFingerprint: hashValue({
          provider: this.id,
          executablePath,
          executableSha256,
          identityVerified: false
        }),
        rawStdout: "",
        rawStderr:
          "dreamina executable discovered but not executed before official identity verification"
      };
    }

    try {
      assertVerifiedIdentity(this.runtime, executablePath, executableSha256);
    } catch {
      const providerIdentityHash = hashValue({
        provider: this.id,
        executablePath,
        executableSha256,
        verificationStatus: "UNVERIFIED"
      });
      return {
        code: "PROVIDER_IDENTITY_UNVERIFIED",
        cliFound: true,
        executablePath,
        executableSha256,
        providerIdentityHash,
        capabilityFingerprint: hashValue({
          provider: this.id,
          executablePath,
          executableSha256,
          identityVerified: false
        }),
        rawStdout: "",
        rawStderr: "discovered executable does not match VERIFIED ProviderIdentity"
      };
    }

    const [versionResult, helpResult] = await Promise.all([
      this.execute("PROBE", executablePath, this.runtime.versionArgs, 30_000),
      this.execute("PROBE", executablePath, this.runtime.helpArgs, 30_000)
    ]);
    if (
      versionResult.exitCode !== 0 ||
      helpResult.exitCode !== 0 ||
      versionResult.timedOut ||
      helpResult.timedOut
    ) {
      throw new ProviderNotReadyError("Verified dreamina probe commands failed");
    }

    const parsed = this.runtime.parseProbe(versionResult, helpResult);
    const supportedOperations = [
      ...new Set([...parsed.supportedOperations, ...runtimeOperations(this.runtime)])
    ].sort();
    const supportedModels = [...new Set(parsed.supportedModels)].sort();
    const supportedDurationsMs = parsed.supportedDurationsMs
      ? [...new Set(parsed.supportedDurationsMs)].sort((a, b) => a - b)
      : undefined;
    const providerIdentityHash = hashValue(this.runtime.identity);
    const capabilityFingerprint = hashValue({
      provider: this.id,
      executableSha256,
      cliVersion: parsed.cliVersion,
      versionStdout: versionResult.stdout,
      helpStdout: helpResult.stdout,
      supportedOperations,
      supportedModels,
      supportedDurationsMs
    });

    return {
      code: "READY",
      cliFound: true,
      identityVerified: true,
      executablePath,
      executableSha256,
      cliVersion: parsed.cliVersion,
      providerIdentityHash,
      supportedOperations,
      supportedModels,
      ...(supportedDurationsMs ? { supportedDurationsMs } : {}),
      capabilityFingerprint,
      rawStdout: [versionResult.stdout, helpResult.stdout].filter(Boolean).join("\n"),
      rawStderr: [versionResult.stderr, helpResult.stderr].filter(Boolean).join("\n")
    };
  }

  async accountStatus(): Promise<AccountStatus> {
    const { executablePath, runtime } = await this.verifiedContext();
    if (!runtime.account) return { status: "UNKNOWN" };
    const result = await this.execute(
      "ACCOUNT",
      executablePath,
      runtime.account.args,
      15_000
    );
    if (result.exitCode !== 0 || result.timedOut) {
      return { status: "UNKNOWN" };
    }
    return runtime.account.parse(result);
  }

  async inspectCommandHelp(command: string): Promise<{
    command: string;
    stdout: string;
    stderr: string;
    executablePath: string;
    executableSha256: string;
  }> {
    if (!/^[a-z0-9_-]+$/i.test(command)) {
      throw new ProviderNotReadyError("Invalid dreamina command name");
    }
    const { executablePath, executableSha256 } =
      await this.verifiedContext();
    const helpArgs =
      command === "__root__" ? ["-h"] : [command, "-h"];
    const result = await this.execute(
      "PROBE",
      executablePath,
      helpArgs,
      30_000
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw new ProviderNotReadyError(
        `dreamina ${command} -h failed`
      );
    }
    return {
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      executablePath,
      executableSha256
    };
  }

  async estimate(requests: GenerationRequest[]): Promise<CostEstimateResult> {
    const { executablePath, runtime } = await this.verifiedContext();
    if (!runtime.estimate) return { status: "UNKNOWN" };
    const result = await this.execute(
      "ESTIMATE",
      executablePath,
      runtime.estimate.buildArgs(requests),
      20_000
    );
    if (result.exitCode !== 0 || result.timedOut) {
      return { status: "UNKNOWN" };
    }
    return runtime.estimate.parse(result);
  }

  async submit(request: GenerationRequest): Promise<SubmitResult> {
    const { executablePath, runtime } = await this.verifiedContext();
    if (!runtime.submit) {
      throw new ProviderNotReadyError("submit capability was not verified from official help");
    }
    const resolvedAssets = await this.resolveGenerationAssets(request);
    const result = await this.execute(
      "SUBMIT",
      executablePath,
      runtime.submit.buildArgs(request, resolvedAssets),
      120_000
    );
    if (result.exitCode !== 0 || result.timedOut) {
      const classification = runtime.submit.classifyFailure?.(result) ?? "UNKNOWN";
      if (classification === "UNKNOWN") {
        throw new SubmissionOutcomeUnknownError(
          "dreamina submit may have produced an external side effect; reconciliation required"
        );
      }
      throw new Error("dreamina submit failed before a successful task handle was parsed");
    }
    if (runtime.submit.classifyFailure?.(result) === "FAILED") {
      throw new Error("dreamina submit returned a terminal failure response");
    }
    const handle = runtime.submit.parse(result);
    if (!handle.externalTaskId && !handle.submitId && !handle.opaqueHandle) {
      throw new SubmissionOutcomeUnknownError(
        "dreamina submit exited successfully but no durable task handle was parsed"
      );
    }
    return handle;
  }

  async status(handle: GenerationHandle): Promise<GenerationStatusResult> {
    const { executablePath, runtime } = await this.verifiedContext();
    if (!runtime.status) {
      throw new ProviderNotReadyError("status capability was not verified from official help");
    }
    const result = await this.execute(
      "STATUS",
      executablePath,
      runtime.status.buildArgs(handle),
      30_000
    );
    if (result.exitCode !== 0 || result.timedOut) return { status: "UNKNOWN" };
    return runtime.status.parse(result);
  }

  async download(
    handle: GenerationHandle,
    outputPath: string
  ): Promise<DownloadedAsset> {
    const { executablePath, runtime } = await this.verifiedContext();
    if (!runtime.download) {
      throw new ProviderNotReadyError("download capability was not verified from official help");
    }
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });
    const beforeEntries =
      runtime.download.outputMode === "DIRECTORY"
        ? new Map(
            (
              await fs.readdir(outputDir, { withFileTypes: true })
            )
              .filter((entry) => entry.isFile())
              .map((entry) => [entry.name, null] as const)
          )
        : new Map<string, null>();
    const result = await this.execute(
      "DOWNLOAD",
      executablePath,
      runtime.download.buildArgs(handle, outputPath),
      120_000
    );
    let actualPath = outputPath;
    let recoveredByDirectUrl = false;
    if (result.exitCode !== 0 || result.timedOut) {
      if (!runtime.status) {
        throw new Error("dreamina download failed");
      }
      const fresh = await this.execute(
        "DOWNLOAD",
        executablePath,
        runtime.status.buildArgs(handle),
        30_000
      );
      if (fresh.exitCode !== 0 || fresh.timedOut) {
        throw new Error(
          "dreamina download failed and fresh result lookup was unavailable"
        );
      }
      let freshPayload: unknown;
      try {
        freshPayload = JSON.parse(fresh.stdout);
      } catch {
        throw new Error(
          "dreamina download failed and fresh result JSON could not be parsed"
        );
      }
      const videoUrl = firstVideoUrl(freshPayload);
      if (!videoUrl) {
        throw new Error(
          "dreamina download failed and fresh result had no video URL"
        );
      }
      const startedAt = new Date().toISOString();
      try {
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        await this.directHttpDownload(videoUrl, outputPath, 300_000);
        this.commandEvidence.push({
          operation: "DOWNLOAD",
          argvRedacted: ["dreamina-result-url", "<signed-url-redacted>"],
          stdoutRedacted:
            "Recovered generated video by direct HTTPS download from the fresh official query_result response.",
          stderrRedacted: "",
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: 0,
          timedOut: false
        });
        recoveredByDirectUrl = true;
        actualPath = outputPath;
      } catch (error) {
        this.commandEvidence.push({
          operation: "DOWNLOAD",
          argvRedacted: ["dreamina-result-url", "<signed-url-redacted>"],
          stdoutRedacted: "",
          stderrRedacted: redactSensitiveText(
            error instanceof Error ? error.message : String(error)
          ),
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: 1,
          timedOut:
            error instanceof Error &&
            /abort|timeout|timed out/i.test(error.message)
        });
        throw error;
      }
    }
    if (!recoveredByDirectUrl && runtime.download.outputMode === "DIRECTORY") {
      const after = await fs.readdir(outputDir, { withFileTypes: true });
      const candidates: Array<{
        path: string;
        mtimeMs: number;
      }> = [];
      for (const entry of after) {
        if (!entry.isFile()) continue;
        const candidate = path.join(outputDir, entry.name);
        const stat = await fs.stat(candidate);
        if (!beforeEntries.has(entry.name)) {
          candidates.push({ path: candidate, mtimeMs: stat.mtimeMs });
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (!candidates.length) {
        throw new Error(
          "dreamina download command succeeded but no new result file was found"
        );
      }
      actualPath = candidates[0]!.path;
    }
    const bytes = await fs.readFile(actualPath);
    return {
      path: actualPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength
    };
  }

  async reconcileSubmission(input: {
    requestHash: string;
    submissionFingerprint: string;
    knownHandle?: GenerationHandle;
  }): Promise<ReconcileResult> {
    let context;
    try {
      context = await this.verifiedContext();
    } catch (error) {
      return {
        outcome: "INCONCLUSIVE",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    if (!context.runtime.reconcile) {
      return {
        outcome: "INCONCLUSIVE",
        reason: "Official dreamina reconciliation capability has not been verified"
      };
    }
    const result = await this.execute(
      "RECONCILE",
      context.executablePath,
      context.runtime.reconcile.buildArgs(input),
      30_000
    );
    if (result.exitCode !== 0 || result.timedOut) {
      return { outcome: "INCONCLUSIVE", reason: "dreamina reconciliation command failed" };
    }
    return context.runtime.reconcile.parse(result);
  }
}
