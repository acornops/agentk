import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, SUPPORTED_WORKLOAD_PATCH_KINDS, SupportedWorkloadPatchKind } from '../../config.js';
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

const workloadKinds = new Set<SupportedWorkloadPatchKind>(SUPPORTED_WORKLOAD_PATCH_KINDS);
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

const envNameSchema = z.string().min(1).max(253).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a valid environment variable name');
const envValueSchema = z.string().max(4096)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Must not contain control or format characters');
const configMapKeySchema = z.string().min(1).max(253)
  .regex(/^[-._a-zA-Z0-9]+$/, 'Must be a valid ConfigMap key');

const setEnvSchema = z.object({
  type: z.literal('set_env'),
  container_type: z.enum(['container', 'init_container']),
  container: containerNameSchema,
  name: envNameSchema,
  expected_source: z.enum(['absent', 'literal', 'config_map']),
  value: envValueSchema,
}).strict();

const setEnvFromConfigMapSchema = z.object({
  type: z.literal('set_env_from_configmap'),
  container_type: z.enum(['container', 'init_container']),
  container: containerNameSchema,
  name: envNameSchema,
  expected_source: z.enum(['absent', 'literal', 'config_map']),
  config_map: kubernetesNameSchema,
  key: configMapKeySchema,
  optional: z.boolean().optional().default(false),
}).strict();

const removeEnvSchema = z.object({
  type: z.literal('remove_env'),
  container_type: z.enum(['container', 'init_container']),
  container: containerNameSchema,
  name: envNameSchema,
  expected_source: z.enum(['literal', 'config_map']),
}).strict();

export const patchChangeSchema = z.discriminatedUnion('type', [
  setImageSchema,
  setLabelSchema,
  removeLabelSchema,
  setAnnotationSchema,
  removeAnnotationSchema,
  setEnvSchema,
  setEnvFromConfigMapSchema,
  removeEnvSchema,
]);

const patchKindSchema = z.enum(SUPPORTED_WORKLOAD_PATCH_KINDS);

