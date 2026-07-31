import { z } from 'zod';
import { k8sClient } from '../../k8s/client.js';
import { boundedItems, fullToolResultOutputSchema } from '../model-context.js';
import { ToolDefinition } from '../registry.js';
import { continuationTokenSchema, namespaceSchema, selectorSchema } from '../schemas.js';
import { checkNamespaceAllowed } from '../utils.js';
import { requireCustomResourceAddition } from '../custom-resource-additions.js';
import { ToolExecutionError } from '../errors.js';

const OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object',
  required: ['additionKey', 'resource', 'scope', 'total', 'continue_token', 'items'],
  properties: {
    additionKey: { type: 'string' },
    resource: { type: 'string' },
    scope: { type: 'string' },
    total: { type: 'integer' },
    continue_token: { type: 'string' },
    items: { type: 'array' }
  },
  additionalProperties: false
});

export const listCustomResourcesSchema = z.object({
  addition_key: z.string().min(1).max(64),
  resource: z.string().min(1).max(253),
  namespace: namespaceSchema.optional(),
  label_selector: selectorSchema.optional(),
  field_selector: selectorSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(50),
  continue_token: continuationTokenSchema.optional()
}).strict();

/** Return identity-only custom-resource summaries without arbitrary spec or status data. */
function summarizeCustomResource(item: any): Record<string, unknown> {
  const metadata = item?.metadata || {};
  return {
    apiVersion: item?.apiVersion,
    kind: item?.kind,
    name: metadata.name || '',
    namespace: metadata.namespace || undefined,
    uid: metadata.uid || undefined,
    resourceVersion: metadata.resourceVersion || undefined,
    generation: metadata.generation,
    createdAt: metadata.creationTimestamp || undefined
  };
}

/** List one administrator-approved custom-resource type. */
export async function listCustomResourcesHandler(params: z.infer<typeof listCustomResourcesSchema>) {
  const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'list');
  if (definition.scope === 'namespaced' && !params.namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace is required for this custom resource');
  }
  if (definition.scope === 'cluster' && params.namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace must be omitted for this cluster-scoped custom resource');
  }
  checkNamespaceAllowed(params.namespace);
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    labelSelector: params.label_selector,
    fieldSelector: params.field_selector,
    limit: params.limit,
    _continue: params.continue_token
  };
  const response = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.listNamespacedCustomObject({ ...options, namespace: params.namespace! })
    : await k8sClient.customObjects.listClusterCustomObject(options);
  const items = Array.isArray((response as any)?.items) ? (response as any).items.map(summarizeCustomResource) : [];
  return {
    additionKey: definition.additionKey,
    resource: definition.resource,
    scope: definition.scope,
    total: items.length,
    continue_token: String((response as any)?.metadata?._continue || ''),
    items
  };
}

export const listCustomResourcesTool: ToolDefinition = {
  name: 'list_custom_resources',
  description: 'List a custom-resource type from an administrator-approved integration. Use only addition and resource keys exposed by the installed AgentK configuration.',
  capability: 'read',
  timeoutMs: 12000,
  version: 'v1',
  outputSchema: OUTPUT_SCHEMA,
  artifactPolicy: 'if_detailed',
  schema: listCustomResourcesSchema,
  scopeResolver: (params) => params.namespace
    ? { type: 'namespace-collection', namespace: params.namespace }
    : { type: 'cluster', kind: params.resource },
  handler: listCustomResourcesHandler,
  projectForModel: (result) => {
    const items = Array.isArray(result?.items) ? result.items : [];
    const bounded = boundedItems(items, 50);
    return {
      schemaVersion: 'acornops.model-context.v1',
      tool: 'list_custom_resources',
      status: 'success',
      summary: `Returned ${result?.total ?? bounded.items.length} ${result?.resource || 'custom resource'} item(s).`,
      data: { ...result, items: bounded.items },
      omissions: bounded.omissions
    };
  }
};
