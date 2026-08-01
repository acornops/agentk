import WebSocket from 'ws';
import pino from 'pino';
import { config } from '../config.js';
import { EventEmitter } from 'events';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'websocket' });

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

    logger.info({ url: this.url }, 'Connecting to platform...');
    const socket = new WebSocket(this.url, {
      maxPayload: config.ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES,
      headers: {
        'x-agent-key': config.ACORNOPS_AGENT_KEY,
        'x-connector-version': `agentk/${config.CONNECTOR_VERSION}`,
      },
    });
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket || this.stopped) return;
      logger.info('WebSocket connection established');
      this.emit('open');
    });

    socket.on('message', (data: WebSocket.Data) => {
      if (this.ws !== socket || this.stopped) return;
      this.emit('message', data);
    });

    socket.on('close', (code, reason) => {
      if (this.ws !== socket) return;
      logger.warn({ code, reason: reason.toString() }, 'WebSocket connection closed');
      this.ws = null;
      this.emit('close');
      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      if (this.ws !== socket || this.stopped) return;
      logger.error({ err }, 'WebSocket error');
      this.emit('error', err);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const baseDelay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, this.maxReconnectDelay);
    // Equal jitter prevents a control-plane recovery from reconnecting every agent at once.
    const delay = Math.round((baseDelay / 2) + (Math.random() * baseDelay / 2));
    this.reconnectAttempts++;

    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnection...');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Sends data over the WebSocket if the connection is open.
   * @param data The payload to send.
   */
  public send(data: string | Buffer): void {
    if (!this.stopped && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      logger.warn('Cannot send message: WebSocket not open');
    }
  }

  /**
   * Gracefully closes the WebSocket connection and prevents reconnection.
   */
  public close(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  /** Terminate the current socket and schedule a reconnect. */
  public forceReconnect(): void {
    if (this.stopped) return;

    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }

    this.scheduleReconnect();
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
