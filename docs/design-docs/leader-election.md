# Leader Election For Active-Passive High Availability

Status: Implemented<br>
Last updated: 2026-05-15

## Summary

The agent should support **leader-election-based active-passive HA**, not active-active operation.

This matches the current role of the component:

- the agent maintains a single outbound WebSocket session to the control plane
- it collects cluster-wide snapshots that would be duplicated by multiple active replicas
- it executes remote tools where single-writer authority is safer than concurrent execution
- it already relies on stateless reconnect and re-handshake instead of sharded workload ownership

The implementation goal is to allow multiple replicas to be scheduled for availability while ensuring that **exactly one replica is operational at a time**. Non-leader replicas should stay warm, participate in election, and remain ready to take over quickly, but they must not send snapshots, emit heartbeats, or serve tool calls.

## Implementation Notes

Leader election keeps the control-plane WebSocket protocol unchanged. It is an internal agent availability mechanism:

- `src/runtime/leader-election.ts` uses `coordination.k8s.io/v1` `Lease` objects.
- `src/index.ts` starts the active runtime only after leadership is acquired.
- `LifecycleManager.stop()` fences WebSocket, heartbeat, snapshot, and JSON-RPC side effects.
- `WebSocketClient.close()` cancels pending reconnects so leadership loss cannot revive a stopped runtime.
- Helm rejects `replicaCount > 1` unless `leaderElection.enabled=true`.

The control plane stores one active in-memory connection per cluster ID and replaces the map entry on a new handshake. Agent-side fencing prevents routine overlap. Control-plane connection replacement should close superseded sockets and include agent instance identity in diagnostics when operators need deeper failover visibility.

Default replica policy: keep `replicaCount=1` and `leaderElection.enabled=false`. This preserves the least-privilege single-agent install and avoids Lease write RBAC unless HA is explicitly requested. For active-passive HA, `replicaCount=2` is usually the right starting point; it provides one active pod and one warm standby. `replicaCount=3` can be used for two warm standbys or more scheduling spread, but Lease leader election does not benefit from odd-number quorum at the agent replica layer.

## Why Active-Passive Instead Of Active-Active

Active-active would require solving problems that do not provide enough value for this agent:

- deduplicating identical cluster-wide snapshots
- coordinating tool execution across replicas
- reconciling multiple concurrent WebSocket sessions for one cluster identity
- preventing capability drift and duplicate heartbeats
- teaching the control plane which session is authoritative

Active-passive avoids those problems. It preserves the platform model: there is one active agent session per cluster, and failover is handled by leader turnover rather than by concurrent runtime instances.

## Goals

- Support `replicaCount > 1` without duplicate agent activity.
- Use Kubernetes-native leader election via `coordination.k8s.io/v1` `Lease`.
- Keep only the elected leader connected to the control plane.
- Ensure leadership loss immediately fences all outbound behavior.
- Keep the default single-replica deployment simple.
- Minimize direct protocol changes unless they are required for safe failover diagnostics.

## Non-Goals

- Active-active snapshot streaming.
- Concurrent tool execution across replicas.
- Cross-cluster or cross-namespace election coordination.
- Persisting local agent state across failover.
- Introducing a second control channel between replicas.

## Runtime Model

The runtime is built around one active process instance:

- `src/index.ts` constructs one `LifecycleManager` and immediately starts it.
- `src/core/lifecycle.ts` starts the WebSocket client, handshake, snapshot pipeline, and heartbeat loop in one always-on runtime.
- `src/transport/websocket-client.ts` owns reconnect behavior and reconnects until the runtime stops.
- `src/core/snapshot-manager.ts` starts periodic cluster-wide snapshot collection once the handshake succeeds.
- `charts/acornops-agentk/values.yaml` explicitly says the chart does not support active-active HA and defaults `replicaCount` to `1`.

Active-passive mode adds:

- passive replicas
- runtime fencing after leadership loss
- leader-specific activation/deactivation
- lease ownership identity
- lease RBAC

## Proposed Design

### High-Level Behavior

At startup, every replica should:

1. initialize config, logging, Kubernetes clients, and leader-election support
2. compete for a namespaced `Lease`
3. stay **passive** until leadership is acquired
4. start the agent runtime only after leadership is acquired
5. stop the agent runtime immediately when leadership is lost
6. re-enter the election loop unless the process is shutting down

Operationally:

- **leader replica**: owns Lease, connects to control plane, performs handshake, emits heartbeats, sends snapshots, serves tool calls
- **passive replica**: does not connect to control plane, does not run snapshot timers, does not serve tools, only renews election participation

