# Manual Manifests

The raw manifests in this directory are available for manual development and troubleshooting. The supported install path is the Helm chart in `charts/acornops-agentk`.

Use Helm for production or public installs:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

The raw deployment exposes the same leader-election environment variables and Lease RBAC for troubleshooting, but leaves `ACORNOPS_AGENT_LEADER_ELECTION_ENABLED=false` and `replicas: 1` by default. Multi-replica installs must be active-passive with leader election enabled.
