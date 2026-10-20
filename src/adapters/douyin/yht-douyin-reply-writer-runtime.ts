import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  DouyinReplyWriterRuntime,
  DouyinReplyWriteResult
} from "../../application/ports/douyin-reply-writer-runtime.js";
import { DouyinOpsRuntimeError } from "../../application/ports/douyin-ops-runtime.js";

const PREFIX = "PVS_DOUYIN_JSON:";
const MAX_BUFFER = 2 * 1024 * 1024;

export type ReplyWriterCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type YhtDouyinReplyWriterOptions = {
  engineRoot?: string;
  nodeExecutable?: string;
  bridgeScript?: string;
  timeoutMs?: number;
  runner?: ReplyWriterCommandRunner;
};

const envelopeSchema = z.object({
  contractVersion: z.literal(1),
  readonly: z.literal(false),
  operation: z.literal("post-reply"),
  ok: z.boolean(),
  status: z.enum([
    "REPLY_POSTED_CONFIRMED",
    "SUBMISSION_UNKNOWN",
    "REJECTED"
  ]),
  data: z.object({
    status: z.enum([
      "REPLY_POSTED_CONFIRMED",
      "SUBMISSION_UNKNOWN",
      "REJECTED"
    ]),
    confirmed: z.boolean(),
    writeIntentId: z.string(),
    replyCid: z.string().optional(),
    text: z.string().optional(),
    createdAt: z.number().optional(),
    platformStatusCode: z.number().optional(),
    message: z.string().optional()
  }).optional(),
  error: z.object({
    code: z.string(),
    message: z.string()
  }).optional()
});

const defaultRunner: ReplyWriterCommandRunner = (
  executable,
  args,
  options
) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        shell: false,
        maxBuffer: MAX_BUFFER
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            typeof error?.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        });
      }
    );
  });

export class YhtDouyinReplyWriterRuntime
  implements DouyinReplyWriterRuntime
{
  private readonly engineRoot: string;
  private readonly nodeExecutable: string;
  private readonly bridgeScript: string;
  private readonly timeoutMs: number;
  private readonly runner: ReplyWriterCommandRunner;

  constructor(
    options: YhtDouyinReplyWriterOptions = {}
  ) {
    this.engineRoot = path.resolve(
      options.engineRoot?.trim() ||
        process.env.PVS_DOUYIN_OPS_ROOT?.trim() ||
        path.resolve(process.cwd(), "..", "douyin-cli")
    );
    this.nodeExecutable = path.resolve(
      options.nodeExecutable?.trim() ||
        process.env.PVS_DOUYIN_OPS_NODE?.trim() ||
        process.execPath
    );
    this.bridgeScript = path.resolve(
      options.bridgeScript?.trim() ||
        process.env.PVS_DOUYIN_OPS_BRIDGE?.trim() ||
        path.join(this.engineRoot, "pvs_bridge.js")
    );
    this.timeoutMs =
      options.timeoutMs ?? 45_000;
    this.runner = options.runner ?? defaultRunner;
  }

  async postReply(input: {
    awemeId: string;
    cid: string;
    text: string;
    writeIntentId: string;
    confirmed: true;
  }): Promise<DouyinReplyWriteResult> {
    try {
      await fs.access(this.bridgeScript);
    } catch {
      throw new DouyinOpsRuntimeError(
        "ENGINE_UNAVAILABLE",
        "未找到 Yht douyin-cli PVS Bridge"
      );
    }

    const result = await this.runner(
      this.nodeExecutable,
      [
        this.bridgeScript,
        "post-reply",
        "--aweme-id",
        input.awemeId,
        "--cid",
        input.cid,
        "--text",
        input.text,
        "--write-intent-id",
        input.writeIntentId,
        "--confirmed",
        "yes"
      ],
      {
        cwd: this.engineRoot,
        timeoutMs: this.timeoutMs
      }
    );

    const structured = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(PREFIX))
      .at(-1);

    if (!structured) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        writeIntentId: input.writeIntentId,
        message:
          "写入进程未返回结构化结果，无法确认平台状态；禁止自动重试。"
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(
        structured.slice(PREFIX.length)
      );
    } catch {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        writeIntentId: input.writeIntentId,
        message:
          "写入进程返回无效 JSON，无法确认平台状态；禁止自动重试。"
      };
    }

    const parsed =
      envelopeSchema.safeParse(parsedJson);
    if (!parsed.success || !parsed.data.data) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        writeIntentId: input.writeIntentId,
        message:
          "写入运行时契约校验失败，无法确认平台状态；禁止自动重试。"
      };
    }

    const data = parsed.data.data;
    if (
      data.writeIntentId !==
      input.writeIntentId
    ) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        writeIntentId: input.writeIntentId,
        message:
          "写入回执与本次 writeIntentId 不一致；禁止自动重试。"
      };
    }

    if (
      data.status ===
        "REPLY_POSTED_CONFIRMED" &&
      (!data.confirmed ||
        !data.replyCid ||
        !/^\d{1,40}$/.test(data.replyCid))
    ) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        writeIntentId: input.writeIntentId,
        message:
          "平台成功回执缺少可信回复 CID；禁止自动重试。"
      };
    }

    return data;
  }
}
