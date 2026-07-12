import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { canAccessClusterScopedKind, isNamespaceAllowed } from '../runtime/namespace-scope.js';
import { redactKubernetesResource } from './resource-redaction.js';
import { isKubernetesPreconditionFailure, ToolExecutionError } from './errors.js';
import { ToolCapability, ToolDefinition, toolRegistry } from './registry.js';

export interface ToolSessionPolicy {
  allowedTools: ReadonlySet<string>;
  writeEnabled: boolean;
  generation: number;
}

const LIST_RESULT_FIELDS = new Set(['continue_token']);

class AdmissionGate {
  private active = 0;
  private readonly queue: Array<{ resolve: () => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }> = [];

  /** Create a bounded concurrency gate. */
  constructor(private readonly concurrency: number, private readonly queueBudget: QueueBudget) {}

  /** Acquire a slot or enqueue within the configured bound. */
  async acquire(timeoutMs: number, timeoutData: Record<string, unknown>): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active++;
      return () => this.release();
    }
    if (!this.queueBudget.enter()) {
      throw new ToolExecutionError('TOOL_BUSY', 'Tool executor is busy; retry later');
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.queueBudget.leave();
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          this.queueBudget.leave();
          reject(new ToolExecutionError('TOOL_TIMEOUT', 'Tool timed out while waiting for an execution slot', timeoutData));
        }, timeoutMs),
      };
      this.queue.push(entry);
    });
    return () => this.release();
  }

  /** Reject queued calls and return their shared queue budget immediately. */
  cancelQueued(reason: ToolExecutionError): void {
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      clearTimeout(entry.timer);
      this.queueBudget.leave();
      entry.reject(reason);
    }
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.active--;
  }
}

class QueueBudget {
  private queued = 0;

  /** Create a process-local shared queue budget. */
  constructor(private readonly limit: number) {}

  /** Reserve one queue position when capacity remains. */
  enter(): boolean {
    if (this.queued >= this.limit) return false;
    this.queued++;
    return true;
  }

  /** Return one previously reserved queue position. */
  leave(): void {
    this.queued--;
  }
}

interface ToolExecutorLimits {
  readConcurrency: number;
  writeConcurrency: number;
  queueLimit: number;
}

/** Execute a registered tool through the shared authorization and resource boundary. */
export class ToolExecutor {
  private activeGeneration: number | null = null;
  private readonly gates: Record<ToolCapability, AdmissionGate>;

  /** Create an executor with isolated admission state. */
  constructor(limits: ToolExecutorLimits = {
    readConcurrency: config.ACORNOPS_AGENT_TOOL_READ_CONCURRENCY,
    writeConcurrency: config.ACORNOPS_AGENT_TOOL_WRITE_CONCURRENCY,
    queueLimit: config.ACORNOPS_AGENT_TOOL_QUEUE_LIMIT,
  }) {
    const queueBudget = new QueueBudget(limits.queueLimit);
    this.gates = {
      read: new AdmissionGate(limits.readConcurrency, queueBudget),
      write: new AdmissionGate(limits.writeConcurrency, queueBudget),
    };
  }

  /** Activate one authenticated connection generation. */
  public setActiveGeneration(generation: number): void {
    if (this.activeGeneration !== null && this.activeGeneration !== generation) {
      this.cancelQueuedCalls();
    }
    this.activeGeneration = generation;
  }

  /** Revoke the active connection generation for future and queued calls. */
  public clearActiveGeneration(): void {
    this.activeGeneration = null;
    this.cancelQueuedCalls();
  }

  /** Execute a registered tool through all shared policy checks. */
  async execute(params: {
    name: string;
    arguments: unknown;
    requestId: string | number;
    policy: ToolSessionPolicy;
  }): Promise<unknown> {
    if (this.activeGeneration !== params.policy.generation) {
      throw new ToolExecutionError('TOOL_NOT_ALLOWED', 'Tool session generation is no longer active');
    }
    const tool = toolRegistry.get(params.name);
    if (!tool) {
      throw new ToolExecutionError('TOOL_NOT_ALLOWED', `Tool not found: ${params.name}`);
    }
    if (!params.policy.allowedTools.has(tool.name)) {
      throw new ToolExecutionError('TOOL_NOT_ALLOWED', `Tool is not allowed for this session: ${tool.name}`);
    }
    if (tool.capability === 'write' && (!config.ACORNOPS_AGENT_WRITE_ENABLED || !params.policy.writeEnabled)) {
      throw new ToolExecutionError('WRITE_DISABLED', 'Write operations are disabled for this session');
    }

    const inputBytes = Buffer.byteLength(JSON.stringify(params.arguments ?? {}));
    if (inputBytes > config.ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'Tool input exceeds the configured size limit');
    }

