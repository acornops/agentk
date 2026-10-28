import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceLogsTool, readPodLogsText, redactLogSecrets } from './get-resource-logs.js';
import { k8sClient } from '../../k8s/client.js';
import fetch, { Headers, Response } from 'node-fetch';

vi.mock('node-fetch', async () => {
  const actual = await vi.importActual<typeof import('node-fetch')>('node-fetch');
  return {
    ...actual,
    default: vi.fn()
  };
});

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    kc: {
      getCurrentCluster: vi.fn(),
      applyToFetchOptions: vi.fn()
    },
    core: {
      readNamespacedPodLog: vi.fn()
    }
  }
}));

describe('Get Resource Logs Tool', () => {
  it('redacts common credentials before model and artifact handling', () => {
    const value = redactLogSecrets(
      'Authorization: Bearer abc.def Basic dXNlcjpwYXNz password=hunter2 '
      + 'client_secret="client value" AWS_SECRET_ACCESS_KEY=aws-value AWS_ACCESS_KEY_ID=AKIAEXAMPLE '
      + 'postgresql://db-user:db-password@database.example/app https://user:secret@example.com'
    );
    expect(value).not.toContain('abc.def');
    expect(value).not.toContain('dXNlcjpwYXNz');
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('client value');
    expect(value).not.toContain('aws-value');
    expect(value).not.toContain('AKIAEXAMPLE');
    expect(value).not.toContain('db-user:db-password@');
    expect(value).not.toContain('user:secret@');
    expect(value).toContain('<redacted>');
  });

  beforeEach(() => {
    vi.mocked(k8sClient.kc.getCurrentCluster).mockReturnValue({ server: 'https://kube.example' } as never);
    vi.mocked(k8sClient.kc.applyToFetchOptions).mockResolvedValue({
      headers: { authorization: 'Bearer test-token' }
    } as never);
    vi.mocked(fetch).mockResolvedValue(new Response('pod log text', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads pod logs as raw text instead of using the generated Kubernetes parser', async () => {
    const result = await getResourceLogsTool.handler({
      name: 'api-pod',
      namespace: 'default',
      container: 'api',
      previous: true,
      tail_lines: 300,
      since_seconds: 60,
      limit_bytes: 2048
    });

    expect(result).toEqual({
      name: 'api-pod',
      namespace: 'default',
      container: 'api',
      logs: 'pod log text'
    });
    expect(k8sClient.core.readNamespacedPodLog).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://kube.example/api/v1/namespaces/default/pods/api-pod/log?container=api&previous=true&tailLines=300&sinceSeconds=60&limitBytes=2048',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers)
      })
    );
  });

  it('returns the body even when Kubernetes omits a content-type header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('plain text without a content-type', { status: 200 }));

    await expect(
      readPodLogsText('pod name', 'default', {
        previous: false,
        tail_lines: 100,
        limit_bytes: 1024
      })
    ).resolves.toBe('plain text without a content-type');
  });

  it('does not surface Kubernetes error bodies when log retrieval fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('pods "missing" not found', { status: 404 }));

    await expect(
      readPodLogsText('missing', 'default', {
        previous: false,
        tail_lines: 100,
        limit_bytes: 1024
      })
    ).rejects.toThrow('Kubernetes pod log request failed with status 404');
  });

  it.each(['json', 'text'])('classifies a waiting container from a %s error without exposing upstream details', async (format) => {
    const message = 'container "api" in pod "private-pod" is waiting to start: trying and failing to pull image private-registry/image';
    const body = format === 'json'
      ? JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, reason: 'BadRequest', code: 400 })
      : message;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 400 }));

    await expect(readPodLogsText('private-pod', 'default', {
      previous: false, tail_lines: 100, limit_bytes: 1024,
    })).rejects.toMatchObject({
      toolCode: 'PRECONDITION_FAILED',
      message: 'No logs yet; this container has not started.',
      data: { status: 400, reason: 'ContainerNotStarted', phase: 'kubernetes_api' },
    });
  });

  it.each([
    [400, 'previous terminated container "api" in pod "api-pod" not found'],
    [400, 'container "invalid" is not valid for pod "api-pod"'],
    [403, 'container "api" in pod "api-pod" is waiting to start: forbidden'],
  ])('does not turn other log errors (%s) into a waiting-container result', async (status, message) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message }), { status }));

    await expect(readPodLogsText('api-pod', 'default', {
      previous: false, tail_lines: 100, limit_bytes: 1024,
    })).rejects.toThrow(`Kubernetes pod log request failed with status ${status}`);
  });

  it('rejects an upstream log body larger than the hard output limit', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));

    await expect(readPodLogsText('api', 'default', {
      previous: false,
      tail_lines: 100,
      limit_bytes: 1024 * 1024,
    })).rejects.toMatchObject({ toolCode: 'OUTPUT_TOO_LARGE' });
  });

  it('projects a UTF-8-safe bounded tail with requested and returned counts', () => {
    const logs = `${'line\n'.repeat(2000)}${'🙂'.repeat(3000)}`;
    const context = getResourceLogsTool.projectForModel(
      { name: 'api', namespace: 'default', container: 'api', logs },
      { previous: false, tail_lines: 5000, since_seconds: 60, limit_bytes: 1024 * 1024 }
    );

    expect(Buffer.byteLength(String(context.data.logExcerpt))).toBeLessThanOrEqual(8 * 1024);
    expect(String(context.data.logExcerpt)).not.toContain('�');
    expect(context.data).toMatchObject({
      requested: { previous: false, tailLines: 5000, sinceSeconds: 60, limitBytes: 1024 * 1024 },
      returnedBytes: Buffer.byteLength(logs),
    });
    expect(context.omissions).toHaveLength(1);
  });

  it('reports effective request defaults in the model projection', () => {
    const context = getResourceLogsTool.projectForModel(
      { name: 'api', namespace: 'default', container: '', logs: 'ready\n' },
      {}
    );

    expect(context.data.requested).toEqual({
      previous: false,
      tailLines: 200,
      sinceSeconds: null,
      limitBytes: 1024 * 1024,
    });
  });
});
