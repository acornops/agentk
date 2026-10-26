# Agent maintenance standardization

## Release integration — 2026-10-26

Implementation and independent review are complete. The user subsequently
authorized main integration and a demo release. The original implementation
record below is historical; publication and deployment acceptance are tracked
in the deployment repository's security-maintenance-release plan. Remaining
production gates are not cleared by this source qualification.

Add a deterministic managed-key pod checksum and document credential-preserving
repair versus explicit replacement. No agent runtime or wire-protocol change.
Externally managed Secrets remain operator-owned. Existing security work is kept.

Branch: `fix/runtime-validation-security` (existing current checkout).

Validation on 2026-10-26: `npm run validate` passed (262 tests, Helm lint/render,
contracts, harness, and build); `npm run test:e2e` passed (one lifecycle test).
Helm regressions cover changed/unchanged keys, external Secrets, and custom
annotations. Independent review confirmed the checksum behavior and reran the
Helm rendering checks successfully; no chart findings were raised. Changes remain
uncommitted. A live Helm upgrade and real cluster rollout were not exercised; the
release still needs a disposable-cluster canary before production deployment.
