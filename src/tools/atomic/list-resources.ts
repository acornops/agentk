import { z } from 'zod';
import { createHash } from 'node:crypto';
import { KubernetesListObject, KubernetesObject } from '@kubernetes/client-node';
import { k8sClient } from '../../k8s/client.js';
import { ToolDefinition } from '../registry.js';
import { checkNamespaceAllowed } from '../utils.js';
import { continuationTokenSchema, namespaceSchema, selectorSchema } from '../schemas.js';
import { filterNamespaceItems, getEffectiveNamespaceScope, hasBoundedNamespaceInclude, isNamespaceAllowed } from '../../runtime/namespace-scope.js';
import { ToolExecutionError } from '../errors.js';
import { boundedItems, fullToolResultOutputSchema } from '../model-context.js';
import { requireCustomResourceAddition } from '../custom-resource-additions.js';

const OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object', required: ['kind', 'namespace', 'total', 'continue_token', 'items'],
  properties: {
    kind: { type: 'string' }, namespace: { type: 'string' }, total: { type: 'integer' },
    continue_token: { type: 'string' }, items: { type: 'array' },
  },
  additionalProperties: false,
});

const GENERIC_MODEL_PAGE_LIMIT = 50;
const NAMESPACE_MODEL_PAGE_LIMIT = 100;

const builtInSchema = z.object({
  kind: z.enum(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Service', 'Ingress', 'ConfigMap', 'PVC', 'HPA', 'Namespace', 'Node', 'Event']),
  namespace: namespaceSchema.optional(),
  label_selector: selectorSchema.optional(),
  field_selector: selectorSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  continue_token: continuationTokenSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.namespace === 'all') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['namespace'],
      message: 'omit namespace to query all allowed namespaces; do not pass the literal value "all"'
    });
  }
}).transform((value) => ({
  ...value,
  // Namespace and Node use cluster-scoped Kubernetes APIs. A namespace filter
  // is meaningless for those kinds, so discard model-supplied guesses before
  // scope authorization and execution.
  namespace: ['Namespace', 'Node'].includes(value.kind) ? undefined : value.namespace,
  limit: Math.min(
    value.limit ?? (value.kind === 'Namespace' ? NAMESPACE_MODEL_PAGE_LIMIT : GENERIC_MODEL_PAGE_LIMIT),
    value.kind === 'Namespace' ? NAMESPACE_MODEL_PAGE_LIMIT : GENERIC_MODEL_PAGE_LIMIT
  )
}));

const customResourceSchema = z.object({
  addition_key: z.string().min(1).max(64),
  resource: z.string().min(1).max(253),
  namespace: namespaceSchema.optional(),
  label_selector: selectorSchema.optional(),
  field_selector: selectorSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(50),
  continue_token: continuationTokenSchema.optional()
}).strict();

const schema = z.union([builtInSchema, customResourceSchema]);

