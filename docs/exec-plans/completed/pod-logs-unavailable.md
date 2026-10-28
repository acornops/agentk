# Explain logs unavailable before container startup

2026-10-29. Shared branch: `fix/console-log-polish` in AgentK, Control Plane,
and Management Console. User requested this small follow-up and a main push.

- [x] Reproduce the generic-error regression with boundary tests.
- [x] Recognize Kubernetes HTTP 400 waiting-to-start responses, returning only
  the safe `PRECONDITION_FAILED` / `ContainerNotStarted` classification.
- [x] Map this classification to console API `POD_LOGS_UNAVAILABLE` (409) and
  localized no-logs-yet copy. Keep other errors distinct.
- [x] Mirror contracts, run required validation and review, then commit/push main.

No transport, RBAC, dependency or deployment changes. Older components continue
to use the generic error; the improved message requires all three updates.

Validation with Node 22.23.1:

- `npm test -- src/tools/atomic/get-resource-logs.spec.ts`: the two new positive
  cases failed before implementation, then all 12 tests passed, including JSON
  and plain-text waiting errors, unrelated HTTP 400/403, successful logs,
  redaction and the output bound.
- `npm run validate`: passed; 34 files / 267 tests, lint/types, contracts,
  harness, Helm lint/templates and build.
- Workspace `node scripts/harness/check-platform-contracts.mjs`: passed against
  this worktree and counterpart main manifests.
- Independent read-only review: no actionable findings.
- `git diff --check`: passed.

Docs impact: mirrored error contract, operational guidance, and this plan.
`npm run test:e2e` was not needed: lifecycle, websocket and RBAC code is unchanged.
No dependency or image version change. Log evidence is retained under
`/tmp/acornops-console-publish/`. The user requested direct main publication,
so no PR is created; deploying updated AgentK, Control Plane and console remains
a separate action. Older consumers retain generic error handling.