### Core Principle: Leadership Must Fence All Activity

Leadership is not just an informational state. It must be the hard boundary for all external side effects.

If a replica is not the leader, it must not:

- establish or keep a WebSocket session
- send handshake requests
- emit heartbeat notifications
- send snapshot notifications
- respond to remote tool calls
- keep reconnect timers alive

If leadership becomes uncertain, behavior should fail closed.

## Detailed Runtime Design

### 1. Split “Process Running” From “Agent Session Active”

The current `LifecycleManager` combines:

- runtime construction
- transport ownership
- control-plane handshake
- snapshot scheduling
- heartbeat scheduling
- JSON-RPC dispatch

This needs to be refactored so the process can remain alive while the agent session is started and stopped multiple times.

Recommended shape:

- `LeaderElector` (new): acquires, renews, and releases the Lease
- `AgentRuntime` or refactored `LifecycleManager`: encapsulates one active leader session
- `Main` entrypoint: wires config, signal handling, leader election, and runtime lifecycle transitions

The key requirement is that the leader-elector must be able to call:

- `runtime.start()` when leadership is acquired
- `runtime.stop()` when leadership is lost

The runtime must make those operations idempotent.

### 2. Introduce A Leader-Election Component

Add a new module responsible for Lease-based election, for example:

- `src/runtime/leader-election.ts`

It should use the Kubernetes client already present in the repo rather than introducing a second Kubernetes library unless there is a strong reason to do so.

Responsibilities:

- read or create the target `Lease`
- acquire leadership when the Lease is free or expired
- renew leadership before the renew deadline
- emit callbacks on `acquired`, `lost`, and optionally `standby`
- release the Lease on clean shutdown when possible
- tolerate transient Kubernetes API failures without accidentally keeping the runtime active after leadership is lost

Recommended election configuration fields:

- election enabled flag
- lease name
- lease namespace
- holder identity
- lease duration
- renew deadline
- retry period

### 3. Use Stable Per-Pod Identity

Election must use a stable holder identity for the lifetime of the pod. The recommended source is:

- pod UID when available
- otherwise pod name

Also capture:

- pod namespace
- pod name
- pod UID

These should be injected through the Kubernetes downward API in the Deployment template.

The runtime may derive a human-readable instance identifier such as:

- `<pod-name>.<pod-uid>`

Use this for:

- Lease holder identity
- logs
- debugging
- optional handshake metadata

Do **not** change the cluster identity model unless required. The cluster should still register as one logical agent/cluster with the control plane.

### 4. Make Runtime Start/Stop Explicit And Safe

The active runtime should expose explicit lifecycle controls:

- `start()`
- `stop()`
- `isRunning()` or equivalent guard

`stop()` must fully fence side effects:

- close the WebSocket client
- prevent reconnect scheduling after leadership loss
- clear heartbeat timers
- stop snapshot timers
- reject or ignore in-flight messages after shutdown begins
- reset handshake/session state

Important edge cases:

- leadership loss during handshake
- leadership loss while a reconnect timer is pending
- leadership loss while a snapshot is being collected
- rapid leadership loss followed by reacquisition
- shutdown while Lease release is in progress

### 5. Add Transport Fencing

`WebSocketClient` reconnects automatically until `close()` sets `isClosing`.

That behavior needs a stronger runtime contract:

- the transport must not reconnect after leadership loss
- any reconnect timer created before leadership loss must be canceled or rendered inert
- `forceReconnect()` must not revive a stopped runtime

Recommended implementation constraints:

- track reconnect timeout handles so they can be cleared
- separate “intentionally stopped” from transient network closure
- ensure event listeners do not continue to dispatch into a stopped runtime

### 6. Guard Snapshot And Heartbeat Loops

Snapshot and heartbeat logic must only run while the runtime is leader-active.

Requirements:

- `SnapshotManager.start()` may only be called from an active runtime
- `SnapshotManager.stop()` must run on leadership loss and process shutdown
- heartbeat interval must be cleared on leadership loss
- any one-shot or manual trigger path must verify runtime active state before sending

For extra safety, the runtime should guard outbound sends with a leadership-active check so stale timers cannot leak traffic after a state transition.

### 7. JSON-RPC Request Handling Expectations

Only the leader should ever have a control-plane socket, so passive replicas should not receive tool calls.

Still, implementation should preserve defense in depth:

- request handling should no-op or reject if the runtime is stopping
- the router must not remain reachable through stale transport callbacks

This is especially important during failover races when the prior leader is shutting down while a new leader is connecting.

## Configuration Changes

### Environment Variables

Add explicit configuration for HA and leader election. Proposed names:

