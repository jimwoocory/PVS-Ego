import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gatePath = path.resolve("scripts", "license-gate.mjs");

type Fixture = {
  root: string;
  manifest: Record<string, any>;
  lock: Record<string, any>;
  allow: Record<string, any>;
  notice: string;
};

function npmEntry(name: string, version: string, license = "MIT") {
  return {
    name,
    version,
    ecosystem: "npm",
    usage: "P0 runtime dependency",
    license,
    sourceUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${version}`,
    bundled: true,
    runtimeType: "production-dependency",
    approvedForP0: true,
    licenseFile: "third_party/licenses/spdx/MIT.txt",
    noticeEntry: "THIRD_PARTY_NOTICES.md#bundled-npm-dependency-inventory",
    reviewedAt: "2026-09-27",
    scope: "production",
    direct: true
  };
}

function runtimes() {
  return [
    {
      name: "dreamina",
      version: "TO_BE_DISCOVERED_BY_PROBE",
      ecosystem: "external-runtime",
      usage: "Domestic official Jimeng Seedance runtime",
      license: "EXTERNAL-SERVICE-TERMS-NOT-BUNDLED",
      sourceUrl: "TO_BE_VERIFIED_OFFICIAL_SOURCE",
      bundled: false,
      runtimeType: "external-runtime",
      approvedForP0: true,
      identityVerificationRequired: true,
      requiredIdentityStatusBeforeSubmit: "VERIFIED",
      serviceTermsStatus: "TO_BE_VERIFIED_WITH_OFFICIAL_INSTALL",
      licenseFile: null,
      noticeEntry:
        "THIRD_PARTY_NOTICES.md#domestic-jimeng-official-dreamina-cli",
      reviewedAt: "2026-09-27"
    },
    {
      name: "hermes-agent",
      version: "0.21.3",
      ecosystem: "external-runtime",
      usage: "Structured AI runtime",
      license: "MIT",
      sourceUrl: "https://github.com/NousResearch/hermes-agent",
      bundled: false,
      runtimeType: "external-runtime",
      approvedForP0: true,
      identityVerificationRequired: true,
      serviceTermsStatus: "LOCAL_EXTERNAL_RUNTIME_NOT_BUNDLED",
      licenseFile: "third_party/licenses/hermes-agent-0.21.3-LICENSE",
      noticeEntry:
        "THIRD_PARTY_NOTICES.md#hermes-agent-structured-ai-runtime",
      reviewedAt: "2026-09-27"
    }
  ];
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-license-gate-"));
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    private: true,
    dependencies: { foo: "1.0.0" }
  };
  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" }
      },
      "node_modules/foo": {
        name: "foo",
        version: "1.0.0",
        license: "MIT"
      }
    }
  };
  const allow = {
    schemaVersion: "1.0.0",
    policyVersion: "P0-V0.2",
    defaultDecision: "DENY",
    reviewedAt: "2026-09-27",
    allowedLicenses: [
      "MIT",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC"
    ],
    deniedLicenses: [
      "GPL-2.0",
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
      "AGPL-3.0",
      "SSPL-1.0",
      "UNKNOWN",
      "NOASSERTION",
      "UNLICENSED",
      "NO-LICENSE"
    ],
    dependencies: [npmEntry("foo", "1.0.0")],
    externalRuntimes: runtimes()
  };
  const notice = `# Third-Party Notices

## Bundled npm dependency inventory

| Package | Version | License | Scope |
| --- | --- | --- | --- |
| foo | 1.0.0 | MIT | production |

## Domestic Jimeng official dreamina CLI

Official external runtime only.

## Hermes Agent structured AI runtime

MIT external runtime.
`;

  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "third_party", "licenses", "spdx"), {
    recursive: true
  });
  await fs.writeFile(
    path.join(root, "docs", "THIRD-PARTY-POLICY.md"),
    "# P0 policy\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "third_party", "licenses", "spdx", "MIT.txt"),
    "MIT License fixture\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "third_party", "licenses", "hermes-agent-0.21.3-LICENSE"),
    "MIT License Hermes fixture\n",
    "utf8"
  );
  await writeFixture({ root, manifest, lock, allow, notice });
  return { root, manifest, lock, allow, notice };
}

async function writeFixture(fixture: Fixture): Promise<void> {
  await Promise.all([
    fs.writeFile(
      path.join(fixture.root, "package.json"),
      JSON.stringify(fixture.manifest, null, 2),
      "utf8"
    ),
    fs.writeFile(
      path.join(fixture.root, "package-lock.json"),
      JSON.stringify(fixture.lock, null, 2),
      "utf8"
    ),
    fs.writeFile(
      path.join(fixture.root, "dependency-allowlist.json"),
      JSON.stringify(fixture.allow, null, 2),
      "utf8"
    ),
    fs.writeFile(
      path.join(fixture.root, "THIRD_PARTY_NOTICES.md"),
      fixture.notice,
      "utf8"
    )
  ]);
}

async function runGate(root: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, [gatePath], {
      cwd: process.cwd(),
      env: { ...process.env, PVS_LICENSE_ROOT: root }
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const fixture = await makeFixture();
  try {
    await fn(fixture);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

test("License Gate accepts a complete governed fixture", async () => {
  await withFixture(async ({ root }) => {
    const result = await runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /LICENSE_GATE_PASS packages=1 external_runtimes=2/);
  });
});

test("License Gate rejects unregistered lockfile dependency", async () => {
  await withFixture(async (fixture) => {
    fixture.lock.packages["node_modules/bar"] = {
      name: "bar",
      version: "1.0.0",
      license: "MIT"
    };
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ALLOWLIST_MISSING_OR_MISMATCH/);
  });
});

test("License Gate rejects transitive GPL dependency", async () => {
  await withFixture(async (fixture) => {
    fixture.lock.packages["node_modules/gpl-child"] = {
      name: "gpl-child",
      version: "1.0.0",
      license: "GPL-3.0"
    };
    fixture.allow.dependencies.push({
      ...npmEntry("gpl-child", "1.0.0", "GPL-3.0"),
      usage: "Transitive dependency",
      bundled: false,
      runtimeType: "transitive-dependency",
      scope: "transitive",
      direct: false
    });
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LICENSE_POLICY_BLOCK/);
    assert.match(result.stderr, /gpl-child@1\.0\.0/);
  });
});

test("License Gate rejects NO-LICENSE package", async () => {
  await withFixture(async (fixture) => {
    fixture.lock.packages["node_modules/foo"].license = undefined;
    fixture.allow.dependencies[0].license = "NO-LICENSE";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LICENSE_POLICY_BLOCK/);
    assert.match(result.stderr, /NO-LICENSE/);
  });
});

test("License Gate rejects missing license copy", async () => {
  await withFixture(async (fixture) => {
    fixture.allow.dependencies[0].licenseFile =
      "third_party/licenses/spdx/missing.txt";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LICENSE_GOVERNANCE_INVALID/);
    assert.match(result.stderr, /licenseFile missing/);
  });
});

test("License Gate rejects missing NOTICE anchor", async () => {
  await withFixture(async (fixture) => {
    fixture.allow.dependencies[0].noticeEntry =
      "THIRD_PARTY_NOTICES.md#missing-section";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LICENSE_GOVERNANCE_INVALID/);
    assert.match(result.stderr, /NOTICE anchor missing/);
  });
});

test("License Gate rejects third-party Jimeng MIT wrapper as runtime", async () => {
  await withFixture(async (fixture) => {
    fixture.allow.externalRuntimes.push({
      name: "xiaozhichao2025-JimengCli_api",
      version: "1.0.0",
      ecosystem: "external-runtime",
      usage: "third-party Jimeng API wrapper",
      license: "MIT",
      sourceUrl: "https://github.com/xiaozhichao2025/JimengCli_api",
      bundled: false,
      runtimeType: "external-runtime",
      approvedForP0: true,
      identityVerificationRequired: false,
      serviceTermsStatus: "TEST_ONLY",
      licenseFile: "third_party/licenses/spdx/MIT.txt",
      noticeEntry:
        "THIRD_PARTY_NOTICES.md#hermes-agent-structured-ai-runtime",
      reviewedAt: "2026-09-27"
    });
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EXTERNAL_RUNTIME_POLICY_BLOCK/);
    assert.match(result.stderr, /prohibited Jimeng\/Dreamina wrapper/);
  });
});

test("License Gate rejects unregistered vendor or binary files", async () => {
  await withFixture(async (fixture) => {
    await fs.mkdir(path.join(fixture.root, "third_party", "bin"), {
      recursive: true
    });
    await fs.writeFile(
      path.join(fixture.root, "third_party", "bin", "third-party.exe"),
      "binary fixture",
      "utf8"
    );
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /UNREGISTERED_VENDOR_OR_BINARY/);
  });
});

test("License Gate rejects package.json and lockfile manifest mismatch", async () => {
  await withFixture(async (fixture) => {
    fixture.manifest.dependencies.foo = "2.0.0";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MANIFEST_LOCK_MISMATCH/);
    assert.match(result.stderr, /foo/);
  });
});

test("License Gate rejects allowlisted npm Jimeng wrapper dependency", async () => {
  await withFixture(async (fixture) => {
    const name = "xiaozhichao-jimengcli-api";
    fixture.manifest.dependencies[name] = "1.0.0";
    fixture.lock.packages[""].dependencies[name] = "1.0.0";
    fixture.lock.packages[`node_modules/${name}`] = {
      name,
      version: "1.0.0",
      license: "MIT"
    };
    fixture.allow.dependencies.push({
      ...npmEntry(name, "1.0.0"),
      sourceUrl: "https://github.com/xiaozhichao2025/JimengCli_api",
      usage: "third-party Jimeng API wrapper"
    });
    fixture.notice +=
      "\n| xiaozhichao-jimengcli-api | 1.0.0 | MIT | production |\n";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LICENSE_GOVERNANCE_INVALID/);
    assert.match(
      result.stderr,
      /prohibited Jimeng\/Dreamina wrapper or reverse CLI dependency/
    );
  });
});

test("License Gate rejects UNKNOWN external runtime license", async () => {
  await withFixture(async (fixture) => {
    fixture.allow.externalRuntimes.push({
      name: "safe-external",
      version: "1.0.0",
      ecosystem: "external-runtime",
      usage: "test runtime",
      license: "UNKNOWN",
      sourceUrl: "https://example.test/runtime",
      bundled: false,
      runtimeType: "external-runtime",
      approvedForP0: true,
      identityVerificationRequired: true,
      serviceTermsStatus: "REVIEWED_TEST",
      licenseFile: null,
      noticeEntry:
        "THIRD_PARTY_NOTICES.md#hermes-agent-structured-ai-runtime",
      reviewedAt: "2026-09-27"
    });
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EXTERNAL_RUNTIME_POLICY_BLOCK/);
    assert.match(result.stderr, /license is not approved: UNKNOWN/);
  });
});

test("License Gate rejects external runtime missing service terms status", async () => {
  await withFixture(async (fixture) => {
    delete fixture.allow.externalRuntimes[1].serviceTermsStatus;
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EXTERNAL_RUNTIME_POLICY_BLOCK/);
    assert.match(result.stderr, /missing serviceTermsStatus/);
  });
});

test("License Gate rejects external runtime missing NOTICE anchor", async () => {
  await withFixture(async (fixture) => {
    fixture.allow.externalRuntimes[1].noticeEntry =
      "THIRD_PARTY_NOTICES.md#missing-runtime-notice";
    await writeFixture(fixture);
    const result = await runGate(fixture.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EXTERNAL_RUNTIME_POLICY_BLOCK/);
    assert.match(result.stderr, /NOTICE anchor missing/);
  });
});
