# Tool Result Projections

AgentK owns the model-facing representation of every built-in Kubernetes tool. A successful call returns a standards-shaped MCP result with two views:

- `content` contains one JSON-encoded `acornops.model-context.v1` envelope and is the only view intended for model reasoning.
- `structuredContent` contains `acornops.full-tool-result.v1` with the complete source-redacted result in `data`.

Every tool advertises `outputSchema`, `artifactPolicy`, and a deterministic `projectForModel` implementation. Model context is limited to 12 KiB. Collections are reduced by whole items and every omission is explicit. If exact remediation prerequisites cannot fit, `get_resource` fails closed by returning no remediation target; it never emits a partial target that could authorize a guessed write.

## Kubernetes ownership safety

Pod remediation follows only owner references marked `controller: true`. Every fetched owner UID must match its reference before traversal continues. Supported paths are Pod to ReplicaSet to Deployment, Pod to StatefulSet, Pod to DaemonSet, and Pod to Job to CronJob. Missing owners, RBAC failures, UID replacement, cycles, depth limits, and unsupported controllers preserve the known path but return no write target.

Standalone Pods, Pods without a designated controlling owner, orphan ReplicaSets, and active Jobs are not patch targets. CronJob targets are marked `future_runs_only`. `patch_workload` requires the exact resolved UID, resource version, and current-value/source preconditions. Before an AI-run workload patch can reach AgentK, execution-engine additionally requires those fields to match a successful Pod ownership projection in the same active evidence ledger; a direct controller read cannot authorize a guessed workload patch. ConfigMap patches require a direct UID- and resource-version-bound ConfigMap projection with bounded key inventory.

## Redaction and size boundaries

Kubernetes objects are redacted before either result view is created. ConfigMap `data` and `binaryData` values are always redacted from complete results; the model projection receives only bounded `data` key names, sizes, and SHA-256 fingerprints. Pod logs additionally remove bearer and Basic credentials, credential-bearing URL userinfo across standard URI schemes, private keys, common access-key assignments, and quoted or unquoted credential assignments. AgentK rejects complete results above 2 MiB before they cross the MCP boundary. Invalid argument details retain only bounded issue codes, paths, and messages, so an adversarial validation failure cannot overflow the error projection.

Tool errors preserve a stable code, bounded message, retryability, and safe remediation metadata. Unknown internal error bodies never cross the boundary.

Write tools return bounded receipts with exact operation and target identities. Their producer projections retain change details, Kubernetes observations, warnings, and deterministic `get_resource` verification guidance; the evidence ledger protects these receipts from ordinary observation eviction.

Write uncertainty is preserved at every producer failure boundary. AgentK marks Kubernetes timeout/unavailability, post-handler output failures, and post-execution projection failures as `outcome: unknown`; consumers must inspect the target before retrying.
