export interface WriteReceipt {
  success: true;
  operationId: string;
  target: {
    kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob' | 'Service' | 'Ingress';
    namespace: string;
    name: string;
    uid: string;
  };
  change:
    | { type: 'restart'; restartedAt: string }
    | {
        type: 'scale';
        previousReplicas: number;
        requestedReplicas: number;
        hpaOverride: boolean;
      }
    | {
        type: 'patch';
        changeCount: number;
        rolloutTriggered: boolean;
        serviceRoutingChanged: boolean;
        fields: Array<{ type: string; location: string }>;
      };
  observed: {
    resourceVersion: string;
    generation?: number;
  };
  warnings?: string[];
}
