# AgentK Operations

## Runtime Contract

- The agent uses an outbound WebSocket to the platform.
- The default install is one read-only replica.
- Multi-replica installs are active-passive only and require Kubernetes Lease leader election.
- Write-capable tools require explicit RBAC and configuration opt-in.
- The control-plane session may narrow locally enabled tools and namespaces but cannot expand them.

## Required Environment

- `ACORNOPS_AGENT_PLATFORM_URL`
- `ACORNOPS_CLUSTER_ID`
- `ACORNOPS_AGENT_KEY` or an existing Secret referenced by the Helm chart
- `ACORNOPS_AGENT_WRITE_ENABLED`
- `ACORNOPS_AGENT_LEADER_ELECTION_ENABLED`

## Helm Operations

Install into a workload cluster:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

Check rollout:

```bash
kubectl -n acornops rollout status deployment/acornops-agent
kubectl -n acornops logs -f deployment/acornops-agent
```

### Additional platform CA trust

When the platform WebSocket certificate uses an organization-private CA,
either pass a public PEM bundle with
`--set-file config.tls.additionalCaBundle.inlinePem=/path/to/ca.pem`, or publish
it as a ConfigMap or Secret in the AgentK release namespace of each workload
cluster. Configure one source:

```yaml
config:
  platformUrl: https://api.acornops.example
  tls:
    additionalCaBundle:
      configMapKeyRef:
        name: organization-platform-trust
        key: ca.crt
```

For a Secret source, replace `configMapKeyRef` with `secretKeyRef`. Both `name`
and `key` are required. The resource is namespace-local and must already exist;
a missing resource or selected key prevents the pod from starting. A ConfigMap
produced in each namespace by cert-manager trust-manager is supported, but the
chart does not install or require trust-manager.

AgentK mounts the selected key read-only at
`/etc/acornops/trust/platform-ca.pem` and sets `NODE_EXTRA_CA_CERTS` to that
path. This extends Node.js public trust while preserving certificate and
hostname verification. It does not alter Kubernetes API trust or the AgentK
authentication Secret.

Node.js reads the bundle only at startup, and the `subPath` mount does not
refresh inside an existing container. Rotate with an overlap: publish old and
new roots, restart AgentK, rotate the platform certificate, verify WebSocket
handshake/heartbeats/snapshots, remove the old root, and restart AgentK again.
An upgrade that changes chart-managed inline PEM content rolls the Deployment
automatically; externally managed ConfigMaps and Secrets do not.

```bash
kubectl -n acornops rollout restart deployment/<agentk-deployment>
kubectl -n acornops rollout status deployment/<agentk-deployment>
```

## Snapshot Scalability

The snapshot pipeline uses a Kubernetes watch-backed local cache by default. The agent still sends periodic compact `notify/snapshot` payloads to the control plane, but steady-state resource changes come from watch streams and debounced change-triggered snapshots instead of full-list polling on every interval.

Bounded, paginated list calls are still used for initial cache sync, namespace-scope changes, 410-compaction recovery, and fallback when the watch cache is disabled, warming, or unhealthy. Monitor `snapshot-manager` logs for `durationMs`, `skippedSnapshots`, `droppedSnapshots`, `originalBytes`, and `compressedBytes`, and monitor `watch-manager` logs for repeated relist or reconnect warnings. If snapshots regularly skip interval ticks, increase the snapshot interval before raising `ACORNOPS_AGENT_K8S_CONCURRENCY`; higher concurrency can increase API server pressure when list latency is already the bottleneck.

## WebSocket Recovery

Connection/upgrade and application-handshake waits each have a 10-second limit.
Transport pings run every 30 seconds with a 10-second pong deadline; a silent
peer is normally detected within 40 seconds. An in-process stop, including
leadership loss, bounds the close exchange to one second; process termination
can close sockets immediately. These bounds assume a responsive event loop.

Outbound frames are limited to 10 MiB and admission checks the existing socket
buffer plus payload against 16 MiB. This bounds admitted payload buffering,
not process RSS or operating-system buffers. Snapshots use the negotiated
smaller budget, or 10 MiB if omitted; compression remains gzip only.
Oversize or backpressured snapshots are dropped without a replay queue.
Failed control-message admission or asynchronous socket-write failure revokes
the session immediately and reconnects with the existing jittered backoff.
Logs report bounded reasons and byte counts rather than payloads or peer text.
Transport errors distinguish DNS, refused connections, TLS and upgrade rejection
without exposing error messages. The handshake reports last-known metrics API
availability; only a probe completing in its current generation updates that value.

