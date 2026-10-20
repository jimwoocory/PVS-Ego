import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../src/application/ports/artifact-repository.js";
import type { ArtifactRecord } from "../src/domain/schemas.js";
import {
  ArtifactStoreInjectedCrash,
  LocalArtifactStore
} from "../src/adapters/store/local-artifact-store.js";
import { sha256Bytes } from "../src/domain/hashing.js";

class MemoryArtifactRepository implements ArtifactRepository {
  readonly data = new Map<string, ArtifactRecord>();

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      relativePath: input.relativePath,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      integrityStatus: "PENDING",
      immutable: true,
      createdAt: "2026-09-27T05:00:00.000Z"
    };
    this.data.set(record.id, record);
    return record;
  }

  async markReady(
    id: string,
    fields: { sha256: string; sizeBytes: number; mimeType?: string }
  ): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...current,
      sha256: fields.sha256,
      sizeBytes: fields.sizeBytes,
      ...(fields.mimeType ? { mimeType: fields.mimeType } : {}),
      integrityStatus: "READY"
    };
    this.data.set(id, next);
    return next;
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...current,
      integrityStatus: "MISSING"
    };
    this.data.set(id, next);
    return next;
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const current = this.data.get(id);
    if (!current) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...current,
      integrityStatus: "CORRUPT"
    };
    this.data.set(id, next);
    return next;
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    return this.data.get(id) ?? null;
  }

  async listByProject(
    projectId: string,
    kind?: ArtifactRecord["kind"]
  ): Promise<ArtifactRecord[]> {
    return [...this.data.values()].filter(
      (item) => item.projectId === projectId && (!kind || item.kind === kind)
    );
  }

  async listPending(): Promise<ArtifactRecord[]> {
    return [...this.data.values()].filter(
      (item) => item.integrityStatus === "PENDING"
    );
  }
}

test("ArtifactStore atomically publishes and marks READY with hash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-artifacts-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo);
  const bytes = Buffer.from("hello artifact", "utf8");

  try {
    const record = await store.writeImmutable({
      id: "artifact-1",
      projectId: "project-1",
      kind: "STRUCTURED_SNAPSHOT",
      relativePath: "snapshots/one.json",
      immutable: true,
      bytes,
      mimeType: "application/json"
    });

    assert.equal(record.integrityStatus, "READY");
    assert.equal(record.sha256, sha256Bytes(bytes));
    assert.equal(
      await fs.readFile(path.join(root, "snapshots", "one.json"), "utf8"),
      "hello artifact"
    );
    const entries = await fs.readdir(path.join(root, "snapshots"));
    assert.equal(entries.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore refuses an existing immutable target before creating PENDING record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-immutable-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo);
  const target = path.join(root, "snapshots", "one.json");

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "existing", "utf8");

    await assert.rejects(
      store.writeImmutable({
        id: "artifact-conflict",
        projectId: "project-1",
        kind: "STRUCTURED_SNAPSHOT",
        relativePath: "snapshots/one.json",
        immutable: true,
        bytes: Buffer.from("new", "utf8")
      }),
      /Immutable artifact already exists/
    );
    assert.equal(repo.data.size, 0);
    assert.equal(await fs.readFile(target, "utf8"), "existing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore rejects path traversal outside project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-containment-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo);
  try {
    await assert.rejects(
      store.writeImmutable({
        id: "artifact-escape",
        projectId: "project-1",
        kind: "OTHER",
        relativePath: "../escape.bin",
        immutable: true,
        bytes: Buffer.from("escape", "utf8")
      }),
      /escapes project root/
    );
    assert.equal(repo.data.size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore reconciliation marks missing pending artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-reconcile-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo);
  try {
    await repo.createPending({
      id: "artifact-missing",
      projectId: "project-1",
      kind: "OTHER",
      relativePath: "missing/file.bin",
      immutable: true
    });
    const result = await store.reconcilePending();
    assert.deepEqual(result, {
      ready: [],
      missing: ["artifact-missing"]
    });
    assert.equal(
      (await repo.findById("artifact-missing"))?.integrityStatus,
      "MISSING"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore recovers crash after temporary file write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-crash-temp-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo, (point) => {
    if (point === "AFTER_TEMP_WRITE") {
      throw new ArtifactStoreInjectedCrash(point);
    }
  });
  try {
    await assert.rejects(
      store.writeImmutable({
        id: "artifact-crash-temp",
        projectId: "project-1",
        kind: "OTHER",
        relativePath: "crash/temp.bin",
        immutable: true,
        bytes: Buffer.from("temp-crash", "utf8")
      }),
      ArtifactStoreInjectedCrash
    );
    assert.equal(
      (await repo.findById("artifact-crash-temp"))?.integrityStatus,
      "PENDING"
    );

    const restarted = new LocalArtifactStore(root, repo);
    const result = await restarted.reconcileProject("project-1");
    assert.ok(result.missing.includes("artifact-crash-temp"));
    assert.ok(result.tempRemoved.some((item) => item.includes(".tmp")));
    assert.equal(
      (await repo.findById("artifact-crash-temp"))?.integrityStatus,
      "MISSING"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore recovers crash after target publication but before DB READY", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-crash-publish-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo, (point) => {
    if (point === "AFTER_PUBLISH") {
      throw new ArtifactStoreInjectedCrash(point);
    }
  });
  const bytes = Buffer.from("published-before-ready", "utf8");
  try {
    await assert.rejects(
      store.writeImmutable({
        id: "artifact-crash-publish",
        projectId: "project-1",
        kind: "OTHER",
        relativePath: "crash/published.bin",
        immutable: true,
        bytes
      }),
      ArtifactStoreInjectedCrash
    );
    assert.equal(
      (await repo.findById("artifact-crash-publish"))?.integrityStatus,
      "PENDING"
    );
    assert.equal(
      await fs.readFile(path.join(root, "crash", "published.bin"), "utf8"),
      "published-before-ready"
    );

    const restarted = new LocalArtifactStore(root, repo);
    const result = await restarted.reconcileProject("project-1");
    assert.ok(result.ready.includes("artifact-crash-publish"));
    const recovered = await repo.findById("artifact-crash-publish");
    assert.equal(recovered?.integrityStatus, "READY");
    assert.equal(recovered?.sha256, sha256Bytes(bytes));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore remains READY after crash immediately after DB READY", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-crash-ready-"));
  const repo = new MemoryArtifactRepository();
  const store = new LocalArtifactStore(root, repo, (point) => {
    if (point === "AFTER_DB_READY") {
      throw new ArtifactStoreInjectedCrash(point);
    }
  });
  const bytes = Buffer.from("ready-before-crash", "utf8");
  try {
    await assert.rejects(
      store.writeImmutable({
        id: "artifact-crash-ready",
        projectId: "project-1",
        kind: "OTHER",
        relativePath: "crash/ready.bin",
        immutable: true,
        bytes
      }),
      ArtifactStoreInjectedCrash
    );
    const durable = await repo.findById("artifact-crash-ready");
    assert.equal(durable?.integrityStatus, "READY");
    assert.equal(durable?.sha256, sha256Bytes(bytes));

    const restarted = new LocalArtifactStore(root, repo);
    const result = await restarted.reconcileProject("project-1");
    assert.equal(result.missing.length, 0);
    assert.equal(result.corrupt.length, 0);
    assert.equal(
      (await repo.findById("artifact-crash-ready"))?.integrityStatus,
      "READY"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
