import { z } from 'zod';
import { createHash } from 'node:crypto';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import { kubernetesNameSchema, namespaceSchema, reasonSchema } from '../schemas.js';
import {
  checkNamespaceAllowed,
  checkOperationNotAborted,
  checkWriteEnabled,
  getAnnotations,
  operationAnnotationsMatch,
} from '../utils.js';
import { WriteReceipt } from '../write-receipt.js';

const schema = z.object({
  kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet']),
  name: kubernetesNameSchema,
  namespace: namespaceSchema,
  reason: reasonSchema
}).strict();

/** Build a minimal restart receipt without returning the workload specification. */
function receipt(params: z.infer<typeof schema>, current: any, operationId: string, restartedAt: string): WriteReceipt {
  return {
    success: true,
    operationId,
    target: {
      kind: params.kind,
      namespace: params.namespace,
      name: params.name,
      uid: String(current.metadata?.uid || ''),
    },
    change: { type: 'restart', restartedAt },
    observed: {
      resourceVersion: String(current.metadata?.resourceVersion || ''),
      ...(current.metadata?.generation === undefined ? {} : { generation: current.metadata.generation }),
    },
  };
}

/** Read the current workload before applying a guarded restart. */
async function readWorkload(kind: z.infer<typeof schema>['kind'], name: string, namespace: string): Promise<any> {
  if (kind === 'Deployment') return k8sClient.apps.readNamespacedDeployment({ name, namespace });
  if (kind === 'StatefulSet') return k8sClient.apps.readNamespacedStatefulSet({ name, namespace });
  return k8sClient.apps.readNamespacedDaemonSet({ name, namespace });
}

/** Apply one JSON Patch to the selected workload kind. */
async function patchWorkload(kind: z.infer<typeof schema>['kind'], name: string, namespace: string, body: any[]): Promise<any> {
  if (kind === 'Deployment') return k8sClient.apps.patchNamespacedDeployment({ name, namespace, body });
  if (kind === 'StatefulSet') return k8sClient.apps.patchNamespacedStatefulSet({ name, namespace, body });
  return k8sClient.apps.patchNamespacedDaemonSet({ name, namespace, body });
}

/** Handle a request to restart a scalable workload atomically. */
async function handler(params: z.infer<typeof schema>, context?: ToolExecutionContext): Promise<WriteReceipt> {
  checkWriteEnabled();
  checkNamespaceAllowed(params.namespace);
  const operationId = context?.operationId || `direct-${Date.now()}`;
  const current = await readWorkload(params.kind, params.name, params.namespace);
  checkOperationNotAborted(context, operationId);
  if (!current.metadata?.uid || !current.metadata?.resourceVersion) {
    throw new ToolExecutionError('PRECONDITION_FAILED', 'Workload identity is incomplete');
  }
  const operationHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
  const existingAnnotations = current.spec?.template?.metadata?.annotations || {};
  const existingOperationId = existingAnnotations['acornops.dev/operation-id'];
  const existingRestartedAt = existingAnnotations['kubectl.kubernetes.io/restartedAt'];
  if (existingOperationId === operationId) {
    if (!operationAnnotationsMatch(existingAnnotations, operationId, operationHash, 'restart') || !existingRestartedAt) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different restart arguments or state');
    }
    return receipt(params, current, operationId, existingRestartedAt);
  }
  const restartedAt = new Date().toISOString();
  const templateMetadata = current.spec?.template?.metadata;
  const annotations = {
    ...(templateMetadata?.annotations ?? {}),
    ...getAnnotations(params.reason, operationId),
    'acornops.dev/operation-hash': operationHash,
    'acornops.dev/operation-kind': 'restart',
    'kubectl.kubernetes.io/restartedAt': restartedAt,
  };
  const path = templateMetadata ? '/spec/template/metadata/annotations' : '/spec/template/metadata';
  const value = templateMetadata ? annotations : { annotations };
  const updated = await patchWorkload(params.kind, params.name, params.namespace, [
    { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'add', path, value },
  ]);
  const updatedAnnotations = updated.spec?.template?.metadata?.annotations;
  if (updated.metadata?.uid !== current.metadata.uid || !updated.metadata?.resourceVersion ||
      updated.metadata.resourceVersion === current.metadata.resourceVersion ||
      !operationAnnotationsMatch(updatedAnnotations, operationId, operationHash, 'restart') ||
      updatedAnnotations?.['kubectl.kubernetes.io/restartedAt'] !== restartedAt) {
    throw new ToolExecutionError('KUBERNETES_ERROR', 'Kubernetes accepted the restart but returned an inconsistent workload', {
      outcome: 'unknown', operationId,
    });
  }
  return receipt(params, updated, operationId, restartedAt);
}

export const restartWorkloadTool: ToolDefinition = {
  name: 'restart_workload',
  description: 'Trigger a rolling restart for a Deployment, StatefulSet, or DaemonSet.',
  capability: 'write',
  timeoutMs: 15000,
  version: 'v1',
  schema,
  scopeResolver: (params) => ({ type: 'namespaced', namespace: params.namespace }),
  handler
};
