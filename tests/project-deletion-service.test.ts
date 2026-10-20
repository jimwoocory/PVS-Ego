import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaProjectDeletionService } from "../src/adapters/db/prisma-project-deletion-service.js";

const exec = promisify(execFile);

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-project-delete-")
  );
  const database =
    "file:" +
    path.join(root, "fixture.db").replaceAll("\\", "/");
  await fs.writeFile(path.join(root,"fixture.db"),"");

  await exec(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy"
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: database
      },
      windowsHide: true,
      timeout: 90_000
    }
  );

  const db = new PrismaClient({
    datasources: { db: { url: database } }
  });
  const projectsRoot = path.join(root, "projects");
  await fs.mkdir(projectsRoot, { recursive: true });

  return {
    root,
    db,
    projectsRoot,
    cleanup: async () => {
      await db.$disconnect();
      await fs.rm(root, {
        recursive: true,
        force: true
      });
    }
  };
}

test("deleting a project rehomes a shared provider identity instead of violating the FK", async () => {
  const fx = await fixture();
  try {
    const ownerId = "delete-owner";
    const survivorId = "delete-survivor";
    const identityId = "shared-provider-identity";

    await fx.db.project.createMany({
      data: [
        {
          id: ownerId,
          name: "Delete Owner",
          status: "DRAFT",
          targetPlatform: "douyin",
          targetDurationMs: 10000,
          aspectRatio: "9:16"
        },
        {
          id: survivorId,
          name: "Delete Survivor",
          status: "DRAFT",
          targetPlatform: "douyin",
          targetDurationMs: 10000,
          aspectRatio: "9:16"
        }
      ]
    });

    await fx.db.providerIdentityRecord.create({
      data: {
        id: identityId,
        projectId: ownerId,
        provider: "domestic-jimeng-cli",
        executablePath: "C:/verified/dreamina.exe",
        executableSha256: "a".repeat(64),
        cliVersion: "1.0.0",
        rawVersionArtifactId: "version-artifact",
        rawHelpArtifactId: "help-artifact",
        officialLoginOriginsJson: "[]",
        capabilityFingerprint: "b".repeat(64),
        verificationStatus: "VERIFIED"
      }
    });

    const capabilityBase = {
      provider: "domestic-jimeng-cli",
      providerIdentityId: identityId,
      cliFound: true,
      authenticated: "AUTHENTICATED",
      supportedOperationsJson: '["probe"]',
      supportedModelsJson: '["seedance-2.0"]',
      supportedDurationsMsJson: "[10000]",
      rawProbeArtifactId: "probe-artifact",
      capabilityFingerprint: "c".repeat(64),
      probedAt: new Date("2026-10-07T08:00:00.000Z")
    };

    await fx.db.providerCapabilityRecord.createMany({
      data: [
        {
          id: "cap-owner",
          projectId: ownerId,
          ...capabilityBase
        },
        {
          id: "cap-survivor",
          projectId: survivorId,
          ...capabilityBase
        }
      ]
    });

    const service = new PrismaProjectDeletionService(
      fx.db,
      fx.projectsRoot
    );
    const deleted = await service.deleteProject({
      projectId: ownerId,
      confirmName: "Delete Owner"
    });

    assert.equal(deleted.projectId, ownerId);
    assert.equal(
      await fx.db.project.findUnique({
        where: { id: ownerId }
      }),
      null
    );
    assert.ok(
      await fx.db.project.findUnique({
        where: { id: survivorId }
      })
    );

    const identity =
      await fx.db.providerIdentityRecord.findUnique({
        where: { id: identityId }
      });
    assert.equal(identity?.projectId, survivorId);

    const survivorCapability =
      await fx.db.providerCapabilityRecord.findUnique({
        where: { id: "cap-survivor" }
      });
    assert.equal(
      survivorCapability?.providerIdentityId,
      identityId
    );
    assert.equal(
      await fx.db.providerCapabilityRecord.findUnique({
        where: { id: "cap-owner" }
      }),
      null
    );
  } finally {
    await fx.cleanup();
  }
});