Reconnect requires a fresh authenticated handshake. Pending replies from the
old connection are discarded; successful local send admission does not prove
delivery. Inspect any uncertain write outcome before deciding to retry.

## Failure Modes

- Agent cannot connect: verify `ACORNOPS_AGENT_PLATFORM_URL`, DNS, TLS, and the platform `/api/v1/agent/connect` route. With additional CA trust enabled, inspect pod events for a missing ConfigMap, Secret, or key; repeated issuer errors indicate a wrong or incomplete bundle, while hostname mismatches and expired certificates must be fixed at the platform endpoint.
- Authentication rejected: use **Replace AgentK credential** in cluster settings.
  Generating the command revokes the old key immediately. Managed-key changes
  restart pods through the chart checksum; externally managed Secrets must be
  updated and their consumers restarted by the operator.
- Routine upgrade or repair: use **Upgrade or repair AgentK**. It reuses installed
  Helm values and credentials and waits for the rollout. Check context, release,
  namespace, and any image pin before execution; it will not install a missing
  release. See the [chart maintenance guide](../charts/acornops-agentk/README.md#agent-maintenance-and-credential-replacement).
- No telemetry: verify Kubernetes RBAC, namespace scope, metrics-server availability, and collector logs.
- Pod logs report `ContainerNotStarted`: the selected container is waiting to
  start, so it has no logs yet. Check its status and events (for example an image
  pull failure), then refresh after startup. This uses sanitized
  `PRECONDITION_FAILED` tool metadata rather than exposing Kubernetes error bodies.
- Slow or skipped telemetry: inspect `watch-manager` and `snapshot-manager` logs, increase the snapshot interval if collection takes too long, then tune `ACORNOPS_AGENT_K8S_CONCURRENCY` and `ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT` if list fallback or relist recovery is the bottleneck.
- HA does not elect a leader: verify Lease RBAC and `leaderElection.enabled=true`.
- Lease requests time out after at most two seconds (or the shorter configured
  retry/deadline). An independent monotonic watchdog stops the active runtime
  when renewal is unconfirmed for `renewDeadlineMs`, even if a request hangs.
  Active retries run sooner when needed to leave half the remaining renewal
  window available for API calls; passive retries retain the configured cadence.
  Shutdown revokes local authority before a best-effort one-second Lease release.
  An adapter that ignores cancellation keeps its single request slot occupied;
  restart that passive replica if it never settles. Event-loop suspension can
  delay timers, but a late response cannot restore expired authority.
- Tool rejected before execution: verify handshake session policy, local namespace maximum, and write enablement.
- Write tool times out, or Kubernetes accepts a mutation but returns a result that AgentK cannot verify: treat the outcome as unknown, retain the returned operation ID, and inspect the resource before deciding whether to retry the same tool call ID.

Tool failure logs expose only an allowlisted operational projection: `tool`,
stable `code`, `retryable`, and, when available, numeric Kubernetes `status`,
stable `reason`, execution `phase`, write `outcome`, and generated `operationId`.
Use these fields to distinguish API rejection, execution timeout, result
processing, and post-write verification failures. AgentK intentionally excludes
tool arguments, resource names and namespaces, exception messages, and raw
Kubernetes response bodies from these logs.

Verify the mounted bundle without printing it:

```bash
kubectl -n acornops exec deployment/<agentk-deployment> -- \
  sh -c 'test -r "$NODE_EXTRA_CA_CERTS" && echo "additional CA file is readable"'
```

TLS success followed by a closed connection points to WebSocket routing or
authentication rather than CA trust. DNS failures, timeouts, and connection
refusals require network investigation.

## Tool Safety Defaults

- Read tool concurrency: 4; write tool concurrency: 1; queued calls: 16 shared across both gates.
- Maximum tool input: 1 MiB; maximum serialized output: 2 MiB.
- Maximum scale target: 100 replicas; operators may configure a lower ceiling.
- Scale-to-zero is disabled unless both the operator and the caller confirm it.
- Structured patching defaults to Deployment, StatefulSet, and DaemonSet.
  CronJob, Service, and Ingress patch RBAC must be opted into through
  `patchPolicy.workloadKinds`, `patchPolicy.resourceKinds`, and the explicit
  environment or ConfigMap opt-ins.
- Service selector changes require both operator enablement and caller
  confirmation because they can immediately redirect traffic.
- Namespace-scoped installs use their Role namespaces as the local maximum scope.

## Required Validation

Before chart or runtime changes:

```bash
npm run validate
npm run helm:check
```
