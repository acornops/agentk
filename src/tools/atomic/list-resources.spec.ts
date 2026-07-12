import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: {
      listNamespacedPod: vi.fn(),
      listPodForAllNamespaces: vi.fn(),
      listNamespacedService: vi.fn(),
      listServiceForAllNamespaces: vi.fn(),
      listNamespacedPersistentVolumeClaim: vi.fn(),
      listPersistentVolumeClaimForAllNamespaces: vi.fn(),
      listNamespace: vi.fn(),
      listNode: vi.fn(),
      listNamespacedEvent: vi.fn(),
      listEventForAllNamespaces: vi.fn(),
    },
    apps: {
      listNamespacedDeployment: vi.fn(),
      listDeploymentForAllNamespaces: vi.fn(),
      listNamespacedStatefulSet: vi.fn(),
      listStatefulSetForAllNamespaces: vi.fn(),
      listNamespacedDaemonSet: vi.fn(),
      listDaemonSetForAllNamespaces: vi.fn(),
    },
    batch: {
      listNamespacedCronJob: vi.fn(),
      listCronJobForAllNamespaces: vi.fn(),
      listNamespacedJob: vi.fn(),
      listJobForAllNamespaces: vi.fn(),
    },
    networking: {
      listNamespacedIngress: vi.fn(),
      listIngressForAllNamespaces: vi.fn(),
    },
    autoscaling: {
      listNamespacedHorizontalPodAutoscaler: vi.fn(),
      listHorizontalPodAutoscalerForAllNamespaces: vi.fn(),
    },
  },
}));

import { k8sClient } from '../../k8s/client.js';
import { listResourcesTool } from './list-resources.js';
import { setNamespaceScope } from '../../runtime/namespace-scope.js';

