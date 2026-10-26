import { z } from 'zod';
import { isKubernetesDnsLabel } from './k8s/names.js';

export const DEFAULT_EXCLUDED_NAMESPACES = ['kube-node-lease', 'kube-public'];
export const SUPPORTED_WORKLOAD_PATCH_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'] as const;
export type SupportedWorkloadPatchKind = typeof SUPPORTED_WORKLOAD_PATCH_KINDS[number];
const DEFAULT_WORKLOAD_PATCH_KINDS: SupportedWorkloadPatchKind[] = ['Deployment', 'StatefulSet', 'DaemonSet'];
export const SUPPORTED_RESOURCE_PATCH_KINDS = ['Service', 'Ingress'] as const;
export type SupportedResourcePatchKind = typeof SUPPORTED_RESOURCE_PATCH_KINDS[number];
// Historical snapshots may contain verbs for removed tools. Keep them parseable;
// Helm renders only get, list, and patch permissions.
export const KUBERNETES_RBAC_ADDITION_VERBS = ['get', 'list', 'watch', 'create', 'patch', 'delete'] as const;
export type KubernetesRbacAdditionVerb = typeof KUBERNETES_RBAC_ADDITION_VERBS[number];

const kubernetesRbacAdditionResourceSchema = z.object({
  apiGroup: z.string().trim().min(1).max(253)
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/, 'Invalid Kubernetes API group'),
  apiVersion: z.string().trim().min(1).max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Invalid Kubernetes API version'),
  resource: z.string().trim().min(1).max(253)
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/, 'Invalid Kubernetes resource plural'),
  kind: z.string().trim().min(1).max(128)
    .regex(/^[A-Z][A-Za-z0-9]*$/, 'Invalid Kubernetes resource kind'),
  scope: z.enum(['namespaced', 'cluster']),
  verbs: z.array(z.enum(KUBERNETES_RBAC_ADDITION_VERBS)).min(1).max(KUBERNETES_RBAC_ADDITION_VERBS.length)
    .refine((verbs) => new Set(verbs).size === verbs.length, 'RBAC verbs must not contain duplicates')
    .refine((verbs) => !verbs.includes('patch') || verbs.includes('list'), 'patch requires list so the agent can establish resource identity')
}).strict();

export const kubernetesRbacAdditionSchema = z.object({
  key: z.string().trim().min(1).max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Invalid RBAC addition key'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional().default(''),
  resources: z.array(kubernetesRbacAdditionResourceSchema).min(1).max(50)
    .refine(
      (resources) => new Set(resources.map((resource) => resource.resource)).size === resources.length,
      'Kubernetes resource plurals must be unique within an RBAC addition'
    )
}).strict();

export type KubernetesRbacAddition = z.infer<typeof kubernetesRbacAdditionSchema>;

/** Parse the control-plane-owned custom-resource addition snapshot. */
function parseKubernetesRbacAdditions(value: string, ctx: z.RefinementCtx): KubernetesRbacAddition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ACORNOPS_AGENT_RBAC_ADDITIONS_JSON must be valid JSON' });
    return [];
  }
  const result = z.array(kubernetesRbacAdditionSchema).max(25).safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid RBAC addition: ${issue.message}` });
    }
    return [];
  }
  if (new Set(result.data.map((addition) => addition.key)).size !== result.data.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RBAC addition keys must not contain duplicates' });
    return [];
  }
  return result.data;
}

/** Parse and validate a comma-separated Kubernetes namespace environment value. */
function parseNamespaceList(value: string | undefined, ctx: z.RefinementCtx): string[] {
  const namespaces = [...new Set((value || '').split(',').map((item) => item.trim()).filter(Boolean))];
  for (const namespace of namespaces) {
    if (!isKubernetesDnsLabel(namespace)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid Kubernetes namespace: ${namespace}` });
    }
  }
  return namespaces;
}

