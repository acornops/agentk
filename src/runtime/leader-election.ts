import type * as k8s from '@kubernetes/client-node';
import pino from 'pino';
import { config } from '../config.js';
import { k8sClient } from '../k8s/client.js';
import { createLeaseApi, type LeaseApi } from './lease-api.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'leader-election' });

type Lease = k8s.V1Lease;

export interface LeaderElectionOptions {
  leaseName: string;
  leaseNamespace: string;
  holderIdentity: string;
  leaseDurationMs: number;
  renewDeadlineMs: number;
  retryPeriodMs: number;
  podName?: string;
  podUid?: string;
  onAcquired: () => void | Promise<void>;
  onLost: (reason: string) => void | Promise<void>;
  api?: LeaseApi;
}

/** Extract an HTTP-like status code from Kubernetes client errors. */
function getErrorStatus(err: unknown): number | undefined {
  const candidate = err as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
  };
  return candidate.statusCode ?? candidate.code ?? candidate.response?.statusCode ?? candidate.response?.status;
}

/** Return the current time in Kubernetes MicroTime shape. */
function nowMicro(): k8s.V1MicroTime {
  return new Date() as k8s.V1MicroTime;
}

/** Return the latest renew or acquire timestamp for a Lease. */
function leaseRenewedAtMs(lease: Lease): number {
  const timestamp = lease.spec?.renewTime ?? lease.spec?.acquireTime;
  if (!timestamp) return 0;
  const parsed = timestamp instanceof Date
    ? timestamp.getTime()
    : new Date(timestamp as unknown as string).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Kubernetes Lease-based active-passive election. Leadership is fail-closed:
 * if renews cannot be confirmed within the renew deadline, the active runtime
 * is stopped and can only restart after a fresh successful acquire/renew.
 */
export class LeaderElector {
  private readonly api: LeaseApi;
  private stopped = true;
  private isLeader = false;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private lastSuccessfulRenewMs = 0;
  private epoch = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private operation: AbortController | null = null;
  private unsettled: Promise<unknown> | null = null;

  /** Initialize a Lease-backed leader elector. */
  constructor(private readonly options: LeaderElectionOptions) {
    this.api = options.api ?? createLeaseApi(k8sClient.coordination);
  }

  /** Start attempting to acquire or renew leadership. */
  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.epoch++;
    logger.info(this.logFields(), 'Starting leader election');
    this.schedule(0);
  }

  /** Stop election and release leadership when held. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const epoch = ++this.epoch;
    this.clearTimer();
    this.clearWatchdog();
    this.operation?.abort();
    const wasLeader = this.isLeader;
    this.isLeader = false;

    if (wasLeader) {
      await this.emitLost('shutdown');
      if (this.stopped && epoch === this.epoch && !this.unsettled) await this.releaseLease(epoch);
    }
  }

  /** Return whether this replica currently holds leadership. */
  public hasLeadership(): boolean {
    return this.isLeader;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      if (!this.unsettled) await this.tryAcquireOrRenew(this.epoch);
    } finally {
      this.tickInFlight = false;
      if (!this.stopped) {
        const remaining = this.lastSuccessfulRenewMs + this.options.renewDeadlineMs - performance.now();
        // Leave time to renew even when the configured retry equals the deadline.
        this.schedule(this.isLeader
          ? Math.max(1, Math.min(this.options.retryPeriodMs, remaining / 2))
          : this.options.retryPeriodMs);
      }
    }
  }

  private async tryAcquireOrRenew(epoch: number): Promise<void> {
    let lease: Lease | null = null;
    try {
      lease = await this.request((signal) => this.api.readNamespacedLease(this.options.leaseName, this.options.leaseNamespace, signal));
    } catch (err) {
      if (!this.isCurrent(epoch)) return;
      if (getErrorStatus(err) === 404) {
        await this.createLease(epoch);
        return;
      }
      await this.handleApiFailure(err, 'read');
      return;
    }
    if (!this.isCurrent(epoch)) return;

    const holder = lease.spec?.holderIdentity || '';
    if (holder === this.options.holderIdentity) {
      await this.renewLease(lease, false, epoch);
      return;
    }

    if (this.isLeader) {
      await this.loseLeadership(`lease-held-by-${holder || 'empty'}`);
      return;
    }

    if (!holder || this.isExpired(lease)) {
      await this.renewLease(lease, true, epoch);
      return;
    }

    logger.debug({ ...this.logFields(), currentHolder: holder }, 'Lease is held by another replica');
  }

  private async createLease(epoch: number): Promise<void> {
    const body = this.buildLease();
    const startedAt = performance.now();

    try {
      const created = await this.request((signal) => this.api.createNamespacedLease(this.options.leaseNamespace, body, signal));
      if (!this.isCurrent(epoch)) return;
      await this.markRenewed(created, 'created', startedAt);
    } catch (err) {
      if (!this.isCurrent(epoch)) return;
      const status = getErrorStatus(err);
      if (status === 409) {
        logger.debug(this.logFields(), 'Lease was created by another replica');
        return;
      }
      await this.handleApiFailure(err, 'create');
    }
  }

  private async renewLease(existing: Lease, transition: boolean, epoch: number): Promise<void> {
    const body = this.buildLease(existing, transition);
    const startedAt = performance.now();

    try {
      const renewed = await this.request((signal) => this.api.replaceNamespacedLease(
        this.options.leaseName,
        this.options.leaseNamespace,
        body, signal
      ));
      if (!this.isCurrent(epoch)) return;
      await this.markRenewed(renewed, transition ? 'acquired' : 'renewed', startedAt);
    } catch (err) {
      if (!this.isCurrent(epoch)) return;
      const status = getErrorStatus(err);
      if (status === 409 && this.isLeader) {
        await this.loseLeadership('lease-update-conflict');
        return;
      }
      await this.handleApiFailure(err, transition ? 'acquire' : 'renew');
    }
  }

  private buildLease(existing?: Lease, transition = false): Lease {
    const priorTransitions = existing?.spec?.leaseTransitions ?? 0;
    const leaseTransitions = transition ? priorTransitions + 1 : priorTransitions;

    return {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.options.leaseName,
        namespace: this.options.leaseNamespace,
        resourceVersion: existing?.metadata?.resourceVersion,
      },
      spec: {
        holderIdentity: this.options.holderIdentity,
        leaseDurationSeconds: Math.ceil(this.options.leaseDurationMs / 1000),
        acquireTime: transition || !existing?.spec?.acquireTime ? nowMicro() : existing.spec.acquireTime,
        renewTime: nowMicro(),
        leaseTransitions,
      },
    };
  }

  private isExpired(lease: Lease): boolean {
    const renewedAt = leaseRenewedAtMs(lease);
    if (renewedAt === 0) return true;
    const durationSeconds = lease.spec?.leaseDurationSeconds ?? Math.ceil(this.options.leaseDurationMs / 1000);
    return Date.now() - renewedAt > durationSeconds * 1000;
  }

  private async markRenewed(lease: Lease, action: 'created' | 'acquired' | 'renewed', startedAt: number): Promise<void> {
    if (lease.spec?.holderIdentity !== this.options.holderIdentity
      || performance.now() - startedAt >= this.options.renewDeadlineMs) {
      await this.loseLeadership('unconfirmed-renewal');
      return;
    }
    this.lastSuccessfulRenewMs = startedAt;
    this.armWatchdog();
    if (!this.isLeader) {
      this.isLeader = true;
      logger.info({ ...this.logFields(), action }, 'Lease acquired');
      await this.options.onAcquired();
      return;
    }

    logger.debug({ ...this.logFields(), action }, 'Lease renewed');
  }

  private async handleApiFailure(err: unknown, operation: string): Promise<void> {
    logger.warn({ ...this.logFields(), err, operation }, 'Leader election API operation failed');
    if (!this.isLeader) return;

    const elapsed = performance.now() - this.lastSuccessfulRenewMs;
    if (elapsed >= this.options.renewDeadlineMs) {
      await this.loseLeadership(`${operation}-failed-renew-deadline`);
    }
  }

  private async loseLeadership(reason: string): Promise<void> {
    if (!this.isLeader) return;
    this.isLeader = false;
    this.epoch++;
    this.clearWatchdog();
    this.operation?.abort();
    logger.warn({ ...this.logFields(), reason }, 'Lease lost');
    await this.emitLost(reason);
  }

  private async emitLost(reason: string): Promise<void> {
    try {
      await this.options.onLost(reason);
    } catch {
      logger.error(this.logFields(), 'Leadership-loss callback failed; remaining passive');
    }
  }

  private async releaseLease(epoch: number): Promise<void> {
    const deadline = performance.now() + 1000;
    try {
      const lease = await this.request((signal) => this.api.readNamespacedLease(this.options.leaseName, this.options.leaseNamespace, signal), 1000);
      if (epoch !== this.epoch || lease.spec?.holderIdentity !== this.options.holderIdentity) return;

      const released: Lease = {
        ...lease,
        spec: {
          ...lease.spec,
          holderIdentity: undefined,
          renewTime: nowMicro(),
        },
      };
      await this.request((signal) => this.api.replaceNamespacedLease(this.options.leaseName, this.options.leaseNamespace, released, signal), deadline - performance.now());
      logger.info(this.logFields(), 'Lease released');
    } catch (err) {
      logger.warn({ ...this.logFields(), err }, 'Failed to release Lease during shutdown');
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    const epoch = this.epoch;
    const remaining = this.lastSuccessfulRenewMs + this.options.renewDeadlineMs - performance.now();
    this.watchdog = setTimeout(() => {
      // Timer precision must not turn an early callback into a missed deadline.
      if (this.isCurrent(epoch) && this.isLeader) this.armWatchdog();
    }, Math.max(1, Math.ceil(remaining)));
    this.watchdog.unref();
  }

  /** Check elapsed authority before accepting even an already-queued response. */
  private isCurrent(epoch: number): boolean {
    if (this.stopped || epoch !== this.epoch) return false;
    if (this.isLeader && performance.now() - this.lastSuccessfulRenewMs >= this.options.renewDeadlineMs) {
      void this.loseLeadership('renew-deadline-exceeded');
      return false;
    }
    return true;
  }

  /** Cancel transport work and retain its slot until the raw request settles. */
  private async request<T>(send: (signal: AbortSignal) => Promise<T>, timeoutMs = Math.min(2000, this.options.retryPeriodMs, this.options.renewDeadlineMs)): Promise<T> {
    if (this.unsettled) throw new Error('Previous Lease request is still unsettled');
    const remaining = this.isLeader ? this.lastSuccessfulRenewMs + this.options.renewDeadlineMs - performance.now() : timeoutMs;
    const budget = Math.min(timeoutMs, remaining);
    if (budget <= 0) throw new Error('Lease request deadline exceeded');
    const controller = new AbortController();
    this.operation = controller;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Lease request cancelled or timed out'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), budget);
    const request = Promise.resolve().then(() => send(controller.signal));
    this.unsettled = request;
    const settled = () => { if (this.unsettled === request) this.unsettled = null; };
    void request.then(settled, settled);
    try {
      return await Promise.race([request, cancelled]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (this.operation === controller) this.operation = null;
    }
  }

  private logFields(): Record<string, string | number | undefined> {
    return {
      leaseName: this.options.leaseName,
      leaseNamespace: this.options.leaseNamespace,
      holderIdentity: this.options.holderIdentity,
      podName: this.options.podName,
      podUid: this.options.podUid,
    };
  }
}
