import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  MockWebSocketClient,
  MockSnapshotManager,
  clientInstances,
  snapshotManagerInstances,
  checkMetricsApi,
  registerAllTools,
  handleRequest,
  MockWatchManager,
  watchManagerInstances,
} = vi.hoisted(() => {
  class SimpleEmitter {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    on(event: string, listener: (...args: any[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: any[]): boolean {
      const handlers = this.listeners.get(event) ?? [];
      handlers.forEach((listener) => listener(...args));
      return handlers.length > 0;
    }
  }

  const clientInstances: Array<InstanceType<typeof MockWebSocketClient>> = [];
  const snapshotManagerInstances: Array<InstanceType<typeof MockSnapshotManager>> = [];
  const checkMetricsApi = vi.fn();
  const registerAllTools = vi.fn();
  const handleRequest = vi.fn();
  const watchManagerInstances: any[] = [];

  class MockWebSocketClient extends SimpleEmitter {
    connect = vi.fn();
    send = vi.fn();
    close = vi.fn();
    forceReconnect = vi.fn();
    markReady = vi.fn();
    isOpen = vi.fn(() => true);

    constructor(readonly url: string) {
      super();
      clientInstances.push(this);
    }
  }

  class MockSnapshotManager {
    start = vi.fn();
    stop = vi.fn();
    triggerSnapshot = vi.fn();

    constructor(readonly onSnapshot: (payload: Buffer | string) => void) {
      snapshotManagerInstances.push(this);
    }
  }

  class MockWatchManager {
    start = vi.fn();
    stop = vi.fn();
    restart = vi.fn();

    constructor() {
      watchManagerInstances.push(this);
    }
  }

  return {
    MockWebSocketClient,
    MockSnapshotManager,
    clientInstances,
    snapshotManagerInstances,
    checkMetricsApi,
    registerAllTools,
    handleRequest,
    MockWatchManager,
    watchManagerInstances,
  };
});

vi.mock('../config.js', () => ({
  DEFAULT_EXCLUDED_NAMESPACES: ['kube-node-lease', 'kube-public'],
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'info',
    ACORNOPS_AGENT_PLATFORM_URL: 'wss://platform.example/ws',
    ACORNOPS_CLUSTER_ID: 'cluster-1',
    TARGET_ID: 'cluster-1',
    ACORNOPS_AGENT_KEY: 'agent-key',
    AGENT_VERSION: '1.2.3',
    ACORNOPS_AGENT_WRITE_ENABLED: true,
    ACORNOPS_AGENT_WATCH_NAMESPACES: ['team-a'],
    ACORNOPS_AGENT_HANDSHAKE_PROBE_TIMEOUT_MS: 5000,
  },
}));
vi.mock('../transport/websocket-client.js', () => ({ WebSocketClient: MockWebSocketClient }));
vi.mock('./snapshot-manager.js', () => ({ SnapshotManager: MockSnapshotManager }));
vi.mock('./watch/watch-manager.js', () => ({ WatchManager: MockWatchManager }));
vi.mock('../k8s/metrics.js', () => ({ checkMetricsApi }));
vi.mock('../mcp/router.js', () => ({ mcpRouter: { handleRequest } }));
vi.mock('../tools/index.js', () => ({ registerAllTools }));

import { LifecycleManager } from './lifecycle.js';

describe('LifecycleManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    clientInstances.length = 0;
    snapshotManagerInstances.length = 0;
    watchManagerInstances.length = 0;
    checkMetricsApi.mockResolvedValue(true);
    handleRequest.mockResolvedValue({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('registers tools and starts the websocket client', () => {
    const lifecycle = new LifecycleManager();

    expect(registerAllTools).toHaveBeenCalledTimes(1);

    lifecycle.start();
    expect(clientInstances[0]!.connect).toHaveBeenCalledTimes(1);
  });

  it('sends a handshake request when the socket opens', () => {
    checkMetricsApi.mockReturnValue(new Promise(() => {}));
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit('open');

    expect(checkMetricsApi).toHaveBeenCalledTimes(1);
    expect(clientInstances[0]!.send).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(clientInstances[0]!.send.mock.calls[0]![0]);
    expect(payload).toEqual({
      jsonrpc: '2.0',
      id: 'handshake-1',
      method: 'lifecycle/handshake',
      params: {
        targetId: 'cluster-1',
        targetType: 'kubernetes',
        agentType: 'k8s_agent',
        agentKey: 'agent-key',
        version: '1.2.3',
        agentVersion: '1.2.3',
        supportedCapabilities: ['read', 'write'],
        clusterFeatures: {
          metricsApiAvailable: false,
          rbacMode: 'namespace',
        },
      },
    });
  });

  it('handles handshake success, starts snapshots, and emits heartbeats while open', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-1',
        result: {
          workspaceId: 'ws-1',
          targetId: 'cluster-1',
          targetType: 'kubernetes',
          config: {
            snapshotInterval: 15,
            maxSnapshotBytes: 2048,
          },
        },
      })
    );

    await Promise.resolve();

    expect(clientInstances[0]!.markReady).toHaveBeenCalledTimes(1);
    expect(watchManagerInstances[0]!.start).toHaveBeenCalledTimes(1);
    expect(snapshotManagerInstances[0]!.start).toHaveBeenCalledWith(15, 2048);

    vi.advanceTimersByTime(30000);

    expect(clientInstances[0]!.send).toHaveBeenCalledTimes(1);
    const heartbeat = JSON.parse(clientInstances[0]!.send.mock.calls[0]![0]);
    expect(heartbeat.jsonrpc).toBe('2.0');
    expect(heartbeat.method).toBe('lifecycle/heartbeat');
    expect(typeof heartbeat.params.timestamp).toBe('string');
  });

  it('rejects handshake responses for a different target scope', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-1',
        result: {
          workspaceId: 'ws-1',
          targetId: 'vm-1',
          targetType: 'virtual_machine',
          config: {
            snapshotInterval: 15,
          },
        },
      })
    );

    await Promise.resolve();

    expect(clientInstances[0]!.forceReconnect).toHaveBeenCalledTimes(1);
    expect(clientInstances[0]!.markReady).not.toHaveBeenCalled();
    expect(snapshotManagerInstances[0]!.start).not.toHaveBeenCalled();
  });

  it('routes JSON-RPC requests through the MCP router and returns responses', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit(
      'message',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }))
    );

    await Promise.resolve();

    expect(handleRequest).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: {},
    });
    expect(clientInstances[0]!.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    );
  });

  it('applies pre-handshake namespace scope updates without starting watches', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit(
      'message',
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'scope-1',
        method: 'config/update_namespace_scope',
        params: {
          namespaceScope: {
            include: ['default', 'payments'],
            exclude: ['payments']
          }
        }
      }))
    );

    await Promise.resolve();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(watchManagerInstances[0]!.restart).not.toHaveBeenCalled();
    expect(snapshotManagerInstances[0]!.triggerSnapshot).not.toHaveBeenCalled();
    expect(clientInstances[0]!.send).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'scope-1',
        result: {
          namespaceScope: {
            include: ['default', 'payments'],
            exclude: ['payments']
          },
          rbacMode: 'namespace'
        }
      })
    );
  });

  it('restarts watches for post-handshake namespace scope updates', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 'handshake-1',
      result: { workspaceId: 'ws-1', targetId: 'cluster-1', targetType: 'kubernetes', config: {} },
    }));
    await Promise.resolve();

    clientInstances[0]!.emit(
      'message',
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'scope-1',
        method: 'config/update_namespace_scope',
        params: {
          namespaceScope: {
            include: ['default', 'payments'],
            exclude: ['payments']
          }
        }
      }))
    );

    await Promise.resolve();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(watchManagerInstances[0]!.start).toHaveBeenCalledTimes(1);
    expect(watchManagerInstances[0]!.restart).toHaveBeenCalledTimes(1);
    expect(snapshotManagerInstances[0]!.triggerSnapshot).toHaveBeenCalledTimes(1);
  });

  it('forces reconnect on handshake failure and stops snapshots on close', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-1',
        error: { code: -32000, message: 'denied' },
      })
    );

    await Promise.resolve();

    expect(clientInstances[0]!.forceReconnect).toHaveBeenCalledTimes(1);
    expect(snapshotManagerInstances[0]!.start).not.toHaveBeenCalled();

    clientInstances[0]!.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 'handshake-1',
      result: { workspaceId: 'ws-1', targetId: 'cluster-1', targetType: 'kubernetes', config: {} },
    }));
    await Promise.resolve();
    clientInstances[0]!.emit('close');

    expect(snapshotManagerInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(watchManagerInstances[0]!.stop).toHaveBeenCalledTimes(1);

    const sendCount = clientInstances[0]!.send.mock.calls.length;
    vi.advanceTimersByTime(30000);
    expect(clientInstances[0]!.send).toHaveBeenCalledTimes(sendCount);
  });

  it('stops the active runtime and fences stale callbacks', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.start();

    clientInstances[0]!.emit('open');
    expect(clientInstances[0]!.send).toHaveBeenCalledTimes(1);

    lifecycle.stop();

    expect(snapshotManagerInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(watchManagerInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(clientInstances[0]!.close).toHaveBeenCalledTimes(1);

    clientInstances[0]!.emit('open');
    clientInstances[0]!.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 'handshake-1',
      result: { workspaceId: 'ws-1', targetId: 'cluster-1', targetType: 'kubernetes', config: {} },
    }));
    await Promise.resolve();
    vi.advanceTimersByTime(30000);

    expect(snapshotManagerInstances[0]!.start).not.toHaveBeenCalled();
    expect(clientInstances[0]!.send).toHaveBeenCalledTimes(1);
  });
});
