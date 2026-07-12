import { config } from '../config.js';
import { isNamespaceAllowed } from '../runtime/namespace-scope.js';
import { ToolExecutionError } from './errors.js';
import type { ToolExecutionContext } from './registry.js';

/** Throw when write tools are disabled by configuration. */
export function checkWriteEnabled() {
  if (!config.ACORNOPS_AGENT_WRITE_ENABLED) {
    throw new ToolExecutionError('WRITE_DISABLED', 'Write operations are disabled');
  }
}

/** Throw when a namespace is outside the configured namespace scope. */
export function checkNamespaceAllowed(namespace?: string) {
  if (!namespace) return;
  if (!isNamespaceAllowed(namespace)) {
    throw new ToolExecutionError('NAMESPACE_FORBIDDEN', `Namespace is outside the allowed scope: ${namespace}`);
  }
}

/** Stop a multi-stage write before it initiates another Kubernetes operation. */
export function checkOperationNotAborted(context: ToolExecutionContext | undefined, operationId: string): void {
  if (context?.signal?.aborted) {
    throw new ToolExecutionError('TOOL_TIMEOUT', 'Write deadline expired before mutation', {
      outcome: 'not_started',
      operationId,
    });
  }
}

/** Verify the idempotency record written by an atomic AgentK operation. */
export function operationAnnotationsMatch(
  annotations: unknown,
  operationId: string,
  operationHash: string,
  operationKind: 'restart' | 'scale' | 'patch'
): boolean {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  const record = annotations as Record<string, unknown>;
  return record['acornops.dev/operation-id'] === operationId &&
    record['acornops.dev/operation-hash'] === operationHash &&
    record['acornops.dev/operation-kind'] === operationKind;
}

/** Build standard AcornOps annotations for a write operation. */
export function getAnnotations(reason: string, operationId?: string) {
  return {
    'acornops.dev/applied-by': `cluster-${config.ACORNOPS_CLUSTER_ID}`,
    'acornops.dev/reason': reason,
    ...(operationId ? { 'acornops.dev/operation-id': operationId } : {}),
  };
}
