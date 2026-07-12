import { z } from 'zod';

export const JsonRpcIdSchema = z.union([z.string().max(256), z.number().finite()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.string().min(1).max(128),
  params: z.any().optional(),
}).strict();

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1).max(128),
  params: z.any().optional(),
}).strict();

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.nullable(),
  result: z.any().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.any().optional(),
  }).optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/**
 * Creates a standard JSON-RPC 2.0 Request object.
 */
export function createRequest(method: string, params: any, id: string | number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * Creates a standard JSON-RPC 2.0 Notification object.
 */
export function createNotification(method: string, params: any): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

/**
 * Creates a standard JSON-RPC 2.0 Response object for successful requests.
 */
export function createResponse(id: string | number, result: any): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Creates a standard JSON-RPC 2.0 Error Response object.
 */
export function createErrorResponse(id: string | number | null, code: number, message: string, data?: any): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};
