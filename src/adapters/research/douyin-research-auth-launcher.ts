import "../../isolation/require-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DomainValidationError } from "../../domain/validation.js";

type BridgeConfig = {
  root: string;
  endpoint: string;
  token: string;
};

export type DouyinResearchAuthLaunchResult = {
  started: boolean;
  alreadyRunning: boolean;
  executable: string;
};

export type DouyinResearchAuthSyncResult = {
  cookieCount: number;
  hasSession: boolean;
};

export interface DouyinResearchAuthLauncher {
  launch(query?: string): Promise<DouyinResearchAuthLaunchResult>;
  syncCookies(): Promise<DouyinResearchAuthSyncResult>;
}

async function resolveBrowserExecutable(): Promise<string> {
  const configured = process.env.PVS_DOUYIN_RESEARCH_BROWSER_BIN?.trim();
  const candidates = [
    configured,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new DomainValidationError(
    "未找到可用的 Microsoft Edge 或 Google Chrome，无法启用抖音网页研究。"
  );
}

function resolveBridgeConfig(): BridgeConfig {
  const root =
    process.env.PVS_DOUYIN_BROWSER_BRIDGE_ROOT?.trim() ||
    path.join(
      process.env.USERPROFILE ?? "",
      "AgentDock",
      "douyin-cli"
    );
  const configPath = path.join(root, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new DomainValidationError(
      "未找到抖音网页研究 Bridge。请先恢复 Yht20927/douyin-cli。"
    );
  }
  let parsed: {
    bridge?: {
      host?: string;
      port?: number;
      token?: string;
    };
  };
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new DomainValidationError(
      "抖音网页研究 Bridge 配置无法读取。"
    );
  }
  const host = parsed.bridge?.host?.trim() || "127.0.0.1";
  const port = Number(parsed.bridge?.port ?? 19422);
  const token = parsed.bridge?.token?.trim() || "";
  if (
    !["127.0.0.1", "localhost"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token
  ) {
    throw new DomainValidationError(
      "抖音网页研究 Bridge 配置无效。"
    );
  }
  return {
    root,
    endpoint: "http://" + host + ":" + port,
    token
  };
}

function isolatedProfileFor(browserExecutable: string): {
  root: string;
  name: "Default";
} {
  const useEdge = /(?:^|[\\/])msedge\.exe$/i.test(
    browserExecutable
  );
  const normalRoot = path.resolve(
    process.env.LOCALAPPDATA ?? "",
    useEdge ? "Microsoft" : "Google",
    useEdge ? "Edge" : "Chrome",
    "User Data"
  );
  const root = path.resolve(
    process.env.PVS_DOUYIN_BRIDGE_PROFILE_ROOT?.trim() ||
      path.join(
        process.cwd(),
        "..",
        useEdge
          ? "douyin-research-bridge-edge-v1"
          : "douyin-research-bridge-chrome-v1"
      )
  );
  const relative = path.relative(normalRoot, root);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new DomainValidationError(
      "PVS 抖音网页研究必须使用独立浏览器 Profile，不能使用系统默认浏览器用户目录。"
    );
  }
  return { root, name: "Default" };
}

async function bridgeRequest(
  endpoint: string,
  pathname: string,
  timeoutMs = 2500,
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(endpoint + pathname, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function freshDouyinConnection(
  status: Record<string, unknown> | null,
  freshnessMs = 70_000
): boolean {
  if (!status) return false;
  const connections =
    status.connections &&
    typeof status.connections === "object" &&
    !Array.isArray(status.connections)
      ? (status.connections as Record<string, unknown>)
      : {};
  const rows = Array.isArray(connections["douyin.com"])
    ? (connections["douyin.com"] as unknown[])
    : [];
  const now = Date.now();
  return rows.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const item = raw as Record<string, unknown>;
    if (item.alive === false || typeof item.lastActivity !== "string") {
      return false;
    }
    const value = Date.parse(item.lastActivity);
    return (
      Number.isFinite(value) &&
      now - value >= -5_000 &&
      now - value <= freshnessMs
    );
  });
}

