/** Convert a Kubernetes Pod object into the snapshot pod shape. */
export function mapPod(p: any): Record<string, unknown> {
  return {
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    uid: p.metadata?.uid,
    labels: p.metadata?.labels,
    ownerReferences: p.metadata?.ownerReferences?.map((owner: any) => ({
      apiVersion: owner.apiVersion,
      kind: owner.kind,
      name: owner.name,
      uid: owner.uid,
      controller: owner.controller,
      blockOwnerDeletion: owner.blockOwnerDeletion,
    })),
    creationTimestamp: p.metadata?.creationTimestamp,
    phase: p.status?.phase,
    nodeName: p.spec?.nodeName,
    restartCount: (p.status?.containerStatuses || []).reduce((sum: number, status: any) => sum + (status.restartCount || 0), 0),
    containerStatuses: p.status?.containerStatuses?.map((cs: any) => ({
      name: cs.name,
      ready: cs.ready,
      restartCount: cs.restartCount,
      state: cs.state,
      lastState: cs.lastState,
    })),
  };
}

/** Convert a Kubernetes Deployment object into the snapshot deployment shape. */
export function mapDeployment(d: any): Record<string, unknown> {
  return {
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    uid: d.metadata?.uid,
    creationTimestamp: d.metadata?.creationTimestamp,
    replicas: d.status?.replicas,
    availableReplicas: d.status?.availableReplicas,
    readyReplicas: d.status?.readyReplicas,
  };
}

/** Convert a Kubernetes StatefulSet object into the snapshot statefulset shape. */
export function mapStatefulSet(s: any): Record<string, unknown> {
  return {
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    uid: s.metadata?.uid,
    creationTimestamp: s.metadata?.creationTimestamp,
    replicas: s.status?.replicas,
    availableReplicas: s.status?.availableReplicas,
    readyReplicas: s.status?.readyReplicas,
  };
}

/** Convert a Kubernetes DaemonSet object into the snapshot daemonset shape. */
export function mapDaemonSet(d: any): Record<string, unknown> {
  return {
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    uid: d.metadata?.uid,
    creationTimestamp: d.metadata?.creationTimestamp,
    replicas: d.status?.desiredNumberScheduled,
    availableReplicas: d.status?.numberAvailable,
    readyReplicas: d.status?.numberReady,
  };
}

/** Convert a Kubernetes CronJob object into the snapshot cronjob shape. */
export function mapCronJob(c: any): Record<string, unknown> {
  return {
    name: c.metadata?.name,
    namespace: c.metadata?.namespace,
    uid: c.metadata?.uid,
    creationTimestamp: c.metadata?.creationTimestamp,
    schedule: c.spec?.schedule,
    suspend: c.spec?.suspend,
    active: c.status?.active?.length || 0,
    lastScheduleTime: c.status?.lastScheduleTime,
  };
}

/** Convert a Kubernetes Job object into the snapshot job shape. */
export function mapJob(j: any): Record<string, unknown> {
  return {
    name: j.metadata?.name,
    namespace: j.metadata?.namespace,
    uid: j.metadata?.uid,
    creationTimestamp: j.metadata?.creationTimestamp,
    completions: j.spec?.completions,
    succeeded: j.status?.succeeded,
    failed: j.status?.failed,
    active: j.status?.active,
    startTime: j.status?.startTime,
    completionTime: j.status?.completionTime,
  };
}

/** Convert a Kubernetes Service object into the snapshot service shape. */
export function mapService(s: any): Record<string, unknown> {
  return {
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    uid: s.metadata?.uid,
    creationTimestamp: s.metadata?.creationTimestamp,
    type: s.spec?.type,
    clusterIP: s.spec?.clusterIP,
    selector: s.spec?.selector || {},
    externalIPs: s.spec?.externalIPs || [],
    loadBalancerIP: s.spec?.loadBalancerIP,
    ports: s.spec?.ports?.map((port: any) => ({
      name: port.name,
      port: port.port,
      protocol: port.protocol,
      targetPort: port.targetPort,
      nodePort: port.nodePort,
    })) || [],
  };
}

/** Convert a Kubernetes Ingress object into the snapshot ingress shape. */
export function mapIngress(i: any): Record<string, unknown> {
  const addresses = i.status?.loadBalancer?.ingress
    ?.map((entry: any) => entry.hostname || entry.ip)
    .filter((value: unknown): value is string => Boolean(value)) || [];
  const rules = i.spec?.rules
    ?.map((rule: any) => ({
      host: rule.host,
      paths: rule.http?.paths?.map((path: any) => ({
        path: path.path,
        pathType: path.pathType,
        serviceName: path.backend?.service?.name,
        servicePort: path.backend?.service?.port?.name || path.backend?.service?.port?.number,
      })) || [],
    })) || [];
  const hosts = rules
    .map((rule: any) => rule.host)
    .filter((value: unknown): value is string => Boolean(value)) || [];

  return {
    name: i.metadata?.name,
    namespace: i.metadata?.namespace,
    uid: i.metadata?.uid,
    creationTimestamp: i.metadata?.creationTimestamp,
    ingressClassName: i.spec?.ingressClassName,
    hosts,
    address: addresses.join(', '),
    rules,
    tls: i.spec?.tls?.map((tls: any) => ({
      hosts: tls.hosts || [],
      secretName: tls.secretName,
    })) || [],
  };
}

/** Convert a Kubernetes PVC object into the snapshot PVC shape. */
export function mapPvc(pvc: any): Record<string, unknown> {
  return {
    name: pvc.metadata?.name,
    namespace: pvc.metadata?.namespace,
    uid: pvc.metadata?.uid,
    creationTimestamp: pvc.metadata?.creationTimestamp,
    status: pvc.status?.phase,
    capacity: pvc.status?.capacity?.storage,
    accessModes: pvc.spec?.accessModes || [],
    storageClass: pvc.spec?.storageClassName,
    volumeName: pvc.spec?.volumeName,
    volumeMode: pvc.spec?.volumeMode,
  };
}

/** Convert a Kubernetes Node object into the snapshot node shape. */
export function mapNode(n: any): Record<string, unknown> {
  return {
    name: n.metadata?.name,
    uid: n.metadata?.uid,
    labels: n.metadata?.labels || {},
    kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
    osImage: n.status?.nodeInfo?.osImage,
    containerRuntimeVersion: n.status?.nodeInfo?.containerRuntimeVersion,
    architecture: n.status?.nodeInfo?.architecture,
    operatingSystem: n.status?.nodeInfo?.operatingSystem,
    capacity: n.status?.capacity || {},
    allocatable: n.status?.allocatable || {},
    status: {
      conditions: n.status?.conditions?.map((c: any) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message,
      })),
    },
  };
}

/** Convert a Kubernetes Namespace object into the snapshot namespace shape. */
export function mapNamespace(ns: any): Record<string, unknown> {
  return {
    name: ns.metadata?.name,
    uid: ns.metadata?.uid,
    creationTimestamp: ns.metadata?.creationTimestamp,
    labels: ns.metadata?.labels || {},
    status: ns.status?.phase,
  };
}
