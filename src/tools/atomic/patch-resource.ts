import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, SUPPORTED_RESOURCE_PATCH_KINDS, SupportedResourcePatchKind } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { WRITE_TOOL_RESULT_OUTPUT_SCHEMA, writeProjection } from '../model-context.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import {
  annotationValueSchema,
  kubernetesNameSchema,
  kubernetesUidSchema,
  labelValueSchema,
  namespaceSchema,
  qualifiedNameSchema,
  reasonSchema,
} from '../schemas.js';
import {
  checkNamespaceAllowed,
  checkOperationNotAborted,
  checkWriteEnabled,
  getAnnotations,
  operationAnnotationsMatch,
} from '../utils.js';
import { WriteReceipt } from '../write-receipt.js';
import {
  patchCustomResourceHandler,
  patchCustomResourceSchema,
  type CustomResourcePatchReceipt
} from './patch-custom-resource.js';

const setLabelSchema = z.object({
  type: z.literal('set_label'),
  key: qualifiedNameSchema,
  expected_value: labelValueSchema.nullable(),
  value: labelValueSchema,
}).strict();
const removeLabelSchema = z.object({
  type: z.literal('remove_label'),
  key: qualifiedNameSchema,
  expected_value: labelValueSchema,
}).strict();
const setAnnotationSchema = z.object({
  type: z.literal('set_annotation'),
  key: qualifiedNameSchema,
  expected_value: annotationValueSchema.nullable(),
  value: annotationValueSchema,
}).strict();
const removeAnnotationSchema = z.object({
  type: z.literal('remove_annotation'),
  key: qualifiedNameSchema,
  expected_value: annotationValueSchema,
}).strict();
const setServiceSelectorSchema = z.object({
  type: z.literal('set_service_selector'),
  key: qualifiedNameSchema,
  expected_value: labelValueSchema.nullable(),
  value: labelValueSchema,
}).strict();
const removeServiceSelectorSchema = z.object({
  type: z.literal('remove_service_selector'),
  key: qualifiedNameSchema,
  expected_value: labelValueSchema,
}).strict();

export const resourcePatchChangeSchema = z.discriminatedUnion('type', [
  setLabelSchema,
  removeLabelSchema,
  setAnnotationSchema,
  removeAnnotationSchema,
  setServiceSelectorSchema,
  removeServiceSelectorSchema,
]);
export type ResourcePatchChange = z.infer<typeof resourcePatchChangeSchema>;

/** Return a stable semantic location for duplicate detection and receipts. */
function location(change: ResourcePatchChange): string {
  if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
    return `resource:service_selector:${change.key}`;
  }
  return `resource:${change.type.endsWith('label') ? 'label' : 'annotation'}:${change.key}`;
}

/** Return whether an annotation key suggests secret-bearing content. */
function isSensitiveAnnotationKey(key: string): boolean {
  if (key.startsWith('checksum/')) return false;
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['secret', 'token', 'password', 'passwd', 'credential', 'authorization', 'apikey', 'privatekey']
    .some((fragment) => normalized.includes(fragment));
}

/** Return whether a metadata key is reserved for AgentK bookkeeping. */
function isProtectedMetadataKey(key: string): boolean {
  return key.startsWith('acornops.dev/');
}

/** Return whether an annotation is owned by AgentK or a specialized tool. */
function isProtectedAnnotationKey(key: string): boolean {
  return isProtectedMetadataKey(key) || key === 'kubectl.kubernetes.io/restartedAt';
}

const builtInPatchResourceSchema = z.object({
  kind: z.enum(SUPPORTED_RESOURCE_PATCH_KINDS),
  namespace: namespaceSchema,
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  expected_resource_version: z.string().min(1).max(128),
  reason: reasonSchema,
  confirm_service_selector_change: z.boolean().optional().default(false),
  changes: z.array(resourcePatchChangeSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  if (!config.ACORNOPS_AGENT_RESOURCE_PATCH_KINDS.includes(value.kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: `${value.kind} is not enabled by local patch policy` });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Semantic patch exceeds the 32 KiB limit' });
  }
  const locations = new Set<string>();
  for (const [index, change] of value.changes.entries()) {
    const changeLocation = location(change);
    if (locations.has(changeLocation)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: `Duplicate patch location: ${changeLocation}` });
    }
    locations.add(changeLocation);
    if ((change.type === 'set_service_selector' || change.type === 'remove_service_selector') && value.kind !== 'Service') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: `${change.type} is available only for Service` });
    }
    if ((change.type === 'set_label' || change.type === 'set_annotation' || change.type === 'set_service_selector') &&
        change.expected_value === change.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'value'], message: 'Set change must not be a no-op' });
    }
    if ((change.type === 'set_annotation' || change.type === 'remove_annotation') &&
        (isProtectedAnnotationKey(change.key) || isSensitiveAnnotationKey(change.key))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'key'], message: 'Annotation key is protected or sensitive' });
    }
    if ((change.type === 'set_label' || change.type === 'remove_label') && isProtectedMetadataKey(change.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'key'], message: 'Label key is protected' });
    }
    if ((change.type === 'set_annotation' || change.type === 'remove_annotation') && change.key.startsWith('checksum/')) {
      const values = change.type === 'set_annotation'
        ? [change.expected_value, change.value]
        : [change.expected_value];
      if (values.some((item) => item !== null && !/^[a-fA-F0-9]{32,128}$/.test(item))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['changes', index],
          message: 'Checksum annotations require hexadecimal digest values',
        });
      }
    }
  }
  const selectorChange = value.changes.some((change) =>
    change.type === 'set_service_selector' || change.type === 'remove_service_selector');
  if (selectorChange && (!config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH || !value.confirm_service_selector_change)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirm_service_selector_change'],
      message: 'Service selector changes require operator enablement and caller confirmation',
    });
  }
});

