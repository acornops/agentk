import { describe, expect, it } from 'vitest';
import { JsonRpcNotificationSchema, JsonRpcRequestSchema, JsonRpcResponseSchema } from '../mcp/protocol.js';
import { patchCustomResourceSchema } from './atomic/patch-custom-resource.js';
import { patchWorkloadSchema } from './atomic/patch-workload.js';
import { listResourcesTool } from './atomic/list-resources.js';

describe('tool validation security', () => {
  it.each([
    { name: 'workload changes', schema: patchWorkloadSchema, field: 'changes', limit: 10, target: { kind: 'Deployment' } },
    { name: 'custom-resource operations', schema: patchCustomResourceSchema, field: 'operations', limit: 20, target: { addition_key: 'widgets', resource: 'widgets' } },
  ])('rejects excess $name without traversing elements', ({ schema, field, limit, target }) => {
    let reads = 0;
    const items = Array.from({ length: limit + 1 }, () => null);
    for (let index = 0; index < items.length; index++) {
      Object.defineProperty(items, index, { get() { reads++; return null; } });
    }
    const result = schema.safeParse({
      ...target, namespace: 'default', name: 'worker', expected_uid: 'uid-123',
      expected_resource_version: '1', reason: 'Approved maintenance', [field]: items,
    });
    expect(result.success).toBe(false);
    expect(reads).toBe(0);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({ code: 'too_big', path: [field] });
  });

  it('preserves list-resource input transforms and defaults', () => {
    expect(listResourcesTool.schema.parse({ kind: 'Node', namespace: 'default', limit: 1000 }))
      .toEqual({ kind: 'Node', namespace: undefined, limit: 50 });
    expect(listResourcesTool.schema.parse({ kind: 'Namespace' })).toMatchObject({ limit: 100 });
    expect(listResourcesTool.schema.parse({ addition_key: 'widgets', resource: 'widgets' })).toMatchObject({ limit: 50 });
  });

  it('preserves omitted protocol payloads and explicit null results', () => {
    expect(JsonRpcRequestSchema.parse({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).not.toHaveProperty('params');
    expect(JsonRpcNotificationSchema.parse({ jsonrpc: '2.0', method: 'notifications/initialized' })).not.toHaveProperty('params');
    expect(JsonRpcResponseSchema.parse({ jsonrpc: '2.0', id: 1, result: null }).result).toBeNull();
    expect(JsonRpcResponseSchema.parse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })).not.toHaveProperty('result');
  });
});
