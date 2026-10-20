import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfficialDouyinOpenApiProvider } from "../src/adapters/publish/official-douyin-openapi-provider.js";
import { DouyinOpenApiDirectProviderAdapter } from "../src/adapters/publish/douyin-openapi-direct-provider.js";
import { PublishSubmissionUnknownError } from "../src/application/ports/publish-provider.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-openapi-account-"));
  const keys = ["DOUYIN_CLIENT_KEY", "DOUYIN_CLIENT_SECRET", "DOUYIN_REDIRECT_URI", "PVS_DOUYIN_OPENAPI_DIRECT_ENABLED"];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = key === "PVS_DOUYIN_OPENAPI_DIRECT_ENABLED" ? "1" : "synthetic-test-only";
  await fs.mkdir(path.join(root, "tokens"));
  const tokenFile = path.join(root, "tokens", "project.json");
  const setToken = (openId: string) => fs.writeFile(tokenFile, JSON.stringify({
    projectId: "project", accessToken: "synthetic-token-" + openId, openId,
    scope: "video.create", expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  }));
  await setToken("account-A");
  const videoPath = path.join(root, "synthetic.mp4");
  await fs.writeFile(videoPath, "synthetic-test-video");
  const originalFetch = globalThis.fetch;
  // No test can accidentally make a platform request, including tests expected to fail before upload.
  globalThis.fetch = async () => { throw new Error("Unexpected external request in synthetic account test"); };
  return { provider: new OfficialDouyinOpenApiProvider(root), videoPath, setToken,
    async dispose() {
      globalThis.fetch = originalFetch;
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test("OpenAPI adapter exposes concrete openId and forwards the user's expected identity", async () => {
  const f = await fixture();
  try {
    let seen: string | undefined;
    f.provider.publish = async input => {
      seen = input.expectedAccountId;
      return { videoId: "opaque-video", itemId: "opaque-item", providerAccountId: "account-A" };
    };
    const adapter = new DouyinOpenApiDirectProviderAdapter(f.provider);
    assert.equal((await adapter.probe("project")).platformUserId, "account-A");
    await assert.rejects(adapter.directPublish({ projectId: "project", packageId: "package",
      videoPath: f.videoPath, title: "测试", expectedAccountId: "account-B" }), /账号.*不一致/);
    assert.equal(seen, undefined);
    const result = await adapter.directPublish({ projectId: "project", packageId: "package",
      videoPath: f.videoPath, title: "测试", expectedAccountId: "account-A" });
    assert.equal(seen, "account-A");
    assert.equal(result.platformIdentity?.providerAccountId, "account-A");
    assert.equal(result.platformIdentity?.providerAccountIdType, "OPEN_ID");
    assert.equal(result.platformIdentity?.verifiedAwemeId, undefined);
  } finally { await f.dispose(); }
});

test("OpenAPI rechecks the actual token identity after probe before any upload", async () => {
  const f = await fixture();
  try {
    const originalProbe = f.provider.probe.bind(f.provider);
    f.provider.probe = async projectId => {
      const result = await originalProbe(projectId);
      await f.setToken("account-B");
      return result;
    };
    await assert.rejects(f.provider.publish({ projectId: "project", videoPath: f.videoPath,
      title: "测试", expectedAccountId: "account-A" }), /授权账号已变更/);
  } finally { await f.dispose(); }
});

test("OpenAPI upload and create use one pinned token even when stored authorization changes", async () => {
  const f = await fixture();
  try {
    const accounts: string[] = [];
    globalThis.fetch = async (url, init) => {
      accounts.push(new URL(String(url)).searchParams.get("open_id")!);
      assert.equal(new Headers(init?.headers).get("access-token"), "synthetic-token-account-A");
      if (accounts.length === 1) {
        await f.setToken("account-B");
        return new Response(JSON.stringify({ data: { video: { video_id: "opaque-video" } } }));
      }
      return new Response(JSON.stringify({ data: { item_id: "opaque-item" } }));
    };
    const result = await f.provider.publish({ projectId: "project", videoPath: f.videoPath,
      title: "测试", expectedAccountId: "account-A" });
    assert.deepEqual(accounts, ["account-A", "account-A"]);
    assert.equal(result.providerAccountId, "account-A");
  } finally { await f.dispose(); }
});

test("OpenAPI create transport loss, invalid JSON and missing item IDs are unknown; explicit rejections remain failures", async () => {
  const f = await fixture();
  try {
    for (const mode of ["transport", "json", "empty-id", "null", "http-error", "rejected"] as const) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ data: { video: { video_id: "uploaded-only" } } }));
        if (mode === "transport") throw new Error("synthetic response lost after platform accepted create");
        if (mode === "json") return new Response("bad json");
        if (mode === "null") return new Response("null");
        if (mode === "http-error") return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ data: mode === "rejected"
          ? { error_code: 2100005, description: "explicit synthetic rejection" } : { error_code: 0 } }));
      };
      await assert.rejects(f.provider.publish({ projectId: "project", videoPath: f.videoPath,
        title: "测试", expectedAccountId: "account-A" }), error => mode === "rejected"
        ? error instanceof Error && !(error instanceof PublishSubmissionUnknownError) && /rejected/.test(error.message)
        : error instanceof PublishSubmissionUnknownError);
      assert.equal(calls, 2);
    }
  } finally { await f.dispose(); }
});
