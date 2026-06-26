import os from 'node:os';
import pino from 'pino';
import { k8sClient } from '../../k8s/client.js';
import { ListPageOptions, listAllPages } from '../../k8s/pagination.js';
import { Collector } from '../../types/collector.js';
import { config } from '../../config.js';
import { filterNamespaceItems, getWatchNamespaces, isNamespaceAllowed } from '../../runtime/namespace-scope.js';
import { WatchResourceSnapshot, WatchStore } from '../watch/watch-store.js';
import {
  mapCronJob,
  mapDaemonSet,
  mapDeployment,
  mapIngress,
  mapJob,
  mapNamespace,
  mapNode,
  mapPod,
  mapPvc,
  mapService,
  mapStatefulSet,
} from './resource-mappers.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'resource-collector' });
const WATCH_CACHE_POLL_MS = 100;

/** Wait for a short polling interval while a watch cache is warming. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collector responsible for fetching standard Kubernetes resources.
 */
export class ResourceCollector implements Collector {
  public name = 'resources';

  /** Initialize the collector with an optional watch-backed cache. */
  constructor(private readonly watchStore?: WatchStore) {}

  /** Collect the Kubernetes resource snapshot for watched namespaces. */
  public async collect(): Promise<any> {
    const cached = await this.collectFromWatchStore();
    if (cached) return cached;

    const namespaces = getWatchNamespaces();

    const [pods, deployments, statefulSets, daemonSets, cronJobs, jobs, services, ingresses, pvcs, nodes, namespaceItems] = await Promise.all([
      this.getPods(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect pods');
        return [];
      }),
      this.getDeployments(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect deployments');
        return [];
      }),
      this.getStatefulSets(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect stateful sets');
        return [];
      }),
      this.getDaemonSets(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect daemon sets');
        return [];
      }),
      this.getCronJobs(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect cron jobs');
        return [];
      }),
      this.getJobs(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect jobs');
        return [];
      }),
      this.getServices(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect services');
        return [];
      }),
      this.getIngresses(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect ingresses');
        return [];
      }),
      this.getPVCs(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect PVCs');
        return [];
      }),
      this.getNodes().catch((err) => {
        logger.warn({ err }, 'Failed to collect nodes');
        return [];
      }),
      this.getNamespaces(namespaces).catch((err) => {
        logger.warn({ err }, 'Failed to collect namespaces');
        return [];
      }),
    ]);

    return {
      pods,
      deployments,
      statefulSets,
      daemonSets,
      cronJobs,
      jobs,
      services,
      ingresses,
      pvcs,
      nodes: this.withSafeNodes(nodes),
      namespaces: namespaceItems,
    };
  }

  private async collectFromWatchStore(): Promise<any | null> {
    if (!config.ACORNOPS_AGENT_WATCH_CACHE_ENABLED || !this.watchStore) return null;
    let snapshot = this.watchStore.getResourceSnapshot();
    if (!snapshot && this.watchStore.resourcesWarming()) {
      snapshot = await this.waitForWatchSnapshot();
    }
    if (!snapshot) return null;
    return this.mapWatchSnapshot(snapshot);
  }

  private async waitForWatchSnapshot(): Promise<WatchResourceSnapshot | null> {
    const deadline = Date.now() + config.ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS;
    while (Date.now() < deadline && this.watchStore?.resourcesWarming()) {
      const snapshot = this.watchStore.getResourceSnapshot();
      if (snapshot) return snapshot;
      await sleep(Math.min(WATCH_CACHE_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    return this.watchStore?.getResourceSnapshot() || null;
  }

  private mapWatchSnapshot(snapshot: WatchResourceSnapshot): any {
    return {
      pods: snapshot.pods.map(mapPod),
      deployments: snapshot.deployments.map(mapDeployment),
      statefulSets: snapshot.statefulSets.map(mapStatefulSet),
      daemonSets: snapshot.daemonSets.map(mapDaemonSet),
      cronJobs: snapshot.cronJobs.map(mapCronJob),
      jobs: snapshot.jobs.map(mapJob),
      services: snapshot.services.map(mapService),
      ingresses: snapshot.ingresses.map(mapIngress),
      pvcs: snapshot.pvcs.map(mapPvc),
      nodes: this.withSafeNodes(snapshot.nodes.map(mapNode)),
      namespaces: snapshot.namespaces
        .filter(ns => this.isNamespaceInScope(ns.metadata?.name || '', getWatchNamespaces()))
        .map(mapNamespace),
    };
  }

  /** Return collected nodes or the local fallback node when local mode requires one. */
  private withSafeNodes(nodes: any[]): any[] {
    if (nodes.length || !config.ACORNOPS_AGENT_LOCAL_FALLBACK_ENABLED) return nodes;
    return [
      {
        name: os.hostname(),
        uid: 'local-fallback-node',
        labels: {
          'node-role.kubernetes.io/worker': ''
        },
        kubeletVersion: 'local-dev',
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'LocalFallback',
              message: 'No Kubernetes API connection available in local mode.'
            }
          ]
        }
      }
    ];
  }

  private isNamespaceInScope(namespace: string, namespaces?: string[]): boolean {
    if (namespaces) {
      return namespaces.includes(namespace);
    }
    return isNamespaceAllowed(namespace);
  }

  private async listNamespacedItems(
    namespaces: string[],
    fetchPage: (namespace: string, options: ListPageOptions) => Promise<any>
  ): Promise<any[]> {
    const results = await Promise.all(
      namespaces.map((namespace) => listAllPages((options) => fetchPage(namespace, options)))
    );
    return results.flat();
  }

  private async listClusterItems(fetchPage: (options: ListPageOptions) => Promise<any>): Promise<any[]> {
    return listAllPages((options) => fetchPage(options));
  }

  private async getPods(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.core.listNamespacedPod({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.core.listPodForAllNamespaces(options));
      items = filterNamespaceItems(res, (p) => p.metadata?.namespace);
    }

    return items.map(mapPod);
  }

  private async getDeployments(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.apps.listNamespacedDeployment({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.apps.listDeploymentForAllNamespaces(options));
      items = filterNamespaceItems(res, (d) => d.metadata?.namespace);
    }

    return items.map(mapDeployment);
  }

  private async getStatefulSets(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.apps.listNamespacedStatefulSet({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.apps.listStatefulSetForAllNamespaces(options));
      items = filterNamespaceItems(res, (s) => s.metadata?.namespace);
    }

    return items.map(mapStatefulSet);
  }

  private async getDaemonSets(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.apps.listNamespacedDaemonSet({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.apps.listDaemonSetForAllNamespaces(options));
      items = filterNamespaceItems(res, (d) => d.metadata?.namespace);
    }

    return items.map(mapDaemonSet);
  }

  private async getCronJobs(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.batch.listNamespacedCronJob({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.batch.listCronJobForAllNamespaces(options));
      items = filterNamespaceItems(res, (c) => c.metadata?.namespace);
    }

    return items.map(mapCronJob);
  }

  private async getJobs(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.batch.listNamespacedJob({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.batch.listJobForAllNamespaces(options));
      items = filterNamespaceItems(res, (j) => j.metadata?.namespace);
    }

    return items.map(mapJob);
  }

  private async getServices(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.core.listNamespacedService({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.core.listServiceForAllNamespaces(options));
      items = filterNamespaceItems(res, (s) => s.metadata?.namespace);
    }

    return items.map(mapService);
  }

  private async getIngresses(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.networking.listNamespacedIngress({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.networking.listIngressForAllNamespaces(options));
      items = filterNamespaceItems(res, (i) => i.metadata?.namespace);
    }

    return items.map(mapIngress);
  }

  private async getPVCs(namespaces?: string[]) {
    let items;
    if (namespaces) {
      items = await this.listNamespacedItems(
        namespaces,
        (namespace, options) => k8sClient.core.listNamespacedPersistentVolumeClaim({ namespace, ...options })
      );
    } else {
      const res = await this.listClusterItems((options) => k8sClient.core.listPersistentVolumeClaimForAllNamespaces(options));
      items = filterNamespaceItems(res, (pvc) => pvc.metadata?.namespace);
    }

    return items.map(mapPvc);
  }

  private async getNodes() {
    const items = await this.listClusterItems((options) => k8sClient.core.listNode(options));
    return items.map(mapNode);
  }

  private async getNamespaces(namespaces?: string[]) {
    const items = await this.listClusterItems((options) => k8sClient.core.listNamespace(options));
    return items
      .filter(ns => this.isNamespaceInScope(ns.metadata?.name || '', namespaces))
      .map(mapNamespace);
  }
}
