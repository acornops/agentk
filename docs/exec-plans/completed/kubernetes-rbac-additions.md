# Kubernetes RBAC Additions

## Goal

Allow a cluster installation to opt into a bounded snapshot of administrator-defined
custom-resource permissions, and expose those resources through AgentK without
turning AgentK into an unrestricted Kubernetes proxy.

## Boundaries

- Additions are Kubernetes-only and arrive as validated structured Helm values.
- Read-only installs grant configured `get`, `list`, and `watch`; configured
  `create`, `patch`, and `delete` require both Helm write RBAC and
  `ACORNOPS_AGENT_WRITE_ENABLED=true`.
- Custom-resource tools accept only snapshotted addition/resource keys.
- Patch operations require UID and resource-version preconditions, use dry-run,
  operation receipts, retry recognition, and verified non-array `/spec` paths.
- AgentK never reconciles RBAC after installation.

## Validation

- Render empty, read-only, read/write, namespaced, and cluster-scoped additions.
- Test configuration validation, unselected-resource denial, namespace policy,
  read listing, and write gating.
- Run lint, unit tests, Helm checks, contracts, harness checks, and build.

## Completion criteria

- Existing empty-addition installs render identically.
- Configured custom resources can be fetched, listed, watched, created, patched,
  or deleted when both the profile and agent access mode allow the operation.

## Result

Complete. `npm run validate` passes, including 257 tests, Helm rendering,
contracts, harness checks, lint, and build.
