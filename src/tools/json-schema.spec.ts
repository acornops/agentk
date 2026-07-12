import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.js';
import { patchResourceSchema } from './atomic/patch-resource.js';

describe('zodToJsonSchema', () => {
  it('preserves refined object fields and discriminated semantic operations', () => {
    const schema = z.object({
      name: z.string().min(1).max(20).regex(/^[a-z]+$/),
      changes: z.array(z.discriminatedUnion('type', [
        z.object({ type: z.literal('set'), value: z.string().nullable() }).strict(),
        z.object({ type: z.literal('remove') }).strict(),
      ])).min(1).max(10),
    }).strict().superRefine(() => undefined);

    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z]+$' },
        changes: {
          type: 'array', minItems: 1, maxItems: 10,
          items: { oneOf: [{ properties: { type: { const: 'set' } } }, { properties: { type: { const: 'remove' } } }] },
        },
      },
      required: ['name', 'changes'],
      additionalProperties: false,
    });
  });

  it('advertises the structured patch operation union to tool consumers', () => {
    const schema = zodToJsonSchema(patchResourceSchema) as any;
    expect(schema.properties.kind.enum).toEqual([
      'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Service', 'Ingress',
    ]);
    expect(schema.properties.changes.minItems).toBe(1);
    expect(schema.properties.changes.maxItems).toBe(10);
    expect(schema.properties.changes.items.oneOf).toHaveLength(7);
    expect(schema.properties.changes.items.oneOf[0]).toMatchObject({
      properties: { type: { const: 'set_image' }, container: { type: 'string' } },
      additionalProperties: false,
    });
  });
});
