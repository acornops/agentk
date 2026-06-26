import * as k8s from '@kubernetes/client-node';
import pino from 'pino';
import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { ListPageOptions, listAllPagesWithMetadata } from '../../k8s/pagination.js';
import { getWatchNamespaces } from '../../runtime/namespace-scope.js';
import { WatchResourceKind, WatchStore } from './watch-store.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'watch-manager' });

type ApiGroup = 'core' | 'apps' | 'batch' | 'networking';

interface ResourceDescriptor {
  kind: WatchResourceKind;
  apiGroup: ApiGroup;
  resourcePath: string;
  namespaced: boolean;
  listCluster: (options: ListPageOptions) => Promise<any>;
  listNamespaced?: (namespace: string, options: ListPageOptions) => Promise<any>;
}

interface WatchHandle {
  abort?: AbortController;
  reconnectTimer?: NodeJS.Timeout;
  generation: number;
  attempts: number;
  descriptor: ResourceDescriptor | 'events';
  namespace?: string;
}

type WatchRecoveryAction = 'relist' | 'reconnect' | undefined;

/** Return the resourceVersion from a Kubernetes object if present. */
function resourceVersionOf(obj: any): string | undefined {
  return obj?.metadata?.resourceVersion;
}

/** Return whether a watch error means the resourceVersion has been compacted. */
function isGoneError(err: unknown, watchObj?: unknown): boolean {
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  const code = (watchObj as { code?: unknown })?.code || (err as { code?: unknown })?.code;
  return statusCode === 410 || code === 410 || code === '410';
}

