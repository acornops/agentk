<p align="center">
  <img width="220" src="https://raw.githubusercontent.com/acornops/docs-website/main/logo/light.svg" alt="AcornOps" />
</p>

<h1 align="center">AcornOps Agent</h1>

<p align="center">
  <a href="https://github.com/acornops/agentk/actions/workflows/ci.yml"><img src="https://github.com/acornops/agentk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/acornops/agentk"><img src="https://codecov.io/gh/acornops/agentk/branch/main/graph/badge.svg" alt="Coverage" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-20-green.svg" alt="Node 20" /></a>
  <a href="docs/contracts/README.md"><img src="https://img.shields.io/badge/contracts-checked-blue.svg" alt="Contracts checked" /></a>
</p>

<p align="center">
  Lightweight Kubernetes operations agent with outbound-only connectivity and an MCP bridge for cluster management.
</p>

## Status

This repository owns the Kubernetes agent code, chart, production image, protocol contract, and agent-level docs. Central platform deployment wiring belongs in `acornops-deployment`.

## Agent-Assisted Development

This repository supports human and agent-assisted development. Start coding agents from this repository root for agentk-only work, and from the `acornops-workspace` root for changes that touch multiple AcornOps repositories.

## Contracts

Cross-repo contract documentation lives in [`docs/contracts/README.md`](docs/contracts/README.md). This repo's only direct platform dependency should be the control-plane protocol documented there.
Machine-readable contract data lives in [`docs/contracts/manifest.json`](docs/contracts/manifest.json).
Run `npm run contracts:check` to mechanically verify the documented agent/control-plane contract against the implementation.

Coverage is generated in CI with Vitest V8 coverage, uploaded as a workflow artifact, and published to Codecov when `CODECOV_TOKEN` is configured for the repository.

## Documentation

Primary docs:

- [`AGENTS.md`](AGENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`docs/index.md`](docs/index.md)
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Whole-system architecture: [`../docs/system-architecture.md`](../docs/system-architecture.md)

## Features

- **Rich Snapshots**: Modular telemetry collection (Pods, workloads, Services, Ingresses, PVCs, Nodes, Metrics, Events).
- **Outbound-only**: Initiates secure WebSocket connection to the platform.
- **MCP Bridge**: Executes "Atomic Tools" and "Orchestrated Remediations" via JSON-RPC.
- **Stateless**: Zero local persistence; automatic re-handshake on reconnection.
- **Safe**: Built-in write guards and mandatory audit annotations.

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (Strict Mode)
- **Core Libraries**: `@kubernetes/client-node`, `ws`, `zod`, `pino`, `fast-json-patch`, `jsonpath-plus`.

## Configuration

