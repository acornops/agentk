import { z } from 'zod';
import { isKubernetesDnsLabel } from './k8s/names.js';

export const DEFAULT_EXCLUDED_NAMESPACES = ['kube-node-lease', 'kube-public'];
export const SUPPORTED_PATCH_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Service', 'Ingress'] as const;
export type SupportedPatchKind = typeof SUPPORTED_PATCH_KINDS[number];
const DEFAULT_PATCH_KINDS: SupportedPatchKind[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

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
function parsePatchKindList(value: string | undefined, ctx: z.RefinementCtx): SupportedPatchKind[] {
  const source = value === undefined ? DEFAULT_PATCH_KINDS.join(',') : value;
  const rawKinds = source.split(',').map((item) => item.trim()).filter(Boolean);
  const kinds = [...new Set(rawKinds)];
  if (kinds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one patch kind is required' });
  }
  for (const kind of kinds) {
    if (!SUPPORTED_PATCH_KINDS.includes(kind as SupportedPatchKind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported patch kind: ${kind}` });
    }
  }
  return kinds.filter((kind): kind is SupportedPatchKind => SUPPORTED_PATCH_KINDS.includes(kind as SupportedPatchKind));
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
  ACORNOPS_AGENT_PATCH_KINDS: z.string().optional().transform(parsePatchKindList),
  ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH: z.string().optional().default('false').transform(val => val === 'true'),
  ACORNOPS_AGENT_RBAC_SCOPE: z.enum(['cluster', 'namespace']).default('cluster'),
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
  AGENT_VERSION: z.string().default('0.0.1-experimental.1'),
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
