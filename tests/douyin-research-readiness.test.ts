import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DouyinOpsRuntimeError, type DouyinOpsRuntime } from "../src/application/ports/douyin-ops-runtime.js";
import { checkDouyinResearchReadiness } from "../src/application/services/douyin-research-readiness.js";
import type { DouyinOpsDashboardService } from "../src/application/services/douyin-ops-dashboard-service.js";
import { handleDouyinOpsHttp } from "../src/web/douyin-ops-http.js";

const probeReady = { ok: true, ready: true, status: "READY" };
const identity = { nickname: "测试账号", uid: "valid-user", secUid: "", uniqueId: "", shortId: "" };
type ReadOnlyRuntime = Pick<DouyinOpsRuntime, "probe" | "identity">;

test("research readiness uses probe + identity only, never loading posts or publishing bindings", async () => {
  const calls: string[] = [];
  const runtime = {
    probe: async () => { calls.push("probe"); return probeReady; },
    identity: async () => { calls.push("identity"); return identity; },
    listMyWorks: () => { throw Error("must never query a creator works list"); }
  } as ReadOnlyRuntime;
  const result = await checkDouyinResearchReadiness(runtime);
  assert.equal(result.status, "READY");
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ["probe", "identity"]);
  assert.doesNotMatch(JSON.stringify(result), /valid-user|测试账号/);
});

test("offline Bridge avoids identity lookups and reports the actual blocked state", async () => {
  let identityCalls = 0;
  const result = await checkDouyinResearchReadiness({
    probe: async () => ({ok: false, ready: false, status: "SITE_OFFLINE"}),
    identity: async () => {identityCalls++; return identity;}
  });
  assert.equal(identityCalls, 0);
  assert.equal(result.ready, false);
  assert.equal(result.status, "SITE_OFFLINE");
  assert.match(result.message, /专用抖音网页/);
});

test("successful Bridge ping is not treated as proof of logged-in account", async () => {
  const result = await checkDouyinResearchReadiness({
    probe: async () => probeReady,
    identity: async () => ({nickname: "未登录", uid: "", secUid: "", uniqueId: "", shortId: ""})
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, "AUTH_REQUIRED");
});

test("login expiry, risk control and unknown errors remain distinct and fail closed", async () => {
  for (const code of ["AUTH_REQUIRED", "RISK_CONTROL", "SITE_OFFLINE"]) {
    const result = await checkDouyinResearchReadiness({
      probe: async () => probeReady,
      identity: async () => { throw new DouyinOpsRuntimeError(code, "credential secret 123"); }
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, code);
    assert.doesNotMatch(result.message, /credential|123/);
  }
  const unexpected = await checkDouyinResearchReadiness({
    probe: async () => {throw Error("internal credential token");},
    identity: async () => identity
  });
  assert.equal(unexpected.ready, false);
  assert.equal(unexpected.status, "PROVIDER_ERROR");
  assert.doesNotMatch(unexpected.message, /credential|token/);
});

test("dedicated readiness HTTP is GET-only, does not invoke expensive dashboard global or writes", async () => {
  let calls = 0;
  const fake = {
    researchReadiness: async () => {
      calls++;
      return {ready:true, status:"READY", message:"研究连接已就绪", checkedAt:"2026-10-10T00:00:00Z"};
    },
    global: () => { throw Error("must not query global operations dashboard"); },
    launch: () => { throw Error("must not launch browser"); }
  } as unknown as DouyinOpsDashboardService;
  const server = http.createServer((req,res) => {
    void handleDouyinOpsHttp(req,res,new URL(req.url ?? "/", "http://localhost"),{
      douyinOpsDashboard: fake
    }).then(found => {
      if (!found && !res.writableEnded) {res.writeHead(404);res.end();}
    }).catch(() => {if (!res.writableEnded) {res.writeHead(500);res.end();}});
  });
  await new Promise<void>((resolve,reject) => server.listen(0,"127.0.0.1", () => resolve()).once("error",reject));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port + "/api/douyin/ops/research-readiness";
    const good = await fetch(url);
    assert.equal(good.status,200);
    assert.equal(good.headers.get("cache-control"),"no-store, max-age=0");
    const json = await good.json() as {ready:boolean;status:string};
    assert.deepEqual({ready:json.ready,status:json.status},{ready:true,status:"READY"});
    const forbidden = await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    assert.equal(forbidden.status,405);
    assert.equal(calls,1);
  } finally {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error):resolve()));
  }
});
