import { filterNamespaceItems } from '../../runtime/namespace-scope.js';

export type WatchResourceKind =
  | 'pods'
  | 'deployments'
  | 'statefulSets'
  | 'daemonSets'
  | 'cronJobs'
  | 'jobs'
  | 'services'
  | 'ingresses'
  | 'pvcs'
  | 'nodes'
  | 'namespaces';

export const WATCH_RESOURCE_KINDS: WatchResourceKind[] = [
  'pods',
  'deployments',
  'statefulSets',
  'daemonSets',
  'cronJobs',
  'jobs',
  'services',
  'ingresses',
  'pvcs',
  'nodes',
  'namespaces',
];

export type WatchKind = WatchResourceKind | 'events';

type WatchStatus = 'idle' | 'syncing' | 'synced' | 'unhealthy';

interface KindState {
  status: WatchStatus;
  resourceVersion?: string;
  items: Map<string, any>;
  syncingScopes: Set<string>;
  unhealthyScopes: Set<string>;
  updatedAt?: number;
  error?: string;
}

export interface WatchResourceSnapshot {
  pods: any[];
  deployments: any[];
  statefulSets: any[];
  daemonSets: any[];
  cronJobs: any[];
  jobs: any[];
  services: any[];
  ingresses: any[];
  pvcs: any[];
  nodes: any[];
  namespaces: any[];
}

/** Create an empty per-kind watch cache state. */
function emptyState(): KindState {
  return { status: 'idle', items: new Map(), syncingScopes: new Set(), unhealthyScopes: new Set() };
}

/** Return the stable cache key for a namespaced Kubernetes object. */
function namespacedKey(item: any): string {
  return `${item?.metadata?.namespace || ''}/${item?.metadata?.name || ''}`;
}

/** Return the stable cache key for a cluster-scoped Kubernetes object. */
function clusterKey(item: any): string {
  return String(item?.metadata?.name || '');
}

/** Return the status scope key for a namespaced or cluster-wide watch stream. */
function scopeKey(scope?: string): string {
  return scope || '__cluster__';
}

