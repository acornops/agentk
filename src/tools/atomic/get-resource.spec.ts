import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: {
      readNamespacedPod: vi.fn(),
      readNamespacedService: vi.fn(),
      readNamespacedConfigMap: vi.fn(),
      readNamespacedPersistentVolumeClaim: vi.fn(),
      readNode: vi.fn(),
      readNamespacedEvent: vi.fn(),
      readNamespace: vi.fn(),
    },
    apps: {
      readNamespacedDeployment: vi.fn(),
      readNamespacedReplicaSet: vi.fn(),
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
    ['ConfigMap', vi.mocked(k8sClient.core.readNamespacedConfigMap), { name: 'api', namespace: 'default' }],
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
    ).resolves.toMatchObject({ resource });

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
    ).resolves.toMatchObject({ resource: node });

    expect(k8sClient.core.readNode).toHaveBeenCalledWith({ name: 'worker-1' });

    await expect(
      getResourceTool.handler({
        kind: 'Namespace',
        name: 'payments',
      }),
    ).resolves.toMatchObject({ resource: namespace });

    expect(k8sClient.core.readNamespace).toHaveBeenCalledWith({ name: 'payments' });
  });

  it('resolves a Pod through its ReplicaSet to exact Deployment patch prerequisites', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: {
        name: 'acornops-demo-unhealthy-abc',
        namespace: 'acornops-demo',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'acornops-demo-unhealthy-rs', uid: 'rs-uid', controller: true }],
      },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedReplicaSet).mockResolvedValue({
      metadata: {
        name: 'acornops-demo-unhealthy-rs', uid: 'rs-uid',
        ownerReferences: [{ kind: 'Deployment', name: 'acornops-demo-unhealthy', uid: 'deployment-uid', controller: true }],
      },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { name: 'acornops-demo-unhealthy', uid: 'deployment-uid' },
      spec: {
        template: {
          spec: {
            containers: [{ name: 'nginx', image: 'nginx:1.27.4-alpnie' }],
          },
        },
      },
    } as never);

    const result = await getResourceTool.handler({
      kind: 'Pod',
      name: 'acornops-demo-unhealthy-abc',
      namespace: 'acornops-demo',
    });
    expect(result).toMatchObject({
      ownership: {
        status: 'resolved',
        remediationTarget: {
          kind: 'Deployment',
          name: 'acornops-demo-unhealthy',
          namespace: 'acornops-demo',
          uid: 'deployment-uid',
          containers: [{ name: 'nginx', image: 'nginx:1.27.4-alpnie' }],
        },
      },
    });
    expect(k8sClient.apps.readNamespacedReplicaSet).toHaveBeenCalledWith({
      name: 'acornops-demo-unhealthy-rs',
      namespace: 'acornops-demo',
    });
  });

  it('marks standalone Pods as unowned instead of guessing a workload', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'standalone', namespace: 'default', uid: 'pod-1' },
    } as never);
    const result = await getResourceTool.handler({ kind: 'Pod', name: 'standalone', namespace: 'default' });
    expect(result).toMatchObject({
      ownership: { status: 'unowned', remediationTarget: null, reason: 'standalone_pod_not_patchable' },
    });
    const context = getResourceTool.projectForModel(result, { kind: 'Pod', name: 'standalone', namespace: 'default' });
    expect(context.summary).toContain('No patchable remediation target');
  });

  it('does not treat a non-controller owner reference as a remediation owner', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      apiVersion: 'v1', kind: 'Pod', metadata: {
        name: 'observed', namespace: 'default', uid: 'pod-1',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'not-controller', uid: 'rs-1', controller: false }],
      },
    } as never);

    await expect(getResourceTool.handler({ kind: 'Pod', name: 'observed', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'unowned', remediationTarget: null, reason: 'no_controlling_owner_reference',
      } });
    expect(k8sClient.apps.readNamespacedReplicaSet).not.toHaveBeenCalled();
  });

  it('resolves Job-owned Pods to a future-runs-only CronJob target', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'nightly-123-x', namespace: 'ops', uid: 'pod-1', ownerReferences: [
        { kind: 'Job', name: 'nightly-123', uid: 'job-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.batch.readNamespacedJob).mockResolvedValue({
      metadata: { name: 'nightly-123', uid: 'job-1', ownerReferences: [
        { kind: 'CronJob', name: 'nightly', uid: 'cron-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.batch.readNamespacedCronJob).mockResolvedValue({
      metadata: { name: 'nightly', uid: 'cron-1' },
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image: 'job:v1' }] } } } } },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'nightly-123-x', namespace: 'ops' }))
      .resolves.toMatchObject({ ownership: { status: 'resolved', remediationTarget: {
        kind: 'CronJob', name: 'nightly', effect: 'future_runs_only',
      } } });
  });

  it.each([
    ['StatefulSet', vi.mocked(k8sClient.apps.readNamespacedStatefulSet)],
    ['DaemonSet', vi.mocked(k8sClient.apps.readNamespacedDaemonSet)],
  ])('resolves a Pod directly to its UID-verified %s', async (kind, method) => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'api-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind, name: 'api', uid: 'owner-1', controller: true },
      ] },
    } as never);
    method.mockResolvedValue({
      metadata: { name: 'api', uid: 'owner-1' },
      spec: { template: { spec: { containers: [{ name: 'api', image: 'api:v1' }] } } },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'api-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: { status: 'resolved', remediationTarget: {
        kind, name: 'api', uid: 'owner-1', containers: [{ name: 'api', image: 'api:v1' }],
      } } });
  });

  it('preserves a partial path when RBAC denies owner traversal', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'api-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind: 'ReplicaSet', name: 'api-rs', uid: 'rs-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedReplicaSet).mockRejectedValue({ statusCode: 403 });
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'api-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'partial', remediationTarget: null, error: { code: 'OWNER_LOOKUP_FORBIDDEN' },
        path: [{ kind: 'Pod', name: 'api-pod' }, { kind: 'ReplicaSet', name: 'api-rs', uid: 'rs-1' }],
      } });
  });

  it('preserves the referenced owner when it is deleted during traversal', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'api-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind: 'ReplicaSet', name: 'api-rs', uid: 'rs-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedReplicaSet).mockRejectedValue({ statusCode: 404 });
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'api-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'partial', remediationTarget: null, error: { code: 'OWNER_NOT_FOUND' },
        path: [
          { kind: 'Pod', name: 'api-pod', uid: 'pod-1', controller: false },
          { kind: 'ReplicaSet', name: 'api-rs', uid: 'rs-1', controller: true },
        ],
      } });
  });

  it('does not patch through an orphan ReplicaSet', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'orphan-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind: 'ReplicaSet', name: 'orphan-rs', uid: 'rs-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedReplicaSet).mockResolvedValue({
      metadata: { name: 'orphan-rs', uid: 'rs-1' },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'orphan-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'partial', remediationTarget: null, reason: 'owner_chain_incomplete',
      } });
  });

  it('marks a directly owned active Job immutable for current-Pod remediation', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'job-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind: 'Job', name: 'one-off', uid: 'job-1', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.batch.readNamespacedJob).mockResolvedValue({
      metadata: { name: 'one-off', uid: 'job-1' },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'job-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'unsupported', remediationTarget: null, reason: 'active_job_template_immutable',
      } });
  });

  it('rejects unsupported custom controllers without guessing a target', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'custom-pod', namespace: 'default', uid: 'pod-1', ownerReferences: [
        { kind: 'Rollout', name: 'api', uid: 'rollout-1', controller: true },
      ] },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'custom-pod', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'unsupported', remediationTarget: null, error: { code: 'OWNER_KIND_UNSUPPORTED' },
      } });
  });

  it('reports owner UID replacement and does not expose a remediation target', async () => {
    vi.mocked(k8sClient.core.readNamespacedPod).mockResolvedValue({
      metadata: { name: 'api-old', namespace: 'default', ownerReferences: [
        { kind: 'ReplicaSet', name: 'api-rs', uid: 'old-uid', controller: true },
      ] },
    } as never);
    vi.mocked(k8sClient.apps.readNamespacedReplicaSet).mockResolvedValue({
      metadata: { name: 'api-rs', uid: 'new-uid' },
    } as never);
    await expect(getResourceTool.handler({ kind: 'Pod', name: 'api-old', namespace: 'default' }))
      .resolves.toMatchObject({ ownership: {
        status: 'partial', remediationTarget: null, error: { code: 'OWNER_UID_MISMATCH' },
      } });
  });

  it('projects direct workload patch prerequisites within the model-context budget', () => {
    const resource = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'api', namespace: 'default', uid: 'deployment-1', resourceVersion: '7' },
      spec: {
        selector: { matchLabels: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key-${index}`, 'x'.repeat(50)])) },
        template: { spec: {
          containers: [{ name: 'api', image: 'registry.example.test/api:v1' }],
          initContainers: [{ name: 'migrate', image: 'registry.example.test/migrate:v1' }],
        } },
      },
    };
    const context = getResourceTool.projectForModel(
      { resource }, { kind: 'Deployment', name: 'api', namespace: 'default' }
    );
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(12 * 1024);
    expect(context.data.remediationTarget).toMatchObject({
      kind: 'Deployment', name: 'api', uid: 'deployment-1',
      containers: [{ name: 'api', image: 'registry.example.test/api:v1' }],
      initContainers: [{ name: 'migrate', image: 'registry.example.test/migrate:v1' }],
    });
    expect(context.omissions).toContainEqual({
      path: 'data.configuration.selector', reason: 'context_byte_limit', originalBytes: expect.any(Number),
    });
  });

  it('uses original literal environment fingerprints in direct workload projections', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'api',
        namespace: 'default',
        uid: 'deployment-1',
        resourceVersion: '7',
      },
      spec: {
        selector: { matchLabels: { app: 'api' } },
        template: {
          metadata: { labels: { app: 'api' } },
          spec: {
            containers: [{
              name: 'api',
              image: 'registry.example.test/api:v1',
              env: [{ name: 'LOG_LEVEL', value: 'debug' }],
            }],
          },
        },
      },
    } as never);

    const result = await getResourceTool.handler({
      kind: 'Deployment',
      name: 'api',
      namespace: 'default',
    });
    const context = getResourceTool.projectForModel(result, {
      kind: 'Deployment',
      name: 'api',
      namespace: 'default',
    });

    expect(result.resource.spec.template.spec.containers[0].env[0].value).toBe('<redacted>');
    expect(context.data.remediationTarget.containers[0].env).toEqual([
      {
        name: 'LOG_LEVEL',
        source: 'literal',
        valueSha256: '0b8e9e995d8d77f1e4770f0f79665aee6f3f70247b3735422daba73df4c3096f',
      },
    ]);
  });

  it('projects an exact remediation target for a directly patchable Ingress', () => {
    const context = getResourceTool.projectForModel(
      {
        resource: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: {
            name: 'api', namespace: 'default', uid: 'ingress-1', resourceVersion: '9',
          },
          spec: { rules: [{ host: 'api.example.test' }] },
        },
      },
      { kind: 'Ingress', name: 'api', namespace: 'default' },
    );

    expect(context.data.remediationTarget).toMatchObject({
      kind: 'Ingress', name: 'api', namespace: 'default', uid: 'ingress-1', effect: 'current_resource',
    });
  });

  it('fails closed when complete remediation prerequisites cannot fit model context', () => {
    const resource = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'huge', namespace: 'default', uid: 'deployment-1', resourceVersion: '7' },
      spec: { template: { spec: { containers: Array.from({ length: 100 }, (_, index) => ({
        name: `container-${index}`, image: `registry.example.test/${'x'.repeat(300)}:${index}`,
      })) } } },
    };
    const context = getResourceTool.projectForModel(
      { resource }, { kind: 'Deployment', name: 'huge', namespace: 'default' }
    );
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(12 * 1024);
    expect(context).toMatchObject({
      status: 'success',
      data: { code: 'MODEL_CONTEXT_TOO_LARGE', remediationTarget: null },
    });
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
      resource: {
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
      }
    });
    expect(result).not.toHaveProperty('resource.metadata.managedFields');
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
      resource: {
        metadata: { name: 'worker-1' },
        spec: { providerID: '<redacted>' },
      },
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

  it('projects ConfigMap keys without exposing values', async () => {
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'api', namespace: 'default', uid: 'cm-uid', resourceVersion: '7' },
      data: { LOG_LEVEL: 'debug' },
      binaryData: { certificate: 'ZGVidWc=' },
    } as never);

    const result = await getResourceTool.handler({
      kind: 'ConfigMap',
      name: 'api',
      namespace: 'default',
    } as never);
    const projection = getResourceTool.projectForModel(result, {
      kind: 'ConfigMap',
      name: 'api',
      namespace: 'default',
    });

    expect(projection.data.configuration.configMapKeys).toEqual([
      { key: 'LOG_LEVEL', valueSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 5 },
    ]);
    expect(result.resource.data).toEqual({ LOG_LEVEL: '<redacted>' });
    expect(result.resource.binaryData).toEqual({ certificate: '<redacted>' });
    expect(JSON.stringify(result.resource)).not.toContain('debug');
    expect(JSON.stringify(result.resource)).not.toContain('ZGVidWc=');
    expect(JSON.stringify(projection)).not.toContain('debug');
  });
});
