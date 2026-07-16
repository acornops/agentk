import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, SUPPORTED_PATCH_KINDS, SupportedPatchKind } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import {
  annotationValueSchema,
  containerNameSchema,
  imageReferenceSchema,
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
import { WRITE_TOOL_RESULT_OUTPUT_SCHEMA, writeProjection } from '../model-context.js';

const workloadKinds = new Set<SupportedPatchKind>(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']);
const scopeSchema = z.enum(['resource', 'pod_template']);

const setImageSchema = z.object({
  type: z.literal('set_image'),
  container_type: z.enum(['container', 'init_container']),
  container: containerNameSchema,
  expected_image: imageReferenceSchema,
  image: imageReferenceSchema,
}).strict();

const setLabelSchema = z.object({
  type: z.literal('set_label'),
  scope: scopeSchema,
  key: qualifiedNameSchema,
  expected_value: labelValueSchema.nullable(),
  value: labelValueSchema,
}).strict();

const removeLabelSchema = z.object({
  type: z.literal('remove_label'),
  scope: scopeSchema,
  key: qualifiedNameSchema,
  expected_value: labelValueSchema,
}).strict();

const setAnnotationSchema = z.object({
  type: z.literal('set_annotation'),
  scope: scopeSchema,
  key: qualifiedNameSchema,
  expected_value: annotationValueSchema.nullable(),
  value: annotationValueSchema,
}).strict();

const removeAnnotationSchema = z.object({
  type: z.literal('remove_annotation'),
  scope: scopeSchema,
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

export const patchChangeSchema = z.discriminatedUnion('type', [
  setImageSchema,
  setLabelSchema,
  removeLabelSchema,
  setAnnotationSchema,
  removeAnnotationSchema,
  setServiceSelectorSchema,
  removeServiceSelectorSchema,
]);

const patchKindSchema = z.enum(SUPPORTED_PATCH_KINDS);

/** Return a stable semantic location for duplicate detection, hashing, and receipts. */
export function patchChangeLocation(change: PatchChange): string {
  if (change.type === 'set_image') return `pod_template:${change.container_type}:${change.container}:image`;
  if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
    return `resource:service_selector:${change.key}`;
  }
  const field = change.type.endsWith('label') ? 'label' : 'annotation';
  return `${change.scope}:${field}:${change.key}`;
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

/** Return whether a resource kind contains a supported Pod template. */
function supportsPodTemplate(kind: SupportedPatchKind): boolean {
  return workloadKinds.has(kind);
}

/** Validate one semantic operation against its target resource kind. */
function validateKindAndChange(kind: SupportedPatchKind, change: PatchChange): string | undefined {
  if (change.type === 'set_image' && !workloadKinds.has(kind)) return `${change.type} is unavailable for ${kind}`;
  if ((change.type === 'set_service_selector' || change.type === 'remove_service_selector') && kind !== 'Service') {
    return `${change.type} is available only for Service`;
  }
  if ('scope' in change && change.scope === 'pod_template' && !supportsPodTemplate(kind)) {
    return `pod_template metadata is unavailable for ${kind}`;
  }
  return undefined;
}

export const patchResourceSchema = z.object({
  kind: patchKindSchema,
  namespace: namespaceSchema,
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  reason: reasonSchema,
  confirm_service_selector_change: z.boolean().optional().default(false),
  changes: z.array(patchChangeSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  if (!config.ACORNOPS_AGENT_PATCH_KINDS.includes(value.kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: `${value.kind} is not enabled by local patch policy` });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Semantic patch exceeds the 32 KiB limit' });
  }
  const locations = new Set<string>();
  for (const [index, change] of value.changes.entries()) {
    const error = validateKindAndChange(value.kind, change);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: error });
    const location = patchChangeLocation(change);
    if (locations.has(location)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: `Duplicate patch location: ${location}` });
    }
    locations.add(location);
    if (change.type === 'set_image' && change.image === change.expected_image) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'image'], message: 'Image change must not be a no-op' });
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
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: 'Checksum annotations require hexadecimal digest values' });
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

