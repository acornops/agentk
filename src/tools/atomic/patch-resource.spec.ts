import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    apps: {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      patchNamespacedStatefulSet: vi.fn(),
      patchNamespacedDaemonSet: vi.fn(),
    },
    batch: {
      readNamespacedCronJob: vi.fn(),
      patchNamespacedCronJob: vi.fn(),
    },
    core: {
      readNamespacedService: vi.fn(),
      patchNamespacedService: vi.fn(),
    },
    networking: {
      readNamespacedIngress: vi.fn(),
      patchNamespacedIngress: vi.fn(),
    },
  },
}));

import { config } from '../../config.js';
import { k8sClient } from '../../k8s/client.js';
import { ToolExecutionError } from '../errors.js';
import { patchResourceHandler, patchResourceSchema, patchResourceTool, PatchResourceRequest } from './patch-resource.js';

function deployment(image = 'registry.example.com/api:bad') {
  return {
    metadata: {
      name: 'api', namespace: 'team-a', uid: 'uid-1', resourceVersion: '10', generation: 2,
      labels: { app: 'api' }, annotations: {},
    },
    spec: {
      selector: { matchLabels: { app: 'api' } },
      template: {
        metadata: { labels: { app: 'api' }, annotations: {} },
        spec: {
          containers: [{ name: 'api', image }],
          initContainers: [{ name: 'setup', image: 'registry.example.com/setup:v1' }],
        },
      },
    },
  };
}

function parseRequest(overrides: Record<string, unknown> = {}): PatchResourceRequest {
  return patchResourceSchema.parse({
    kind: 'Deployment',
    namespace: 'team-a',
    name: 'api',
    expected_uid: 'uid-1',
    reason: 'Correct the workload image',
    changes: [{
      type: 'set_image', container_type: 'container', container: 'api',
      expected_image: 'registry.example.com/api:bad', image: 'registry.example.com/api:v2',
    }],
    ...overrides,
  });
}

function patchedDeployment(image = 'registry.example.com/api:v2') {
  const result = deployment(image);
  result.metadata.resourceVersion = '11';
  result.metadata.generation = 3;
  return result;
}

function returnPatchedResource(method: ReturnType<typeof vi.fn>, result: any) {
  method.mockImplementation(async (options: any) => {
    const response = structuredClone(result);
    const annotationPatch = options.body.find((operation: any) => operation.path === '/metadata/annotations');
    response.metadata.annotations = annotationPatch?.value || {};
    return response;
  });
}

