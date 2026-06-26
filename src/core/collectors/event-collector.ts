import { k8sClient } from '../../k8s/client.js';
import pino from 'pino';
import { Collector } from '../../types/collector.js';
import { config } from '../../config.js';
import { filterNamespaceItems, getWatchNamespaces } from '../../runtime/namespace-scope.js';
import { listAllPages } from '../../k8s/pagination.js';
import { WatchStore } from '../watch/watch-store.js';
import { isEventWithinAge, mapWarningEvent } from './event-mappers.js';

const logger = pino({ level: config.ACORNOPS_AGENT_LOG_LEVEL }).child({ module: 'event-collector' });
const WATCH_CACHE_POLL_MS = 100;

/** Wait for a short polling interval while the watch event cache is warming. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collector responsible for fetching Warning events from the last 60 seconds.
 */
export class EventCollector implements Collector {
  public name = 'events';
  private readonly recentEventAgeMs = 60000;

  /** Initialize the collector with an optional watch-backed event cache. */
  constructor(private readonly watchStore?: WatchStore) {}

  /** Collect recent warning events from watched namespaces. */
  public async collect(): Promise<any> {
    try {
      const cached = await this.collectFromWatchStore();
      if (cached) return cached;

      const namespaces = getWatchNamespaces();

      let events;
      if (namespaces) {
          const results = await Promise.all(namespaces.map(namespace =>
              listAllPages((options) => k8sClient.core.listNamespacedEvent({
                  ...options,
                  namespace,
                  fieldSelector: `type=Warning`
              }))
          ));
          events = results.flat();
      } else {
          events = await listAllPages((options) =>
              k8sClient.core.listEventForAllNamespaces({
                  ...options,
                  fieldSelector: `type=Warning`
              })
          );
          events = filterNamespaceItems(events, (event) => event.metadata?.namespace || event.involvedObject?.namespace);
      }

      // Filter events newer than 'since' - k8s doesn't support time filtering in fieldSelector easily for all resources
      return events.filter(e => isEventWithinAge(e, this.recentEventAgeMs)).map(mapWarningEvent);
    } catch (err) {
      logger.warn({ err }, 'Failed to collect warning events');
      return [];
    }
  }

  private async collectFromWatchStore(): Promise<any[] | null> {
    if (!config.ACORNOPS_AGENT_WATCH_CACHE_ENABLED || !this.watchStore) return null;
    let events = this.watchStore.getRecentEvents(this.recentEventAgeMs);
    if (!events && this.watchStore.eventsWarming()) {
      events = await this.waitForWatchEvents();
    }
    if (!events) return null;
    return events.map(mapWarningEvent);
  }

  private async waitForWatchEvents(): Promise<any[] | null> {
    const deadline = Date.now() + config.ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS;
    while (Date.now() < deadline && this.watchStore?.eventsWarming()) {
      const events = this.watchStore.getRecentEvents(this.recentEventAgeMs);
      if (events) return events;
      await sleep(Math.min(WATCH_CACHE_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    return this.watchStore?.getRecentEvents(this.recentEventAgeMs) || null;
  }
}