- `ACORNOPS_AGENT_LEADER_ELECTION_ENABLED`
- `ACORNOPS_AGENT_LEASE_NAME`
- `ACORNOPS_AGENT_LEASE_NAMESPACE`
- `ACORNOPS_AGENT_LEADER_IDENTITY`
- `ACORNOPS_AGENT_LEASE_DURATION_MS`
- `ACORNOPS_AGENT_RENEW_DEADLINE_MS`
- `ACORNOPS_AGENT_RETRY_PERIOD_MS`

Recommended defaults:

- disabled by default for simple single-replica installs
- enabled when operators explicitly opt in to HA
- lease namespace defaults to the pod namespace
- leader identity defaults to pod UID, then pod name

Alternative acceptable design:

- always enable leader election when `replicaCount > 1`
- allow it to remain disabled for `replicaCount = 1`

If this path is chosen, the chart and runtime rules must be explicit so operators do not create multi-replica installs without election.

### Helm Values

Add a dedicated values section, for example:

```yaml
leaderElection:
  enabled: false
  leaseName: acornops-agent-leader
  leaseNamespace: ""
  leaseDurationMs: 15000
  renewDeadlineMs: 10000
  retryPeriodMs: 2000
```

Also consider:

- `podDisruptionBudget.enabled`
- `topologySpreadConstraints`
- opinionated anti-affinity defaults when HA is enabled

The exact values can be tuned during implementation, but the chart must document the failover tradeoff:

- shorter timings -> faster failover, higher API churn, greater split-brain sensitivity
- longer timings -> slower failover, lower churn

## Deployment And Manifest Changes

### Helm Chart

Update:

- `charts/acornops-agentk/values.yaml`
- `charts/acornops-agentk/values.schema.json`
- `charts/acornops-agentk/templates/deployment.yaml`
- chart README if install instructions change

Deployment template changes should include:

- downward API env vars for pod name, pod UID, and namespace
- leader-election env vars
- optional anti-affinity or topology spread for multi-replica scheduling
- optional `PodDisruptionBudget`

### Raw Manifests

If `deploy/` remains a supported troubleshooting path, mirror the same leader-election-related environment variables and RBAC changes there.

### Termination Behavior

Review pod termination settings so clean shutdown can:

- stop the runtime
- release the Lease when possible
- avoid long overlapping active windows

That may require reviewing:

- `terminationGracePeriodSeconds`
- preStop hook behavior if introduced

Keep the implementation simple unless shutdown data shows this is necessary.

## RBAC Changes

Leader election requires access to `Lease` resources in `coordination.k8s.io`.

The agent service account will need, at minimum:

- `get`
- `create`
- `update`
- `patch`
- `watch`

Depending on implementation details, `list` may also be useful, but the default should remain as narrow as possible.

Scope expectations:

- Lease access should be namespaced
- the Lease should live in the release namespace unless there is a documented override

Security review points:

- do not broaden cluster permissions unnecessarily
- keep Lease permissions separate and reviewable in chart/manifests
- preserve the current write-gating boundary for cluster mutation tools

## Control-Plane And Cross-Repo Considerations

This repository only directly depends on the control-plane WebSocket contract, but leader election may still affect other repositories indirectly.

An implementation ticket should explicitly inspect the following:

### 1. Control Plane Repository

Check whether the control plane assumes:

- only one active WebSocket session per agent key or cluster
- session replacement behavior during reconnect/failover
- stale session cleanup timing
- heartbeat timeout handling during failover

Questions to answer:

- If the old leader is slow to disconnect, does a new leader successfully replace it?
- Does the control plane deduplicate or reject simultaneous sessions?
- Are there logs or metrics that should include the agent instance identity?

If handshake or session semantics need to change, update:

- this repo’s `docs/contracts/README.md`
- this repo’s `docs/contracts/manifest.json`
- the mirrored contract docs/manifests in the control-plane repository

### 2. Deployment / Environment Repository

If install defaults or HA guidance are maintained in another deployment repository (for example the local/full-stack deployment repo referenced from this project’s README), check for:

- duplicated install values
- example manifests
- Helm value overlays
- operational runbooks

Those may need the same leader-election configuration surfaced and documented.

### 3. Management Console / Platform UX

This repo does not directly contract with the management console, but operators may need visibility into:

- which pod currently holds leadership
- whether the agent is passive or active
- failover timing

Only add cross-repo UI work if the platform already exposes agent-instance health.

## Protocol Considerations

The preferred first implementation is **no breaking protocol change**.

The control plane should continue to see one logical cluster agent session. Leader election should be an internal agent availability mechanism.

