import * as k8s from '@kubernetes/client-node';
import { z } from 'zod';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { boundedItems, fullToolResultOutputSchema, WRITE_TOOL_RESULT_OUTPUT_SCHEMA, writeProjection } from '../model-context.js';
import { redactKubernetesResource } from '../resource-redaction.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import { kubernetesNameSchema, kubernetesUidSchema, namespaceSchema, reasonSchema, selectorSchema } from '../schemas.js';
import { checkNamespaceAllowed, checkOperationNotAborted, checkWriteEnabled, getAnnotations } from '../utils.js';
import { requireCustomResourceAddition } from '../custom-resource-additions.js';

const READ_OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object',
  required: ['additionKey', 'resource', 'object'],
  properties: {
    additionKey: { type: 'string' },
    resource: { type: 'string' },
    object: { type: 'object' }
  },
  additionalProperties: false
});

const WATCH_OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object',
  required: ['additionKey', 'resource', 'events'],
  properties: {
    additionKey: { type: 'string' },
    resource: { type: 'string' },
    events: { type: 'array' }
  },
  additionalProperties: false
});

const resourceIdentitySchema = z.object({
  addition_key: z.string().min(1).max(64),
  resource: z.string().min(1).max(253),
  namespace: namespaceSchema.optional()
}).strict();

/** Validate one configured custom-resource scope against the requested namespace. */
function validateScope(scope: 'namespaced' | 'cluster', namespace?: string): void {
  if (scope === 'namespaced' && !namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace is required for this custom resource');
  }
  if (scope === 'cluster' && namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace must be omitted for this cluster-scoped custom resource');
  }
  checkNamespaceAllowed(namespace);
}

const getCustomResourceSchema = resourceIdentitySchema.extend({
  name: kubernetesNameSchema
}).strict();

/** Fetch one exact administrator-approved custom resource. */
export async function getCustomResourceHandler(params: z.infer<typeof getCustomResourceSchema>) {
  const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'get');
  validateScope(definition.scope, params.namespace);
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    name: params.name
  };
  const object = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.getNamespacedCustomObject({ ...options, namespace: params.namespace! })
    : await k8sClient.customObjects.getClusterCustomObject(options);
  return {
    additionKey: definition.additionKey,
    resource: definition.resource,
    object: redactKubernetesResource(object)
  };
}

const watchCustomResourcesSchema = resourceIdentitySchema.extend({
  label_selector: selectorSchema.optional(),
  field_selector: selectorSchema.optional(),
  resource_version: z.string().min(1).max(128).optional(),
  timeout_seconds: z.number().int().min(1).max(30).optional().default(15),
  limit: z.number().int().min(1).max(50).optional().default(50)
}).strict();

type WatchClient = Pick<k8s.Watch, 'watch'>;

/** Watch a bounded sequence of administrator-approved custom-resource events. */
export async function watchCustomResourcesHandler(
  params: z.infer<typeof watchCustomResourcesSchema>,
  context?: ToolExecutionContext,
  watchClient: WatchClient = new k8s.Watch(k8sClient.kc)
) {
  const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'watch');
  validateScope(definition.scope, params.namespace);
  const path = definition.scope === 'namespaced'
    ? `/apis/${definition.apiGroup}/${definition.apiVersion}/namespaces/${params.namespace}/${definition.resource}`
    : `/apis/${definition.apiGroup}/${definition.apiVersion}/${definition.resource}`;

  const events = await new Promise<Array<{ type: string; object: unknown }>>((resolve, reject) => {
    const collected: Array<{ type: string; object: unknown }> = [];
    let abort: AbortController | undefined;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort?.abort();
      if (error) reject(error);
      else resolve(collected);
    };
    const timer = setTimeout(() => finish(), (params.timeout_seconds + 1) * 1000);
    context?.signal?.addEventListener('abort', () => {
      abort?.abort();
      finish(new ToolExecutionError('TOOL_TIMEOUT', 'Custom-resource watch timed out'));
    }, { once: true });
    watchClient.watch(
      path,
      {
        timeoutSeconds: params.timeout_seconds,
        resourceVersion: params.resource_version,
        labelSelector: params.label_selector,
        fieldSelector: params.field_selector
      },
      (type, object) => {
        collected.push({ type, object: redactKubernetesResource(object) });
        if (collected.length >= params.limit) finish();
      },
      (error) => finish(error || undefined)
    ).then((controller) => {
      abort = controller;
      if (settled) controller.abort();
    }).catch(finish);
  });

  return { additionKey: definition.additionKey, resource: definition.resource, events };
}

const createCustomResourceSchema = resourceIdentitySchema.extend({
  body: z.record(z.unknown()),
  reason: reasonSchema
}).strict();

