import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { gunzipSync } from 'zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonRpcResponse } from './mcp/protocol.js';

vi.mock('./k8s/metrics.js', () => ({ checkMetricsApi: vi.fn().mockResolvedValue(false) }));

interface WireMessage {
  socket: WebSocket;
  isBinary: boolean;
  data: Buffer;
  parsed?: Record<string, unknown>;
}

async function waitForMessage(
  messages: WireMessage[],
  predicate: (message: WireMessage) => boolean,
  timeoutMs = 20000,
): Promise<WireMessage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const hit = messages.find(predicate);
    if (hit) {
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for websocket message');
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

describe('E2E Agent Lifecycle', () => {
  const expectedSocketsAfterReconnect = 2;
  const sockets: WebSocket[] = [];
  const messages: WireMessage[] = [];
  const servers: WebSocketServer[] = [];
  const managers: Array<{ stop: () => void }> = [];
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'agentk-e2e-'));
  const kubeconfig = join(fixtureDirectory, 'config');
  writeFileSync(kubeconfig, JSON.stringify({
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'fixture', cluster: { server: 'http://127.0.0.1:9' } }],
    contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
    users: [{ name: 'fixture', user: {} }], 'current-context': 'fixture',
  }));

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KUBECONFIG', kubeconfig);
    vi.stubEnv('ACORNOPS_AGENT_WATCH_CACHE_ENABLED', 'false');
    vi.stubEnv('ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT', 'true');
    vi.stubEnv('ACORNOPS_CLUSTER_ID', 'cluster-e2e');
    vi.stubEnv('ACORNOPS_AGENT_KEY', 'synthetic-only');
  });
  afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

  afterEach(async () => {
    managers.forEach((manager) => manager.stop());
    sockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    });
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    sockets.length = 0;
    messages.length = 0;
    servers.length = 0;
    managers.length = 0;
    vi.restoreAllMocks();
  });

  it('performs handshake, sends snapshots, serves tools, and reconnects', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind websocket test server');
    }

    vi.stubEnv('ACORNOPS_AGENT_PLATFORM_URL', `ws://127.0.0.1:${address.port}`);

    const [
      { LifecycleManager },
      { ResourceCollector },
      { MetricsCollector },
      { EventCollector },
      { mcpRouter },
    ] = await Promise.all([
      import('./core/lifecycle.js'),
      import('./core/collectors/resource-collector.js'),
      import('./core/collectors/metrics-collector.js'),
      import('./core/collectors/event-collector.js'),
      import('./mcp/router.js'),
    ]);
    vi.spyOn(ResourceCollector.prototype, 'collect').mockResolvedValue({ pods: [] });
    vi.spyOn(MetricsCollector.prototype, 'collect').mockResolvedValue({ available: false, pods: [], nodes: [] });
    vi.spyOn(EventCollector.prototype, 'collect').mockResolvedValue([]);

    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data, isBinary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let parsed: Record<string, unknown> | undefined;
        if (!isBinary) {
          parsed = JSON.parse(buffer.toString('utf-8')) as Record<string, unknown>;
        }
        messages.push({ socket, isBinary, data: buffer, parsed });
      });
    });

    const manager = new LifecycleManager();
    managers.push(manager);
    manager.start();

    const handshakeRequest = await waitForMessage(
      messages,
      (message) => !message.isBinary && message.parsed?.method === 'lifecycle/handshake',
    );
    expect(handshakeRequest.parsed?.params).toMatchObject({
      targetId: process.env.ACORNOPS_CLUSTER_ID,
      targetType: 'kubernetes',
      agentType: 'agentk',
      agentKey: process.env.ACORNOPS_AGENT_KEY,
    });

    const connection = handshakeRequest.socket;
    expect(connection).toBeDefined();
    const handshakeResponse = {
      jsonrpc: '2.0',
      id: 'handshake-1',
      result: {
        workspaceId: 'workspace-e2e',
        targetId: process.env.ACORNOPS_CLUSTER_ID,
        targetType: 'kubernetes',
        sessionPolicy: {
          allowedTools: [
            'list_resources',
            'get_resource',
            'get_resource_logs',
            'restart_workload',
            'scale_workload',
            'patch_workload',
            'patch_resource',
            'patch_configmap',
          ],
          writeEnabled: false,
        },
        config: {
          snapshotInterval: 10,
          maxSnapshotBytes: 1_000_000,
        },
      },
    };
    connection.send(JSON.stringify(handshakeResponse));

    const snapshotMessage = await waitForMessage(messages, (message) => message.isBinary);
    const snapshotPayload = JSON.parse(gunzipSync(snapshotMessage.data).toString('utf-8'));
    expect(snapshotPayload.method).toBe('notify/snapshot');
    expect(snapshotPayload.params?.data).toBeDefined();

    connection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-list-1',
      method: 'tools/list',
      params: {},
    }));
    const toolsListResponse = await waitForMessage(
      messages,
      (message) => !message.isBinary && message.parsed?.id === 'tools-list-1',
    );
    const listedTools = ((toolsListResponse.parsed?.result as { tools?: Array<{ name?: string }> })?.tools) || [];
    expect(listedTools.some((tool) => tool.name === 'list_resources')).toBe(true);
    expect(listedTools).toHaveLength(8);
    expect(listedTools.some((tool) => tool.name === 'patch_workload')).toBe(true);
    expect(listedTools.some((tool) => tool.name === 'patch_resource')).toBe(true);
    expect(listedTools.some((tool) => tool.name === 'patch_configmap')).toBe(true);
    expect(listedTools.some((tool) => tool.name === 'simulate_patch')).toBe(false);
    expect(listedTools.some((tool) => tool.name === 'apply_remediation')).toBe(false);

    connection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-call-1',
      method: 'tools/call',
      params: {
        name: 'apply_remediation',
        arguments: {},
      },
    }));
    const toolsCallResponse = await waitForMessage(
      messages,
      (message) => !message.isBinary && message.parsed?.id === 'tools-call-1',
    );
    expect((toolsCallResponse.parsed as { error?: { code?: number } }).error?.code).toBe(-32601);

    connection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-call-write-disabled',
      method: 'tools/call',
      params: { name: 'patch_workload', arguments: {} },
    }));
    const writeDisabledResponse = await waitForMessage(
      messages,
      (message) => !message.isBinary && message.parsed?.id === 'tools-call-write-disabled',
    );
    expect(writeDisabledResponse.parsed?.result).toMatchObject({
      isError: true,
      structuredContent: {
        schemaVersion: 'acornops.full-tool-result.v1',
        data: { code: 'WRITE_DISABLED', retryable: false },
      },
    });

    let finishReply!: (response: JsonRpcResponse) => void;
    const pendingReply = new Promise<JsonRpcResponse>((resolve) => { finishReply = resolve; });
    const route = vi.spyOn(mcpRouter, 'handleRequest').mockReturnValueOnce(pendingReply);
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'pending-reply', method: 'tools/list', params: {} }));
    await waitForCondition(() => route.mock.calls.length === 1);
    connection.close();
    await waitForCondition(() => sockets.length >= expectedSocketsAfterReconnect, 30000);

    const reconnectHandshake = await waitForMessage(
      messages,
      (message) => message.socket === sockets[1] && !message.isBinary && message.parsed?.method === 'lifecycle/handshake',
      30000,
    );
    expect(reconnectHandshake.parsed?.method).toBe('lifecycle/handshake');
    const replacement = reconnectHandshake.socket;
    replacement.send(JSON.stringify(handshakeResponse));
    await waitForMessage(messages, (message) => message.socket === replacement && message.isBinary);
    finishReply({ jsonrpc: '2.0', id: 'pending-reply', result: { old: true } });
    replacement.send(JSON.stringify({ jsonrpc: '2.0', id: 'fresh-reply', method: 'tools/list', params: {} }));
    await waitForMessage(messages, (message) => message.socket === replacement && message.parsed?.id === 'fresh-reply');
    expect(messages.some((message) => message.parsed?.id === 'pending-reply')).toBe(false);
    expect(route).toHaveBeenCalledTimes(2);

    // Leadership loss uses this same stop path and must leave the replica passive.
    manager.stop();
    await waitForCondition(() => replacement.readyState === WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(sockets).toHaveLength(2);
  }, 60000);

  it('reconnects when an upgraded peer withholds the application handshake', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    vi.stubEnv('ACORNOPS_AGENT_PLATFORM_URL', `ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data) => messages.push({
        socket, isBinary: false, data: Buffer.from(data as Buffer),
        parsed: JSON.parse(data.toString()),
      }));
    });
    const { LifecycleManager } = await import('./core/lifecycle.js');
    const manager = new LifecycleManager();
    managers.push(manager);
    manager.start();
    await waitForMessage(messages, (message) => message.parsed?.method === 'lifecycle/handshake');
    const started = performance.now();
    await waitForCondition(() => sockets[0]?.readyState === WebSocket.CLOSED, 12000);
    expect(performance.now() - started).toBeGreaterThan(9800);
    await waitForMessage(messages, (message) => message.socket === sockets[1] && message.parsed?.method === 'lifecycle/handshake', 2000);
    expect(messages.every((message) => message.parsed?.method === 'lifecycle/handshake')).toBe(true);
  }, 15000);
});
