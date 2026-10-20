import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { z } from "zod";
import {metricKeys,metricAvailabilitySchema,commentPageCoverageSchema} from "../../domain/douyin-observation.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsCommentPage,
  type DouyinOpsDownloadMetadata,
  type DouyinOpsIdentity,
  type DouyinOpsProbe,
  type DouyinOpsRuntime,
  type DouyinOpsWork
} from "../../application/ports/douyin-ops-runtime.js";

const RESULT_PREFIX = "PVS_DOUYIN_JSON:";
const CONTRACT_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DouyinOpsCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
  }
) => Promise<CommandResult>;

export type YhtDouyinOpsRuntimeOptions = {
  engineRoot?: string;
  nodeExecutable?: string;
  bridgeScript?: string;
  timeoutMs?: number;
  runner?: DouyinOpsCommandRunner;
};

const metricsSchema = z.object({
  plays: z.number().int().nonnegative().nullish().transform(v=>v??undefined),
  likes: z.number().int().nonnegative().nullish().transform(v=>v??undefined),
  comments: z.number().int().nonnegative().nullish().transform(v=>v??undefined),
  shares: z.number().int().nonnegative().nullish().transform(v=>v??undefined),
  collects: z.number().int().nonnegative().nullish().transform(v=>v??undefined)
});

const authorSchema = z.object({
  nickname: z.string(),
  uid: z.string(),
  secUid: z.string(),
  uniqueId: z.string()
});

const workSchema = z.object({
  awemeId: z.string(),
  description: z.string(),
  publishedAt: z.string().nullable(),
  author: authorSchema,
  metrics: metricsSchema,
  metricAvailability:metricAvailabilitySchema.optional(),
  durationMs: z.number().nonnegative(),
  coverUrl: z.string(),
  externalUrl: z.string()
});

const identitySchema = z.object({
  nickname: z.string(),
  uid: z.string(),
  secUid: z.string(),
  uniqueId: z.string(),
  shortId: z.string()
});

const commentSchema = z.object({
  cid: z.string(),
  awemeId: z.string(),
  uid: z.string(),
  secUid: z.string(),
  nickname: z.string(),
  text: z.string(),
  diggCount: z.number().nonnegative(),
  replyCount: z.number().nonnegative(),
  createdAt: z.string().nullable(),
  parentCid: z.string(),
  avatarUrl: z.string()
});

const commentPageSchema = z.object({
  comments: z.array(commentSchema),
  cursor: z.string(),
  hasMore: z.boolean(),
  coverage:commentPageCoverageSchema.optional()
  ,readEvidence:z.object({version:z.literal("douyin-read-page-v1"),kind:z.enum(["COMMENTS","REPLIES"]),awemeId:z.string(),parentCid:z.string().nullable(),requestCursor:z.string(),count:z.number().int().min(1).max(20),observedAt:z.string().datetime(),raw:z.unknown()}).strict().optional()
});

/** The legacy CLI normalizer coerces missing counters to zero. Do not promote ambiguous zeroes to observations. */
function preserveWorkEvidence(work:DouyinOpsWork):DouyinOpsWork{
  const result=structuredClone(work);result.metricAvailability??={};
  for(const key of metricKeys){const value=result.metrics[key],state=result.metricAvailability[key];
    if(state==="OBSERVED"&&value===undefined)throw new DouyinOpsRuntimeError("PROTOCOL_ERROR","指标声明已观察但未提供数值");
    const availability=state??(value===undefined?"NOT_PROVIDED":value===0?"LEGACY_UNVERIFIED":"OBSERVED");
    result.metricAvailability[key]=availability;if(availability!=="OBSERVED")delete result.metrics[key];
  }
  return result;
}

const downloadMetadataSchema = z.object({
  work: workSchema,
  media: z.object({
    videoUrl: z.string(),
    audioUrl: z.string()
  })
});

const probeDataSchema = z.object({
  ready: z.boolean(),
  status: z.string(),
  bridgeVersion: z.string().optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
  connection: z.object({
    id: z.string(),
    url: z.string(),
    connectedAt: z.string().optional(),
    lastActivity: z.string().optional()
  }).optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  missingCapabilities: z.array(z.string()).optional(),
  message: z.string().optional()
});

const envelopeSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  readonly: z.literal(true),
  operation: z.string(),
  ok: z.boolean(),
  status: z.string(),
  checkedAt: z.string(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string()
  }).optional()
});

type ParsedEnvelope = z.infer<typeof envelopeSchema>;

function commandExitCode(
  error: { code?: string | number } | null
): number {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

const defaultRunner: DouyinOpsCommandRunner = (
  executable,
  args,
  options
) =>
  new Promise((resolve) => {
    execFile(
      executable,
      ["comments","replies"].includes(args[1]??"")&&path.resolve(args[0]??"")===path.join(options.cwd,"pvs_bridge.js")
        ? [fileURLToPath(new URL("./yht-douyin-read-evidence-bridge.js",import.meta.url)),options.cwd,...args.slice(1)]
        : [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        shell: false,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        }
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: commandExitCode(error),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        });
      }
    );
  });

function protocolError(message: string): DouyinOpsRuntimeError {
  return new DouyinOpsRuntimeError("PROTOCOL_ERROR", message);
}

function parseEnvelope(
  result: CommandResult,
  expectedOperation: string
): ParsedEnvelope {
  const structured = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RESULT_PREFIX))
    .at(-1);

  if (!structured) {
    throw protocolError(
      result.exitCode === 0
        ? "抖音运营运行时未返回结构化结果"
        : "抖音运营运行时执行失败，且未返回结构化结果"
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(structured.slice(RESULT_PREFIX.length));
  } catch {
    throw protocolError("抖音运营运行时返回了无效 JSON");
  }

  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw protocolError("抖音运营运行时契约校验失败");
  }
  if (parsed.data.operation !== expectedOperation) {
    throw protocolError(
      "抖音运营运行时返回的 operation 与请求不一致"
    );
  }
  return parsed.data;
}

function runtimeFailure(envelope: ParsedEnvelope): DouyinOpsRuntimeError {
  return new DouyinOpsRuntimeError(
    envelope.error?.code || envelope.status || "PROVIDER_ERROR",
    envelope.error?.message ||
      "抖音运营运行时返回失败状态：" + envelope.status
  );
}

export class YhtDouyinOpsRuntime implements DouyinOpsRuntime {
  private readonly engineRoot: string;
  private readonly nodeExecutable: string;
  private readonly bridgeScript: string;
  private readonly timeoutMs: number;
  private readonly runner: DouyinOpsCommandRunner;

  constructor(options: YhtDouyinOpsRuntimeOptions = {}) {
    const engineRoot =
      options.engineRoot?.trim() ||
      process.env.PVS_DOUYIN_OPS_ROOT?.trim() ||
      path.resolve(process.cwd(), "..", "douyin-cli");
    this.engineRoot = path.resolve(engineRoot);

    const nodeExecutable =
      options.nodeExecutable?.trim() ||
      process.env.PVS_DOUYIN_OPS_NODE?.trim() ||
      process.execPath;
    this.nodeExecutable = path.resolve(nodeExecutable);

    const bridgeScript =
      options.bridgeScript?.trim() ||
      process.env.PVS_DOUYIN_OPS_BRIDGE?.trim() ||
      path.join(this.engineRoot, "pvs_bridge.js");
    this.bridgeScript = path.resolve(bridgeScript);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = options.runner ?? defaultRunner;
  }

  private async bridgeExists(): Promise<boolean> {
    try {
      await fs.access(this.bridgeScript);
      return true;
    } catch {
      return false;
    }
  }

  private async invoke(
    operation: string,
    args: readonly string[] = []
  ): Promise<ParsedEnvelope> {
    if (!(await this.bridgeExists())) {
      throw new DouyinOpsRuntimeError(
        "ENGINE_UNAVAILABLE",
        "未找到 Yht douyin-cli PVS Bridge"
      );
    }

    let result: CommandResult;
    try {
      result = await this.runner(
        this.nodeExecutable,
        [this.bridgeScript, operation, ...args],
        {
          cwd: this.engineRoot,
          timeoutMs: this.timeoutMs
        }
      );
    } catch (error) {
      throw new DouyinOpsRuntimeError(
        "ENGINE_UNAVAILABLE",
        error instanceof Error ? error.message : String(error)
      );
    }

    return parseEnvelope(result, operation);
  }

