import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentCycleService } from "../src/application/services/agent-cycle-service.js";
import { PvsAgentSkills, pvsSkills } from "../src/application/services/pvs-agent-skills.js";
import type { AgentCycleRepository } from "../src/application/ports/agent-cycle-repository.js";
import type { AgentCapability, AgentCapabilityCatalog, AgentCapabilityContext } from "../src/application/ports/agent-capability.js";
import type { StructuredAiRequest, StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import { businessStages, type AgentCycle, type BusinessStage, type CapabilityResult, type CycleEvidence } from "../src/domain/agent-cycle.js";

const copy = <T>(value: T): T => structuredClone(value);

/** Copies at every boundary prevent tests from accidentally persisting mutations by reference. */
class MemoryCycles implements AgentCycleRepository {
  readonly rows = new Map<string, AgentCycle>();
  readonly leases = new Map<string, string>();
  readonly recoveries: Array<{ projectId: string; id: string }> = [];
  async create(cycle: AgentCycle) {
    const prior = [...this.rows.values()].find(row => row.projectId === cycle.projectId && row.input.requestKey === cycle.input.requestKey);
    if (prior) {
      if (prior.inputHash !== cycle.inputHash) throw new Error("request key input changed");
      return copy(prior);
    }
    this.rows.set(cycle.id, copy(cycle)); return copy(cycle);
  }
  async get(projectId: string, id: string) { const row = this.rows.get(id); return row?.projectId === projectId ? copy(row) : null; }
  async list(projectId?: string) { return [...this.rows.values()].filter(row => !projectId || row.projectId === projectId).map(copy); }
  async claim(projectId: string, id: string, owner: string) {
    if (this.rows.get(id)?.projectId !== projectId || this.leases.has(id)) return false;
    this.leases.set(id, owner); return true;
  }
  async save(cycle: AgentCycle, expectedRevision: number, owner: string) {
    const old = this.rows.get(cycle.id);
    if (!old || old.projectId !== cycle.projectId || old.revision !== expectedRevision || this.leases.get(cycle.id) !== owner) throw new Error("stale or unowned save");
    this.rows.set(cycle.id, copy(cycle)); return copy(cycle);
  }
  async release(id: string, owner: string) { if (this.leases.get(id) === owner) this.leases.delete(id); }
  async recoverAbandoned(projectId: string, id: string) { this.recoveries.push({ projectId, id }); return false; }
  crash(cycle: AgentCycle) { this.rows.set(cycle.id, copy(cycle)); this.leases.delete(cycle.id); }
}

type DecisionView = {
  goal: string; stages: BusinessStage[];
  loadedSkills: Array<{ id: string; text: string }>;
  actions: Array<{ capabilityId: string; input: Record<string, unknown>; status: string; result?: { status?: CapabilityResult["status"]; data?: string; summary: string } }>;
  evidence: CycleEvidence[];
  messages?: Array<{ role: string; text: string }>;
};
type Decision = (view: DecisionView, request: StructuredAiRequest) => unknown;

class DecisionRuntime implements StructuredAiRuntime {
  readonly id = "agent-test-decision-runtime"; readonly version = "1";
  readonly calls: StructuredAiRequest[] = [];
  constructor(private readonly decide: Decision) {}
  async generateJson(request: StructuredAiRequest) { this.calls.push(copy(request)); return this.decide(request.input as DecisionView, request); }
}

const stageSpecs: Array<{ stage: BusinessStage; skill: string; capability: string; effect: AgentCapability["effect"]; field: string }> = [
  { stage: "RESEARCH", skill: "pvs-market-research", capability: "research.discover", effect: "READ", field: "query" },
  { stage: "STRATEGY", skill: "pvs-content-strategy", capability: "strategy.create", effect: "MODEL", field: "researchId" },
  { stage: "PRODUCTION", skill: "pvs-video-production", capability: "production.submit", effect: "PAID_GENERATION", field: "strategyId" },
  { stage: "PUBLICATION", skill: "pvs-publication", capability: "publication.publish", effect: "EXTERNAL_WRITE", field: "assemblyId" },
  { stage: "OPERATIONS", skill: "pvs-post-publish-operations", capability: "operations.capture", effect: "READ", field: "awemeId" },
  { stage: "FEEDBACK", skill: "pvs-performance-feedback", capability: "feedback.adopt", effect: "HUMAN_DECISION", field: "insightId" }
];

class TestCatalog implements AgentCapabilityCatalog {
  readonly executed: Array<{ id: string; context: AgentCapabilityContext; input: Record<string, unknown> }> = [];
  readonly fingerprints = new Map([["project-a", "snapshot-a-1"], ["project-b", "snapshot-b-1"]]);
  readonly overrides = new Map<string, () => Promise<CapabilityResult>>();
  readonly completionCalls: Array<{ projectId: string; stages: BusinessStage[]; evidence: CycleEvidence[] }> = [];
  readonly capabilities: AgentCapability[] = stageSpecs.map(spec => ({
    id: spec.capability, stage: spec.stage, title: spec.stage + "测试能力", description: "Controlled business boundary", effect: spec.effect,
    inputSchema: z.object({ [spec.field]: z.string().min(1) }).strict(),
    run: async (context, input) => {
      this.executed.push({ id: spec.capability, context: copy(context), input: copy(input) });
      const override = this.overrides.get(spec.capability);
      if (override) return override();
      const resultId = spec.stage.toLowerCase() + "-result";
      return { status: "COMPLETE", summary: spec.stage + "真实边界已被调用",
        data: { id: resultId, source: input[spec.field] }, evidence: [{ stage: spec.stage, kind: "TEST_STAGE_RECEIPT", id: resultId }] };
    },
    preview: async (_projectId, input) => spec.stage + "：" + String(input[spec.field])
  }));
  list() { return this.capabilities; }
  get(id: string) { const found = this.capabilities.find(capability => capability.id === id); if (!found) throw new Error("unknown capability"); return found; }
  async snapshot(projectId: string) { if (!this.fingerprints.has(projectId)) throw new Error("unknown project"); return { projectId, current: this.fingerprints.get(projectId) }; }
  async fingerprint(projectId: string) { await this.snapshot(projectId); return this.fingerprints.get(projectId)!; }
  async validateCompletion(projectId: string, stages: BusinessStage[], evidence: CycleEvidence[]) {
    this.completionCalls.push(copy({ projectId, stages, evidence }));
    return stages.filter(stage => !evidence.some(item => item.stage === stage && item.kind === "TEST_STAGE_RECEIPT" && item.id === stage.toLowerCase() + "-result"));
  }
}

async function harness(decide: Decision = () => ({ action: "ASK_USER", question: "请补充下一步目标" })) {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-agent-skills-test-"));
  for (const skill of pvsSkills) {
    const directory = path.join(skillRoot, skill.id); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "# " + skill.title + "\nOnly execute registered " + skill.stage + " capabilities.\n");
  }
  const repository = new MemoryCycles(), catalog = new TestCatalog(), runtime = new DecisionRuntime(decide), skills = new PvsAgentSkills(skillRoot);
  const service = new AgentCycleService(repository, catalog, runtime, skills);
  return { repository, catalog, runtime, skills, skillRoot, service, cleanup: () => fs.rm(skillRoot, { recursive: true, force: true }) };
}

