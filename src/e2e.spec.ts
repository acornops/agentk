import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { gunzipSync } from 'zlib';

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
  });

  it('performs handshake, sends snapshots, serves tools, and reconnects', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind websocket test server');
    }

    process.env.ACORNOPS_AGENT_PLATFORM_URL = `ws://127.0.0.1:${address.port}`;
    process.env.ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT = 'true';
    process.env.ACORNOPS_CLUSTER_ID = process.env.ACORNOPS_CLUSTER_ID || 'cluster-e2e';
    process.env.ACORNOPS_AGENT_KEY = process.env.ACORNOPS_AGENT_KEY || 'test-key';
    process.env.ACORNOPS_AGENT_KUBECONFIG_SKIP_TLS_VERIFY = 'true';
    process.env.ACORNOPS_AGENT_LOG_LEVEL = process.env.ACORNOPS_AGENT_LOG_LEVEL || 'warn';

    const { LifecycleManager } = await import('./core/lifecycle.js');

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
    connection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'handshake-1',
      result: {
        workspaceId: 'workspace-e2e',
        targetId: process.env.ACORNOPS_CLUSTER_ID,
        targetType: 'kubernetes',
        config: {
          snapshotInterval: 10,
          maxSnapshotBytes: 1_000_000,
        },
      },
    }));

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

    connection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-call-1',
      method: 'tools/call',
      params: {
        name: 'apply_remediation',
        arguments: {
          remediationId: 'remediation-e2e',
          steps: [
            {
              tool: 'wait',
              arguments: {
                seconds: 0,
              },
            },
          ],
        },
      },
    }));
    const toolsCallResponse = await waitForMessage(
      messages,
      (message) => !message.isBinary && message.parsed?.id === 'tools-call-1',
    );
    expect((toolsCallResponse.parsed as { error?: unknown }).error).toBeUndefined();
    expect((toolsCallResponse.parsed?.result as { remediationId?: string }).remediationId).toBe('remediation-e2e');

    connection.close();
    await waitForCondition(() => sockets.length >= expectedSocketsAfterReconnect, 30000);

    const reconnectHandshake = await waitForMessage(
      messages,
      (message) => message.socket === sockets[1] && !message.isBinary && message.parsed?.method === 'lifecycle/handshake',
      30000,
    );
    expect(reconnectHandshake.parsed?.method).toBe('lifecycle/handshake');
  }, 60000);
});
