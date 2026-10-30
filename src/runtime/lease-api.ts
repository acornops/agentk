import * as k8s from '@kubernetes/client-node';

export interface LeaseApi {
  readNamespacedLease(name: string, namespace: string, signal: AbortSignal): Promise<k8s.V1Lease>;
  createNamespacedLease(namespace: string, body: k8s.V1Lease, signal: AbortSignal): Promise<k8s.V1Lease>;
  replaceNamespacedLease(name: string, namespace: string, body: k8s.V1Lease, signal: AbortSignal): Promise<k8s.V1Lease>;
}

/** Append per-call cancellation without replacing kubeconfig authentication or TLS. */
export function createLeaseApi(coordination: k8s.CoordinationV1Api): LeaseApi {
  const options = (signal: AbortSignal) => ({
    middlewareMergeStrategy: 'append' as const,
    middleware: k8s.createConfiguration({ promiseMiddleware: [{
      pre: async (context) => { context.setSignal(signal); return context; },
      post: async (context) => context,
    }] }).middleware,
  });
  return {
    readNamespacedLease: (name, namespace, signal) => coordination.readNamespacedLease({ name, namespace }, options(signal)),
    createNamespacedLease: (namespace, body, signal) => coordination.createNamespacedLease({ namespace, body }, options(signal)),
    replaceNamespacedLease: (name, namespace, body, signal) => coordination.replaceNamespacedLease({ name, namespace, body }, options(signal)),
  };
}