function loadOrCall(view: DecisionView, stage: BusinessStage, input: Record<string, unknown>) {
  const spec = stageSpecs.find(spec => spec.stage === stage)!;
  if (!view.loadedSkills.some(skill => skill.id === spec.skill)) return { action: "LOAD_SKILL", skillId: spec.skill, reason: "依据目标加载对应业务技能" };
  return { action: "CALL_CAPABILITY", capabilityId: spec.capability, input, reason: "根据当前真实上下文执行下一步" };
}

async function settle(service: AgentCycleService, cycle: AgentCycle, max = 60) {
  for (let step = 0; step < max && !["COMPLETED", "BLOCKED", "WAITING_USER", "OUTCOME_UNKNOWN"].includes(cycle.status); step++) {
    if (cycle.status === "WAITING_CONFIRMATION") {
      const action = cycle.actions.find(action => action.status === "PROPOSED")!;
      cycle = await service.confirm(cycle.projectId, cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash });
    } else cycle = await service.advance(cycle.projectId, cycle.id);
  }
  return cycle;
}

test("different user goals select different Skills and execute different capabilities through multiple decisions", async () => {
  const h = await harness(view => {
    const stage = view.goal.includes("行业研究") ? "RESEARCH" : "OPERATIONS";
    const evidence = view.evidence.find(item => item.stage === stage);
    if (evidence) {
      const completed = view.actions.find(action => action.status === "SUCCEEDED");
      assert.ok(completed?.result?.data?.includes(stage.toLowerCase() + "-result"), "the planner must observe the actual capability result before finishing");
      return { action: "FINISH", summary: "已取得目标所需真实结果" };
    }
    return stage === "RESEARCH" ? loadOrCall(view, stage, { query: "护颈枕行业" }) : loadOrCall(view, stage, { awemeId: "published-work-17" });
  });
  try {
    const research = await settle(h.service, await h.service.create("project-a", { requestKey: "research", goal: "只做行业研究并分析", stages: ["RESEARCH"] }));
    const operations = await settle(h.service, await h.service.create("project-a", { requestKey: "ops", goal: "只采集已发布作品的运营表现", stages: ["OPERATIONS"] }));
    assert.equal(research.status, "COMPLETED"); assert.equal(operations.status, "COMPLETED");
    assert.deepEqual(research.loadedSkills.map(skill => skill.id), ["pvs-market-research"]);
    assert.deepEqual(operations.loadedSkills.map(skill => skill.id), ["pvs-post-publish-operations"]);
    assert.deepEqual(h.catalog.executed.map(call => call.id), ["research.discover", "operations.capture"]);
    assert.equal(h.runtime.calls.length, 6, "load, decide a real call, observe and finish for each goal");
  } finally { await h.cleanup(); }
});

