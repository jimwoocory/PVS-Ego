import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { z } from "zod";
import { AgentCycleService } from "../src/application/services/agent-cycle-service.js";
import type { AgentCycleRepository } from "../src/application/ports/agent-cycle-repository.js";
import type { AgentCapabilityCatalog } from "../src/application/ports/agent-capability.js";
import type { AgentCycle } from "../src/domain/agent-cycle.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { handleAgentCycleHttp } from "../src/web/agent-cycle-http.js";
import { renderAgentCyclePage } from "../src/web/agent-cycle-ui.js";

class MemoryCycles implements AgentCycleRepository {
  rows = new Map<string, AgentCycle>(); locks = new Set<string>();
  async create(cycle: AgentCycle) {
    const previous = [...this.rows.values()].find(row => row.projectId === cycle.projectId && row.input.requestKey === cycle.input.requestKey);
    if (previous) { if (previous.inputHash !== cycle.inputHash) throw new DomainValidationError("请求键已使用且输入不同"); return structuredClone(previous); }
    this.rows.set(cycle.id, structuredClone(cycle)); return structuredClone(cycle);
  }
  async get(projectId: string, id: string) { const row = this.rows.get(id); return row?.projectId === projectId ? structuredClone(row) : null; }
  async list(projectId?: string) { return structuredClone([...this.rows.values()].filter(row => !projectId || row.projectId === projectId)); }
  async claim(projectId: string, id: string) { if (!await this.get(projectId, id) || this.locks.has(id)) return false; this.locks.add(id); return true; }
  async save(cycle: AgentCycle, expectedRevision: number) { if (this.rows.get(cycle.id)?.revision !== expectedRevision) throw new Error("revision conflict"); this.rows.set(cycle.id, structuredClone(cycle)); return structuredClone(cycle); }
  async release(id: string) { this.locks.delete(id); }
  async recoverAbandoned() { return false; }
}