export const patchResourceSchema = z.union([builtInPatchResourceSchema, patchCustomResourceSchema]);
type BuiltInPatchResourceRequest = z.infer<typeof builtInPatchResourceSchema>;

export type PatchResourceRequest = z.infer<typeof patchResourceSchema>;

/** Read the current scalar value addressed by a resource patch operation. */
function currentValue(resource: any, change: ResourcePatchChange): string | undefined {
  if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
    return resource.spec?.selector?.[change.key];
  }
  const field = change.type.endsWith('label') ? 'labels' : 'annotations';
  return resource.metadata?.[field]?.[change.key];
}

/** Return whether all requested resource changes are visible. */
function desiredStateMatches(resource: any, request: BuiltInPatchResourceRequest): boolean {
  return request.changes.every((change) => {
    const actual = currentValue(resource, change);
    return change.type === 'set_label' || change.type === 'set_annotation' || change.type === 'set_service_selector'
      ? actual === change.value
      : actual === undefined;
  });
}

/** Return whether Service routing invariants remain valid. */
function invariantsMatch(resource: any, request: BuiltInPatchResourceRequest): boolean {
  const selectorChanged = request.changes.some((change) =>
    change.type === 'set_service_selector' || change.type === 'remove_service_selector');
  return !selectorChanged ||
    (request.kind === 'Service' && resource.spec?.type !== 'ExternalName' && Object.keys(resource.spec?.selector || {}).length > 0);
}

/** Sort resource changes deterministically for hashing and receipts. */
function canonicalChanges(changes: ResourcePatchChange[]): ResourcePatchChange[] {
  return [...changes].sort((left, right) => location(left).localeCompare(location(right)));
}

/** Compile Service or Ingress semantic operations into one guarded JSON Patch. */
function compilePatch(current: any, request: BuiltInPatchResourceRequest, operationId: string, operationHash: string) {
  if (!current.metadata?.uid || !current.metadata?.resourceVersion) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource identity is incomplete');
  }
  const proposed = structuredClone(current);
  const changes = canonicalChanges(request.changes);
  const body: Array<Record<string, unknown>> = [
    { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
  ];
  const touched = new Set<string>();
  for (const change of changes) {
    const actual = currentValue(current, change);
    const expected = change.expected_value;
    if (expected === null ? actual !== undefined : actual !== expected) {
      throw new ToolExecutionError('PRECONDITION_FAILED', `Current value changed at ${location(change)}`);
    }
    if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
      proposed.spec ||= {};
      proposed.spec.selector = { ...(proposed.spec.selector || {}) };
      if (change.type === 'set_service_selector') proposed.spec.selector[change.key] = change.value;
      else delete proposed.spec.selector[change.key];
      touched.add('selector');
    } else {
      const field = change.type.endsWith('label') ? 'labels' : 'annotations';
      proposed.metadata ||= {};
      proposed.metadata[field] = { ...(proposed.metadata[field] || {}) };
      if (change.type === 'set_label' || change.type === 'set_annotation') proposed.metadata[field][change.key] = change.value;
      else delete proposed.metadata[field][change.key];
      touched.add(field);
    }
  }
  if (!invariantsMatch(proposed, request)) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Service selector changes require a non-empty selector on a non-ExternalName Service');
  }
  proposed.metadata.annotations = {
    ...(proposed.metadata.annotations || {}),
    ...getAnnotations(request.reason, operationId),
    'acornops.dev/operation-hash': operationHash,
    'acornops.dev/operation-kind': 'patch',
  };
  touched.add('annotations');
  for (const field of [...touched].sort()) {
    body.push(field === 'selector'
      ? { op: 'add', path: '/spec/selector', value: proposed.spec.selector }
      : { op: 'add', path: `/metadata/${field}`, value: proposed.metadata[field] });
  }
  return {
    body,
    changes,
    rolloutTriggered: false,
    serviceRoutingChanged: changes.some((change) =>
      change.type === 'set_service_selector' || change.type === 'remove_service_selector'),
  };
}

/** Read one supported Service or Ingress target. */
async function readResource(kind: SupportedResourcePatchKind, name: string, namespace: string): Promise<any> {
  return kind === 'Service'
    ? k8sClient.core.readNamespacedService({ name, namespace })
    : k8sClient.networking.readNamespacedIngress({ name, namespace });
}

