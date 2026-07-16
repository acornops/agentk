import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRouter } from './router.js';
import { toolRegistry } from '../tools/registry.js';
import { z } from 'zod';
import { createRequest } from './protocol.js';
import { FULL_TOOL_RESULT_OUTPUT_SCHEMA } from '../tools/model-context.js';
import { config } from '../config.js';
import { ToolExecutionError } from '../tools/errors.js';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('pino', () => {
  const logger = {
    ...logSpies,
    child: () => logger,
  };
  return { default: () => logger };
});

const projectionFields = {
  outputSchema: FULL_TOOL_RESULT_OUTPUT_SCHEMA,
  artifactPolicy: 'never' as const,
  projectForModel: (result: any) => ({
    schemaVersion: 'acornops.model-context.v1' as const,
    tool: 'test_tool',
    status: 'success' as const,
    summary: 'Test tool completed.',
    data: result,
    omissions: [],
  }),
};

describe('MCP Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolRegistry.resetForTests();
    mcpRouter.setSessionPolicy({ allowedTools: new Set(), writeEnabled: true, generation: 1 });
  });

  afterEach(() => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
  });

  it('rejects discovery before a session policy is installed', async () => {
    mcpRouter.clearSessionPolicy();
    const res = await mcpRouter.handleRequest(createRequest('tools/list', {}, 0));
    expect(res.error).toMatchObject({ code: -32001, data: { code: 'TOOL_NOT_ALLOWED' } });
  });

  it('should list tools', async () => {
    const req = createRequest('tools/list', {}, 1);
    const res = await mcpRouter.handleRequest(req);
    expect(res.result.tools).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);
  });

  it('should call a registered tool', async () => {
    const mockHandler = vi.fn().mockResolvedValue({ success: true });
    toolRegistry.register({
      name: 'test_tool',
      description: 'A test tool',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({ arg1: z.string() }),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: mockHandler,
    });
    mcpRouter.setSessionPolicy({ allowedTools: new Set(['test_tool']), writeEnabled: true, generation: 1 });

    const req = createRequest('tools/call', { name: 'test_tool', arguments: { arg1: 'hello' } }, 1);
    const res = await mcpRouter.handleRequest(req);

    expect(res.result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Test tool completed') }],
      structuredContent: { schemaVersion: 'acornops.full-tool-result.v1', data: { success: true } },
      isError: false,
    });
    expect(mockHandler).toHaveBeenCalledWith({ arg1: 'hello' }, expect.objectContaining({ operationId: expect.any(String) }));
  });

  it('should return error for unknown tool', async () => {
    const req = createRequest('tools/call', { name: 'non_existent', arguments: {} }, 1);
    const res = await mcpRouter.handleRequest(req);

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601); // Method not found
  });

  it('includes tool metadata when listing tools', async () => {
    toolRegistry.register({
      name: 'metadata_tool',
      description: 'Exposes metadata',
      capability: 'write',
      timeoutMs: 2500,
      version: 'v2',
      ...projectionFields,
      deprecated: true,
      schema: z.object({
        name: z.string(),
        enabled: z.boolean().optional(),
      }),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn(),
    });
    mcpRouter.setSessionPolicy({ allowedTools: new Set(['metadata_tool']), writeEnabled: true, generation: 1 });

    const res = await mcpRouter.handleRequest(createRequest('tools/list', {}, 7));
    const tool = res.result.tools.find((entry: { name: string }) => entry.name === 'metadata_tool');

    expect(tool).toEqual({
      name: 'metadata_tool',
      description: 'Exposes metadata',
      capability: 'write',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: FULL_TOOL_RESULT_OUTPUT_SCHEMA,
      artifactPolicy: 'never',
      timeout_ms: 2500,
      version: 'v2',
      deprecated: true,
    });
  });

  it('returns invalid params when tool name is missing', async () => {
    const res = await mcpRouter.handleRequest(createRequest('tools/call', {}, 2));

    expect(res.error).toEqual({
      code: -32602,
      message: 'Invalid tool name',
      data: undefined,
    });
  });

  it('returns invalid params details when tool arguments fail validation', async () => {
    toolRegistry.register({
      name: 'validated_tool',
      description: 'Requires a string argument',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({ arg1: z.string() }),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn(),
    });
    mcpRouter.setSessionPolicy({ allowedTools: new Set(['validated_tool']), writeEnabled: true, generation: 1 });

    const res = await mcpRouter.handleRequest(
      createRequest('tools/call', { name: 'validated_tool', arguments: {} }, 3)
    );

    expect(res.result).toMatchObject({
      isError: true,
      structuredContent: { data: { code: 'INVALID_ARGUMENTS', message: 'Invalid tool arguments' } },
    });
    expect(JSON.parse(res.result.content[0].text).data.issues).toEqual([
      expect.objectContaining({ path: ['arg1'] }),
    ]);
  });

  it('bounds validation details for adversarially large invalid arguments', async () => {
    toolRegistry.register({
      name: 'bounded_validation_tool',
      description: 'Requires an empty object',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({}).strict(),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn(),
    });
    mcpRouter.setSessionPolicy({
      allowedTools: new Set(['bounded_validation_tool']), writeEnabled: true, generation: 1,
    });
    const argumentsPayload = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`unexpected_${index}`, 'value'])
    );

    const res = await mcpRouter.handleRequest(createRequest(
      'tools/call', { name: 'bounded_validation_tool', arguments: argumentsPayload }, 31
    ));

    expect(res.result.isError).toBe(true);
    expect(Buffer.byteLength(res.result.content[0].text)).toBeLessThanOrEqual(12 * 1024);
    expect(() => JSON.parse(res.result.content[0].text)).not.toThrow();
  });

  it('returns internal errors when a tool throws', async () => {
    toolRegistry.register({
      name: 'failing_tool',
      description: 'Throws',
      capability: 'read',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({}),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn().mockRejectedValue(new Error('tool exploded')),
    });
    mcpRouter.setSessionPolicy({ allowedTools: new Set(['failing_tool']), writeEnabled: true, generation: 1 });

    const res = await mcpRouter.handleRequest(
      createRequest('tools/call', { name: 'failing_tool', arguments: {} }, 4)
    );

    expect(res.result).toMatchObject({
      isError: true,
      structuredContent: { data: { code: 'KUBERNETES_ERROR', message: 'Kubernetes operation failed' } },
    });
  });

  it('marks a post-execution write projection failure as outcome unknown', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    toolRegistry.register({
      name: 'write_projection_failure',
      description: 'Completes a write before projection fails',
      capability: 'write',
      timeoutMs: 1000,
      version: 'v1',
      outputSchema: FULL_TOOL_RESULT_OUTPUT_SCHEMA,
      artifactPolicy: 'never',
      projectForModel: () => { throw new Error('projection failed'); },
      schema: z.object({}),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn().mockResolvedValue({ success: true }),
    });
    mcpRouter.setSessionPolicy({
      allowedTools: new Set(['write_projection_failure']), writeEnabled: true, generation: 1,
    });

    const res = await mcpRouter.handleRequest(createRequest(
      'tools/call', { name: 'write_projection_failure', arguments: {} }, 5
    ));

    expect(res.result).toMatchObject({
      isError: true,
      structuredContent: { data: { code: 'INTERNAL_ERROR', outcome: 'unknown', retryable: false } },
    });
    expect(logSpies.error).toHaveBeenCalledWith({
      tool: 'write_projection_failure',
      code: 'INTERNAL_ERROR',
      reason: 'ResultProjectionFailed',
      phase: 'result_projection',
      retryable: false,
    }, 'Tool execution failed');
  });

  it('logs only allowlisted tool failure diagnostics', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    toolRegistry.register({
      name: 'sanitized_failure',
      description: 'Fails with safe and sensitive diagnostic fields',
      capability: 'write',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({ namespace: z.string(), token: z.string() }).strict(),
      scopeResolver: (args) => ({ type: 'namespaced', namespace: args.namespace }),
      handler: vi.fn().mockRejectedValue(new ToolExecutionError(
        'KUBERNETES_ERROR',
        'raw exception message must not be logged',
        {
          status: 503,
          reason: 'Unavailable',
          phase: 'kubernetes_api',
          outcome: 'unknown',
          namespace: 'customer-secret',
          rawResponse: { token: 'upstream-secret' },
        },
      )),
    });
    mcpRouter.setSessionPolicy({
      allowedTools: new Set(['sanitized_failure']), writeEnabled: true, generation: 1,
    });

    await mcpRouter.handleRequest(createRequest('tools/call', {
      name: 'sanitized_failure',
      arguments: { namespace: 'customer-secret', token: 'caller-secret' },
    }, 32));

    expect(logSpies.error).toHaveBeenCalledWith({
      tool: 'sanitized_failure',
      code: 'KUBERNETES_ERROR',
      status: 503,
      reason: 'Unavailable',
      phase: 'kubernetes_api',
      outcome: 'unknown',
      operationId: expect.stringMatching(/^[a-f0-9]{24}$/),
      retryable: false,
    }, 'Tool execution failed');
    const logged = JSON.stringify(logSpies.error.mock.calls.at(-1));
    expect(logged).not.toContain('customer-secret');
    expect(logged).not.toContain('caller-secret');
    expect(logged).not.toContain('upstream-secret');
    expect(logged).not.toContain('raw exception message');
  });

  it('never marks an unknown write outcome as retryable', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    toolRegistry.register({
      name: 'ambiguous_write',
      description: 'Fails after a write may have started',
      capability: 'write',
      timeoutMs: 1000,
      version: 'v1',
      ...projectionFields,
      schema: z.object({}),
      scopeResolver: () => ({ type: 'namespace-collection' }),
      handler: vi.fn().mockRejectedValue(new ToolExecutionError('KUBERNETES_UNAVAILABLE', 'Unavailable')),
    });
    mcpRouter.setSessionPolicy({ allowedTools: new Set(['ambiguous_write']), writeEnabled: true, generation: 1 });

    const res = await mcpRouter.handleRequest(
      createRequest('tools/call', { name: 'ambiguous_write', arguments: {} }, 6)
    );

    expect(res.result).toMatchObject({
      isError: true,
      structuredContent: { data: { outcome: 'unknown', retryable: false } },
    });
  });

  it('returns method not found for unsupported rpc methods', async () => {
    const res = await mcpRouter.handleRequest(createRequest('unknown/method', {}, 5));

    expect(res.error).toEqual({
      code: -32601,
      message: 'Method not found: unknown/method',
      data: undefined,
    });
  });
});
