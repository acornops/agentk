import { z } from 'zod';

/** Advertise accepted inputs, preserving optional defaults and pre-transform constraints. */
export function zodToJsonSchema(type: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(type, {
    io: 'input',
    target: 'draft-2020-12',
    override: ({ zodSchema, jsonSchema }) => {
      // Stripped object keys were never advertised as accepted tool arguments.
      if (zodSchema instanceof z.ZodObject && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false;
      }
    },
  });
}
