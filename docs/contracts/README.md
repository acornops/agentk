# AgentK Contracts

This repo has one direct platform contract: the control-plane WebSocket and JSON-RPC protocol. The agent does not talk directly to the management console, execution-engine, or llm-gateway.
Machine-readable contract data for this repo lives in `docs/contracts/manifest.json` and is checked alongside this document.

## Full Platform Matrix

- Management console -> control plane
- Control plane <-> execution-engine
- Control plane <-> llm-gateway
- Control plane <-> agentk
- Execution-engine -> llm-gateway

## Platform Dependency Summary

| This repo depends on | Why |
| --- | --- |
| Control plane | Cluster registration auth, WebSocket handshake, heartbeat, snapshot upload, and remote tool execution over JSON-RPC |

## Shared Invariants

- The connection is outbound-only from agent to control plane.
- HA is active-passive. When leader election is enabled, only the elected replica opens the WebSocket; passive replicas do not participate in the protocol.
- Control plane is authoritative for `workspaceId`, `targetId`, `targetType`, snapshot interval, and builtin tool registration.
- `supportedCapabilities` is the signal that drives write-tool availability across the platform. Advertising `write` when mutation is not actually safe is a contract violation.
- Snapshots are sent as gzipped JSON-RPC notifications and later surfaced to the management console through the control plane.
- Kubernetes resource snapshots may be assembled from a watch-backed local cache, but `notify/snapshot` remains the authoritative control-plane contract. The agent must fall back to list collection when the watch cache is disabled, warming, or unhealthy.
- Any breaking change here must update this file and the mirrored control-plane contract doc in the same change.

## Control-Plane WebSocket Contract

### Connection bootstrap

Accepted control-plane paths:

- `/api/v1/agent/connect`
- `/agent/v1/connect`

Agent headers:

- `x-agent-key`
- `x-agent-version`

Handshake request:

- JSON-RPC method `lifecycle/handshake`
- params:
  - `agentKey`
  - `version`
  - `agentVersion`
  - `targetId`
  - `targetType`
  - `agentType`
  - `supportedCapabilities`
  - `clusterFeatures.metricsApiAvailable`
  - `clusterFeatures.rbacMode`

Handshake success response must include:

- `workspaceId`
- `targetId`
- `targetType`
- `sessionPolicy.allowedTools`
- `sessionPolicy.writeEnabled`
- `config.snapshotInterval`
- `config.maxSnapshotBytes`
- `config.namespaceScope.{include,exclude}`
- `config.namespaceScope.include`
- `config.namespaceScope.exclude`

The agent must reject a handshake response whose `targetId` differs from its configured Kubernetes target id or whose `targetType` is not `kubernetes`.

The agent must honor `config.maxSnapshotBytes` as a compressed-payload ceiling for `notify/snapshot`.
The agent must honor `config.namespaceScope` at handshake and `config/update_namespace_scope` requests at runtime. Namespace scope updates apply to collectors and namespace-guarded tools without restarting the agent.

Current control-plane-expected builtin tool names:

- `list_resources`
- `get_resource`
- `get_resource_logs`
- `restart_workload`
- `scale_workload`
- `simulate_patch`
- `apply_remediation`

### Agent -> control plane notifications

Heartbeat:

- method `lifecycle/heartbeat`
- params `timestamp`

Snapshot upload:

- method `notify/snapshot`
- params:
  - `timestamp`
  - `data.metrics`
  - `data.resources`
  - `data.events`

The wire payload remains a gzipped JSON-RPC notification. Snapshot collection is non-overlapping: interval ticks are skipped while a collection is in flight, and at most one manual or startup snapshot is coalesced to run after the active collection finishes.
The agent maintains a watch-backed Kubernetes resource cache by default and may trigger debounced snapshots after watched resource or Warning event changes. Interval snapshots remain the reconciliation boundary, and list-based collection remains the fallback path.

Current snapshot branches and key fields the rest of the platform depends on:

- `metrics.available`
- `metrics.nodes[].usage.{cpu,memory}`
- `resources.pods[].{name,namespace,uid,creationTimestamp,phase,nodeName,restartCount,containerStatuses}`
- `resources.deployments[].{name,namespace,uid,creationTimestamp,replicas,availableReplicas,readyReplicas}`
- `resources.statefulSets[].{name,namespace,uid,creationTimestamp,replicas,availableReplicas,readyReplicas}`
- `resources.daemonSets[].{name,namespace,uid,creationTimestamp,replicas,availableReplicas,readyReplicas}`
- `resources.cronJobs[].{name,namespace,uid,creationTimestamp,schedule,suspend,active,lastScheduleTime}`
- `resources.jobs[].{name,namespace,uid,creationTimestamp,completions,succeeded,failed,active,startTime,completionTime}`
- `resources.services[].{name,namespace,uid,creationTimestamp,type,clusterIP,ports}`
- `resources.ingresses[].{name,namespace,uid,creationTimestamp,hosts,address}`
- `resources.pvcs[].{name,namespace,uid,creationTimestamp,status,capacity,accessModes,storageClass}`
- `resources.nodes[].{name,uid,labels,kubeletVersion,status.conditions}`
- `events[].{involvedObject,reason,message,type,lastTimestamp}`

### Control plane -> agent JSON-RPC requests

The control plane can issue:

- `tools/list`
- `tools/call`

`tools/list` response must advertise, for each tool:

- `name`
- `description`
- `capability`
- `input_schema`
- `timeout_ms`
- `version`
- `deprecated`

`tools/call` request params are:

- `name`
- `arguments`

The tool implementation remains local to the agent, but the advertised schemas are consumed by control plane and then propagated to llm-gateway and execution-engine as part of the platform contract.