/** Convert a Kubernetes API object into a compact list item summary. */
function summarizeResource(kind: string, item: any): Record<string, unknown> {
  const metadata = item?.metadata || {};
  const base = {
    name: metadata.name || '',
    namespace: metadata.namespace || undefined,
    uid: metadata.uid || undefined,
    createdAt: metadata.creationTimestamp || undefined
  };

  if (kind === 'Pod') {
    const statuses = Array.isArray(item?.status?.containerStatuses) ? item.status.containerStatuses : [];
    const restartCount = statuses.reduce((acc: number, status: { restartCount?: number }) => acc + (status.restartCount || 0), 0);
    return {
      ...base,
      phase: item?.status?.phase || 'Unknown',
      nodeName: item?.spec?.nodeName || '',
      restartCount
    };
  }

  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    return {
      ...base,
      replicas: item?.status?.replicas ?? item?.spec?.replicas ?? 0,
      readyReplicas: item?.status?.readyReplicas ?? 0,
      availableReplicas: item?.status?.availableReplicas ?? 0
    };
  }

  if (kind === 'CronJob') {
    return {
      ...base,
      schedule: item?.spec?.schedule || '',
      suspend: Boolean(item?.spec?.suspend),
      active: Array.isArray(item?.status?.active) ? item.status.active.length : 0,
      lastScheduleTime: item?.status?.lastScheduleTime || undefined
    };
  }

  if (kind === 'Job') {
    return {
      ...base,
      completions: item?.spec?.completions ?? 1,
      succeeded: item?.status?.succeeded ?? 0,
      failed: item?.status?.failed ?? 0,
      active: item?.status?.active ?? 0,
      startTime: item?.status?.startTime || undefined,
      completionTime: item?.status?.completionTime || undefined
    };
  }

  if (kind === 'Service') {
    return {
      ...base,
      type: item?.spec?.type || 'ClusterIP',
      clusterIP: item?.spec?.clusterIP || ''
    };
  }

  if (kind === 'Ingress') {
    return {
      ...base,
      hosts: (item?.spec?.rules || []).map((rule: any) => rule?.host).filter(Boolean),
      ingressClassName: item?.spec?.ingressClassName || '',
    };
  }

  if (kind === 'PVC') {
    return {
      ...base,
      phase: item?.status?.phase || 'Unknown',
      capacity: item?.status?.capacity?.storage || '',
      storageClassName: item?.spec?.storageClassName || '',
    };
  }

  if (kind === 'HPA') {
    return {
      ...base,
      minReplicas: item?.spec?.minReplicas ?? 1,
      maxReplicas: item?.spec?.maxReplicas ?? 0,
      currentReplicas: item?.status?.currentReplicas ?? 0,
      desiredReplicas: item?.status?.desiredReplicas ?? 0,
      targetKind: item?.spec?.scaleTargetRef?.kind || '',
      targetName: item?.spec?.scaleTargetRef?.name || '',
    };
  }

  if (kind === 'Node') {
    return {
      ...base,
      phase: summarizeNodePhase(item)
    };
  }

  if (kind === 'Event') {
    return {
      ...base,
      reason: item?.reason || '',
      type: item?.type || '',
      message: item?.message || ''
    };
  }

  return base;
}

/** Return identity and concurrency metadata for an administrator-approved custom resource. */
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

/** Derive the human-readable node phase from Kubernetes readiness conditions. */
function summarizeNodePhase(item: any): string {
  if (item?.status?.phase) {
    return item.status.phase;
  }

  const conditions = Array.isArray(item?.status?.conditions) ? item.status.conditions : [];
  const readyCondition = conditions.find((condition: any) => condition?.type === 'Ready');

  if (readyCondition?.status === 'True') {
    return 'Ready';
  }
  if (readyCondition?.status === 'False') {
    return 'NotReady';
  }

  return 'Unknown';
}

