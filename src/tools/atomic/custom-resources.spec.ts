import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    customObjects: {
      listNamespacedCustomObject: vi.fn(),
      listClusterCustomObject: vi.fn(),
      getNamespacedCustomObject: vi.fn(),
      getClusterCustomObject: vi.fn(),
      patchNamespacedCustomObject: vi.fn(),
      patchClusterCustomObject: vi.fn(),
    }
  }
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { getResourceHandler, getResourceTool } from './get-resource.js';
import { listResourcesHandler, listResourcesTool } from './list-resources.js';
import { patchResourceHandler, patchResourceSchema, patchResourceTool } from './patch-resource.js';

describe('consolidated custom resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_RBAC_ADDITIONS_JSON = [{
      key: 'cnpg',
      name: 'CNPG',
      description: 'CloudNativePG clusters',
      resources: [{
        apiGroup: 'postgresql.cnpg.io',
        apiVersion: 'v1',
        resource: 'clusters',
        kind: 'Cluster',
        scope: 'namespaced',
        verbs: ['get', 'list', 'patch']
      }]
    }];
  });

  it('lists custom-resource patch prerequisites without arbitrary spec or status data', async () => {
    vi.mocked(k8sClient.customObjects.listNamespacedCustomObject).mockResolvedValue({
      metadata: { _continue: 'next' },
      items: [{
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Cluster',
        metadata: {
          name: 'db', namespace: 'payments', uid: 'uid-1', resourceVersion: '7',
          generation: 3, creationTimestamp: '2026-08-01T00:00:00Z'
        },
        spec: { superuserSecret: { name: 'must-not-leak' } },
        status: { secret: 'must-not-leak' }
      }]
    } as never);

    const result = await listResourcesHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', limit: 50
    });

    expect(k8sClient.customObjects.listNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({
      group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters', namespace: 'payments'
    }));
    expect(result).toMatchObject({
      kind: 'Cluster',
      namespace: 'payments',
      continue_token: 'next',
      items: [{
        apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', name: 'db', uid: 'uid-1',
        resourceVersion: '7', generation: 3
      }]
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('gets a redacted custom resource and preserves useful bounded model context', async () => {
    vi.mocked(k8sClient.customObjects.getNamespacedCustomObject).mockResolvedValue({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: 'db', namespace: 'payments', uid: 'uid-1', resourceVersion: '7' },
      spec: { instances: 3, superuserSecret: { name: 'db-superuser' } },
      status: { phase: 'Ready' }
    } as never);

    const params = { addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db' };
    const result = await getResourceHandler(params);
    const projection = getResourceTool.projectForModel(result, params);

    expect(result.resource).toMatchObject({
      metadata: { name: 'db', resourceVersion: '7' },
      spec: { instances: 3, superuserSecret: { name: '<redacted>' } },
      status: { phase: 'Ready' }
    });
    expect(projection.data.resource).toMatchObject({ spec: { instances: 3 }, status: { phase: 'Ready' } });
  });

  it('falls back to custom-resource identity when model context would exceed its byte limit', () => {
    const params = { addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db' };
    const projection = getResourceTool.projectForModel({
      resource: {
        apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
        metadata: { name: 'db', namespace: 'payments', uid: 'uid-1', resourceVersion: '7' },
        spec: { oversized: 'x'.repeat(20_000) }
      }
    }, params);

    expect(projection.data.resource).toEqual(expect.objectContaining({ name: 'db', resourceVersion: '7' }));
    expect(projection.data.resource).not.toHaveProperty('spec');
    expect(projection.omissions).toEqual([expect.objectContaining({
      path: 'data.resource', reason: 'context_byte_limit'
    })]);
  });

  it('patches a custom resource through patch_resource with guarded dry-run verification', async () => {
    vi.mocked(k8sClient.customObjects.listNamespacedCustomObject).mockResolvedValue({
      items: [{
        metadata: { name: 'db', uid: 'uid-1', resourceVersion: '7', annotations: {} },
        spec: { instances: 2 }
      }]
    } as never);
    vi.mocked(k8sClient.customObjects.patchNamespacedCustomObject).mockImplementation(async ({ body }: any) => ({
      metadata: {
        uid: 'uid-1',
        resourceVersion: '8',
        annotations: body.find((operation: any) => operation.path === '/metadata/annotations').value
      },
      spec: { instances: 3 }
    }) as never);
    const request = patchResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Increase database capacity',
      operations: [{ op: 'replace', path: '/spec/instances', value: 3 }]
    });

    const result = await patchResourceHandler(request, { operationId: 'op-1' } as never);

    expect(k8sClient.customObjects.patchNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(k8sClient.customObjects.patchNamespacedCustomObject).mock.calls[0]?.[0]).toMatchObject({
      dryRun: 'All',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'uid-1' },
        { op: 'test', path: '/metadata/resourceVersion', value: '7' },
        expect.objectContaining({ op: 'add', path: '/metadata/annotations' }),
        { op: 'replace', path: '/spec/instances', value: 3 }
      ]
    });
    expect(result).toMatchObject({ success: true, operationId: 'op-1', change: { paths: ['/spec/instances'] } });
  });

  it('uses cluster authorization scopes for cluster-scoped custom resources', () => {
    const params = { addition_key: 'operators', resource: 'installations', name: 'global' };
    expect(listResourcesTool.scopeResolver({ ...params, limit: 50 })).toEqual({ type: 'cluster', kind: 'installations' });
    expect(getResourceTool.scopeResolver(params)).toEqual({ type: 'cluster', kind: 'installations' });
    expect(patchResourceTool.scopeResolver({ ...params, operations: [] })).toEqual({ type: 'cluster', kind: 'installations' });
  });

  it('retains custom-resource patch safety boundaries after consolidation', async () => {
    await expect(listResourcesHandler({
      addition_key: 'cnpg', resource: 'backups', namespace: 'payments', limit: 50
    })).rejects.toThrow('is not enabled');
    expect(() => patchResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Change status',
      operations: [{ op: 'replace', path: '/status/phase', value: 'Ready' }]
    })).toThrow('/spec');
    expect(() => patchResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Change instance list',
      operations: [{ op: 'remove', path: '/spec/instances/0' }]
    })).toThrow('Array-element');

    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
    await expect(patchResourceHandler(patchResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Increase database capacity',
      operations: [{ op: 'replace', path: '/spec/instances', value: 3 }]
    }))).rejects.toThrow('Write operations are disabled');
  });
});
