import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DreaminaAgentCapabilityService,
  resolveDreaminaSkillPath
} from "../src/application/services/dreamina-agent-capability.js";
import type { DomesticJimengCliProvider } from "../src/adapters/video/domestic-jimeng-cli-provider.js";

const markers = [
  "dreamina-cli", "Choosing the right command", "dreamina <subcommand> -h",
  "Warn the user before running commands that may consume credits."
];

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-skill-discovery-"));
  const official = path.join(home, ".dreamina_cli", "dreamina", "SKILL.md");
  const legacy = path.join(home, ".agentdock", "tmp", "dreamina-official", "SKILL.md");
  const write = async (file: string, text = markers.join("\n")) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  };
  return { home, official, legacy, write, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}

test("official persistent Skill takes precedence over the legacy temporary copy", async () => {
  const f = await fixture();
  try {
    await f.write(f.official); await f.write(f.legacy);
    assert.equal(await resolveDreaminaSkillPath({ env: {}, homeDir: f.home }), f.official);
  } finally { await f.cleanup(); }
});

test("legacy Skill remains compatible when the official path is absent", async () => {
  const f = await fixture();
  try {
    await f.write(f.legacy);
    assert.equal(await resolveDreaminaSkillPath({ env: {}, homeDir: f.home }), f.legacy);
  } finally { await f.cleanup(); }
});

test("explicit environment path remains authoritative even when missing", async () => {
  const f = await fixture();
  try {
    await f.write(f.official); await f.write(f.legacy);
    const explicit = path.join(f.home, "configured", "SKILL.md");
    assert.equal(await resolveDreaminaSkillPath({ env: { DREAMINA_SKILL_PATH: explicit }, homeDir: f.home }), explicit);
  } finally { await f.cleanup(); }
});

test("constructor path overrides the environment and empty environment uses discovery", async () => {
  const f = await fixture();
  try {
    await f.write(f.official);
    assert.equal(await resolveDreaminaSkillPath({ explicitPath: f.legacy, env: { DREAMINA_SKILL_PATH: f.official }, homeDir: f.home }), f.legacy);
    assert.equal(await resolveDreaminaSkillPath({ env: { DREAMINA_SKILL_PATH: "  " }, homeDir: f.home }), f.official);
  } finally { await f.cleanup(); }
});

test("missing default files retain the official path for the existing missing-Skill guard", async () => {
  const f = await fixture();
  try {
    assert.equal(await resolveDreaminaSkillPath({ env: {}, homeDir: f.home }), f.official);
  } finally { await f.cleanup(); }
});

test("both capability entrypoints reject every missing review marker before inspecting the CLI", async () => {
  const f = await fixture();
  let cliCalls = 0;
  const provider = {
    inspectCommandHelp: async () => { cliCalls++; throw new Error("must not inspect an unreviewed Skill"); }
  } as unknown as DomesticJimengCliProvider;
  try {
    for (let missing = 0; missing < markers.length; missing++) {
      await f.write(f.official, markers.filter((_, index) => index !== missing).join("\n"));
      const service = new DreaminaAgentCapabilityService(provider, f.official);
      await assert.rejects(service.registry(), /Skill 内容与已审核能力说明不一致/);
      await assert.rejects(service.inspect("text2video", "seedance2.0"), /Skill 内容与已审核能力说明不一致/);
    }
    assert.equal(cliCalls, 0);
  } finally { await f.cleanup(); }
});