export type PatchResourceRequest = z.infer<typeof patchResourceSchema>;
export type PatchChange = z.infer<typeof patchChangeSchema>;

interface CompiledPatch {
  body: Array<Record<string, unknown>>;
  changes: PatchChange[];
  rolloutTriggered: boolean;
  serviceRoutingChanged: boolean;
}

/** Return the JSON pointer for a supported workload Pod template. */
function templatePath(kind: SupportedPatchKind): string {
  return kind === 'CronJob' ? '/spec/jobTemplate/spec/template' : '/spec/template';
}

/** Return a supported workload Pod template from a Kubernetes resource. */
function templateFor(resource: any, kind: SupportedPatchKind): any {
  return kind === 'CronJob' ? resource.spec?.jobTemplate?.spec?.template : resource.spec?.template;
}

/** Return a metadata map at resource or Pod-template scope. */
function mapValue(resource: any, kind: SupportedPatchKind, scope: 'resource' | 'pod_template', field: 'labels' | 'annotations') {
  const metadata = scope === 'resource' ? resource.metadata : templateFor(resource, kind)?.metadata;
  return metadata?.[field] || {};
}

/** Return the expected scalar value from a non-image semantic operation. */
function expectedValue(change: PatchChange): string | null | undefined {
  return 'expected_value' in change ? change.expected_value : undefined;
}

/** Read the current scalar value addressed by a semantic operation. */
function currentChangeValue(resource: any, kind: SupportedPatchKind, change: PatchChange): string | undefined {
  if (change.type === 'set_image') {
    const field = change.container_type === 'container' ? 'containers' : 'initContainers';
    return templateFor(resource, kind)?.spec?.[field]?.find((container: any) => container?.name === change.container)?.image;
  }
  if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
    return resource.spec?.selector?.[change.key];
  }
  const field = change.type.endsWith('label') ? 'labels' : 'annotations';
  return mapValue(resource, kind, change.scope, field)[change.key];
}

/** Reject a patch whose expected field values are no longer current. */
function assertExpectedState(resource: any, request: PatchResourceRequest): void {
  for (const change of request.changes) {
    const actual = currentChangeValue(resource, request.kind, change);
    const expected = change.type === 'set_image' ? change.expected_image : expectedValue(change);
    if (expected === null ? actual !== undefined : actual !== expected) {
      throw new ToolExecutionError('PRECONDITION_FAILED', `Current value changed at ${patchChangeLocation(change)}`);
    }
  }
}

/** Return whether every requested semantic operation is reflected in a resource. */
function desiredStateMatches(resource: any, request: PatchResourceRequest): boolean {
  return request.changes.every((change) => {
    const actual = currentChangeValue(resource, request.kind, change);
    if (change.type === 'set_image') return actual === change.image;
    if (change.type === 'set_label' || change.type === 'set_annotation' || change.type === 'set_service_selector') {
      return actual === change.value;
    }
    return actual === undefined;
  });
}

/** Return whether Pod-template labels still satisfy a workload selector. */
function selectorMatchesLabels(selector: any, labels: Record<string, string>): boolean {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return false;
  const matchLabels = selector.matchLabels || {};
  if (typeof matchLabels !== 'object' || Array.isArray(matchLabels)) return false;
  for (const [key, value] of Object.entries(matchLabels)) {
    if (labels[key] !== value) return false;
  }
  const expressions = selector.matchExpressions || [];
  if (!Array.isArray(expressions)) return false;
  for (const expression of expressions) {
    if (!expression || typeof expression.key !== 'string' || typeof expression.operator !== 'string') return false;
    const value = labels[expression.key];
    const values = Array.isArray(expression.values) ? expression.values : [];
    if (expression.operator === 'In' && (value === undefined || !values.includes(value))) return false;
    if (expression.operator === 'NotIn' && (value === undefined || values.includes(value))) return false;
    if (expression.operator === 'Exists' && value === undefined) return false;
    if (expression.operator === 'DoesNotExist' && value !== undefined) return false;
    if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(expression.operator)) return false;
  }
  return true;
}