/** Submit a guarded JSON Patch to the supported resource API. */
async function applyPatch(kind: SupportedResourcePatchKind, name: string, namespace: string, body: any[], dryRun?: 'All'): Promise<any> {
  const options = { name, namespace, body, dryRun, fieldManager: 'acornops-agentk', fieldValidation: 'Strict' };
  return kind === 'Service'
    ? k8sClient.core.patchNamespacedService(options)
    : k8sClient.networking.patchNamespacedIngress(options);
}

interface ResourcePatchSummary {
  changes: ResourcePatchChange[];
  serviceRoutingChanged: boolean;
}

/** Build a metadata-value-free Service or Ingress mutation receipt. */
function buildReceipt(request: BuiltInPatchResourceRequest, resource: any, operationId: string, compiled: ResourcePatchSummary): WriteReceipt {
  return {
    success: true,
    operationId,
    target: {
      kind: request.kind,
      namespace: request.namespace,
      name: request.name,
      uid: String(resource.metadata?.uid || ''),
    },
    change: {
      type: 'patch',
      changeCount: compiled.changes.length,
      rolloutTriggered: false,
      serviceRoutingChanged: compiled.serviceRoutingChanged,
      fields: compiled.changes.map((change) => ({ type: change.type, location: location(change) })),
    },
    observed: { resourceVersion: String(resource.metadata?.resourceVersion || '') },
    ...(compiled.serviceRoutingChanged ? { warnings: ['Service selector changes can immediately redirect traffic.'] } : {}),
  };
}

/** Apply a guarded Service or Ingress semantic patch. */
export async function patchResourceHandler(
  request: PatchResourceRequest,
  context?: ToolExecutionContext
): Promise<WriteReceipt | CustomResourcePatchReceipt> {
  if ('addition_key' in request) {
    return patchCustomResourceHandler(request, context);
  }
  const builtInRequest = request as BuiltInPatchResourceRequest;
  checkWriteEnabled();
  checkNamespaceAllowed(builtInRequest.namespace);
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const normalized = { ...builtInRequest, changes: canonicalChanges(builtInRequest.changes) };
  const operationHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const current = await readResource(builtInRequest.kind, builtInRequest.name, builtInRequest.namespace);
  checkOperationNotAborted(context, operationId);
  if (current.metadata?.uid !== builtInRequest.expected_uid) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource UID does not match the expected target');
  }
  if (current.metadata?.annotations?.['acornops.dev/operation-id'] === operationId) {
    if (!operationAnnotationsMatch(current.metadata?.annotations, operationId, operationHash, 'patch') ||
        !desiredStateMatches(current, builtInRequest) || !invariantsMatch(current, builtInRequest)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different patch arguments or state');
    }
    return buildReceipt(builtInRequest, current, operationId, {
      changes: normalized.changes,
      serviceRoutingChanged: normalized.changes.some((change) =>
        change.type === 'set_service_selector' || change.type === 'remove_service_selector'),
    });
  }
  if (current.metadata?.resourceVersion !== builtInRequest.expected_resource_version) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource version does not match the inspected resource');
  }
  const compiled = compilePatch(current, normalized, operationId, operationHash);
  const dryRunResult = await applyPatch(builtInRequest.kind, builtInRequest.name, builtInRequest.namespace, compiled.body, 'All');
  checkOperationNotAborted(context, operationId);
  if (dryRunResult.metadata?.uid !== builtInRequest.expected_uid || !desiredStateMatches(dryRunResult, builtInRequest) ||
      !operationAnnotationsMatch(dryRunResult.metadata?.annotations, operationId, operationHash, 'patch') ||
      !invariantsMatch(dryRunResult, builtInRequest)) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Kubernetes dry-run returned an inconsistent patched resource');
  }
  const updated = await applyPatch(builtInRequest.kind, builtInRequest.name, builtInRequest.namespace, compiled.body);
  if (updated.metadata?.uid !== builtInRequest.expected_uid || !updated.metadata?.resourceVersion ||
      updated.metadata.resourceVersion === current.metadata.resourceVersion || !desiredStateMatches(updated, builtInRequest) ||
      !operationAnnotationsMatch(updated.metadata?.annotations, operationId, operationHash, 'patch') ||
      !invariantsMatch(updated, builtInRequest)) {
    throw new ToolExecutionError(
      'KUBERNETES_ERROR',
      'Kubernetes accepted the patch but returned an inconsistent resource',
      { outcome: 'unknown', operationId, reason: 'PostWriteVerificationFailed', phase: 'verification' },
    );
  }
  return buildReceipt(builtInRequest, updated, operationId, compiled);
}

export const patchResourceTool: ToolDefinition = {
  name: 'patch_resource',
  description: 'Update supported metadata or specifications on an inspected resource.',
  capability: 'write',
  timeoutMs: 20000,
  version: 'v3',
  outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA,
  artifactPolicy: 'never',
  schema: patchResourceSchema,
  scopeResolver: (params) => 'addition_key' in params && !params.namespace
    ? { type: 'cluster', kind: params.resource }
    : { type: 'namespaced', namespace: params.namespace },
  handler: patchResourceHandler,
  projectForModel: (result) => writeProjection('patch_resource', result),
};