/** Return the best available event timestamp in milliseconds. */
function eventTimestamp(event: any): number {
  const raw = event?.lastTimestamp || event?.eventTime || event?.metadata?.creationTimestamp;
  const parsed = raw ? Date.parse(String(raw)) : Date.now();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Return a stable key for replacing repeated watch updates for one Event. */
function eventKey(event: any): string | undefined {
  if (event?.metadata?.uid) return `uid:${event.metadata.uid}`;
  if (event?.metadata?.name) {
    return `name:${event.metadata.namespace || event.involvedObject?.namespace || ''}/${event.metadata.name}`;
  }
  const involved = event?.involvedObject;
  if (involved?.kind && involved?.name && event?.reason) {
    return [
      'involved',
      involved.kind,
      involved.namespace || event?.metadata?.namespace || '',
      involved.name,
      event.reason,
      event.firstTimestamp || ''
    ].join(':');
  }
  return undefined;
}

/** In-memory Kubernetes watch cache used to assemble snapshot payloads. */
export class WatchStore {
  private readonly states = new Map<WatchResourceKind, KindState>();
  private eventState: KindState = emptyState();
  private readonly events: any[] = [];

  /** Initialize the store with a maximum age for retained events. */
  constructor(private readonly maxEventAgeMs = 5 * 60 * 1000) {
    this.clear();
  }

  /** Reset all resource and event state. */
  public clear(): void {
    this.states.clear();
    for (const kind of WATCH_RESOURCE_KINDS) {
      this.states.set(kind, emptyState());
    }
    this.eventState = emptyState();
    this.events.length = 0;
  }

  /** Mark a watch kind as syncing. */
  public markSyncing(kind: WatchKind, scope?: string): void {
    const state = this.stateFor(kind);
    state.status = 'syncing';
    state.syncingScopes.add(scopeKey(scope));
    state.unhealthyScopes.delete(scopeKey(scope));
    state.error = undefined;
  }

  /** Replace the complete cache for a resource kind after an initial list. */
  public replaceResourceKind(kind: WatchResourceKind, items: any[], resourceVersion?: string): void {
    const state = this.states.get(kind) || emptyState();
    state.items = new Map();
    for (const item of items) {
      const key = this.keyFor(kind, item);
      if (key) state.items.set(key, item);
    }
    state.status = 'synced';
    state.resourceVersion = resourceVersion;
    state.updatedAt = Date.now();
    state.error = undefined;
    state.syncingScopes.clear();
    state.unhealthyScopes.clear();
    this.states.set(kind, state);
  }

  /** Replace one namespace scope for a resource kind after a scoped relist. */
  public replaceResourceScope(kind: WatchResourceKind, namespace: string, items: any[], resourceVersion?: string): void {
    const state = this.states.get(kind) || emptyState();
    for (const key of Array.from(state.items.keys())) {
      if (key.startsWith(`${namespace}/`)) {
        state.items.delete(key);
      }
    }
    for (const item of items) {
      const key = this.keyFor(kind, item);
      if (key) state.items.set(key, item);
    }
    state.syncingScopes.delete(scopeKey(namespace));
    state.unhealthyScopes.delete(scopeKey(namespace));
    state.status = this.statusAfterScopeUpdate(state);
    state.resourceVersion = resourceVersion || state.resourceVersion;
    state.updatedAt = Date.now();
    if (state.status === 'synced') state.error = undefined;
    this.states.set(kind, state);
  }

  /** Upsert one watched Kubernetes resource object. */
  public upsertResource(kind: WatchResourceKind, item: any, resourceVersion?: string): void {
    const state = this.states.get(kind) || emptyState();
    const key = this.keyFor(kind, item);
    if (key) state.items.set(key, item);
    state.resourceVersion = resourceVersion || item?.metadata?.resourceVersion || state.resourceVersion;
    state.updatedAt = Date.now();
    state.status = this.statusAfterScopeUpdate(state);
    if (state.status === 'synced') state.error = undefined;
    this.states.set(kind, state);
  }

  /** Delete one watched Kubernetes resource object. */
  public deleteResource(kind: WatchResourceKind, item: any, resourceVersion?: string): void {
    const state = this.states.get(kind) || emptyState();
    const key = this.keyFor(kind, item);
    if (key) state.items.delete(key);
    state.resourceVersion = resourceVersion || item?.metadata?.resourceVersion || state.resourceVersion;
    state.updatedAt = Date.now();
    state.status = this.statusAfterScopeUpdate(state);
    if (state.status === 'synced') state.error = undefined;
    this.states.set(kind, state);
  }

  /** Update a resourceVersion from a bookmark event without changing data. */
  public setResourceVersion(kind: WatchKind, resourceVersion?: string): void {
    if (!resourceVersion) return;
    const state = this.stateFor(kind);
    state.resourceVersion = resourceVersion;
    state.updatedAt = Date.now();
  }

  /** Mark a previously synced kind healthy again after a watch reconnects. */
  public markSynced(kind: WatchKind, scope?: string): void {
    const state = this.stateFor(kind);
    if (scope === undefined) {
      state.syncingScopes.clear();
      state.unhealthyScopes.clear();
    } else {
      state.syncingScopes.delete(scopeKey(scope));
      state.unhealthyScopes.delete(scopeKey(scope));
    }
    state.status = this.statusAfterScopeUpdate(state);
    if (state.status === 'synced') state.error = undefined;
    state.updatedAt = Date.now();
  }

  /** Mark a kind unhealthy so collectors can use list fallback. */
  public markUnhealthy(kind: WatchKind, error: unknown, scope?: string): void {
    const state = this.stateFor(kind);
    state.syncingScopes.delete(scopeKey(scope));
    state.unhealthyScopes.add(scopeKey(scope));
    state.status = 'unhealthy';
    state.error = error instanceof Error ? error.message : String(error || 'watch failed');
    state.updatedAt = Date.now();
  }

  /** Replace the event buffer after an initial event list. */
  public replaceEvents(events: any[], resourceVersion?: string): void {
    this.events.length = 0;
    for (const event of events) {
      this.upsertEvent(event);
    }
    this.pruneEvents();
    this.eventState = {
      status: 'synced',
      resourceVersion,
      items: new Map(),
      syncingScopes: new Set(),
      unhealthyScopes: new Set(),
      updatedAt: Date.now()
    };
  }

  /** Replace one namespace worth of cached events after a scoped relist. */
  public replaceEventScope(namespace: string, events: any[], resourceVersion?: string): void {
    const retained = this.events.filter((event) => {
      const eventNamespace = event?.metadata?.namespace || event?.involvedObject?.namespace;
      return eventNamespace !== namespace;
    });
    this.events.length = 0;
    this.events.push(...retained);
    for (const event of events) {
      this.upsertEvent(event);
    }
    this.pruneEvents();
    this.eventState.syncingScopes.delete(scopeKey(namespace));
    this.eventState.unhealthyScopes.delete(scopeKey(namespace));
    this.eventState.status = this.statusAfterScopeUpdate(this.eventState);
    this.eventState.resourceVersion = resourceVersion || this.eventState.resourceVersion;
    this.eventState.updatedAt = Date.now();
    if (this.eventState.status === 'synced') this.eventState.error = undefined;
  }

  /** Add one event from the watch stream. */
  public addEvent(event: any, resourceVersion?: string): void {
    if (event?.type !== 'Warning') {
      this.setResourceVersion('events', resourceVersion || event?.metadata?.resourceVersion);
      return;
    }
    this.upsertEvent(event);
    this.pruneEvents();
    this.eventState.status = this.statusAfterScopeUpdate(this.eventState);
    this.eventState.resourceVersion = resourceVersion || event?.metadata?.resourceVersion || this.eventState.resourceVersion;
    this.eventState.updatedAt = Date.now();
    if (this.eventState.status === 'synced') this.eventState.error = undefined;
  }

  /** Remove one event from the watch buffer after a delete notification. */
  public deleteEvent(event: any, resourceVersion?: string): void {
    const key = eventKey(event);
    if (key) {
      const existingIndex = this.events.findIndex((candidate) => eventKey(candidate) === key);
      if (existingIndex >= 0) {
        this.events.splice(existingIndex, 1);
      }
    }
    this.eventState.status = this.statusAfterScopeUpdate(this.eventState);
    this.eventState.resourceVersion = resourceVersion || event?.metadata?.resourceVersion || this.eventState.resourceVersion;
    this.eventState.updatedAt = Date.now();
    if (this.eventState.status === 'synced') this.eventState.error = undefined;
  }

  /** Return true when every resource kind has a healthy synced cache. */
  public resourcesReady(): boolean {
    return WATCH_RESOURCE_KINDS.every((kind) => {
      const state = this.states.get(kind);
      return state?.status === 'synced' && state.syncingScopes.size === 0 && state.unhealthyScopes.size === 0;
    });
  }

  /** Return true while one or more resource kinds are actively warming. */
  public resourcesWarming(): boolean {
    return WATCH_RESOURCE_KINDS.some((kind) => {
      const state = this.states.get(kind);
      return state?.status === 'syncing' || Boolean(state?.syncingScopes.size);
    }) && !this.hasUnhealthyResources();
  }

  /** Return true when event watch state is healthy and synced. */
  public eventsReady(): boolean {
    return this.eventState.status === 'synced' && this.eventState.syncingScopes.size === 0 && this.eventState.unhealthyScopes.size === 0;
  }

  /** Return true while the event watch is actively warming. */
  public eventsWarming(): boolean {
    return this.eventState.status === 'syncing' || this.eventState.syncingScopes.size > 0;
  }

  /** Return a deterministic raw resource snapshot from cache. */
  public getResourceSnapshot(): WatchResourceSnapshot | null {
    if (!this.resourcesReady()) return null;
    return {
      pods: this.sorted('pods', true),
      deployments: this.sorted('deployments', true),
      statefulSets: this.sorted('statefulSets', true),
      daemonSets: this.sorted('daemonSets', true),
      cronJobs: this.sorted('cronJobs', true),
      jobs: this.sorted('jobs', true),
      services: this.sorted('services', true),
      ingresses: this.sorted('ingresses', true),
      pvcs: this.sorted('pvcs', true),
      nodes: this.sorted('nodes', false),
      namespaces: this.sorted('namespaces', false),
    };
  }

  /** Return cached events newer than the requested age. */
  public getRecentEvents(maxAgeMs: number): any[] | null {
    if (!this.eventsReady()) return null;
    const cutoff = Date.now() - maxAgeMs;
    return filterNamespaceItems(
      this.events.filter((event) => eventTimestamp(event) > cutoff),
      (event) => event?.metadata?.namespace || event?.involvedObject?.namespace
    )
      .sort((left, right) => eventTimestamp(left) - eventTimestamp(right));
  }

  /** Return whether the cache has an unhealthy kind. */
  public hasUnhealthyResources(): boolean {
    return WATCH_RESOURCE_KINDS.some((kind) => {
      const state = this.states.get(kind);
      return state?.status === 'unhealthy' || Boolean(state?.unhealthyScopes.size);
    });
  }

  private stateFor(kind: WatchKind): KindState {
    if (kind === 'events') {
      return this.eventState;
    }
    const state = this.states.get(kind) || emptyState();
    this.states.set(kind, state);
    return state;
  }

  private keyFor(kind: WatchResourceKind, item: any): string {
    return kind === 'nodes' || kind === 'namespaces' ? clusterKey(item) : namespacedKey(item);
  }

  private statusAfterScopeUpdate(state: KindState): WatchStatus {
    if (state.unhealthyScopes.size > 0) return 'unhealthy';
    if (state.syncingScopes.size > 0) return 'syncing';
    return 'synced';
  }

  private sorted(kind: WatchResourceKind, namespaced: boolean): any[] {
    const values = Array.from(this.states.get(kind)?.items.values() || []);
    const scoped = namespaced ? filterNamespaceItems(values, (item) => item?.metadata?.namespace) : values;
    return scoped.sort((left, right) => {
      const leftKey = namespaced ? namespacedKey(left) : clusterKey(left);
      const rightKey = namespaced ? namespacedKey(right) : clusterKey(right);
      return leftKey.localeCompare(rightKey);
    });
  }

  private pruneEvents(): void {
    const cutoff = Date.now() - this.maxEventAgeMs;
    const retained = this.events.filter((event) => eventTimestamp(event) > cutoff);
    this.events.length = 0;
    this.events.push(...retained);
  }

  private upsertEvent(event: any): void {
    const key = eventKey(event);
    if (!key) {
      this.events.push(event);
      return;
    }
    const existingIndex = this.events.findIndex((candidate) => eventKey(candidate) === key);
    if (existingIndex >= 0) {
      this.events[existingIndex] = event;
      return;
    }
    this.events.push(event);
  }
}
