import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: { readNamespacedService: vi.fn(), patchNamespacedService: vi.fn() },
    networking: { readNamespacedIngress: vi.fn(), patchNamespacedIngress: vi.fn() },
  },
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { patchResourceHandler, patchResourceSchema } from './patch-resource.js';

function returnPatched(method: ReturnType<typeof vi.fn>, result: any) {
  method.mockImplementation(async (options: any) => {
    const response = structuredClone(result);
    for (const operation of options.body) {
      if (operation.path === '/metadata/annotations') response.metadata.annotations = operation.value;
      if (operation.path === '/spec/selector') response.spec.selector = operation.value;
    }
    return response;
  });
}

describe('patchResourceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_RESOURCE_PATCH_KINDS = ['Service', 'Ingress'];
    config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH = false;
  });

  it('preserves guarded Ingress metadata patching', async () => {
    const current = { metadata: { uid: 'ingress-uid', resourceVersion: '1', annotations: {} }, spec: { rules: [] } };
    const updated = {
      metadata: { uid: 'ingress-uid', resourceVersion: '2', annotations: { 'nginx.ingress.kubernetes.io/rewrite-target': '/private-route' } },
      spec: { rules: [] },
    };
    vi.mocked(k8sClient.networking.readNamespacedIngress).mockResolvedValue(current as never);
    returnPatched(vi.mocked(k8sClient.networking.patchNamespacedIngress) as any, updated);
    const request = patchResourceSchema.parse({
      kind: 'Ingress',
      namespace: 'team-a',
      name: 'web',
      expected_uid: 'ingress-uid',
      expected_resource_version: '1',
      reason: 'Repair routing annotation',
      changes: [{
        type: 'set_annotation',
        key: 'nginx.ingress.kubernetes.io/rewrite-target',
        expected_value: null,
        value: '/private-route',
      }],
    });

    const receipt = await patchResourceHandler(request);

    expect(receipt).toMatchObject({ change: { rolloutTriggered: false, serviceRoutingChanged: false } });
    expect(JSON.stringify(receipt)).not.toContain('private-route');
  });

  it('preserves explicit confirmation for Service selector changes', async () => {
    const input = {
      kind: 'Service',
      namespace: 'team-a',
      name: 'api',
      expected_uid: 'service-uid',
      expected_resource_version: '4',
      reason: 'Repair selector',
      changes: [{ type: 'set_service_selector', key: 'app', expected_value: 'wrong', value: 'api' }],
    };
    expect(() => patchResourceSchema.parse(input)).toThrow('operator enablement and caller confirmation');
    config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH = true;
    expect(() => patchResourceSchema.parse(input)).toThrow('operator enablement and caller confirmation');
    const request = patchResourceSchema.parse({ ...input, confirm_service_selector_change: true });
    const current = {
      metadata: { uid: 'service-uid', resourceVersion: '4', annotations: {} },
      spec: { type: 'ClusterIP', selector: { app: 'wrong' } },
    };
    const updated = {
      metadata: { uid: 'service-uid', resourceVersion: '5', annotations: {} },
      spec: { type: 'ClusterIP', selector: { app: 'api' } },
    };
    vi.mocked(k8sClient.core.readNamespacedService).mockResolvedValue(current as never);
    returnPatched(vi.mocked(k8sClient.core.patchNamespacedService) as any, updated);

    await expect(patchResourceHandler(request)).resolves.toMatchObject({
      change: { serviceRoutingChanged: true },
      warnings: [expect.stringContaining('redirect traffic')],
    });
  });

  it('preserves checksum annotation validation and label-key behavior', () => {
    const base = {
      kind: 'Ingress',
      namespace: 'team-a',
      name: 'web',
      expected_uid: 'ingress-uid',
      expected_resource_version: '1',
      reason: 'Update rollout checksum',
    };
    expect(() => patchResourceSchema.parse({
      ...base,
      changes: [{
        type: 'set_annotation',
        key: 'checksum/config',
        expected_value: null,
        value: 'not-a-digest',
      }],
    })).toThrow('hexadecimal digest');
    expect(() => patchResourceSchema.parse({
      ...base,
      changes: [{
        type: 'set_label',
        key: 'kubectl.kubernetes.io/restartedAt',
        expected_value: null,
        value: 'allowed-as-a-label',
      }],
    })).not.toThrow();
  });

  it('rejects a stale resource version before dry-run', async () => {
    vi.mocked(k8sClient.networking.readNamespacedIngress).mockResolvedValue({
      metadata: { uid: 'ingress-uid', resourceVersion: '2', annotations: {} },
      spec: { rules: [] },
    } as never);
    const request = patchResourceSchema.parse({
      kind: 'Ingress',
      namespace: 'team-a',
      name: 'web',
      expected_uid: 'ingress-uid',
      expected_resource_version: '1',
      reason: 'Repair routing annotation',
      changes: [{
        type: 'set_annotation',
        key: 'nginx.ingress.kubernetes.io/rewrite-target',
        expected_value: null,
        value: '/private-route',
      }],
    });

    await expect(patchResourceHandler(request)).rejects.toThrow('Resource version');
    expect(k8sClient.networking.patchNamespacedIngress).not.toHaveBeenCalled();
  });
});
