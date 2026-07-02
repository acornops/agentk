# AgentK Security Model

## Trust Boundaries

- The agent connects outbound to the control plane and should not accept inbound control channels.
- Agent keys authenticate the cluster to the platform.
- Write capability advertisement and local write enablement must stay aligned.
- RBAC manifests are part of the security boundary.

## Secrets

- Never log agent keys or derived auth material.
- Keep `ACORNOPS_AGENT_WRITE_ENABLED` explicit and reviewable.
- Treat kubeconfig rewrites and local TLS-skip settings as development-only hazards.

## High-Risk Changes

- Handshake or websocket auth behavior
- RBAC manifest permissions
- Destructive tool implementations
- Snapshot payload handling and remote headers