/** Build the Kubernetes API path for a resource watch. */
function apiPath(descriptor: ResourceDescriptor, namespace?: string): string {
  const prefix = descriptor.apiGroup === 'core' ? '/api/v1' : `/apis/${descriptor.apiGroup}/v1`;
  if (descriptor.namespaced && namespace) {
    return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${descriptor.resourcePath}`;
  }
  return `${prefix}/${descriptor.resourcePath}`;
}

/** Build the Kubernetes API path for an Event watch. */
function eventPath(namespace?: string): string {
  return namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : '/api/v1/events';
}

/** Build query options for a Warning Event watch. */
function warningEventOptions(resourceVersion?: string): Record<string, string | number | boolean | undefined> {
  return {
    fieldSelector: 'type=Warning',
    resourceVersion,
    allowWatchBookmarks: true,
    timeoutSeconds: config.ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS,
  };
}

/** Build query options for a Kubernetes resource watch. */
function watchOptions(resourceVersion?: string): Record<string, string | number | boolean | undefined> {
  return {
    resourceVersion,
    allowWatchBookmarks: true,
    timeoutSeconds: config.ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS,
  };
}

const RESOURCE_DESCRIPTORS: ResourceDescriptor[] = [
  {
    kind: 'pods',
    apiGroup: 'core',
    resourcePath: 'pods',
    namespaced: true,
    listCluster: (options) => k8sClient.core.listPodForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.core.listNamespacedPod({ namespace, ...options }),
  },
  {
    kind: 'deployments',
    apiGroup: 'apps',
    resourcePath: 'deployments',
    namespaced: true,
    listCluster: (options) => k8sClient.apps.listDeploymentForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.apps.listNamespacedDeployment({ namespace, ...options }),
  },
  {
    kind: 'statefulSets',
    apiGroup: 'apps',
    resourcePath: 'statefulsets',
    namespaced: true,
    listCluster: (options) => k8sClient.apps.listStatefulSetForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.apps.listNamespacedStatefulSet({ namespace, ...options }),
  },
  {
    kind: 'daemonSets',
    apiGroup: 'apps',
    resourcePath: 'daemonsets',
    namespaced: true,
    listCluster: (options) => k8sClient.apps.listDaemonSetForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.apps.listNamespacedDaemonSet({ namespace, ...options }),
  },
  {
    kind: 'cronJobs',
    apiGroup: 'batch',
    resourcePath: 'cronjobs',
    namespaced: true,
    listCluster: (options) => k8sClient.batch.listCronJobForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.batch.listNamespacedCronJob({ namespace, ...options }),
  },
  {
    kind: 'jobs',
    apiGroup: 'batch',
    resourcePath: 'jobs',
    namespaced: true,
    listCluster: (options) => k8sClient.batch.listJobForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.batch.listNamespacedJob({ namespace, ...options }),
  },
  {
    kind: 'services',
    apiGroup: 'core',
    resourcePath: 'services',
    namespaced: true,
    listCluster: (options) => k8sClient.core.listServiceForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.core.listNamespacedService({ namespace, ...options }),
  },
  {
    kind: 'ingresses',
    apiGroup: 'networking',
    resourcePath: 'ingresses',
    namespaced: true,
    listCluster: (options) => k8sClient.networking.listIngressForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.networking.listNamespacedIngress({ namespace, ...options }),
  },
  {
    kind: 'pvcs',
    apiGroup: 'core',
    resourcePath: 'persistentvolumeclaims',
    namespaced: true,
    listCluster: (options) => k8sClient.core.listPersistentVolumeClaimForAllNamespaces(options),
    listNamespaced: (namespace, options) => k8sClient.core.listNamespacedPersistentVolumeClaim({ namespace, ...options }),
  },
  {
    kind: 'nodes',
    apiGroup: 'core',
    resourcePath: 'nodes',
    namespaced: false,
    listCluster: (options) => k8sClient.core.listNode(options),
  },
  {
    kind: 'namespaces',
    apiGroup: 'core',
    resourcePath: 'namespaces',
    namespaced: false,
    listCluster: (options) => k8sClient.core.listNamespace(options),
  },
];

/** Maintains Kubernetes watches and keeps a local cache fresh for snapshots. */
export class WatchManager {
  private readonly watchClient: k8s.Watch;
  private readonly handles = new Set<WatchHandle>();
  private generation = 0;
  private active = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  /** Initialize the watch manager around a shared store. */
  constructor(
    private readonly store: WatchStore,
    private readonly onSignificantChange: () => void,
    watchClient = new k8s.Watch(k8sClient.kc)
  ) {
    this.watchClient = watchClient;
  }

  /** Start list-then-watch cache maintenance. */
  public start(): void {
    if (!config.ACORNOPS_AGENT_WATCH_CACHE_ENABLED) return;
    this.stop();
    this.active = true;
    this.generation++;
    this.store.clear();
    const generation = this.generation;
    for (const descriptor of RESOURCE_DESCRIPTORS) {
      void this.syncResourceDescriptor(descriptor, generation);
    }
    void this.syncEvents(generation);
  }

  /** Stop all watches and pending reconnects. */
  public stop(): void {
    this.active = false;
    this.generation++;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const handle of this.handles) {
      if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer);
      handle.abort?.abort();
    }
    this.handles.clear();
  }

  /** Restart cache maintenance after a scope or runtime change. */
  public restart(): void {
    this.start();
  }

  private async syncResourceDescriptor(descriptor: ResourceDescriptor, generation: number, attempts = 0): Promise<void> {
    this.store.markSyncing(descriptor.kind);
    try {
      const namespaces = descriptor.namespaced ? getWatchNamespaces() : undefined;
      if (descriptor.namespaced && namespaces) {
        const results = await Promise.all(namespaces.map(async (namespace) => ({
          namespace,
          result: await listAllPagesWithMetadata((options) => descriptor.listNamespaced!(namespace, options))
        })));
        if (!this.isCurrent(generation)) return;
        this.store.replaceResourceKind(descriptor.kind, results.flatMap((entry) => entry.result.items), results.at(-1)?.result.resourceVersion);
        for (const entry of results) {
          this.openResourceWatch(descriptor, generation, entry.result.resourceVersion, entry.namespace);
        }
      } else {
        const result = await listAllPagesWithMetadata((options) => descriptor.listCluster(options));
        if (!this.isCurrent(generation)) return;
        this.store.replaceResourceKind(descriptor.kind, result.items, result.resourceVersion);
        this.openResourceWatch(descriptor, generation, result.resourceVersion);
      }
    } catch (err) {
      logger.warn({ err, kind: descriptor.kind }, 'Failed initial resource watch sync');
      this.store.markUnhealthy(descriptor.kind, err);
      this.scheduleResourceInitialSync(descriptor, generation, attempts + 1);
    }
  }

  private async syncEvents(generation: number, attempts = 0): Promise<void> {
    this.store.markSyncing('events');
    try {
      const namespaces = getWatchNamespaces();
      if (namespaces) {
        const results = await Promise.all(namespaces.map(async (namespace) => ({
          namespace,
          result: await listAllPagesWithMetadata((options) => k8sClient.core.listNamespacedEvent({
            ...options,
            namespace,
            fieldSelector: 'type=Warning'
          }))
        })));
        if (!this.isCurrent(generation)) return;
        this.store.replaceEvents(results.flatMap((entry) => entry.result.items), results.at(-1)?.result.resourceVersion);
        for (const entry of results) {
          this.openEventWatch(generation, entry.result.resourceVersion, entry.namespace);
        }
      } else {
        const result = await listAllPagesWithMetadata((options) => k8sClient.core.listEventForAllNamespaces({
          ...options,
          fieldSelector: 'type=Warning'
        }));
        if (!this.isCurrent(generation)) return;
        this.store.replaceEvents(result.items, result.resourceVersion);
        this.openEventWatch(generation, result.resourceVersion);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed initial event watch sync');
      this.store.markUnhealthy('events', err);
      this.scheduleEventInitialSync(generation, attempts + 1);
    }
  }

  private openResourceWatch(descriptor: ResourceDescriptor, generation: number, resourceVersion?: string, namespace?: string, attempts = 0): void {
    const handle: WatchHandle = { generation, attempts, descriptor, namespace };
    let currentResourceVersion = resourceVersion;
    let recoveryScheduled = false;
    const scheduleRelist = (err?: unknown) => {
      if (recoveryScheduled) return;
      recoveryScheduled = true;
      this.handles.delete(handle);
      handle.abort?.abort();
      logger.warn({ err, kind: descriptor.kind, namespace }, 'Resource watch expired; relisting');
      void this.relistResourceScope(descriptor, generation, namespace);
    };
    const scheduleReconnect = (
      err?: unknown,
      options: { markUnhealthy?: boolean; attempts?: number } = {}
    ) => {
      if (recoveryScheduled) return;
      recoveryScheduled = true;
      this.handles.delete(handle);
      handle.abort?.abort();
      if (options.markUnhealthy !== false) {
        this.store.markUnhealthy(descriptor.kind, err || k8s.Watch.SERVER_SIDE_CLOSE, namespace);
      }
      this.scheduleResourceReconnect(
        descriptor,
        generation,
        namespace,
        currentResourceVersion,
        options.attempts ?? attempts + 1
      );
    };
    this.handles.add(handle);
    this.watchClient.watch(
      apiPath(descriptor, namespace),
      watchOptions(resourceVersion),
      (phase, obj, watchObj) => {
        currentResourceVersion = resourceVersionOf(obj) || currentResourceVersion;
        const recoveryAction = this.handleResourceWatchEvent(descriptor, generation, phase, obj, watchObj);
        if (recoveryAction === 'relist') {
          scheduleRelist(watchObj || obj);
        } else if (recoveryAction === 'reconnect') {
          scheduleReconnect(watchObj || obj);
        }
      },
      (err) => {
        this.handles.delete(handle);
        if (!this.isCurrent(generation)) return;
        if (isGoneError(err)) {
          scheduleRelist(err);
          return;
        }
        if (err) {
          scheduleReconnect(err);
          return;
        }
        scheduleReconnect(k8s.Watch.SERVER_SIDE_CLOSE, { markUnhealthy: false, attempts: 1 });
      }
    ).then((abort) => {
      handle.abort = abort;
      if (recoveryScheduled) {
        abort.abort();
        return;
      }
      if (!this.isCurrent(generation)) {
        abort.abort();
        return;
      }
      attempts = 0;
      this.store.markSynced(descriptor.kind, namespace);
    }).catch((err) => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      scheduleReconnect(err);
    });
  }

  private openEventWatch(generation: number, resourceVersion?: string, namespace?: string, attempts = 0): void {
    const handle: WatchHandle = { generation, attempts, descriptor: 'events', namespace };
    let currentResourceVersion = resourceVersion;
    let recoveryScheduled = false;
    const scheduleRelist = (err?: unknown) => {
      if (recoveryScheduled) return;
      recoveryScheduled = true;
      this.handles.delete(handle);
      handle.abort?.abort();
      logger.warn({ err, namespace }, 'Event watch expired; relisting');
      void this.relistEventScope(generation, namespace);
    };
    const scheduleReconnect = (
      err?: unknown,
      options: { markUnhealthy?: boolean; attempts?: number } = {}
    ) => {
      if (recoveryScheduled) return;
      recoveryScheduled = true;
      this.handles.delete(handle);
      handle.abort?.abort();
      if (options.markUnhealthy !== false) {
        this.store.markUnhealthy('events', err || k8s.Watch.SERVER_SIDE_CLOSE, namespace);
      }
      this.scheduleEventReconnect(generation, namespace, currentResourceVersion, options.attempts ?? attempts + 1);
    };
    this.handles.add(handle);
    this.watchClient.watch(
      eventPath(namespace),
      warningEventOptions(resourceVersion),
      (phase, obj, watchObj) => {
        currentResourceVersion = resourceVersionOf(obj) || currentResourceVersion;
        const recoveryAction = this.handleEventWatchEvent(generation, phase, obj, watchObj);
        if (recoveryAction === 'relist') {
          scheduleRelist(watchObj || obj);
        } else if (recoveryAction === 'reconnect') {
          scheduleReconnect(watchObj || obj);
        }
      },
      (err) => {
        this.handles.delete(handle);
        if (!this.isCurrent(generation)) return;
        if (isGoneError(err)) {
          scheduleRelist(err);
          return;
        }
        if (err) {
          scheduleReconnect(err);
          return;
        }
        scheduleReconnect(k8s.Watch.SERVER_SIDE_CLOSE, { markUnhealthy: false, attempts: 1 });
      }
    ).then((abort) => {
      handle.abort = abort;
      if (recoveryScheduled) {
        abort.abort();
        return;
      }
      if (!this.isCurrent(generation)) {
        abort.abort();
        return;
      }
      attempts = 0;
      this.store.markSynced('events', namespace);
    }).catch((err) => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      scheduleReconnect(err);
    });
  }

  private handleResourceWatchEvent(
    descriptor: ResourceDescriptor,
    generation: number,
    phase: string,
    obj: any,
    watchObj?: any
  ): WatchRecoveryAction {
    if (!this.isCurrent(generation)) return undefined;
    if (phase === 'BOOKMARK') {
      this.store.setResourceVersion(descriptor.kind, resourceVersionOf(obj));
      return undefined;
    }
    if (phase === 'ERROR') {
      if (isGoneError(undefined, watchObj || obj)) {
        return 'relist';
      }
      return 'reconnect';
    }
    if (phase === 'DELETED') {
      this.store.deleteResource(descriptor.kind, obj, resourceVersionOf(obj));
      this.scheduleSnapshotTrigger();
      return undefined;
    }
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      this.store.upsertResource(descriptor.kind, obj, resourceVersionOf(obj));
      this.scheduleSnapshotTrigger();
    }
    return undefined;
  }

  private handleEventWatchEvent(generation: number, phase: string, obj: any, watchObj?: any): WatchRecoveryAction {
    if (!this.isCurrent(generation)) return undefined;
    if (phase === 'BOOKMARK') {
      this.store.setResourceVersion('events', resourceVersionOf(obj));
      return undefined;
    }
    if (phase === 'ERROR') {
      if (isGoneError(undefined, watchObj || obj)) {
        return 'relist';
      }
      return 'reconnect';
    }
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      this.store.addEvent(obj, resourceVersionOf(obj));
      this.scheduleSnapshotTrigger();
      return undefined;
    }
    if (phase === 'DELETED') {
      this.store.deleteEvent(obj, resourceVersionOf(obj));
      this.scheduleSnapshotTrigger();
    }
    return undefined;
  }

  private async relistResourceScope(descriptor: ResourceDescriptor, generation: number, namespace?: string, attempts = 0): Promise<void> {
    try {
      this.store.markSyncing(descriptor.kind, namespace);
      if (namespace && descriptor.listNamespaced) {
        const result = await listAllPagesWithMetadata((options) => descriptor.listNamespaced!(namespace, options));
        if (!this.isCurrent(generation)) return;
        this.store.replaceResourceScope(descriptor.kind, namespace, result.items, result.resourceVersion);
        this.openResourceWatch(descriptor, generation, result.resourceVersion, namespace);
      } else {
        const result = await listAllPagesWithMetadata((options) => descriptor.listCluster(options));
        if (!this.isCurrent(generation)) return;
        this.store.replaceResourceKind(descriptor.kind, result.items, result.resourceVersion);
        this.openResourceWatch(descriptor, generation, result.resourceVersion);
      }
      this.scheduleSnapshotTrigger();
    } catch (err) {
      logger.warn({ err, kind: descriptor.kind, namespace }, 'Failed resource watch relist');
      this.store.markUnhealthy(descriptor.kind, err, namespace);
      this.scheduleResourceRelist(descriptor, generation, namespace, attempts + 1);
    }
  }

  private async relistEventScope(generation: number, namespace?: string, attempts = 0): Promise<void> {
    try {
      this.store.markSyncing('events', namespace);
      if (namespace) {
        const result = await listAllPagesWithMetadata((options) => k8sClient.core.listNamespacedEvent({
          ...options,
          namespace,
          fieldSelector: 'type=Warning'
        }));
        if (!this.isCurrent(generation)) return;
        this.store.replaceEventScope(namespace, result.items, result.resourceVersion);
        this.openEventWatch(generation, result.resourceVersion, namespace);
      } else {
        const result = await listAllPagesWithMetadata((options) => k8sClient.core.listEventForAllNamespaces({
          ...options,
          fieldSelector: 'type=Warning'
        }));
        if (!this.isCurrent(generation)) return;
        this.store.replaceEvents(result.items, result.resourceVersion);
        this.openEventWatch(generation, result.resourceVersion);
      }
      this.scheduleSnapshotTrigger();
    } catch (err) {
      logger.warn({ err, namespace }, 'Failed event watch relist');
      this.store.markUnhealthy('events', err, namespace);
      this.scheduleEventRelist(generation, namespace, attempts + 1);
    }
  }

  private scheduleResourceInitialSync(descriptor: ResourceDescriptor, generation: number, attempts = 1): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      void this.syncResourceDescriptor(descriptor, generation, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ kind: descriptor.kind, attempts, delayMs }, 'Scheduled resource watch initial sync retry');
  }

  private scheduleEventInitialSync(generation: number, attempts = 1): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor: 'events' };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      void this.syncEvents(generation, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ attempts, delayMs }, 'Scheduled event watch initial sync retry');
  }

  private scheduleEventRelist(generation: number, namespace?: string, attempts = 1): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor: 'events', namespace };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      void this.relistEventScope(generation, namespace, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ namespace, attempts, delayMs }, 'Scheduled event watch relist retry');
  }

  private scheduleResourceRelist(
    descriptor: ResourceDescriptor,
    generation: number,
    namespace?: string,
    attempts = 1
  ): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor, namespace };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      void this.relistResourceScope(descriptor, generation, namespace, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ kind: descriptor.kind, namespace, attempts, delayMs }, 'Scheduled resource watch relist retry');
  }

  private scheduleResourceReconnect(
    descriptor: ResourceDescriptor,
    generation: number,
    namespace?: string,
    resourceVersion?: string,
    attempts = 1
  ): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor, namespace };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      this.openResourceWatch(descriptor, generation, resourceVersion, namespace, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ kind: descriptor.kind, namespace, attempts, delayMs }, 'Scheduled resource watch reconnect');
  }

  private scheduleEventReconnect(generation: number, namespace?: string, resourceVersion?: string, attempts = 1): void {
    const delayMs = this.reconnectDelayMs(attempts);
    const handle: WatchHandle = { generation, attempts, descriptor: 'events', namespace };
    handle.reconnectTimer = setTimeout(() => {
      this.handles.delete(handle);
      if (!this.isCurrent(generation)) return;
      this.openEventWatch(generation, resourceVersion, namespace, attempts);
    }, delayMs);
    this.handles.add(handle);
    logger.warn({ namespace, attempts, delayMs }, 'Scheduled event watch reconnect');
  }

  private reconnectDelayMs(attempts: number): number {
    return Math.min(30000, 1000 * (2 ** Math.min(5, Math.max(0, attempts - 1))));
  }

  private scheduleSnapshotTrigger(): void {
    if (!this.active) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.active) this.onSignificantChange();
    }, config.ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS);
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}