test("default full cycle cannot finish with an empty or production-only evidence set", async () => {
  const h = await harness(() => ({ action: "FINISH", summary: "已经导出MP4，尝试结束" }));
  try {
    let cycle = await h.service.create("project-a", { requestKey: "no-shortcut", goal: "完成行业研究到运营反馈的完整业务" });
    assert.deepEqual(cycle.input.stages, [...businessStages]);
    cycle = await h.service.advance(cycle.projectId, cycle.id);
    assert.equal(cycle.status, "READY");
    assert.deepEqual(h.catalog.completionCalls[0]?.stages, [...businessStages]);
    cycle.evidence = [{ stage: "PRODUCTION", kind: "TEST_STAGE_RECEIPT", id: "production-result" }];
    h.repository.crash(cycle);
    cycle = await h.service.advance(cycle.projectId, cycle.id);
    assert.equal(cycle.status, "READY");
    assert.match(cycle.messages.at(-1)!.text, /RESEARCH/); assert.match(cycle.messages.at(-1)!.text, /FEEDBACK/);
    assert.equal(h.catalog.executed.length, 0);
  } finally { await h.cleanup(); }
});

test("the next decision observes a failed capability and changes its actual input before retrying", async () => {
  const h = await harness(view => {
    if (view.evidence.some(item => item.stage === "RESEARCH")) return { action: "FINISH", summary: "新来源分析成功并已取得研究回执" };
    const failed = view.actions.some(action => action.capabilityId === "research.discover" && action.status === "FAILED");
    return loadOrCall(view, "RESEARCH", { query: failed ? "verified-new-source" : "unavailable-source" });
  });
  h.catalog.overrides.set("research.discover", async () => {
    const query = h.catalog.executed.at(-1)!.input.query;
    if (query === "unavailable-source") throw new Error("source unavailable");
    return { status: "COMPLETE", summary: "已从新来源取得研究资料", data: { id: "research-result" }, evidence: [{ stage: "RESEARCH", kind: "TEST_STAGE_RECEIPT", id: "research-result" }] };
  });
  try {
    const cycle = await settle(h.service, await h.service.create("project-a", { requestKey: "replan", goal: "研究指定行业，来源失败时据实调整", stages: ["RESEARCH"] }));
    assert.equal(cycle.status, "COMPLETED");
    assert.deepEqual(h.catalog.executed.map(call => call.input.query), ["unavailable-source", "verified-new-source"]);
    assert.deepEqual(cycle.actions.map(action => action.status), ["FAILED", "SUCCEEDED"]);
    assert.ok(h.runtime.calls.some(request => (request.input as DecisionView).actions.some(action => action.status === "FAILED")));
  } finally { await h.cleanup(); }
});

test("a full six-stage cycle forwards observed result IDs and requires scoped human confirmations", async () => {
  const h = await harness(view => {
    const index = businessStages.findIndex(stage => !view.evidence.some(item => item.stage === stage));
    if (index < 0) return { action: "FINISH", summary: "六个业务阶段均有真实回执，完成本轮闭环" };
    const spec = stageSpecs[index]!;
    const prior = index === 0 ? undefined : view.evidence.find(item => item.stage === businessStages[index - 1]);
    return loadOrCall(view, spec.stage, { [spec.field]: prior?.id ?? "行业搜索目标" });
  });
  try {
    const cycle = await settle(h.service, await h.service.create("project-a", { requestKey: "full-cycle", goal: "完成研究、策略、生产、发布、运营到下一轮反馈" }));
    assert.equal(cycle.status, "COMPLETED");
    assert.deepEqual(h.catalog.executed.map(call => call.id), stageSpecs.map(spec => spec.capability));
    assert.deepEqual(new Set(cycle.evidence.map(item => item.stage)), new Set(businessStages));
    for (let index = 1; index < stageSpecs.length; index++) {
      assert.equal(h.catalog.executed[index]!.input[stageSpecs[index]!.field], businessStages[index - 1]!.toLowerCase() + "-result");
    }
    for (const call of h.catalog.executed) {
      const effect = h.catalog.get(call.id).effect;
      assert.equal(call.context.confirmed, ["EXTERNAL_WRITE", "PAID_GENERATION", "HUMAN_DECISION"].includes(effect));
      assert.equal(call.context.projectId, "project-a"); assert.equal(call.context.cycleId, cycle.id);
    }
    assert.equal(cycle.loadedSkills.length, 6);
  } finally { await h.cleanup(); }
});

