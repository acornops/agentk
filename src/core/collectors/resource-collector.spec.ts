import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ResourceCollector } from './resource-collector.js';
import { k8sClient } from '../../k8s/client.js';
import { setNamespaceScope } from '../../runtime/namespace-scope.js';
import { WatchStore, WATCH_RESOURCE_KINDS } from '../watch/watch-store.js';
import { config } from '../../config.js';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: {
      listPodForAllNamespaces: vi.fn(),
      listNamespacedPod: vi.fn(),
      listServiceForAllNamespaces: vi.fn(),
      listNamespacedService: vi.fn(),
      listPersistentVolumeClaimForAllNamespaces: vi.fn(),
      listNamespacedPersistentVolumeClaim: vi.fn(),
      listNode: vi.fn(),
      listNamespace: vi.fn(),
    },
    apps: {
      listDeploymentForAllNamespaces: vi.fn(),
      listNamespacedDeployment: vi.fn(),
      listStatefulSetForAllNamespaces: vi.fn(),
      listNamespacedStatefulSet: vi.fn(),
      listDaemonSetForAllNamespaces: vi.fn(),
      listNamespacedDaemonSet: vi.fn(),
    },
    batch: {
      listCronJobForAllNamespaces: vi.fn(),
      listNamespacedCronJob: vi.fn(),
      listJobForAllNamespaces: vi.fn(),
      listNamespacedJob: vi.fn(),
    },
    networking: {
      listIngressForAllNamespaces: vi.fn(),
      listNamespacedIngress: vi.fn(),
    },
    autoscaling: {
      listHorizontalPodAutoscalerForAllNamespaces: vi.fn(),
    }
  }
}));

