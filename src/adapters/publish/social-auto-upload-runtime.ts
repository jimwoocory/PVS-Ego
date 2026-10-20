import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DouyinBrowserAccountStatus,
  DouyinBrowserEngineProbe,
  DouyinBrowserLoginResult,
  DouyinBrowserPublishRequest,
  DouyinBrowserPublishResult,
  DouyinBrowserPublisherRuntime
} from "../../application/ports/douyin-browser-publisher-runtime.js";

const RESULT_PREFIX = "PVS_BRIDGE_JSON:";
const DEFAULT_TIMEOUT_MS = 120_000;
const ACCOUNT_CHECK_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const PUBLISH_TIMEOUT_MS = 30 * 60_000;

type CommandResult = {
  exitCode: number;
  stdout: string;
};

function commandExitCode(error: { code?: string | number } | null): number {
  if (!error) return 0;
  if (typeof error.code === "number") return error.code;
  return 1;
}

export class SocialAutoUploadRuntime
  implements DouyinBrowserPublisherRuntime
{
  constructor(
    private readonly engineRoot =
      process.env.PVS_SOCIAL_AUTO_UPLOAD_ROOT?.trim() ||
      path.resolve(process.cwd(), "..", "social-auto-upload"),
    private readonly runtimeHome =
      process.env.PVS_DOUYIN_BROWSER_RUNTIME_HOME?.trim() ||
      path.resolve(
        process.cwd(),
        ".runtime-secrets",
        "publishing",
        "social-auto-upload"
      ),
    private readonly executableOverride =
      process.env.PVS_SOCIAL_AUTO_UPLOAD_EXECUTABLE?.trim() || ""
  ) {}

  private executablePath(): string {
    if (this.executableOverride) {
      return path.resolve(this.executableOverride);
    }
    return process.platform === "win32"
      ? path.join(this.engineRoot, ".venv", "Scripts", "sau-pvs.exe")
      : path.join(this.engineRoot, ".venv", "bin", "sau-pvs");
  }

  private activeAccountPath(): string {
    return path.join(this.runtimeHome, "active-account.txt");
  }

  private cookiesPath(): string {
    return path.join(this.runtimeHome, "cookies");
  }

  private async ensureRuntimeHome(): Promise<void> {
    await fs.mkdir(this.cookiesPath(), { recursive: true });
  }

  private async executableExists(): Promise<boolean> {
    try {
      await fs.access(this.executablePath());
      return true;
    } catch {
      return false;
    }
  }

  private async run(
    args: readonly string[],
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<CommandResult> {
    await this.ensureRuntimeHome();
    const executable = this.executablePath();
    return new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        {
          cwd: this.engineRoot,
          env: {
            ...process.env,
            SAU_RUNTIME_HOME: this.runtimeHome
          },
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024
        },
        (error, stdout) => {
          resolve({
            exitCode: commandExitCode(error),
            stdout: String(stdout ?? "")
          });
        }
      );
    });
  }

  private parse<T extends Record<string, unknown>>(
    result: CommandResult
  ): T {
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
    const structured = lines
      .filter((line) => line.startsWith(RESULT_PREFIX))
      .at(-1);
    if (!structured) {
      throw new Error(
        result.exitCode === 0
          ? "抖音浏览器发布引擎未返回结构化结果"
          : "抖音浏览器发布引擎执行失败"
      );
    }
    const raw = structured.slice(RESULT_PREFIX.length);
    const parsed = JSON.parse(raw) as T;
    return parsed;
  }

  async resolveAccountName(): Promise<string> {
    const configured = process.env.PVS_DOUYIN_BROWSER_ACCOUNT?.trim();
    if (configured) return configured;

    try {
      const active = (await fs.readFile(this.activeAccountPath(), "utf8")).trim();
      if (active) return active;
    } catch {
      // No active-account file yet.
    }

    try {
      const entries = await fs.readdir(this.cookiesPath(), {
        withFileTypes: true
      });
      const accounts = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^douyin_.+\.json$/i.test(entry.name)
        )
        .map((entry) =>
          entry.name.replace(/^douyin_/i, "").replace(/\.json$/i, "")
        )
        .filter(Boolean);
      if (accounts.length === 1) {
        return accounts[0]!;
      }
    } catch {
      // Runtime home will be created on first operation.
    }

    return "default";
  }

  async probe(): Promise<DouyinBrowserEngineProbe> {
    if (!(await this.executableExists())) {
      return {
        ok: false,
        status: "ENGINE_UNAVAILABLE",
        message:
          "未找到二开的 social-auto-upload 发布引擎，请先安装 sau-pvs。"
      };
    }
    try {
      return this.parse<DouyinBrowserEngineProbe>(
        await this.run(["probe"])
      );
    } catch (error) {
      return {
        ok: false,
        status: "ENGINE_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async check(
    accountName?: string
  ): Promise<DouyinBrowserAccountStatus> {
    const account = accountName?.trim() || (await this.resolveAccountName());
    try {
      const payload = this.parse<DouyinBrowserAccountStatus>(
        await this.run(
          ["check", "--account", account],
          ACCOUNT_CHECK_TIMEOUT_MS
        )
      );
      return {
        ...payload,
        account,
        valid: payload.valid === true
      };
    } catch (error) {
      return {
        ok: false,
        account,
        status: "FAILED",
        valid: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async login(
    accountName: string,
    headed = true
  ): Promise<DouyinBrowserLoginResult> {
    const account = accountName.trim() || "default";
    const args = ["login", "--account", account];
    if (headed) args.push("--headed");
    const payload = this.parse<DouyinBrowserLoginResult>(
      await this.run(args, LOGIN_TIMEOUT_MS)
    );
    if (payload.ok) {
      await this.ensureRuntimeHome();
      await fs.writeFile(this.activeAccountPath(), account, "utf8");
    }
    return {
      ...payload,
      account
    };
  }

  async publish(
    request: DouyinBrowserPublishRequest,
    accountName?: string
  ): Promise<DouyinBrowserPublishResult> {
    const account = accountName?.trim() || (await this.resolveAccountName());
    const args = [
      "publish",
      "--account",
      account,
      "--file",
      request.videoPath,
      "--title",
      request.title
    ];
    if (request.description?.trim()) {
      args.push("--desc", request.description.trim());
    }
    if (request.tags?.length) {
      args.push("--tags", request.tags.join(","));
    }
    if (request.thumbnailPath?.trim()) {
      args.push("--thumbnail", request.thumbnailPath.trim());
    }
    if (request.declaration?.trim()) {
      args.push("--declaration", request.declaration.trim());
    }
    if (request.headed !== false) {
      args.push("--headed");
    }

    const payload = this.parse<DouyinBrowserPublishResult>(
      await this.run(args, PUBLISH_TIMEOUT_MS)
    );
    return {
      ...payload,
      account,
      verified: payload.verified === true
    };
  }
}