Optional protocol additions that may be useful, but should be treated as explicit contract changes:

- add `instanceId` to handshake metadata
- add leadership-related diagnostics to logs or session metadata

Do not add protocol fields casually. If they are introduced, they become part of the mirrored cross-repo contract surface.

## Failure And Fencing Rules

The implementation must treat the following as loss of leadership or loss of safe authority:

- Lease renew failure beyond the configured deadline
- explicit Lease ownership change to another holder
- local shutdown
- unrecoverable election loop errors

When any of those occur, the runtime must:

1. mark itself inactive
2. stop new outbound work immediately
3. tear down transport and timers
4. clear session-local state
5. only resume after a fresh acquire event

Target behavior:

- brief failover gap is acceptable
- overlapping active windows should be minimized and treated as a bug
- duplicate snapshots during failover should be prevented, not merely tolerated

## Observability Expectations

Add clear logs around:

- election start
- Lease acquired
- Lease renewed
- Lease lost
- runtime started because leadership was acquired
- runtime stopped because leadership was lost
- takeover after prior leader failure

Recommended log fields:

- `leaseName`
- `leaseNamespace`
- `holderIdentity`
- `podName`
- `podUid`
- `reason`

If metrics are added later, useful signals would be:

- leadership transitions counter
- active leadership duration
- renew failures
- failover duration

Metrics are optional for the first implementation.

## Testing Plan

### Unit Tests

Add focused tests for:

- leader election acquire path
- renew path
- loss path
- runtime start on acquire
- runtime stop on loss
- reconnect timer cancellation on stop
- no heartbeat after stop
- no snapshot send after stop
- rapid reacquire does not duplicate timers

Suggested files:

- `src/runtime/leader-election.spec.ts`
- updated lifecycle and transport specs

### Integration / E2E Coverage

Because lifecycle and deploy behavior are high risk, add or extend end-to-end coverage for:

- two replicas deployed with election enabled
- exactly one active control-plane session
- leader pod termination causing follower takeover
- no sustained overlap of active sessions
- no duplicate periodic snapshots after takeover

If the existing local mock platform can expose connection counts and received snapshots, it is a good place to validate failover behavior before any cross-repo environment testing.

### Validation Commands

For an implementation change, expect at least:

- `npm run lint`
- `npm run contracts:check`
- `npm run harness:check`
- `npm run validate`
- `npm test`
- `npm run test:e2e`

`npm run test:e2e` is especially important because this work touches lifecycle, websocket, and deployment behavior.

## Implementation Outline

Recommended order:

1. Refactor lifecycle/runtime so it can be started and stopped cleanly.
2. Harden `WebSocketClient` stop semantics and reconnect cancellation.
3. Add the leader-election component and unit tests.
4. Wire leader election into `src/index.ts`.
5. Add config parsing for election settings.
6. Add chart/deployment/downward-API/RBAC changes.
7. Add integration and e2e coverage.
8. Update contracts only if protocol/session metadata changes are required.
9. Update architecture, reliability, and deployment docs after the behavior lands.

## Acceptance Criteria

Implementation should not be considered done until all of the following are true:

- multi-replica deployment runs with one active leader only
- passive replicas do not connect to the control plane
- leadership loss stops snapshots, heartbeats, and reconnect loops
- leader takeover restores handshake, heartbeat, and snapshot behavior
- Lease access is limited to the minimum required RBAC
- Helm and raw manifests expose the required configuration
- docs clearly state HA is active-passive, not active-active
- any required cross-repo contract changes are updated in the same change

## Risks

- split-brain caused by incomplete fencing after leadership loss
- control-plane rejection or confusion during quick session replacement
- reconnect loops surviving runtime stop
- Kubernetes API instability causing false leadership loss
- too-aggressive election timings causing flapping

## Implementation Touchpoints

Primary files in this repository:

- `src/index.ts`
- `src/config.ts`
- `src/core/lifecycle.ts`
- `src/transport/websocket-client.ts`
- `src/core/snapshot-manager.ts`
- `src/runtime/leader-election.ts`
- `charts/acornops-agentk/values.yaml`
- `charts/acornops-agentk/values.schema.json`
- `charts/acornops-agentk/templates/deployment.yaml`
- RBAC templates/manifests for Lease access
- `deploy/` manifests for manual troubleshooting
- `docs/contracts/README.md` and `docs/contracts/manifest.json` if protocol changes are required

Related files in other repositories:

- mirrored control-plane contract docs/manifests
- control-plane WebSocket session handling
- deployment repo overlays or install docs
- any operator runbooks that describe single-replica assumptions