/** Handle a request to list Kubernetes resources by kind. */
export async function listResourcesHandler(params: z.infer<typeof schema>) {
  if ('addition_key' in params) {
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
    const items = Array.isArray((response as any)?.items) ? (response as any).items : [];
    return {
      kind: definition.kind,
      namespace: params.namespace || '*',
      total: items.length,
      continue_token: String((response as any)?.metadata?._continue || ''),
      items: items.map(summarizeCustomResource)
    };
  }
  const { kind, namespace, label_selector, field_selector, limit, continue_token } = params;
  checkNamespaceAllowed(namespace);

  const effectiveScope = getEffectiveNamespaceScope();
  if (!namespace && !['Node', 'Namespace'].includes(kind) && hasBoundedNamespaceInclude()) {
    if (effectiveScope.include.length === 0) {
      return { kind, namespace: '*', total: 0, continue_token: '', items: [] };
    }
    return listAcrossAllowedNamespaces(params, effectiveScope.include.filter(isNamespaceAllowed).sort());
  }

  const listOptions = {
    labelSelector: label_selector,
    fieldSelector: field_selector,
    limit,
    _continue: continue_token
  };

  let response: KubernetesListObject<KubernetesObject>;
  switch (kind) {
    case 'Pod':
      response = namespace
        ? await k8sClient.core.listNamespacedPod({ namespace, ...listOptions })
        : await k8sClient.core.listPodForAllNamespaces(listOptions);
      break;
    case 'Deployment':
      response = namespace
        ? await k8sClient.apps.listNamespacedDeployment({ namespace, ...listOptions })
        : await k8sClient.apps.listDeploymentForAllNamespaces(listOptions);
      break;
    case 'StatefulSet':
      response = namespace
        ? await k8sClient.apps.listNamespacedStatefulSet({ namespace, ...listOptions })
        : await k8sClient.apps.listStatefulSetForAllNamespaces(listOptions);
      break;
    case 'DaemonSet':
      response = namespace
        ? await k8sClient.apps.listNamespacedDaemonSet({ namespace, ...listOptions })
        : await k8sClient.apps.listDaemonSetForAllNamespaces(listOptions);
      break;
    case 'CronJob':
      response = namespace
        ? await k8sClient.batch.listNamespacedCronJob({ namespace, ...listOptions })
        : await k8sClient.batch.listCronJobForAllNamespaces(listOptions);
      break;
    case 'Job':
      response = namespace
        ? await k8sClient.batch.listNamespacedJob({ namespace, ...listOptions })
        : await k8sClient.batch.listJobForAllNamespaces(listOptions);
      break;
    case 'Service':
      response = namespace
        ? await k8sClient.core.listNamespacedService({ namespace, ...listOptions })
        : await k8sClient.core.listServiceForAllNamespaces(listOptions);
      break;
    case 'ConfigMap':
      response = namespace
        ? await k8sClient.core.listNamespacedConfigMap({ namespace, ...listOptions })
        : await k8sClient.core.listConfigMapForAllNamespaces(listOptions);
      break;
    case 'Ingress':
      response = namespace
        ? await k8sClient.networking.listNamespacedIngress({ namespace, ...listOptions })
        : await k8sClient.networking.listIngressForAllNamespaces(listOptions);
      break;
    case 'PVC':
      response = namespace
        ? await k8sClient.core.listNamespacedPersistentVolumeClaim({ namespace, ...listOptions })
        : await k8sClient.core.listPersistentVolumeClaimForAllNamespaces(listOptions);
      break;
    case 'HPA':
      response = namespace
        ? await k8sClient.autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace, ...listOptions })
        : await k8sClient.autoscaling.listHorizontalPodAutoscalerForAllNamespaces(listOptions);
      break;
    case 'Namespace':
      response = await k8sClient.core.listNamespace(listOptions);
      break;
    case 'Node':
      response = await k8sClient.core.listNode(listOptions);
      break;
    case 'Event':
      response = namespace
        ? await k8sClient.core.listNamespacedEvent({ namespace, ...listOptions })
        : await k8sClient.core.listEventForAllNamespaces(listOptions);
      break;
    default:
      throw new Error(`Unsupported kind for list_resources: ${kind}`);
  }

  let items = Array.isArray(response?.items) ? response.items : [];
  if (!namespace && kind !== 'Node') {
    items = kind === 'Namespace'
      ? items.filter((item: any) => isNamespaceAllowed(item?.metadata?.name))
      : filterNamespaceItems(items, (item: any) => item?.metadata?.namespace);
  }
  return {
    kind,
    namespace: namespace || '*',
    total: items.length,
    continue_token: response?.metadata?._continue || '',
    items: items.map((item) => summarizeResource(kind, item))
  };
}

interface ScopedContinueToken {
  v: 1;
  namespaceIndex: number;
  namespace: string;
  scopeHash: string;
  kubernetesToken: string;
}

/** Bind a scoped cursor to its authorized namespace set and Kubernetes query. */
function scopedQueryHash(params: z.infer<typeof schema>, namespaces: string[]): string {
  const builtInParams = params as z.infer<typeof builtInSchema>;
  return createHash('sha256').update(JSON.stringify({
    kind: builtInParams.kind,
    labelSelector: builtInParams.label_selector || '',
    fieldSelector: builtInParams.field_selector || '',
    namespaces,
  })).digest('hex').slice(0, 24);
}

/** Decode and validate an opaque namespace-fanout cursor. */
function decodeScopedToken(value: string | undefined, namespaces: string[], scopeHash: string): ScopedContinueToken {
  if (!value) return { v: 1, namespaceIndex: 0, namespace: namespaces[0] || '', scopeHash, kubernetesToken: '' };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ScopedContinueToken;
    if (
      parsed.v !== 1 || !Number.isInteger(parsed.namespaceIndex) || parsed.namespaceIndex < 0 ||
      typeof parsed.namespace !== 'string' || parsed.namespace !== namespaces[parsed.namespaceIndex] ||
      parsed.scopeHash !== scopeHash ||
      typeof parsed.kubernetesToken !== 'string'
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'Invalid scoped continuation token');
  }
}

