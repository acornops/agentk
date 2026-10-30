# AgentK Security Model

## Trust Boundaries

- The agent connects outbound to the control plane and should not accept inbound control channels.
- Agent keys authenticate the cluster to the platform.
- Write capability advertisement and local write enablement must stay aligned.
- RBAC manifests are part of the security boundary.
- The effective tool policy is the intersection of local configuration, the
  authenticated connection's `sessionPolicy`, namespace scope, and Kubernetes RBAC.
- Remote namespace policy may narrow the locally configured maximum but may not expand it.
- Tool calls are rejected until the handshake has installed a policy for the current connection generation.

## Secrets

- Never log agent keys or derived auth material.
- Keep `ACORNOPS_AGENT_WRITE_ENABLED` explicit and reviewable.
- Treat kubeconfig rewrites and local TLS-skip settings as development-only hazards.

## Platform TLS Trust

- Optional private-CA trust references an existing namespace-local ConfigMap or
  Secret; the chart never accepts or renders inline PEM.
- `NODE_EXTRA_CA_CERTS` adds the fixed read-only bundle to Node.js's public
  roots while preserving certificate validity and hostname verification.
- The additional trust is process-wide for Node.js outbound TLS. It does not
  change Kubernetes API trust, which remains owned by in-cluster configuration
  or kubeconfig.
- The source is not optional: missing resources and keys fail pod startup.
- Agent authentication material remains independent from CA trust material,
  and certificate contents must not be logged.
- TLS bypass values such as `skipTlsVerify`, `rejectUnauthorized`, and
  `NODE_TLS_REJECT_UNAUTHORIZED=0` are not supported.

## High-Risk Changes

- Handshake or websocket auth behavior
- RBAC manifest permissions
- Destructive tool implementations
- Snapshot payload handling and remote headers

## Tool Execution Boundary

- Built-in tool names are unique within a target catalog; duplicate registration fails startup.
- The WebSocket boundary accepts only strict JSON-RPC 2.0 envelopes with
  bounded methods and request IDs; malformed requests never reach the router.
- Read and write calls use separate bounded concurrency gates, enforced deadlines, and input/output size ceilings.
- Argument validation and scope authorization occur before admission, so
  rejected calls do not consume Kubernetes concurrency or queue capacity.
- Queued calls are revoked when their authenticated connection generation is
  cleared or replaced. JSON-RPC numeric and string IDs remain distinct when
  deriving per-generation operation IDs.
- Multi-stage writes recheck the deadline after each Kubernetes operation and
  never start a later mutation after cancellation.
- Write timeouts and post-write verification failures have an unknown outcome until the target resource is read again.
- Successful write responses must retain the expected identity, requested
  state, resource-version advance, and AcornOps idempotency record.
- Write tools return minimal receipts rather than complete workload specifications.
- `patch_workload`, `patch_resource`, and `patch_configmap` accept semantic operations only. Callers cannot provide raw
  JSON Patch paths, YAML, arbitrary object fragments, or secret-bearing fields.
- Structured patches verify target UID, inspected resource version, and
  expected field state, use live
  resource-version tests, pass Kubernetes dry-run, and then apply the identical
  guarded patch.
- Literal environment and ConfigMap values are restricted to explicitly
  confirmed, single-line non-secret configuration of at most 4 KiB and are
  omitted from receipts and durable tool-call events. ConfigMap `data` and
  `binaryData` values are also redacted from complete read results; guarded
  evidence exposes only bounded key metadata and `data` value fingerprints.
  Secret resources and secret-bearing key names are rejected. Name heuristics
  are defense in depth rather than secret detection: operators must use
  Kubernetes Secrets for confidential values and keep these opt-ins disabled
  where that separation cannot be guaranteed.
- ConfigMap get/list/watch RBAC follows the explicit ConfigMap-change opt-in;
  ConfigMap patch RBAC additionally requires global write enablement. Default
  read-only installs do not gain ConfigMap access.
- Pod logs are sensitive application data. AgentK bounds but does not persist or log tool results.
- Log redaction covers common credential assignments and quoted JSON keys,
  including nested values, JSONL, and up to two embedded JSON-string layers,
  before full-result and model-excerpt construction. It preserves unrelated
  formatting; ambiguous quoted or over-deep sensitive segments are withheld. This
  cannot identify arbitrary secrets and does not scrub previously stored data.
- Tool failure logs use a fixed allowlist of identity-free status, reason, phase,
  outcome, and operation-correlation fields. Raw exceptions, Kubernetes bodies,
  tool arguments, and resource identities remain excluded.
- Namespace policy constrains namespaced objects but does not narrow existing
  Node visibility. Node objects and node metrics remain subject to Kubernetes
  RBAC, preserving the installation's pre-hardening cluster-health behavior.
- `apply_remediation` is not part of the AgentK tool surface; multi-step sequencing belongs to the execution layer.
