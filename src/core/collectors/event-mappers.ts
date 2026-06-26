/** Return the best timestamp field for a Kubernetes Event object. */
export function getEventTimestamp(event: any): string | undefined {
  return event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp;
}

/** Convert a Kubernetes Warning Event into the snapshot event shape. */
export function mapWarningEvent(e: any): Record<string, unknown> {
  return {
    involvedObject: {
      kind: e.involvedObject?.kind,
      name: e.involvedObject?.name,
      namespace: e.involvedObject?.namespace,
      uid: e.involvedObject?.uid,
    },
    reason: e.reason,
    message: e.message,
    type: e.type,
    count: e.count,
    firstTimestamp: e.firstTimestamp,
    lastTimestamp: getEventTimestamp(e),
    reportingComponent: e.reportingComponent || e.source?.component,
  };
}

/** Return whether an event is newer than the requested age. */
export function isEventWithinAge(event: any, maxAgeMs: number): boolean {
  const eventTime = getEventTimestamp(event);
  if (!eventTime) return true;
  return new Date(eventTime as any).getTime() > (Date.now() - maxAgeMs);
}
