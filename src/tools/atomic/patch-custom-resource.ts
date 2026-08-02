import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { ToolExecutionContext } from '../registry.js';
import { kubernetesNameSchema, kubernetesUidSchema, namespaceSchema, reasonSchema } from '../schemas.js';
import {
  checkNamespaceAllowed,
  checkOperationNotAborted,
  checkWriteEnabled,
  getAnnotations,
  operationAnnotationsMatch
} from '../utils.js';
import { requireCustomResourceAddition } from '../custom-resource-additions.js';

const patchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'remove']),
  path: z.string().min(6).max(512).regex(/^\/spec(?:\/[^/~]*(?:~[01][^/~]*)*)+$/, 'Custom-resource patches are limited to /spec paths'),
  value: z.unknown().optional()
}).strict().superRefine((operation, ctx) => {
  if (operation.op !== 'remove' && !Object.prototype.hasOwnProperty.call(operation, 'value')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `${operation.op} requires value` });
  }
  if (operation.op === 'remove' && Object.prototype.hasOwnProperty.call(operation, 'value')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'remove must not include value' });
  }
});

export const patchCustomResourceSchema = z.object({
  addition_key: z.string().min(1).max(64),
  resource: z.string().min(1).max(253),
  namespace: namespaceSchema.optional(),
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  expected_resource_version: z.string().min(1).max(128),
  reason: reasonSchema,
  operations: z.array(patchOperationSchema).min(1).max(20)
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom-resource patch exceeds the 32 KiB limit' });
  }
  const paths = value.operations.map((operation) => operation.path);
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['operations'], message: 'Patch paths must not contain duplicates' });
  }
  for (const [index, operation] of value.operations.entries()) {
    const segments = operation.path.split('/').slice(2).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segments.some((segment) => segment === '-' || /^\d+$/.test(segment))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'path'],
        message: 'Array-element custom-resource patches are not supported'
      });
    }
  }
});

type CustomResourcePatchRequest = z.infer<typeof patchCustomResourceSchema>;

export interface CustomResourcePatchReceipt {
  success: true;
  operationId: string;
  target: { kind: string; namespace?: string; name: string; uid: string };
  change: { type: 'patch'; additionKey: string; resource: string; paths: string[] };
  observed: { resourceVersion: string };
}

/** Read one JSON Pointer from a custom resource. */
function pointerValue(resource: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = path.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = resource;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** Return whether the admitted resource reflects every requested spec change. */
function desiredStateMatches(resource: unknown, request: CustomResourcePatchRequest): boolean {
  return request.operations.every((operation) => {
    const observed = pointerValue(resource, operation.path);
    return operation.op === 'remove'
      ? !observed.found
      : observed.found && isDeepStrictEqual(observed.value, operation.value);
  });
}

/** List one exact target privately using the addition's required list permission. */
async function readCustomResource(
  definition: ReturnType<typeof requireCustomResourceAddition>,
  request: CustomResourcePatchRequest
): Promise<any> {
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    fieldSelector: `metadata.name=${request.name}`,
    limit: 2
  };
  const response = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.listNamespacedCustomObject({ ...options, namespace: request.namespace! })
    : await k8sClient.customObjects.listClusterCustomObject(options);
  const items = Array.isArray((response as any)?.items) ? (response as any).items : [];
  if (items.length !== 1 || items[0]?.metadata?.name !== request.name) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Custom-resource target was not found uniquely');
  }
  return items[0];
}

/** Build a value-free custom-resource mutation receipt. */
function buildReceipt(
  definition: ReturnType<typeof requireCustomResourceAddition>,
  request: CustomResourcePatchRequest,
  resource: any,
  operationId: string
): CustomResourcePatchReceipt {
  return {
    success: true,
    operationId,
    target: {
      kind: definition.kind,
      namespace: request.namespace,
      name: request.name,
      uid: request.expected_uid
    },
    change: {
      type: 'patch',
      additionKey: definition.additionKey,
      resource: definition.resource,
      paths: request.operations.map((operation) => operation.path)
    },
    observed: { resourceVersion: String(resource.metadata.resourceVersion) }
  };
}

/** Apply one guarded JSON Patch to an administrator-approved custom resource. */
export async function patchCustomResourceHandler(
  request: CustomResourcePatchRequest,
  context?: ToolExecutionContext
): Promise<CustomResourcePatchReceipt> {
  checkWriteEnabled();
  const definition = requireCustomResourceAddition(request.addition_key, request.resource, 'patch');
  if (definition.scope === 'namespaced' && !request.namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace is required for this custom resource');
  }
  if (definition.scope === 'cluster' && request.namespace) {
    throw new ToolExecutionError('INVALID_ARGUMENTS', 'namespace must be omitted for this cluster-scoped custom resource');
  }
  checkNamespaceAllowed(request.namespace);
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const operationHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const current = await readCustomResource(definition, request);
  checkOperationNotAborted(context, operationId);
  if (current.metadata?.uid !== request.expected_uid) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Custom-resource UID does not match the expected target');
  }
  if (current.metadata?.annotations?.['acornops.dev/operation-id'] === operationId) {
    if (!operationAnnotationsMatch(current.metadata.annotations, operationId, operationHash, 'patch') ||
        !desiredStateMatches(current, request)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different custom-resource arguments or state');
    }
    return buildReceipt(definition, request, current, operationId);
  }
  if (current.metadata?.resourceVersion !== request.expected_resource_version) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource version does not match the inspected custom resource');
  }
  const annotations = {
    ...(current.metadata?.annotations || {}),
    ...getAnnotations(request.reason, operationId),
    'acornops.dev/operation-hash': operationHash,
    'acornops.dev/operation-kind': 'patch'
  };
  const body = [
    { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'add', path: '/metadata/annotations', value: annotations },
    ...request.operations
  ];
  const options = {
    group: definition.apiGroup,
    version: definition.apiVersion,
    plural: definition.resource,
    name: request.name,
    body,
    fieldManager: 'acornops-agentk',
    fieldValidation: 'Strict'
  };
  const dryRunResult = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.patchNamespacedCustomObject(
      { ...options, namespace: request.namespace!, dryRun: 'All' })
    : await k8sClient.customObjects.patchClusterCustomObject({ ...options, dryRun: 'All' });
  checkOperationNotAborted(context, operationId);
  if ((dryRunResult as any)?.metadata?.uid !== request.expected_uid ||
      !desiredStateMatches(dryRunResult, request) ||
      !operationAnnotationsMatch((dryRunResult as any)?.metadata?.annotations, operationId, operationHash, 'patch')) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Kubernetes dry-run returned an inconsistent custom resource');
  }
  const updated = definition.scope === 'namespaced'
    ? await k8sClient.customObjects.patchNamespacedCustomObject({ ...options, namespace: request.namespace! })
    : await k8sClient.customObjects.patchClusterCustomObject(options);
  if ((updated as any)?.metadata?.uid !== request.expected_uid || !(updated as any)?.metadata?.resourceVersion ||
      (updated as any).metadata.resourceVersion === current.metadata.resourceVersion ||
      !desiredStateMatches(updated, request) ||
      !operationAnnotationsMatch((updated as any)?.metadata?.annotations, operationId, operationHash, 'patch')) {
    throw new ToolExecutionError('KUBERNETES_ERROR', 'Kubernetes accepted the patch but returned an inconsistent custom resource', {
      outcome: 'unknown', operationId, reason: 'PostWriteVerificationFailed', phase: 'verification'
    });
  }
  return buildReceipt(definition, request, updated, operationId);
}
