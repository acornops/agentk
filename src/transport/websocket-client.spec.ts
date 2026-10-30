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
    bufferedAmount = 0;
    ping = vi.fn();
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
      handshakeTimeout: 10000,
      closeTimeout: 1000,
      perMessageDeflate: false,
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
    expect(client.send('ignored')).toBe('not_open');
    expect(socketInstances[0]!.send).not.toHaveBeenCalled();

    socketInstances[0]!.readyState = MockWebSocket.OPEN;
    expect(client.isOpen()).toBe(true);

    expect(client.send('hello')).toBe('sent');
    expect(socketInstances[0]!.send).toHaveBeenCalledWith('hello', expect.any(Function));
  });

  it('admits exact byte limits and rejects the next byte without sending', () => {
    const client = new WebSocketClient('wss://platform.example/ws');
    client.connect();
    const socket = socketInstances[0]!;
    socket.readyState = MockWebSocket.OPEN;
    const maxFrame = 10 * 1024 * 1024;
    const maxBuffer = 16 * 1024 * 1024;

    expect(client.send(Buffer.alloc(maxFrame))).toBe('sent');
    expect(client.send(Buffer.alloc(maxFrame + 1))).toBe('too_large');
    expect(client.send('é'.repeat(maxFrame / 2))).toBe('sent');
    expect(client.send('é'.repeat(maxFrame / 2) + 'x')).toBe('too_large');
    expect(client.send(JSON.stringify({ result: 'x'.repeat(2 * 1024 * 1024) }))).toBe('sent');
    socket.bufferedAmount = maxBuffer - 2;
    expect(client.send('é')).toBe('sent');
    expect(client.send('éx')).toBe('backpressure');
    expect(socket.send).toHaveBeenCalledTimes(4);
  });

  it('revokes once on forced recovery without resetting the scheduled backoff', () => {
    const client = new WebSocketClient('wss://platform.example/ws');
    const closed = vi.fn();
    client.on('close', closed);
    client.connect();
    const old = socketInstances[0]!;
    client.forceReconnect();
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    client.forceReconnect();
    old.emit('close', 1006, Buffer.from('late'));
    vi.advanceTimersByTime(500);
    expect(socketInstances).toHaveLength(2);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('recovers from missing pongs and isolates stale socket events and send callbacks', () => {
    const client = new WebSocketClient('wss://platform.example/ws');
    const closed = vi.fn();
    client.on('close', closed);
    client.connect();
    const old = socketInstances[0]!;
    old.readyState = MockWebSocket.OPEN;
    old.emit('open');
    client.send('old reply');
    vi.advanceTimersByTime(30000);
    expect(old.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9999);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    const current = socketInstances[1]!;
    current.readyState = MockWebSocket.OPEN;
    current.emit('open');
    vi.advanceTimersByTime(30000);
    old.emit('pong');
    old.emit('error', new Error('stale error'));
    old.emit('close', 1006, Buffer.from('late'));
    old.send.mock.calls[0]![1](new Error('stale write failure'));
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(current.terminate).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('cancels only the current pong deadline and clears all timers on stop', () => {
    const client = new WebSocketClient('wss://platform.example/ws');
    client.connect();
    const socket = socketInstances[0]!;
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    vi.advanceTimersByTime(30000);
    socket.emit('pong');
    vi.advanceTimersByTime(10000);
    expect(socket.terminate).not.toHaveBeenCalled();
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(socketInstances).toHaveLength(1);
  });

  it.each(['callback', 'throw', 'ping'])('invalidates the owning socket on a %s failure', (failure) => {
    const client = new WebSocketClient('wss://platform.example/ws');
    const closed = vi.fn();
    client.on('close', closed);
    client.connect();
    const socket = socketInstances[0]!;
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    if (failure === 'throw') {
      socket.send.mockImplementationOnce(() => { throw new Error('write failed'); });
      expect(client.send('reply')).toBe('not_open');
    } else if (failure === 'callback') {
      client.send('reply');
      socket.send.mock.calls[0]![1](new Error('write failed'));
    } else {
      socket.bufferedAmount = 16 * 1024 * 1024;
      vi.advanceTimersByTime(30000);
      expect(socket.ping).not.toHaveBeenCalled();
    }
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
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