describe('patchResourceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.ACORNOPS_AGENT_WRITE_ENABLED = true;
    config.ACORNOPS_AGENT_PATCH_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];
    config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH = false;
  });

  it('dry-runs and applies the identical guarded image patch', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    returnPatchedResource(vi.mocked(k8sClient.apps.patchNamespacedDeployment) as any, patchedDeployment());

    const result = await patchResourceHandler(parseRequest(), { operationId: 'op-1', requestId: 1, sessionGeneration: 1 });

    expect(result).toMatchObject({
      success: true,
      operationId: 'op-1',
      target: { kind: 'Deployment', namespace: 'team-a', name: 'api', uid: 'uid-1' },
      change: { type: 'patch', changeCount: 1, rolloutTriggered: true, serviceRoutingChanged: false },
      observed: { resourceVersion: '11', generation: 3 },
    });
    expect(result).not.toHaveProperty('spec');
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledTimes(2);
    const dryRun = vi.mocked(k8sClient.apps.patchNamespacedDeployment).mock.calls[0]![0] as any;
    const apply = vi.mocked(k8sClient.apps.patchNamespacedDeployment).mock.calls[1]![0] as any;
    expect(dryRun).toMatchObject({ name: 'api', namespace: 'team-a', dryRun: 'All', fieldValidation: 'Strict' });
    expect(apply.dryRun).toBeUndefined();
    expect(apply.body).toEqual(dryRun.body);
    expect(apply.body.slice(0, 2)).toEqual([
      { op: 'test', path: '/metadata/uid', value: 'uid-1' },
      { op: 'test', path: '/metadata/resourceVersion', value: '10' },
    ]);
    expect(apply.body).toContainEqual({ op: 'test', path: '/spec/template/spec/containers/0/name', value: 'api' });
    expect(apply.body).toContainEqual({ op: 'replace', path: '/spec/template/spec/containers/0/image', value: 'registry.example.com/api:v2' });
  });

  it('returns an idempotent receipt without repeating a completed mutation', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValueOnce(deployment() as never);
    returnPatchedResource(vi.mocked(k8sClient.apps.patchNamespacedDeployment) as any, patchedDeployment());
    const request = parseRequest();
    await patchResourceHandler(request, { operationId: 'op-1', requestId: 1, sessionGeneration: 1 });
    const appliedBody = vi.mocked(k8sClient.apps.patchNamespacedDeployment).mock.calls[1]![0].body as any[];
    const annotations = appliedBody.find((operation) => operation.path === '/metadata/annotations')!.value;
    const completed = patchedDeployment();
    completed.metadata.annotations = annotations;
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValueOnce(completed as never);

    await expect(patchResourceHandler(request, { operationId: 'op-1', requestId: 1, sessionGeneration: 1 }))
      .resolves.toMatchObject({ success: true, operationId: 'op-1' });
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledTimes(2);
  });

  it('fails closed when UID or expected current values changed', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue({
      ...deployment('registry.example.com/api:v3'),
      metadata: { ...deployment().metadata, uid: 'replacement-uid' },
    } as never);
    await expect(patchResourceHandler(parseRequest())).rejects.toThrow('UID does not match');
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();

    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment('registry.example.com/api:v3') as never);
    await expect(patchResourceHandler(parseRequest())).rejects.toThrow('Current value changed');
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('rejects pod-template label changes that break a workload selector', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    const request = parseRequest({
      changes: [{ type: 'set_label', scope: 'pod_template', key: 'app', expected_value: 'api', value: 'other' }],
    });

    await expect(patchResourceHandler(request)).rejects.toThrow('would no longer match');
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('uses Kubernetes NotIn semantics when validating workload selectors', async () => {
    const current = deployment();
    current.spec.selector = { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['frontend'] }] } as any;
    current.spec.template.metadata.labels.tier = 'backend';
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(current as never);
    const request = parseRequest({
      changes: [{ type: 'remove_label', scope: 'pod_template', key: 'tier', expected_value: 'backend' }],
    });

    await expect(patchResourceHandler(request)).rejects.toThrow('would no longer match');
    expect(k8sClient.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('rejects a dry-run response when admission breaks a workload selector', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    const admitted = patchedDeployment();
    admitted.spec.template.metadata.labels.app = 'admission-rewrite';
    returnPatchedResource(vi.mocked(k8sClient.apps.patchNamespacedDeployment) as any, admitted);

    await expect(patchResourceHandler(parseRequest())).rejects.toThrow('dry-run returned an inconsistent');
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledOnce();
  });

  it('does not apply when Kubernetes dry-run fails', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockRejectedValueOnce(new Error('admission denied'));

    await expect(patchResourceHandler(parseRequest())).rejects.toThrow('admission denied');
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledOnce();
  });

  it('does not start the real mutation when the deadline expires during dry-run', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    const controller = new AbortController();
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockImplementationOnce(async (options: any) => {
      const response = patchedDeployment();
      const annotationPatch = options.body.find((operation: any) => operation.path === '/metadata/annotations');
      response.metadata.annotations = annotationPatch.value;
      controller.abort();
      return response as never;
    });

    const error = await patchResourceHandler(parseRequest(), {
      operationId: 'op-timeout', requestId: 1, sessionGeneration: 1, signal: controller.signal,
    }).catch((cause) => cause);

    expect(error).toMatchObject({
      toolCode: 'TOOL_TIMEOUT',
      data: { outcome: 'not_started', operationId: 'op-timeout' },
    });
    expect(k8sClient.apps.patchNamespacedDeployment).toHaveBeenCalledOnce();
  });

  it('reports an unknown outcome when the real patch response cannot be verified', async () => {
    vi.mocked(k8sClient.apps.readNamespacedDeployment).mockResolvedValue(deployment() as never);
    returnPatchedResource(vi.mocked(k8sClient.apps.patchNamespacedDeployment) as any, patchedDeployment());
    vi.mocked(k8sClient.apps.patchNamespacedDeployment).mockImplementationOnce(async (options: any) => {
      const response = patchedDeployment();
      const annotationPatch = options.body.find((operation: any) => operation.path === '/metadata/annotations');
      response.metadata.annotations = annotationPatch.value;
      return response as never;
    }).mockResolvedValueOnce(patchedDeployment() as never);

    const error = await patchResourceHandler(
      parseRequest(),
      { operationId: 'op-unknown', requestId: 1, sessionGeneration: 1 }
    ).catch((cause) => cause);

    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({
      toolCode: 'KUBERNETES_ERROR',
      data: {
        outcome: 'unknown', operationId: 'op-unknown',
        reason: 'PostWriteVerificationFailed', phase: 'verification',
      },
    });
  });

  it('supports DaemonSet image changes without exposing replica mutation', async () => {
    const current = deployment();
    const updated = patchedDeployment();
    vi.mocked(k8sClient.apps.readNamespacedDaemonSet).mockResolvedValue(current as never);
    returnPatchedResource(vi.mocked(k8sClient.apps.patchNamespacedDaemonSet) as any, updated);
    const request = parseRequest({ kind: 'DaemonSet' });

    await expect(patchResourceHandler(request)).resolves.toMatchObject({ target: { kind: 'DaemonSet' } });
    const body = vi.mocked(k8sClient.apps.patchNamespacedDaemonSet).mock.calls[1]![0].body as any[];
    expect(body.some((operation) => String(operation.path).includes('replicas'))).toBe(false);
  });

  it('uses the CronJob Pod-template path for opt-in image corrections', async () => {
    config.ACORNOPS_AGENT_PATCH_KINDS = [...config.ACORNOPS_AGENT_PATCH_KINDS, 'CronJob'];
    const current = deployment();
    current.spec = { jobTemplate: { spec: { template: current.spec.template } } } as any;
    const updated = patchedDeployment();
    updated.spec = { jobTemplate: { spec: { template: updated.spec.template } } } as any;
    vi.mocked(k8sClient.batch.readNamespacedCronJob).mockResolvedValue(current as never);
    returnPatchedResource(vi.mocked(k8sClient.batch.patchNamespacedCronJob) as any, updated);

    const receipt = await patchResourceHandler(parseRequest({ kind: 'CronJob' }));

    const body = vi.mocked(k8sClient.batch.patchNamespacedCronJob).mock.calls[1]![0].body as any[];
    expect(body).toContainEqual({
      op: 'replace',
      path: '/spec/jobTemplate/spec/template/spec/containers/0/image',
      value: 'registry.example.com/api:v2',
    });
    expect(receipt).toMatchObject({
      change: { rolloutTriggered: false },
      warnings: [expect.stringContaining('future Jobs')],
    });
  });

  it('supports opt-in Ingress metadata annotations without exposing annotation values in receipts', async () => {
    config.ACORNOPS_AGENT_PATCH_KINDS = [...config.ACORNOPS_AGENT_PATCH_KINDS, 'Ingress'];
    const current = { metadata: { uid: 'ingress-uid', resourceVersion: '1', annotations: {} }, spec: { rules: [] } };
    const updated = {
      metadata: { uid: 'ingress-uid', resourceVersion: '2', annotations: { 'nginx.ingress.kubernetes.io/rewrite-target': '/private-route' } },
      spec: { rules: [] },
    };
    vi.mocked(k8sClient.networking.readNamespacedIngress).mockResolvedValue(current as never);
    returnPatchedResource(vi.mocked(k8sClient.networking.patchNamespacedIngress) as any, updated);
    const request = patchResourceSchema.parse({
      kind: 'Ingress', namespace: 'team-a', name: 'web', expected_uid: 'ingress-uid', reason: 'Repair routing annotation',
      changes: [{
        type: 'set_annotation', scope: 'resource', key: 'nginx.ingress.kubernetes.io/rewrite-target',
        expected_value: null, value: '/private-route',
      }],
    });

    const receipt = await patchResourceHandler(request);

    expect(JSON.stringify(receipt)).not.toContain('private-route');
    expect(JSON.stringify(receipt)).not.toContain('Repair routing annotation');
    expect(receipt).toMatchObject({ change: { rolloutTriggered: false, serviceRoutingChanged: false } });
  });

  it('requires local enablement and caller confirmation for Service selector changes', async () => {
    config.ACORNOPS_AGENT_PATCH_KINDS = [...config.ACORNOPS_AGENT_PATCH_KINDS, 'Service'];
    const input = {
      kind: 'Service', namespace: 'team-a', name: 'api', expected_uid: 'service-uid', reason: 'Repair selector',
      changes: [{ type: 'set_service_selector', key: 'app', expected_value: 'wrong', value: 'api' }],
    };
    expect(() => patchResourceSchema.parse(input)).toThrow('operator enablement and caller confirmation');
    config.ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH = true;
    expect(() => patchResourceSchema.parse(input)).toThrow('operator enablement and caller confirmation');

    const request = patchResourceSchema.parse({ ...input, confirm_service_selector_change: true });
    const current = { metadata: { uid: 'service-uid', resourceVersion: '4', annotations: {} }, spec: { type: 'ClusterIP', selector: { app: 'wrong' } } };
    const updated = { metadata: { uid: 'service-uid', resourceVersion: '5', annotations: {} }, spec: { type: 'ClusterIP', selector: { app: 'api' } } };
    vi.mocked(k8sClient.core.readNamespacedService).mockResolvedValue(current as never);
    returnPatchedResource(vi.mocked(k8sClient.core.patchNamespacedService) as any, updated);

    await expect(patchResourceHandler(request)).resolves.toMatchObject({
      change: { type: 'patch', serviceRoutingChanged: true, rolloutTriggered: false },
      warnings: [expect.stringContaining('redirect traffic')],
    });
  });

  it('rejects arbitrary, duplicate, sensitive, and no-op operations at the schema boundary', () => {
    expect(() => parseRequest({ arbitrary: true })).toThrow();
    expect(() => parseRequest({ changes: [
      { type: 'set_label', scope: 'resource', key: 'app', expected_value: 'old', value: 'new' },
      { type: 'remove_label', scope: 'resource', key: 'app', expected_value: 'old' },
    ] })).toThrow('Duplicate patch location');
    expect(() => parseRequest({ changes: [
      { type: 'set_annotation', scope: 'resource', key: 'example.com/api-token', expected_value: null, value: 'secret' },
    ] })).toThrow('protected or sensitive');
    expect(() => parseRequest({ changes: [
      { type: 'set_annotation', scope: 'resource', key: 'example.com/note', expected_value: null, value: 'safe\u202espoofed' },
    ] })).toThrow('control or format');
    expect(() => parseRequest({ changes: [
      { type: 'set_label', scope: 'resource', key: 'acornops.dev/operation-id', expected_value: null, value: 'forged' },
    ] })).toThrow('Label key is protected');
    expect(() => parseRequest({ changes: [
      { type: 'set_image', container_type: 'container', container: 'api', expected_image: 'same:v1', image: 'same:v1' },
    ] })).toThrow('no-op');
  });

  it('projects exact post-write verification guidance', () => {
    const context = patchResourceTool.projectForModel({
      success: true,
      operationId: 'op-1',
      target: { kind: 'Deployment', namespace: 'team-a', name: 'api', uid: 'uid-1' },
      change: { type: 'patch' },
      observed: { resourceVersion: '11' },
    }, {});

    expect(context.data.verification).toEqual({
      tool: 'get_resource',
      target: { kind: 'Deployment', namespace: 'team-a', name: 'api', uid: 'uid-1' },
      instruction: expect.stringContaining('confirm the requested state'),
    });
  });
});
