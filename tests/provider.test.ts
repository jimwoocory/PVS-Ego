import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DomesticJimengCliProvider } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import { blockerFromProviderProbe } from "../src/application/services/provider-blocker.js";

test("missing dreamina maps to DREAMINA_NOT_FOUND and WorkflowBlocker", async () => {
  const provider = new DomesticJimengCliProvider(async () => null);
  const probe = await provider.probe();
  assert.equal(probe.code, "DREAMINA_NOT_FOUND");
  const blocker = blockerFromProviderProbe(
    "project-1",
    probe,
    new Date("2026-09-27T05:00:00.000Z")
  );
  assert.ok(blocker);
  assert.equal(blocker.reasonCode, "DREAMINA_NOT_FOUND");
  assert.equal(blocker.scope, "PROVIDER");
});

test("discovered unverified dreamina file is hashed but never executed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-dreamina-"));
  const fakeExecutable = path.join(dir, "dreamina.exe");
  try {
    // Deliberately not a valid executable. If probe tried to execute it,
    // this test would fail instead of returning identity-unverified.
    await fs.writeFile(fakeExecutable, "not-an-executable", "utf8");
    const provider = new DomesticJimengCliProvider(
      async () => fakeExecutable
    );
    const probe = await provider.probe();
    assert.equal(probe.code, "PROVIDER_IDENTITY_UNVERIFIED");
    if (probe.code === "PROVIDER_IDENTITY_UNVERIFIED") {
      assert.equal(probe.executablePath, fakeExecutable);
      assert.equal(probe.executableSha256.length, 64);
      assert.match(probe.rawStderr, /not executed/i);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verified runtime enables full provider contract without guessed commands", async () => {
  const { createHash } = await import("node:crypto");
  const { makeRequest, ISO, H } = await import("./fixtures.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-dreamina-verified-"));
  const executable = path.join(dir, "dreamina.exe");
  const output = path.join(dir, "output.mp4");
  const bytes = Buffer.from("fake-video-bytes", "utf8");
  await fs.writeFile(executable, "verified-binary", "utf8");
  const executableSha256 = createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex");

  const runtime = {
    identity: {
      id: "provider-identity-1",
      provider: "domestic-jimeng-cli" as const,
      officialSourceUrl: "https://www.dreamina.com/",
      publisher: "verified-test-publisher",
      executablePath: executable,
      executableSha256,
      cliVersion: "1.0.0",
      rawVersionArtifactId: "artifact-version",
      rawHelpArtifactId: "artifact-help",
      officialLoginOrigins: ["https://www.dreamina.com/"],
      capabilityFingerprint: H.a,
      verificationStatus: "VERIFIED" as const,
      verifiedAt: ISO
    },
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    parseProbe: () => ({
      cliVersion: "1.0.0",
      supportedOperations: ["submit", "status", "download"],
      supportedModels: ["seedance-2.0"],
      supportedDurationsMs: [4000, 15000]
    }),
    account: {
      args: ["account", "status"],
      parse: () => ({ status: "AUTHENTICATED" as const })
    },
    estimate: {
      buildArgs: () => ["estimate"],
      parse: () => ({ status: "KNOWN" as const, estimatedCredits: 10 })
    },
    submit: {
      buildArgs: () => ["submit", "--token", "submit-secret-token"],
      parse: () => ({ externalTaskId: "task-1" })
    },
    status: {
      buildArgs: () => ["status", "task-1"],
      parse: () => ({ status: "SUCCEEDED" as const })
    },
    download: {
      buildArgs: (_handle: { externalTaskId?: string }, outputPath: string) => [
        "download",
        "task-1",
        outputPath
      ]
    },
    reconcile: {
      buildArgs: () => ["reconcile"],
      parse: () => ({
        outcome: "FOUND_SUCCEEDED" as const,
        handle: { externalTaskId: "task-1" }
      })
    }
  };

  const calls: string[][] = [];
  const runner = async (_executablePath: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "download") {
      await fs.writeFile(String(args[2]), bytes);
    }
    if (args[0] === "--version") {
      return { stdout: "dreamina 1.0.0", stderr: "", exitCode: 0, timedOut: false };
    }
    if (args[0] === "--help") {
      return { stdout: "official help", stderr: "", exitCode: 0, timedOut: false };
    }
    if (args[0] === "submit") {
      return {
        stdout: "Authorization: Bearer provider-secret token=provider-token",
        stderr: "cookie=session-secret",
        exitCode: 0,
        timedOut: false
      };
    }
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
  };

  const provider = new DomesticJimengCliProvider(
    async () => executable,
    runtime,
    runner
  );

  try {
    const probe = await provider.probe();
    assert.equal(probe.code, "READY");
    assert.equal(blockerFromProviderProbe("project-1", probe), null);
    assert.deepEqual(await provider.accountStatus(), { status: "AUTHENTICATED" });
    assert.deepEqual(await provider.estimate([makeRequest()]), {
      status: "KNOWN",
      estimatedCredits: 10
    });
    const handle = await provider.submit(makeRequest());
    assert.equal(handle.externalTaskId, "task-1");
    assert.deepEqual(await provider.status(handle), { status: "SUCCEEDED" });
    const downloaded = await provider.download(handle, output);
    assert.equal(downloaded.sizeBytes, bytes.length);
    assert.equal(downloaded.sha256.length, 64);
    assert.deepEqual(
      await provider.reconcileSubmission({
        requestHash: H.d,
        submissionFingerprint: H.one,
        knownHandle: handle
      }),
      { outcome: "FOUND_SUCCEEDED", handle: { externalTaskId: "task-1" } }
    );
    assert.ok(calls.some((call) => call[0] === "submit"));
    assert.ok(calls.some((call) => call[0] === "download"));

    const evidence = provider.drainCommandEvidence();
    assert.ok(evidence.some((item) => item.operation === "SUBMIT"));
    const submitEvidence = evidence.find((item) => item.operation === "SUBMIT");
    assert.ok(submitEvidence);
    assert.deepEqual(submitEvidence.argvRedacted, [
      "dreamina.exe",
      "submit",
      "--token",
      "<redacted>"
    ]);
    assert.doesNotMatch(submitEvidence.stdoutRedacted, /provider-secret|provider-token/);
    assert.doesNotMatch(submitEvidence.stderrRedacted, /session-secret/);
    assert.match(submitEvidence.stdoutRedacted, /<redacted>/);
    assert.match(submitEvidence.stderrRedacted, /<redacted>/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("download recovers from CLI internal timeout by using fresh official result URL without resubmitting", async () => {
  const { createHash } = await import("node:crypto");
  const { ISO, H } = await import("./fixtures.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-dreamina-download-recovery-"));
  const executable = path.join(dir, "dreamina.exe");
  const output = path.join(dir, "recovered.mp4");
  const recoveredBytes = Buffer.from("recovered-video-bytes", "utf8");
  await fs.writeFile(executable, "verified-binary", "utf8");
  const executableSha256 = createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex");
  const runtime = {
    identity: {
      id: "provider-identity-download-recovery",
      provider: "domestic-jimeng-cli" as const,
      officialSourceUrl: "https://www.dreamina.com/",
      publisher: "verified-test-publisher",
      executablePath: executable,
      executableSha256,
      cliVersion: "1.0.0",
      rawVersionArtifactId: "artifact-version",
      rawHelpArtifactId: "artifact-help",
      officialLoginOrigins: ["https://www.dreamina.com/"],
      capabilityFingerprint: H.a,
      verificationStatus: "VERIFIED" as const,
      verifiedAt: ISO
    },
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    parseProbe: () => ({
      cliVersion: "1.0.0",
      supportedOperations: ["status", "download"],
      supportedModels: ["seedance-2.0"],
      supportedDurationsMs: [4000, 15000]
    }),
    status: {
      buildArgs: () => ["query_result", "--submit_id", "task-1"],
      parse: () => ({ status: "SUCCEEDED" as const })
    },
    download: {
      buildArgs: (_handle: { externalTaskId?: string }, target: string) => [
        "query_result", "--submit_id", "task-1", "--download_dir", path.dirname(target)
      ],
      outputMode: "DIRECTORY" as const
    }
  };
  const calls: string[][] = [];
  const runner = async (_exe: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args.includes("--download_dir")) {
      return {
        stdout: "",
        stderr: "context deadline exceeded (Client.Timeout while reading body)",
        exitCode: 1,
        timedOut: true
      };
    }
    return {
      stdout: JSON.stringify({
        gen_status: "success",
        result_json: {
          videos: [{ video_url: "https://cdn.example.test/result.mp4" }]
        }
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false
    };
  };
  let directDownloads = 0;
  const provider = new DomesticJimengCliProvider(
    async () => executable,
    runtime,
    runner,
    async () => [],
    async (url, target, timeoutMs) => {
      directDownloads += 1;
      assert.equal(url, "https://cdn.example.test/result.mp4");
      assert.equal(timeoutMs, 300_000);
      await fs.writeFile(target, recoveredBytes);
    }
  );
  try {
    const downloaded = await provider.download({ externalTaskId: "task-1" }, output);
    assert.equal(downloaded.sizeBytes, recoveredBytes.length);
    assert.equal(await fs.readFile(output, "utf8"), recoveredBytes.toString("utf8"));
    assert.equal(directDownloads, 1);
    assert.equal(calls.filter(call => call.includes("--download_dir")).length, 1);
    assert.equal(calls.filter(call => !call.includes("--download_dir")).length, 1);
    assert.ok(calls.every(call => !call.includes("submit")));
    const evidence = provider.drainCommandEvidence("DOWNLOAD");
    assert.equal(evidence.at(-1)?.exitCode, 0);
    assert.equal(evidence.at(-1)?.timedOut, false);
    assert.match(evidence.at(-1)?.stdoutRedacted ?? "", /direct HTTPS download/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
