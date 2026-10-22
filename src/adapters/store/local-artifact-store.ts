import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../../application/ports/artifact-repository.js";
import type { ArtifactRecord } from "../../domain/schemas.js";
import { sha256Bytes } from "../../domain/hashing.js";

function assertContained(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be relative");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error("Artifact path escapes project root");
  }
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export type ArtifactStoreFaultPoint =
  | "AFTER_PENDING"
  | "AFTER_TEMP_WRITE"
  | "AFTER_PUBLISH"
  | "AFTER_DB_READY";

export class ArtifactStoreInjectedCrash extends Error {
  constructor(public readonly point: ArtifactStoreFaultPoint) {
    super(`Injected ArtifactStore crash at ${point}`);
    this.name = "ArtifactStoreInjectedCrash";
  }
}

export class LocalArtifactStore {
  constructor(
    private readonly root: string,
    private readonly repository: ArtifactRepository,
    private readonly faultInjector?: (
      point: ArtifactStoreFaultPoint
    ) => void | Promise<void>
  ) {}

  private async inject(point: ArtifactStoreFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  async writeImmutable(
    input: PendingArtifactInput & { bytes: Uint8Array; mimeType?: string }
  ): Promise<ArtifactRecord> {
    return this.publishImmutable(input, false);
  }

  /** Publish bytes after a caller has atomically reserved this artifact ID.
   * Reservation is not recovery: existing targets are never replaced. */
  async writeReservedImmutable(
    input: PendingArtifactInput & { bytes: Uint8Array; mimeType?: string }
  ): Promise<ArtifactRecord> {
    return this.publishImmutable(input, true);
  }

  private async publishImmutable(
    input: PendingArtifactInput & { bytes: Uint8Array; mimeType?: string },
    reserved: boolean
  ): Promise<ArtifactRecord> {
    const target = assertContained(this.root, input.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });

    if (await exists(target)) {
      throw new Error(`Immutable artifact already exists: ${input.relativePath}`);
    }

    const reservation: PendingArtifactInput = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      relativePath: input.relativePath,
      immutable: true,
      ...(input.mimeType ? { mimeType: input.mimeType } : {})
    };
    const pending = reserved
      ? await this.repository.findById(input.id)
      : await this.repository.createPending(reservation);
    if (!pending || pending.integrityStatus !== "PENDING" ||
      pending.projectId !== input.projectId || pending.relativePath !== input.relativePath ||
      pending.kind !== input.kind || pending.mimeType !== input.mimeType || !pending.immutable) {
      throw new Error("Artifact reservation does not match publication");
    }
    await this.inject("AFTER_PENDING");

