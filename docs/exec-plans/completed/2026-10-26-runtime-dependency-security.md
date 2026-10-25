# Runtime dependency security implementation plan

Completed and released for demo on 2026-10-26 as `0.0.1-experimental.14`, source
`1e8270944da2275251f0462174021654684bf379`.
[PR #4](https://github.com/acornops/agentk/pull/4), PR/main CI, and
[release](https://github.com/acornops/agentk/actions/runs/40220630996) passed,
including Kubernetes lifecycle, Helm rollout and read-only RBAC gates. Image
provenance and generated chart mirror/Pages publication verified. Full image
scanning shows fewer High/Critical findings and no new package/advisory pairs,
but still flags Zod, bundled npm and OS packages. The production gate remains
open in the quality/debt records; this archive closes only the scoped patches.

> **For agentic workers:** Use `superpowers:executing-plans` for the single scoped task below.

**Goal:** Remove the compatible `fast-copy`, `ip-address`, and `js-yaml` runtime advisories without changing AgentK application code or Zod's major version.

**Architecture:** Refresh only the three existing transitive lockfile entries. Preserve the direct dependency manifest, Kubernetes client, tool contracts, and runtime policy.

**Tech Stack:** Node.js, npm lockfile v3, TypeScript, Vitest, Helm.

**Spec:** Authorized production-readiness task: current checkout on `fix/production-readiness`; no commits, pushes, deployments, real-cluster calls, broad upgrades, or forced audit fixes.

Follow-up authorization, 2026-10-26: final review, publication, and an in-place
demo upgrade. Release `.14` also aligns package, chart, and default connector
version metadata. Dependency scope and runtime policy remain unchanged;
production security acceptance is still open.

## Global constraints

- `pino-pretty@13.1.3` accepts `fast-copy@4.1.0` through `^4.0.0`.
- `@kubernetes/client-node@1.4.0` accepts `js-yaml@4.3.2` through `^4.1.0`.
- Its `socks-proxy-agent -> socks@2.8.7` chain accepts `ip-address@10.7.4` through `^10.0.1`.
- Preserve `zod@3.25.76`; its unresolved advisory remains a release gate, not a claim that request byte limits make validation safe.

## Review focus

Check exact resolved versions, unchanged direct dependencies and unrelated lock nodes, reproducible installation, local validation, and explicit reporting of the remaining Zod advisory. No application implementation is part of this task; the before/after runtime audit is the security regression check.

## Task 1: Refresh and validate the three transitive dependencies

**Files:** `package-lock.json`; this plan and its index; the existing quality/debt records for the residual risk.

**Interfaces:** Consumes existing npm dependency ranges; produces a compatible locked dependency tree with unchanged AgentK source and contracts.

- [x] Read repository guidance and confirm the clean baseline; `npm test` passed 33 files / 258 tests.
- [x] Verify dependency chains, advisory fixed versions, and registry metadata.
- [x] Record the failing runtime audit and apply only the three targeted lockfile updates.
- [x] Inspect the semantic lockfile diff; install exactly the resulting lockfile.
- [x] Run `npm run validate`, `npm audit --omit=dev --json`, and `git diff --check`.
- [x] Hand off the diff and evidence for parent review; do not commit or deploy.

## Residual release gate: Zod collection validation

`GHSA-mrhx-c7xc-m3w5` remains on Zod 3.25.76. AgentK's write-tool `changes` and `operations` arrays accumulate element issues after `.max()` is exceeded. Write/session authorization precedes parsing, but the 32 KiB semantic patch check occurs afterward; the transport byte limit does not remove this risk.

The next scope is either fatal raw-array count checks before Zod walks elements, with malformed-input regression tests, or a deliberate migration to Zod 4.6.7 plus the v3-specific JSON-schema converter and contract tests. A `zod/v3` import in a newer package is not a fix. Any unbounded input collections also need explicit limits.

## Validation log

- Baseline `npm test`: passed, 33 files / 258 tests.
- Baseline `npm audit --omit=dev --json`: 4 flagged runtime packages (`fast-copy`, `ip-address`, `js-yaml`, `zod`); exit 1.
- Targeted `npm update fast-copy ip-address js-yaml --package-lock-only --ignore-scripts --no-audit`: changed only those three entries. The final lock was narrowed from newer compatible releases to the first fixed versions using npm-published integrity metadata.
- Exact semantic lock assertion: passed; only `fast-copy` 4.0.2 -> 4.1.0, `ip-address` 10.2.0 -> 10.7.4, and `js-yaml` 4.3.0 -> 4.3.2 changed. Direct dependencies and Zod 3.25.76 are unchanged.
- `npm ci --ignore-scripts --no-audit`: passed; 236 packages installed from the lockfile.
- `npm run validate`: passed lint/typecheck, 33 files / 258 tests, contracts, harness, all three Helm lint configurations, Helm template checks, and build. Helm's existing icon recommendation is informational.
- Post-update `npm audit --omit=dev --json`: only Zod remains (1 high); exit 1 is expected and is not a clean security audit.
- `npm ls fast-copy ip-address js-yaml zod --omit=dev`: confirms the intended installed versions and original dependency chains.
- `git diff --check`: passed.
- No real-cluster, deployment, release, push, or commit operations ran. E2E was not run because this change does not alter lifecycle/websocket/RBAC behavior and the task excludes real-cluster access.

## Decision log

- Work in the requested current checkout and branch; no additional worktree.
- Keep generated lockfile-only security changes separate from the larger Zod migration; no application source edits or new dependency overrides.
- Keep this plan active until the reviewed change lands. Parent review confirmed the three-entry lock diff, installed versions, and unchanged source/manifest.

## Advisory references

Release preflight, 2026-10-26: independent final review found no new blocker.
`npm run validate` passed again at `.14` (258 tests, contracts, Helm, build).
The release version bump also updates the existing exact-version harness check;
its first failure correctly identified that stale assertion. Hosted Kubernetes
and RBAC gates are required before publication. Zod remains a production gate.

- [fast-copy bounded-copy fix](https://github.com/advisories/GHSA-jggr-w7fw-pc2j)
- [ip-address zone-identifier fix](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)
- [js-yaml merge-work fix](https://github.com/advisories/GHSA-2883-xcg3-v3hh)
- [Zod v3 collection-validation status](https://github.com/colinhacks/zod/issues/6653)
