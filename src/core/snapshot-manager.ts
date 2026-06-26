import pino from 'pino';
import { promisify } from 'util';
import { gzip } from 'zlib';
import { config } from '../config.js';
import { ResourceCollector } from './collectors/resource-collector.js';
import { MetricsCollector } from './collectors/metrics-collector.js';
import { EventCollector } from './collectors/event-collector.js';
import { Collector } from '../types/collector.js';
import { createNotification } from '../mcp/protocol.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'snapshot-manager' });
const gzipAsync = promisify(gzip) as (buffer: Buffer) => Promise<Buffer>;
type SnapshotTrigger = 'initial' | 'interval' | 'manual';

/**
 * Orchestrates the periodic collection of cluster telemetry and sends it to the platform.
 * Supports Gzip compression for efficient transport.
 */
export class SnapshotManager {
  private collectors: Collector[] = [];
  private interval: NodeJS.Timeout | null = null;
  private currentIntervalMs: number = 60000;
  private maxSnapshotBytes = Number.POSITIVE_INFINITY;
  private onSnapshot: (payload: Buffer | string) => void;
  private gzipPayload: (buffer: Buffer) => Promise<Buffer>;
  private active = false;
  private generation = 0;
  private snapshotInFlight = false;
  private pendingSnapshot: { generation: number; trigger: SnapshotTrigger } | null = null;
  private skippedSnapshots = 0;
  private droppedSnapshots = 0;

  /** Initialize snapshot collectors and the outbound snapshot callback. */
  constructor(
    onSnapshot: (payload: Buffer | string) => void,
    gzipPayload: (buffer: Buffer) => Promise<Buffer> = gzipAsync,
    collectors?: Collector[]
  ) {
    this.onSnapshot = onSnapshot;
    this.gzipPayload = gzipPayload;
    this.collectors = collectors || [
      new ResourceCollector(),
      new MetricsCollector(),
      new EventCollector(),
    ];
  }

  /**
   * Starts the periodic snapshot pipeline.
   * @param intervalSeconds Frequency of snapshots (min 10s).
   */
  public start(intervalSeconds: number = 60, maxSnapshotBytes?: number): void {
    this.active = true;
    this.generation++;
    this.currentIntervalMs = Math.max(intervalSeconds, 10) * 1000;
    this.maxSnapshotBytes =
      typeof maxSnapshotBytes === 'number' && Number.isFinite(maxSnapshotBytes) && maxSnapshotBytes > 0
        ? maxSnapshotBytes
        : Number.POSITIVE_INFINITY;
    logger.info({ intervalMs: this.currentIntervalMs }, 'Starting snapshot pipeline');

    if (this.interval) clearInterval(this.interval);

    const generation = this.generation;
    this.interval = setInterval(() => this.takeSnapshot(generation, 'interval'), this.currentIntervalMs);
    // Take initial snapshot
    void this.takeSnapshot(generation, 'initial');
  }

  /** Stop scheduled snapshots and discard pending manual snapshot work. */
  public stop(): void {
    this.active = false;
    this.generation++;
    this.pendingSnapshot = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Replace the active periodic snapshot interval. */
  public setInterval(seconds: number): void {
      logger.info({ seconds }, 'Adjusting snapshot interval');
      this.start(seconds, this.maxSnapshotBytes);
  }

  /** Trigger an immediate snapshot when the pipeline is active. */
  public triggerSnapshot(): void {
    if (!this.active) return;
    void this.takeSnapshot(this.generation, 'manual');
  }

  private maxSnapshotBytesLogValue(): number | 'unlimited' {
    return Number.isFinite(this.maxSnapshotBytes) ? this.maxSnapshotBytes : 'unlimited';
  }

  /**
   * Performs a single collection cycle across all registered collectors.
   * Compresses the result and invokes the onSnapshot callback.
   */
  private async takeSnapshot(generation: number, trigger: SnapshotTrigger = 'interval'): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    if (this.snapshotInFlight) {
      this.skippedSnapshots += 1;
      if (trigger !== 'interval') {
        this.pendingSnapshot = { generation, trigger };
      }
      logger.warn(
        {
          trigger,
          skippedSnapshots: this.skippedSnapshots,
          pendingSnapshot: Boolean(this.pendingSnapshot),
        },
        'Skipping snapshot because previous collection is still running'
      );
      return;
    }

    this.snapshotInFlight = true;
    const startedAt = Date.now();
    let originalBytes = 0;
    let compressedBytes = 0;

    logger.debug({ trigger }, 'Taking snapshot...');
    try {
      const results: Record<string, any> = {};

      await Promise.all(this.collectors.map(async (c) => {
        const collectorStartedAt = Date.now();
        try {
          results[c.name] = await c.collect();
          logger.debug(
            {
              collector: c.name,
              durationMs: Date.now() - collectorStartedAt,
            },
            'Collector finished'
          );
        } catch (err) {
          logger.error(
            {
              err,
              collector: c.name,
              durationMs: Date.now() - collectorStartedAt,
            },
            'Collector failed'
          );
          results[c.name] = { error: 'Failed to collect data' };
        }
      }));

      if (!this.active || generation !== this.generation) return;

      const notification = createNotification('notify/snapshot', {
        timestamp: new Date().toISOString(),
        data: results,
      });

      const payload = JSON.stringify(notification);
      originalBytes = Buffer.byteLength(payload);
      const compressed = await this.gzipPayload(Buffer.from(payload));
      compressedBytes = compressed.length;

      logger.info({
        durationMs: Date.now() - startedAt,
        originalBytes,
        compressedBytes,
        maxSnapshotBytes: this.maxSnapshotBytesLogValue(),
        skippedSnapshots: this.skippedSnapshots,
        droppedSnapshots: this.droppedSnapshots,
      }, 'Snapshot prepared');

      if (compressed.length > this.maxSnapshotBytes) {
        this.droppedSnapshots += 1;
        logger.warn(
          {
            durationMs: Date.now() - startedAt,
            originalBytes,
            compressedBytes,
            maxSnapshotBytes: this.maxSnapshotBytesLogValue(),
            skippedSnapshots: this.skippedSnapshots,
            droppedSnapshots: this.droppedSnapshots,
          },
          'Compressed snapshot exceeded remote size budget; dropping snapshot'
        );
        return;
      }

      if (!this.active || generation !== this.generation) return;
      this.onSnapshot(compressed);
    } catch (err) {
      logger.error({ err }, 'Failed to take snapshot');
    } finally {
      this.snapshotInFlight = false;
      const pendingSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      logger.debug(
        {
          trigger,
          durationMs: Date.now() - startedAt,
          originalBytes,
          compressedBytes,
          skippedSnapshots: this.skippedSnapshots,
          droppedSnapshots: this.droppedSnapshots,
        },
        'Snapshot finished'
      );
      if (pendingSnapshot && this.active && pendingSnapshot.generation === this.generation) {
        void this.takeSnapshot(pendingSnapshot.generation, pendingSnapshot.trigger);
      }
    }
  }
}
