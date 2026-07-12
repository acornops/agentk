import { z } from 'zod';
import { k8sClient } from '../../k8s/client.js';
import { redactKubernetesResource } from '../resource-redaction.js';
import { ToolDefinition } from '../registry.js';
import { checkNamespaceAllowed } from '../utils.js';
import { kubernetesNameSchema, namespaceSchema } from '../schemas.js';

const schema = z.object({
  kind: z.enum(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Service', 'Ingress', 'PVC', 'Node', 'HPA', 'Event', 'Namespace']),
  name: kubernetesNameSchema,
  namespace: namespaceSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (!['Node', 'Namespace'].includes(value.kind) && !value.namespace) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['namespace'], message: 'namespace is required for namespaced kinds' });
  }
});

/** Handle a request to fetch one named Kubernetes resource. */
async function handler(params: z.infer<typeof schema>) {
  const { kind, name, namespace } = params;
  checkNamespaceAllowed(namespace);

  let resource: unknown;
  switch (kind) {
    case 'Pod':
      resource = await k8sClient.core.readNamespacedPod({ name, namespace: namespace! });
      break;
    case 'Deployment':
      resource = await k8sClient.apps.readNamespacedDeployment({ name, namespace: namespace! });
      break;
    case 'StatefulSet':
      resource = await k8sClient.apps.readNamespacedStatefulSet({ name, namespace: namespace! });
      break;
    case 'DaemonSet':
      resource = await k8sClient.apps.readNamespacedDaemonSet({ name, namespace: namespace! });
      break;
    case 'CronJob':
      resource = await k8sClient.batch.readNamespacedCronJob({ name, namespace: namespace! });
      break;
    case 'Job':
      resource = await k8sClient.batch.readNamespacedJob({ name, namespace: namespace! });
      break;
    case 'Service':
      resource = await k8sClient.core.readNamespacedService({ name, namespace: namespace! });
      break;
    case 'Ingress':
      resource = await k8sClient.networking.readNamespacedIngress({ name, namespace: namespace! });
      break;
    case 'PVC':
      resource = await k8sClient.core.readNamespacedPersistentVolumeClaim({ name, namespace: namespace! });
      break;
    case 'Node':
      resource = await k8sClient.core.readNode({ name });
      break;
    case 'HPA':
      resource = await k8sClient.autoscaling.readNamespacedHorizontalPodAutoscaler({ name, namespace: namespace! });
      break;
    case 'Event':
      resource = await k8sClient.core.readNamespacedEvent({ name, namespace: namespace! });
      break;
    case 'Namespace':
      resource = await k8sClient.core.readNamespace({ name });
      break;
    default:
      throw new Error(`Unsupported kind: ${kind}`);
  }

  return redactKubernetesResource(resource);
}

export const getResourceTool: ToolDefinition = {
  name: 'get_resource',
  description: 'Fetch a redacted Kubernetes API object for a specific named resource.',
  capability: 'read',
  timeoutMs: 12000,
  version: 'v1',
  schema,
  scopeResolver: (params) => params.kind === 'Node'
    ? ({ type: 'cluster', kind: params.kind })
    : params.kind === 'Namespace'
      ? ({ type: 'cluster', kind: params.kind, namespace: params.name })
      : ({ type: 'namespaced', namespace: params.namespace }),
  handler
};
