import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    customObjects: {
      listNamespacedCustomObject: vi.fn(),
      listClusterCustomObject: vi.fn(),
      getNamespacedCustomObject: vi.fn(),
      getClusterCustomObject: vi.fn(),
      createNamespacedCustomObject: vi.fn(),
      createClusterCustomObject: vi.fn(),
      patchNamespacedCustomObject: vi.fn(),
      patchClusterCustomObject: vi.fn(),
      deleteNamespacedCustomObject: vi.fn(),
      deleteClusterCustomObject: vi.fn()
    }
  }
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { listCustomResourcesHandler } from './list-custom-resources.js';
import { patchCustomResourceHandler, patchCustomResourceSchema } from './patch-custom-resource.js';
import {
  createCustomResourceHandler,
  deleteCustomResourceHandler,
  getCustomResourceHandler,
  watchCustomResourcesHandler
} from './custom-resource-operations.js';

describe('administrator-approved custom resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_RBAC_ADDITIONS_JSON = [{
      key: 'cnpg',
      name: 'CNPG',
      description: 'CloudNativePG clusters',
      resources: [{
        apiGroup: 'postgresql.cnpg.io', apiVersion: 'v1', resource: 'clusters', kind: 'Cluster',
        scope: 'namespaced', verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete']
      }]
    }];
  });

  it('lists only bounded identity metadata for an exact configured resource', async () => {
    vi.mocked(k8sClient.customObjects.listNamespacedCustomObject).mockResolvedValue({
      metadata: { _continue: 'next' },
      items: [{
        apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
        metadata: { name: 'db', namespace: 'payments', uid: 'uid-1', resourceVersion: '7' },
        spec: { superuserSecret: { name: 'must-not-leak' } }, status: { secret: 'must-not-leak' }
      }]
    } as never);

    const result = await listCustomResourcesHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', limit: 50
    });

    expect(k8sClient.customObjects.listNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({
      group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters', namespace: 'payments'
    }));
    expect(result.continue_token).toBe('next');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('dry-runs and applies an identity-guarded spec-only patch', async () => {
    vi.mocked(k8sClient.customObjects.listNamespacedCustomObject).mockResolvedValue({
      items: [{
        metadata: { name: 'db', uid: 'uid-1', resourceVersion: '7', annotations: {} },
        spec: { instances: 2 }
      }]
    } as never);
    vi.mocked(k8sClient.customObjects.patchNamespacedCustomObject)
      .mockImplementation(async ({ body }: any) => ({
        metadata: {
          uid: 'uid-1',
          resourceVersion: '8',
          annotations: body.find((operation: any) => operation.path === '/metadata/annotations').value
        },
        spec: { instances: 3 }
      }) as never);
    const request = patchCustomResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Increase database capacity',
      operations: [{ op: 'replace', path: '/spec/instances', value: 3 }]
    });

    const result = await patchCustomResourceHandler(request, { operationId: 'op-1' } as never);

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

  it('gets and watches configured custom resources', async () => {
    vi.mocked(k8sClient.customObjects.getNamespacedCustomObject).mockResolvedValue({
      apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
      metadata: { name: 'db', namespace: 'payments', uid: 'uid-1', resourceVersion: '7' },
      status: { phase: 'Ready' }
    } as never);
    const fetched = await getCustomResourceHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db'
    });
    expect(fetched.object).toMatchObject({ metadata: { name: 'db' }, status: { phase: 'Ready' } });

    const abort = vi.fn();
    const watch = vi.fn(async (_path, _query, onEvent, done) => {
      onEvent('MODIFIED', { metadata: { name: 'db', resourceVersion: '8' }, status: { phase: 'Ready' } });
      done();
      return { abort } as AbortController;
    });
    const watched = await watchCustomResourcesHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', timeout_seconds: 1, limit: 1
    }, undefined, { watch });
    expect(watch).toHaveBeenCalledWith(
      '/apis/postgresql.cnpg.io/v1/namespaces/payments/clusters',
      expect.objectContaining({ timeoutSeconds: 1 }),
      expect.any(Function),
      expect.any(Function)
    );
    expect(watched.events).toHaveLength(1);
  });

  it('dry-runs and creates and deletes configured custom resources', async () => {
    vi.mocked(k8sClient.customObjects.createNamespacedCustomObject).mockResolvedValue({
      metadata: { name: 'db', uid: 'uid-1', resourceVersion: '7' }
    } as never);
    const created = await createCustomResourceHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', reason: 'Create database cluster',
      body: { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name: 'db' }, spec: { instances: 2 } }
    }, { operationId: 'op-1' } as never);
    expect(k8sClient.customObjects.createNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(k8sClient.customObjects.createNamespacedCustomObject).mock.calls[0]?.[0]).toMatchObject({ dryRun: 'All' });
    expect(created).toMatchObject({ change: { type: 'create' }, target: { name: 'db', uid: 'uid-1' } });

    vi.mocked(k8sClient.customObjects.deleteNamespacedCustomObject).mockResolvedValue({} as never);
    const deleted = await deleteCustomResourceHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Remove database cluster'
    }, { operationId: 'op-2' } as never);
    expect(k8sClient.customObjects.deleteNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(k8sClient.customObjects.deleteNamespacedCustomObject).mock.calls[0]?.[0]).toMatchObject({
      dryRun: 'All', body: { preconditions: { uid: 'uid-1', resourceVersion: '7' } }
    });
    expect(deleted).toMatchObject({ change: { type: 'delete' }, target: { name: 'db', uid: 'uid-1' } });
  });

  it('rejects a create body whose namespace conflicts with the requested scope', async () => {
    await expect(createCustomResourceHandler({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', reason: 'Create database cluster',
      body: { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name: 'db', namespace: 'other' } }
    })).rejects.toThrow('metadata.namespace must match namespace');

    expect(k8sClient.customObjects.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('rejects unconfigured resources, status patches, and writes when access is read-only', async () => {
    await expect(listCustomResourcesHandler({ addition_key: 'cnpg', resource: 'backups', namespace: 'payments', limit: 50 }))
      .rejects.toThrow('is not enabled');
    expect(() => patchCustomResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Change status',
      operations: [{ op: 'replace', path: '/status/phase', value: 'Ready' }]
    })).toThrow('/spec');
    expect(() => patchCustomResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Change instance list',
      operations: [{ op: 'remove', path: '/spec/instances/0' }]
    })).toThrow('Array-element');
    config.ACORNOPS_AGENT_WRITE_ENABLED = false;
    await expect(patchCustomResourceHandler(patchCustomResourceSchema.parse({
      addition_key: 'cnpg', resource: 'clusters', namespace: 'payments', name: 'db',
      expected_uid: 'uid-1', expected_resource_version: '7', reason: 'Increase database capacity',
      operations: [{ op: 'replace', path: '/spec/instances', value: 3 }]
    }))).rejects.toThrow('Write operations are disabled');
  });
});
