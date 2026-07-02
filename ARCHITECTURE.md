# AgentK Architecture

The cluster agent is the cluster-resident execution edge for:

1. outbound-only connectivity to the control plane
2. telemetry snapshot collection
3. JSON-RPC tool execution
4. heartbeat and lifecycle reporting
5. safe cluster interaction with read/write gating

## High-Level Diagram

```mermaid
flowchart LR
    CP[control-plane websocket endpoint]
    Agent[AgentK]
    K8s[Kubernetes API]
    Tools[Built-in tools / MCP router]
    Snapshots[Snapshot pipeline]

    Agent -->|Outbound WebSocket| CP
    Agent --> K8s
    Agent --> Tools
    Agent --> Snapshots
    Tools --> K8s
    Snapshots --> K8s
```

## Detailed Diagram

```mermaid
flowchart TD
    subgraph Runtime[Agent Runtime]
        Entry[src/index.ts]
        Lifecycle[core/lifecycle.ts]
        WS[transport/websocket-client.ts]
        SnapshotMgr[core/snapshot-manager.ts]
    end

    subgraph Protocol[Command Protocol]
        Router[mcp/router.ts]
        ProtocolDefs[mcp/protocol.ts]
        ToolRegistry[tools/index.ts]
    end

    subgraph ClusterAccess[Kubernetes Access]
        K8sClients[k8s client modules]
        Metrics[k8s/metrics.ts]
        ToolImpls[tool implementations]
    end

    subgraph External[External Systems]
        CP[control-plane agent gateway]
        K8s[Kubernetes API server]
    end

    Entry --> Lifecycle
    Lifecycle --> WS
    Lifecycle --> SnapshotMgr
    Lifecycle --> Router
    Lifecycle --> Metrics
    Lifecycle --> ToolRegistry

    Router --> ProtocolDefs
    Router --> ToolImpls

    SnapshotMgr --> K8sClients
    ToolImpls --> K8sClients
    Metrics --> K8sClients

    WS -->|websocket json-rpc| CP
    K8sClients --> K8s
```

## Primary Responsibilities

1. connect to the control plane using an outbound-only websocket client
2. perform handshake, heartbeat, reconnect, and readiness coordination
3. collect snapshots from cluster resources and metrics APIs
4. execute control-plane-issued JSON-RPC tool calls
5. keep local state minimal and recover through reconnect + re-handshake
