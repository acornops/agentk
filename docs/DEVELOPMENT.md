# AgentK Development

## Scope

This repository owns the cluster-resident AcornOps agent, Kubernetes collectors, JSON-RPC/MCP tool bridge, active-passive leader election, and the workload-cluster Helm chart.

## Prerequisites

- Node.js compatible with `package.json`
- npm
- Optional: a Kubernetes cluster and kubeconfig for integration-style testing
- Helm for chart checks

## Local Development

Install dependencies:

```bash
npm install
```

Run the local mock-platform workflow:

```bash
docker compose up -d --build
```

Run the agent directly:

```bash
export ACORNOPS_AGENT_PLATFORM_URL=wss://api.acornops.dev/api/v1/agent/connect
export ACORNOPS_CLUSTER_ID=your-cluster-id
export ACORNOPS_AGENT_KEY=your-test-key
npm run dev
```

For full-stack local development:

```bash
cd ../acornops-deployment
task local-up
```

## Validation

Canonical validation:

```bash
npm run validate
```

Focused checks:

```bash
npm run lint
npm run test
npm run test:e2e
npm run helm:check
npm run contracts:check
npm run harness:check
npm run build
```

## Documentation Drift Control

Treat documentation as part of feature acceptance. Update the nearest durable doc in the same change when work changes agent behavior, JSON-RPC/MCP tools, chart values, configuration, deployment behavior, operations, security, or reliability.

If docs are intentionally unchanged, record `Docs impact: none` and the reason in handoff evidence.

## Documentation Harness

Keep `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `docs/index.md`, this file, and `docs/OPERATIONS.md` in sync when changing repo behavior. `npm run harness:check` enforces the required structure.