test("confirmation binds current revision, action input hash and project fingerprint", async () => {
  const h = await harness();
  try {
    let cycle = await h.service.create("project-a", { requestKey: "confirm", goal: "发布已确认的视频", stages: ["PUBLICATION"] });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "publication.publish", arguments: { assemblyId: "final-1" }, requestKey: "publish-1" });
    const action = cycle.actions[0]!;
    assert.equal(cycle.status, "WAITING_CONFIRMATION");
    await assert.rejects(h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision - 1, actionId: action.id, inputHash: action.inputHash }), /任务已经变化/);
    await assert.rejects(h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: "wrong" }), /待确认动作已失效/);
    await assert.rejects(h.service.confirm("project-b", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash }));
    h.catalog.fingerprints.set("project-a", "different-work-or-account");
    await assert.rejects(h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash }), /状态已变化/);
    assert.equal(h.catalog.executed.length, 0);
    h.catalog.fingerprints.set("project-a", action.contextHash);
    cycle = await h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash });
    h.catalog.fingerprints.set("project-a", "changed-after-confirmation");
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "BLOCKED"); assert.equal(h.catalog.executed.length, 0);
    assert.equal(cycle.actions[0]?.status, "FAILED");
  } finally { await h.cleanup(); }
});

test("model supplied confirmed flags cannot authorize a paid or external write capability", async () => {
  const h = await harness(view => loadOrCall(view, "PUBLICATION", { assemblyId: "final-1", confirmed: true }));
  try {
    let cycle = await h.service.create("project-a", { requestKey: "forged-model-consent", goal: "发布视频但没有用户确认", stages: ["PUBLICATION", "PRODUCTION"] });
    cycle = await h.service.advance("project-a", cycle.id);
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "BLOCKED");
    assert.equal(cycle.actions.length, 0); assert.equal(h.catalog.executed.length, 0);
    await assert.rejects(h.service.invoke("project-a", cycle.id, { capabilityId: "production.submit", arguments: { strategyId: "strategy-1", confirmed: true }, requestKey: "forged-mcp-consent" }));
    assert.equal(h.catalog.executed.length, 0);
  } finally { await h.cleanup(); }
});

test("MCP request key replay preserves the original receipt and never repeats execution", async () => {
  const h = await harness();
  try {
    let cycle = await h.service.create("project-a", { requestKey: "mcp-replay", goal: "分析指定行业", stages: ["RESEARCH"] });
    const input = { capabilityId: "research.discover", arguments: { query: "护颈枕" }, requestKey: "stable-call-1" };
    cycle = await h.service.invoke("project-a", cycle.id, input);
    const proposedRevision = cycle.revision;
    cycle = await h.service.invoke("project-a", cycle.id, input);
    assert.equal(cycle.revision, proposedRevision); assert.equal(cycle.actions.length, 1);
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(h.catalog.executed.length, 1);
    const completedRevision = cycle.revision, actionId = cycle.actions[0]!.id;
    cycle = await h.service.invoke("project-a", cycle.id, input);
    assert.equal(cycle.revision, completedRevision); assert.equal(cycle.actions[0]!.id, actionId);
    assert.equal(h.catalog.executed.length, 1);
    await assert.rejects(h.service.invoke("project-a", cycle.id, { ...input, arguments: { query: "其他商品" } }), /参数不同/);
  } finally { await h.cleanup(); }
});

test("an interrupted RUNNING action becomes unknown instead of being submitted again", async () => {
  const h = await harness();
  try {
    let cycle = await h.service.create("project-a", { requestKey: "crash", goal: "执行明确的视频生产任务", stages: ["PRODUCTION"] });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "production.submit", arguments: { strategyId: "strategy-1" }, requestKey: "start-production" });
    const action = cycle.actions[0]!;
    cycle = await h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash });
    cycle.status = "RUNNING"; cycle.actions[0]!.status = "RUNNING"; h.repository.crash(cycle);
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "OUTCOME_UNKNOWN"); assert.equal(cycle.actions[0]?.status, "OUTCOME_UNKNOWN");
    assert.equal(h.catalog.executed.length, 0); assert.equal(h.runtime.calls.length, 0);
    await h.service.advance("project-a", cycle.id);
    assert.equal(h.catalog.executed.length, 0);
  } finally { await h.cleanup(); }
});