    const tempPath = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, input.bytes, { flag: "wx" });
      await this.inject("AFTER_TEMP_WRITE");

      // Publish atomically without replacing an existing immutable target.
      // Hard-link creation fails if target already exists. The temp file is
      // already fully written before the target becomes visible.
      const boundary=(globalThis as any)[Symbol.for('pvs.isolation.boundary.v1')];
      if(boundary?.publishImmutableFile)await boundary.publishImmutableFile({tempPath,targetPath:target,sha256:sha256Bytes(input.bytes)});
      else await fs.link(tempPath, target);
      await this.inject("AFTER_PUBLISH");
      await fs.rm(tempPath, { force: true });

      const bytes = await fs.readFile(target);
      const sha256 = sha256Bytes(bytes);
      const ready = await this.repository.markReady(pending.id, {
        sha256,
        sizeBytes: bytes.byteLength,
        ...(input.mimeType ? { mimeType: input.mimeType } : {})
      });
      await this.inject("AFTER_DB_READY");
      return ready;
    } catch (error) {
      if (error instanceof ArtifactStoreInjectedCrash) {
        // Simulate abrupt process termination: leave filesystem and DB exactly
        // at the injected crash boundary for restart reconciliation tests.
        throw error;
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (await exists(target)) {
        await this.repository.markCorrupt(pending.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async reconcilePending(): Promise<{ ready: string[]; missing: string[]; deferred?: string[] }> {
    const pending = await this.repository.listPending();
    const ready: string[] = [];
    const missing: string[] = [];
    const deferred: string[] = [];

    for (const artifact of pending) {
      // These reservations require their independently persisted digest and
      // explicit provider finalization. File existence cannot promote them.
      if (artifact.id.startsWith("go-local-document:")) { deferred.push(artifact.id); continue; }
      const target = assertContained(this.root, artifact.relativePath);
      try {
        const bytes = await fs.readFile(target);
        await this.repository.markReady(artifact.id, {
          sha256: sha256Bytes(bytes),
          sizeBytes: bytes.byteLength,
          ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
        });
        ready.push(artifact.id);
      } catch {
        await this.repository.markMissing(artifact.id);
        missing.push(artifact.id);
      }
    }

    return { ready, missing, ...(deferred.length ? { deferred } : {}) };
  }

  resolveArtifactPath(relativePath: string): string {
    return assertContained(this.root, relativePath);
  }

  async reconcileProject(projectId: string): Promise<{
    ready: string[];
    missing: string[];
    corrupt: string[];
    orphanPaths: string[];
    orphanQuarantined: Array<{ from: string; to: string }>;
    tempRemoved: string[];
    redundantRemoved: string[];
    deferred?: string[];
  }> {
    const records = await this.repository.listByProject(projectId);
    const ready: string[] = [];
    const missing: string[] = [];
    const corrupt: string[] = [];
    const deferred: string[] = [];
    const verifiedReadyHashes = new Set<string>();
    const known = new Set(records.map((item) => item.relativePath.replaceAll("\\", "/")));

    for (const artifact of records) {
      const target = assertContained(this.root, artifact.relativePath);
      if (artifact.integrityStatus === "PENDING") {
        if (artifact.id.startsWith("go-local-document:")) { deferred.push(artifact.id); continue; }
        try {
          const bytes = await fs.readFile(target);
          const updated = await this.repository.markReady(artifact.id, {
            sha256: sha256Bytes(bytes),
            sizeBytes: bytes.byteLength,
            ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
          });
          ready.push(updated.id);
          if (updated.sha256) verifiedReadyHashes.add(updated.sha256);
        } catch {
          await this.repository.markMissing(artifact.id);
          missing.push(artifact.id);
        }
        continue;
      }

      if (artifact.integrityStatus !== "READY") continue;
      try {
        const bytes = await fs.readFile(target);
        const actualHash = sha256Bytes(bytes);
        if (artifact.sha256 && actualHash !== artifact.sha256) {
          await this.repository.markCorrupt(artifact.id);
          corrupt.push(artifact.id);
        } else if (artifact.sha256) {
          verifiedReadyHashes.add(actualHash);
        }
      } catch {
        await this.repository.markMissing(artifact.id);
        missing.push(artifact.id);
      }
    }

    const orphanPaths: string[] = [];
    const orphanQuarantined: Array<{ from: string; to: string }> = [];
    const tempRemoved: string[] = [];
    const redundantRemoved: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const relativeDir = path
            .relative(this.root, absolute)
            .split(path.sep)
            .join("/");
          if (
            relativeDir === "research/go-local" ||
            relativeDir === ".recovery" ||
            relativeDir.startsWith(".recovery/")
          ) {
            continue;
          }
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path
          .relative(this.root, absolute)
          .split(path.sep)
          .join("/");
        if (relative === "exports/project.json") continue;
        if (!known.has(relative) && relative.startsWith(".tmp/")) {
          await fs.rm(absolute, { force: true });
          tempRemoved.push(relative);
          continue;
        }
        if (relative.endsWith(".tmp") || /\.tmp-[^/]+$/i.test(relative)) {
          await fs.rm(absolute, { force: true });
          tempRemoved.push(relative);
          continue;
        }
        if (!known.has(relative)) {
          const orphanBytes = await fs.readFile(absolute);
          const orphanHash = sha256Bytes(orphanBytes);
          if (verifiedReadyHashes.has(orphanHash)) {
            await fs.rm(absolute, { force: true });
            redundantRemoved.push(relative);
            continue;
          }
          orphanPaths.push(relative);
          let quarantineRelative = `.recovery/orphans/${relative}`;
          let quarantineTarget = assertContained(
            this.root,
            quarantineRelative
          );
          await fs.mkdir(path.dirname(quarantineTarget), {
            recursive: true
          });

          if (await exists(quarantineTarget)) {
            const suffix = orphanHash.slice(0, 12);
            quarantineRelative = `${quarantineRelative}.${suffix}`;
            quarantineTarget = assertContained(
              this.root,
              quarantineRelative
            );
            if (await exists(quarantineTarget)) {
              await fs.rm(absolute, { force: true });
            } else {
              await fs.rename(absolute, quarantineTarget);
            }
          } else {
            await fs.rename(absolute, quarantineTarget);
          }
          orphanQuarantined.push({
            from: relative,
            to: quarantineRelative
          });
        }
      }
    };

    await walk(this.root);
    return {
      ready,
      missing,
      corrupt,
      orphanPaths,
      orphanQuarantined,
      tempRemoved,
      redundantRemoved,
      ...(deferred.length ? { deferred } : {})
    };
  }
}
