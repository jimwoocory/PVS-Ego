import "../../isolation/require-isolation.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DouyinOpsLauncher,
  DouyinOpsLaunchResult
} from "../../application/ports/douyin-ops-launcher.js";

type CdpDouyinTab = {
  id: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
};

function isMainDouyinUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      (url.hostname === "www.douyin.com" || url.hostname === "douyin.com");
  } catch {
    return false;
  }
}

async function findExistingDouyinPage(): Promise<CdpDouyinTab | undefined> {
  try {
    const response = await fetch("http://127.0.0.1:9223/json/list", {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) return;
    const targets: unknown = await response.json();
    if (!Array.isArray(targets)) return;
    return targets.find((target): target is CdpDouyinTab => Boolean(
      target && typeof target === "object" &&
      target.type === "page" &&
      typeof target.id === "string" && /^[a-f0-9]{16,64}$/i.test(target.id) &&
      typeof target.url === "string" && isMainDouyinUrl(target.url)
    ));
  } catch {
    return;
  }
}

/** Browser page existence is NOT equivalent to successful Bridge registration. */
async function probeLiveDouyinBridge(): Promise<boolean> {
  try {
    // The Bridge registry may retain a dead polling connection after Chrome
    // exits. Require the independently supervised CDP client to be alive.
    const clientResponse = await fetch("http://127.0.0.1:19423/health", {
      signal: AbortSignal.timeout(2_000)
    });
    if (!clientResponse.ok) return false;
    const client: unknown = await clientResponse.json();
    if (!client || typeof client !== "object" ||
        (client as { ready?: boolean }).ready !== true) return false;
    const port = Number(process.env.PVS_DOUYIN_OPS_BRIDGE_PORT || "19422");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const response = await fetch("http://127.0.0.1:" + port + "/api/status", {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) return false;
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object") return false;
    const status = raw as { ok?: boolean; connections?: Record<string, unknown> };
    if (status.ok !== true) return false;
    const connections = status.connections?.["douyin.com"];
    if (!Array.isArray(connections)) return false;
    return connections.some((record: unknown) => {
      if (!record || typeof record !== "object") return false;
      const item = record as { alive?: boolean; url?: unknown; lastActivity?: unknown };
      if (item.alive === false || typeof item.url !== "string" || !isMainDouyinUrl(item.url)) return false;
      if (typeof item.lastActivity === "string") {
        const lastActivity = Date.parse(item.lastActivity);
        if (Number.isFinite(lastActivity) && Date.now() - lastActivity > 120_000) return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Explicit "restore connection" action: reload ONLY the existing dedicated
 * Douyin tab via its own CDP socket, never user's normal Chrome/Edge tabs.
 */
async function reloadExistingDouyinPage(): Promise<boolean> {
  const target = await findExistingDouyinPage();
  if (!target?.webSocketDebuggerUrl) return false;
  let url: URL;
  try {
    url = new URL(target.webSocketDebuggerUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" ||
      url.port !== "9223" || !url.pathname.startsWith("/devtools/page/")) {
    return false;
  }
  return new Promise(resolve => {
    const ws = new WebSocket(url.toString());
    let finished = false;
    const stop = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* no effect on browser */ }
      resolve(ok);
    };
    const timer = setTimeout(() => stop(false), 3_000);
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: false } }));
      } catch { stop(false); }
    });
    ws.addEventListener("message", event => {
      try {
        const data = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (data.id === 1) stop(!data.error);
      } catch { /* ignore unrelated notifications */ }
    });
    ws.addEventListener("error", () => stop(false));
    ws.addEventListener("close", () => stop(false));
  });
}

async function waitForBridge(
  probe: () => Promise<boolean>,
  timeoutMs = 7_000
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (true) {
    if (await probe()) return true;
    if (Date.now() >= until) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(700, until - Date.now())));
  }
}

async function activateExistingDouyinPage(): Promise<boolean> {
  // Existing page must be reused even when its Bridge is offline; do NOT
  // open a second browser just to hide a script-injection failure.
  const page = await findExistingDouyinPage();
  if (!page) return false;
  try {
    const activated = await fetch(
      "http://127.0.0.1:9223/json/activate/" + page.id,
      { signal: AbortSignal.timeout(2_000) }
    );
    // Activation only focuses the tab; connection state is verified separately.
    void activated;
    return true;
  } catch {
    // CDP activation can fail even though the page is present. Treat it as an
    // existing page so the launcher never forks duplicate Chrome profiles.
    return true;
  }
}

