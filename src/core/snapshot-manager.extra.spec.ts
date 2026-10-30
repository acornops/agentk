import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';

const { collectorResults, collectorErrors, ResourceCollector, MetricsCollector, EventCollector } = vi.hoisted(() => {
  const collectorResults = new Map<string, unknown>();
  const collectorErrors = new Map<string, Error>();

  class MockCollector {
    constructor(readonly name: string) {}

    collect = vi.fn(async () => {
      const error = collectorErrors.get(this.name);
      if (error) {
        throw error;
      }
      return collectorResults.get(this.name);
    });
  }

  return {
    collectorResults,
    collectorErrors,
    ResourceCollector: class extends MockCollector {
      constructor() {
        super('resources');
      }
    },
    MetricsCollector: class extends MockCollector {
      constructor() {
        super('metrics');
      }
    },
    EventCollector: class extends MockCollector {
      constructor() {
        super('events');
      }
    },
  };
});

vi.mock('../config.js', () => ({
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'info',
  },
}));
vi.mock('./collectors/resource-collector.js', () => ({ ResourceCollector }));
vi.mock('./collectors/metrics-collector.js', () => ({ MetricsCollector }));
vi.mock('./collectors/event-collector.js', () => ({ EventCollector }));

import { SnapshotManager } from './snapshot-manager.js';

async function flushPromises() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('SnapshotManager extra coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    collectorResults.clear();
    collectorErrors.clear();
    collectorResults.set('resources', { pods: ['api-0'] });
    collectorResults.set('metrics', { available: true });
    collectorResults.set('events', [{ reason: 'BackOff' }]);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('emits a compressed snapshot payload and records collector failures in the payload', async () => {
    collectorErrors.set('metrics', new Error('metrics unavailable'));
    const sent: Array<Buffer | string> = [];
    const manager = new SnapshotManager((payload) => sent.push(payload), async (payload) => gzipSync(payload));

    manager.start(10);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const payload = JSON.parse(gunzipSync(sent[0] as Buffer).toString());
    expect(payload.method).toBe('notify/snapshot');
    expect(payload.params.data).toEqual({
      resources: { pods: ['api-0'] },
      metrics: { error: 'Failed to collect data' },
      events: [{ reason: 'BackOff' }],
    });
  });

  it('drops snapshots that exceed the remote size budget', async () => {
    collectorResults.set('resources', { pods: ['x'.repeat(10_000)] });
    const sent: Array<Buffer | string> = [];
    const manager = new SnapshotManager((payload) => sent.push(payload), async (payload) => gzipSync(payload));

    manager.start(10, 1, 20_000);
    await flushPromises();

    expect(sent).toHaveLength(0);
  });

  it('clears the in-flight guard after compression failure', async () => {
    const sent: Array<Buffer | string> = [];
    let failCompression = true;
    let compressionAttempts = 0;
    const manager = new SnapshotManager(
      (payload) => sent.push(payload),
      async (payload) => {
        compressionAttempts += 1;
        if (failCompression) {
          throw new Error('gzip failed');
        }
        return gzipSync(payload);
      }
    );

    manager.start(10);
    await vi.waitFor(() => expect(compressionAttempts).toBe(1));
    expect(sent).toHaveLength(0);

    failCompression = false;
    manager.triggerSnapshot();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('drops decoded oversize snapshots before gzip and retains the limit on interval changes', async () => {
    const sent: Array<Buffer | string> = [];
    let compressions = 0;
    const manager = new SnapshotManager((payload) => sent.push(payload), async (payload) => {
      compressions++;
      return gzipSync(payload);
    });
    // Six MiB of UTF-8 data compresses far below the three MiB wire budget.
    collectorResults.set('resources', { pods: ['é'.repeat(3 * 1024 * 1024)] });
    manager.start(10, 3 * 1024 * 1024, 5 * 1024 * 1024);
    await flushPromises();
    expect(sent).toHaveLength(0);
    expect(compressions).toBe(0);

    manager.setInterval(20);
    await flushPromises();
    expect(sent).toHaveLength(0);
    expect(compressions).toBe(0);

    // Four MiB decoded is valid even though it is above the wire budget.
    collectorResults.set('resources', { pods: ['é'.repeat(2 * 1024 * 1024)] });
    manager.triggerSnapshot();
    await flushPromises();
    expect(sent).toHaveLength(1);
    expect(gunzipSync(sent[0] as Buffer).length).toBeGreaterThan(3 * 1024 * 1024);
    expect((sent[0] as Buffer).length).toBeLessThan(3 * 1024 * 1024);
  });

  it('accepts the exact decoded UTF-8 byte limit and drops one byte over', async () => {
    const sent: Array<Buffer | string> = [];
    collectorResults.set('resources', { pods: ['é'] });
    const manager = new SnapshotManager((payload) => sent.push(payload), async (payload) => gzipSync(payload));
    manager.start(10);
    await flushPromises();
    const payload = gunzipSync(sent[0] as Buffer);
    expect(payload.length).toBeGreaterThan(payload.toString().length);
    sent.length = 0;
    manager.start(10, 1024, payload.length);
    await flushPromises();
    expect(sent).toHaveLength(1);
    sent.length = 0;
    manager.start(10, 1024, payload.length - 1);
    await flushPromises();
    expect(sent).toHaveLength(0);
  });

  it('enforces the minimum ten second interval for periodic snapshots', async () => {
    const sent: Array<Buffer | string> = [];
    const manager = new SnapshotManager((payload) => sent.push(payload), async (payload) => gzipSync(payload));

    manager.start(1);
    await flushPromises();
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9_999);
    await flushPromises();
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });
});