test("user clarification cannot replay an unknown write under another request key", async () => {
  const h = await harness(view => loadOrCall(view, "PUBLICATION", { assemblyId: "final-1" }));
  h.catalog.overrides.set("publication.publish", async () => ({ status: "OUTCOME_UNKNOWN", summary: "平台已受理但尚无可信回执" }));
  try {
    let cycle = await h.service.create("project-a", { requestKey: "unknown-reply", goal: "发布已接受成片", stages: ["PUBLICATION"] });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "publication.publish", arguments: { assemblyId: "final-1" }, requestKey: "original-write" });
    const action = cycle.actions[0]!;
    cycle = await h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash });
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(h.catalog.executed.length, 1); assert.equal(cycle.status, "OUTCOME_UNKNOWN");
    cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "继续处理，先核对原结果" });
    await assert.rejects(h.service.invoke("project-a", cycle.id, { capabilityId: "publication.publish", arguments: { assemblyId: "final-1" }, requestKey: "new-key-same-write" }), /结果仍未知/);
    cycle = await h.service.advance("project-a", cycle.id); // load publication Skill
    cycle = await h.service.advance("project-a", cycle.id); // planner attempts the same signature
    assert.equal(cycle.status, "BLOCKED"); assert.equal(cycle.actions.length, 1);
    assert.equal(h.catalog.executed.length, 1); assert.match(cycle.messages.at(-1)!.text, /结果仍未知/);
  } finally { await h.cleanup(); }
});

test("planning and tool-call budgets stop a decision loop while retaining its evidence", async () => {
  const h = await harness(() => ({ action: "ASK_USER", question: "补充输入后继续" }));
  try {
    let cycle = await h.service.create("project-a", { requestKey: "step-limit", goal: "有限规划任务", stages: ["RESEARCH"], maxSteps: 1 });
    cycle = await h.service.advance("project-a", cycle.id);
    cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "已补充关键词" });
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "BLOCKED"); assert.equal(h.runtime.calls.length, 1); assert.equal(cycle.steps, 1);
    let limited = await h.service.create("project-a", { requestKey: "call-limit", goal: "有限工具任务", stages: ["RESEARCH"], maxToolCalls: 1 });
    limited = await h.service.invoke("project-a", limited.id, { capabilityId: "research.discover", arguments: { query: "first" }, requestKey: "one" });
    limited = await h.service.advance("project-a", limited.id);
    await assert.rejects(h.service.invoke("project-a", limited.id, { capabilityId: "research.discover", arguments: { query: "second" }, requestKey: "two" }), /工具调用上限/);
    const saved = await h.service.get("project-a", limited.id);
    assert.equal(saved?.actions.length, 1); assert.equal(saved?.evidence.length, 1); assert.equal(h.catalog.executed.length, 1);
  } finally { await h.cleanup(); }
});

test("resuming one existing task never recovers or advances another project or task", async () => {
  const h = await harness(() => ({ action: "ASK_USER", question: "核对本任务状态" }));
  try {
    const first = await h.service.create("project-a", { requestKey: "old-one", goal: "恢复这个已有任务", stages: ["RESEARCH"] });
    const other = await h.service.create("project-b", { requestKey: "other-one", goal: "另一个项目已有任务", stages: ["OPERATIONS"] });
    h.repository.recoveries.length = 0;
    await h.service.advance("project-a", first.id);
    assert.deepEqual(h.repository.recoveries, [{ projectId: "project-a", id: first.id }]);
    assert.deepEqual(await h.service.get("project-b", other.id), other);
    assert.equal(h.catalog.executed.length, 0);
    assert.equal((await h.service.list()).length, 2, "resume must not silently create replacement tasks");
  } finally { await h.cleanup(); }
});