The agent is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ACORNOPS_AGENT_PLATFORM_URL` | WSS endpoint of the platform | (Required) |
| `ACORNOPS_CLUSTER_ID` | Control-plane cluster id this agent key is bound to | (Required) |
| `ACORNOPS_AGENT_KEY` | Unique agent authentication token | (Required) |
| `ACORNOPS_AGENT_HANDSHAKE_PROBE_TIMEOUT_MS` | Timeout for non-blocking metrics API probe during handshake | `3000` |
| `ACORNOPS_AGENT_KUBECONFIG_REWRITE_LOOPBACK` | Rewrite kubeconfig API server host (`0.0.0.0/localhost`) to `ACORNOPS_AGENT_KUBECONFIG_HOST_ALIAS` for containerized local dev | `false` |
| `ACORNOPS_AGENT_KUBECONFIG_HOST_ALIAS` | Hostname used when loopback rewrite is enabled | `host.docker.internal` |
| `ACORNOPS_AGENT_KUBECONFIG_SKIP_TLS_VERIFY` | Skip TLS verification after loopback-host rewrite (local k3d convenience only) | `false` |
| `ACORNOPS_AGENT_K8S_CONCURRENCY` | Process-wide maximum concurrent Kubernetes API list requests during snapshot collection | `8` |
| `ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT` | Kubernetes API list page size used when collecting large snapshots | `500` |
| `ACORNOPS_AGENT_WATCH_CACHE_ENABLED` | Build snapshots from a Kubernetes watch-backed local cache when ready | `true` |
| `ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS` | Debounce window for snapshots triggered by watched resource or Warning event changes | `5000` |
| `ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS` | Time to wait for watch cache warmup before using list fallback | `15000` |
| `ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS` | Kubernetes watch stream timeout before clean reconnect | `300` |
| `ACORNOPS_AGENT_WATCH_NAMESPACES` | Comma-separated list of namespaces to watch | All |
| `ACORNOPS_AGENT_WRITE_ENABLED` | Set to `true` to enable mutation tools | `false` |
| `ACORNOPS_AGENT_LOCAL_FALLBACK_ENABLED` | Emit local synthetic node/usage snapshot when Kubernetes API is unreachable (dev only) | `false` |
| `ACORNOPS_AGENT_LOG_LEVEL` | Logging level (`info`, `debug`, `error`, `warn`, `trace`) | `info` |
| `ACORNOPS_AGENT_LEADER_ELECTION_ENABLED` | Enable active-passive HA using a Kubernetes `Lease` | `false` |
| `ACORNOPS_AGENT_LEASE_NAME` | Leader election Lease name | `acornops-agent-leader` |
| `ACORNOPS_AGENT_LEASE_NAMESPACE` | Leader election Lease namespace; empty uses pod namespace | Pod namespace |
| `ACORNOPS_AGENT_LEADER_IDENTITY` | Lease holder identity; empty uses pod UID, then pod name | Pod UID/name |
| `ACORNOPS_AGENT_LEASE_DURATION_MS` | Lease expiry window before another replica can take over | `15000` |
| `ACORNOPS_AGENT_RENEW_DEADLINE_MS` | Local renew failure deadline before the leader fences itself | `10000` |
| `ACORNOPS_AGENT_RETRY_PERIOD_MS` | Election retry/renew period | `2000` |

## Snapshot Scalability

Snapshots are assembled from a Kubernetes watch-backed local cache by default. The agent still emits the existing compact `notify/snapshot` payload, but it keeps Pods, workloads, Services, Ingresses, PVCs, Nodes, Namespaces, and recent Warning Events fresh through list-then-watch streams instead of listing every resource on each interval.

The list collectors remain the fallback path when the watch cache is disabled, warming, or unhealthy. Initial sync and 410-compaction recovery still use bounded, paginated list calls, so `ACORNOPS_AGENT_K8S_CONCURRENCY` and `ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT` continue to bound API pressure during warmup, scope changes, and watch recovery.

Use `snapshot-manager` logs to track `durationMs`, `skippedSnapshots`, `droppedSnapshots`, `originalBytes`, and `compressedBytes`. If snapshots regularly skip interval ticks, increase the snapshot interval before raising `ACORNOPS_AGENT_K8S_CONCURRENCY`; higher concurrency can worsen API server pressure when list latency is already the bottleneck.

## Deployment

### Helm (Recommended)

The supported release install path is the `acornops-agentk` Helm chart. This is the right install method whether the central AcornOps platform runs on Docker-on-VM or Kubernetes.

Install with the public platform base URL:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

`config.platformUrl` is the public control-plane base URL. The chart derives the agent WebSocket URL as `wss://<host>/api/v1/agent/connect`. For Docker-on-VM central deployments, this is the API host, for example `https://api.acornops.dev`; the management console is served separately from `https://console.acornops.dev/`.

If your WebSocket route is custom, pass it directly:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.websocketUrl=wss://api.acornops.dev/api/v1/agent/connect \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY
```

Use an existing Kubernetes Secret instead of passing the key in Helm values:

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

The chart defaults to cluster-wide read-only RBAC. Write tools require an explicit opt-in:

```bash
helm upgrade --install acornops-agent oci://ghcr.io/acornops/charts/acornops-agentk \
  --namespace acornops \
  --create-namespace \
  --set-string config.platformUrl=https://api.acornops.dev \
  --set-string config.clusterId=YOUR_CLUSTER_ID \
  --set-string config.agentKey=YOUR_AGENT_KEY \
  --set rbac.write.enabled=true
