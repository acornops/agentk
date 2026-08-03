import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { WRITE_TOOL_RESULT_OUTPUT_SCHEMA, writeProjection } from '../model-context.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import {
  kubernetesNameSchema,
  kubernetesUidSchema,
  namespaceSchema,
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

const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const configMapKeySchema = z.string().min(1).max(253)
  .regex(/^[-._a-zA-Z0-9]+$/, 'Must be a valid ConfigMap key');
const configMapValueSchema = z.string().max(4096)
  .refine((value) => !CONTROL_OR_FORMAT_CHARACTER.test(value), 'Must not contain control or format characters');

const setKeySchema = z.object({
  type: z.literal('set_key'),
  key: configMapKeySchema,
  expected_present: z.boolean(),
  value: configMapValueSchema,
}).strict();
const removeKeySchema = z.object({
  type: z.literal('remove_key'),
  key: configMapKeySchema,
}).strict();
export const configMapChangeSchema = z.discriminatedUnion('type', [setKeySchema, removeKeySchema]);
export type ConfigMapChange = z.infer<typeof configMapChangeSchema>;

/** Return whether a ConfigMap key suggests secret-bearing content. */
function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['secret', 'token', 'password', 'passwd', 'credential', 'authorization', 'apikey', 'privatekey']
    .some((fragment) => normalized.includes(fragment));
}

export const patchConfigMapSchema = z.object({
  namespace: namespaceSchema,
  name: kubernetesNameSchema,
  expected_uid: kubernetesUidSchema,
  expected_resource_version: z.string().min(1).max(128),
  reason: reasonSchema,
  confirm_non_secret_data: z.literal(true),
  changes: z.array(configMapChangeSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  if (!config.ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ConfigMap changes are not enabled by local patch policy' });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ConfigMap patch exceeds the 32 KiB limit' });
  }
  const keys = new Set<string>();
  for (const [index, change] of value.changes.entries()) {
    if (keys.has(change.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: `Duplicate ConfigMap key: ${change.key}` });
    }
    keys.add(change.key);
    if (isSensitiveKey(change.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'key'], message: 'Secret-bearing ConfigMap keys are not supported' });
    }
  }
});
export type PatchConfigMapRequest = z.infer<typeof patchConfigMapSchema>;

/** Sort ConfigMap changes deterministically for hashing and receipts. */
function canonicalChanges(changes: ConfigMapChange[]): ConfigMapChange[] {
  return [...changes].sort((left, right) => left.key.localeCompare(right.key));
}

/** Return whether all requested ConfigMap key changes are visible. */
function desiredStateMatches(resource: any, request: PatchConfigMapRequest): boolean {
  const data = resource?.data || {};
  return request.changes.every((change) =>
    change.type === 'set_key' ? data[change.key] === change.value : data[change.key] === undefined);
}

/** Compile semantic ConfigMap key changes into one guarded JSON Patch. */
function compilePatch(current: any, request: PatchConfigMapRequest, operationId: string, operationHash: string) {
  if (!current.metadata?.uid || !current.metadata?.resourceVersion) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'ConfigMap identity is incomplete');
  }
  if (current.immutable === true) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Immutable ConfigMaps cannot be patched');
  }
  const proposedData = { ...(current.data || {}) };
  const changes = canonicalChanges(request.changes);
  for (const change of changes) {
    const present = Object.hasOwn(proposedData, change.key);
    if (change.type === 'set_key') {
      if (present !== change.expected_present) {
        throw new ToolExecutionError('PRECONDITION_FAILED', `ConfigMap key presence changed: ${change.key}`);
      }
      proposedData[change.key] = change.value;
    } else {
      if (!present) throw new ToolExecutionError('PRECONDITION_FAILED', `ConfigMap key is absent: ${change.key}`);
      delete proposedData[change.key];
    }
  }
  const annotations = {
    ...(current.metadata?.annotations || {}),
    ...getAnnotations(request.reason, operationId),
    'acornops.dev/operation-hash': operationHash,
    'acornops.dev/operation-kind': 'patch',
  };
  return {
    body: [
      { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
      { op: 'add', path: '/metadata/annotations', value: annotations },
      { op: 'add', path: '/data', value: proposedData },
    ],
    changes,
  };
}

