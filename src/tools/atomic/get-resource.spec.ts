import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: {
      readNamespacedPod: vi.fn(),
      readNamespacedService: vi.fn(),
      readNamespacedPersistentVolumeClaim: vi.fn(),
      readNode: vi.fn(),
      readNamespacedEvent: vi.fn(),
      readNamespace: vi.fn(),
    },
    apps: {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
    },
    batch: {
      readNamespacedCronJob: vi.fn(),
      readNamespacedJob: vi.fn(),
    },
    autoscaling: {
      readNamespacedHorizontalPodAutoscaler: vi.fn(),
    },
    networking: {
      readNamespacedIngress: vi.fn(),
    },
  },
}));

import { k8sClient } from '../../k8s/client.js';
import { setNamespaceScope } from '../../runtime/namespace-scope.js';
import { getResourceTool } from './get-resource.js';

describe('getResourceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNamespaceScope({ include: [], exclude: [] });
  });

  afterEach(() => {
    setNamespaceScope({ include: [], exclude: [] });
  });

  it.each([
    ['Pod', vi.mocked(k8sClient.core.readNamespacedPod), { name: 'api', namespace: 'default' }],
    ['Deployment', vi.mocked(k8sClient.apps.readNamespacedDeployment), { name: 'api', namespace: 'default' }],
    ['StatefulSet', vi.mocked(k8sClient.apps.readNamespacedStatefulSet), { name: 'api', namespace: 'default' }],
    ['DaemonSet', vi.mocked(k8sClient.apps.readNamespacedDaemonSet), { name: 'api', namespace: 'default' }],
    ['CronJob', vi.mocked(k8sClient.batch.readNamespacedCronJob), { name: 'api', namespace: 'default' }],
    ['Job', vi.mocked(k8sClient.batch.readNamespacedJob), { name: 'api', namespace: 'default' }],
    ['Service', vi.mocked(k8sClient.core.readNamespacedService), { name: 'api', namespace: 'default' }],
    ['Ingress', vi.mocked(k8sClient.networking.readNamespacedIngress), { name: 'api', namespace: 'default' }],
    ['PVC', vi.mocked(k8sClient.core.readNamespacedPersistentVolumeClaim), { name: 'api', namespace: 'default' }],
    ['HPA', vi.mocked(k8sClient.autoscaling.readNamespacedHorizontalPodAutoscaler), { name: 'api', namespace: 'default' }],
    ['Event', vi.mocked(k8sClient.core.readNamespacedEvent), { name: 'api', namespace: 'default' }],
  ])('reads %s resources through the matching namespaced API', async (kind, method, expectedArgs) => {
    const resource = { metadata: { name: 'api', namespace: 'default', kind } };
    method.mockResolvedValue(resource as never);

    await expect(
      getResourceTool.handler({
        kind: kind as 'Pod',
        name: 'api',
        namespace: 'default',
      }),
    ).resolves.toEqual(resource);

    expect(method).toHaveBeenCalledWith(expectedArgs);
  });

  it('reads cluster-scoped nodes and namespaces without requiring a namespace', async () => {
    const node = { metadata: { name: 'worker-1' } };
    const namespace = { metadata: { name: 'payments' } };
    vi.mocked(k8sClient.core.readNode).mockResolvedValue(node as never);
    vi.mocked(k8sClient.core.readNamespace).mockResolvedValue(namespace as never);

    await expect(
      getResourceTool.handler({
        kind: 'Node',
        name: 'worker-1',
      })
    ).resolves.toEqual(node);

    expect(k8sClient.core.readNode).toHaveBeenCalledWith({ name: 'worker-1' });

    await expect(
      getResourceTool.handler({
        kind: 'Namespace',
        name: 'payments',
      }),
    ).resolves.toEqual(namespace);

    expect(k8sClient.core.readNamespace).toHaveBeenCalledWith({ name: 'payments' });
  });

  it('redacts sensitive data from returned Kubernetes objects', async () => {
    const pod = {
      metadata: {
        name: 'api',
        namespace: 'default',
        labels: {
          app: 'api',
          'acornops.io/token': 'label-token',
        },
        annotations: {
          owner: 'platform',
          'checksum/secret': 'annotation-secret',
        },
        managedFields: [{ manager: 'kube-controller-manager' }],
      },
      spec: {
        containers: [
          {
            name: 'api',
            image: 'registry.example.com/api:v1',
            command: ['/bin/sh', '-c'],
            args: ['echo token-value'],
            env: [
              { name: 'DATABASE_PASSWORD', value: 'plain-env-secret' },
              { name: 'API_URL', value: 'https://api.example.com' },
              {
                name: 'FROM_SECRET',
                valueFrom: {
                  secretKeyRef: {
                    name: 'database-credentials',
                    key: 'password',
                  },
                },
              },
            ],
          },
        ],
        imagePullSecrets: [{ name: 'pull-secret' }],
        volumes: [{ name: 'db', secret: { secretName: 'database-credentials' } }],
      },
    };
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue(pod as never);

    const result = await getResourceTool.handler({
      kind: 'Pod',
      name: 'api',
      namespace: 'default',
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      metadata: {
        name: 'api',
        namespace: 'default',
        labels: {
          app: 'api',
          'acornops.io/token': '<redacted>',
        },
        annotations: {
          owner: 'platform',
          'checksum/secret': '<redacted>',
        },
      },
      spec: {
        containers: [
          {
            name: 'api',
            image: 'registry.example.com/api:v1',
            command: ['<redacted>'],
            args: ['<redacted>'],
            env: [
              { name: 'DATABASE_PASSWORD', value: '<redacted>' },
              { name: 'API_URL', value: '<redacted>' },
              {
                name: 'FROM_SECRET',
                valueFrom: {
                  secretKeyRef: {
                    name: '<redacted>',
                    key: '<redacted>',
                  },
                },
              },
            ],
          },
        ],
        imagePullSecrets: [{ name: '<redacted>' }],
        volumes: [{ name: 'db', secret: { secretName: '<redacted>' } }],
      },
    });
    expect(result).not.toHaveProperty('metadata.managedFields');
    expect(serialized).not.toContain('plain-env-secret');
    expect(serialized).not.toContain('label-token');
    expect(serialized).not.toContain('annotation-secret');
    expect(serialized).not.toContain('database-credentials');
    expect(serialized).not.toContain('pull-secret');
    expect(serialized).not.toContain('echo token-value');
  });

  it('redacts node provider identifiers from cluster-scoped reads', async () => {
    const node = {
      metadata: { name: 'worker-1' },
      spec: { providerID: 'aws:///us-east-1a/i-1234567890abcdef0' },
    };
    vi.mocked(k8sClient.core.readNode).mockResolvedValue(node as never);

    await expect(
      getResourceTool.handler({
        kind: 'Node',
        name: 'worker-1',
      }),
    ).resolves.toMatchObject({
      metadata: { name: 'worker-1' },
      spec: { providerID: '<redacted>' },
    });
  });

  it('rejects namespaces outside the runtime scope before calling the client', async () => {
    setNamespaceScope({ include: ['default'], exclude: [] });

    await expect(
      getResourceTool.handler({
        kind: 'Pod',
        name: 'api',
        namespace: 'kube-system',
      }),
    ).rejects.toThrow('Namespace is outside the allowed scope: kube-system');

    expect(k8sClient.core.readNamespacedPod).not.toHaveBeenCalled();
  });

  it('throws for unsupported kinds when called directly', async () => {
    await expect(
      getResourceTool.handler({
        kind: 'ConfigMap',
        name: 'api',
        namespace: 'default',
      } as never),
    ).rejects.toThrow('Unsupported kind: ConfigMap');
  });
});
