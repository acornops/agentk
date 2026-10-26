# AgentK Quality Score

Assessment date: April 10, 2026.

Security follow-up (October 26, 2026): the [runtime dependency plan](exec-plans/completed/2026-10-26-runtime-dependency-security.md) records the earlier compatible patches. The independently reviewed [Zod 4 qualification](exec-plans/completed/runtime-validation-security.md) verifies early rejection for bounded arrays, input-schema compatibility, and a zero-advisory runtime audit. Publication and image-level release acceptance remain separate gates.

| Area | Score | Evidence | Main Gap |
| --- | --- | --- | --- |
| Control-plane contract alignment | 4/5 | Mirrored contract docs, manifests, repo checks | No replay harness for large degraded websocket sessions |
| Lifecycle reliability | 4/5 | Reconnect, handshake, heartbeat, and snapshot rules documented | More chaos-style reconnect coverage is still needed |
| Tool execution safety | 4/5 | Write gating, capability advertising, and tool metadata checks | More destructive-path validation coverage would help |
| Deployment safety | 3/5 | RBAC and deployment manifests exist, safety rules documented | More manifest regression checks would help |
| Harness knowledge base | 4/5 | AGENTS entry point, indexed docs tree, plan directories, quality/security/reliability docs | Freshness still depends on docs being updated with protocol changes |
