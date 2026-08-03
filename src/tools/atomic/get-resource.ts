import { z } from 'zod';
import { createHash } from 'node:crypto';
import { k8sClient } from '../../k8s/client.js';
import { REDACTED, redactKubernetesResource } from '../resource-redaction.js';
import { ToolDefinition } from '../registry.js';
import { checkNamespaceAllowed } from '../utils.js';
import { kubernetesNameSchema, namespaceSchema } from '../schemas.js';
import { boundedText, fullToolResultOutputSchema, identity } from '../model-context.js';
import { requireCustomResourceAddition } from '../custom-resource-additions.js';
import { ToolExecutionError } from '../errors.js';

const OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object', required: ['resource'],
  properties: {
    resource: { type: 'object' },
    ownership: { type: 'object' },
    safeConfiguration: { type: 'object' },
  },
  additionalProperties: false,
});

const builtInSchema = z.object({
  kind: z.enum(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Service', 'Ingress', 'ConfigMap', 'PVC', 'Node', 'HPA', 'Event', 'Namespace']),
  name: kubernetesNameSchema,
  namespace: namespaceSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (!['Node', 'Namespace'].includes(value.kind) && !value.namespace) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['namespace'], message: 'namespace is required for namespaced kinds' });
  }
});

const customResourceSchema = z.object({
  addition_key: z.string().min(1).max(64),
  resource: z.string().min(1).max(253),
  name: kubernetesNameSchema,
  namespace: namespaceSchema.optional()
}).strict();

const schema = z.union([builtInSchema, customResourceSchema]);
type BuiltInKind = z.infer<typeof builtInSchema>['kind'];

const API_VERSION_BY_KIND: Record<BuiltInKind, string> = {
  Pod: 'v1', Service: 'v1', ConfigMap: 'v1', PVC: 'v1', Node: 'v1', Event: 'v1', Namespace: 'v1',
  Deployment: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1',
  CronJob: 'batch/v1', Job: 'batch/v1', Ingress: 'networking.k8s.io/v1', HPA: 'autoscaling/v2',
};

interface OwnerRef { kind: string; name: string; uid?: string; controller: boolean }
type OwnershipNode = OwnerRef;

/** Return only the Kubernetes-designated controlling owner reference. */
function controllerOwner(resource: any): OwnerRef | undefined {
  const owners = Array.isArray(resource?.metadata?.ownerReferences) ? resource.metadata.ownerReferences : [];
  const owner = owners.find((item: any) => item?.controller === true);
  if (typeof owner?.kind !== 'string' || typeof owner?.name !== 'string') return undefined;
  return {
    kind: owner.kind,
    name: owner.name,
    uid: typeof owner.uid === 'string' ? owner.uid : undefined,
    controller: true,
  };
}

/** Convert a fetched controller into a compact ownership-path node. */
function node(kind: string, resource: any): OwnershipNode {
  return {
    kind,
    name: String(resource?.metadata?.name || ''),
    uid: typeof resource?.metadata?.uid === 'string' ? resource.metadata.uid : undefined,
    controller: true,
  };
}

/** Extract container identities and images from a workload Pod template. */
function templateContainers(kind: string, resource: any): { containers: any[]; initContainers: any[] } {
  const podSpec = kind === 'CronJob'
    ? resource?.spec?.jobTemplate?.spec?.template?.spec
    : resource?.spec?.template?.spec;
  const summarizeEnv = (items: any) => Array.isArray(items)
    ? items.map((item: any) => {
        const configMapRef = item?.valueFrom?.configMapKeyRef;
        if (typeof item?.value === 'string') {
          return {
            name: item?.name,
            source: 'literal',
            valueSha256: createHash('sha256').update(item.value).digest('hex'),
          };
        }
        if (configMapRef) {
          return {
            name: item?.name,
            source: 'config_map',
            configMap: configMapRef.name,
            key: configMapRef.key,
            optional: Boolean(configMapRef.optional),
          };
        }
        return { name: item?.name, source: 'unsupported' };
      })
    : [];
  const summarize = (items: any) => Array.isArray(items)
    ? items.map((item: any) => ({ name: item?.name, image: item?.image, env: summarizeEnv(item?.env) }))
    : [];
  return { containers: summarize(podSpec?.containers), initContainers: summarize(podSpec?.initContainers) };
}

