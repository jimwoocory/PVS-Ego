import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FinalQcService } from "../src/application/services/final-qc-service.js";
import { sha256Bytes } from "../src/domain/hashing.js";
import type { ArtifactRecord, Project } from "../src/domain/schemas.js";
import type { ArtifactRepository, PendingArtifactInput } from "../src/application/ports/artifact-repository.js";
import type { FinalAssembly } from "../src/application/ports/final-output-repository.js";

const execute = promisify(execFile);
const ISO = "2026-10-05T00:00:00.000Z";

class MemoryArtifactRepository implements ArtifactRepository {
  private readonly records = new Map<string, ArtifactRecord>();

  constructor(initial: ArtifactRecord[] = []) {
    for (const item of initial) this.records.set(item.id, item);
  }

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    if (this.records.has(input.id)) throw new Error("duplicate artifact");
    const record: ArtifactRecord = {
      ...input,
      integrityStatus: "PENDING",
      createdAt: new Date().toISOString()
    };
    this.records.set(record.id, record);
    return record;
  }

  async markReady(id: string, fields: { sha256: string; sizeBytes: number; mimeType?: string }): Promise<ArtifactRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("missing artifact");
    const updated: ArtifactRecord = {
      ...current,
      ...fields,
      integrityStatus: "READY"
    };
    this.records.set(id, updated);
    return updated;
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("missing artifact");
    const updated = { ...current, integrityStatus: "MISSING" as const };
    this.records.set(id, updated);
    return updated;
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("missing artifact");
    const updated = { ...current, integrityStatus: "CORRUPT" as const };
    this.records.set(id, updated);
    return updated;
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByProject(projectId: string, kind?: ArtifactRecord["kind"]): Promise<ArtifactRecord[]> {
    return [...this.records.values()].filter(
      (item) => item.projectId === projectId && (!kind || item.kind === kind)
    );
  }

  async listPending(): Promise<ArtifactRecord[]> {
    return [...this.records.values()].filter((item) => item.integrityStatus === "PENDING");
  }
}

async function makeVideo(file: string, withAudio: boolean) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=720x1280:rate=30:duration=3"
  ];
  if (withAudio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-shortest"
    );
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p"
  );
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-y", file);
  await execute(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
    timeout: 120000,
    windowsHide: true
  });
}

function project(id: string, targetDurationMs = 3000): Project {
  return {
    id,
    name: "QC fixture",
    status: "FINAL_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs,
    aspectRatio: "9:16",
    createdAt: ISO,
    updatedAt: ISO
  };
}

async function fixture(input: { withAudio: boolean; targetDurationMs?: number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-final-qc-"));
  const projectId = "qc-project";
  const projectRoot = path.join(root, projectId);
  const relativePath = "final/final.mp4";
  const file = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await makeVideo(file, input.withAudio);
  const bytes = await fs.readFile(file);
  const hash = sha256Bytes(bytes);

  const finalArtifact: ArtifactRecord = {
    id: "final-artifact",
    projectId,
    kind: "FINAL_VIDEO",
    relativePath,
    sha256: hash,
    sizeBytes: bytes.byteLength,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: ISO
  };
  const artifacts = new MemoryArtifactRepository([finalArtifact]);
  const assembly: FinalAssembly = {
    id: "assembly-1",
    projectId,
    productionPlanHash: "a".repeat(64),
    selectedClipIds: ["agent-direct"],
    inputArtifactIds: ["source-1"],
    inputArtifactHashes: ["b".repeat(64)],
    outputArtifactId: finalArtifact.id,
    outputArtifactHash: hash,
    renderConfig: {
      width: 720,
      height: 1280,
      fps: 30,
      videoCodec: "libx264",
      audioCodec: "aac",
      format: "mp4"
    },
    status: "READY",
    createdAt: ISO
  };

  const service = new FinalQcService(
    {
      getWorkspace: async () => ({
        project: project(projectId, input.targetDurationMs ?? 3000)
      })
    } as never,
    artifacts,
    {
      latestAssembly: async () => assembly
    } as never,
    {
      latestTimeline: async () => null
    } as never,
    {
      listDecisions: async () => []
    } as never,
    root
  );

  return { root, service, artifacts, assembly };
}

test("Final QC accepts playable media with audio but warns when visual/text evidence is unavailable", { timeout: 120000 }, async () => {
  const f = await fixture({ withAudio: true });
  try {
    const report = await f.service.run("qc-project");
    assert.equal(report.overall, "WARN");
    assert.equal(report.artifactId, "final-artifact");
    assert.ok(report.checks.some((item) => item.code === "FILE_PLAYABLE" && item.severity === "PASS"));
    assert.ok(report.checks.some((item) => item.code === "AUDIO_STREAM" && item.severity === "PASS"));
    assert.ok(report.checks.some((item) => item.code === "VISUAL_PRODUCT_IDENTITY" && item.severity === "WARN"));
    assert.ok(report.checks.every((item) => item.severity !== "BLOCK"));

    const latest = await f.service.latest("qc-project");
    assert.equal(latest?.id, report.id);
    assert.equal(latest?.artifactHash, report.artifactHash);

    const qcArtifacts = await f.artifacts.listByProject("qc-project", "OTHER");
    assert.equal(qcArtifacts.length, 1);
    assert.match(qcArtifacts[0]!.relativePath, /^final-qc\//);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("Final QC blocks a final video without an audio track", { timeout: 120000 }, async () => {
  const f = await fixture({ withAudio: false });
  try {
    const report = await f.service.run("qc-project");
    assert.equal(report.overall, "BLOCK");
    const audio = report.checks.find((item) => item.code === "AUDIO_STREAM");
    assert.equal(audio?.severity, "BLOCK");
    await assert.rejects(
      () => f.service.assertPublishable("qc-project"),
      /最终成片未通过发布前质检/
    );
    const qcArtifacts = await f.artifacts.listByProject("qc-project", "OTHER");
    assert.equal(qcArtifacts.length, 2);
    assert.notEqual(qcArtifacts[0]?.id, qcArtifacts[1]?.id);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("Final QC blocks severe duration mismatch", { timeout: 120000 }, async () => {
  const f = await fixture({ withAudio: true, targetDurationMs: 10000 });
  try {
    const report = await f.service.run("qc-project");
    const duration = report.checks.find((item) => item.code === "DURATION");
    assert.equal(duration?.severity, "BLOCK");
    assert.equal(report.overall, "BLOCK");
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