    const parsed = tool.schema.safeParse(params.arguments);
    if (!parsed.success) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'Invalid tool arguments', parsed.error.flatten());
    }
    this.authorizeScope(tool, parsed.data);

    const operationId = createHash('sha256')
      .update(`${params.policy.generation}:${typeof params.requestId}:${String(params.requestId)}`)
      .digest('hex')
      .slice(0, 24);
    const deadline = Date.now() + tool.timeoutMs;
    const release = await this.gates[tool.capability].acquire(tool.timeoutMs, {
      outcome: 'not_started',
      operationId,
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let handlerPromise: Promise<unknown> | undefined;

    try {
      if (this.activeGeneration !== params.policy.generation) {
        throw new ToolExecutionError('TOOL_NOT_ALLOWED', 'Tool session generation is no longer active');
      }
      if (Date.now() >= deadline) {
        throw new ToolExecutionError('TOOL_TIMEOUT', `Tool '${tool.name}' timed out`, {
          outcome: 'not_started',
          operationId,
        });
      }

      const controller = new AbortController();
      handlerPromise = Promise.resolve().then(() => tool.handler(parsed.data, {
        operationId,
        requestId: params.requestId,
        sessionGeneration: params.policy.generation,
        signal: controller.signal,
      }));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ToolExecutionError(
            'TOOL_TIMEOUT',
            `Tool '${tool.name}' timed out`,
            tool.capability === 'write' ? { outcome: 'unknown', operationId } : { operationId }
          ));
        }, Math.max(1, deadline - Date.now()));
      });
      const rawResult = await Promise.race([handlerPromise, timeoutPromise]);
      const result = redactKubernetesResource(rawResult, tool.name === 'list_resources'
        ? { preserveRootFields: LIST_RESULT_FIELDS }
        : undefined);
      const serializedResult = JSON.stringify(result);
      if (serializedResult === undefined) {
        throw new ToolExecutionError('KUBERNETES_ERROR', 'Tool returned no result');
      }
      if (Buffer.byteLength(serializedResult) > config.ACORNOPS_AGENT_TOOL_MAX_OUTPUT_BYTES) {
        throw new ToolExecutionError('OUTPUT_TOO_LARGE', 'Tool result exceeds the configured size limit');
      }
      return result;
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      if (isKubernetesPreconditionFailure(err)) {
        throw new ToolExecutionError('PRECONDITION_FAILED', 'Kubernetes resource precondition failed');
      }
      throw new ToolExecutionError('KUBERNETES_ERROR', 'Kubernetes operation failed');
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut && handlerPromise) {
        void handlerPromise.catch(() => undefined).finally(release);
      } else {
        release();
      }
    }
  }

  private authorizeScope(tool: ToolDefinition, args: unknown): void {
    const scope = tool.scopeResolver(args);
    if (scope.type === 'namespaced' && !isNamespaceAllowed(scope.namespace)) {
      throw new ToolExecutionError('NAMESPACE_FORBIDDEN', `Namespace is outside the allowed scope: ${scope.namespace}`);
    }
    if (scope.type === 'namespace-collection' && scope.namespace && !isNamespaceAllowed(scope.namespace)) {
      throw new ToolExecutionError('NAMESPACE_FORBIDDEN', `Namespace is outside the allowed scope: ${scope.namespace}`);
    }
    if (scope.type === 'cluster' && !canAccessClusterScopedKind(scope.kind)) {
      throw new ToolExecutionError('NAMESPACE_FORBIDDEN', `Cluster-scoped kind is unavailable in the current scope: ${scope.kind}`);
    }
    if (scope.type === 'cluster' && scope.namespace && !isNamespaceAllowed(scope.namespace)) {
      throw new ToolExecutionError('NAMESPACE_FORBIDDEN', `Namespace is outside the allowed scope: ${scope.namespace}`);
    }
  }

  private cancelQueuedCalls(): void {
    const error = new ToolExecutionError('TOOL_NOT_ALLOWED', 'Tool session generation is no longer active');
    this.gates.read.cancelQueued(error);
    this.gates.write.cancelQueued(error);
  }
}

export const toolExecutor = new ToolExecutor();
