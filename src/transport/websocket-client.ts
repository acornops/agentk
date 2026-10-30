import WebSocket from 'ws';
import pino from 'pino';
import { config } from '../config.js';
import { EventEmitter } from 'events';
import {
  CLOSE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_OUTBOUND_BUFFER_BYTES,
  MAX_OUTBOUND_FRAME_BYTES, PING_INTERVAL_MS, PONG_TIMEOUT_MS,
} from './limits.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'websocket' });
export type SendResult = 'sent' | 'not_open' | 'backpressure' | 'too_large';
type CloseReason = 'peer_closed' | 'forced' | 'send_failed' | 'ping_failed' | 'pong_timeout' | 'backpressure';

/**
 * Manages the outbound WebSocket connection to the platform.
 * Handles automatic reconnection with exponential backoff.
 */
export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 15000;
  private url: string;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  /**
   * Creates a new WebSocketClient.
   * @param url The platform WSS endpoint URL.
   */
  constructor(url: string) {
    super();
    this.url = url;
  }

  /**
   * Initiates the WebSocket connection.
   */
  public connect(): void {
    this.stopped = false;
    this.clearReconnectTimer();
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

    logger.info('Connecting to platform...');
    // ws supports closeTimeout; the installed @types/ws version does not declare it yet.
    const options: WebSocket.ClientOptions & { closeTimeout: number } = {
      maxPayload: config.ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      closeTimeout: CLOSE_TIMEOUT_MS,
      perMessageDeflate: false,
      headers: {
        'x-agent-key': config.ACORNOPS_AGENT_KEY,
        'x-connector-version': `agentk/${config.CONNECTOR_VERSION}`,
      },
    };
    const socket = new WebSocket(this.url, options);
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket || this.stopped) return;
      logger.info('WebSocket connection established');
      this.startPing(socket);
      this.emit('open');
    });

    socket.on('message', (data: WebSocket.Data) => {
      if (this.ws !== socket || this.stopped) return;
      this.emit('message', data);
    });

    socket.on('close', (code) => {
      if (this.ws !== socket) return;
      this.invalidateSocket(socket, 'peer_closed', code);
    });

    socket.on('pong', () => {
      if (this.ws !== socket || this.stopped) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    socket.on('error', (err) => {
      if (this.ws !== socket || this.stopped) return;
      this.emit('error', err);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.ws || this.reconnectTimer) return;

    const baseDelay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
    // Equal jitter prevents a control-plane recovery from reconnecting every agent at once.
    const delay = Math.round((baseDelay / 2) + (Math.random() * baseDelay / 2));
    this.reconnectAttempts++;

    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnection...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
    // Keep standalone replicas alive while disconnected; close() clears this timer.
  }

  private invalidateSocket(socket: WebSocket, reason: CloseReason, code?: number): void {
    if (this.ws !== socket) return;
    this.ws = null;
    this.clearSocketTimers();
    logger.warn({ reason, code }, 'WebSocket connection invalidated');
    this.emit('close');
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    this.scheduleReconnect();
  }

  private startPing(socket: WebSocket): void {
    this.clearSocketTimers();
    this.pingInterval = setInterval(() => {
      if (this.ws !== socket || this.stopped || this.pongTimer) return;
      // An empty, masked ping occupies six bytes on the wire.
      if (socket.bufferedAmount + 6 > MAX_OUTBOUND_BUFFER_BYTES) {
        this.invalidateSocket(socket, 'backpressure');
        return;
      }
      this.pongTimer = setTimeout(() => this.invalidateSocket(socket, 'pong_timeout'), PONG_TIMEOUT_MS);
      this.pongTimer.unref();
      try {
        socket.ping(undefined, undefined, (err: Error | undefined) => {
          if (err) this.invalidateSocket(socket, 'ping_failed');
        });
      } catch {
        this.invalidateSocket(socket, 'ping_failed');
      }
    }, PING_INTERVAL_MS);
    this.pingInterval.unref();
  }

  private clearSocketTimers(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingInterval = null;
    this.pongTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Admits a bounded payload to ws; success does not confirm remote delivery.
   * @param data The payload to send.
   */
  public send(data: string | Buffer): SendResult {
    const socket = this.ws;
    if (this.stopped || !socket || socket.readyState !== WebSocket.OPEN) return 'not_open';
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_OUTBOUND_FRAME_BYTES) return 'too_large';
    if (socket.bufferedAmount + bytes > MAX_OUTBOUND_BUFFER_BYTES) return 'backpressure';
    try {
      socket.send(data, (err) => {
        if (err) this.invalidateSocket(socket, 'send_failed');
      });
      return 'sent';
    } catch {
      this.invalidateSocket(socket, 'send_failed');
      return 'not_open';
    }
  }

  /**
   * Gracefully closes the WebSocket connection and prevents reconnection.
   */
  public close(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearSocketTimers();
    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  /** Terminate the current socket and schedule a reconnect. */
  public forceReconnect(): void {
    if (this.stopped) return;

    if (this.ws) this.invalidateSocket(this.ws, 'forced');
  }

  /** Mark the current connection as ready and reset reconnect backoff. */
  public markReady(): void {
    this.reconnectAttempts = 0;
  }

  /** Return whether the current socket can send messages. */
  public isOpen(): boolean {
    return !this.stopped && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
