import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    ACORNOPS_AGENT_LOG_LEVEL: 'info',
  },
}));

vi.mock('../k8s/client.js', () => ({
  k8sClient: {
    coordination: {},
  },
}));

import { LeaderElector, type LeaderElectionOptions } from './leader-election.js';

interface Lease {
  metadata?: {
    name?: string;
    namespace?: string;
    resourceVersion?: string;
  };
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    renewTime?: string;
    acquireTime?: string;
    leaseTransitions?: number;
  };
}

function notFound(): Error & { statusCode: number } {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

class FakeLeaseApi {
  lease: Lease | null = null;
  failReplace: unknown = null;
  readGate: Promise<void> | null = null;
  createCalls = 0;
  replaceCalls = 0;

  async readNamespacedLease(): Promise<Lease> {
    if (this.readGate) await this.readGate;
    if (!this.lease) throw notFound();
    return this.lease;
  }

  async createNamespacedLease(_namespace: string, body: Lease): Promise<Lease> {
    this.createCalls++;
    this.lease = {
      ...body,
      metadata: {
        ...body.metadata,
        resourceVersion: String(this.createCalls + this.replaceCalls),
      },
    };
    return this.lease;
  }

  async replaceNamespacedLease(_name: string, _namespace: string, body: Lease): Promise<Lease> {
    this.replaceCalls++;
    if (this.failReplace) throw this.failReplace;
    if (this.lease?.metadata?.resourceVersion !== body.metadata?.resourceVersion) {
      throw Object.assign(new Error('conflict'), { statusCode: 409 });
    }
    this.lease = {
      ...body,
      metadata: {
        ...body.metadata,
        resourceVersion: String(this.createCalls + this.replaceCalls),
      },
    };
    return this.lease;
  }
}

function elector(api: FakeLeaseApi, callbacks?: { onAcquired?: () => void; onLost?: (reason: string) => void }, options: Partial<LeaderElectionOptions> = {}) {
  return new LeaderElector({
    leaseName: 'agent-leader',
    leaseNamespace: 'acornops',
    holderIdentity: 'pod-uid-1',
    leaseDurationMs: 15000,
    renewDeadlineMs: 2000,
    retryPeriodMs: 1000,
    onAcquired: callbacks?.onAcquired ?? vi.fn(),
    onLost: callbacks?.onLost ?? vi.fn(),
    api,
    ...options,
  });
}

describe('LeaderElector', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('creates a missing Lease and reports leadership acquired', async () => {
    const api = new FakeLeaseApi();
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(subject.hasLeadership()).toBe(true);
    expect(api.lease?.spec?.holderIdentity).toBe('pod-uid-1');
  });

  it('stays passive while an unexpired Lease is held by another replica', async () => {
    const api = new FakeLeaseApi();
    api.lease = {
      metadata: { name: 'agent-leader', namespace: 'acornops', resourceVersion: '1' },
      spec: {
        holderIdentity: 'pod-uid-2',
        leaseDurationSeconds: 15,
        renewTime: new Date().toISOString(),
      },
    };
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onAcquired).not.toHaveBeenCalled();
    expect(subject.hasLeadership()).toBe(false);
    expect(api.replaceCalls).toBe(0);
  });

  it('takes over an expired Lease', async () => {
    const api = new FakeLeaseApi();
    api.lease = {
      metadata: { name: 'agent-leader', namespace: 'acornops', resourceVersion: '1' },
      spec: {
        holderIdentity: 'pod-uid-2',
        leaseDurationSeconds: 15,
        renewTime: new Date('2026-05-14T23:59:00.000Z').toISOString(),
        leaseTransitions: 3,
      },
    };
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(api.lease?.spec?.holderIdentity).toBe('pod-uid-1');
    expect(api.lease?.spec?.leaseTransitions).toBe(4);
  });

  it('loses leadership after renew failures exceed the deadline', async () => {
    const api = new FakeLeaseApi();
    api.lease = {
      metadata: { name: 'agent-leader', namespace: 'acornops', resourceVersion: '1' },
      spec: {
        holderIdentity: 'pod-uid-1',
        leaseDurationSeconds: 15,
        renewTime: new Date().toISOString(),
      },
    };
    const onAcquired = vi.fn();
    const onLost = vi.fn();
    const subject = elector(api, { onAcquired, onLost });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAcquired).toHaveBeenCalledTimes(1);

    api.failReplace = Object.assign(new Error('api down'), { statusCode: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onLost).toHaveBeenCalledWith('renew-deadline-exceeded');
    expect(subject.hasLeadership()).toBe(false);
  });

  it.each([0, 400])('keeps healthy leadership when retry equals the deadline and renewal takes %i ms', async (latency) => {
    const api = new FakeLeaseApi();
    const replace = api.replaceNamespacedLease.bind(api);
    const renew = vi.spyOn(api, 'replaceNamespacedLease').mockImplementation(async (...args) => {
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
      return replace(...args);
    });
    const onAcquired = vi.fn();
    const onLost = vi.fn();
    const subject = elector(api, { onAcquired, onLost }, { retryPeriodMs: 2000, renewDeadlineMs: 2000 });
    subject.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onLost).not.toHaveBeenCalled();
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(api.replaceCalls).toBeGreaterThan(2);
    expect(subject.hasLeadership()).toBe(true);
    renew.mockRestore();
    await subject.stop();
  });

  it('emits lost and releases the Lease on shutdown', async () => {
    const api = new FakeLeaseApi();
    const onLost = vi.fn();
    const subject = elector(api, { onLost });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);

    await subject.stop();

    expect(onLost).toHaveBeenCalledWith('shutdown');
    expect(subject.hasLeadership()).toBe(false);
    expect(api.lease?.spec?.holderIdentity).toBeUndefined();
  });

  it('does not acquire leadership from a stale API response after stop', async () => {
    let releaseRead!: () => void;
    const api = new FakeLeaseApi();
    api.readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    api.lease = {
      metadata: { name: 'agent-leader', namespace: 'acornops', resourceVersion: '1' },
      spec: {
        holderIdentity: 'pod-uid-2',
        leaseDurationSeconds: 15,
        renewTime: new Date('2026-05-14T23:59:00.000Z').toISOString(),
      },
    };
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired });

    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    await subject.stop();
    releaseRead();
    await Promise.resolve();

    expect(onAcquired).not.toHaveBeenCalled();
    expect(api.replaceCalls).toBe(0);
    expect(subject.hasLeadership()).toBe(false);
  });

  for (const operation of ['readNamespacedLease', 'replaceNamespacedLease'] as const) {
    it(`revokes before the 15-second Lease expires when ${operation} never settles`, async () => {
      const api = new FakeLeaseApi();
      const onLost = vi.fn();
      const subject = elector(api, { onLost }, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
      subject.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.lease?.spec?.leaseDurationSeconds).toBe(15);
      const stalled = vi.spyOn(api, operation).mockImplementation(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(9999);
      expect(subject.hasLeadership()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(subject.hasLeadership()).toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledWith('renew-deadline-exceeded');
      await vi.advanceTimersByTimeAsync(6000);
      expect(subject.hasLeadership()).toBe(false);
      expect(stalled).toHaveBeenCalledTimes(1); // No abandoned-request accumulation.
      const args = stalled.mock.calls[0] as unknown[];
      expect((args.at(-1) as AbortSignal).aborted).toBe(true);
      await subject.stop();
    });
  }

  it('ignores late successful renewals after the authority deadline', async () => {
    const api = new FakeLeaseApi();
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired }, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    let complete!: (lease: Lease) => void;
    vi.spyOn(api, 'replaceNamespacedLease').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(10000);
    complete(api.lease!);
    await vi.advanceTimersByTimeAsync(0);
    expect(subject.hasLeadership()).toBe(false);
    expect(onAcquired).toHaveBeenCalledTimes(1);
    await subject.stop();
  });

  it('fences an unsettled request across stop and restart', async () => {
    const api = new FakeLeaseApi();
    let release!: () => void;
    api.readGate = new Promise((resolve) => { release = resolve; });
    const onAcquired = vi.fn();
    const subject = elector(api, { onAcquired });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    await subject.stop();
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAcquired).not.toHaveBeenCalled();
    expect(api.createCalls).toBe(0);
    await subject.stop();
  });

  it('bounds shutdown release after immediately revoking local leadership', async () => {
    const api = new FakeLeaseApi();
    const onLost = vi.fn();
    const subject = elector(api, { onLost });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    api.readGate = new Promise(() => {});
    let stopped = false;
    void subject.stop().then(() => { stopped = true; });
    expect(subject.hasLeadership()).toBe(false);
    expect(onLost).toHaveBeenCalledWith('shutdown');
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(true);
  });

  it('does not let an old asynchronous shutdown release newly acquired leadership', async () => {
    const api = new FakeLeaseApi();
    let lost!: () => void;
    const onLost = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { lost = resolve; }));
    const subject = elector(api, { onLost });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = subject.stop();
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(subject.hasLeadership()).toBe(true);
    const version = api.lease?.metadata?.resourceVersion;
    lost();
    await stopping;
    expect(api.lease?.spec?.holderIdentity).toBe('pod-uid-1');
    expect(api.lease?.metadata?.resourceVersion).toBe(version);
    expect(subject.hasLeadership()).toBe(true);
    await subject.stop();
  });

  it('does not extend local authority when the wall clock goes backwards', async () => {
    const api = new FakeLeaseApi();
    const subject = elector(api, undefined, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    api.readGate = new Promise(() => {});
    vi.setSystemTime(new Date('2025-01-01'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(subject.hasLeadership()).toBe(false);
    await subject.stop();
  });

  it('rejects a late response before a delayed watchdog gets CPU time', async () => {
    const api = new FakeLeaseApi();
    const onLost = vi.fn();
    const subject = elector(api, { onLost }, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    let complete!: (lease: Lease) => void;
    vi.spyOn(api, 'replaceNamespacedLease').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(12000);
    complete(api.lease!);
    await vi.advanceTimersByTimeAsync(0);
    expect(subject.hasLeadership()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    clock.mockRestore();
    await subject.stop();
  });

  it('rearms a watchdog delivered just before its monotonic deadline', async () => {
    const api = new FakeLeaseApi();
    const subject = elector(api, undefined, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    api.readGate = new Promise(() => {});
    const clock = vi.spyOn(performance, 'now').mockReturnValue(9999.5);
    await vi.advanceTimersByTimeAsync(10000);
    expect(subject.hasLeadership()).toBe(true);
    clock.mockReturnValue(10000.5);
    await vi.advanceTimersByTimeAsync(1);
    expect(subject.hasLeadership()).toBe(false);
    clock.mockRestore();
    await subject.stop();
  });

  it('does not accept a successful response naming a different holder', async () => {
    const api = new FakeLeaseApi();
    const onAcquired = vi.fn();
    vi.spyOn(api, 'createNamespacedLease').mockResolvedValue({ spec: { holderIdentity: 'someone-else' } });
    const subject = elector(api, { onAcquired });
    subject.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(subject.hasLeadership()).toBe(false);
    expect(onAcquired).not.toHaveBeenCalled();
    await subject.stop();
  });

  it('allows a healthy standby to acquire only after the old Lease expires', async () => {
    const api = new FakeLeaseApi();
    const active = elector(api, undefined, { renewDeadlineMs: 10000, retryPeriodMs: 2000 });
    active.start();
    await vi.advanceTimersByTimeAsync(0);
    // Same stored Lease, but an independent request path remains healthy.
    const standbyApi = new FakeLeaseApi();
    standbyApi.readNamespacedLease = async () => api.lease!;
    standbyApi.replaceNamespacedLease = api.replaceNamespacedLease.bind(api);
    const acquired = vi.fn();
    const standby = elector(standbyApi, { onAcquired: acquired }, {
      holderIdentity: 'pod-uid-2', renewDeadlineMs: 10000, retryPeriodMs: 2000
    });
    api.readGate = new Promise(() => {});
    standby.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(active.hasLeadership()).toBe(false);
    expect(acquired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(active.hasLeadership()).toBe(false);
    expect(standby.hasLeadership()).toBe(true);
    expect(api.lease?.spec?.holderIdentity).toBe('pod-uid-2');
    await active.stop();
    await standby.stop();
  });
});
