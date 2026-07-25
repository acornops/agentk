# Workload and ConfigMap Patching

Split the built-in Kubernetes patch surface into explicit workload, generic
resource, and ConfigMap tools. Preserve current workload, Service, and Ingress
mutation behavior; add guarded non-secret workload environment operations and
guarded ConfigMap `data` key operations.

Completion requires strict semantic schemas, UID and resource-version
preconditions, Kubernetes dry-run, idempotent receipts, least-privilege opt-in
RBAC, source-redacted model projections, execution-engine evidence and approval
support, contract updates, and repository/platform validation.

Breaking compatibility is accepted: workload callers move from
`patch_resource` to `patch_workload`. `patch_resource` remains for the existing
Service and Ingress operations. Secret values, Secret resources, `binaryData`,
raw JSON Patch, YAML, create, delete, and multi-resource writes remain outside
the built-in tool surface.

Completed and production-audited on 2026-07-25. `npm run validate` passed with
250 tests, contract and harness checks, Helm lint/template checks, and
TypeScript build. The loopback WebSocket lifecycle suite also passed with
`npm run test:e2e`.

The production-readiness audit corrected duplicate environment handling,
Kubernetes `NotIn` selector semantics, existing Service/Ingress metadata
validation parity, direct-read environment fingerprints, and explicit
non-secret literal confirmation. It also moved ConfigMap read RBAC behind the
same explicit ConfigMap policy opt-in. A live k3d API-server smoke test exercised
workload environment, ConfigMap data, and Service metadata patches, including
same-operation idempotency and read-result redaction.