/** Encode namespace-fanout cursor state for a subsequent request. */
function encodeScopedToken(token: ScopedContinueToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

/** List namespaced resources across the effective include set with bounded pagination. */
async function listAcrossAllowedNamespaces(
  params: z.infer<typeof schema>,
  namespaces: string[]
): Promise<Record<string, unknown>> {
  const builtInParams = params as z.infer<typeof builtInSchema>;
  const scopeHash = scopedQueryHash(params, namespaces);
  const cursor = decodeScopedToken(params.continue_token, namespaces, scopeHash);
  if (cursor.namespaceIndex >= namespaces.length) throw new ToolExecutionError('INVALID_ARGUMENTS', 'Invalid scoped continuation token');
  const items: Array<Record<string, unknown>> = [];
  let namespaceIndex = cursor.namespaceIndex;
  let kubernetesToken = cursor.kubernetesToken;
  let nextToken = '';

  while (namespaceIndex < namespaces.length && items.length < builtInParams.limit) {
    const namespace = namespaces[namespaceIndex]!;
    if (!isNamespaceAllowed(namespace)) throw new ToolExecutionError('NAMESPACE_FORBIDDEN', 'Scoped continuation token references a forbidden namespace');
    const page = await listResourcesHandler({
      ...builtInParams,
      namespace,
      limit: builtInParams.limit - items.length,
      continue_token: kubernetesToken || undefined,
    }) as { items: Array<Record<string, unknown>>; continue_token: string };
    items.push(...page.items);
    if (page.continue_token) {
      nextToken = encodeScopedToken({ v: 1, namespaceIndex, namespace, scopeHash, kubernetesToken: page.continue_token });
      break;
    }
    namespaceIndex++;
    kubernetesToken = '';
    if (namespaceIndex < namespaces.length) {
      nextToken = encodeScopedToken({
        v: 1,
        namespaceIndex,
        namespace: namespaces[namespaceIndex]!,
        scopeHash,
        kubernetesToken: '',
      });
    }
  }

  return {
    kind: builtInParams.kind,
    namespace: '*',
    total: items.length,
    continue_token: nextToken,
    items,
  };
}

export const listResourcesTool: ToolDefinition = {
  name: 'list_resources',
  description: 'List built-in Kubernetes resources by kind, or an administrator-approved custom resource by addition_key and resource. Supports namespace and selector filters. For built-in resources, omit namespace entirely to query all allowed namespaces; never pass namespace="all" or namespace="*". Follow continue_token until it is empty.',
  capability: 'read',
  timeoutMs: 12000,
  version: 'v2',
  outputSchema: OUTPUT_SCHEMA,
  artifactPolicy: 'if_detailed',
  schema,
  scopeResolver: (params) => 'addition_key' in params
    ? (params.namespace
      ? { type: 'namespace-collection', namespace: params.namespace }
      : { type: 'cluster', kind: params.resource })
    : ['Node', 'Namespace'].includes(params.kind)
      ? ({ type: 'cluster', kind: params.kind })
      : ({ type: 'namespace-collection', namespace: params.namespace }),
  handler: listResourcesHandler,
  projectForModel: (result) => {
    const kind = result?.kind;
    const items = Array.isArray(result?.items) ? result.items : [];
    const hasMore = Boolean(result?.continue_token);
    const projectedItems = kind === 'Namespace'
      ? items.map((item: Record<string, unknown>) => ({ name: item.name }))
      : items;
    const bounded = boundedItems(
      projectedItems,
      kind === 'Namespace' ? NAMESPACE_MODEL_PAGE_LIMIT : GENERIC_MODEL_PAGE_LIMIT
    );
    return {
      schemaVersion: 'acornops.model-context.v1',
      tool: 'list_resources',
      status: 'success',
      summary: `Returned ${result?.total ?? bounded.items.length} ${result?.kind || 'resource'} item(s) on this page from ${result?.namespace === '*' ? 'all allowed namespaces' : result?.namespace || 'the requested scope'}.${hasMore ? ' More results are available; call list_resources again with continue_token to complete the listing.' : ' The listing is complete.'}`,
      data: {
        kind,
        namespace: result?.namespace,
        total: result?.total,
        returnedCount: result?.total,
        hasMore,
        continue_token: result?.continue_token,
        items: bounded.items,
      },
      omissions: bounded.omissions,
    };
  },
};