export class WindowsDouyinOpsLauncher
  implements DouyinOpsLauncher
{
  constructor(
    private readonly launcherPath =
      process.env.PVS_DOUYIN_OPS_LAUNCHER?.trim() ||
      path.resolve(
        process.cwd(),
        "..",
        "douyin-cli-start.cmd"
      ),
    private readonly reuseOpenPage: () => Promise<boolean> =
      activateExistingDouyinPage,
    private readonly bridgeProbe: () => Promise<boolean> =
      probeLiveDouyinBridge,
    private readonly reloadExistingPage: () => Promise<boolean> =
      reloadExistingDouyinPage,
    private readonly startConnection: () => Promise<boolean> =
      () => this.executeLauncher()
  ) {}

  private executeLauncher(): Promise<boolean> {
    // The dedicated Chromium may outlive its .cmd bootstrap process.
    // Pipe-backed execFile can wait on a Chrome descendant's inherited stdout,
    // making the launch button appear stuck for ~20 seconds. Ignore stdio and
    // wait for the bootstrap CMD process only; Bridge is probed separately.
    return new Promise(resolve => {
      const processHandle = spawn("cmd.exe", ["/d", "/c", this.launcherPath], {
        cwd: path.dirname(this.launcherPath),
        windowsHide: true,
        shell: false,
        stdio: "ignore"
      });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        processHandle.kill();
        finish(false);
      }, 20_000);
      processHandle.once("error", () => finish(false));
      processHandle.once("exit", code => finish(code === 0));
    });
  }

  async launch(): Promise<DouyinOpsLaunchResult> {
    if (process.platform !== "win32") {
      return {
        ok: false,
        status: "UNAVAILABLE",
        message: "当前只配置了 Windows 抖音运营启动器。"
      };
    }

    try {
      await fs.access(this.launcherPath);
    } catch {
      return {
        ok: false,
        status: "UNAVAILABLE",
        message: "未找到抖音运营启动器。"
      };
    }

    if (await this.reuseOpenPage()) {
      if (await this.bridgeProbe()) {
        return {
          ok: true,
          status: "STARTED",
          message: "复用已有抖音标签页，已确认本地连接服务与 Bridge 实际连通。"
        };
      }
      // Existing page != healthy connection. Bootstrap the supervised native
      // CDP bridge first; the underlying CMD reuses the SAME Chromium profile.
      const started = await this.startConnection();
      if (started && await waitForBridge(this.bridgeProbe, 12_000)) {
        return {
          ok: true,
          status: "STARTED",
          message: "已复用原抖音标签页并启动本地连接服务，Bridge 已确认恢复。"
        };
      }
      // Last-resort user-initiated recovery: reload ONE existing scoped page,
      // never spawn duplicate tabs or silently bypass browser trust prompts.
      if (started && await this.reloadExistingPage() &&
          await waitForBridge(this.bridgeProbe, 7_000)) {
        return {
          ok: true,
          status: "STARTED",
          message: "已刷新原抖音标签页，本地连接服务与 Bridge 重新建立通信。"
        };
      }
      return {
        ok: false,
        status: "FAILED",
        message: "抖音页面已打开，但本地连接服务尚未恢复。没有重复启动浏览器；请查看 CDP Bridge 健康检查和专用浏览器连接状态。"
      };
    }

    const started = await this.startConnection();
    if (!started) return {
      ok: false, status: "FAILED",
      message: "专用浏览器或 CDP Bridge 启动失败，请查看本地启动器诊断。"
    };
    if (await waitForBridge(this.bridgeProbe, 15_000)) {
      return {
        ok: true, status: "STARTED",
        message: "专用抖音浏览器和本地 Bridge 均已验证连通，账号状态另行核实。"
      };
    }
    return {
      ok: false, status: "FAILED",
      message: "专用浏览器已启动，但未检测到可执行请求的 Bridge 连接，不会重复打开页面。"
    };
  }
}
