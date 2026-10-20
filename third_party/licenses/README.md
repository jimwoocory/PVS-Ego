# Third-Party License Archive

This directory stores license texts for npm packages actually installed by the P0 dependency set.

Current P0 rules:

1. Default deny: every exact package/version in `package-lock.json` must already exist in `dependency-allowlist.json` before installation is accepted.
2. `npm run license:gate` is read-only. It never auto-approves or rewrites the allowlist.
3. Direct and transitive lockfile packages are checked. GPL, AGPL, SSPL, UNKNOWN, NOASSERTION, unlicensed/no-LICENSE, non-allowlisted, or otherwise non-approved licenses fail the gate.
4. `npm run license:archive` archives the license file for every package actually installed on the current platform under `third_party/licenses/npm/`.
5. Platform-specific optional packages that exist in the lockfile but are not installed are still license-gated; they are listed in `PLATFORM_OPTIONAL_SKIPPED.txt` rather than treated as missing installed files.
6. Multiple installed versions of the same package are archived using their exact lockfile installation path.
7. The official dreamina CLI is an external runtime and its binary must never be copied into this repository or license archive.
8. Third-party Jimeng/Dreamina CLIs and MIT wrappers are not approved P0 runtime dependencies.

Current inventory is recorded in `THIRD_PARTY_NOTICES.md` and `dependency-allowlist.json`.
