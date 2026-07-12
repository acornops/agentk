import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restartWorkloadTool } from './restart-workload.js';
import { k8sClient } from '../../k8s/client.js';
import { config } from '../../config.js';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    apps: {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      patchNamespacedStatefulSet: vi.fn(),
      patchNamespacedDaemonSet: vi.fn(),
    }
  }
}));

describe('Restart Workload Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
  });

  it('should fail if write is not enabled', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
    await expect(
      restartWorkloadTool.handler({
        kind: 'Deployment',
        name: 'test',
        namespace: 'default',
        reason: 'testing'
      })
    ).rejects.toThrow('Write operations are disabled');
  });

  it('should call deployment patch if write is enabled', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    (k8sClient.apps.readNamespacedDeployment as any).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10', generation: 2 },
      spec: { template: { metadata: { annotations: { existing: 'annotation' } } } }
    });
    (k8sClient.apps.patchNamespacedDeployment as any).mockImplementation(async ({ body }: any) => ({
      metadata: { name: 'test', uid: 'dep-uid', resourceVersion: '11', generation: 3 },
      spec: { template: { metadata: { annotations: body[2].value } } },
    }));

    const result = await restartWorkloadTool.handler({
      kind: 'Deployment',
      name: 'test',
      namespace: 'default',
      reason: 'testing'
    });

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('spec');
    expect(result).not.toHaveProperty('status');
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledWith({
      name: 'test',
      namespace: 'default',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'dep-uid' },
        { op: 'test', path: '/metadata/resourceVersion', value: '10' },
        {
          op: 'add',
          path: '/spec/template/metadata/annotations',
          value: expect.objectContaining({
            existing: 'annotation',
            'acornops.dev/reason': 'testing',
            'acornops.dev/applied-by': 'cluster-cluster-1',
            'acornops.dev/operation-id': expect.any(String),
            'kubectl.kubernetes.io/restartedAt': expect.any(String),
          }),
        },
      ],
    });
  });

  it.each([
    [
      'StatefulSet',
      'readNamespacedStatefulSet',
      'patchNamespacedStatefulSet',
      'db',
    ],
    [
      'DaemonSet',
      'readNamespacedDaemonSet',
      'patchNamespacedDaemonSet',
      'agent',
    ],
  ])('creates template metadata when restarting a %s without annotations', async (kind, readMethod, patchMethod, name) => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    (k8sClient.apps[readMethod as 'readNamespacedStatefulSet'] as any).mockResolvedValue({
      metadata: { uid: `${name}-uid`, resourceVersion: '20' },
      spec: { template: {} },
    });
    (k8sClient.apps[patchMethod as 'patchNamespacedStatefulSet'] as any).mockImplementation(async ({ body }: any) => ({
      metadata: { name, uid: `${name}-uid`, resourceVersion: '21' },
      spec: { template: { metadata: body[2].value } },
    }));

    const result = await restartWorkloadTool.handler({
      kind: kind as 'StatefulSet',
      name,
      namespace: 'default',
      reason: 'testing',
    });

    expect(result).toMatchObject({
      success: true,
      operationId: expect.any(String),
      target: { kind, namespace: 'default', name, uid: `${name}-uid` },
      change: { type: 'restart', restartedAt: expect.any(String) },
      observed: { resourceVersion: '21' },
    });
    expect(k8sClient.apps[patchMethod as 'patchNamespacedStatefulSet']).toHaveBeenCalledWith({
      name,
      namespace: 'default',
      body: [
        { op: 'test', path: '/metadata/uid', value: `${name}-uid` },
        { op: 'test', path: '/metadata/resourceVersion', value: '20' },
        {
          op: 'add',
          path: '/spec/template/metadata',
          value: {
            annotations: expect.objectContaining({
              'acornops.dev/reason': 'testing',
              'acornops.dev/applied-by': 'cluster-cluster-1',
              'kubectl.kubernetes.io/restartedAt': expect.any(String),
            }),
          },
        },
      ],
    });
  });

  it('returns the existing receipt on an idempotent retry and rejects changed arguments', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    const current = {
      metadata: { uid: 'dep-uid', resourceVersion: '10' },
      spec: { template: { metadata: { annotations: {} } } },
    };
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(current as never);
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockImplementation(async ({ body }: any) => ({
      metadata: { uid: 'dep-uid', resourceVersion: '11' },
      spec: { template: { metadata: { annotations: body[2].value } } },
    }) as never);
    const context = { operationId: 'operation-1', requestId: 1, sessionGeneration: 1 };
    const params = { kind: 'Deployment' as const, name: 'api', namespace: 'default', reason: 'retry-safe restart' };

    const first = await restartWorkloadTool.handler(params, context);
    const patched = vi.mocked(k8sClient.apps.patchNamespacedDeployment).mock.results[0]!.value;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(await patched as never);
    const retried = await restartWorkloadTool.handler(params, context);

    expect(retried).toEqual(first);
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledTimes(1);
    await expect(restartWorkloadTool.handler({ ...params, reason: 'different reason' }, context))
      .rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
  });

  it('does not patch after its execution deadline expires during the read', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    const controller = new AbortController();
    controller.abort();
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' }, spec: { template: { metadata: {} } },
    } as never);

    await expect(restartWorkloadTool.handler(
      { kind: 'Deployment', name: 'api', namespace: 'default', reason: 'restart' },
      { operationId: 'op-timeout', requestId: 1, sessionGeneration: 1, signal: controller.signal },
    )).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT', data: { outcome: 'not_started' } });
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('reports an unknown outcome when an accepted restart cannot be verified', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' }, spec: { template: { metadata: {} } },
    } as never);
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '11' }, spec: { template: { metadata: {} } },
    } as never);

    await expect(restartWorkloadTool.handler(
      { kind: 'Deployment', name: 'api', namespace: 'default', reason: 'restart' },
      { operationId: 'op-unknown', requestId: 1, sessionGeneration: 1 },
    )).rejects.toMatchObject({
      toolCode: 'KUBERNETES_ERROR', data: { outcome: 'unknown', operationId: 'op-unknown' },
    });
  });
});
