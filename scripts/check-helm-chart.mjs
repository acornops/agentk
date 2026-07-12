import { spawnSync } from 'node:child_process';

const chart = 'charts/acornops-agentk';

function helmTemplate(args = []) {
  const result = spawnSync('helm', ['template', 'acornops-agent', chart, '--namespace', 'acornops', ...args], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `helm template exited ${result.status}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

function assertIncludes(output, needle, message) {
  if (!output.includes(needle)) {
    throw new Error(`${message}\nMissing: ${needle}`);
  }
}

function assertExcludes(output, needle, message) {
  if (output.includes(needle)) {
    throw new Error(`${message}\nUnexpected: ${needle}`);
  }
}

function assertMatch(output, pattern, message) {
  if (!pattern.test(output)) {
    throw new Error(`${message}\nPattern: ${pattern}`);
  }
}

function expectFailure(args, message) {
  try {
    helmTemplate(args);
  } catch (error) {
    const stderr = error.stderr?.toString() || error.message;
    if (!stderr.includes(message)) {
      throw new Error(`Expected failure containing "${message}", got:\n${stderr}`);
    }
    return;
  }
  throw new Error(`Expected helm template to fail: ${message}`);
}

const baseArgs = [
  '--set-string',
  'config.platformUrl=https://api.acornops.dev',
  '--set-string',
  'config.clusterId=cluster-1',
  '--set-string',
  'config.agentKey=test-key'
];

const readOnly = helmTemplate(baseArgs);
assertIncludes(
  readOnly,
  'value: "wss://api.acornops.dev/api/v1/agent/connect"',
  'config.platformUrl should derive the agent WebSocket URL'
);
assertMatch(readOnly, /name: ACORNOPS_CLUSTER_ID\s+value: "cluster-1"/, 'deployment should expose cluster id env');
assertExcludes(readOnly, 'name: ACORNOPS_TARGET_ID', 'deployment should derive target scope inside the Kubernetes agent');
assertIncludes(readOnly, 'name: ACORNOPS_AGENT_WRITE_ENABLED', 'deployment should expose write capability env');
assertMatch(readOnly, /name: ACORNOPS_AGENT_WRITE_ENABLED\s+value: "false"/, 'write env should default false');
assertMatch(readOnly, /name: ACORNOPS_AGENT_LEADER_ELECTION_ENABLED\s+value: "false"/, 'leader election should default false');
assertMatch(readOnly, /name: ACORNOPS_AGENT_K8S_CONCURRENCY\s+value: "8"/, 'k8s concurrency env should default 8');
assertMatch(readOnly, /name: ACORNOPS_AGENT_K8S_LIST_PAGE_LIMIT\s+value: "500"/, 'k8s list page limit env should default 500');
assertMatch(readOnly, /name: ACORNOPS_AGENT_WATCH_CACHE_ENABLED\s+value: "true"/, 'watch cache env should default true');
assertMatch(readOnly, /name: ACORNOPS_AGENT_WATCH_SNAPSHOT_DEBOUNCE_MS\s+value: "5000"/, 'watch debounce env should default 5000');
assertMatch(readOnly, /name: ACORNOPS_AGENT_WATCH_CACHE_SYNC_TIMEOUT_MS\s+value: "15000"/, 'watch sync timeout env should default 15000');
assertMatch(readOnly, /name: ACORNOPS_AGENT_WATCH_TIMEOUT_SECONDS\s+value: "300"/, 'watch timeout env should default 300');
assertMatch(readOnly, /name: ACORNOPS_AGENT_PATCH_KINDS\s+value: "Deployment,StatefulSet,DaemonSet"/, 'patch kinds should default to existing workload RBAC');
assertMatch(readOnly, /name: ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH\s+value: "false"/, 'Service selector patching should default false');
assertIncludes(readOnly, 'fieldPath: metadata.uid', 'deployment should inject pod UID for leader identity');
assertExcludes(readOnly, 'verbs: ["patch"]', 'default RBAC must not include workload write verbs');
assertExcludes(readOnly, 'resources: ["leases"]', 'default install should not grant Lease RBAC');
assertIncludes(
  readOnly,
  'resources: ["pods", "pods/log", "services", "persistentvolumeclaims", "events", "nodes", "namespaces"]',
  'cluster RBAC should allow namespace discovery'
);
assertIncludes(readOnly, 'kind: Secret', 'default install should create the agent key Secret');

const writeEnabled = helmTemplate([...baseArgs, '--set', 'rbac.write.enabled=true']);
assertMatch(writeEnabled, /name: ACORNOPS_AGENT_WRITE_ENABLED\s+value: "true"/, 'write env should follow rbac.write.enabled');
assertIncludes(writeEnabled, 'resources: ["deployments", "statefulsets", "daemonsets"]', 'write RBAC should cover only supported workload parents');
assertIncludes(writeEnabled, 'verbs: ["patch"]', 'write RBAC should grant only patch');
assertExcludes(writeEnabled, 'deployments/scale', 'write RBAC should not grant scale subresources');
assertExcludes(writeEnabled, 'verbs: ["patch", "update"]', 'write RBAC should not grant update');
assertExcludes(writeEnabled, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'default write RBAC should not patch CronJobs');
assertExcludes(writeEnabled, 'resources: ["services"]\n    verbs: ["patch"]', 'default write RBAC should not patch Services');
assertExcludes(writeEnabled, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'default write RBAC should not patch Ingresses');

const expandedPatchKinds = helmTemplate([
  ...baseArgs,
  '--set',
  'rbac.write.enabled=true',
  '--set-json',
  'patchPolicy.kinds=["Deployment","StatefulSet","DaemonSet","CronJob","Service","Ingress"]',
  '--set',
  'patchPolicy.allowServiceSelectorChanges=true'
]);
assertIncludes(expandedPatchKinds, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'CronJob patch opt-in should add exact batch RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["services"]\n    verbs: ["patch"]', 'Service patch opt-in should add exact core RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'Ingress patch opt-in should add exact networking RBAC');
assertMatch(expandedPatchKinds, /name: ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH\s+value: "true"/, 'selector operator opt-in should reach AgentK');

const existingSecret = helmTemplate([
  '--set-string',
  'config.platformUrl=https://api.acornops.dev',
  '--set-string',
  'config.clusterId=cluster-1',
  '--set-string',
  'existingSecret.name=precreated-agent-secret',
  '--set-string',
  'existingSecret.key=token'
]);
assertExcludes(existingSecret, 'kind: Secret', 'existingSecret should suppress generated Secret');
assertIncludes(existingSecret, 'name: precreated-agent-secret', 'deployment should reference existing Secret');
assertIncludes(existingSecret, 'key: token', 'deployment should reference existing Secret key');

const namespaceScoped = helmTemplate([
  ...baseArgs,
  '--set-string',
  'rbac.scope=namespace',
  '--set-json',
  'namespaceScope.include=["team-a","team-b"]'
]);
assertIncludes(namespaceScoped, 'kind: Role', 'namespace-scoped install should create Roles');
assertIncludes(namespaceScoped, 'namespace: team-a', 'namespace-scoped install should include team-a Role/Binding');
assertIncludes(namespaceScoped, 'namespace: team-b', 'namespace-scoped install should include team-b Role/Binding');
assertExcludes(namespaceScoped, 'kind: ClusterRole', 'namespace-scoped install should avoid ClusterRole');
assertExcludes(namespaceScoped, 'resources: ["pods", "pods/log", "services", "persistentvolumeclaims", "events", "nodes", "namespaces"]', 'namespace-scoped install should not grant cluster namespace discovery');
assertIncludes(namespaceScoped, 'value: "team-a,team-b"', 'namespace include should set ACORNOPS_AGENT_WATCH_NAMESPACES');

const namespaceWrite = helmTemplate([
  ...baseArgs,
  '--set-string',
  'rbac.scope=namespace',
  '--set-json',
  'rbac.namespaces=["team-a"]',
  '--set',
  'rbac.write.enabled=true'
]);
assertExcludes(namespaceWrite, 'kind: ClusterRole', 'namespace write install should remain Role-scoped');
assertIncludes(namespaceWrite, 'resources: ["deployments", "statefulsets", "daemonsets"]', 'namespace write RBAC should cover only workload parents');
assertIncludes(namespaceWrite, 'verbs: ["patch"]', 'namespace write RBAC should grant patch');

const namespaceExpandedPatchKinds = helmTemplate([
  ...baseArgs,
  '--set-string',
  'rbac.scope=namespace',
  '--set-json',
  'rbac.namespaces=["team-a"]',
  '--set',
  'rbac.write.enabled=true',
  '--set-json',
  'patchPolicy.kinds=["Deployment","StatefulSet","DaemonSet","CronJob","Service","Ingress"]'
]);
assertExcludes(namespaceExpandedPatchKinds, 'kind: ClusterRole', 'expanded namespace patch RBAC should remain Role-scoped');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'namespace CronJob opt-in should add exact batch RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["services"]\n    verbs: ["patch"]', 'namespace Service opt-in should add exact core RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'namespace Ingress opt-in should add exact networking RBAC');
assertExcludes(namespaceWrite, 'deployments/scale', 'namespace write RBAC should not grant scale subresources');
assertExcludes(namespaceWrite, 'verbs: ["patch", "update"]', 'namespace write RBAC should not grant update');

const explicitScopeWins = helmTemplate([
  ...baseArgs,
  '--set-string',
  'config.watchNamespaces=legacy',
  '--set-json',
  'namespaceScope.include=["team-a"]'
]);
assertIncludes(explicitScopeWins, 'value: "team-a"', 'namespaceScope.include should be the local maximum when explicitly configured');
assertExcludes(explicitScopeWins, 'value: "legacy"', 'legacy watch namespaces should not override explicit namespaceScope.include');

const explicitWebsocket = helmTemplate([
  '--set-string',
  'config.websocketUrl=wss://edge.example.net/custom-agent',
  '--set-string',
  'config.clusterId=cluster-1',
  '--set-string',
  'config.agentKey=test-key'
]);
assertIncludes(
  explicitWebsocket,
  'value: "wss://edge.example.net/custom-agent"',
  'config.websocketUrl should pass through exactly'
);

const haEnabled = helmTemplate([
  ...baseArgs,
  '--set',
  'replicaCount=2',
  '--set',
  'leaderElection.enabled=true',
  '--set-string',
  'leaderElection.leaseName=agent-ha',
  '--set',
  'podDisruptionBudget.enabled=true'
]);
assertMatch(haEnabled, /replicas: 2/, 'HA install should render multiple replicas');
assertMatch(haEnabled, /name: ACORNOPS_AGENT_LEADER_ELECTION_ENABLED\s+value: "true"/, 'HA install should enable election env');
assertIncludes(haEnabled, 'value: "agent-ha"', 'HA install should render custom Lease name');
assertIncludes(haEnabled, 'resources: ["leases"]', 'HA install should grant namespaced Lease RBAC');
assertIncludes(haEnabled, 'kind: PodDisruptionBudget', 'PDB should render when enabled');

expectFailure(['--set-string', 'config.platformUrl=https://api.acornops.dev', '--set-string', 'config.clusterId=cluster-1'], 'config.agentKey is required');
expectFailure(['--set-string', 'config.agentKey=test-key', '--set-string', 'config.clusterId=cluster-1'], 'config.platformUrl or config.websocketUrl is required');
expectFailure([...baseArgs, '--set-string', 'config.platformUrl=http://api.acornops.dev'], 'config.platformUrl must use https://; http:// is not allowed');
expectFailure([
  '--set-string',
  'config.websocketUrl=ws://api.acornops.dev/api/v1/agent/connect',
  '--set-string',
  'config.clusterId=cluster-1',
  '--set-string',
  'config.agentKey=test-key'
], 'config.websocketUrl must use wss://; ws:// is not allowed');
expectFailure([...baseArgs, '--set', 'replicaCount=2'], 'leaderElection.enabled must be true when replicaCount is greater than 1');
expectFailure([...baseArgs, '--set', 'leaderElection.renewDeadlineMs=15000'], 'leaderElection.renewDeadlineMs must be less than leaderElection.leaseDurationMs');
expectFailure([...baseArgs, '--set', 'leaderElection.retryPeriodMs=11000'], 'leaderElection.retryPeriodMs must be less than or equal to leaderElection.renewDeadlineMs');

console.log('Helm chart template checks passed.');