/** Return whether safety invariants still hold after admission processing. */
function patchedInvariantsMatch(resource: any, request: PatchResourceRequest): boolean {
  if (workloadKinds.has(request.kind) && request.kind !== 'CronJob') {
    const labels = templateFor(resource, request.kind)?.metadata?.labels || {};
    if (!selectorMatchesLabels(resource.spec?.selector, labels)) return false;
  }
  const changesServiceRouting = request.changes.some((change) =>
    change.type === 'set_service_selector' || change.type === 'remove_service_selector');
  if (request.kind === 'Service' && changesServiceRouting) {
    return resource.spec?.type !== 'ExternalName' && Object.keys(resource.spec?.selector || {}).length > 0;
  }
  return true;
}

/** Sort semantic changes deterministically without mutating caller input. */
function canonicalChanges(changes: PatchChange[]): PatchChange[] {
  return [...changes].sort((left, right) => patchChangeLocation(left).localeCompare(patchChangeLocation(right)));
}

/** Derive user-visible effects directly from semantic operations. */
function patchEffects(kind: SupportedPatchKind, changes: PatchChange[]) {
  return {
    rolloutTriggered: kind !== 'CronJob' && changes.some((change) =>
      change.type === 'set_image' || ('scope' in change && change.scope === 'pod_template')),
    serviceRoutingChanged: changes.some((change) =>
      change.type === 'set_service_selector' || change.type === 'remove_service_selector'),
  };
}

/** Compile validated semantic operations into one guarded Kubernetes JSON Patch. */
function compilePatch(current: any, request: PatchResourceRequest, operationId: string, operationHash: string): CompiledPatch {
  if (!current.metadata?.uid || !current.metadata?.resourceVersion) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource identity is incomplete');
  }
  assertExpectedState(current, request);
  const proposed = structuredClone(current);
  const changes = canonicalChanges(request.changes);
  const body: Array<Record<string, unknown>> = [
    { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
  ];
  const touchedMaps = new Set<string>();
  const { rolloutTriggered, serviceRoutingChanged } = patchEffects(request.kind, changes);

  for (const change of changes) {
    if (change.type === 'set_image') {
      const arrayField = change.container_type === 'container' ? 'containers' : 'initContainers';
      const containers = templateFor(proposed, request.kind)?.spec?.[arrayField];
      const index = Array.isArray(containers) ? containers.findIndex((container: any) => container?.name === change.container) : -1;
      if (index < 0) throw new ToolExecutionError('PRECONDITION_FAILED', `Container not found: ${change.container}`);
      const path = `${templatePath(request.kind)}/spec/${arrayField}/${index}`;
      body.push({ op: 'test', path: `${path}/name`, value: change.container });
      body.push({ op: 'test', path: `${path}/image`, value: change.expected_image });
      body.push({ op: 'replace', path: `${path}/image`, value: change.image });
      containers[index].image = change.image;
      continue;
    }

    if (change.type === 'set_service_selector' || change.type === 'remove_service_selector') {
      proposed.spec ||= {};
      proposed.spec.selector = { ...(proposed.spec.selector || {}) };
      if (change.type === 'set_service_selector') proposed.spec.selector[change.key] = change.value;
      else delete proposed.spec.selector[change.key];
      touchedMaps.add('resource:service_selector');
      continue;
    }

    const field = change.type.endsWith('label') ? 'labels' : 'annotations';
    const metadata = change.scope === 'resource'
      ? (proposed.metadata ||= {})
      : (templateFor(proposed, request.kind).metadata ||= {});
    metadata[field] = { ...(metadata[field] || {}) };
    if (change.type === 'set_label' || change.type === 'set_annotation') metadata[field][change.key] = change.value;
    else delete metadata[field][change.key];
    touchedMaps.add(`${change.scope}:${field}`);
  }

  if (workloadKinds.has(request.kind)) {
    const labels = templateFor(proposed, request.kind)?.metadata?.labels || {};
    if (request.kind !== 'CronJob' && !selectorMatchesLabels(proposed.spec?.selector, labels)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Patched pod-template labels would no longer match the workload selector');
    }
  }
  if (request.kind === 'Service' && serviceRoutingChanged) {
    if (proposed.spec?.type === 'ExternalName') {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'ExternalName Services do not support selector changes');
    }
    if (Object.keys(proposed.spec?.selector || {}).length === 0) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Service selector changes may not leave an empty selector');
    }
  }

  const operationAnnotations = {
    ...(proposed.metadata?.annotations || {}),
    ...getAnnotations(request.reason, operationId),
    'acornops.dev/operation-hash': operationHash,
    'acornops.dev/operation-kind': 'patch',
  };
  proposed.metadata.annotations = operationAnnotations;
  touchedMaps.add('resource:annotations');

  const originalTemplateMetadata = templateFor(current, request.kind)?.metadata;
  const templateMaps = [...touchedMaps].filter((entry) => entry.startsWith('pod_template:'));
  if (templateMaps.length > 0 && !originalTemplateMetadata) {
    body.push({ op: 'add', path: `${templatePath(request.kind)}/metadata`, value: templateFor(proposed, request.kind).metadata });
    templateMaps.forEach((entry) => touchedMaps.delete(entry));
  }
  for (const entry of [...touchedMaps].sort()) {
    if (entry === 'resource:service_selector') {
      body.push({ op: 'add', path: '/spec/selector', value: proposed.spec.selector });
      continue;
    }
    const [scope, field] = entry.split(':') as ['resource' | 'pod_template', 'labels' | 'annotations'];
    const path = scope === 'resource' ? `/metadata/${field}` : `${templatePath(request.kind)}/metadata/${field}`;
    body.push({ op: 'add', path, value: mapValue(proposed, request.kind, scope, field) });
  }

  return { body, changes, rolloutTriggered, serviceRoutingChanged };
}