/** Map an owner lookup failure to a bounded model-visible diagnostic. */
function resolutionError(error: any): { code: string; message: string } {
  const status = Number(error?.statusCode || error?.code || error?.response?.statusCode || error?.response?.status);
  if (status === 401 || status === 403) return { code: 'OWNER_LOOKUP_FORBIDDEN', message: 'RBAC denied an owner lookup.' };
  if (status === 404) return { code: 'OWNER_NOT_FOUND', message: 'An owner referenced by the Pod no longer exists.' };
  return { code: 'OWNER_LOOKUP_FAILED', message: 'The owner chain could not be resolved.' };
}

/** Fetch one supported namespaced controller by exact owner identity. */
async function readOwner(owner: OwnerRef, namespace: string): Promise<any> {
  switch (owner.kind) {
    case 'ReplicaSet': return k8sClient.apps.readNamespacedReplicaSet({ name: owner.name, namespace });
    case 'Deployment': return k8sClient.apps.readNamespacedDeployment({ name: owner.name, namespace });
    case 'StatefulSet': return k8sClient.apps.readNamespacedStatefulSet({ name: owner.name, namespace });
    case 'DaemonSet': return k8sClient.apps.readNamespacedDaemonSet({ name: owner.name, namespace });
    case 'Job': return k8sClient.batch.readNamespacedJob({ name: owner.name, namespace });
    case 'CronJob': return k8sClient.batch.readNamespacedCronJob({ name: owner.name, namespace });
    default: return undefined;
  }
}

/** Build the exact patch prerequisites for a resolved workload target. */
function target(
  kind: string,
  resource: any,
  namespace: string,
  effect: 'current_and_future_pods' | 'future_runs_only' | 'current_resource',
  containers = templateContainers(kind, resource),
) {
  return {
    kind,
    name: resource?.metadata?.name,
    namespace,
    uid: resource?.metadata?.uid,
    resourceVersion: resource?.metadata?.resourceVersion,
    effect,
    ...containers,
  };
}

/** Resolve a Pod controller chain without using naming conventions. */
async function resolvePodOwnership(pod: any, namespace: string): Promise<Record<string, unknown>> {
  const path: OwnershipNode[] = [{ ...node('Pod', pod), controller: false }];
  let owner = controllerOwner(pod);
  if (!owner) {
    const hasOwnerReferences = Array.isArray(pod?.metadata?.ownerReferences) && pod.metadata.ownerReferences.length > 0;
    return {
      status: 'unowned', path, remediationTarget: null,
      reason: hasOwnerReferences ? 'no_controlling_owner_reference' : 'standalone_pod_not_patchable',
    };
  }
  const seen = new Set<string>();

  for (let depth = 0; depth < 5; depth += 1) {
    const key = `${owner.kind}/${owner.name}/${owner.uid || ''}`;
    if (seen.has(key)) return { status: 'partial', path, remediationTarget: null, error: { code: 'OWNER_CYCLE', message: 'Owner chain contains a cycle.' } };
    seen.add(key);
    if (!['ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(owner.kind)) {
      path.push(owner);
      return { status: 'unsupported', path, remediationTarget: null, reason: 'owner_kind_unsupported', error: { code: 'OWNER_KIND_UNSUPPORTED', message: `Controller kind ${owner.kind} is not supported for remediation.` } };
    }

    let resource: any;
    try {
      resource = await readOwner(owner, namespace);
    } catch (error) {
      path.push(owner);
      return { status: 'partial', path, remediationTarget: null, error: resolutionError(error) };
    }
    if (!owner.uid || !resource?.metadata?.uid || owner.uid !== resource.metadata.uid) {
      path.push(node(owner.kind, resource));
      return { status: 'partial', path, remediationTarget: null, error: { code: 'OWNER_UID_MISMATCH', message: 'The owner was replaced while it was being resolved.' } };
    }
    path.push(node(owner.kind, resource));

    if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(owner.kind)) {
      return { status: 'resolved', path, remediationTarget: target(owner.kind, resource, namespace, 'current_and_future_pods') };
    }
    if (owner.kind === 'CronJob') {
      return { status: 'resolved', path, remediationTarget: target('CronJob', resource, namespace, 'future_runs_only'), reason: 'cronjob_changes_affect_future_jobs_only' };
    }

    const nextOwner = controllerOwner(resource);
    if (!nextOwner) {
      return {
        status: owner.kind === 'Job' ? 'unsupported' : 'partial',
        path,
        remediationTarget: null,
        reason: owner.kind === 'Job' ? 'active_job_template_immutable' : 'owner_chain_incomplete',
      };
    }
    owner = nextOwner;
  }
  return { status: 'partial', path, remediationTarget: null, error: { code: 'OWNER_DEPTH_EXCEEDED', message: 'Owner chain exceeded the supported depth.' } };
}

