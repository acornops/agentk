import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    apps: {
      readNamespacedDeployment: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      patchNamespacedStatefulSet: vi.fn(),
    },
    autoscaling: {
      listNamespacedHorizontalPodAutoscaler: vi.fn(),
    },
  },
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { scaleWorkloadTool } from './scale.js';

describe('scaleWorkloadTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(k8sClient.autoscaling.listNamespacedHorizontalPodAutoscaler).mockResolvedValue({ items: [] } as never);
  });

  afterEach(() => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
    config.ACORNOPS_AGENT_ALLOW_SCALE_TO_ZERO = false;
  });

  it('fails when write operations are disabled', async () => {
    await expect(
      scaleWorkloadTool.handler({
        kind: 'Deployment',
        name: 'api',
        namespace: 'default',
        replicas: 3,
        reason: 'manual scale',
      })
    ).rejects.toThrow('Write operations are disabled');
  });

  it('scales deployments and records merge-safe annotations', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10', generation: 2, annotations: { existing: 'annotation' } },
      spec: { replicas: 3 },
    } as never);
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockImplementation(async ({ body }: any) => ({
      metadata: { name: 'api', uid: 'dep-uid', resourceVersion: '11', generation: 3, annotations: body[3].value },
      spec: { replicas: body[2].value },
    }) as never);

    await expect(
      scaleWorkloadTool.handler({
        kind: 'Deployment',
        name: 'api',
        namespace: 'default',
        replicas: 5,
        reason: 'manual scale',
      })
    ).resolves.toMatchObject({
      success: true,
      target: { kind: 'Deployment', namespace: 'default', name: 'api', uid: 'dep-uid' },
      change: { type: 'scale', previousReplicas: 3, requestedReplicas: 5, hpaOverride: false },
      observed: { resourceVersion: '11', generation: 3 },
    });
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledWith({
      name: 'api',
      namespace: 'default',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'dep-uid' },
        { op: 'test', path: '/metadata/resourceVersion', value: '10' },
        { op: 'add', path: '/spec/replicas', value: 5 },
        {
          op: 'add',
          path: '/metadata/annotations',
          value: expect.objectContaining({
            existing: 'annotation',
            'acornops.dev/reason': 'manual scale',
            'acornops.dev/applied-by': 'cluster-cluster-1',
          }),
        },
      ],
    });
  });

  it('scales statefulsets with one guarded parent-resource patch', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    vi.mocked(k8sClient.apps.readNamespacedStatefulSet).mockResolvedValue({
      metadata: { uid: 'sts-uid', resourceVersion: '20', annotations: {} },
      spec: { replicas: 1 },
    } as never);
    vi.mocked(k8sClient.apps.patchNamespacedStatefulSet).mockImplementation(async ({ body }: any) => ({
      metadata: { name: 'db', uid: 'sts-uid', resourceVersion: '21', annotations: body[3].value },
      spec: { replicas: body[2].value },
    }) as never);

    await scaleWorkloadTool.handler({
      kind: 'StatefulSet',
      name: 'db',
      namespace: 'data',
      replicas: 2,
      reason: 'right size',
    });

    expect(k8sClient.apps.patchNamespacedStatefulSet).toHaveBeenCalledWith({
      name: 'db',
      namespace: 'data',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'sts-uid' },
        { op: 'test', path: '/metadata/resourceVersion', value: '20' },
        { op: 'add', path: '/spec/replicas', value: 2 },
        {
          op: 'add',
          path: '/metadata/annotations',
          value: expect.objectContaining({
            'acornops.dev/reason': 'right size',
          }),
        },
      ],
    });
  });

  it('requires operator and caller confirmation for scale-to-zero', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_ALLOW_SCALE_TO_ZERO = false;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' }, spec: { replicas: 1 },
    } as never);
    await expect(scaleWorkloadTool.handler({
      kind: 'Deployment', name: 'api', namespace: 'default', replicas: 0, reason: 'stop', confirm_scale_to_zero: true,
    })).rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation when an HPA manages the workload', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' },
      spec: { replicas: 3 },
    } as never);
    vi.mocked(k8sClient.autoscaling.listNamespacedHorizontalPodAutoscaler).mockResolvedValue({
      items: [{ spec: { scaleTargetRef: { kind: 'Deployment', name: 'api' } } }],
    } as never);

    await expect(scaleWorkloadTool.handler({
      kind: 'Deployment', name: 'api', namespace: 'default', replicas: 4, reason: 'manual',
    })).rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('returns an idempotent receipt before reapplying the caller replica precondition', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    const params = {
      kind: 'Deployment' as const,
      name: 'api',
      namespace: 'default',
      replicas: 5,
      reason: 'manual scale',
      confirm_scale_to_zero: false,
      confirm_hpa_override: false,
      expected_current_replicas: 3,
    };
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValueOnce({
      metadata: {
        uid: 'dep-uid', resourceVersion: '11',
        annotations: {
          'acornops.dev/operation-id': 'op-1', 'acornops.dev/operation-hash': hash,
          'acornops.dev/operation-kind': 'scale',
          'acornops.dev/previous-replicas': '3', 'acornops.dev/requested-replicas': '5',
          'acornops.dev/hpa-override': 'false',
        },
      },
      spec: { replicas: 5 },
    } as never);

    await expect(scaleWorkloadTool.handler(params, { operationId: 'op-1', requestId: 1, sessionGeneration: 1 }))
      .resolves.toMatchObject({ change: { previousReplicas: 3, requestedReplicas: 5 } });
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('rejects an idempotent retry with incomplete persisted receipt metadata', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    const params = {
      kind: 'Deployment' as const, name: 'api', namespace: 'default', replicas: 5, reason: 'manual scale',
      confirm_scale_to_zero: false, confirm_hpa_override: false,
    };
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: {
        uid: 'dep-uid', resourceVersion: '11',
        annotations: {
          'acornops.dev/operation-id': 'op-1', 'acornops.dev/operation-hash': hash,
          'acornops.dev/operation-kind': 'scale', 'acornops.dev/previous-replicas': 'not-a-number',
          'acornops.dev/requested-replicas': '5', 'acornops.dev/hpa-override': 'false',
        },
      },
      spec: { replicas: 5 },
    } as never);

    await expect(scaleWorkloadTool.handler(params, { operationId: 'op-1', requestId: 1, sessionGeneration: 1 }))
      .rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
  });

  it('does not patch after its execution deadline expires during HPA discovery', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    const controller = new AbortController();
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' }, spec: { replicas: 3 },
    } as never);
    vi.mocked(k8sClient.autoscaling.listNamespacedHorizontalPodAutoscaler).mockImplementationOnce(async () => {
      controller.abort();
      return { items: [] } as never;
    });

    await expect(scaleWorkloadTool.handler(
      { kind: 'Deployment', name: 'api', namespace: 'default', replicas: 4, reason: 'scale' },
      { operationId: 'op-timeout', requestId: 1, sessionGeneration: 1, signal: controller.signal },
    )).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT', data: { outcome: 'not_started' } });
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('reports an unknown outcome when an accepted scale cannot be verified', async () => {
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '10' }, spec: { replicas: 3 },
    } as never);
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockResolvedValue({
      metadata: { uid: 'dep-uid', resourceVersion: '11' }, spec: { replicas: 4 },
    } as never);

    await expect(scaleWorkloadTool.handler(
      { kind: 'Deployment', name: 'api', namespace: 'default', replicas: 4, reason: 'scale' },
      { operationId: 'op-unknown', requestId: 1, sessionGeneration: 1 },
    )).rejects.toMatchObject({
      toolCode: 'KUBERNETES_ERROR',
      data: {
        outcome: 'unknown', operationId: 'op-unknown',
        reason: 'PostWriteVerificationFailed', phase: 'verification',
      },
    });
  });
});