describe('listResourcesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setNamespaceScope({ include: [], exclude: [] });
  });

  it('lists namespaced pods and returns summarized pod data', async () => {
    vi.mocked(k8sClient.core.listNamespacedPod).mockResolvedValue({
      metadata: { _continue: 'next-page' },
      items: [
        {
          metadata: {
            name: 'api-0',
            namespace: 'default',
            uid: 'pod-uid',
            creationTimestamp: '2024-01-01T00:00:00Z',
          },
          spec: { nodeName: 'worker-a' },
          status: {
            phase: 'Running',
            containerStatuses: [{ restartCount: 1 }, { restartCount: 2 }],
          },
        },
      ],
    } as never);

    await expect(
      listResourcesTool.handler({
        kind: 'Pod',
        namespace: 'default',
        label_selector: 'app=api',
        field_selector: 'status.phase=Running',
        limit: 50,
        continue_token: 'cursor-1',
      })
    ).resolves.toEqual({
      kind: 'Pod',
      namespace: 'default',
      total: 1,
      continue_token: 'next-page',
      items: [
        {
          name: 'api-0',
          namespace: 'default',
          uid: 'pod-uid',
          createdAt: '2024-01-01T00:00:00Z',
          phase: 'Running',
          nodeName: 'worker-a',
          restartCount: 3,
        },
      ],
    });

    expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'default',
      labelSelector: 'app=api',
      fieldSelector: 'status.phase=Running',
      limit: 50,
      _continue: 'cursor-1',
    });
  });

  it('fans out an omitted namespace only across the effective include-list', async () => {
    setNamespaceScope({ include: ['team-b', 'team-a'], exclude: [] });
    vi.mocked(k8sClient.core.listNamespacedPod)
      .mockResolvedValueOnce({ metadata: {}, items: [{ metadata: { name: 'a', namespace: 'team-a' }, status: {} }] } as never)
      .mockResolvedValueOnce({ metadata: {}, items: [{ metadata: { name: 'b', namespace: 'team-b' }, status: {} }] } as never);

    const result = await listResourcesTool.handler({ kind: 'Pod', limit: 100 });

    expect(result.items.map((item: any) => item.namespace)).toEqual(['team-a', 'team-b']);
    expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();
    expect(k8sClient.core.listNamespacedPod).toHaveBeenNthCalledWith(1, expect.objectContaining({ namespace: 'team-a' }));
    expect(k8sClient.core.listNamespacedPod).toHaveBeenNthCalledWith(2, expect.objectContaining({ namespace: 'team-b' }));
  });

  it('continues scoped pagination only in the namespace encoded by the cursor', async () => {
    setNamespaceScope({ include: ['team-a', 'team-b'], exclude: [] });
    vi.mocked(k8sClient.core.listNamespacedPod)
      .mockResolvedValueOnce({
        metadata: { _continue: 'kube-page-2' },
        items: [{ metadata: { name: 'a-1', namespace: 'team-a' }, status: {} }],
      } as never)
      .mockResolvedValueOnce({
        metadata: {},
        items: [{ metadata: { name: 'a-2', namespace: 'team-a' }, status: {} }],
      } as never);

    const first = await listResourcesTool.handler({ kind: 'Pod', limit: 1 }) as any;
    const second = await listResourcesTool.handler({
      kind: 'Pod', limit: 1, continue_token: first.continue_token,
    }) as any;

    expect(first.items[0].name).toBe('a-1');
    expect(second.items[0].name).toBe('a-2');
    expect(k8sClient.core.listNamespacedPod).toHaveBeenNthCalledWith(2, expect.objectContaining({
      namespace: 'team-a',
      _continue: 'kube-page-2',
    }));
  });

  it('rejects a scoped cursor after policy changes its namespace position', async () => {
    setNamespaceScope({ include: ['team-a', 'team-b'], exclude: [] });
    vi.mocked(k8sClient.core.listNamespacedPod).mockResolvedValueOnce({
      metadata: { _continue: 'kube-page-2' },
      items: [{ metadata: { name: 'a-1', namespace: 'team-a' }, status: {} }],
    } as never);
    const first = await listResourcesTool.handler({ kind: 'Pod', limit: 1 }) as any;

    await expect(listResourcesTool.handler({
      kind: 'Pod', limit: 1, label_selector: 'app=changed', continue_token: first.continue_token,
    })).rejects.toMatchObject({ toolCode: 'INVALID_ARGUMENTS' });
    setNamespaceScope({ include: ['team-b'], exclude: [] });
    await expect(listResourcesTool.handler({
      kind: 'Pod', limit: 1, continue_token: first.continue_token,
    })).rejects.toMatchObject({ toolCode: 'INVALID_ARGUMENTS' });
    expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it('lists deployments across all namespaces and summarizes replica status', async () => {
    vi.mocked(k8sClient.apps.listDeploymentForAllNamespaces).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: {
            name: 'api',
            namespace: 'prod',
            uid: 'deploy-uid',
            creationTimestamp: '2024-01-02T00:00:00Z',
          },
          spec: { replicas: 3 },
          status: { readyReplicas: 2, availableReplicas: 2 },
        },
      ],
    } as never);

    await expect(
      listResourcesTool.handler({
        kind: 'Deployment',
        limit: 100,
      })
    ).resolves.toEqual({
      kind: 'Deployment',
      namespace: '*',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'api',
          namespace: 'prod',
          uid: 'deploy-uid',
          createdAt: '2024-01-02T00:00:00Z',
          replicas: 3,
          readyReplicas: 2,
          availableReplicas: 2,
        },
      ],
    });

    expect(k8sClient.apps.listDeploymentForAllNamespaces).toHaveBeenCalledWith({
      labelSelector: undefined,
      fieldSelector: undefined,
      limit: 100,
      _continue: undefined,
    });
  });

  it('lists cronjobs in a namespace and summarizes schedule activity', async () => {
    vi.mocked(k8sClient.batch.listNamespacedCronJob).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'nightly', namespace: 'ops', uid: 'cron-uid' },
          spec: { schedule: '0 0 * * *', suspend: true },
          status: {
            active: [{ name: 'nightly-123' }],
            lastScheduleTime: '2024-01-03T00:00:00Z',
          },
        },
      ],
    } as never);

    await expect(
      listResourcesTool.handler({
        kind: 'CronJob',
        namespace: 'ops',
        limit: 25,
      })
    ).resolves.toEqual({
      kind: 'CronJob',
      namespace: 'ops',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'nightly',
          namespace: 'ops',
          uid: 'cron-uid',
          createdAt: undefined,
          schedule: '0 0 * * *',
          suspend: true,
          active: 1,
          lastScheduleTime: '2024-01-03T00:00:00Z',
        },
      ],
    });
  });

  it('lists jobs across all namespaces and summarizes completion state', async () => {
    vi.mocked(k8sClient.batch.listJobForAllNamespaces).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'migration', namespace: 'ops', uid: 'job-uid' },
          spec: { completions: 2 },
          status: {
            succeeded: 1,
            failed: 0,
            active: 1,
            startTime: '2024-01-03T00:00:00Z',
            completionTime: '2024-01-03T00:01:00Z',
          },
        },
      ],
    } as never);

    await expect(listResourcesTool.handler({ kind: 'Job', limit: 100 })).resolves.toEqual({
      kind: 'Job',
      namespace: '*',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'migration',
          namespace: 'ops',
          uid: 'job-uid',
          createdAt: undefined,
          completions: 2,
          succeeded: 1,
          failed: 0,
          active: 1,
          startTime: '2024-01-03T00:00:00Z',
          completionTime: '2024-01-03T00:01:00Z',
        },
      ],
    });
  });

  it('lists services in a namespace and summarizes network fields', async () => {
    vi.mocked(k8sClient.core.listNamespacedService).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'api', namespace: 'default', uid: 'svc-uid' },
          spec: { type: 'LoadBalancer', clusterIP: '10.0.0.10' },
        },
      ],
    } as never);

    await expect(
      listResourcesTool.handler({
        kind: 'Service',
        namespace: 'default',
        limit: 10,
      })
    ).resolves.toEqual({
      kind: 'Service',
      namespace: 'default',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'api',
          namespace: 'default',
          uid: 'svc-uid',
          createdAt: undefined,
          type: 'LoadBalancer',
          clusterIP: '10.0.0.10',
        },
      ],
    });
  });

  it('lists and summarizes Ingress, PVC, and HPA resources', async () => {
    vi.mocked(k8sClient.networking.listNamespacedIngress).mockResolvedValue({
      metadata: {}, items: [{ metadata: { name: 'web', namespace: 'default' }, spec: { ingressClassName: 'nginx', rules: [{ host: 'app.example.com' }] } }],
    } as never);
    vi.mocked(k8sClient.core.listNamespacedPersistentVolumeClaim).mockResolvedValue({
      metadata: {}, items: [{ metadata: { name: 'data', namespace: 'default' }, spec: { storageClassName: 'fast' }, status: { phase: 'Bound', capacity: { storage: '10Gi' } } }],
    } as never);
    vi.mocked(k8sClient.autoscaling.listNamespacedHorizontalPodAutoscaler).mockResolvedValue({
      metadata: {}, items: [{ metadata: { name: 'api', namespace: 'default' }, spec: { minReplicas: 2, maxReplicas: 10, scaleTargetRef: { kind: 'Deployment', name: 'api' } }, status: { currentReplicas: 3, desiredReplicas: 4 } }],
    } as never);

    await expect(listResourcesTool.handler({ kind: 'Ingress', namespace: 'default', limit: 100 })).resolves.toMatchObject({
      items: [{ name: 'web', hosts: ['app.example.com'], ingressClassName: 'nginx' }],
    });
    await expect(listResourcesTool.handler({ kind: 'PVC', namespace: 'default', limit: 100 })).resolves.toMatchObject({
      items: [{ name: 'data', phase: 'Bound', capacity: '10Gi', storageClassName: 'fast' }],
    });
    await expect(listResourcesTool.handler({ kind: 'HPA', namespace: 'default', limit: 100 })).resolves.toMatchObject({
      items: [{ name: 'api', minReplicas: 2, maxReplicas: 10, currentReplicas: 3, desiredReplicas: 4, targetKind: 'Deployment', targetName: 'api' }],
    });
  });

  it('lists namespaces through the cluster-scoped namespace api', async () => {
    vi.mocked(k8sClient.core.listNamespace).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'default', uid: 'ns-uid', creationTimestamp: '2024-01-01T00:00:00Z' },
        },
      ],
    } as never);

    await expect(listResourcesTool.handler({ kind: 'Namespace', limit: 100 })).resolves.toEqual({
      kind: 'Namespace',
      namespace: '*',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'default',
          namespace: undefined,
          uid: 'ns-uid',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
  });

  it('lists nodes through the cluster-scoped node api', async () => {
    vi.mocked(k8sClient.core.listNode).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'worker-a', uid: 'node-uid' },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    } as never);

    await expect(listResourcesTool.handler({ kind: 'Node', limit: 100 })).resolves.toEqual({
      kind: 'Node',
      namespace: '*',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'worker-a',
          namespace: undefined,
          uid: 'node-uid',
          createdAt: undefined,
          phase: 'Ready',
        },
      ],
    });
  });

  it('lists events across all namespaces and summarizes reason and message', async () => {
    vi.mocked(k8sClient.core.listEventForAllNamespaces).mockResolvedValue({
      metadata: {},
      items: [
        {
          metadata: { name: 'pod.123', namespace: 'default', uid: 'event-uid' },
          reason: 'BackOff',
          type: 'Warning',
          message: 'Back-off restarting failed container',
        },
      ],
    } as never);

    await expect(listResourcesTool.handler({ kind: 'Event', limit: 100 })).resolves.toEqual({
      kind: 'Event',
      namespace: '*',
      total: 1,
      continue_token: '',
      items: [
        {
          name: 'pod.123',
          namespace: 'default',
          uid: 'event-uid',
          createdAt: undefined,
          reason: 'BackOff',
          type: 'Warning',
          message: 'Back-off restarting failed container',
        },
      ],
    });
  });
});