async function fixture() {
  const repository = new MemoryCycles(); let readCalls = 0; let writeCalls = 0;
  const capabilities = [
    { id: "project.inspect", title: "读取本地结果", description: "只读", effect: "READ" as const, inputSchema: z.object({}).strict(), async run() { readCalls++; return { status: "COMPLETE" as const, summary: "已读取", data: { actualResult: "stored-1" } }; } },
    { id: "publication.submit", title: "发布成片", description: "需要用户明确确认", effect: "EXTERNAL_WRITE" as const, inputSchema: z.object({ packageId: z.string().min(1) }).strict(), async preview() { return "账号 UID-1；标题：测试；视频 sha256：abc"; }, async run(context: { confirmed: boolean }) { assert.equal(context.confirmed, true); writeCalls++; return { status: "COMPLETE" as const, summary: "测试确认路径" }; } }
  ];
  const catalog: AgentCapabilityCatalog = { list() { return capabilities; }, get(id) { const tool = capabilities.find(c => c.id === id); if (!tool) throw new DomainValidationError("unknown capability"); return tool; },
    async snapshot() { return { stored: true }; }, async fingerprint() { return "fixed-local-state"; }, async validateCompletion() { return ["未完成真实业务"]; } };
  const service = new AgentCycleService(repository, catalog, { id: "MOCK", version: "1", async generateJson() { return { action: "ASK_USER", question: "测试所需信息" }; } });
  const flow = { async getProject(id: string) { return ["p", "another"].includes(id) ? { id, name: "项目" } : null; }, async listProjects() { return [{ id: "p", name: "项目" }]; } } as unknown as ProductFlowService;
  const server = http.createServer((req, res) => { void handleAgentCycleHttp(req, res, new URL(req.url!, "http://localhost"), { agentCycles: service, productFlow: flow }).then(handled => {
    if (!handled && !res.headersSent) { res.statusCode = 404; res.end(); }
  }).catch(error => { if (!res.headersSent) { res.writeHead(error instanceof z.ZodError || error instanceof DomainValidationError ? 400 : 500, { "content-type": "application/json" }); res.end(JSON.stringify({ message: error.message })); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const rpc = async (method: string, params: object = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/pvs/mcp", { method: "POST", headers: { "content-type": "application/json", ...(process.env.PVS_MCP_TOKEN ? { authorization: "Bearer " + process.env.PVS_MCP_TOKEN } : {}), ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });
    return { response, body: await response.json() as Record<string, any> };
  };
  return { base, rpc, service, repository, get readCalls() { return readCalls; }, get writeCalls() { return writeCalls; },
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("all Agent HTTP/MCP surfaces reject hostile Host, Origin, port and scheme", async () => {
  const f = await fixture();
  try {
    const rejectedHeaders: Array<Record<string, string>> = [{ host: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "null" }, { origin: "http://127.0.0.1:1" }, { origin: f.base.replace("http:", "https:") }, { origin: f.base + "/unexpected-path" }];
    for (const route of ["/agent-cycle", "/projects/p/agent-cycle", "/api/projects/p/agent-cycles", "/api/pvs/mcp"]) {
      for (const headers of rejectedHeaders)
        assert.equal(await new Promise<number>((resolve, reject) => {
          // fetch/undici rewrites Host; use the actual HTTP header on the wire.
          const request = http.request(f.base + route, { headers }, response => { response.resume(); resolve(response.statusCode!); });
          request.on("error", reject); request.end();
        }), 403, route + " " + JSON.stringify(headers));
    }
    assert.equal((await fetch(f.base + "/api/projects/p/agent-cycles", { headers: { origin: f.base } })).status, 200);
  } finally { await f.close(); }
});

test("MCP transport implements initialize, notification, ping, JSON and protocol boundaries", async () => {
  const f = await fixture(); const original = process.env.PVS_MCP_TOKEN;
  process.env.PVS_MCP_TOKEN = "test-only-local-mcp-token";
  const headers = { authorization: "Bearer test-only-local-mcp-token" };
  try {
    assert.equal((await f.rpc("initialize", {}, { authorization: "" })).response.status, 401);
    assert.equal((await f.rpc("initialize", {}, { authorization: "Bearer wrong" })).response.status, 401);
    const init = await f.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, headers);
    assert.equal(init.body.jsonrpc, "2.0"); assert.equal(init.body.id, 7); assert.equal(init.body.result.protocolVersion, "2025-06-18"); assert.ok(init.body.result.capabilities.tools);
    assert.equal((await f.rpc("ping", {}, headers)).body.result && true, true);
    assert.equal((await fetch(f.base + "/api/pvs/mcp", { method: "GET", headers })).status, 405);
    assert.equal((await fetch(f.base + "/api/pvs/mcp", { method: "POST", headers, body: "{}" })).status, 415);
    assert.equal((await f.rpc("ping", {}, { ...headers, "mcp-protocol-version": "unsupported" })).response.status, 400);
    const notification = await fetch(f.base + "/api/pvs/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(notification.status, 202); assert.equal(await notification.text(), "");
    assert.equal((await f.rpc("unknown/method", {}, headers)).body.error.code, -32601);
  } finally { if (original === undefined) delete process.env.PVS_MCP_TOKEN; else process.env.PVS_MCP_TOKEN = original; await f.close(); }
});

test("MCP tools use actual action execution and request-key replay does not call a tool twice", async () => {
  const f = await fixture();
  try {
    const list = (await f.rpc("tools/list")).body.result.tools;
    const inspect = list.find((t: { name: string }) => t.name === "pvs_project_inspect");
    assert.ok(inspect); assert.equal(inspect.inputSchema.additionalProperties, false); assert.equal(inspect.annotations.readOnlyHint, true);
    assert.ok(list.some((t: { name: string }) => t.name === "pvs_publication_submit"));
    const create = async (goal = "测试业务目标") => (await f.rpc("tools/call", { name: "pvs_create_cycle", arguments: { projectId: "p", goal, requestKey: "create-1" } })).body.result;
    const initial = await create(); const cycleId = initial.structuredContent.result.id;
    assert.equal((await create()).structuredContent.result.id, cycleId);
    assert.equal((await create("已经改变的目标")).isError, true);
    const invoke = { name: "pvs_project_inspect", arguments: { projectId: "p", cycleId, requestKey: "read-1", input: {} } };
    const first = (await f.rpc("tools/call", invoke)).body.result;
    assert.equal(first.structuredContent.result.action.result.data.actualResult, "stored-1"); assert.equal(f.readCalls, 1);
    assert.equal((await f.rpc("tools/call", invoke)).body.result.isError, undefined); assert.equal(f.readCalls, 1);
    const conflict = await f.rpc("tools/call", { name: "pvs_publication_submit", arguments: { projectId: "p", cycleId, requestKey: "read-1", input: { packageId: "pkg-1" } } });
    assert.equal(conflict.body.result.isError, true); assert.equal(f.writeCalls, 0);
    const crossProject = await f.rpc("tools/call", { name: "pvs_get_cycle", arguments: { projectId: "another", cycleId } });
    assert.equal(crossProject.body.result.isError, true);
  } finally { await f.close(); }
});

test("MCP cannot forge confirmation and real HTTP confirmation binds revision and exact action hash", async () => {
  const f = await fixture();
  try {
    const cycle = await f.service.create("p", { goal: "测试发布确认路径", requestKey: "create-write" });
    const args = { projectId: "p", cycleId: cycle.id, requestKey: "write-1", input: { packageId: "pkg-1" } };
    const forged = await f.rpc("tools/call", { name: "pvs_publication_submit", arguments: { ...args, confirmed: true } });
    assert.equal(forged.body.result.isError, true);
    const forgedInput = await f.rpc("tools/call", { name: "pvs_publication_submit", arguments: { ...args, input: { ...args.input, confirmed: true } } });
    assert.equal(forgedInput.body.result.isError, true);
    const proposal = (await f.rpc("tools/call", { name: "pvs_publication_submit", arguments: args })).body.result.structuredContent.result;
    assert.equal(proposal.status, "WAITING_CONFIRMATION"); assert.equal(f.writeCalls, 0);
    const pending = (await f.service.get("p", cycle.id))!; const action = pending.actions[0]!;
    const post = (actionName: string, body: object) => fetch(f.base + "/api/projects/p/agent-cycles/" + cycle.id + "/" + actionName, { method: "POST", headers: { "content-type": "application/json", origin: f.base }, body: JSON.stringify(body) });
    assert.equal((await post("advance", { confirmed: true })).status, 200); assert.equal(f.writeCalls, 0);
    assert.equal((await post("confirm", { expectedRevision: pending.revision, actionId: action.id, inputHash: "0".repeat(64) })).status, 400);
    assert.equal((await post("confirm", { expectedRevision: pending.revision, actionId: action.id, inputHash: action.inputHash, confirmed: true })).status, 400);
    assert.equal((await post("confirm", { expectedRevision: pending.revision, actionId: action.id, inputHash: action.inputHash })).status, 200);
    assert.equal((await post("advance", {})).status, 200); assert.equal(f.writeCalls, 1);
    await f.rpc("tools/call", { name: "pvs_publication_submit", arguments: args }); assert.equal(f.writeCalls, 1, "request-key replay must not send again");
    assert.equal((await f.rpc("tools/call", { name: "pvs_confirm_cycle", arguments: args })).body.error.code, -32602);
  } finally { await f.close(); }
});

test("Agent UI escapes business content and embeds syntactically valid JavaScript", () => {
  const marker = '<img src=x onerror="attack()"><script>attack()</script>';
  const cycle = { id: "cycle-1", projectId: "p", input: { goal: marker }, revision: 3, status: "WAITING_CONFIRMATION", steps: 1, loadedSkills: [], evidence: [], messages: [{ role: "agent", text: marker }], actions: [
    { id: "a1", status: "PROPOSED", inputHash: "f".repeat(64), preview: marker }
  ] } as unknown as AgentCycle;
  const html = renderAgentCyclePage({ project: { id: "p", name: marker }, projects: [], cycles: [cycle], skills: [{ id: "s", title: marker }] });
  assert.ok(html.includes("&lt;img")); assert.ok(!html.includes("<img src=x")); assert.ok(!html.includes("<script>attack()"));
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]; assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]![1]!)); assert.ok(html.includes("确认这一项动作"));
});

test("UI caches request keys across failed retries and navigation, scoped to project and goal", async () => {
  const storage = new Map<string, string>(); let sequence = 0; let fail = true;
  const requests: Array<{ goal: string; requestKey: string }> = [];
  function page(projectId: string, initialGoal: string) {
    const html = renderAgentCyclePage({ project: { id: projectId, name: "测试" }, projects: [], cycles: [], skills: [] });
    const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)][0]![1]!;
    const goal = { value: initialGoal }; let submit: (() => Promise<void>) | undefined;
    const form = { addEventListener(_name: string, handler: (event: { preventDefault(): void }) => Promise<void>) { submit = () => handler({ preventDefault() {} }); } };
    const error = { textContent: "" };
    vm.runInNewContext(script, { document: { querySelector(selector: string) { return selector === "#goal-form" ? form : selector === "#goal" ? goal : error; }, addEventListener() {} },
      crypto: { randomUUID() { return "request-" + ++sequence; } }, sessionStorage: { getItem(key: string) { return storage.get(key) ?? null; }, setItem(key: string, value: string) { storage.set(key, value); } },
      fetch: async (_url: string, options: { body: string }) => { requests.push(JSON.parse(options.body)); if (fail) throw new Error("network response lost"); return { ok: true, async json() { return { result: { id: "same-cycle" } }; } }; },
      location: { reload() {} }, setInterval() {}, confirm() { return true; }, encodeURIComponent });
    return { goal, async submit() { assert.ok(submit); await submit(); } };
  }
  const first = page("p", "  同一个业务目标  "); await first.submit(); fail = false; await first.submit();
  assert.equal(requests[0]!.requestKey, requests[1]!.requestKey); assert.equal(requests[0]!.goal, "同一个业务目标");
  first.goal.value = "已经变更的业务目标"; await first.submit(); assert.notEqual(requests[2]!.requestKey, requests[1]!.requestKey);
  await page("p", "已经变更的业务目标").submit(); assert.equal(requests[3]!.requestKey, requests[2]!.requestKey);
  await page("another", "已经变更的业务目标").submit(); assert.notEqual(requests[4]!.requestKey, requests[3]!.requestKey);
});
