import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ProductionImageProvider,
  ProductionImageStatusResult,
  ProductionImageSubmitInput
} from "../../application/ports/production-image-provider.js";

const execute = promisify(execFile);

export class ProductionImageSubmissionUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionImageSubmissionUnknownError";
  }
}

async function locateDreamina(): Promise<string | null> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execute(command, ["dreamina"], {
      windowsHide: true,
      timeout: 5000
    });
    return String(stdout)
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function parseJson(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dreamina returned invalid JSON");
  }
  return parsed as Record<string, unknown>;
}

function firstImageUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImageUrl(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["image_url", "imageUrl", "url"]) {
    if (typeof record[key] === "string" && String(record[key]).trim()) {
      const candidate = String(record[key]).trim();
      if (/^https:\/\//i.test(candidate)) return candidate;
    }
  }
  for (const child of Object.values(record)) {
    const found = firstImageUrl(child);
    if (found) return found;
  }
  return null;
}

function submitId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["submit_id", "submitId"]) {
    if (typeof record[key] === "string" && record[key]!.trim()) {
      return record[key]!.trim();
    }
  }
  for (const child of Object.values(record)) {
    const found = submitId(child);
    if (found) return found;
  }
  return null;
}

function statusValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["gen_status", "status", "state"]) {
    if (typeof record[key] === "string" && record[key]!.trim()) {
      return record[key]!.trim().toLowerCase();
    }
  }
  for (const child of Object.values(record)) {
    const found = statusValue(child);
    if (found) return found;
  }
  return null;
}

function queueStatusValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const queueInfo =
    record.queue_info &&
    typeof record.queue_info === "object" &&
    !Array.isArray(record.queue_info)
      ? (record.queue_info as Record<string, unknown>)
      : undefined;
  if (
    queueInfo &&
    typeof queueInfo.queue_status === "string" &&
    queueInfo.queue_status.trim()
  ) {
    return queueInfo.queue_status.trim().toLowerCase();
  }
  return null;
}

export function interpretDreaminaImageStatus(
  parsed: Record<string, unknown>
): ProductionImageStatusResult {
  const status = statusValue(parsed);
  if (
    status === "success" ||
    status === "succeeded" ||
    status === "finish"
  ) {
    const imageUrl = firstImageUrl(parsed);
    return imageUrl
      ? { status: "SUCCEEDED", imageUrl }
      : {
          status: "UNKNOWN",
          reason: "即梦任务成功但未返回可下载图片地址"
        };
  }
  if (status === "fail" || status === "failed" || status === "error") {
    return {
      status: "FAILED",
      reason:
        typeof parsed.message === "string"
          ? parsed.message
          : "即梦图片生成失败"
    };
  }
  if (
    status === "submitted" ||
    status === "queued" ||
    status === "pending"
  ) {
    return { status: "SUBMITTED" };
  }
  if (
    status === "querying" ||
    status === "processing" ||
    status === "running"
  ) {
    return queueStatusValue(parsed) === "finish"
      ? {
          status: "PROCESSING",
          observation: "QUEUE_FINISHED_WITHOUT_RESULT"
        }
      : { status: "PROCESSING" };
  }
  return { status: "UNKNOWN", reason: "无法识别即梦图片任务状态" };
}

import { productionImageRatio as ratioFor } from "../../domain/production-image-spec.js";