/** Read one supported Kubernetes object by exact kind, name, and namespace. */
async function readResource(kind: BuiltInKind, name: string, namespace?: string): Promise<any> {
  switch (kind) {
    case 'Pod': return k8sClient.core.readNamespacedPod({ name, namespace: namespace! });
    case 'Deployment': return k8sClient.apps.readNamespacedDeployment({ name, namespace: namespace! });
    case 'StatefulSet': return k8sClient.apps.readNamespacedStatefulSet({ name, namespace: namespace! });
    case 'DaemonSet': return k8sClient.apps.readNamespacedDaemonSet({ name, namespace: namespace! });
    case 'CronJob': return k8sClient.batch.readNamespacedCronJob({ name, namespace: namespace! });
    case 'Job': return k8sClient.batch.readNamespacedJob({ name, namespace: namespace! });
    case 'Service': return k8sClient.core.readNamespacedService({ name, namespace: namespace! });
    case 'ConfigMap': return k8sClient.core.readNamespacedConfigMap({ name, namespace: namespace! });
    case 'Ingress': return k8sClient.networking.readNamespacedIngress({ name, namespace: namespace! });
    case 'PVC': return k8sClient.core.readNamespacedPersistentVolumeClaim({ name, namespace: namespace! });
    case 'Node': return k8sClient.core.readNode({ name });
    case 'HPA': return k8sClient.autoscaling.readNamespacedHorizontalPodAutoscaler({ name, namespace: namespace! });
    case 'Event': return k8sClient.core.readNamespacedEvent({ name, namespace: namespace! });
    case 'Namespace': return k8sClient.core.readNamespace({ name });
    default: throw new Error(`Unsupported kind: ${kind}`);
  }
}

/** Return a complete redacted resource plus explicit ownership diagnostics. */
export async function getResourceHandler(params: z.infer<typeof schema>) {
  if ('addition_key' in params) {
    const definition = requireCustomResourceAddition(params.addition_key, params.resource, 'get');
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
      name: params.name
    };
    const original = definition.scope === 'namespaced'
      ? await k8sClient.customObjects.getNamespacedCustomObject({ ...options, namespace: params.namespace! })
      : await k8sClient.customObjects.getClusterCustomObject(options);
    return { resource: redactKubernetesResource(original) };
  }
  const { kind, name, namespace } = params;
  checkNamespaceAllowed(namespace);
  const original = await readResource(kind, name, namespace);
  const resource = redactKubernetesResource(original);
  if (kind === 'ConfigMap') {
    if (original?.data !== undefined) {
      resource.data = Object.fromEntries(Object.keys(original.data || {}).map((key) => [key, REDACTED]));
    }
    if (original?.binaryData !== undefined) {
      resource.binaryData = Object.fromEntries(Object.keys(original.binaryData || {}).map((key) => [key, REDACTED]));
    }
  }
  const ownership = kind === 'Pod' ? await resolvePodOwnership(original, namespace!) : undefined;
  const safeConfiguration = {
    ...templateContainers(kind, original),
    configMapKeys: kind === 'ConfigMap'
      ? Object.entries(original?.data || {}).map(([key, value]) => ({
          key,
          valueSha256: createHash('sha256').update(String(value)).digest('hex'),
          bytes: Buffer.byteLength(String(value)),
        })).sort((left, right) => left.key.localeCompare(right.key))
      : [],
  };
  return { resource, safeConfiguration, ...(ownership ? { ownership } : {}) };
}

/** Summarize container status without copying the entire Pod status object. */
function containerHealth(statuses: any): Array<Record<string, unknown>> {
  if (!Array.isArray(statuses)) return [];
  return statuses.map((status: any) => ({
    name: status?.name,
    ready: status?.ready,
    restartCount: status?.restartCount,
    state: summarizeContainerState(status?.state),
    lastState: summarizeContainerState(status?.lastState),
  }));
}