  private async read<T>(
    operation: string,
    args: readonly string[],
    schema: z.ZodType<T>
  ): Promise<T> {
    const envelope = await this.invoke(operation, args);
    if (!envelope.ok) {
      throw runtimeFailure(envelope);
    }
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      throw protocolError(
        "抖音运营运行时 " + operation + " 数据结构无效"
      );
    }
    return parsed.data;
  }

  async probe(): Promise<DouyinOpsProbe> {
    if (!(await this.bridgeExists())) {
      return {
        ok: false,
        ready: false,
        status: "ENGINE_UNAVAILABLE",
        runtimeRoot: this.engineRoot,
        message: "未找到 Yht douyin-cli PVS Bridge"
      };
    }

    try {
      const envelope = await this.invoke("probe");
      const parsed = probeDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        throw protocolError("抖音运营 probe 数据结构无效");
      }
      const data = parsed.data;
      return {
        ok: envelope.ok,
        ready: data.ready,
        status: envelope.status,
        contractVersion: envelope.contractVersion,
        runtimeRoot: this.engineRoot,
        ...(data.bridgeVersion
          ? { bridgeVersion: data.bridgeVersion }
          : {}),
        ...(data.uptimeSeconds !== undefined
          ? { uptimeSeconds: data.uptimeSeconds }
          : {}),
        ...(data.connection
          ? { connection: data.connection }
          : {}),
        ...(data.capabilities
          ? { capabilities: data.capabilities }
          : {}),
        ...(data.missingCapabilities
          ? { missingCapabilities: data.missingCapabilities }
          : {}),
        ...(data.message ? { message: data.message } : {})
      };
    } catch (error) {
      const runtimeError =
        error instanceof DouyinOpsRuntimeError
          ? error
          : new DouyinOpsRuntimeError(
              "PROVIDER_ERROR",
              error instanceof Error ? error.message : String(error)
            );
      return {
        ok: false,
        ready: false,
        status: runtimeError.code,
        runtimeRoot: this.engineRoot,
        message: runtimeError.message
      };
    }
  }

  identity(): Promise<DouyinOpsIdentity> {
    return this.read("identity", [], identitySchema);
  }

  async listMyWorks(count = 20): Promise<DouyinOpsWork[]> {
    const data = await this.read(
      "my",
      ["--count", String(count)],
      z.object({ items: z.array(workSchema) })
    );
    return data.items.map(preserveWorkEvidence);
  }

  async searchWorks(input: {
    query: string;
    count?: number;
    offset?: number;
  }): Promise<DouyinOpsWork[]> {
    const args = ["--query", input.query];
    if (input.count !== undefined) {
      args.push("--count", String(input.count));
    }
    if (input.offset !== undefined) {
      args.push("--offset", String(input.offset));
    }
    const data = await this.read(
      "search",
      args,
      z.object({ items: z.array(workSchema) })
    );
    return data.items.map(preserveWorkEvidence);
  }

  async getWork(awemeId: string): Promise<DouyinOpsWork> {
    const data = await this.read(
      "video",
      ["--aweme-id", awemeId],
      z.object({ work: workSchema })
    );
    return preserveWorkEvidence(data.work);
  }

  getComments(input: {
    awemeId: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    const args = ["--aweme-id", input.awemeId];
    if (input.cursor !== undefined) {
      args.push("--cursor", input.cursor);
    }
    if (input.count !== undefined) {
      args.push("--count", String(input.count));
    }
    return this.read("comments", args, commentPageSchema);
  }

  getReplies(input: {
    awemeId: string;
    cid: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    const args = [
      "--aweme-id",
      input.awemeId,
      "--cid",
      input.cid
    ];
    if (input.cursor !== undefined) {
      args.push("--cursor", input.cursor);
    }
    if (input.count !== undefined) {
      args.push("--count", String(input.count));
    }
    return this.read("replies", args, commentPageSchema);
  }

  async getDownloadMetadata(
    awemeId: string
  ): Promise<DouyinOpsDownloadMetadata> {
    const result=await this.read(
      "download",
      ["--aweme-id", awemeId],
      downloadMetadataSchema
    );
    return {...result,work:preserveWorkEvidence(result.work)};
  }
}

export const douyinOpsContractVersion = CONTRACT_VERSION;
export const douyinOpsResultPrefix = RESULT_PREFIX;