/** Read one supported resource through its typed Kubernetes API. */
async function readResource(kind: SupportedPatchKind, name: string, namespace: string): Promise<any> {
  if (kind === 'Deployment') return k8sClient.apps.readNamespacedDeployment({ name, namespace });
  if (kind === 'StatefulSet') return k8sClient.apps.readNamespacedStatefulSet({ name, namespace });
  if (kind === 'DaemonSet') return k8sClient.apps.readNamespacedDaemonSet({ name, namespace });
  if (kind === 'CronJob') return k8sClient.batch.readNamespacedCronJob({ name, namespace });
  if (kind === 'Service') return k8sClient.core.readNamespacedService({ name, namespace });
  return k8sClient.networking.readNamespacedIngress({ name, namespace });
}

/** Submit a JSON Patch to the correct typed Kubernetes API. */
async function applyPatch(kind: SupportedPatchKind, name: string, namespace: string, body: any[], dryRun?: 'All'): Promise<any> {
  const options = { name, namespace, body, dryRun, fieldManager: 'acornops-agentk', fieldValidation: 'Strict' };
  if (kind === 'Deployment') return k8sClient.apps.patchNamespacedDeployment(options);
  if (kind === 'StatefulSet') return k8sClient.apps.patchNamespacedStatefulSet(options);
  if (kind === 'DaemonSet') return k8sClient.apps.patchNamespacedDaemonSet(options);
  if (kind === 'CronJob') return k8sClient.batch.patchNamespacedCronJob(options);
  if (kind === 'Service') return k8sClient.core.patchNamespacedService(options);
  return k8sClient.networking.patchNamespacedIngress(options);
}

