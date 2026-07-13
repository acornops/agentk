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

## Additional Platform CA Trust

Use `config.tls.additionalCaBundle` when AgentK must connect to a platform whose
WebSocket certificate chains to an organization-private CA. The chart
references an existing ConfigMap or Secret in the Helm release namespace; it
does not create or copy the resource, and Kubernetes cannot mount a resource
from another namespace. Prefer a ConfigMap because CA certificates are public
trust anchors. Secret support accommodates PKI systems that distribute trust
material as Secrets.

The selected key must contain one or more PEM-encoded CA certificates. Use a
root CA or an intentionally managed CA bundle, not a server private key, client
certificate/private-key pair, or frequently replaced leaf certificate. Inline
PEM values are not supported.

ConfigMap source:

```yaml
config:
  platformUrl: https://api.acornops.example
  tls:
    additionalCaBundle:
      configMapKeyRef:
        name: organization-platform-trust
        key: ca.crt
```

Secret source:

```yaml
config:
  platformUrl: https://api.acornops.example
  tls:
    additionalCaBundle:
      secretKeyRef:
        name: organization-platform-trust
        key: ca.crt
```

Configure exactly one source. Both `name` and `key` are required. When neither
source is configured, the chart renders no additional CA volume, mount, or
environment variable. When one is configured, the AgentK container receives a
read-only `platform-additional-ca` volume at
`/etc/acornops/trust/platform-ca.pem` and chart-owned
`NODE_EXTRA_CA_CERTS=/etc/acornops/trust/platform-ca.pem`.

`NODE_EXTRA_CA_CERTS` adds this bundle to Node.js's public CA set; it does not
replace public trust or disable certificate and hostname verification. The
additional trust is process-wide for Node.js outbound TLS, but it does not
change the Kubernetes client's in-cluster or kubeconfig CA settings. The
volume source is intentionally not optional, so a missing resource or key
prevents pod startup instead of silently changing the trust policy. The AgentK
authentication key remains an independent Secret.

The chart can consume a namespace-local ConfigMap produced by cert-manager
trust-manager or an equivalent enterprise PKI distributor. AgentK does not
install or require trust-manager. Cluster administrators remain responsible
for publishing the bundle into every workload cluster and AgentK release
namespace that needs it.

### CA rotation and restarts

Node.js reads `NODE_EXTRA_CA_CERTS` only at process startup, and the file uses a
`subPath` mount. Updating the source does not update trust in an existing
AgentK container. Rotate with an overlap:

1. Publish a bundle containing both old and new CA roots.
2. Restart AgentK in each workload cluster.
3. Rotate the platform serving certificate.
4. Confirm AgentK reconnects and resumes heartbeats and snapshots.
5. Remove the old CA after the overlap period.
6. Restart AgentK again.

```bash
kubectl -n acornops rollout restart deployment/<agentk-deployment>
kubectl -n acornops rollout status deployment/<agentk-deployment>
```

The chart deliberately avoids `lookup`-based checksums for external resources
because they are inconsistent across offline rendering, Helm upgrades, and
GitOps renderers.

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

For additional CA failures, inspect pod events and AgentK logs first:

```bash
kubectl -n acornops describe pod <agentk-pod>
kubectl -n acornops logs deployment/<agentk-deployment>
kubectl -n acornops exec deployment/<agentk-deployment> -- \
  sh -c 'test -r "$NODE_EXTRA_CA_CERTS" && echo "additional CA file is readable"'
```

A pod blocked during volume setup usually indicates a missing resource or key.
Repeated certificate errors usually indicate a wrong or incomplete CA bundle.
Expired certificates and hostname mismatches must be fixed at the platform
endpoint. DNS errors, timeouts, and connection refusals require network
investigation; a connection that closes after TLS succeeds may indicate
WebSocket routing or AgentK authentication problems. Do not print certificate
contents or private material into shared terminals or logs.