/** Return a stable semantic location for duplicate detection, hashing, and receipts. */
export function patchChangeLocation(change: PatchChange): string {
  if (change.type === 'set_image') return `pod_template:${change.container_type}:${change.container}:image`;
  if (change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') {
    return `pod_template:${change.container_type}:${change.container}:env:${change.name}`;
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
function supportsPodTemplate(kind: SupportedWorkloadPatchKind): boolean {
  return workloadKinds.has(kind);
}

/** Validate one semantic operation against its target resource kind. */
function validateKindAndChange(kind: SupportedWorkloadPatchKind, change: PatchChange): string | undefined {
  if ('scope' in change && change.scope === 'pod_template' && !supportsPodTemplate(kind)) {
    return `pod_template metadata is unavailable for ${kind}`;
  }
  return undefined;
}

export const patchWorkloadSchema = z.object({
  kind: patchKindSchema,
  namespace: namespaceSchema,
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  expected_resource_version: z.string().min(1).max(128),
  reason: reasonSchema,
  confirm_non_secret_data: z.boolean().optional().default(false),
  changes: z.array(patchChangeSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  if (!config.ACORNOPS_AGENT_WORKLOAD_PATCH_KINDS.includes(value.kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: `${value.kind} is not enabled by local patch policy` });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Semantic patch exceeds the 32 KiB limit' });
  }
  const locations = new Set<string>();
  const hasEnvChange = value.changes.some((change) =>
    change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env');
  const hasLiteralEnvChange = value.changes.some((change) => change.type === 'set_env');
  if (hasEnvChange && !config.ACORNOPS_AGENT_ALLOW_ENV_PATCH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes'], message: 'Environment changes are not enabled by local patch policy' });
  }
  if (hasLiteralEnvChange && !value.confirm_non_secret_data) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirm_non_secret_data'],
      message: 'Literal environment changes require explicit non-secret data confirmation',
    });
  }
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
    if ((change.type === 'set_label' || change.type === 'set_annotation') &&
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
    if ((change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') &&
        isSensitiveEnvName(change.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'name'], message: 'Secret-bearing environment names are not supported' });
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
});

export type PatchWorkloadRequest = z.infer<typeof patchWorkloadSchema>;
export type PatchChange = z.infer<typeof patchChangeSchema>;

interface CompiledPatch {
  body: Array<Record<string, unknown>>;
  changes: PatchChange[];
  rolloutTriggered: boolean;
}

/** Return the JSON pointer for a supported workload Pod template. */
function templatePath(kind: SupportedWorkloadPatchKind): string {
  return kind === 'CronJob' ? '/spec/jobTemplate/spec/template' : '/spec/template';
}

/** Return a supported workload Pod template from a Kubernetes resource. */
function templateFor(resource: any, kind: SupportedWorkloadPatchKind): any {
  return kind === 'CronJob' ? resource.spec?.jobTemplate?.spec?.template : resource.spec?.template;
}

/** Return a metadata map at resource or Pod-template scope. */
function mapValue(resource: any, kind: SupportedWorkloadPatchKind, scope: 'resource' | 'pod_template', field: 'labels' | 'annotations') {
  const metadata = scope === 'resource' ? resource.metadata : templateFor(resource, kind)?.metadata;
  return metadata?.[field] || {};
}

/** Return the expected scalar value from a non-image semantic operation. */
function expectedValue(change: PatchChange): string | null | undefined {
  return 'expected_value' in change ? change.expected_value : undefined;
}

/** Return whether an environment variable name suggests secret-bearing content. */
function isSensitiveEnvName(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['secret', 'token', 'password', 'passwd', 'credential', 'authorization', 'apikey', 'privatekey']
    .some((fragment) => normalized.includes(fragment));
}

/** Return one supported environment source without exposing its value. */
function envSource(value: any): 'absent' | 'literal' | 'config_map' | 'unsupported' {
  if (!value) return 'absent';
  if (typeof value.value === 'string') return 'literal';
  if (value.valueFrom?.configMapKeyRef) return 'config_map';
  return 'unsupported';
}

/** Return the named container from a workload Pod template. */
function findContainer(resource: any, kind: SupportedWorkloadPatchKind, containerType: 'container' | 'init_container', name: string): any {
  const field = containerType === 'container' ? 'containers' : 'initContainers';
  return templateFor(resource, kind)?.spec?.[field]?.find((container: any) => container?.name === name);
}

/** Return every environment entry with the requested name. */
function matchingEnvEntries(resource: any, kind: SupportedWorkloadPatchKind, change: Extract<PatchChange, { name: string }>): any[] {
  const container = findContainer(resource, kind, change.container_type, change.container);
  return Array.isArray(container?.env)
    ? container.env.filter((item: any) => item?.name === change.name)
    : [];
}

/** Return one named environment entry from a workload container. */
function findEnv(resource: any, kind: SupportedWorkloadPatchKind, change: Extract<PatchChange, { name: string }>): any {
  const matches = matchingEnvEntries(resource, kind, change);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read the current scalar value addressed by a semantic operation. */
function currentChangeValue(resource: any, kind: SupportedWorkloadPatchKind, change: PatchChange): string | undefined {
  if (change.type === 'set_image') {
    const field = change.container_type === 'container' ? 'containers' : 'initContainers';
    return templateFor(resource, kind)?.spec?.[field]?.find((container: any) => container?.name === change.container)?.image;
  }
  if (change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') {
    return envSource(findEnv(resource, kind, change));
  }
  const field = change.type.endsWith('label') ? 'labels' : 'annotations';
  return mapValue(resource, kind, change.scope, field)[change.key];
}

/** Reject a patch whose expected field values are no longer current. */
function assertExpectedState(resource: any, request: PatchWorkloadRequest): void {
  for (const change of request.changes) {
    if ((change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') &&
        matchingEnvEntries(resource, request.kind, change).length > 1) {
      throw new ToolExecutionError(
        'PRECONDITION_FAILED',
        `Environment variable is duplicated at ${patchChangeLocation(change)}`,
      );
    }
    const actual = currentChangeValue(resource, request.kind, change);
    const expected = change.type === 'set_image'
      ? change.expected_image
      : change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env'
        ? change.expected_source
        : expectedValue(change);
    if (expected === null ? actual !== undefined : actual !== expected) {
      throw new ToolExecutionError('PRECONDITION_FAILED', `Current value changed at ${patchChangeLocation(change)}`);
    }
  }
}

/** Return whether every requested semantic operation is reflected in a resource. */
function desiredStateMatches(resource: any, request: PatchWorkloadRequest): boolean {
  return request.changes.every((change) => {
    if ((change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') &&
        matchingEnvEntries(resource, request.kind, change).length > 1) {
      return false;
    }
    const actual = currentChangeValue(resource, request.kind, change);
    if (change.type === 'set_image') return actual === change.image;
    if (change.type === 'set_env') {
      const env = findEnv(resource, request.kind, change);
      return envSource(env) === 'literal' && env.value === change.value && env.valueFrom === undefined;
    }
    if (change.type === 'set_env_from_configmap') {
      const ref = findEnv(resource, request.kind, change)?.valueFrom?.configMapKeyRef;
      return ref?.name === change.config_map && ref?.key === change.key && Boolean(ref?.optional) === change.optional;
    }
    if (change.type === 'remove_env') return actual === 'absent';
    if (change.type === 'set_label' || change.type === 'set_annotation') {
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
    if (expression.operator === 'NotIn' && value !== undefined && values.includes(value)) return false;
    if (expression.operator === 'Exists' && value === undefined) return false;
    if (expression.operator === 'DoesNotExist' && value !== undefined) return false;
    if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(expression.operator)) return false;
  }
  return true;
}

/** Return whether safety invariants still hold after admission processing. */
function patchedInvariantsMatch(resource: any, request: PatchWorkloadRequest): boolean {
  if (request.kind !== 'CronJob') {
    const labels = templateFor(resource, request.kind)?.metadata?.labels || {};
    if (!selectorMatchesLabels(resource.spec?.selector, labels)) return false;
  }
  return true;
}

/** Sort semantic changes deterministically without mutating caller input. */
function canonicalChanges(changes: PatchChange[]): PatchChange[] {
  return [...changes].sort((left, right) => patchChangeLocation(left).localeCompare(patchChangeLocation(right)));
}

/** Derive user-visible effects directly from semantic operations. */
function patchEffects(kind: SupportedWorkloadPatchKind, changes: PatchChange[]) {
  return {
    rolloutTriggered: kind !== 'CronJob' && changes.some((change) =>
      change.type === 'set_image' ||
      change.type === 'set_env' ||
      change.type === 'set_env_from_configmap' ||
      change.type === 'remove_env' ||
      ('scope' in change && change.scope === 'pod_template')),
  };
}

/** Compile validated semantic operations into one guarded Kubernetes JSON Patch. */
function compilePatch(current: any, request: PatchWorkloadRequest, operationId: string, operationHash: string): CompiledPatch {
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
  const touchedEnvContainers = new Set<string>();
  const { rolloutTriggered } = patchEffects(request.kind, changes);

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

    if (change.type === 'set_env' || change.type === 'set_env_from_configmap' || change.type === 'remove_env') {
      const container = findContainer(proposed, request.kind, change.container_type, change.container);
      if (!container) throw new ToolExecutionError('PRECONDITION_FAILED', `Container not found: ${change.container}`);
      const env = Array.isArray(container.env) ? [...container.env] : [];
      const index = env.findIndex((item: any) => item?.name === change.name);
      if (change.type === 'remove_env') env.splice(index, 1);
      else {
        const desired = change.type === 'set_env'
          ? { name: change.name, value: change.value }
          : {
              name: change.name,
              valueFrom: {
                configMapKeyRef: {
                  name: change.config_map,
                  key: change.key,
                  optional: change.optional,
                },
              },
            };
        if (index < 0) env.push(desired);
        else env[index] = desired;
      }
      container.env = env;
      touchedEnvContainers.add(`${change.container_type}:${change.container}`);
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

  const labels = templateFor(proposed, request.kind)?.metadata?.labels || {};
  if (request.kind !== 'CronJob' && !selectorMatchesLabels(proposed.spec?.selector, labels)) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Patched pod-template labels would no longer match the workload selector');
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
  for (const entry of [...touchedEnvContainers].sort()) {
    const [containerType, containerName] = entry.split(':') as ['container' | 'init_container', string];
    const arrayField = containerType === 'container' ? 'containers' : 'initContainers';
    const containers = templateFor(proposed, request.kind)?.spec?.[arrayField];
    const index = Array.isArray(containers) ? containers.findIndex((container: any) => container?.name === containerName) : -1;
    if (index < 0) throw new ToolExecutionError('PRECONDITION_FAILED', `Container not found: ${containerName}`);
    body.push({ op: 'test', path: `${templatePath(request.kind)}/spec/${arrayField}/${index}/name`, value: containerName });
    body.push({ op: 'add', path: `${templatePath(request.kind)}/spec/${arrayField}/${index}/env`, value: containers[index].env });
  }
  for (const entry of [...touchedMaps].sort()) {
    const [scope, field] = entry.split(':') as ['resource' | 'pod_template', 'labels' | 'annotations'];
    const path = scope === 'resource' ? `/metadata/${field}` : `${templatePath(request.kind)}/metadata/${field}`;
    body.push({ op: 'add', path, value: mapValue(proposed, request.kind, scope, field) });
  }

  return { body, changes, rolloutTriggered };
}

/** Read one supported resource through its typed Kubernetes API. */
async function readResource(kind: SupportedWorkloadPatchKind, name: string, namespace: string): Promise<any> {
  if (kind === 'Deployment') return k8sClient.apps.readNamespacedDeployment({ name, namespace });
  if (kind === 'StatefulSet') return k8sClient.apps.readNamespacedStatefulSet({ name, namespace });
  if (kind === 'DaemonSet') return k8sClient.apps.readNamespacedDaemonSet({ name, namespace });
  return k8sClient.batch.readNamespacedCronJob({ name, namespace });
}

/** Submit a JSON Patch to the correct typed Kubernetes API. */
async function applyPatch(kind: SupportedWorkloadPatchKind, name: string, namespace: string, body: any[], dryRun?: 'All'): Promise<any> {
  const options = { name, namespace, body, dryRun, fieldManager: 'acornops-agentk', fieldValidation: 'Strict' };
  if (kind === 'Deployment') return k8sClient.apps.patchNamespacedDeployment(options);
  if (kind === 'StatefulSet') return k8sClient.apps.patchNamespacedStatefulSet(options);
  if (kind === 'DaemonSet') return k8sClient.apps.patchNamespacedDaemonSet(options);
  return k8sClient.batch.patchNamespacedCronJob(options);
}

/** Build a minimal non-sensitive structured patch receipt. */
function buildReceipt(request: PatchWorkloadRequest, resource: any, operationId: string, compiled: Omit<CompiledPatch, 'body'>): WriteReceipt {
  const affectsFutureJobs = request.kind === 'CronJob' && compiled.changes.some((change) =>
    change.type === 'set_image' ||
    change.type === 'set_env' ||
    change.type === 'set_env_from_configmap' ||
    change.type === 'remove_env' ||
    ('scope' in change && change.scope === 'pod_template'));
  const warnings = [
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
      serviceRoutingChanged: false,
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
export async function patchWorkloadHandler(request: PatchWorkloadRequest, context?: ToolExecutionContext): Promise<WriteReceipt> {
  checkWriteEnabled();
  checkNamespaceAllowed(request.namespace);
  if (!config.ACORNOPS_AGENT_WORKLOAD_PATCH_KINDS.includes(request.kind)) {
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
    const { rolloutTriggered } = patchEffects(request.kind, normalized.changes);
    return buildReceipt(request, current, operationId, {
      changes: normalized.changes,
      rolloutTriggered,
    });
  }
  if (current.metadata?.resourceVersion !== request.expected_resource_version) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource version does not match the inspected workload');
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

export const patchWorkloadTool: ToolDefinition = {
  name: 'patch_workload',
  description: 'Update a workload image, environment, labels, or annotations after get_resource.',
  capability: 'write',
  timeoutMs: 20000,
  version: 'v2',
  outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA,
  artifactPolicy: 'never',
  schema: patchWorkloadSchema,
  scopeResolver: (params) => ({ type: 'namespaced', namespace: params.namespace }),
  handler: patchWorkloadHandler,
  projectForModel: (result) => writeProjection('patch_workload', result),
};
