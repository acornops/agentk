import { beforeEach, describe, expect, it, vi } from 'vitest';

const { k8sClient, watchCalls } = vi.hoisted(() => {
  const watchCalls: Array<{
    path: string;
    query: Record<string, unknown>;
    callback: (phase: string, obj: any, watchObj?: any) => void;
    done: (err: any) => void;
    abort: AbortController;
  }> = [];

  const emptyList = vi.fn(async () => ({ items: [], metadata: { resourceVersion: '1' } }));
  return {
    watchCalls,
    k8sClient: {
      kc: {},
      core: {
        listPodForAllNamespaces: vi.fn(async () => ({ items: [{ metadata: { name: 'pod1', namespace: 'default', resourceVersion: '1' } }], metadata: { resourceVersion: '10' } })),
        listNamespacedPod: vi.fn(async ({ namespace }: { namespace: string }) => ({ items: [{ metadata: { name: `${namespace}-pod`, namespace, resourceVersion: '1' } }], metadata: { resourceVersion: '11' } })),
        listServiceForAllNamespaces: emptyList,
        listNamespacedService: emptyList,
        listPersistentVolumeClaimForAllNamespaces: emptyList,
        listNamespacedPersistentVolumeClaim: emptyList,
        listNode: emptyList,
        listNamespace: emptyList,
        listEventForAllNamespaces: vi.fn(async () => ({ items: [], metadata: { resourceVersion: '20' } })),
        listNamespacedEvent: vi.fn(async () => ({ items: [], metadata: { resourceVersion: '21' } })),
      },
      apps: {
        listDeploymentForAllNamespaces: emptyList,
        listNamespacedDeployment: emptyList,
        listStatefulSetForAllNamespaces: emptyList,
        listNamespacedStatefulSet: emptyList,
        listDaemonSetForAllNamespaces: emptyList,
        listNamespacedDaemonSet: emptyList,
      },
      batch: {
        listCronJobForAllNamespaces: emptyList,
        listNamespacedCronJob: emptyList,
        listJobForAllNamespaces: emptyList,
        listNamespacedJob: emptyList,
      },
      networking: {
        listIngressForAllNamespaces: emptyList,
        listNamespacedIngress: emptyList,
      },
    },
  };
});

vi.mock('../../config.js', () => ({
  DEFAULT_EXCLUDED_NAMESPACES: ['kube-node-lease', 'kube-public'],
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'error',
    ACORNOPS_AGENT_WATCH_CACHE_ENABLED: true,
    ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS: 5,
    ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS: 300,
    ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT: 500,
    ACORNOPS_AGENT_K8S_CONCURRENCY: 8,
  }
}));
vi.mock('../../k8s/client.js', () => ({ k8sClient }));

import { setNamespaceScope } from '../../runtime/namespace-scope.js';
import { WatchManager } from './watch-manager.js';
import { WatchStore } from './watch-store.js';

function createWatchClient() {
  return {
    watch: vi.fn(async (
      path: string,
      query: Record<string, unknown>,
      callback: (phase: string, obj: any, watchObj?: any) => void,
      done: (err: any) => void
    ) => {
      const abort = new AbortController();
      watchCalls.push({ path, query, callback, done, abort });
      return abort;
    })
  };
}

