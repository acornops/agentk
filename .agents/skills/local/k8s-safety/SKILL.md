---
name: acornops-k8s-safety
description: Enforce cluster safety for agentk changes involving RBAC, tool execution, websocket lifecycle, and snapshot collection. Use when modifying manifests, tool handlers, transport logic, or write-gated operations.
---

# Inputs

- changed RBAC/deployment manifests and TypeScript runtime modules
- expected write-gating behavior (`ACORNOPS_AGENT_WRITE_ENABLED`)
- websocket handshake and reconnection expectations

# Procedure

1. Review permission changes for least-privilege compliance.
2. Verify write operations remain explicit and safely scoped.
3. Validate websocket handshake, heartbeat, and reconnect behavior.
4. Validate snapshot path remains bounded and actionable.
5. Run lint and relevant unit/e2e checks.

# Outputs

- cluster safety review summary
- RBAC and tool risk checklist
- required operational safeguards
