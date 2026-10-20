import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsDouyinResearchAuthLauncher } from "../src/adapters/research/douyin-research-auth-launcher.js";

test("Douyin research launcher prepares read-only Edge bridge and reuses active session", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-douyin-auth-"));
  const bridgeRoot = path.join(temp, "douyin-cli");
  const bridgeProfileRoot = path.join(temp, "pvs-edge-profile");
  const runtimeExtension = path.join(temp, "runtime-extension");
  const browserExe = path.join(temp, "msedge.exe");
  await fs.mkdir(bridgeRoot, { recursive: true });
  await fs.writeFile(browserExe, "");
  await fs.writeFile(
    path.join(bridgeRoot, "config.json"),
    JSON.stringify({
      bridge: {
        host: "127.0.0.1",
        port: 19422,
        token: "unit-test-bridge-token"
      }
    })
  );
  await fs.writeFile(path.join(bridgeRoot, "server.js"), "");

  const oldEnv = {
    root: process.env.PVS_DOUYIN_BROWSER_BRIDGE_ROOT,
    bridgeProfile: process.env.PVS_DOUYIN_BRIDGE_PROFILE_ROOT,
    runtime: process.env.PVS_DOUYIN_BRIDGE_EXTENSION_RUNTIME,
  };
  process.env.PVS_DOUYIN_BROWSER_BRIDGE_ROOT = bridgeRoot;
  process.env.PVS_DOUYIN_BRIDGE_PROFILE_ROOT = bridgeProfileRoot;
  process.env.PVS_DOUYIN_BRIDGE_EXTENSION_RUNTIME = runtimeExtension;

  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }> = [];

  const spawnFake = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => {
    const child = new EventEmitter() as ChildProcess & {
      spawnfile: string;
      exitCode: number | null;
      killed: boolean;
      unref(): void;
    };
    child.spawnfile = command;
    child.exitCode = null;
    child.killed = false;
    child.unref = () => undefined;
    spawnCalls.push({
      command,
      args: [...args],
      options
    });
    return child;
  }) as never;

  let statusCalls = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/health")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.endsWith("/api/status")) {
      statusCalls += 1;
      const active = statusCalls >= 2;
      return new Response(
        JSON.stringify({
          ok: true,
          connections: active
            ? {
                "douyin.com": [
                  {
                    alive: true,
                    lastActivity: new Date().toISOString()
                  }
                ]
              }
            : {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;

  const launcher = new WindowsDouyinResearchAuthLauncher(
    async () => browserExe,
    spawnFake,
    fakeFetch
  );

  try {
    const first = await launcher.launch("草本护颈枕");
    assert.equal(first.started, true);
    assert.equal(first.alreadyRunning, false);
    assert.equal(spawnCalls.length, 1);

    const browser = spawnCalls[0]!;
    assert.equal(browser.command, browserExe);
    assert.equal(browser.options.windowsHide, false);
    assert.equal(browser.options.detached, true);
    assert.ok(
      browser.args.includes("--profile-directory=Default")
    );
    assert.ok(
      browser.args.includes("--user-data-dir=" + bridgeProfileRoot)
    );
    assert.ok(
      browser.args.some((item) =>
        item.startsWith("--load-extension=" + runtimeExtension)
      )
    );
    assert.ok(
      browser.args.some((item) =>
        item.includes(
          "https://www.douyin.com/search/%E8%8D%89%E6%9C%AC%E6%8A%A4%E9%A2%88%E6%9E%95?type=video"
        )
      )
    );
    assert.equal(
      browser.args.some((item) => item === "--disable-extensions"),
      false
    );
    assert.equal(
      browser.args.some((item) => item === "--restore-last-session"),
      false
    );

    const background = await fs.readFile(
      path.join(runtimeExtension, "background.js"),
      "utf8"
    );
    assert.doesNotMatch(background, /__PVS_BRIDGE_TOKEN__/);
    assert.match(background, /unit-test-bridge-token/);

    const second = await launcher.launch("另一个关键词");
    assert.equal(second.started, false);
    assert.equal(second.alreadyRunning, true);
    assert.equal(spawnCalls.length, 2);
    assert.ok(
      spawnCalls[1]!.args.includes(
        "--user-data-dir=" + bridgeProfileRoot
      )
    );
    assert.ok(
      spawnCalls[1]!.args.includes(
        "https://www.douyin.com/search/%E5%8F%A6%E4%B8%80%E4%B8%AA%E5%85%B3%E9%94%AE%E8%AF%8D?type=video"
      )
    );
    assert.equal(
      spawnCalls[1]!.args.some(
        (item) => item === "--restore-last-session"
      ),
      false
    );

    const synced = await launcher.syncCookies();
    assert.deepEqual(synced, {
      cookieCount: 0,
      hasSession: true
    });
  } finally {
    if (oldEnv.root === undefined) {
      delete process.env.PVS_DOUYIN_BROWSER_BRIDGE_ROOT;
    } else {
      process.env.PVS_DOUYIN_BROWSER_BRIDGE_ROOT = oldEnv.root;
    }
    if (oldEnv.bridgeProfile === undefined) {
      delete process.env.PVS_DOUYIN_BRIDGE_PROFILE_ROOT;
    } else {
      process.env.PVS_DOUYIN_BRIDGE_PROFILE_ROOT =
        oldEnv.bridgeProfile;
    }
    if (oldEnv.runtime === undefined) {
      delete process.env.PVS_DOUYIN_BRIDGE_EXTENSION_RUNTIME;
    } else {
      process.env.PVS_DOUYIN_BRIDGE_EXTENSION_RUNTIME = oldEnv.runtime;
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Douyin research launcher source cannot globally kill or restore the user's browser", async () => {
  const source = await fs.readFile(
    path.join(
      process.cwd(),
      "src",
      "adapters",
      "research",
      "douyin-research-auth-launcher.ts"
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /taskkill\.exe/i);
  assert.doesNotMatch(source, /CloseMainWindow/i);
  assert.doesNotMatch(source, /--restore-last-session/i);
  assert.doesNotMatch(
    source,
    /PVS_DOUYIN_BROWSER_USER_DATA_ROOT/
  );
  assert.match(source, /PVS_DOUYIN_BRIDGE_PROFILE_ROOT/);
});
