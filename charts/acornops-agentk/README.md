# AcornOps Agent Helm Chart

This chart installs the AcornOps Kubernetes agent. It is the canonical release install path for workload clusters, whether the central AcornOps platform runs on Docker-on-VM or Kubernetes.

## Quick Start

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

`config.platformUrl` is the public control-plane base URL. The chart derives `wss://.../api/v1/agent/connect` for the agent.

Use `config.websocketUrl` only when the WebSocket endpoint is not derived from the platform base URL:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.websocketUrl=wss://agent.example.com/custom-agent-path \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

## Existing Secret

```bash
kubectl -n acornops create secret generic acornops-agent-key \
  --from-literal=agent-key=YOUR_AGENT_KEY

helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string existingSecret.name=acornops-agent-key \
  --set-string existingSecret.key=agent-key
```

## RBAC Modes

The default install is cluster-wide read-only. Write tools are disabled and the chart does not grant mutation verbs.

Snapshot collection is bounded by `config.k8sConcurrency` and paginated with `config.k8sListPageLimit`. The defaults are conservative for unreleased environments: 8 concurrent Kubernetes API list requests and 500 items per page.

Enable write tools explicitly:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY \
  --set rbac.write.enabled=true
```

Namespace-scoped install:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY \
  --set-string rbac.scope=namespace \
  --set-json 'namespaceScope.include=["team-a","team-b"]'
```

When `rbac.scope=namespace`, the chart creates Roles in `rbac.namespaces` when set, otherwise in `namespaceScope.include`, otherwise in the release namespace.

## Active-Passive HA

The agent supports active-passive HA with Kubernetes Lease leader election. It does not support active-active operation. When `replicaCount > 1`, `leaderElection.enabled` must be `true`; passive replicas stay warm but do not connect, send snapshots, emit heartbeats, or serve tool calls.

The chart defaults to `replicaCount=1` and `leaderElection.enabled=false`. This is intentional: a single replica is the simplest least-privilege default, and HA requires namespaced Lease write permissions. For HA, `replicaCount=2` is typically the pragmatic default because it gives one active pod and one warm standby. `replicaCount=3` is useful when operators want two warm standbys or stronger scheduling spread, but Kubernetes Lease election does not require an odd number of agent replicas.

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY \
  --set replicaCount=2 \
  --set leaderElection.enabled=true
```

Leader election values:

```yaml
leaderElection:
  enabled: false
  leaseName: acornops-agent-leader
  leaseNamespace: ""
  leaseDurationMs: 15000
  renewDeadlineMs: 10000
  retryPeriodMs: 2000
```

`leaseNamespace` defaults to the pod namespace when empty. Shorter timings fail over faster but increase Kubernetes API churn and sensitivity to API stalls; longer timings reduce churn but extend the failover gap.

## Uninstall

```bash
helm uninstall acornops-agent --namespace acornops
```

## Troubleshooting

```bash
kubectl -n acornops rollout status deployment/acornops-agent
kubectl -n acornops logs -f deployment/acornops-agent
kubectl auth can-i list pods --as=system:serviceaccount:acornops:acornops-agent
kubectl auth can-i list namespaces --as=system:serviceaccount:acornops:acornops-agent
kubectl auth can-i list nodes --as=system:serviceaccount:acornops:acornops-agent
```