test("a BLOCKED business result is retained as a blocked task and can be explicitly resumed after clarification", async () => {
  const h = await harness();
  let blocked = true;
  h.catalog.overrides.set("operations.capture", async () => blocked
    ? { status: "BLOCKED", summary: "尚未确认目标作品绑定" }
    : { status: "COMPLETE", summary: "绑定已确认，采集完成", evidence: [{ stage: "OPERATIONS", kind: "TEST_STAGE_RECEIPT", id: "operations-result" }] });
  try {
    let cycle = await h.service.create("project-a", { requestKey: "business-block", goal: "采集作品运营数据", stages: ["OPERATIONS"] });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "operations.capture", arguments: { awemeId: "work-1" }, requestKey: "before-binding" });
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "BLOCKED"); assert.equal(cycle.actions[0]?.status, "FAILED"); assert.equal(cycle.evidence.length, 0);
    blocked = false;
    cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "已确认目标账号和作品绑定，继续原任务" });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "operations.capture", arguments: { awemeId: "work-1" }, requestKey: "after-binding" });
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "READY"); assert.equal(cycle.actions[1]?.status, "SUCCEEDED"); assert.equal(cycle.evidence.length, 1);
    assert.equal(h.catalog.executed.length, 2); assert.equal((await h.service.list()).length, 1);
  } finally { await h.cleanup(); }
});

test("user clarification invalidates a proposed old action and its prior confirmation revision", async () => {
  const h = await harness();
  try {
    let cycle = await h.service.create("project-a", { requestKey: "clarification", goal: "确认发布前先补充", stages: ["PUBLICATION"] });
    cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: "publication.publish", arguments: { assemblyId: "old-final" }, requestKey: "old-action" });
    const before = copy(cycle), action = before.actions[0]!;
    cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "改用新版成片，先不要发布旧版" });
    assert.equal(cycle.actions[0]?.status, "FAILED");
    await assert.rejects(h.service.confirm("project-a", cycle.id, { expectedRevision: before.revision, actionId: action.id, inputHash: action.inputHash }), /任务已经变化/);
    assert.equal(h.catalog.executed.length, 0);
  } finally { await h.cleanup(); }
});

test("unregistered and traversal Skill names never read files outside the registered Skill root", async () => {
  const h = await harness();
  try {
    for (const name of ["../private", "../../SKILL.md", "pvs-market-research/../../private", "C:\\private", "/tmp/private", "pvs-market-research%2f..%2fprivate"]) {
      await assert.rejects(h.skills.load(name), /未注册的 PVS Skill/);
    }
    const loaded = await h.skills.load("pvs-market-research");
    assert.match(loaded.text, /RESEARCH/); assert.match(loaded.digest, /^[a-f0-9]{64}$/);
    assert.equal(h.catalog.executed.length, 0);
  } finally { await h.cleanup(); }
});

