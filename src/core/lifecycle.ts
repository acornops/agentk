import pino from 'pino';
import { config } from '../config.js';
import { WebSocketClient } from '../transport/websocket-client.js';
import {
    createRequest,
    createNotification,
    JsonRpcRequest,
    JsonRpcRequestSchema,
    JsonRpcResponse,
    JsonRpcNotification,
    JsonRpcNotificationSchema,
    JsonRpcIdSchema,
    createResponse,
    createErrorResponse,
    RPC_ERRORS
} from '../mcp/protocol.js';
import { checkMetricsApi } from '../k8s/metrics.js';
import { mcpRouter } from '../mcp/router.js';
import { SnapshotManager } from './snapshot-manager.js';
import { registerAllTools } from '../tools/index.js';
import { clearRemoteNamespaceScope, isNamespaceScoped, NamespaceScope, setNamespaceScope } from '../runtime/namespace-scope.js';
import { WatchStore } from './watch/watch-store.js';
import { WatchManager } from './watch/watch-manager.js';
import { ResourceCollector } from './collectors/resource-collector.js';
import { MetricsCollector } from './collectors/metrics-collector.js';
import { EventCollector } from './collectors/event-collector.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'lifecycle' });
const KUBERNETES_TARGET_TYPE = 'kubernetes' as const;

/** Normalize inbound WebSocket payload data to UTF-8 text. */
function normalizeIncomingData(data: Buffer | string | ArrayBuffer | Buffer[]): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf-8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf-8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf-8');
  }
  return Buffer.from(data as unknown as ArrayBufferLike).toString('utf-8');
}

/**
 * Manages the high-level lifecycle of the agent, including handshake,
 * heartbeats, and message dispatching.
 */
export class LifecycleManager {
  private client: WebSocketClient;
  private snapshotManager: SnapshotManager;
  private watchStore: WatchStore;
  private watchManager: WatchManager;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private metricsApiAvailable = false;
  private running = false;
  private sessionReady = false;
  private runtimeGeneration = 0;

  /** Initialize lifecycle orchestration and platform event handlers. */
  constructor() {
    this.client = new WebSocketClient(config.ACORNOPS_AGENT_PLATFORM_URL);
    this.watchStore = new WatchStore();
    this.watchManager = new WatchManager(this.watchStore, () => this.snapshotManager.triggerSnapshot());
    this.snapshotManager = new SnapshotManager(
      (payload) => this.sendOutbound(payload),
      undefined,
      [
        new ResourceCollector(this.watchStore),
        new MetricsCollector(),
        new EventCollector(this.watchStore),
      ]
    );

    registerAllTools();

    this.client.on('open', () => this.handleOpen());
    this.client.on('message', (data) => this.handleMessage(data));
    this.client.on('close', () => this.handleClose());
    this.client.on('error', (err) => {
        logger.error({ err }, 'WebSocket error occurred');
    });
  }

  /**
   * Starts the agent by initiating a connection to the platform.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.runtimeGeneration++;
    this.clearAuthenticatedSession(false);
    logger.info('Starting active agent runtime');
    this.client.connect();
  }

  /** Stop the active agent runtime and close platform connections. */
  public stop(): void {
    if (!this.running) return;
    this.running = false;
    this.runtimeGeneration++;
    this.clearAuthenticatedSession();
    logger.info('Stopping active agent runtime');
    this.client.close();
  }

  /** Return whether the active runtime is currently running. */
  public isRunning(): boolean {
    return this.running;
  }