/** Parse and validate the local maximum set of patchable resource kinds. */
function parseWorkloadPatchKindList(value: string | undefined, ctx: z.RefinementCtx): SupportedWorkloadPatchKind[] {
  const source = value === undefined ? DEFAULT_WORKLOAD_PATCH_KINDS.join(',') : value;
  const rawKinds = source.split(',').map((item) => item.trim()).filter(Boolean);
  const kinds = [...new Set(rawKinds)];
  if (kinds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one patch kind is required' });
  }
  for (const kind of kinds) {
    if (!SUPPORTED_WORKLOAD_PATCH_KINDS.includes(kind as SupportedWorkloadPatchKind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported workload patch kind: ${kind}` });
    }
  }
  return kinds.filter((kind): kind is SupportedWorkloadPatchKind =>
    SUPPORTED_WORKLOAD_PATCH_KINDS.includes(kind as SupportedWorkloadPatchKind));
}

/** Parse the explicit local opt-in set of patchable Service and Ingress kinds. */
function parseResourcePatchKindList(value: string | undefined, ctx: z.RefinementCtx): SupportedResourcePatchKind[] {
  const kinds = [...new Set((value || '').split(',').map((item) => item.trim()).filter(Boolean))];
  for (const kind of kinds) {
    if (!SUPPORTED_RESOURCE_PATCH_KINDS.includes(kind as SupportedResourcePatchKind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported resource patch kind: ${kind}` });
    }
  }
  return kinds.filter((kind): kind is SupportedResourcePatchKind =>
    SUPPORTED_RESOURCE_PATCH_KINDS.includes(kind as SupportedResourcePatchKind));
}

