import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MockWebSocket, socketInstances } = vi.hoisted(() => {
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

  const socketInstances: Array<InstanceType<typeof MockWebSocket>> = [];

  class MockWebSocket extends SimpleEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly CLOSE_NORMAL = 1000;
    static readonly CLOSE_ABNORMAL = 1006;

    readonly url: string;
    readonly options: Record<string, unknown>;
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', MockWebSocket.CLOSE_NORMAL, Buffer.from('closed'));
    });
    terminate = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', MockWebSocket.CLOSE_ABNORMAL, Buffer.from('terminated'));
    });

    constructor(url: string, options: Record<string, unknown>) {
      super();
      this.url = url;
      this.options = options;
      socketInstances.push(this);
    }
  }

  return { MockWebSocket, socketInstances };
});

vi.mock('ws', () => ({ default: MockWebSocket }));
vi.mock('../config.js', () => ({
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'info',
    ACORNOPS_AGENT_KEY: 'agent-key',
    ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES: 1024 * 1024,
    CONNECTOR_VERSION: '1.2.3',
  },
}));

import { WebSocketClient } from './websocket-client.js';

describe('WebSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    socketInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('connects with agent headers and re-emits socket events', () => {
    const client = new WebSocketClient('wss://platform.example/ws');
    const openSpy = vi.fn();
    const messageSpy = vi.fn();
    const errorSpy = vi.fn();

    client.on('open', openSpy);
    client.on('message', messageSpy);
    client.on('error', errorSpy);

    client.connect();

    expect(socketInstances).toHaveLength(1);
    expect(socketInstances[0]?.url).toBe('wss://platform.example/ws');
    expect(socketInstances[0]?.options).toEqual({
      maxPayload: 1024 * 1024,
      headers: {
        'x-agent-key': 'agent-key',
        'x-connector-version': 'agentk/1.2.3',
      },
    });

    const socket = socketInstances[0]!;
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    socket.emit('message', Buffer.from('payload'));
    const error = new Error('boom');
    socket.emit('error', error);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(messageSpy).toHaveBeenCalledWith(Buffer.from('payload'));
    expect(errorSpy).toHaveBeenCalledWith(error);
  });

  it('uses exponential reconnect backoff and resets attempts after markReady', () => {
    const client = new WebSocketClient('wss://platform.example/ws');

    client.connect();
    socketInstances[0]!.emit('close', 1006, Buffer.from('down'));

    vi.advanceTimersByTime(999);
    expect(socketInstances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socketInstances).toHaveLength(2);

    client.markReady();
    socketInstances[1]!.emit('close', 1006, Buffer.from('down again'));

    vi.advanceTimersByTime(999);
    expect(socketInstances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socketInstances).toHaveLength(3);
  });

  it('caps reconnect delay at 15 seconds', () => {
    const client = new WebSocketClient('wss://platform.example/ws');

    client.connect();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
      socketInstances.at(-1)!.emit('close', 1006, Buffer.from('down'));
      vi.advanceTimersByTime(delay - 1);
      const count = socketInstances.length;
      vi.advanceTimersByTime(1);
      expect(socketInstances).toHaveLength(count + 1);
    }
  });

  it('sends only on open sockets and reports open state', () => {
    const client = new WebSocketClient('wss://platform.example/ws');

    client.connect();

    expect(client.isOpen()).toBe(false);
    client.send('ignored');
    expect(socketInstances[0]!.send).not.toHaveBeenCalled();

    socketInstances[0]!.readyState = MockWebSocket.OPEN;
    expect(client.isOpen()).toBe(true);

    client.send('hello');
    expect(socketInstances[0]!.send).toHaveBeenCalledWith('hello');
  });

  it('terminates active sockets on forceReconnect and suppresses reconnect after close', () => {
    const client = new WebSocketClient('wss://platform.example/ws');

    client.connect();
    const socket = socketInstances[0]!;

    client.forceReconnect();
    expect(socket.terminate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(socketInstances).toHaveLength(2);

    client.close();
    expect(socketInstances[1]!.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60000);
    expect(socketInstances).toHaveLength(2);
  });
});