function verifiedImageMime(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export class DomesticJimengImageProvider implements ProductionImageProvider {
  readonly id = "domestic-jimeng-image-cli";

  constructor(
    private readonly locateExecutable: () => Promise<string | null> =
      locateDreamina,
    private readonly fetchImage: typeof fetch = fetch
  ) {}

  private async executable(): Promise<string> {
    const executable = await this.locateExecutable();
    if (!executable) throw new Error("DREAMINA_NOT_FOUND");
    return executable;
  }

  async probe(): Promise<{
    ready: boolean;
    providerVersion?: string;
    reason?: string;
  }> {
    try {
      const executable = await this.executable();
      // As with the video capability registry, concurrent Windows cold starts
      // contend for the CLI runtime and can turn a valid login into a timeout.
      // These are bounded, read-only checks; none submits a generation task.
      const options = { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
      const { stdout: version } = await execute(executable, ["version"], options);
      const { stdout: textHelp } = await execute(executable, ["text2image", "--help"], options);
      const { stdout: imageHelp } = await execute(executable, ["image2image", "--help"], options);
      const { stdout: credit } = await execute(executable, ["user_credit"], { ...options, timeout: 45_000 });
      if (
        !/text2image/i.test(textHelp) ||
        !/image2image/i.test(imageHelp) ||
        !/total_credit|credit/i.test(credit)
      ) {
        return {
          ready: false,
          reason:
            "Dreamina image generation capability or authentication is unavailable"
        };
      }
      let providerVersion = version.trim();
      try {
        const parsed = parseJson(version);
        providerVersion =
          typeof parsed.version === "string"
            ? parsed.version
            : typeof parsed.commit === "string"
              ? parsed.commit
              : version.trim();
      } catch {
        // The verified legacy CLI may print plain version text.
      }
      return {
        ready: true,
        ...(providerVersion ? { providerVersion } : {})
      };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async submit(input: ProductionImageSubmitInput) {
    const executable = await this.executable();
    const references = input.referenceImagePaths ?? [];
    const args =
      references.length > 0
        ? [
            "image2image",
            "--images",
            references.join(","),
            "--prompt",
            input.prompt,
            "--ratio",
            ratioFor(input.kind),
            "--resolution_type",
            "2k",
            "--model_version",
            "5.0",
            "--generate_num",
            "1",
            "--poll",
            "0"
          ]
        : [
            "text2image",
            "--prompt",
            input.prompt,
            "--ratio",
            ratioFor(input.kind),
            "--resolution_type",
            "2k",
            "--model_version",
            "5.0",
            "--generate_num",
            "1",
            "--poll",
            "0"
          ];

    try {
      const { stdout } = await execute(executable, args, {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      });
      const parsed = parseJson(stdout);
      const id = submitId(parsed);
      if (!id) {
        throw new ProductionImageSubmissionUnknownError(
          "即梦图片生成命令已返回，但没有可恢复的 submit_id；禁止自动重提"
        );
      }
      return { submitId: id };
    } catch (error) {
      if (error instanceof ProductionImageSubmissionUnknownError) throw error;
      throw new ProductionImageSubmissionUnknownError(
        "即梦图片生成提交结果未知；禁止自动重提：" +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  async status(submissionId: string): Promise<ProductionImageStatusResult> {
    const executable = await this.executable();
    try {
      const { stdout } = await execute(
        executable,
        ["query_result", "--submit_id", submissionId],
        {
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024
        }
      );
      const parsed = parseJson(stdout);
      return interpretDreaminaImageStatus(parsed);
    } catch (error) {
      return {
        status: "UNKNOWN",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async download(imageUrl: string, outputPath: string) {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("即梦图片结果必须使用 HTTPS");
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    // GET retries reuse the original submit ID; they never create another paid generation.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const temp = outputPath + ".part-" + attempt + "-" + Date.now();
      let retryable = true;
      try {
        const response = await this.fetchImage(parsed, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal
        });
        if (!response.ok) {
          retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          throw new Error("即梦图片下载失败：HTTP " + response.status);
        }
        const length = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(length) && length > 80 * 1024 * 1024) {
          retryable = false;
          throw new Error("即梦图片结果文件异常过大");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 80 * 1024 * 1024) {
          retryable = false;
          throw new Error("即梦图片结果无有效内容");
        }
        if (length > 0 && length !== bytes.length) {
          throw new Error("即梦图片接收不完整，请重新获取原任务结果");
        }
        const mimeType = verifiedImageMime(bytes);
        if (!mimeType) {
          retryable = false;
          throw new Error("即梦返回的文件不是受支持的图片");
        }
        await fs.writeFile(temp, bytes, { flag: "wx" });
        await fs.rename(temp, outputPath);
        return {
          path: outputPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
          mimeType
        };
      } catch (error) {
        if (!retryable || attempt === 3) {
          throw new Error(
            "即梦图片接收失败（已尝试 " + attempt + " 次，可继续从原任务下载，不需重新生图）："
              + (error instanceof Error ? error.message : String(error)),
            { cause: error }
          );
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 400));
      } finally {
        clearTimeout(timer);
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    }
    throw new Error("即梦图片接收未完成");
  }
}