test("resume retries the same accepted run after clarification while task-creation capabilities reuse their original tasks", async () => {
  for (const initialStatus of ["WAITING_USER", "RUNNING"] as const) {
    const clarification = "已经处理阻断，请继续原研究任务";
    const h = await harness(view => {
      if (!view.loadedSkills.some(skill => skill.id === "pvs-market-research")) return { action: "LOAD_SKILL", skillId: "pvs-market-research", reason: "续接原研究" };
      const previous = view.actions.at(-1);
      if (previous?.result?.status === "COMPLETE") return { action: "FINISH", summary: "原研究任务已恢复并取得真实证据" };
      if (previous?.result?.status === "RUNNING" && !view.messages?.some(message => message.text === clarification)) return { action: "ASK_USER", question: "原研究仍在运行，请补充确认后继续检查" };
      return { action: "CALL_CAPABILITY", capabilityId: "research.resume", input: { runId: "existing-run-17" }, reason: "继续同一个已存在任务，不重新创建研究" };
    });
    let attempts = 0;
    h.catalog.capabilities.push({ id: "research.resume", title: "续接研究", description: "Continue a controlled existing run", stage: "RESEARCH", effect: "MODEL",
      inputSchema: z.object({ runId: z.string() }).strict(),
      run: async (context, input) => {
        attempts++; h.catalog.executed.push({ id: "research.resume", context: copy(context), input: copy(input) });
        return attempts === 1 ? { status: initialStatus, summary: "原任务已保存", data: { runId: input.runId } }
          : { status: "COMPLETE", summary: "原任务已完成", data: { runId: input.runId }, evidence: [{ stage: "RESEARCH", kind: "TEST_STAGE_RECEIPT", id: "research-result" }] };
      } });
    try {
      let cycle = await h.service.create("project-a", { requestKey: "resume-" + initialStatus, goal: "续接已有行业研究", stages: ["RESEARCH"] });
      cycle = await h.service.advance("project-a", cycle.id); // load
      cycle = await h.service.advance("project-a", cycle.id); // decide
      cycle = await h.service.advance("project-a", cycle.id); // original response
      if (initialStatus === "RUNNING") {
        // Simulate the persisted wake time having elapsed, without a wall-clock sleep.
        cycle.nextWakeAt = new Date(0).toISOString(); h.repository.crash(cycle);
        cycle = await h.service.advance("project-a", cycle.id); // ask based on observed RUNNING receipt
      }
      assert.equal(cycle.status, "WAITING_USER");
      cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: clarification });
      cycle = await settle(h.service, cycle);
      assert.equal(cycle.status, "COMPLETED"); assert.equal(attempts, 2);
      assert.deepEqual(h.catalog.executed.map(call => call.input.runId), ["existing-run-17", "existing-run-17"]);
      assert.equal(cycle.actions.length, 2); assert.equal(h.catalog.executed.some(call => call.id === "research.start"), false);
    } finally { await h.cleanup(); }
  }

  for (const definition of [
    { id: "research.start", stage: "RESEARCH", skill: "pvs-market-research" },
    { id: "production.create", stage: "PRODUCTION", skill: "pvs-video-production" },
    { id: "publication.prepare", stage: "PUBLICATION", skill: "pvs-publication" },
    { id: "operations.schedule-create", stage: "OPERATIONS", skill: "pvs-post-publish-operations" }
  ] as const) {
    const h = await harness(view => !view.loadedSkills.some(skill => skill.id === definition.skill)
      ? { action: "LOAD_SKILL", skillId: definition.skill, reason: "装载创建任务技能" }
      : { action: "CALL_CAPABILITY", capabilityId: definition.id, input: { source: "fixed-source-1" }, reason: "检查已创建任务" });
    h.catalog.capabilities.push({ id: definition.id, title: "创建原任务", description: "Controlled create operation", stage: definition.stage, effect: "LOCAL",
      inputSchema: z.object({ source: z.string() }).strict(),
      run: async (context, input) => { h.catalog.executed.push({ id: definition.id, context: copy(context), input: copy(input) }); return { status: "WAITING_USER", summary: "任务已创建并等待业务确认", data: { taskId: "original-created-task" } }; } });
    try {
      let cycle = await settle(h.service, await h.service.create("project-a", { requestKey: definition.id, goal: "继续原有业务任务并保留任务编号", stages: [definition.stage] }));
      assert.equal(cycle.status, "WAITING_USER");
      cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "已补充信息，继续处理原任务" });
      cycle = await h.service.advance("project-a", cycle.id);
      assert.equal(cycle.status, "READY"); assert.equal(cycle.actions.length, 1); assert.equal(h.catalog.executed.length, 1);
      assert.match(cycle.messages.at(-1)!.text, /复用动作/);
    } finally { await h.cleanup(); }
  }
});

test("changing an already-loaded Skill digest blocks before another model decision or capability call", async () => {
  const h = await harness(view => loadOrCall(view, "RESEARCH", { query: "same-goal" }));
  try {
    let cycle = await h.service.create("project-a", { requestKey: "skill-digest", goal: "按已审核技能执行研究", stages: ["RESEARCH"] });
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.loadedSkills.length, 1); assert.equal(h.runtime.calls.length, 1);
    await fs.appendFile(path.join(h.skillRoot, "pvs-market-research", "SKILL.md"), "\nChanged instructions must not silently affect an existing task.\n");
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(cycle.status, "BLOCKED"); assert.match(cycle.messages.at(-1)!.text, /Skill内容发生变化/);
    assert.equal(h.runtime.calls.length, 1); assert.equal(h.catalog.executed.length, 0); assert.equal(cycle.actions.length, 0);
  } finally { await h.cleanup(); }
});