/** Bound waiting and termination messages while retaining diagnostic reasons. */
function summarizeContainerState(state: any): Record<string, unknown> | undefined {
  if (!state || typeof state !== 'object') return undefined;
  if (state.waiting) return { waiting: { reason: state.waiting.reason, message: boundedText(state.waiting.message) } };
  if (state.terminated) return { terminated: {
    reason: state.terminated.reason,
    message: boundedText(state.terminated.message),
    exitCode: state.terminated.exitCode,
    signal: state.terminated.signal,
    finishedAt: state.terminated.finishedAt,
  } };
  if (state.running) return { running: { startedAt: state.running.startedAt } };
  return undefined;
}

export const getResourceTool: ToolDefinition = {
  name: 'get_resource',
  description: 'Inspect one Kubernetes resource; Pod results include a UID-verified ownership path.',
  capability: 'read',
  timeoutMs: 12000,
  version: 'v3',
  outputSchema: OUTPUT_SCHEMA,
  artifactPolicy: 'always',
  schema,
  scopeResolver: (params) => 'addition_key' in params
    ? (params.namespace ? { type: 'namespaced', namespace: params.namespace } : { type: 'cluster', kind: params.resource })
    : params.kind === 'Node'
    ? ({ type: 'cluster', kind: params.kind })
    : params.kind === 'Namespace'
      ? ({ type: 'cluster', kind: params.kind, namespace: params.name })
      : ({ type: 'namespaced', namespace: params.namespace }),
  handler: getResourceHandler,
  projectForModel: (result, params) => {
    const resource = result?.resource || {};
    if ('addition_key' in params) {
      const projection = {
        schemaVersion: 'acornops.model-context.v1' as const,
        tool: 'get_resource',
        status: 'success' as const,
        summary: `Inspected ${resource?.kind || params.resource} ${params.namespace ? `${params.namespace}/` : ''}${params.name}.`,
        data: { resource },
        omissions: [] as Array<Record<string, unknown>>,
      };
      const originalBytes = Buffer.byteLength(JSON.stringify(projection));
      if (originalBytes > 12 * 1024) {
        projection.data.resource = identity(resource);
        projection.omissions.push({ path: 'data.resource', reason: 'context_byte_limit', originalBytes });
      }
      return {
        ...projection,
      };
    }
    const status = resource?.status || {};
    const ownership = result?.ownership;
    const safeContainers = {
      containers: result?.safeConfiguration?.containers || templateContainers(params?.kind, resource).containers,
      initContainers: result?.safeConfiguration?.initContainers || templateContainers(params?.kind, resource).initContainers,
    };
    const name = resource?.metadata?.name || params?.name;
    const namespace = resource?.metadata?.namespace || params?.namespace;
    const directlyPatchable = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Service', 'Ingress', 'ConfigMap']
      .includes(params?.kind);
    const remediationTarget = ownership?.remediationTarget || (directlyPatchable
      ? target(
        params.kind,
        resource,
        namespace,
        params.kind === 'CronJob'
          ? 'future_runs_only'
          : ['Service', 'Ingress', 'ConfigMap'].includes(params.kind) ? 'current_resource' : 'current_and_future_pods',
        safeContainers,
      )
      : null);
    const resolutionSummary = params?.kind === 'Pod'
      ? remediationTarget
        ? ` Owning remediation target is ${remediationTarget.kind} ${namespace}/${remediationTarget.name}.`
        : ` No patchable remediation target was resolved (${ownership?.reason || ownership?.error?.code || ownership?.status || 'unknown'}).`
      : '';
    const resourceIdentity = {
      ...identity(resource),
      apiVersion: resource?.apiVersion || API_VERSION_BY_KIND[params.kind as keyof typeof API_VERSION_BY_KIND],
      kind: resource?.kind || params?.kind,
      name,
      namespace,
    };
    const projection: any = {
      schemaVersion: 'acornops.model-context.v1',
      tool: 'get_resource',
      status: 'success',
      summary: `Inspected ${params?.kind} ${namespace ? `${namespace}/` : ''}${name}.${resolutionSummary}`,
      data: {
        resource: resourceIdentity,
        ownership,
        remediationTarget,
        health: {
          phase: status.phase,
          reason: status.reason,
          message: boundedText(status.message),
          conditions: Array.isArray(status.conditions) ? status.conditions.slice(-12).map((condition: any) => ({
            type: condition?.type,
            status: condition?.status,
            reason: condition?.reason,
            message: boundedText(condition?.message),
            lastTransitionTime: condition?.lastTransitionTime,
          })) : [],
          replicas: status.replicas,
          readyReplicas: status.readyReplicas,
          availableReplicas: status.availableReplicas,
          containerStatuses: containerHealth(status.containerStatuses),
          initContainerStatuses: containerHealth(status.initContainerStatuses),
        },
        configuration: {
          containers: result?.safeConfiguration?.containers || [],
          initContainers: result?.safeConfiguration?.initContainers || [],
          configMapKeys: result?.safeConfiguration?.configMapKeys || [],
          selector: resource?.spec?.selector,
          serviceType: resource?.spec?.type,
          clusterIP: resource?.spec?.clusterIP,
          ingressClassName: resource?.spec?.ingressClassName,
          hosts: Array.isArray(resource?.spec?.rules)
            ? resource.spec.rules.map((rule: any) => rule?.host).filter(Boolean).slice(0, 50)
            : [],
          storageClassName: resource?.spec?.storageClassName,
          capacity: status?.capacity,
          scaleTargetRef: resource?.spec?.scaleTargetRef,
        },
      },
      omissions: [],
    };
    const size = () => Buffer.byteLength(JSON.stringify(projection));
    const originalProjectionBytes = size();
    if (size() > 12 * 1024 && projection.data.configuration.selector !== undefined) {
      const originalBytes = Buffer.byteLength(JSON.stringify(projection.data.configuration.selector));
      projection.data.configuration.selector = undefined;
      projection.omissions.push({
        path: 'data.configuration.selector', reason: 'context_byte_limit', originalBytes,
      });
    }
    if (size() > 12 * 1024) {
      const originalCount = projection.data.health.conditions.length;
      projection.data.health.conditions = projection.data.health.conditions.slice(-5);
      if (originalCount > projection.data.health.conditions.length) {
        projection.omissions.push({
          path: 'data.health.conditions', reason: 'context_byte_limit', originalCount,
          retainedCount: projection.data.health.conditions.length,
        });
      }
    }
    if (size() > 12 * 1024) {
      const originalCount = projection.data.configuration.hosts.length;
      projection.data.configuration.hosts = projection.data.configuration.hosts.slice(0, 10);
      if (originalCount > projection.data.configuration.hosts.length) {
        projection.omissions.push({
          path: 'data.configuration.hosts', reason: 'context_byte_limit', originalCount,
          retainedCount: projection.data.configuration.hosts.length,
        });
      }
    }
    if (size() > 12 * 1024) {
      for (const field of ['containerStatuses', 'initContainerStatuses']) {
        const values = projection.data.health[field];
        projection.data.health[field] = values.slice(0, 10);
        if (values.length > 10) projection.omissions.push({
          path: `data.health.${field}`, reason: 'context_byte_limit', originalCount: values.length, retainedCount: 10,
        });
      }
    }
    if (size() > 12 * 1024 && remediationTarget) {
      for (const field of ['containers', 'initContainers']) {
        const values = projection.data.configuration[field];
        projection.data.configuration[field] = [];
        if (values.length) projection.omissions.push({
          path: `data.configuration.${field}`, reason: 'duplicated_in_remediation_target', originalCount: values.length,
          retainedCount: 0,
        });
      }
    }
    if (size() > 12 * 1024) {
      return {
        schemaVersion: 'acornops.model-context.v1',
        tool: 'get_resource',
        status: 'success',
        summary: `Inspected ${params?.kind} ${namespace ? `${namespace}/` : ''}${name}, but its safe remediation evidence exceeds the model-context limit. No patch target is available.`,
        data: {
          code: 'MODEL_CONTEXT_TOO_LARGE',
          message: 'The complete remediation prerequisites could not fit safely in model context; do not patch this resource.',
          resource: resourceIdentity,
          remediationTarget: null,
          ownershipStatus: ownership?.status,
        },
        omissions: [{ path: '$', reason: 'context_byte_limit', originalBytes: originalProjectionBytes }],
      };
    }
    return projection;
  },
};
