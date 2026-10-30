import { z } from 'zod';
import fetch, { Headers, Response } from 'node-fetch';
import { k8sClient } from '../../k8s/client.js';
import { ToolDefinition, ToolExecutionContext } from '../registry.js';
import { checkNamespaceAllowed } from '../utils.js';
import { containerNameSchema, kubernetesNameSchema, namespaceSchema } from '../schemas.js';
import { ToolExecutionError } from '../errors.js';
import { fullToolResultOutputSchema } from '../model-context.js';
import { redactStructuredLogText } from '../structured-log-redaction.js';

const OUTPUT_SCHEMA = fullToolResultOutputSchema({
  type: 'object', required: ['name', 'namespace', 'container', 'logs'],
  properties: {
    name: { type: 'string' }, namespace: { type: 'string' },
    container: { type: 'string' }, logs: { type: 'string' },
  },
  additionalProperties: false,
});

const MAX_LOG_BYTES = 1024 * 1024;
const LOG_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic <redacted>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1<redacted>@'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '<redacted-private-key>'],
  [/(\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|credential)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1<redacted>'],
];

const schema = z.object({
  name: kubernetesNameSchema,
  namespace: namespaceSchema,
  container: containerNameSchema.optional(),
  previous: z.boolean().optional().default(false),
  tail_lines: z.number().int().min(1).max(5000).optional().default(200),
  since_seconds: z.number().int().min(1).optional(),
  limit_bytes: z.number().int().min(1).max(MAX_LOG_BYTES).optional().default(MAX_LOG_BYTES)
}).strict();

/** Consume a response body without allowing an oversized upstream response into memory. */
async function readBoundedBody(response: Response): Promise<string> {
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > MAX_LOG_BYTES) {
      throw new ToolExecutionError('OUTPUT_TOO_LARGE', 'Pod log response exceeds the 1 MiB limit');
    }
    return response.body.toString('utf8');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_LOG_BYTES) {
      throw new ToolExecutionError('OUTPUT_TOO_LARGE', 'Pod log response exceeds the 1 MiB limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** Remove common credential shapes from logs before model or artifact handling. */
export function redactLogSecrets(value: string): string {
  return redactStructuredLogText(value, (text) => LOG_SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement), text
  ));
}

/** Return a UTF-8-safe suffix within a serialized byte budget. */
function utf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/** Build the Kubernetes pod logs API URL for a specific pod request. */
function buildPodLogUrl(name: string, namespace: string, params: {
  container?: string;
  previous: boolean;
  tail_lines: number;
  since_seconds?: number;
  limit_bytes: number;
}): URL {
  const cluster = k8sClient.kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error('No active Kubernetes cluster');
  }

  const url = new URL(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/log`,
    cluster.server.endsWith('/') ? cluster.server : `${cluster.server}/`
  );
  if (params.container) url.searchParams.set('container', params.container);
  url.searchParams.set('previous', String(params.previous));
  url.searchParams.set('tailLines', String(params.tail_lines));
  if (params.since_seconds) url.searchParams.set('sinceSeconds', String(params.since_seconds));
  url.searchParams.set('limitBytes', String(params.limit_bytes));
  return url;
}

/** Recognize the Kubernetes waiting-container error without returning its details. */
function isContainerWaitingToStart(body: string): boolean {
  let message: unknown = body;
  try {
    message = JSON.parse(body)?.message;
  } catch {
    // The pod log endpoint can return a plain-text error instead of a Status object.
  }
  return typeof message === 'string'
    && /^container "[^"\r\n]+" in pod "[^"\r\n]+" is waiting to start:/.test(message);
}

/** Read pod logs as plain text from the Kubernetes API. */
export async function readPodLogsText(name: string, namespace: string, params: {
  container?: string;
  previous: boolean;
  tail_lines: number;
  since_seconds?: number;
  limit_bytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  const url = buildPodLogUrl(name, namespace, params);
  const requestInit = await k8sClient.kc.applyToFetchOptions({});
  const headers = new Headers(requestInit.headers);
  headers.set('accept', 'text/plain, */*');

  const response = await fetch(url.toString(), {
    ...requestInit,
    method: 'GET',
    headers,
    signal: params.signal,
  });
  const body = await readBoundedBody(response);
  if (!response.ok) {
    if (response.status === 400 && isContainerWaitingToStart(body)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'No logs yet; this container has not started.', {
        status: 400, reason: 'ContainerNotStarted', phase: 'kubernetes_api',
      });
    }
    throw new Error(`Kubernetes pod log request failed with status ${response.status}`);
  }
  return body;
}

/** Handle the get_resource_logs tool request. */
async function handler(params: z.infer<typeof schema>, context?: ToolExecutionContext) {
  const { name, namespace, container, previous, tail_lines, since_seconds, limit_bytes } = params;
  checkNamespaceAllowed(namespace);

  const logs = redactLogSecrets(await readPodLogsText(name, namespace, {
    container,
    previous,
    tail_lines,
    since_seconds,
    limit_bytes,
    signal: context?.signal,
  }));

  return {
    name,
    namespace,
    container: container || '',
    logs
  };
}

export const getResourceLogsTool: ToolDefinition = {
  name: 'get_resource_logs',
  description: 'Read recent logs from a Pod container.',
  capability: 'read',
  timeoutMs: 20000,
  version: 'v1',
  outputSchema: OUTPUT_SCHEMA,
  artifactPolicy: 'always',
  schema,
  scopeResolver: (params) => ({ type: 'namespaced', namespace: params.namespace }),
  handler,
  projectForModel: (result, params) => {
    const logs = typeof result?.logs === 'string' ? result.logs : '';
    const excerptBytes = 8 * 1024;
    const buffer = Buffer.from(logs, 'utf8');
    const excerpt = utf8Tail(logs, excerptBytes);
    const returnedLines = logs.length === 0 ? 0 : logs.split('\n').length - (logs.endsWith('\n') ? 1 : 0);
    const excerptLines = excerpt.length === 0 ? 0 : excerpt.split('\n').length - (excerpt.endsWith('\n') ? 1 : 0);
    return {
      schemaVersion: 'acornops.model-context.v1',
      tool: 'get_resource_logs',
      status: 'success',
      summary: `Read recent logs for Pod ${result?.namespace}/${result?.name}${result?.container ? ` container ${result.container}` : ''}.`,
      data: {
        target: { kind: 'Pod', name: result?.name, namespace: result?.namespace, container: result?.container || undefined },
        requested: {
          previous: params?.previous ?? false,
          tailLines: params?.tail_lines ?? 200,
          sinceSeconds: params?.since_seconds ?? null,
          limitBytes: params?.limit_bytes ?? MAX_LOG_BYTES,
        },
        returnedBytes: buffer.length,
        returnedLines,
        excerptBytes: Buffer.byteLength(excerpt),
        excerptLines,
        logExcerpt: excerpt,
      },
      omissions: buffer.length > excerptBytes
        ? [{ path: 'data.logExcerpt', reason: 'byte_limit', originalBytes: buffer.length, retainedBytes: Buffer.byteLength(excerpt) }]
        : [],
    };
  },
};
