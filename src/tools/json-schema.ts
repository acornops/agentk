import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

/** Unwrap optional/default Zod wrappers and report whether the field is required. */
function unwrap(type: z.ZodTypeAny): { schema: z.ZodTypeAny; required: boolean } {
  let current = type;
  let required = true;
  while (true) {
    const typeName = (current as { _def?: { typeName?: string } })._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      required = false;
      current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = (current as unknown as { _def: { schema: z.ZodTypeAny } })._def.schema;
      continue;
    }
    return { schema: current, required };
  }
}

/** Convert supported Zod schema nodes into JSON Schema fragments. */
function toJsonSchemaInternal(type: z.ZodTypeAny): JsonSchema {
  const typeName = (type as { _def?: { typeName?: string } })._def?.typeName;
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return toJsonSchemaInternal((type as unknown as { _def: { schema: z.ZodTypeAny } })._def.schema);
    case z.ZodFirstPartyTypeKind.ZodString: {
      const schema: JsonSchema = { type: 'string' };
      const checks = (type as unknown as { _def: { checks?: Array<Record<string, unknown>> } })._def.checks || [];
      for (const check of checks) {
        if (check.kind === 'min') schema.minLength = check.value;
        if (check.kind === 'max') schema.maxLength = check.value;
        if (check.kind === 'regex' && check.regex instanceof RegExp) schema.pattern = check.regex.source;
      }
      return schema;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const schema: JsonSchema = { type: 'number' };
      const checks = (type as unknown as { _def: { checks?: Array<Record<string, unknown>> } })._def.checks || [];
      for (const check of checks) {
        if (check.kind === 'int') schema.type = 'integer';
        if (check.kind === 'min') schema.minimum = check.value;
        if (check.kind === 'max') schema.maximum = check.value;
      }
      return schema;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodAny:
      return {};
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: (type as unknown as { _def: { value: unknown } })._def.value };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return {
        type: 'string',
        enum: [...(type as z.ZodEnum<[string, ...string[]]>).options]
      };
    case z.ZodFirstPartyTypeKind.ZodRecord: {
      const valueType = (type as unknown as { _def: { valueType: z.ZodTypeAny } })._def.valueType;
      return {
        type: 'object',
        additionalProperties: toJsonSchemaInternal(valueType)
      };
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const elementType = (type as z.ZodArray<z.ZodTypeAny>).element;
      const schema: JsonSchema = {
        type: 'array',
        items: toJsonSchemaInternal(elementType)
      };
      const definition = (type as unknown as { _def: { minLength?: { value: number }; maxLength?: { value: number } } })._def;
      if (definition.minLength) schema.minItems = definition.minLength.value;
      if (definition.maxLength) schema.maxItems = definition.maxLength.value;
      return schema;
    }
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return {
        anyOf: [
          toJsonSchemaInternal((type as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType),
          { type: 'null' },
        ],
      };
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return {
        oneOf: (type as unknown as { _def: { options: z.ZodTypeAny[] } })._def.options.map(toJsonSchemaInternal),
      };
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return {
        oneOf: [...(type as unknown as { options: Map<unknown, z.ZodTypeAny> }).options.values()].map(toJsonSchemaInternal),
      };
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const objectSchema = type as z.ZodObject<Record<string, z.ZodTypeAny>>;
      const shape = objectSchema.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, rawSchema] of Object.entries(shape)) {
        const { schema, required: isRequired } = unwrap(rawSchema);
        properties[key] = toJsonSchemaInternal(schema);
        if (isRequired) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false
      };
    }
    default:
      return {};
  }
}

/** Convert a Zod schema into a JSON Schema document. */
export function zodToJsonSchema(type: z.ZodTypeAny): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...toJsonSchemaInternal(type)
  };
}
