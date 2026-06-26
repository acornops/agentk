import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EventCollector } from './event-collector.js';
import { k8sClient } from '../../k8s/client.js';
import { setNamespaceScope } from '../../runtime/namespace-scope.js';
import { WatchStore } from '../watch/watch-store.js';

vi.mock('../../k8s/client.js', () => ({
  k8sClient: {
    core: {
      listEventForAllNamespaces: vi.fn(),
      listNamespacedEvent: vi.fn(),
    },
  }
}));

describe('EventCollector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNamespaceScope({ include: [], exclude: [] });
  });

  it('should collect trimmed warning events from the last 60 seconds', async () => {
    const now = Date.now();
    const mockEvents = {
      items: [
        {
          involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
          reason: 'BackOff',
          message: 'Back-off restarting failed container',
          type: 'Warning',
          count: 3,
          firstTimestamp: new Date(now - 30000).toISOString(),
          lastTimestamp: new Date(now - 10000).toISOString(),
          reportingComponent: 'kubelet',
          metadata: { name: 'event1', uid: 'uid1' }
        },
        {
          involvedObject: { kind: 'Pod', name: 'pod2', namespace: 'default' },
          reason: 'Other',
          message: 'Old event',
          type: 'Warning',
          lastTimestamp: new Date(now - 120000).toISOString(),
        }
      ]
    };

    (k8sClient.core.listEventForAllNamespaces as any).mockResolvedValue(mockEvents);

    const collector = new EventCollector();
    const result = await collector.collect();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      involvedObject: {
        kind: 'Pod',
        name: 'pod1',
        namespace: 'default',
        uid: 'pod-uid-1',
      },
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      count: 3,
      firstTimestamp: expect.any(String),
      lastTimestamp: expect.any(String),
      reportingComponent: 'kubelet',
    });
    expect(result[0].metadata).toBeUndefined();
  });

  it('collects warning events for each configured namespace', async () => {
    setNamespaceScope({ include: ['default', 'payments'], exclude: [] });
    (k8sClient.core.listNamespacedEvent as any).mockImplementation(({ namespace }: { namespace: string }) => ({
      items: [
        {
          involvedObject: { kind: 'Pod', name: `${namespace}-pod`, namespace },
          reason: 'BackOff',
          message: `${namespace} warning`,
          type: 'Warning',
          lastTimestamp: new Date().toISOString(),
        },
      ],
    }));

    const result = await new EventCollector().collect();

    expect(result.map((event: any) => event.involvedObject.namespace)).toEqual(['default', 'payments']);
    expect(k8sClient.core.listNamespacedEvent).toHaveBeenCalledWith({
      namespace: 'default',
      fieldSelector: 'type=Warning',
      limit: 500,
      _continue: undefined,
    });
    expect(k8sClient.core.listNamespacedEvent).toHaveBeenCalledWith({
      namespace: 'payments',
      fieldSelector: 'type=Warning',
      limit: 500,
      _continue: undefined,
    });
  });

  it('collects recent warning events from a ready watch cache', async () => {
    const store = new WatchStore();
    store.replaceEvents([
      {
        involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
        reason: 'BackOff',
        message: 'Back-off restarting failed container',
        type: 'Warning',
        count: 4,
        firstTimestamp: new Date(Date.now() - 30000).toISOString(),
        lastTimestamp: new Date(Date.now() - 10000).toISOString(),
        reportingComponent: 'kubelet',
      }
    ], '2');

    const result = await new EventCollector(store).collect();

    expect(k8sClient.core.listEventForAllNamespaces).not.toHaveBeenCalled();
    expect(result).toEqual([{
      involvedObject: {
        kind: 'Pod',
        name: 'pod1',
        namespace: 'default',
        uid: 'pod-uid-1',
      },
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      count: 4,
      firstTimestamp: expect.any(String),
      lastTimestamp: expect.any(String),
      reportingComponent: 'kubelet',
    }]);
  });

  it('deduplicates repeated watch updates for the same warning event', async () => {
    const store = new WatchStore();
    store.replaceEvents([
      {
        metadata: { uid: 'event-uid-1', name: 'pod1-warning', namespace: 'default' },
        involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
        reason: 'BackOff',
        message: 'first message',
        type: 'Warning',
        count: 1,
        firstTimestamp: new Date(Date.now() - 30000).toISOString(),
        lastTimestamp: new Date(Date.now() - 20000).toISOString(),
        reportingComponent: 'kubelet',
      }
    ], '2');
    store.addEvent({
      metadata: { uid: 'event-uid-1', name: 'pod1-warning', namespace: 'default', resourceVersion: '3' },
      involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
      reason: 'BackOff',
      message: 'updated message',
      type: 'Warning',
      count: 4,
      firstTimestamp: new Date(Date.now() - 30000).toISOString(),
      lastTimestamp: new Date(Date.now() - 10000).toISOString(),
      reportingComponent: 'kubelet',
    }, '3');

    const result = await new EventCollector(store).collect();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      reason: 'BackOff',
      message: 'updated message',
      count: 4,
    });
  });

  it('filters excluded namespaces when collecting warning events from a watch cache', async () => {
    const store = new WatchStore();
    store.replaceEvents([
      {
        metadata: { uid: 'event-uid-1', name: 'default-warning', namespace: 'default' },
        involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
        reason: 'BackOff',
        message: 'default warning',
        type: 'Warning',
        lastTimestamp: new Date(Date.now() - 10000).toISOString(),
      },
      {
        metadata: { uid: 'event-uid-2', name: 'lease-warning', namespace: 'kube-node-lease' },
        involvedObject: { kind: 'Lease', name: 'node-1', namespace: 'kube-node-lease' },
        reason: 'NoisyLease',
        message: 'excluded warning',
        type: 'Warning',
        lastTimestamp: new Date(Date.now() - 10000).toISOString(),
      },
    ], '2');

    const result = await new EventCollector(store).collect();

    expect(result.map((event: any) => event.involvedObject.namespace)).toEqual(['default']);
  });

  it('waits for a warming watch event cache before using list fallback', async () => {
    vi.useFakeTimers();
    try {
      const store = new WatchStore();
      store.markSyncing('events');

      const collect = new EventCollector(store).collect();
      await Promise.resolve();
      expect(k8sClient.core.listEventForAllNamespaces).not.toHaveBeenCalled();

      store.replaceEvents([
        {
          involvedObject: { kind: 'Pod', name: 'pod1', namespace: 'default', uid: 'pod-uid-1' },
          reason: 'BackOff',
          message: 'Back-off restarting failed container',
          type: 'Warning',
          count: 1,
          firstTimestamp: new Date(Date.now() - 30000).toISOString(),
          lastTimestamp: new Date(Date.now() - 10000).toISOString(),
          reportingComponent: 'kubelet',
        }
      ], '2');
      await vi.advanceTimersByTimeAsync(100);

      const result = await collect;
      expect(result.map((event: any) => event.reason)).toEqual(['BackOff']);
      expect(k8sClient.core.listEventForAllNamespaces).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
