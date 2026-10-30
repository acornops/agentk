import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import * as k8s from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { createLeaseApi } from './lease-api.js';

async function withApi(
  handle: (response: ServerResponse, method?: string, authorization?: string) => void,
  run: (api: ReturnType<typeof createLeaseApi>) => Promise<void>,
) {
  const server = createServer((request, response) => handle(response, request.method, request.headers.authorization));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = new k8s.KubeConfig();
  config.loadFromOptions({
    // Only this synthetic loopback fixture permits HTTP; production config is untouched.
    clusters: [{ name: 'fixture', server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, skipTLSVerify: true }],
    users: [{ name: 'fixture', token: 'synthetic-only' }],
    contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }], currentContext: 'fixture',
  });
  try { await run(createLeaseApi(config.makeApiClient(k8s.CoordinationV1Api))); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('cancellable Kubernetes Lease transport', () => {
  it('retains kubeconfig authentication on read, create and replace', async () => {
    const methods: string[] = [];
    await withApi((response, method, authorization) => {
      expect(authorization).toBe('Bearer synthetic-only');
      methods.push(method!);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ metadata: { resourceVersion: '1' }, spec: { holderIdentity: 'fixture' } }));
    }, async (api) => {
      const signal = new AbortController().signal;
      expect((await api.readNamespacedLease('lease', 'test', signal)).metadata?.resourceVersion).toBe('1');
      await api.createNamespacedLease('test', { spec: { holderIdentity: 'fixture' } }, signal);
      await api.replaceNamespacedLease('lease', 'test', { spec: { holderIdentity: 'fixture' } }, signal);
    });
    expect(methods).toEqual(['GET', 'POST', 'PUT']);
  });

  for (const partialBody of [false, true]) {
    it(`aborts a stalled ${partialBody ? 'response body' : 'response header'} and closes the socket`, async () => {
      const controller = new AbortController();
      let closed!: Promise<unknown>;
      let received = false;
      await withApi((response) => {
        received = true;
        closed = once(response, 'close');
        if (partialBody) {
          response.setHeader('content-type', 'application/json');
          response.write('{"metadata":');
        }
        setTimeout(() => controller.abort(), 50);
      }, async (api) => {
        await expect(api.readNamespacedLease('lease', 'test', controller.signal)).rejects.toThrow(/abort/i);
        expect(received).toBe(true);
        await closed;
      });
    }, 5000);
  }
});