test("an interrupted READ can really reread with a new request key while paid and external actions remain fenced", async () => {
  for (const spec of stageSpecs.filter(spec => ["READ", "PAID_GENERATION", "EXTERNAL_WRITE"].includes(spec.effect))) {
    const h = await harness();
    try {
      let cycle = await h.service.create("project-a", { requestKey: "crashed-" + spec.capability, goal: "核对中断动作后继续原任务", stages: [spec.stage] });
      const input = { [spec.field]: "same-existing-source" };
      cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: spec.capability, arguments: input, requestKey: "before-crash" });
      if (cycle.status === "WAITING_CONFIRMATION") {
        const action = cycle.actions[0]!;
        cycle = await h.service.confirm("project-a", cycle.id, { expectedRevision: cycle.revision, actionId: action.id, inputHash: action.inputHash });
      }
      cycle.status = "RUNNING"; cycle.actions[0]!.status = "RUNNING"; h.repository.crash(cycle);
      cycle = await h.service.advance("project-a", cycle.id);
      assert.equal(h.catalog.executed.length, 0, "crash recovery itself must never submit any business action");
      if (spec.effect === "READ") {
        assert.equal(cycle.status, "READY"); assert.equal(cycle.actions[0]!.status, "FAILED");
        cycle = await h.service.invoke("project-a", cycle.id, { capabilityId: spec.capability, arguments: input, requestKey: "reread-after-crash" });
        cycle = await h.service.advance("project-a", cycle.id);
        assert.equal(cycle.actions.length, 2); assert.equal(cycle.actions[1]!.status, "SUCCEEDED");
        assert.equal(h.catalog.executed.length, 1); assert.deepEqual(h.catalog.executed[0]!.input, input);
        assert.notEqual(cycle.actions[0]!.requestKey, cycle.actions[1]!.requestKey);
      } else {
        assert.equal(cycle.status, "OUTCOME_UNKNOWN"); assert.equal(cycle.actions[0]!.status, "OUTCOME_UNKNOWN");
        cycle = await h.service.reply("project-a", cycle.id, { expectedRevision: cycle.revision, text: "重新检查原结果，不视为撤销未知回执" });
        await assert.rejects(h.service.invoke("project-a", cycle.id, { capabilityId: spec.capability, arguments: input, requestKey: "must-not-resubmit" }), /结果仍未知/);
        assert.equal(h.catalog.executed.length, 0); assert.equal((await h.service.get("project-a", cycle.id))!.actions.length, 1);
      }
    } finally { await h.cleanup(); }
  }
});

test("completed MODEL results reuse an unchanged observation but regenerate after context changes without changing old MCP receipts", async () => {
  const observedResults: string[] = [];
  const h = await harness(view => {
    const previous = view.actions.at(-1)?.result?.data;
    if (previous) observedResults.push(previous);
    return loadOrCall(view, "STRATEGY", { researchId: "existing-research" });
  });
  let generations = 0;
  h.catalog.overrides.set("strategy.create", async () => ({ status: "COMPLETE", summary: "已基于当前业务观测生成创意",
    data: { creativeVersion: ++generations }, evidence: [{ stage: "STRATEGY", kind: "TEST_STAGE_RECEIPT", id: "strategy-result" }] }));
  try {
    const originalRequest = { capabilityId: "strategy.create", arguments: { researchId: "existing-research" }, requestKey: "original-model-receipt" };
    let cycle = await h.service.create("project-a", { requestKey: "model-context-change", goal: "根据新运营反馈更新下一轮策略创意", stages: ["STRATEGY"] });
    cycle = await h.service.invoke("project-a", cycle.id, originalRequest);
    cycle = await h.service.advance("project-a", cycle.id);
    const originalAction = copy(cycle.actions[0]!);
    assert.match(originalAction.resultObservationHash ?? "", /^[a-f0-9]{64}$/);
    cycle = await h.service.advance("project-a", cycle.id); // decision loads the strategy Skill after observing result 1
    cycle = await h.service.advance("project-a", cycle.id); // identical parameters and snapshot reuse result 1
    assert.equal(generations, 1); assert.equal(cycle.actions.length, 1); assert.match(cycle.messages.at(-1)!.text, /复用动作/);

    h.catalog.fingerprints.set("project-a", "snapshot-a-new-feedback");
    cycle = await h.service.advance("project-a", cycle.id); // same intent, new project observation
    assert.equal(cycle.actions.length, 2); assert.equal(cycle.actions[1]!.status, "PROPOSED");
    assert.equal(cycle.actions[1]!.inputHash, originalAction.inputHash, "same parameters are intentionally reused under changed feedback");
    cycle = await h.service.advance("project-a", cycle.id);
    assert.equal(generations, 2); assert.equal(cycle.actions[1]!.status, "SUCCEEDED");
    assert.notEqual(cycle.actions[1]!.resultObservationHash, originalAction.resultObservationHash);
    assert.deepEqual(cycle.actions[0], originalAction, "regeneration preserves the old durable receipt");
    assert.deepEqual(cycle.actions[1]!.result?.data, { creativeVersion: 2 });
    assert.ok(observedResults.length >= 3 && observedResults.every(result => result.includes('"creativeVersion":1')), "successive planning rounds must observe the saved first result before deciding whether to regenerate");

    const beforeReplay = copy(cycle);
    cycle = await h.service.invoke("project-a", cycle.id, originalRequest);
    assert.deepEqual(cycle, beforeReplay); assert.equal(generations, 2);
    assert.deepEqual(cycle.actions.find(action => action.requestKey === originalRequest.requestKey)?.result, originalAction.result);
  } finally { await h.cleanup(); }
});