```

For namespace-scoped installs, create Roles only in the watched namespaces:

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

Active-passive HA is opt-in. Multiple replicas are rejected unless leader election is enabled, because the agent is not active-active safe. In HA mode, only the elected Lease holder connects to the control plane, sends snapshots/heartbeats, and serves tool calls:

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

The default remains `replicaCount=1` with leader election disabled. That keeps the common install simple and avoids granting Lease write permissions unless HA is requested. For HA, `replicaCount=2` is usually enough to survive one agent pod or node loss. Use `replicaCount=3` only when you want two warm standbys or broader scheduling spread; Kubernetes Lease election does not need an odd number of agent replicas.

Shorter Lease timings reduce failover time but increase Kubernetes API churn and sensitivity to transient API delays. Longer timings reduce churn but extend the passive takeover gap.

Check status and logs:

```bash
kubectl -n acornops rollout status deployment/acornops-agent
kubectl -n acornops logs -f deployment/acornops-agent
```

Uninstall:

```bash
helm uninstall acornops-agent --namespace acornops
```

### Manual Raw Manifests

The raw manifests under `deploy/` are retained for manual development and troubleshooting. Prefer Helm for release installs.

### Local Development (Direct Run)

If you have a Kubernetes cluster already running and configured in your `KUBECONFIG`:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run in development mode:
   ```bash
   export ACORNOPS_AGENT_PLATFORM_URL=wss://api.acornops.dev/api/v1/agent/connect
   export ACORNOPS_CLUSTER_ID=your-cluster-id
   export ACORNOPS_AGENT_KEY=your-test-key
   npm run dev
   ```

## Local Development and Testing

Compose files are split as:

- `docker-compose.yml`: base/default runtime for `acornops-agentk`.
- `docker-compose.override.yml`: local development additions (`mock-platform`, host mounts, host ports, local image build).

### Run Modes

1. Component-only local development (recommended in this repo):

```bash
docker compose up -d --build
```

This local mode runs the agent with `tsx watch` and the mock platform with `node --watch`, so code changes are reflected immediately.

2. Component-only production-style container (agent only):

```bash
docker compose -f docker-compose.yml up -d
```

3. Full AcornOps stack (all components together):

```bash
cd ../acornops-deployment
task local-up
```

This full-stack flow uses the deployment repo `Taskfile.yml` and requires the `task` CLI to be installed.

Use full-stack mode when validating the agent against the real control-plane service instead of the local mock platform.
Do not run this repository's local compose stack and `acornops-deployment` local stack at the same time on the same host ports.

If dependencies change (`package.json` or lockfile), rebuild once:

```bash
docker compose up -d --build
```

For efficient component-level development, run the agent with the local **Mock Platform** and command-testing endpoint.

The local mock platform provides:
- **WebSocket Server**: Listens on `ws://localhost:3000/agent`
- **Snapshot Storage**: Decompressed snapshots are saved to `./local-snapshots/` in Docker Compose local mode. When the mock platform is run directly, it writes to `SNAPSHOT_DIR` or `./snapshots/`.
- **Command Trigger**: `POST http://localhost:3000/send-command` to send MCP requests to the agent.
- **Health Endpoint**: `GET http://localhost:3000/health`
- **Connection Inspect Endpoint**: `GET http://localhost:3000/connections`
- **Swagger UI (Mock Platform)**: `http://localhost:3000/docs`
- **OpenAPI JSON (Mock Platform)**: `http://localhost:3000/openapi.json`

The `acornops-agentk` process itself is not an HTTP API server; it is a websocket JSON-RPC client. For local developer docs/testing, use the mock platform HTTP API above.

### Local k3d Testing Guide

This guide provides step-by-step instructions to set up a local Kubernetes cluster using `k3d`, build the agent, and deploy it for manual testing.

#### Prerequisites
Ensure you have the following installed:
- [Docker](https://docs.docker.com/get-docker/)
- [k3d](https://k3d.io/#installation)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Node.js 20+](https://nodejs.org/)

#### Create a Local Cluster
Create a simple one-node cluster:
```bash
k3d cluster create acornops-demo-cluster --no-lb --wait
```

#### Build the Agent Image
Build the Docker image locally:
```bash
docker build -t acornops/agent:local .
```

#### Load Image into k3d
Import the local image into the k3d cluster so it's available without a registry:
```bash
k3d image import acornops/agent:local -c acornops-demo-cluster
```

#### Prepare Deployment Manifests
Create the `acornops` namespace:
```bash
kubectl create namespace acornops
```

Create a dummy secret for testing:
```bash
kubectl create secret generic acornops-agentk-secret \
  --from-literal=agent-key=test-agent-key-123 \
  -n acornops
```

#### Deploy the Agent
Apply the RBAC and Deployment manifests:
```bash
# Apply RBAC
kubectl apply -f deploy/rbac.yaml

# Use the local development manifest which is pre-configured for the mock platform
kubectl apply -f deploy/local-development.yaml
```

#### Verify and Monitor

Check the mock platform logs to see the agent connecting and sending snapshots:
```bash
docker compose logs -f mock-platform
```

Check the `local-snapshots/` directory for saved data in Docker Compose local mode.

#### Sending Commands

You can test tools by sending commands via the mock platform:

```bash
curl -X POST http://localhost:3000/send-command \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_pod_logs",
    "params": {
      "podName": "acornops-agentk-xxxxxxxxxx-xxxxx",
      "namespace": "acornops"
    }
  }'
```

#### Inspect Runtime
Check if the pod is running:
```bash
kubectl get pods -n acornops -l app=acornops-agentk
```

Check the agent logs:
```bash
kubectl logs -f -n acornops -l app=acornops-agentk
```

#### Cleanup Cluster
When finished, delete the cluster:
```bash
k3d cluster delete acornops-demo-cluster
```

## Testing (Automated)

Run unit tests:
```bash
npm test
```

Run E2E tests (requires a running cluster):
```bash
npm run test:e2e
```

## Validation

Run the checks that match the change:

- `npm run lint`
- `npm run contracts:check`
- `npm run harness:check`
- `npm run validate`
- `npm test`
- `npm run test:e2e` when lifecycle, websocket, or RBAC behavior changes

## Tools Available

- `get_pod_logs`: Read pod logs (max 1MB).
- `describe_resource`: Fetch full JSON object of any supported resource.
- `restart_deployment`: Rolling restart via annotation patch.
- `scale_workload`: Scale Deployments or StatefulSets.
- `simulate_patch`: Generate a JSON Diff for a proposed change.
- `apply_remediation`: Execute a sequence of tools with pre-conditions and UID verification.