describe('WatchManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchCalls.length = 0;
    setNamespaceScope({ include: [], exclude: [] });
  });

  it('performs initial list-then-watch sync and updates the cache from watch events', async () => {
    const store = new WatchStore();
    const trigger = vi.fn();
    const watchClient = createWatchClient();
    new WatchManager(store, trigger, watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    expect(store.getResourceSnapshot()?.pods.map((pod) => pod.metadata.name)).toEqual(['pod1']);

    const podWatch = watchCalls.find((call) => call.path === '/api/v1/pods')!;
    expect(podWatch.query).toMatchObject({ resourceVersion: '10', allowWatchBookmarks: true, timeoutSeconds: 300 });
    podWatch.callback('MODIFIED', { metadata: { name: 'pod1', namespace: 'default', resourceVersion: '12' }, status: { phase: 'Running' } });
    await vi.advanceTimersByTimeAsync(5);

    expect(store.getResourceSnapshot()?.pods[0].status.phase).toBe('Running');
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('does not trigger snapshots for bookmark events', async () => {
    const store = new WatchStore();
    const trigger = vi.fn();
    const watchClient = createWatchClient();
    new WatchManager(store, trigger, watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    watchCalls.find((call) => call.path === '/api/v1/pods')!.callback('BOOKMARK', {
      metadata: { resourceVersion: '15' }
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(trigger).not.toHaveBeenCalled();
  });

  it('re-lists and restarts a watch when Kubernetes reports resourceVersion compaction', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    const initialListCount = vi.mocked(k8sClient.core.listPodForAllNamespaces).mock.calls.length;
    watchCalls.find((call) => call.path === '/api/v1/pods')!.callback('ERROR', {}, { code: 410 });

    await vi.waitFor(() => expect(k8sClient.core.listPodForAllNamespaces).toHaveBeenCalledTimes(initialListCount + 1));
    expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(2);
  });

  it('retries initial namespaced resource sync without falling back to cluster-wide watches', async () => {
    setNamespaceScope({ include: ['default'], exclude: [] });
    vi.mocked(k8sClient.core.listNamespacedPod).mockRejectedValueOnce(new Error('temporary list failure') as never);
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledTimes(1));
    expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(k8sClient.core.listNamespacedPod).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/default/pods')).toBe(true));

    expect(k8sClient.core.listPodForAllNamespaces).not.toHaveBeenCalled();
    expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(false);
  });

  it('retries initial namespaced event sync without falling back to cluster-wide watches', async () => {
    setNamespaceScope({ include: ['default'], exclude: [] });
    vi.mocked(k8sClient.core.listNamespacedEvent).mockRejectedValueOnce(new Error('temporary event list failure') as never);
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(k8sClient.core.listNamespacedEvent).toHaveBeenCalledTimes(1));
    expect(watchCalls.some((call) => call.path === '/api/v1/events')).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(k8sClient.core.listNamespacedEvent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/default/events')).toBe(true));

    expect(k8sClient.core.listEventForAllNamespaces).not.toHaveBeenCalled();
    expect(watchCalls.some((call) => call.path === '/api/v1/events')).toBe(false);
  });

  it('re-lists only the affected namespaced event watch when it expires', async () => {
    setNamespaceScope({ include: ['default', 'payments'], exclude: [] });
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/default/events')).toBe(true));
    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/payments/events')).toBe(true));
    const initialEventListCount = vi.mocked(k8sClient.core.listNamespacedEvent).mock.calls.length;

    watchCalls.find((call) => call.path === '/api/v1/namespaces/default/events')!.callback('ERROR', {}, { code: 410 });

    await vi.waitFor(() => expect(k8sClient.core.listNamespacedEvent).toHaveBeenCalledTimes(initialEventListCount + 1));
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/namespaces/default/events')).toHaveLength(2));

    expect(watchCalls.filter((call) => call.path === '/api/v1/namespaces/payments/events')).toHaveLength(1);
    expect(vi.mocked(k8sClient.core.listNamespacedEvent).mock.calls.at(-1)?.[0]).toMatchObject({
      namespace: 'default',
      fieldSelector: 'type=Warning',
    });
  });

  it('retries a failed compaction relist before opening a replacement watch', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    const initialListCount = vi.mocked(k8sClient.core.listPodForAllNamespaces).mock.calls.length;
    vi.mocked(k8sClient.core.listPodForAllNamespaces).mockRejectedValueOnce(new Error('temporary relist failure') as never);
    watchCalls.find((call) => call.path === '/api/v1/pods')!.callback('ERROR', {}, { code: 410 });

    await vi.waitFor(() => expect(k8sClient.core.listPodForAllNamespaces).toHaveBeenCalledTimes(initialListCount + 1));
    expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(k8sClient.core.listPodForAllNamespaces).toHaveBeenCalledTimes(initialListCount + 2));
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(2));
  });

  it('reconnects non-410 watch closures without clearing the existing cache', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    const podWatch = watchCalls.find((call) => call.path === '/api/v1/pods')!;
    podWatch.callback('BOOKMARK', { metadata: { resourceVersion: '15' } });
    podWatch.done(new Error('network closed'));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(2));

    const reconnect = watchCalls.filter((call) => call.path === '/api/v1/pods').at(-1)!;
    expect(reconnect.query.resourceVersion).toBe('15');
    expect(store.getResourceSnapshot()?.pods.map((pod) => pod.metadata.name)).toEqual(['pod1']);
  });

  it('keeps resource cache unhealthy until the affected namespace watch recovers', async () => {
    setNamespaceScope({ include: ['default', 'payments'], exclude: [] });
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/default/pods')).toBe(true));
    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/payments/pods')).toBe(true));

    const defaultPodWatch = watchCalls.find((call) => call.path === '/api/v1/namespaces/default/pods')!;
    const paymentsPodWatch = watchCalls.find((call) => call.path === '/api/v1/namespaces/payments/pods')!;
    defaultPodWatch.callback('ERROR', {}, { code: 500, message: 'default namespace watch failed' });
    paymentsPodWatch.callback('MODIFIED', {
      metadata: { name: 'payments-pod', namespace: 'payments', resourceVersion: '16' },
      status: { phase: 'Running' },
    });

    expect(store.getResourceSnapshot()).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/namespaces/default/pods')).toHaveLength(2));
    expect(store.getResourceSnapshot()?.pods.map((pod) => pod.metadata.namespace)).toEqual(['default', 'payments']);
  });

  it('keeps the cache healthy across clean resource watch timeouts', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    const podWatch = watchCalls.find((call) => call.path === '/api/v1/pods')!;
    podWatch.callback('BOOKMARK', { metadata: { resourceVersion: '15' } });
    podWatch.done(null);

    expect(store.getResourceSnapshot()?.pods.map((pod) => pod.metadata.name)).toEqual(['pod1']);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(2));

    const reconnect = watchCalls.filter((call) => call.path === '/api/v1/pods').at(-1)!;
    expect(reconnect.query.resourceVersion).toBe('15');
    expect(store.getResourceSnapshot()?.pods.map((pod) => pod.metadata.name)).toEqual(['pod1']);
  });

  it('reconnects non-410 resource ERROR events without waiting for stream close', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/pods')).toBe(true));
    const podWatch = watchCalls.find((call) => call.path === '/api/v1/pods')!;
    const abort = vi.spyOn(podWatch.abort, 'abort');
    podWatch.callback('BOOKMARK', { metadata: { resourceVersion: '15' } });
    podWatch.callback('ERROR', {}, { code: 500, message: 'temporary watch failure' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/pods')).toHaveLength(2));

    const reconnect = watchCalls.filter((call) => call.path === '/api/v1/pods').at(-1)!;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reconnect.query.resourceVersion).toBe('15');
  });

  it('reconnects non-410 event ERROR events without waiting for stream close', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/events')).toBe(true));
    const eventWatch = watchCalls.find((call) => call.path === '/api/v1/events')!;
    const abort = vi.spyOn(eventWatch.abort, 'abort');
    eventWatch.callback('ERROR', {}, { code: 500, message: 'temporary event watch failure' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/events')).toHaveLength(2));

    const reconnect = watchCalls.filter((call) => call.path === '/api/v1/events').at(-1)!;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reconnect.query.resourceVersion).toBe('20');
  });

  it('keeps event cache unhealthy until the affected namespace event watch recovers', async () => {
    setNamespaceScope({ include: ['default', 'payments'], exclude: [] });
    const store = new WatchStore();
    const watchClient = createWatchClient();
    new WatchManager(store, vi.fn(), watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/default/events')).toBe(true));
    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/namespaces/payments/events')).toBe(true));

    const defaultEventWatch = watchCalls.find((call) => call.path === '/api/v1/namespaces/default/events')!;
    const paymentsEventWatch = watchCalls.find((call) => call.path === '/api/v1/namespaces/payments/events')!;
    defaultEventWatch.callback('ERROR', {}, { code: 500, message: 'default event watch failed' });
    paymentsEventWatch.callback('ADDED', {
      metadata: { uid: 'event-uid-1', name: 'payments-warning', namespace: 'payments', resourceVersion: '22' },
      involvedObject: { kind: 'Pod', name: 'payments-pod', namespace: 'payments' },
      reason: 'BackOff',
      message: 'payment pod warning',
      type: 'Warning',
      lastTimestamp: new Date().toISOString(),
    });

    expect(store.getRecentEvents(60000)).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(watchCalls.filter((call) => call.path === '/api/v1/namespaces/default/events')).toHaveLength(2));
    expect(store.getRecentEvents(60000)?.map((event) => event.metadata.namespace)).toEqual(['payments']);
  });

  it('removes cached warning events when the event watch reports deletion', async () => {
    const store = new WatchStore();
    const trigger = vi.fn();
    const watchClient = createWatchClient();
    new WatchManager(store, trigger, watchClient as never).start();

    await vi.waitFor(() => expect(watchCalls.some((call) => call.path === '/api/v1/events')).toBe(true));
    const eventWatch = watchCalls.find((call) => call.path === '/api/v1/events')!;
    const event = {
      metadata: { uid: 'event-uid-1', name: 'pod-warning', namespace: 'default', resourceVersion: '21' },
      involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default' },
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      lastTimestamp: new Date().toISOString(),
    };

    eventWatch.callback('ADDED', event);
    await vi.advanceTimersByTimeAsync(5);
    expect(store.getRecentEvents(60000)).toHaveLength(1);

    eventWatch.callback('DELETED', { ...event, metadata: { ...event.metadata, resourceVersion: '22' } });
    await vi.advanceTimersByTimeAsync(5);

    expect(store.getRecentEvents(60000)).toEqual([]);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('aborts active watches and suppresses reconnects after stop', async () => {
    const store = new WatchStore();
    const watchClient = createWatchClient();
    const manager = new WatchManager(store, vi.fn(), watchClient as never);
    manager.start();

    await vi.waitFor(() => expect(watchCalls.length).toBeGreaterThan(0));
    const aborts = watchCalls.map((call) => vi.spyOn(call.abort, 'abort'));
    manager.stop();
    watchCalls[0]!.done(new Error('closed'));
    await vi.advanceTimersByTimeAsync(30000);

    expect(aborts.some((abort) => abort.mock.calls.length > 0)).toBe(true);
    expect(watchClient.watch).toHaveBeenCalledTimes(watchCalls.length);
  });
});