/** Dry-run and create one administrator-approved custom resource. */
export async function createCustomResourceHandler(
  params: z.infer<typeof createCustomResourceSchema>,
  context?: ToolExecutionContext
) {
  checkWriteEnabled();
  const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'create');
  validateScope(definition.scope, params.namespace);
  if (params.body.apiVersion !== `${definition.apiGroup}/${definition.apiVersion}` || params.body.kind !== definition.kind) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'Custom-resource body apiVersion and kind must match the configured resource');
  }
  const metadata = params.body.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.name !== 'string') {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'Custom-resource body metadata.name is required');
  }
  if (definition.scope === 'namespaced' && metadata.namespace !== undefined && metadata.namespace !== params.namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'Custom-resource body metadata.namespace must match namespace');
  }
  if (definition.scope === 'cluster' && metadata.namespace !== undefined) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'Custom-resource body metadata.namespace must be omitted for cluster-scoped resources');
  }
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const body = {
    ...params.body,
    metadata: {
      ...metadata,
      annotations: {
        ...((metadata.annotations as Record<string, unknown> | undefined) || {}),
        ...getAnnotations(params.reason, operationId)
      }
    }
  };
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    body,
    fieldManager: 'acornops-agentk',
    fieldValidation: 'Strict'
  };
  if (definition.scope === 'namespaced') {
    await k8sClient.customObjects.createNamespacedCustomObject({ ...options, namespace: params.namespace!, dryRun: 'All' });
  } else {
    await k8sClient.customObjects.createClusterCustomObject({ ...options, dryRun: 'All' });
  }
  checkOperationNotAborted(context, operationId);
  const created = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.createNamespacedCustomObject({ ...options, namespace: params.namespace! })
    : await k8sClient.customObjects.createClusterCustomObject(options);
  return {
    success: true,
    operationId,
    target: {
      kind: definition.kind,
      namespace: params.namespace,
      name: (created as any)?.metadata?.name || metadata.name,
      uid: (created as any)?.metadata?.uid
    },
    change: { type: 'create', additionKey: definition.additionKey, resource: definition.resource },
    observed: { resourceVersion: (created as any)?.metadata?.resourceVersion }
  };
}

const deleteCustomResourceSchema = resourceIdentitySchema.extend({
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  expected_resource_version: z.string().min(1).max(128),
  reason: reasonSchema
}).strict();

/** Dry-run and delete one exact administrator-approved custom resource. */
export async function deleteCustomResourceHandler(
  params: z.infer<typeof deleteCustomResourceSchema>,
  context?: ToolExecutionContext
) {
  checkWriteEnabled();
  const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'delete');
  validateScope(definition.scope, params.namespace);
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    name: params.name,
    body: { preconditions: { uid: params.expected_uid, resourceVersion: params.expected_resource_version } }
  };
  if (definition.scope === 'namespaced') {
    await k8sClient.customObjects.deleteNamespacedCustomObject({ ...options, namespace: params.namespace!, dryRun: 'All' });
  } else {
    await k8sClient.customObjects.deleteClusterCustomObject({ ...options, dryRun: 'All' });
  }
  checkOperationNotAborted(context, operationId);
  if (definition.scope === 'namespaced') {
    await k8sClient.customObjects.deleteNamespacedCustomObject({ ...options, namespace: params.namespace! });
  } else {
    await k8sClient.customObjects.deleteClusterCustomObject(options);
  }
  return {
    success: true,
    operationId,
    target: { kind: definition.kind, namespace: params.namespace, name: params.name, uid: params.expected_uid },
    change: { type: 'delete', additionKey: definition.additionKey, resource: definition.resource },
    observed: { resourceVersion: params.expected_resource_version }
  };
}

export const getCustomResourceTool: ToolDefinition = {
  name: 'get_custom_resource',
  description: 'Fetch one exact custom resource from an administrator-approved integration.',
  capability: 'read', timeoutMs: 12000, version: 'v1', outputSchema: READ_OUTPUT_SCHEMA, artifactPolicy: 'always',
  schema: getCustomResourceSchema,
  scopeResolver: (params) => params.namespace ? { type: 'namespaced', namespace: params.namespace } : { type: 'cluster', kind: params.resource },
  handler: getCustomResourceHandler,
  projectForModel: (result, params) => ({
    schemaVersion: 'acornops.model-context.v1', tool: 'get_custom_resource', status: 'success',
    summary: `Inspected ${params?.namespace ? `${params.namespace}/` : ''}${params?.name}.`,
    data: result, omissions: []
  })
};

export const watchCustomResourcesTool: ToolDefinition = {
  name: 'watch_custom_resources',
  description: 'Watch bounded changes to an administrator-approved custom-resource type.',
  capability: 'read', timeoutMs: 35000, version: 'v1', outputSchema: WATCH_OUTPUT_SCHEMA, artifactPolicy: 'if_detailed',
  schema: watchCustomResourcesSchema,
  scopeResolver: (params) => params.namespace ? { type: 'namespace-collection', namespace: params.namespace } : { type: 'cluster', kind: params.resource },
  handler: watchCustomResourcesHandler,
  projectForModel: (result) => {
    const bounded = boundedItems(Array.isArray(result?.events) ? result.events : [], 50);
    return {
      schemaVersion: 'acornops.model-context.v1', tool: 'watch_custom_resources', status: 'success',
      summary: `Observed ${bounded.items.length} ${result?.resource || 'custom-resource'} event(s).`,
      data: { ...result, events: bounded.items }, omissions: bounded.omissions
    };
  }
};

export const createCustomResourceTool: ToolDefinition = {
  name: 'create_custom_resource',
  description: 'Create one custom resource from an administrator-approved integration.',
  capability: 'write', timeoutMs: 20000, version: 'v1', outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA, artifactPolicy: 'never',
  schema: createCustomResourceSchema,
  scopeResolver: (params) => params.namespace ? { type: 'namespaced', namespace: params.namespace } : { type: 'cluster', kind: params.resource },
  handler: createCustomResourceHandler,
  projectForModel: (result) => writeProjection('create_custom_resource', result)
};

export const deleteCustomResourceTool: ToolDefinition = {
  name: 'delete_custom_resource',
  description: 'Delete one exact custom resource from an administrator-approved integration.',
  capability: 'write', timeoutMs: 20000, version: 'v1', outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA, artifactPolicy: 'never',
  schema: deleteCustomResourceSchema,
  scopeResolver: (params) => params.namespace ? { type: 'namespaced', namespace: params.namespace } : { type: 'cluster', kind: params.resource },
  handler: deleteCustomResourceHandler,
  projectForModel: (result) => writeProjection('delete_custom_resource', result)
};