  private refreshMetricsAvailability(): void {
    let settled = false;
    const timeoutMs = config.ACORNOPS_AGENT_HANDSHAKE_PROBE_TIMEOUT_MS;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { timeoutMs },
        'Metrics API probe timed out; keeping metrics disabled for this connection'
      );
    }, timeoutMs);

    void checkMetricsApi()
      .then((available) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.metricsApiAvailable = available;
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.warn({ err }, 'Metrics API probe failed; keeping metrics disabled');
      });
  }

  /**
   * Performs the initial handshake with the platform upon connection.
   */
  private async handleOpen(): Promise<void> {
    if (!this.running) return;
    this.runtimeGeneration++;
    this.clearAuthenticatedSession(false);
    logger.info('Performing handshake...');
    this.refreshMetricsAvailability();

    const handshake = createRequest('lifecycle/handshake', {
      targetId: config.TARGET_ID,
      targetType: KUBERNETES_TARGET_TYPE,
      agentType: 'agentk',
      agentKey: config.ACORNOPS_AGENT_KEY,
      version: config.AGENT_VERSION,
      agentVersion: config.AGENT_VERSION,
      supportedCapabilities: config.ACORNOPS_AGENT_WRITE_ENABLED ? ['read', 'write'] : ['read'],
      clusterFeatures: {
        metricsApiAvailable: this.metricsApiAvailable,
        rbacMode: isNamespaceScoped() ? 'namespace' : 'cluster-wide',
      }
    }, 'handshake-1');

    this.sendOutbound(JSON.stringify(handshake));
  }

  private async handleMessage(data: Buffer | string | ArrayBuffer | Buffer[]): Promise<void> {
    if (!this.running) return;
    try {
      const message = JSON.parse(normalizeIncomingData(data));
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Invalid JSON-RPC payload');
      }
      logger.debug({ id: message?.id, method: message?.method }, 'Received JSON-RPC message');

      if (message.id === 'handshake-1' && !this.sessionReady) {
        this.handleHandshakeResponse(message);
        return;
      }

      if ('method' in message && 'id' in message) {
        const requestResult = JsonRpcRequestSchema.safeParse(message);
        if (!requestResult.success) {
          const responseId = JsonRpcIdSchema.safeParse(message.id);
          this.sendOutbound(JSON.stringify(createErrorResponse(
            responseId.success ? responseId.data : null,
            RPC_ERRORS.INVALID_REQUEST,
            'Invalid JSON-RPC request'
          )));
          return;
        }
        const request = requestResult.data;
        if (request.method === 'config/update_namespace_scope') {
          if (!this.sessionReady) {
            this.sendOutbound(JSON.stringify(createErrorResponse(
              request.id,
              -32001,
              'Tool session is not ready',
              { code: 'TOOL_NOT_ALLOWED' }
            )));
            return;
          }
          const response = this.handleNamespaceScopeUpdate(request);
          this.sendOutbound(JSON.stringify(response));
          return;
        }
        // Request
        const response = await mcpRouter.handleRequest(request);
        this.sendOutbound(JSON.stringify(response));
      } else if ('method' in message) {
        const notification = JsonRpcNotificationSchema.safeParse(message);
        if (!notification.success) throw new Error('Invalid JSON-RPC notification');
        this.handleNotification(notification.data);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to handle message');
    }
  }

  private handleHandshakeResponse(response: JsonRpcResponse): void {
    if (!this.running) return;
    if (response.error) {
      this.clearAuthenticatedSession();
      logger.error({ code: response.error.code }, 'Handshake failed');
      this.client.forceReconnect();
      return;
    }

    const result = response.result as {
      workspaceId?: unknown;
      targetId?: unknown;
      targetType?: unknown;
      sessionPolicy?: {
        allowedTools?: unknown;
        writeEnabled?: unknown;
      };
      config?: {
        namespaceScope?: Partial<NamespaceScope>;
        snapshotInterval?: number;
        maxSnapshotBytes?: number;
      };
    } | undefined;
    if (
      response.jsonrpc !== '2.0' ||
      !result ||
      typeof result.workspaceId !== 'string' ||
      result.workspaceId.trim().length === 0 ||
      result.targetId !== config.TARGET_ID ||
      result.targetType !== KUBERNETES_TARGET_TYPE ||
      !result.sessionPolicy ||
      !Array.isArray(result.sessionPolicy.allowedTools) ||
      result.sessionPolicy.allowedTools.length > 64 ||
      !result.sessionPolicy.allowedTools.every((name): name is string => typeof name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(name)) ||
      new Set(result.sessionPolicy.allowedTools).size !== result.sessionPolicy.allowedTools.length ||
      typeof result.sessionPolicy.writeEnabled !== 'boolean' ||
      (result.config !== undefined && (!result.config || typeof result.config !== 'object' || Array.isArray(result.config))) ||
      (result.config?.snapshotInterval !== undefined && (!Number.isInteger(result.config.snapshotInterval) || result.config.snapshotInterval <= 0)) ||
      (result.config?.maxSnapshotBytes !== undefined && (!Number.isInteger(result.config.maxSnapshotBytes) || result.config.maxSnapshotBytes <= 0 || result.config.maxSnapshotBytes > 10 * 1024 * 1024))
    ) {
      logger.error(
        {
          expectedTargetId: config.TARGET_ID,
          receivedTargetId: result?.targetId,
          receivedTargetType: result?.targetType
        },
        'Handshake response contract rejected'
      );
      this.clearAuthenticatedSession();
      this.client.forceReconnect();
      return;
    }

    const { workspaceId, targetId, targetType, sessionPolicy, config: remoteConfig } = result;

    if (remoteConfig?.namespaceScope !== undefined) {
      try {
        setNamespaceScope(remoteConfig.namespaceScope);
      } catch {
        logger.error('Handshake response contained an invalid namespace scope');
        this.clearAuthenticatedSession();
        this.client.forceReconnect();
        return;
      }
    }

    mcpRouter.setSessionPolicy({
      allowedTools: new Set(sessionPolicy!.allowedTools as string[]),
      writeEnabled: Boolean(sessionPolicy!.writeEnabled),
      generation: this.runtimeGeneration,
    });

    logger.info({ workspaceId, targetId, targetType }, 'Handshake successful');
    this.client.markReady();

    if (!this.running) return;
    this.sessionReady = true;
    this.watchManager.start();
    this.snapshotManager.start(remoteConfig?.snapshotInterval ?? 60, remoteConfig?.maxSnapshotBytes);
    this.startHeartbeat();
  }

  private handleNotification(notification: JsonRpcNotification): void {
      logger.debug({ method: notification.method }, 'Received notification');
      // Handle potential remote config changes here
  }

  private handleNamespaceScopeUpdate(request: JsonRpcRequest): JsonRpcResponse {
    try {
      if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params) || !('namespaceScope' in request.params)) {
        throw new Error('namespaceScope is required');
      }
      const scope = setNamespaceScope((request.params as { namespaceScope: unknown }).namespaceScope);
      logger.info({ scope }, 'Updated namespace scope from control plane');
      if (this.running && this.sessionReady) {
        this.watchManager.restart();
        this.snapshotManager.triggerSnapshot();
      }
      return createResponse(request.id, {
        namespaceScope: scope,
        rbacMode: isNamespaceScoped() ? 'namespace' : 'cluster-wide'
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update namespace scope';
      return createErrorResponse(request.id, RPC_ERRORS.INVALID_PARAMS, message);
    }
  }

  private handleClose(): void {
    if (!this.running) return;
    this.runtimeGeneration++;
    this.clearAuthenticatedSession();
  }

  private clearAuthenticatedSession(stopServices = true): void {
    this.sessionReady = false;
    mcpRouter.clearSessionPolicy();
    clearRemoteNamespaceScope();
    if (stopServices) {
      this.snapshotManager.stop();
      this.watchManager.stop();
      this.stopHeartbeat();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    const generation = this.runtimeGeneration;
    this.heartbeatInterval = setInterval(() => {
      if (this.running && generation === this.runtimeGeneration && this.client.isOpen()) {
        const heartbeat = createNotification('lifecycle/heartbeat', {
          timestamp: new Date().toISOString(),
        });
        this.sendOutbound(JSON.stringify(heartbeat));
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendOutbound(payload: string | Buffer): void {
    if (!this.running) return;
    this.client.send(payload);
  }
}