/** Build a minimal non-sensitive structured patch receipt. */
function buildReceipt(request: PatchResourceRequest, resource: any, operationId: string, compiled: Omit<CompiledPatch, 'body'>): WriteReceipt {
  const affectsFutureJobs = request.kind === 'CronJob' && compiled.changes.some((change) =>
    change.type === 'set_image' || ('scope' in change && change.scope === 'pod_template'));
  const warnings = [
    ...(compiled.serviceRoutingChanged ? ['Service selector changes can immediately redirect traffic.'] : []),
    ...(affectsFutureJobs ? ['CronJob template changes affect future Jobs only.'] : []),
  ];
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
      rolloutTriggered: compiled.rolloutTriggered,
      serviceRoutingChanged: compiled.serviceRoutingChanged,
      fields: compiled.changes.map((change) => ({ type: change.type, location: patchChangeLocation(change) })),
    },
    observed: {
      resourceVersion: String(resource.metadata?.resourceVersion || ''),
      ...(resource.metadata?.generation === undefined ? {} : { generation: resource.metadata.generation }),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Apply a semantic resource patch through dry-run, atomic preconditions, and idempotent receipts. */
export async function patchResourceHandler(request: PatchResourceRequest, context?: ToolExecutionContext): Promise<WriteReceipt> {
  checkWriteEnabled();
  checkNamespaceAllowed(request.namespace);
  if (!config.ACORNOPS_AGENT_PATCH_KINDS.includes(request.kind)) {
    throw new ToolExecutionError('PRECONDITION_FAILED', `${request.kind} is not enabled by local patch policy`);
  }
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const normalized = { ...request, changes: canonicalChanges(request.changes) };
  const operationHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const current = await readResource(request.kind, request.name, request.namespace);
  checkOperationNotAborted(context, operationId);
  if (current.metadata?.uid !== request.expected_uid) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource UID does not match the expected target');
  }

  const existingOperationId = current.metadata?.annotations?.['acornops.dev/operation-id'];
  if (existingOperationId === operationId) {
    if (!current.metadata?.resourceVersion ||
        !operationAnnotationsMatch(current.metadata?.annotations, operationId, operationHash, 'patch') ||
        !desiredStateMatches(current, request) || !patchedInvariantsMatch(current, request)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different patch arguments or state');
    }
    const { rolloutTriggered, serviceRoutingChanged } = patchEffects(request.kind, normalized.changes);
    return buildReceipt(request, current, operationId, {
      changes: normalized.changes,
      rolloutTriggered,
      serviceRoutingChanged,
    });
  }

  const compiled = compilePatch(current, request, operationId, operationHash);
  const dryRunResult = await applyPatch(request.kind, request.name, request.namespace, compiled.body, 'All');
  checkOperationNotAborted(context, operationId);
  if (dryRunResult.metadata?.uid !== request.expected_uid || !desiredStateMatches(dryRunResult, request) ||
      !operationAnnotationsMatch(dryRunResult.metadata?.annotations, operationId, operationHash, 'patch') ||
      !patchedInvariantsMatch(dryRunResult, request)) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Kubernetes dry-run returned an inconsistent patched resource');
  }
  const updated = await applyPatch(request.kind, request.name, request.namespace, compiled.body);
  if (updated.metadata?.uid !== request.expected_uid || !updated.metadata?.resourceVersion ||
      updated.metadata.resourceVersion === current.metadata.resourceVersion || !desiredStateMatches(updated, request) ||
      !operationAnnotationsMatch(updated.metadata?.annotations, operationId, operationHash, 'patch') ||
      !patchedInvariantsMatch(updated, request)) {
    throw new ToolExecutionError(
      'KUBERNETES_ERROR',
      'Kubernetes accepted the patch but returned an inconsistent resource',
      { outcome: 'unknown', operationId, reason: 'PostWriteVerificationFailed', phase: 'verification' }
    );
  }
  return buildReceipt(request, updated, operationId, compiled);
}

export const patchResourceTool: ToolDefinition = {
  name: 'patch_resource',
  description: 'Patch the exact remediationTarget after get_resource. Use its UID as expected_uid and current values as preconditions. Image example: changes=[{"type":"set_image","container_type":"container","container":"nginx","expected_image":"nginx:old","image":"nginx:new"}]. expected_image is the current image; image is the desired image. Never patch a generated Pod or guessed controller name.',
  capability: 'write',
  timeoutMs: 20000,
  version: 'v1',
  outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA,
  artifactPolicy: 'never',
  schema: patchResourceSchema,
  scopeResolver: (params) => ({ type: 'namespaced', namespace: params.namespace }),
  handler: patchResourceHandler,
  projectForModel: (result) => writeProjection('patch_resource', result),
};
