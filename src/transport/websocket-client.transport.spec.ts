import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { WebSocketClient } from './websocket-client.js';
import { MAX_OUTBOUND_BUFFER_BYTES } from './limits.js';

vi.mock('../config.js', () => ({
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'silent', ACORNOPS_AGENT_KEY: 'synthetic-only',
    ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES: 1024 * 1024, CONNECTOR_VERSION: 'test',
  },
}));

describe('WebSocketClient real transport', () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const clients: WebSocketClient[] = [];
  const peers: WebSocketServer[] = [];

  afterEach(async () => {
    clients.forEach((client) => client.close());
    sockets.forEach((socket) => socket.destroy());
    await Promise.all(peers.map((peer) => new Promise<void>((resolve) => peer.close(() => resolve()))));
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    clients.length = 0;
    peers.length = 0;
    servers.length = 0;
    sockets.clear();
  });

  async function fixture(autoPong?: boolean) {
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new WebSocketClient(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    clients.push(client);
    client.on('error', () => {});
    if (autoPong === undefined) return { server, client };
    const peer = new WebSocketServer({ server, autoPong });
    peers.push(peer);
    return { server, client, peer };
  }

  it('times out a peer that accepts TCP but never upgrades, then reconnects', async () => {
    const { server, client } = await fixture();
    let upgrades = 0;
    server.on('upgrade', () => { upgrades++; });
    const closed = vi.fn();
    client.on('close', closed);
    const started = performance.now();
    client.connect();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 12000, interval: 25 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
    await vi.waitFor(() => expect(upgrades).toBe(2), { timeout: 2000 });
    expect(client.isOpen()).toBe(false);
  }, 15000);

  it('recovers from a peer that stops answering pings', async () => {
    const { client, peer } = await fixture(false);
    const connected = once(peer!, 'connection');
    const opened = once(client, 'open');
    client.connect();
    const [socket] = await connected as [WebSocket];
    await opened;
    const ping = vi.fn();
    socket.on('ping', ping);
    const closed = vi.fn();
    client.on('close', closed);
    const started = performance.now();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 42000, interval: 50 });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(39900);
    await vi.waitFor(() => expect(client.isOpen()).toBe(true), { timeout: 2000 });
  }, 45000);

  it('bounds actual buffering for a paused reader without queuing rejected sends', async () => {
    const { client, peer } = await fixture(true);
    const connected = once(peer!, 'connection');
    const opened = once(client, 'open');
    client.connect();
    const [socket] = await connected as [WebSocket];
    socket.pause();
    await opened;
    const transport = (client as unknown as { ws: WebSocket }).ws;
    const payload = Buffer.alloc(2 * 1024 * 1024);
    let rejected = false;
    // A finite 64 MiB offered ceiling makes a broken fixture fail without growing forever.
    for (let offered = 0; offered < 64 * 1024 * 1024; offered += payload.length) {
      if (client.send(payload) === 'backpressure') {
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(transport.bufferedAmount).toBeGreaterThan(0);
    expect(transport.bufferedAmount).toBeLessThanOrEqual(MAX_OUTBOUND_BUFFER_BYTES);
    const buffered = transport.bufferedAmount;
    expect(client.send(payload)).toBe('backpressure');
    expect(transport.bufferedAmount).toBe(buffered);
    expect(client.isOpen()).toBe(true);
  }, 15000);

  it('bounds normal close when the peer never acknowledges and does not reconnect', async () => {
    const { client, peer } = await fixture(true);
    const connected = once(peer!, 'connection');
    const opened = once(client, 'open');
    client.connect();
    const [socket] = await connected as [WebSocket];
    socket.pause();
    await opened;
    const transport = (client as unknown as { ws: WebSocket }).ws;
    const closed = once(transport, 'close');
    const started = performance.now();
    client.close();
    await closed;
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(client.isOpen()).toBe(false);
    expect((client as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  }, 5000);

  it('keeps a standalone process alive until it reconnects, then exits after stop', async () => {
    const { server } = await fixture(true);
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { WebSocketClient } from ${JSON.stringify(new URL('./websocket-client.ts', import.meta.url).href)};
      const client = new WebSocketClient(process.env.ACORNOPS_AGENT_PLATFORM_URL);
      let connections = 0;
      client.on('error', () => {});
      client.on('open', () => {
        if (++connections === 1) client.forceReconnect();
        else { console.log('recovered'); client.close(); }
      });
      client.connect();
    `], {
      env: {
        ...process.env, ACORNOPS_AGENT_PLATFORM_URL: url,
        ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT: 'true', ACORNOPS_CLUSTER_ID: 'fixture',
        ACORNOPS_AGENT_KEY: 'synthetic-only', ACORNOPS_AGENT_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const exited = once(child, 'exit');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
    try {
      const [code] = await exited;
      expect(output.trim()).toBe('recovered');
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 5000);
});
