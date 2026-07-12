import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { config } from '../config.js';
import { setNamespaceScope } from '../runtime/namespace-scope.js';
import { ToolExecutionError } from './errors.js';
import { ToolExecutor, toolExecutor } from './executor.js';
import { toolRegistry } from './registry.js';

describe('ToolExecutor', () => {
  beforeEach(() => {
    toolRegistry.resetForTests();
    setNamespaceScope({ include: [], exclude: [] });
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    toolExecutor.setActiveGeneration(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
    config.ACORNOPS_AGENT_RBAC_SCOPE = 'cluster';
    config.ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES = 1024 * 1024;
    config.ACORNOPS_AGENT_TOOL_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
    toolExecutor.clearActiveGeneration();
  });

  it('enforces session allowlisting and write policy', async () => {
    toolRegistry.register({
      name: 'write_tool',
      description: 'write',
      capability: 'write',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({ namespace: z.string() }).strict(),
      scopeResolver: (args) => ({ type: 'namespaced', namespace: args.namespace }),
      handler: vi.fn(),
    });

    await expect(toolExecutor.execute({
      name: 'write_tool',
      arguments: { namespace: 'default' },
      requestId: 1,
      policy: { allowedTools: new Set(), writeEnabled: true, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'TOOL_NOT_ALLOWED' });

    await expect(toolExecutor.execute({
      name: 'write_tool',
      arguments: { namespace: 'default' },
      requestId: 2,
      policy: { allowedTools: new Set(['write_tool']), writeEnabled: false, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'WRITE_DISABLED' });
  });

  it('rejects a namespace outside the effective remote scope', async () => {
    setNamespaceScope({ include: ['team-a'], exclude: [] });
    toolRegistry.register({
      name: 'read_tool',
      description: 'read',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({ namespace: z.string() }).strict(),
      scopeResolver: (args) => ({ type: 'namespaced', namespace: args.namespace }),
      handler: vi.fn(),
    });

    await expect(toolExecutor.execute({
      name: 'read_tool',
      arguments: { namespace: 'team-b' },
      requestId: 3,
      policy: { allowedTools: new Set(['read_tool']), writeEnabled: false, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'NAMESPACE_FORBIDDEN' });
  });

  it('rejects Namespace reads when RBAC is namespace-scoped', async () => {
    config.ACORNOPS_AGENT_RBAC_SCOPE = 'namespace';
    toolRegistry.register({
      name: 'cluster_read',
      description: 'cluster',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'cluster', kind: 'Namespace' }),
      handler: async () => ({ ok: true }),
    });

    await expect(toolExecutor.execute({
      name: 'cluster_read', arguments: {}, requestId: 4,
      policy: { allowedTools: new Set(['cluster_read']), writeEnabled: false, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'NAMESPACE_FORBIDDEN' });
  });

  it('preserves Node reads under bounded namespace policy and delegates authorization to Kubernetes RBAC', async () => {
    config.ACORNOPS_AGENT_RBAC_SCOPE = 'namespace';
    setNamespaceScope({ include: ['team-a'], exclude: [] });
    const handler = vi.fn(async () => ({ ok: true }));
    toolRegistry.register({
      name: 'node_read',
      description: 'node',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'cluster', kind: 'Node' }),
      handler,
    });

    await expect(toolExecutor.execute({
      name: 'node_read', arguments: {}, requestId: 5,
      policy: { allowedTools: new Set(['node_read']), writeEnabled: false, generation: 1 },
    })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps numeric and string JSON-RPC request IDs in separate idempotency domains', async () => {
    const handler = vi.fn(async (_args, context) => context?.operationId);
    toolRegistry.register({
      name: 'operation_id_tool', description: 'id', capability: 'read', timeoutMs: 1000, version: 'v1',
      schema: z.object({}).strict(), scopeResolver: () => ({ type: 'namespace-collection' }), handler,
    });
    const policy = { allowedTools: new Set(['operation_id_tool']), writeEnabled: false, generation: 1 };

    const numericId = await toolExecutor.execute({ name: 'operation_id_tool', arguments: {}, requestId: 1, policy });
    const stringId = await toolExecutor.execute({ name: 'operation_id_tool', arguments: {}, requestId: '1', policy });

    expect(numericId).not.toBe(stringId);
  });

  it('rejects invalid arguments before concurrency admission', async () => {
    const executor = new ToolExecutor({ readConcurrency: 1, writeConcurrency: 1, queueLimit: 0 });
    executor.setActiveGeneration(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    toolRegistry.register({
      name: 'validated_write', description: 'write', capability: 'write', timeoutMs: 1000, version: 'v1',
      schema: z.object({ valid: z.literal(true) }).strict(), scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => { await held; return { ok: true }; },
    });
    const policy = { allowedTools: new Set(['validated_write']), writeEnabled: true, generation: 1 };
    const active = executor.execute({ name: 'validated_write', arguments: { valid: true }, requestId: 1, policy });

    await expect(executor.execute({ name: 'validated_write', arguments: { valid: false }, requestId: 2, policy }))
      .rejects.toMatchObject({ toolCode: 'INVALID_ARGUMENTS' });
    release();
    await active;
  });

  it('cancels queued calls immediately when their session generation is revoked', async () => {
    const executor = new ToolExecutor({ readConcurrency: 1, writeConcurrency: 1, queueLimit: 1 });
    executor.setActiveGeneration(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    toolRegistry.register({
      name: 'generation_write', description: 'write', capability: 'write', timeoutMs: 1000, version: 'v1',
      schema: z.object({}).strict(), scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => { markStarted(); await held; return { ok: true }; },
    });
    const oldPolicy = { allowedTools: new Set(['generation_write']), writeEnabled: true, generation: 1 };
    const active = executor.execute({ name: 'generation_write', arguments: {}, requestId: 1, policy: oldPolicy });
    await started;
    const queued = executor.execute({ name: 'generation_write', arguments: {}, requestId: 2, policy: oldPolicy });

    executor.clearActiveGeneration();
    await expect(queued).rejects.toMatchObject({ toolCode: 'TOOL_NOT_ALLOWED' });
    executor.setActiveGeneration(2);
    const newPolicy = { ...oldPolicy, generation: 2 };
    const replacement = executor.execute({ name: 'generation_write', arguments: {}, requestId: 3, policy: newPolicy });
    release();
    await active;
    await expect(replacement).resolves.toEqual({ ok: true });
  });

  it('reports timed-out writes with an unknown outcome and operation id', async () => {
    vi.useFakeTimers();
    toolExecutor.setActiveGeneration(2);
    toolRegistry.register({
      name: 'slow_write',
      description: 'slow',
      capability: 'write',
      timeoutMs: 10,
      version: 'v1',
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
    });
    const call = toolExecutor.execute({
      name: 'slow_write',
      arguments: {},
      requestId: 'slow-1',
      policy: { allowedTools: new Set(['slow_write']), writeEnabled: true, generation: 2 },
    });
    const rejection = expect(call).rejects.toSatisfy((err: ToolExecutionError) =>
      err.toolCode === 'TOOL_TIMEOUT' && err.data?.outcome === 'unknown' && typeof err.data?.operationId === 'string'
    );
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    await vi.advanceTimersByTimeAsync(50);
  });

  it('does not release a write slot until a timed-out operation settles', async () => {
    vi.useFakeTimers();
    const executor = new ToolExecutor({ readConcurrency: 1, writeConcurrency: 1, queueLimit: 1 });
    executor.setActiveGeneration(7);
    const handler = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)));
    toolRegistry.register({
      name: 'held_write', description: 'held', capability: 'write', timeoutMs: 10, version: 'v1',
      schema: z.object({}).strict(), scopeResolver: () => ({ type: 'namespace-collection' }), handler,
    });
    const policy = { allowedTools: new Set(['held_write']), writeEnabled: true, generation: 7 };
    const first = executor.execute({ name: 'held_write', arguments: {}, requestId: 1, policy });
    const firstRejection = expect(first).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT', data: { outcome: 'unknown' } });
    await vi.advanceTimersByTimeAsync(11);
    await firstRejection;

    const second = executor.execute({ name: 'held_write', arguments: {}, requestId: 2, policy });
    const secondRejection = expect(second).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT', data: { outcome: 'not_started' } });
    await vi.advanceTimersByTimeAsync(11);
    await secondRejection;
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
  });

  it('rejects results beyond the configured serialized output limit', async () => {
    config.ACORNOPS_AGENT_TOOL_MAX_OUTPUT_BYTES = 32;
    toolRegistry.register({
      name: 'large_read', description: 'large', capability: 'read', timeoutMs: 1000, version: 'v1',
      schema: z.object({}).strict(), scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => ({ value: 'x'.repeat(64) }),
    });

    await expect(toolExecutor.execute({
      name: 'large_read', arguments: {}, requestId: 6,
      policy: { allowedTools: new Set(['large_read']), writeEnabled: false, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'OUTPUT_TOO_LARGE' });
  });

  it('rejects inputs beyond the configured serialized payload limit', async () => {
    config.ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES = 32;
    toolRegistry.register({
      name: 'bounded_input', description: 'bounded', capability: 'read', timeoutMs: 1000, version: 'v1',
      schema: z.object({ value: z.string() }).strict(), scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => ({ ok: true }),
    });

    await expect(toolExecutor.execute({
      name: 'bounded_input', arguments: { value: 'x'.repeat(64) }, requestId: 7,
      policy: { allowedTools: new Set(['bounded_input']), writeEnabled: false, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'INVALID_ARGUMENTS' });
  });

  it('maps Kubernetes conflicts to a precondition failure', async () => {
    toolRegistry.register({
      name: 'conflicting_write',
      description: 'conflict',
      capability: 'write',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => { throw Object.assign(new Error('resource version changed'), { statusCode: 409 }); },
    });

    await expect(toolExecutor.execute({
      name: 'conflicting_write',
      arguments: {},
      requestId: 4,
      policy: { allowedTools: new Set(['conflicting_write']), writeEnabled: true, generation: 1 },
    })).rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
  });

  it('preserves protocol continuation cursors while redacting sensitive result fields', async () => {
    toolRegistry.register({
      name: 'list_resources',
      description: 'paged',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: async () => ({ kind: 'Pod', items: [], continue_token: 'next-page', access_token: 'secret' }),
    });

    await expect(toolExecutor.execute({
      name: 'list_resources',
      arguments: {},
      requestId: 5,
      policy: { allowedTools: new Set(['list_resources']), writeEnabled: false, generation: 1 },
    })).resolves.toEqual({ kind: 'Pod', items: [], continue_token: 'next-page', access_token: '<redacted>' });
  });

  it('shares one bounded queue across read and write admission gates', async () => {
    const executor = new ToolExecutor({ readConcurrency: 1, writeConcurrency: 1, queueLimit: 1 });
    executor.setActiveGeneration(9);
    let releaseRead!: () => void;
    let releaseWrite!: () => void;
    const readBlocker = new Promise<void>((resolve) => { releaseRead = resolve; });
    const writeBlocker = new Promise<void>((resolve) => { releaseWrite = resolve; });
    for (const [name, capability, handler] of [
      ['bounded_read', 'read', () => readBlocker.then(() => ({ ok: true }))],
      ['bounded_write', 'write', () => writeBlocker.then(() => ({ ok: true }))],
    ] as const) {
      toolRegistry.register({
        name,
        description: name,
        capability,
        timeoutMs: 1000,
        version: 'v1',
        schema: z.object({}).strict(),
        scopeResolver: () => ({ type: 'namespace-collection' }),
        handler,
      });
    }
    const policy = { allowedTools: new Set(['bounded_read', 'bounded_write']), writeEnabled: true, generation: 9 };
    const firstRead = executor.execute({ name: 'bounded_read', arguments: {}, requestId: 1, policy });
    await Promise.resolve();
    const queuedRead = executor.execute({ name: 'bounded_read', arguments: {}, requestId: 2, policy });
    const firstWrite = executor.execute({ name: 'bounded_write', arguments: {}, requestId: 3, policy });
    await Promise.resolve();

    await expect(executor.execute({ name: 'bounded_write', arguments: {}, requestId: 4, policy }))
      .rejects.toMatchObject({ toolCode: 'TOOL_BUSY' });

    releaseRead();
    releaseWrite();
    await Promise.all([firstRead, queuedRead, firstWrite]);
  });
});
