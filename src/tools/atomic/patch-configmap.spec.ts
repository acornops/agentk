import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: { readNamespacedConfigMap: vi.fn(), patchNamespacedConfigMap: vi.fn() },
  },
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { patchConfigMapHandler, patchConfigMapSchema } from './patch-configmap.js';

describe('patchConfigMapTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH = true;
  });

  it('dry-runs and applies a bounded non-secret data-key patch', async () => {
    const current = {
      metadata: { uid: 'cm-uid', resourceVersion: '7', annotations: {} },
      data: { LOG_LEVEL: 'info' },
    };
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue(current as never);
    vi.mocked(k8sClient.core.patchNamespacedConfigMap).mockImplementation(async (options: any) => {
      const data = options.body.find((operation: any) => operation.path === '/data').value;
      const annotations = options.body.find((operation: any) => operation.path === '/metadata/annotations').value;
      return { metadata: { uid: 'cm-uid', resourceVersion: '8', annotations }, data } as never;
    });
    const request = patchConfigMapSchema.parse({
      namespace: 'team-a',
      name: 'api-config',
      expected_uid: 'cm-uid',
      expected_resource_version: '7',
      reason: 'Enable diagnostic logging',
      confirm_non_secret_data: true,
      changes: [{ type: 'set_key', key: 'LOG_LEVEL', expected_present: true, value: 'debug' }],
    });

    const receipt = await patchConfigMapHandler(request);

    expect(k8sClient.core.patchNamespacedConfigMap).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({
      target: { kind: 'ConfigMap' },
      change: { rolloutTriggered: false },
      warnings: [expect.stringContaining('do not restart')],
    });
    expect(JSON.stringify(receipt)).not.toContain('debug');
  });

  it('fails closed for disabled, immutable, or secret-bearing ConfigMaps', async () => {
    const base = {
      namespace: 'team-a',
      name: 'api-config',
      expected_uid: 'cm-uid',
      expected_resource_version: '7',
      reason: 'Update config',
      confirm_non_secret_data: true,
      changes: [{ type: 'set_key', key: 'LOG_LEVEL', expected_present: false, value: 'debug' }],
    };
    config.ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH = false;
    expect(() => patchConfigMapSchema.parse(base)).toThrow('not enabled');
    config.ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH = true;
    expect(() => patchConfigMapSchema.parse({
      ...base,
      changes: [{ type: 'set_key', key: 'API_TOKEN', expected_present: false, value: 'value' }],
    })).toThrow('Secret-bearing');
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue({
      metadata: { uid: 'cm-uid', resourceVersion: '7', annotations: {} },
      immutable: true,
      data: {},
    } as never);
    await expect(patchConfigMapHandler(patchConfigMapSchema.parse(base))).rejects.toThrow('Immutable');
  });

  it('requires explicit non-secret confirmation and rejects multiline values', () => {
    const base = {
      namespace: 'team-a',
      name: 'api-config',
      expected_uid: 'cm-uid',
      expected_resource_version: '7',
      reason: 'Update config',
      changes: [{ type: 'set_key', key: 'LOG_LEVEL', expected_present: false, value: 'debug' }],
    };

    expect(() => patchConfigMapSchema.parse(base)).toThrow();
    expect(() => patchConfigMapSchema.parse({
      ...base,
      confirm_non_secret_data: true,
      changes: [{ type: 'set_key', key: 'app.conf', expected_present: false, value: 'line-1\nline-2' }],
    })).toThrow('control or format');
  });

  it('removes one data key without touching binaryData', async () => {
    const current = {
      metadata: { uid: 'cm-uid', resourceVersion: '7', annotations: {} },
      data: { LOG_LEVEL: 'info', FEATURE_FLAG: 'enabled' },
      binaryData: { certificate: 'ZGVidWc=' },
    };
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue(current as never);
    vi.mocked(k8sClient.core.patchNamespacedConfigMap).mockImplementation(async (options: any) => {
      const data = options.body.find((operation: any) => operation.path === '/data').value;
      const annotations = options.body.find((operation: any) => operation.path === '/metadata/annotations').value;
      return {
        metadata: { uid: 'cm-uid', resourceVersion: '8', annotations },
        data,
        binaryData: current.binaryData,
      } as never;
    });
    const request = patchConfigMapSchema.parse({
      namespace: 'team-a',
      name: 'api-config',
      expected_uid: 'cm-uid',
      expected_resource_version: '7',
      reason: 'Remove obsolete logging override',
      confirm_non_secret_data: true,
      changes: [{ type: 'remove_key', key: 'LOG_LEVEL' }],
    });

    await patchConfigMapHandler(request);

    const body = vi.mocked(k8sClient.core.patchNamespacedConfigMap).mock.calls[1]![0].body as any[];
    expect(body).toContainEqual({
      op: 'add',
      path: '/data',
      value: { FEATURE_FLAG: 'enabled' },
    });
    expect(body.some((operation) => String(operation.path).includes('binaryData'))).toBe(false);
  });

  it('rejects stale identity and resource-version evidence before dry-run', async () => {
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue({
      metadata: { uid: 'replacement-uid', resourceVersion: '8', annotations: {} },
      data: {},
    } as never);
    const base = {
      namespace: 'team-a',
      name: 'api-config',
      expected_uid: 'cm-uid',
      expected_resource_version: '7',
      reason: 'Update config',
      confirm_non_secret_data: true,
      changes: [{ type: 'set_key', key: 'LOG_LEVEL', expected_present: false, value: 'debug' }],
    };

    await expect(patchConfigMapHandler(patchConfigMapSchema.parse(base))).rejects.toThrow('UID');
    vi.mocked(k8sClient.core.readNamespacedConfigMap).mockResolvedValue({
      metadata: { uid: 'cm-uid', resourceVersion: '8', annotations: {} },
      data: {},
    } as never);
    await expect(patchConfigMapHandler(patchConfigMapSchema.parse(base))).rejects.toThrow('Resource version');
    expect(k8sClient.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });
});
