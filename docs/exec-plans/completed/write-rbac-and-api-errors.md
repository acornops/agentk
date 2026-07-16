# Write RBAC And Kubernetes API Errors

## Goal

Keep every write-enabled AgentK deployment aligned with the supported workload
tools and preserve actionable, sanitized Kubernetes API error classifications.

## Decisions

- Kept the legacy manual production manifest read-only by default.
- Gave the explicitly write-enabled local development manifest an additive role
  limited to `patch` on Deployments, StatefulSets, and DaemonSets.
- Made the deployment script emit that same mutation rule only when
  `ACORNOPS_AGENT_WRITE_ENABLED=true`.
- Recognized the numeric `code` used by client-node `ApiException` while
  retaining legacy client error shapes and excluding raw response bodies.

## Validation

- `npm test -- --run src/tools/executor.spec.ts`: passed, 25 tests.
- `npm run validate`: passed, including 230 tests, contracts, harness, Helm
  rendering, lint, and build.
- `npm run test:e2e`: passed, 1 test. The sandboxed attempt could not bind a
  localhost port; the approved localhost run passed.
- `kubectl apply --dry-run=client --validate=false -f deploy/local-development.yaml`:
  passed for the additive ClusterRole, ClusterRoleBinding, and Deployment.
- `task validate`: passed in `acornops-deployment`.
- `task platform-contracts`: passed in `acornops-deployment`.
- Write-enabled and read-only `agent-deploy.sh` renders were inspected with a
  stubbed kubectl; only the write-enabled render contained mutation RBAC.

## Outcome

All supported restart workload kinds receive patch permission in write-enabled
install paths, read-only installs receive no mutation verbs, and Kubernetes HTTP
failures map to stable sanitized tool codes instead of a generic error.
