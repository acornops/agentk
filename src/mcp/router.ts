import pino from 'pino';
import { config } from '../config.js';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  createResponse,
  createErrorResponse,
  RPC_ERRORS
} from './protocol.js';
import { toolRegistry } from '../tools/registry.js';
import { zodToJsonSchema } from '../tools/json-schema.js';
import { ToolExecutionError, toolErrorLogContext } from '../tools/errors.js';
import { ToolSessionPolicy, toolExecutor } from '../tools/executor.js';
import { buildCallToolResult } from '../tools/model-context.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'mcp-router' });
const RETRYABLE_TOOL_ERRORS = new Set(['TOOL_TIMEOUT', 'TOOL_BUSY', 'KUBERNETES_TIMEOUT', 'KUBERNETES_UNAVAILABLE']);

/**
 * Routes incoming JSON-RPC requests to the appropriate tool or service handler.
 */
export class McpRouter {
  private sessionPolicy: ToolSessionPolicy | null = null;

  /** Install the authenticated policy for the active WebSocket generation. */
  public setSessionPolicy(policy: ToolSessionPolicy): void {
    this.sessionPolicy = {
      ...policy,
      allowedTools: new Set(policy.allowedTools),
    };
    toolExecutor.setActiveGeneration(policy.generation);
  }

  /** Clear policy when the active WebSocket generation ends. */
  public clearSessionPolicy(): void {
    this.sessionPolicy = null;
    toolExecutor.clearActiveGeneration();
  }
  /**
   * Processes a JSON-RPC request and returns the corresponding response.
   * @param request The incoming JSON-RPC request.
   * @returns A promise that resolves to a JSON-RPC response.
   */
  public async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    logger.debug({ method: request.method, id: request.id }, 'Handling JSON-RPC request');

    if (request.method === 'tools/call') {
      if (!this.sessionPolicy) {
        return createErrorResponse(request.id, -32001, 'Tool session is not ready', { code: 'TOOL_NOT_ALLOWED' });
      }
      return this.handleToolCall(request);
    }

    if (request.method === 'tools/list') {
      if (!this.sessionPolicy) {
        return createErrorResponse(request.id, -32001, 'Tool session is not ready', { code: 'TOOL_NOT_ALLOWED' });
      }
      return createResponse(request.id, {
        tools: toolRegistry.getAll().filter(t => this.sessionPolicy!.allowedTools.has(t.name)).map(t => ({
          name: t.name,
          description: t.description,
          capability: t.capability,
          inputSchema: zodToJsonSchema(t.schema),
          outputSchema: t.outputSchema,
          artifactPolicy: t.artifactPolicy,
          timeout_ms: t.timeoutMs,
          version: t.version,
          deprecated: Boolean(t.deprecated),
        }))
      });
    }

    return createErrorResponse(
      request.id,
      RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${request.method}`
    );
  }

  private async handleToolCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { name, arguments: args } = request.params || {};

    if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
      return createErrorResponse(request.id, RPC_ERRORS.INVALID_PARAMS, 'Invalid tool name');
    }

    const tool = toolRegistry.get(name);
    if (!tool) {
      return createErrorResponse(request.id, RPC_ERRORS.METHOD_NOT_FOUND, `Tool not found: ${name}`);
    }

    try {
      logger.info({ tool: name }, 'Executing tool');
      const result = await toolExecutor.execute({
        name,
        arguments: args,
        requestId: request.id,
        policy: this.sessionPolicy!,
      });
      const context = tool.projectForModel(result, args || {});
      return createResponse(request.id, buildCallToolResult(context, result, tool.artifactPolicy));
    } catch (err: any) {
      const knownError = err instanceof ToolExecutionError;
      const retryable = knownError
        && RETRYABLE_TOOL_ERRORS.has(err.toolCode)
        && !(tool.capability === 'write' && err.data?.outcome === 'unknown');
      const diagnostic = knownError
        ? toolErrorLogContext(err)
        : { code: 'INTERNAL_ERROR', reason: 'ResultProjectionFailed', phase: 'result_projection' };
      logger.error({ tool: name, ...diagnostic, retryable }, 'Tool execution failed');
      const error = knownError
        ? {
          code: err.toolCode,
          message: err.message,
          ...err.data,
          retryable,
        }
        : {
          code: 'INTERNAL_ERROR',
          message: 'Internal error during tool execution',
          reason: 'ResultProjectionFailed',
          phase: 'result_projection',
          retryable: false,
          ...(tool.capability === 'write' ? { outcome: 'unknown' } : {}),
        };
      const context = {
        schemaVersion: 'acornops.model-context.v1' as const,
        tool: name,
        status: 'error' as const,
        summary: String(error.message).slice(0, 500),
        data: error,
        omissions: [],
      };
      return createResponse(request.id, buildCallToolResult(context, error, tool.artifactPolicy, true));
    }
  }
}

export const mcpRouter = new McpRouter();
