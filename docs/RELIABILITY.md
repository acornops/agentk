# AgentK Reliability

## Failure Modes

- Handshake or reconnect behavior regresses and leaves the agent disconnected.
- Snapshot collection or compression stalls or exceeds remote size budgets.
- Metrics or resource collectors fail noisily and block the lifecycle loop.
- Tool execution becomes inconsistent with advertised capabilities.

## Required Validation

- Run `npm run validate` for every substantive change.
- Run `npm test` when protocol, snapshot, or tool behavior changes.
- Run `npm run test:e2e` when lifecycle, websocket, or deploy-manifest behavior changes.
- Preserve stateless reconnect and capability-advertising semantics.

## Recovery Expectations

- Prefer explicit degraded behavior over silent data loss.
- Keep lifecycle loops bounded and retry-aware.
- Capture new protocol invariants in docs or checks when they become durable.
