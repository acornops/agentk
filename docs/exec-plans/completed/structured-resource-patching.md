# Structured Resource Patching

## Goal

Replace the non-authoritative `simulate_patch` read tool with one guarded
`patch_resource` write tool while keeping the built-in catalog at six tools.

## Decisions

- Accept semantic operations, never caller-supplied JSON Patch or YAML.
- Preserve `restart_workload` and `scale_workload` as specialized tools.
- Default patch kinds to Deployment, StatefulSet, and DaemonSet.
- Make CronJob, Service, and Ingress patch RBAC explicit local opt-ins.
- Require expected UID and expected field values; use the post-approval live
  resource version for the atomic Kubernetes precondition.
- Run Kubernetes dry-run before applying the identical guarded patch.

## Validation

- `npm run validate` passed: 195 unit tests plus lint, contracts, harness,
  Helm rendering, and build.
- `npm run test:e2e` passed.
- `npm audit --omit=dev` reports zero production vulnerabilities.
- An isolated k3d API-server check passed real Deployment, DaemonSet, CronJob,
  Service, and Ingress mutations, restart and scale operations, minimal receipt
  verification, and idempotent retries. Exact cluster- and namespace-scoped
  Helm RBAC grants and denials were verified, then the cluster was deleted.

## Production Review

- Corrected Kubernetes `NotIn` selector evaluation and added admission-result
  selector checks.
- Multi-stage writes now stop before their next Kubernetes operation when the
  executor deadline expires.
- Restart, scale, and structured patch responses verify resource-version
  advance, requested state, and the shared idempotency record; unverifiable
  accepted writes report an unknown outcome.
- Empty local patch-kind configuration fails closed, image references reject
  non-printable or non-ASCII display controls, and AgentK-owned metadata keys
  cannot be patched.
- Strict JSON-RPC validation rejects malformed envelopes before routing;
  validated and authorized calls alone consume admission capacity.
- Reconnects cancel queued calls from the prior connection generation, and
  operation IDs distinguish numeric from string JSON-RPC IDs.
- Scale retries and post-write receipts require canonical persisted operation
  metadata, and stored reasons and annotation values reject Unicode format
  controls.

## Completion Criteria

AgentK validation, E2E, Helm, contract, idempotency, race, dry-run, namespace,
and receipt tests pass.