const configSchema = z.object({
  ACORNOPS_AGENT_PLATFORM_URL: z.string().url(),
  ACORNOPS_CLUSTER_ID: z.string().min(1),
  ACORNOPS_AGENT_KEY: z.string().min(1),
  ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_HANDSHAKE_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  ACORNOPS_AGENT_KUBECONFIG_REWRITE_LOOPBACK: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_KUBECONFIG_HOST_ALIAS: z.string().optional().default('host.docker.internal'),
  ACORNOPS_AGENT_KUBECONFIG_SKIP_TLS_VERIFY: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_K8S_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(8),
  ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT: z.coerce.number().int().min(1).max(1000).default(500),
  ACORNOPS_AGENT_TOOL_READ_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(4),
  ACORNOPS_AGENT_TOOL_WRITE_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  ACORNOPS_AGENT_TOOL_QUEUE_LIMIT: z.coerce.number().int().min(0).max(16).default(16),
  ACORNOPS_AGENT_TOOL_MAX_INPUT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(1024 * 1024),
  ACORNOPS_AGENT_TOOL_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
  ACORNOPS_AGENT_SCALE_MAX_REPLICAS: z.coerce.number().int().min(1).max(100).default(100),
  ACORNOPS_AGENT_ALLOW_SCALE_TO_ZERO: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_WORKLOAD_PATCH_KINDS: z.string().optional().transform(parseWorkloadPatchKindList),
  ACORNOPS_AGENT_RESOURCE_PATCH_KINDS: z.string().optional().default('').transform(parseResourcePatchKindList),
  ACORNOPS_AGENT_ALLOW_ENV_PATCH: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_RBAC_SCOPE: z.enum(['cluster', 'namespace']).default('cluster'),
  ACORNOPS_AGENT_RBAC_ADDITIONS_JSON: z.string().optional().default('[]').transform(parseKubernetesRbacAdditions),
  ACORNOPS_AGENT_WATCH_CACHE_ENABLED: z.string().optional().default('true').transform(val => val === 'true'),
  ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60000).default(5000),
  ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  ACORNOPS_AGENT_WATCH_NAMESPACES: z.string().optional().transform((val, ctx) => {
    const namespaces = parseNamespaceList(val, ctx);
    return namespaces.length > 0 ? namespaces : undefined;
  }),
  ACORNOPS_AGENT_EXCLUDE_NAMESPACES: z.string().optional().default('').transform(parseNamespaceList),
  ACORNOPS_AGENT_WRITE_ENABLED: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_LOCAL_FALLBACK_ENABLED: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_LOG_LEVEL: z.enum(['info', 'debug', 'error', 'trace', 'warn']).default('info'),
  ACORNOPS_AGENT_LEADER_ELECTION_ENABLED: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_LEASE_NAME: z.string().min(1).default('acornops-agent-leader'),
  ACORNOPS_AGENT_LEASE_NAMESPACE: z.string().optional().default(''),
  ACORNOPS_AGENT_LEADER_IDENTITY: z.string().optional().default(''),
  ACORNOPS_AGENT_LEASE_DURATION_MS: z.coerce.number().int().positive().default(15000),
  ACORNOPS_AGENT_RENEW_DEADLINE_MS: z.coerce.number().int().positive().default(10000),
  ACORNOPS_AGENT_RETRY_PERIOD_MS: z.coerce.number().int().positive().default(2000),
  ACORNOPS_AGENT_POD_NAME: z.string().optional().default(''),
  ACORNOPS_AGENT_POD_UID: z.string().optional().default(''),
  ACORNOPS_AGENT_POD_NAMESPACE: z.string().optional().default(''),
  CONNECTOR_VERSION: z.string().trim().min(1).max(127).regex(/^[^\s/]+$/).default('0.0.1-experimental.15'),
}).superRefine((cfg, ctx) => {
  let platformUrl: URL | undefined;
  try {
    platformUrl = new URL(cfg.ACORNOPS_AGENT_PLATFORM_URL);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACORNOPS_AGENT_PLATFORM_URL'],
      message: 'ACORNOPS_AGENT_PLATFORM_URL must be a valid WebSocket URL',
    });
  }
  if (platformUrl) {
    const allowInsecureTransport = cfg.ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT;
    if (platformUrl.protocol !== 'wss:' && !(allowInsecureTransport && platformUrl.protocol === 'ws:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ACORNOPS_AGENT_PLATFORM_URL'],
        message: 'ACORNOPS_AGENT_PLATFORM_URL must use wss://; ws:// requires ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true for local development only',
      });
    }
  }
  if (cfg.ACORNOPS_AGENT_RENEW_DEADLINE_MS >= cfg.ACORNOPS_AGENT_LEASE_DURATION_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACORNOPS_AGENT_RENEW_DEADLINE_MS'],
      message: 'ACORNOPS_AGENT_RENEW_DEADLINE_MS must be less than ACORNOPS_AGENT_LEASE_DURATION_MS',
    });
  }
  if (cfg.ACORNOPS_AGENT_RETRY_PERIOD_MS > cfg.ACORNOPS_AGENT_RENEW_DEADLINE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACORNOPS_AGENT_RETRY_PERIOD_MS'],
      message: 'ACORNOPS_AGENT_RETRY_PERIOD_MS must be less than or equal to ACORNOPS_AGENT_RENEW_DEADLINE_MS',
    });
  }
}).transform((cfg) => {
  const podNamespace = cfg.ACORNOPS_AGENT_POD_NAMESPACE || 'default';
  const identitySource = cfg.ACORNOPS_AGENT_LEADER_IDENTITY || cfg.ACORNOPS_AGENT_POD_UID || cfg.ACORNOPS_AGENT_POD_NAME;
  const holderIdentity = identitySource || `agent-${process.pid}`;

  return {
    ...cfg,
    TARGET_ID: cfg.ACORNOPS_CLUSTER_ID,
    ACORNOPS_AGENT_LEASE_NAMESPACE: cfg.ACORNOPS_AGENT_LEASE_NAMESPACE || podNamespace,
    ACORNOPS_AGENT_LEADER_IDENTITY: holderIdentity,
    ACORNOPS_AGENT_POD_NAMESPACE: podNamespace,
  };
});

/**
 * Configuration schema for the AcornOps Agent.
 * Validates environment variables and provides typed access to settings.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Loads and validates the configuration from environment variables.
 * Exits the process if any required variables are missing or invalid.
 * @returns The validated configuration object.
 */
function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