export class WindowsDouyinResearchAuthLauncher
  implements DouyinResearchAuthLauncher
{
  private activeBrowser?: ChildProcess;

  constructor(
    private readonly resolveBrowserExecutableFn: () => Promise<string> =
      resolveBrowserExecutable,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private prepareRuntimeExtension(bridge: BridgeConfig): string {
    const projectRoot = process.cwd();
    const source = path.join(
      projectRoot,
      "browser-extension",
      "douyin-research-bridge"
    );
    const target = path.join(
      process.env.PVS_DOUYIN_BRIDGE_EXTENSION_RUNTIME?.trim() ||
        path.join(
          projectRoot,
          ".runtime",
          "douyin-research-bridge-extension"
        )
    );
    for (const filename of [
      "manifest.json",
      "page-search.js",
      "bridge-client.js",
      "background.js"
    ]) {
      const sourceFile = path.join(source, filename);
      if (!fs.existsSync(sourceFile)) {
        throw new DomainValidationError(
          "抖音网页研究扩展文件缺失：" + filename
        );
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const filename of [
      "manifest.json",
      "page-search.js",
      "bridge-client.js",
      "background.js"
    ]) {
      const sourceFile = path.join(source, filename);
      const targetFile = path.join(target, filename);
      let value = fs.readFileSync(sourceFile, "utf8");
      if (filename === "background.js") {
        value = value.replace(
          "__PVS_BRIDGE_TOKEN__",
          bridge.token
        );
      }
      fs.writeFileSync(targetFile, value, "utf8");
    }
    return target;
  }

  private async ensureBridgeServer(bridge: BridgeConfig): Promise<void> {
    if (
      await bridgeRequest(
        bridge.endpoint,
        "/api/health",
        2500,
        this.fetcher
      )
    ) {
      return;
    }
    const serverJs = path.join(bridge.root, "server.js");
    if (!fs.existsSync(serverJs)) {
      throw new DomainValidationError(
        "抖音网页研究 Bridge Server 不存在。"
      );
    }
    const child = this.spawnProcess(
      process.execPath,
      [serverJs],
      {
        cwd: bridge.root,
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    );
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (
        await bridgeRequest(
          bridge.endpoint,
          "/api/health",
          2500,
          this.fetcher
        )
      ) {
        return;
      }
    }
    throw new DomainValidationError(
      "抖音网页研究 Bridge Server 启动失败。"
    );
  }

  private async bridgeConnected(bridge: BridgeConfig): Promise<boolean> {
    return freshDouyinConnection(
      await bridgeRequest(
        bridge.endpoint,
        "/api/status",
        2500,
        this.fetcher
      )
    );
  }

  async launch(query = "护颈枕"): Promise<DouyinResearchAuthLaunchResult> {
    if (process.platform !== "win32") {
      throw new DomainValidationError(
        "当前抖音网页研究入口仅在 Windows 桌面环境启用。"
      );
    }

    const bridge = resolveBridgeConfig();
    const extensionDir = this.prepareRuntimeExtension(bridge);
    await this.ensureBridgeServer(bridge);

    const browserExecutable = await this.resolveBrowserExecutableFn();
    const profile = isolatedProfileFor(browserExecutable);
    fs.mkdirSync(profile.root, { recursive: true });

    const searchUrl =
      "https://www.douyin.com/search/" +
      encodeURIComponent(query.trim() || "护颈枕") +
      "?type=video";

    if (await this.bridgeConnected(bridge)) {
      this.spawnProcess(browserExecutable, [
        `--user-data-dir=${profile.root}`,
        `--profile-directory=${profile.name}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        searchUrl
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }).unref();
      return {
        started: false,
        alreadyRunning: true,
        executable: browserExecutable
      };
    }

    const browser = this.spawnProcess(
      browserExecutable,
      [
        `--user-data-dir=${profile.root}`,
        `--profile-directory=${profile.name}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        searchUrl
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }
    );
    this.activeBrowser = browser;
    browser.once("error", () => {
      if (this.activeBrowser === browser) this.activeBrowser = undefined;
    });
    browser.once("exit", () => {
      if (this.activeBrowser === browser) this.activeBrowser = undefined;
    });
    browser.unref();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (await this.bridgeConnected(bridge)) {
        return {
          started: true,
          alreadyRunning: false,
          executable: browserExecutable
        };
      }
    }

    throw new DomainValidationError(
      "PVS 抖音研究独立浏览器已经打开，但 Bridge 尚未连接。请在该独立窗口中完成登录/验证后重试；程序不会关闭或重启你正在使用的 Edge / Chrome。"
    );
  }

  async syncCookies(): Promise<DouyinResearchAuthSyncResult> {
    const bridge = resolveBridgeConfig();
    await this.ensureBridgeServer(bridge);
    if (!(await this.bridgeConnected(bridge))) {
      throw new DomainValidationError(
        "当前 Edge 抖音网页研究 Bridge 尚未连接，请先打开抖音搜索页。"
      );
    }
    return {
      cookieCount: 0,
      hasSession: true
    };
  }
}