/** Build a value-free ConfigMap mutation receipt. */
function buildReceipt(request: PatchConfigMapRequest, resource: any, operationId: string, changes: ConfigMapChange[]): WriteReceipt {
  return {
    success: true,
    operationId,
    target: {
      kind: 'ConfigMap',
      namespace: request.namespace,
      name: request.name,
      uid: String(resource.metadata?.uid || ''),
    },
    change: {
      type: 'patch',
      changeCount: changes.length,
      rolloutTriggered: false,
      serviceRoutingChanged: false,
      fields: changes.map((change) => ({ type: change.type, location: `data:${change.key}` })),
    },
    observed: { resourceVersion: String(resource.metadata?.resourceVersion || '') },
    warnings: [
      'ConfigMap changes do not restart workloads. Environment consumers require Pod recreation; mounted-file consumers depend on application reload behavior.',
    ],
  };
}

/** Apply a guarded non-secret ConfigMap data-key patch. */
export async function patchConfigMapHandler(request: PatchConfigMapRequest, context?: ToolExecutionContext): Promise<WriteReceipt> {
  checkWriteEnabled();
  checkNamespaceAllowed(request.namespace);
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const normalized = { ...request, changes: canonicalChanges(request.changes) };
  const operationHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const current = await k8sClient.core.readNamespacedConfigMap({ name: request.name, namespace: request.namespace });
  checkOperationNotAborted(context, operationId);
  if (current.metadata?.uid !== request.expected_uid) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'ConfigMap UID does not match the expected target');
  }
  if (current.metadata?.annotations?.['acornops.dev/operation-id'] === operationId) {
    if (!operationAnnotationsMatch(current.metadata?.annotations, operationId, operationHash, 'patch') ||
        !desiredStateMatches(current, request)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different ConfigMap arguments or state');
    }
    return buildReceipt(request, current, operationId, normalized.changes);
  }
  if (current.metadata?.resourceVersion !== request.expected_resource_version) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Resource version does not match the inspected ConfigMap');
  }
  const compiled = compilePatch(current, normalized, operationId, operationHash);
  const options = {
    name: request.name,
    namespace: request.namespace,
    body: compiled.body,
    fieldManager: 'acornops-agentk',
    fieldValidation: 'Strict',
  };
  const dryRunResult = await k8sClient.core.patchNamespacedConfigMap({ ...options, dryRun: 'All' });
  checkOperationNotAborted(context, operationId);
  if (dryRunResult.metadata?.uid !== request.expected_uid || !desiredStateMatches(dryRunResult, request) ||
      !operationAnnotationsMatch(dryRunResult.metadata?.annotations, operationId, operationHash, 'patch')) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Kubernetes dry-run returned an inconsistent ConfigMap');
  }
  const updated = await k8sClient.core.patchNamespacedConfigMap(options);
  if (updated.metadata?.uid !== request.expected_uid || !updated.metadata?.resourceVersion ||
      updated.metadata.resourceVersion === current.metadata.resourceVersion || !desiredStateMatches(updated, request) ||
      !operationAnnotationsMatch(updated.metadata?.annotations, operationId, operationHash, 'patch')) {
    throw new ToolExecutionError(
      'KUBERNETES_ERROR',
      'Kubernetes accepted the ConfigMap patch but returned an inconsistent resource',
      { outcome: 'unknown', operationId, reason: 'PostWriteVerificationFailed', phase: 'verification' },
    );
  }
  return buildReceipt(request, updated, operationId, compiled.changes);
}

export const patchConfigMapTool: ToolDefinition = {
  name: 'patch_configmap',
  description: 'Set or remove non-secret ConfigMap data after get_resource. Does not restart consumers.',
  capability: 'write',
  timeoutMs: 20000,
  version: 'v1',
  outputSchema: WRITE_TOOL_RESULT_OUTPUT_SCHEMA,
  artifactPolicy: 'never',
  schema: patchConfigMapSchema,
  scopeResolver: (params) => ({ type: 'namespaced', namespace: params.namespace }),
  handler: patchConfigMapHandler,
  projectForModel: (result) => writeProjection('patch_configmap', result),
};
