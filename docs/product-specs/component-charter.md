# AgentK Component Charter

## Responsibilities

- Connect to the control plane through an outbound websocket.
- Collect cluster telemetry and send snapshots.
- Execute control-plane-issued JSON-RPC tool calls.
- Enforce local write gating and least-privilege cluster interaction.

## Non-Goals

- Browser or control-plane UI concerns
- Direct model inference
- Long-lived local state beyond reconnect recovery

## Primary Consumers

- Control plane
