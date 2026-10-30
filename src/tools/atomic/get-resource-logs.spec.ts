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
  it.each([
    'log "unterminated\n{"password":"fixture-secret"}',
    'password=first"fixture-secret"',
    'password=\'first "fixture-secret" tail\'',
    '{"Bearer fixture-secret":"ready"}',
  ])('preserves legacy redaction across quoted-token boundaries: %s', (input) => {
    const output = redactLogSecrets(input);
    expect(output).not.toContain('fixture-secret');
    expect(output).toContain('<redacted');
    expect(redactLogSecrets(output)).toBe(output);
  });

  it.each([
    ['JSON', '{"password":"fixture-secret","count":3}', '{"password":"<redacted>","count":3}'],
    ['JSONL', '{"api_key":"fixture-secret"}\n{"status":"ready"}\n', '{"api_key":"<redacted>"}\n{"status":"ready"}\n'],
    ['prefixed JSON', 'time INFO {"token":"fixture-secret","status":"ready"}', 'time INFO {"token":"<redacted>","status":"ready"}'],
    ['nested value', '{"secret":{"parts":["fixture-secret"]},"ok":true}', '{"secret":"<redacted>","ok":true}'],
    ['escaped value', '{"password":"fixture-\\"secret","ok":true}', '{"password":"<redacted>","ok":true}'],
    ['escaped key', '{"pass\\u0077ord":"fixture-secret","ok":true}', '{"pass\\u0077ord":"<redacted>","ok":true}'],
    ['safe text', 'ready 🙂\n{"message":"normal", "count":2}', 'ready 🙂\n{"message":"normal", "count":2}'],
  ])('redacts %s without changing unrelated log evidence', (_name, input, expected) => {
    expect(redactLogSecrets(input)).toBe(expected);
    expect(redactLogSecrets(expected)).toBe(expected);
  });

  it.each([
    '{"password":"fixture-secret',
    '{"password":{\n"part":"fixture-secret"',
    '-----BEGIN PRIVATE KEY-----\nfixture-secret',
    JSON.stringify({ message: JSON.stringify({ password: 'fixture-secret', ok: true }) }),
    JSON.stringify({ message: JSON.stringify({ message: JSON.stringify({ password: 'fixture-secret' }) }) }),
  ])('withholds secrets in truncated or encoded log content', (input) => {
    const output = redactLogSecrets(input);
    expect(output).not.toContain('fixture-secret');
    expect(output).toContain('<redacted');
    expect(redactLogSecrets(output)).toBe(output);
  });

  it('sanitizes JSON strings containing ordinary assignment credentials without corrupting JSON', () => {
    expect(JSON.parse(redactLogSecrets('{"message":"password=fixture-secret","ok":true}')))
      .toEqual({ message: 'password=<redacted>', ok: true });
  });

  it('preserves large harmless JSONL within the pod-log byte ceiling', () => {
    const logs = '{"level":"info","message":"request completed","status":200}\n'.repeat(12000);
    expect(Buffer.byteLength(logs)).toBeLessThan(1024 * 1024);
    expect(redactLogSecrets(logs)).toBe(logs);
  });

  it('redacts many plain assignments before the next quoted JSON record', () => {
    const plain = 'password=fixture-secret '.repeat(12000);
    const sanitized = 'password=<redacted> '.repeat(12000);
    for (const suffix of ['', '{"password":"fixture-secret","status":"ready"}']) {
      expect(redactLogSecrets(plain + suffix)).toBe(sanitized + suffix.replace('fixture-secret', '<redacted>'));
    }
  });

  it('withholds over-deep sensitive values and encoded strings without exposing their tail', () => {
    const deep = '{"password":' + '['.repeat(33) + '"fixture-secret"' + ']'.repeat(33) + '}';
    let encoded = JSON.stringify({ password: 'fixture-secret' });
    for (let layer = 0; layer < 4; layer += 1) encoded = JSON.stringify({ message: encoded });
    for (const input of [deep, encoded]) {
      const output = redactLogSecrets(input);
      expect(output).not.toContain('fixture-secret');
      expect(output).toContain('<redacted-unparseable-log-segment>');
      expect(redactLogSecrets(output)).toBe(output);
    }
  });

  it('redacts the fetched full result before deriving the model excerpt', async () => {
    const logs = 'safe line\n'.repeat(1200) + '{"api_key":"fixture-secret","status":"ready"}\n';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(logs, { status: 200 }));
    const params = { name: 'api', namespace: 'default', previous: false, tail_lines: 200, limit_bytes: 1024 * 1024 };
    const result = await getResourceLogsTool.handler(params);
    const projected = getResourceLogsTool.projectForModel(result, params);
    expect(result.logs).not.toContain('fixture-secret');
    expect(projected.data.logExcerpt).not.toContain('fixture-secret');
    expect(projected.data.logExcerpt).toContain('"status":"ready"');
    expect(Buffer.byteLength(String(projected.data.logExcerpt))).toBeLessThanOrEqual(8192);
    expect(projected.omissions).toHaveLength(1);
  });

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