describe('ResourceCollector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as any).ACORNOPS_AGENT_LOCAL_FALLBACK_ENABLED = false;
    setNamespaceScope({ include: [], exclude: [] });
  });

  it('should collect trimmed resources and nodes', async () => {
    const mockPods = {
      items: [{
        metadata: {
          name: 'pod1',
          namespace: 'default',
          uid: 'uid1',
          labels: { app: 'api' },
          ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-7d9', uid: 'rs1', controller: true }]
        },
        spec: { nodeName: 'node1' },
        status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true, restartCount: 0, state: { running: {} }, lastState: { terminated: { reason: 'Completed' } } }] }
      }]
    };
    const mockDeps = {
      items: [{
        metadata: { name: 'dep1', namespace: 'default', uid: 'uid2' },
        status: { replicas: 1, availableReplicas: 1, readyReplicas: 1 }
      }]
    };
    const mockStatefulSets = {
      items: [{
        metadata: { name: 'sts1', namespace: 'default', uid: 'uid7', creationTimestamp: '2026-05-09T00:03:00Z' },
        status: { replicas: 2, availableReplicas: 2, readyReplicas: 2 }
      }]
    };
    const mockDaemonSets = {
      items: [{
        metadata: { name: 'ds1', namespace: 'default', uid: 'uid8', creationTimestamp: '2026-05-09T00:04:00Z' },
        status: { desiredNumberScheduled: 3, numberAvailable: 2, numberReady: 2 }
      }]
    };
    const mockCronJobs = {
      items: [{
        metadata: { name: 'cron1', namespace: 'default', uid: 'uid9', creationTimestamp: '2026-05-09T00:05:00Z' },
        spec: { schedule: '*/5 * * * *', suspend: false },
        status: { active: [{ name: 'job1' }], lastScheduleTime: '2026-05-09T00:10:00Z' }
      }]
    };
    const mockJobs = {
      items: [{
        metadata: { name: 'job1', namespace: 'default', uid: 'uid10', creationTimestamp: '2026-05-09T00:06:00Z' },
        spec: { completions: 1 },
        status: { succeeded: 1, failed: 0, active: 0, startTime: '2026-05-09T00:06:00Z', completionTime: '2026-05-09T00:07:00Z' }
      }]
    };
    const mockSvc = {
      items: [{
        metadata: { name: 'svc1', namespace: 'default', uid: 'uid3', creationTimestamp: '2026-05-09T00:00:00Z' },
        spec: {
          type: 'ClusterIP',
          clusterIP: '10.0.0.1',
          selector: { app: 'web' },
          ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 8080 }]
        }
      }]
    };
    const mockIngress = {
      items: [{
        metadata: { name: 'ing1', namespace: 'default', uid: 'uid5', creationTimestamp: '2026-05-09T00:01:00Z' },
        spec: {
          ingressClassName: 'nginx',
          rules: [{
            host: 'app.example.com',
            http: {
              paths: [{
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'svc1', port: { number: 80 } } }
              }]
            }
          }],
          tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }]
        },
        status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } }
      }]
    };
    const mockPVC = {
      items: [{
        metadata: { name: 'data', namespace: 'default', uid: 'uid6', creationTimestamp: '2026-05-09T00:02:00Z' },
        spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'gp3', volumeName: 'pv-data', volumeMode: 'Filesystem' },
        status: { phase: 'Bound', capacity: { storage: '20Gi' } }
      }]
    };
    const mockNodes = {
      items: [{
        metadata: { name: 'node1', uid: 'uid4', labels: { 'node-role.kubernetes.io/worker': '' } },
        status: {
          nodeInfo: {
            kubeletVersion: 'v1.31.0',
            osImage: 'Ubuntu 24.04',
            containerRuntimeVersion: 'containerd://1.7.0',
            architecture: 'amd64',
            operatingSystem: 'linux'
          },
          capacity: { cpu: '4', memory: '16Gi' },
          allocatable: { cpu: '3900m', memory: '15Gi' },
          conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is ready' }]
        }
      }]
    };
    const mockNamespaces = {
      items: [{
        metadata: { name: 'default', uid: 'ns1', creationTimestamp: '2026-05-09T00:00:00Z', labels: { team: 'platform' } },
        status: { phase: 'Active' }
      }]
    };

    (k8sClient.core.listPodForAllNamespaces as any).mockResolvedValue(mockPods);
    (k8sClient.apps.listDeploymentForAllNamespaces as any).mockResolvedValue(mockDeps);
    (k8sClient.apps.listStatefulSetForAllNamespaces as any).mockResolvedValue(mockStatefulSets);
    (k8sClient.apps.listDaemonSetForAllNamespaces as any).mockResolvedValue(mockDaemonSets);
    (k8sClient.batch.listCronJobForAllNamespaces as any).mockResolvedValue(mockCronJobs);
    (k8sClient.batch.listJobForAllNamespaces as any).mockResolvedValue(mockJobs);
    (k8sClient.core.listServiceForAllNamespaces as any).mockResolvedValue(mockSvc);
    (k8sClient.networking.listIngressForAllNamespaces as any).mockResolvedValue(mockIngress);
    (k8sClient.core.listPersistentVolumeClaimForAllNamespaces as any).mockResolvedValue(mockPVC);
    (k8sClient.core.listNode as any).mockResolvedValue(mockNodes);
    (k8sClient.core.listNamespace as any).mockResolvedValue(mockNamespaces);

    const collector = new ResourceCollector();
    const result = await collector.collect();

    expect(result.pods).toHaveLength(1);
    expect(result.deployments).toHaveLength(1);
    expect(result.statefulSets).toHaveLength(1);
    expect(result.daemonSets).toHaveLength(1);
    expect(result.cronJobs).toHaveLength(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.services).toHaveLength(1);
    expect(result.ingresses).toHaveLength(1);
    expect(result.pvcs).toHaveLength(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.namespaces).toHaveLength(1);

    expect(result.pods[0]).toEqual({
      name: 'pod1',
      namespace: 'default',
      uid: 'uid1',
      labels: { app: 'api' },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-7d9', uid: 'rs1', controller: true, blockOwnerDeletion: undefined }],
      creationTimestamp: undefined,
      phase: 'Running',
      nodeName: 'node1',
      restartCount: 0,
      containerStatuses: [{ name: 'c1', ready: true, restartCount: 0, state: { running: {} }, lastState: { terminated: { reason: 'Completed' } } }]
    });

    expect(result.deployments[0]).toEqual({
      name: 'dep1',
      namespace: 'default',
      uid: 'uid2',
      creationTimestamp: undefined,
      replicas: 1,
      availableReplicas: 1,
      readyReplicas: 1
    });

    expect(result.statefulSets[0]).toEqual({
      name: 'sts1',
      namespace: 'default',
      uid: 'uid7',
      creationTimestamp: '2026-05-09T00:03:00Z',
      replicas: 2,
      availableReplicas: 2,
      readyReplicas: 2
    });

    expect(result.daemonSets[0]).toEqual({
      name: 'ds1',
      namespace: 'default',
      uid: 'uid8',
      creationTimestamp: '2026-05-09T00:04:00Z',
      replicas: 3,
      availableReplicas: 2,
      readyReplicas: 2
    });

    expect(result.cronJobs[0]).toEqual({
      name: 'cron1',
      namespace: 'default',
      uid: 'uid9',
      creationTimestamp: '2026-05-09T00:05:00Z',
      schedule: '*/5 * * * *',
      suspend: false,
      active: 1,
      lastScheduleTime: '2026-05-09T00:10:00Z'
    });

    expect(result.jobs[0]).toEqual({
      name: 'job1',
      namespace: 'default',
      uid: 'uid10',
      creationTimestamp: '2026-05-09T00:06:00Z',
      completions: 1,
      succeeded: 1,
      failed: 0,
      active: 0,
      startTime: '2026-05-09T00:06:00Z',
      completionTime: '2026-05-09T00:07:00Z'
    });

    expect(result.services[0]).toEqual({
      name: 'svc1',
      namespace: 'default',
      uid: 'uid3',
      creationTimestamp: '2026-05-09T00:00:00Z',
      type: 'ClusterIP',
      clusterIP: '10.0.0.1',
      selector: { app: 'web' },
      externalIPs: [],
      loadBalancerIP: undefined,
      ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 8080, nodePort: undefined }]
    });

    expect(result.ingresses[0]).toEqual({
      name: 'ing1',
      namespace: 'default',
      uid: 'uid5',
      creationTimestamp: '2026-05-09T00:01:00Z',
      ingressClassName: 'nginx',
      hosts: ['app.example.com'],
      address: 'lb.example.com',
      rules: [{
        host: 'app.example.com',
        paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc1', servicePort: 80 }]
      }],
      tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }]
    });

    expect(result.pvcs[0]).toEqual({
      name: 'data',
      namespace: 'default',
      uid: 'uid6',
      creationTimestamp: '2026-05-09T00:02:00Z',
      status: 'Bound',
      capacity: '20Gi',
      accessModes: ['ReadWriteOnce'],
      storageClass: 'gp3',
      volumeName: 'pv-data',
      volumeMode: 'Filesystem'
    });

    expect(result.nodes[0]).toEqual({
      name: 'node1',
      uid: 'uid4',
      labels: { 'node-role.kubernetes.io/worker': '' },
      kubeletVersion: 'v1.31.0',
      osImage: 'Ubuntu 24.04',
      containerRuntimeVersion: 'containerd://1.7.0',
      architecture: 'amd64',
      operatingSystem: 'linux',
      capacity: { cpu: '4', memory: '16Gi' },
      allocatable: { cpu: '3900m', memory: '15Gi' },
      status: {
        conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is ready' }]
      }
    });

    expect(result.namespaces[0]).toEqual({
      name: 'default',
      uid: 'ns1',
      creationTimestamp: '2026-05-09T00:00:00Z',
      labels: { team: 'platform' },
      status: 'Active'
    });

    expect(result.hpas).toBeUndefined();
  });

  it('collects all configured namespaces through paginated namespaced calls', async () => {
    setNamespaceScope({ include: ['default', 'payments'], exclude: [] });
    const empty = { items: [] };

    (k8sClient.core.listNamespacedPod as any).mockImplementation(({ namespace }: { namespace: string }) => ({
      items: [{ metadata: { name: `${namespace}-pod`, namespace } }]
    }));
    (k8sClient.apps.listNamespacedDeployment as any).mockResolvedValue(empty);
    (k8sClient.apps.listNamespacedStatefulSet as any).mockResolvedValue(empty);
    (k8sClient.apps.listNamespacedDaemonSet as any).mockResolvedValue(empty);
    (k8sClient.batch.listNamespacedCronJob as any).mockResolvedValue(empty);
    (k8sClient.batch.listNamespacedJob as any).mockResolvedValue(empty);
    (k8sClient.core.listNamespacedService as any).mockResolvedValue(empty);
    (k8sClient.networking.listNamespacedIngress as any).mockResolvedValue(empty);
    (k8sClient.core.listNamespacedPersistentVolumeClaim as any).mockResolvedValue(empty);
    (k8sClient.core.listNode as any).mockResolvedValue(empty);
    (k8sClient.core.listNamespace as any).mockResolvedValue({
      items: [
        { metadata: { name: 'default' } },
        { metadata: { name: 'payments' } },
        { metadata: { name: 'other' } },
      ],
    });

    const result = await new ResourceCollector().collect();

    expect(result.pods.map((pod: any) => pod.name)).toEqual(['default-pod', 'payments-pod']);
    expect(result.namespaces.map((namespace: any) => namespace.name)).toEqual(['default', 'payments']);
    expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'default',
      limit: 500,
      _continue: undefined,
    });
    expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'payments',
      limit: 500,
      _continue: undefined,
    });
  });

  it('builds the same snapshot shape from a ready watch cache without listing', async () => {
    const store = new WatchStore();
    for (const kind of WATCH_RESOURCE_KINDS) {
      store.replaceResourceKind(kind, [], '1');
    }
    store.replaceResourceKind('pods', [{
      metadata: {
        name: 'pod1',
        namespace: 'default',
        uid: 'uid1',
        labels: { app: 'api' },
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-7d9', uid: 'rs1', controller: true }]
      },
      spec: { nodeName: 'node1' },
      status: { phase: 'Running', containerStatuses: [{ name: 'c1', ready: true, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: {} }] }
    }], '2');
    store.replaceResourceKind('nodes', [{
      metadata: { name: 'node1', uid: 'node-1', labels: { role: 'worker' } },
      status: { nodeInfo: { kubeletVersion: 'v1.31.0' }, conditions: [{ type: 'Ready', status: 'True' }] }
    }], '2');
    store.replaceResourceKind('namespaces', [{ metadata: { name: 'default', uid: 'ns-1' }, status: { phase: 'Active' } }], '2');

    const result = await new ResourceCollector(store).collect();

    expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();
    expect(result.pods).toEqual([{
      name: 'pod1',
      namespace: 'default',
      uid: 'uid1',
      labels: { app: 'api' },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-7d9', uid: 'rs1', controller: true, blockOwnerDeletion: undefined }],
      creationTimestamp: undefined,
      phase: 'Running',
      nodeName: 'node1',
      restartCount: 2,
      containerStatuses: [{ name: 'c1', ready: true, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: {} }]
    }]);
    expect(result.nodes[0].name).toBe('node1');
    expect(result.namespaces[0].name).toBe('default');
  });

  it('waits for a warming watch cache before using list fallback', async () => {
    vi.useFakeTimers();
    try {
      const store = new WatchStore();
      for (const kind of WATCH_RESOURCE_KINDS) {
        store.markSyncing(kind);
      }

      const collect = new ResourceCollector(store).collect();
      await Promise.resolve();
      expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();

      for (const kind of WATCH_RESOURCE_KINDS) {
        store.replaceResourceKind(kind, [], '1');
      }
      store.replaceResourceKind('pods', [{
        metadata: { name: 'cached-pod', namespace: 'default' },
        status: { phase: 'Running' },
      }], '2');
      await vi.advanceTimersByTimeAsync(100);

      const result = await collect;
      expect(result.pods.map((pod: any) => pod.name)).toEqual(['cached-pod']);
      expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the local fallback node when a ready watch cache has no nodes in local mode', async () => {
    (config as any).ACORNOPS_AGENT_LOCAL_FALLBACK_ENABLED = true;
    const store = new WatchStore();
    for (const kind of WATCH_RESOURCE_KINDS) {
      store.replaceResourceKind(kind, [], '1');
    }

    const result = await new ResourceCollector(store).collect();

    expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();
    expect(result.nodes).toEqual([expect.objectContaining({
      uid: 'local-fallback-node',
      kubeletVersion: 'local-dev',
    })]);
  });

  it('falls back to list collection while the watch cache is not fully synced', async () => {
    const store = new WatchStore();
    store.replaceResourceKind('pods', [{ metadata: { name: 'cached-pod', namespace: 'default' } }], '1');
    const empty = { items: [] };
    (k8sClient.core.listPodForAllNamespaces as any).mockResolvedValue({ items: [{ metadata: { name: 'listed-pod', namespace: 'default' } }] });
    (k8sClient.apps.listDeploymentForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.apps.listStatefulSetForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.apps.listDaemonSetForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.batch.listCronJobForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.batch.listJobForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.core.listServiceForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.networking.listIngressForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.core.listPersistentVolumeClaimForAllNamespaces as any).mockResolvedValue(empty);
    (k8sClient.core.listNode as any).mockResolvedValue(empty);
    (k8sClient.core.listNamespace as any).mockResolvedValue(empty);

    const result = await new ResourceCollector(store).collect();

    expect(result.pods.map((pod: any) => pod.name)).toEqual(['listed-pod']);
    expect(k8sClient.core.listPodForAllNamespaces).toHaveBeenCalledTimes(1);
  });
});
