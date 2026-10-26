import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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

function expectAnyFailure(args, message) {
  try {
    helmTemplate(args);
  } catch {
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
const additionalCaValuesPath = 'config.tls.additionalCaBundle';
const additionalCaPath = '/etc/acornops/trust/platform-ca.pem';
const configMapCaArgs = [
  '--set-string',
  `${additionalCaValuesPath}.configMapKeyRef.name=organization-configmap-trust`,
  '--set-string',
  `${additionalCaValuesPath}.configMapKeyRef.key=configmap-ca.crt`
];
const secretCaArgs = [
  '--set-string',
  `${additionalCaValuesPath}.secretKeyRef.name=organization-secret-trust`,
  '--set-string',
  `${additionalCaValuesPath}.secretKeyRef.key=secret-ca.pem`
];
const inlineCaArgs = [
  '--set-file',
  `${additionalCaValuesPath}.inlinePem=test/fixtures/organization-ca.pem`
];

const readOnly = helmTemplate(baseArgs);
const managedKeyChecksum = createHash('sha256').update('test-key').digest('hex');
assertIncludes(readOnly, `checksum/agent-key: ${managedKeyChecksum}`, 'managed key must roll out pods when changed');
assert.equal(helmTemplate(baseArgs), readOnly, 'unchanged values must render deterministically');
const changedKey = helmTemplate([...baseArgs, '--set-string', 'config.agentKey=replacement-key']);
assertExcludes(changedKey, `checksum/agent-key: ${managedKeyChecksum}`, 'replaced key must change the pod checksum');
assertIncludes(changedKey, `checksum/agent-key: ${createHash('sha256').update('replacement-key').digest('hex')}`, 'checksum must cover the replacement key');
const customAnnotations = helmTemplate([...baseArgs, '--set-json', 'podAnnotations={"checksum/agent-key":"override","example.com/custom":"preserved"}']);
assertIncludes(customAnnotations, `checksum/agent-key: ${managedKeyChecksum}`, 'managed key checksum must override conflicting annotations');
assertIncludes(customAnnotations, 'example.com/custom: preserved', 'key checksum must preserve other annotations');
const externalKeyArgs = [...baseArgs, '--set-string', 'existingSecret.name=operator-owned'];
const externalKey = helmTemplate(externalKeyArgs);
assertExcludes(externalKey, 'checksum/agent-key:', 'external Secrets remain operator-owned');
assert.equal(helmTemplate([...externalKeyArgs, '--set-string', 'config.agentKey=ignored-key']), externalKey, 'unused managed key must not restart external-Secret pods');
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
assertMatch(readOnly, /name: ACORNOPS_AGENT_WORKLOAD_PATCH_KINDS\s+value: "Deployment,StatefulSet,DaemonSet"/, 'workload patch kinds should default to existing workload RBAC');
assertMatch(readOnly, /name: ACORNOPS_AGENT_RESOURCE_PATCH_KINDS\s+value: ""/, 'resource patch kinds should default empty');
assertMatch(readOnly, /name: ACORNOPS_AGENT_ALLOW_ENV_PATCH\s+value: "false"/, 'environment patching should default false');
assertMatch(readOnly, /name: ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH\s+value: "false"/, 'ConfigMap patching should default false');
assertMatch(readOnly, /name: ACORNOPS_AGENT_ALLOW_SERVICE_SELECTOR_PATCH\s+value: "false"/, 'Service selector patching should default false');
assertIncludes(readOnly, 'fieldPath: metadata.uid', 'deployment should inject pod UID for leader identity');
assertExcludes(readOnly, 'verbs: ["patch"]', 'default RBAC must not include workload write verbs');
assertExcludes(readOnly, 'resources: ["leases"]', 'default install should not grant Lease RBAC');
assertIncludes(
  readOnly,
  'resources: ["pods", "pods/log", "services", "persistentvolumeclaims", "events", "nodes", "namespaces"]',
  'cluster RBAC should allow namespace discovery'
);
assertExcludes(readOnly, 'resources: ["configmaps"]', 'default RBAC must not grant ConfigMap access');
assertIncludes(readOnly, 'kind: Secret', 'default install should create the agent key Secret');
assertExcludes(readOnly, 'platform-additional-ca', 'default chart should not render an additional CA volume or mount');
assertExcludes(readOnly, 'NODE_EXTRA_CA_CERTS', 'default chart should not configure Node.js additional CA trust');
assertExcludes(readOnly, additionalCaPath, 'default chart should not render the fixed additional CA path');
assertExcludes(readOnly, 'NODE_TLS_REJECT_UNAUTHORIZED', 'chart must not disable Node.js TLS verification');

const configMapCa = helmTemplate([...baseArgs, ...configMapCaArgs]);
assertMatch(
  configMapCa,
  new RegExp(`name: NODE_EXTRA_CA_CERTS\\s+value: "${additionalCaPath}"`),
  'ConfigMap CA should configure Node.js with the fixed path'
);
assertMatch(
  configMapCa,
  new RegExp(`name: platform-additional-ca\\s+mountPath: "${additionalCaPath}"\\s+subPath: platform-ca.pem\\s+readOnly: true`),
  'ConfigMap CA should use the fixed read-only mount'
);
assertMatch(
  configMapCa,
  /name: platform-additional-ca\s+configMap:\s+name: "organization-configmap-trust"\s+items:\s+- key: "configmap-ca\.crt"\s+path: platform-ca\.pem/,
  'ConfigMap CA should map the configured resource key to the fixed filename'
);
assertExcludes(configMapCa, 'optional:', 'ConfigMap CA source should fail closed when the resource or key is missing');

const secretCa = helmTemplate([...baseArgs, ...secretCaArgs]);
assertMatch(
  secretCa,
  new RegExp(`name: NODE_EXTRA_CA_CERTS\\s+value: "${additionalCaPath}"`),
  'Secret CA should configure Node.js with the fixed path'
);
assertMatch(
  secretCa,
  new RegExp(`name: platform-additional-ca\\s+mountPath: "${additionalCaPath}"\\s+subPath: platform-ca.pem\\s+readOnly: true`),
  'Secret CA should use the fixed read-only mount'
);
assertMatch(
  secretCa,
  /name: platform-additional-ca\s+secret:\s+secretName: "organization-secret-trust"\s+items:\s+- key: "secret-ca\.pem"\s+path: platform-ca\.pem/,
  'Secret CA should map the configured resource key to the fixed filename'
);
assertExcludes(secretCa, 'optional:', 'Secret CA source should fail closed when the resource or key is missing');

const inlineCa = helmTemplate([...baseArgs, ...inlineCaArgs]);
assertMatch(
  inlineCa,
  /kind: ConfigMap\s+metadata:\s+name: acornops-agent-platform-ca[\s\S]*ca\.crt: \|-\s+-----BEGIN CERTIFICATE-----/,
  'inline CA should render a chart-managed ConfigMap'
);
assertMatch(
  inlineCa,
  /name: platform-additional-ca\s+configMap:\s+name: "acornops-agent-platform-ca"\s+items:\s+- key: ca\.crt\s+path: platform-ca\.pem/,
  'inline CA should mount the chart-managed ConfigMap'
);
assertMatch(
  inlineCa,
  /checksum\/platform-additional-ca: [a-f0-9]{64}/,
  'inline CA should restart AgentK when the managed bundle changes'
);
assertMatch(
  inlineCa,
  new RegExp(`name: NODE_EXTRA_CA_CERTS\\s+value: "${additionalCaPath}"`),
  'inline CA should configure Node.js with the fixed path'
);
assertExcludes(inlineCa, 'BEGIN PRIVATE KEY', 'inline CA must not contain private key material');

const inlineCaWithAnnotations = helmTemplate([
  ...baseArgs,
  ...inlineCaArgs,
  '--set-json',
  'podAnnotations={"checksum/platform-additional-ca":"override","example.com/custom":"preserved"}'
]);
assertExcludes(
  inlineCaWithAnnotations,
  'checksum/platform-additional-ca: override',
  'chart-owned inline CA checksum should override a conflicting pod annotation'
);
assertMatch(
  inlineCaWithAnnotations,
  /checksum\/platform-additional-ca: [a-f0-9]{64}/,
  'chart-owned inline CA checksum should remain authoritative'
);
assertIncludes(
  inlineCaWithAnnotations,
  'example.com/custom: preserved',
  'inline CA checksum handling should preserve unrelated pod annotations'
);

for (const caRender of [configMapCa, secretCa]) {
  assertExcludes(caRender, 'NODE_TLS_REJECT_UNAUTHORIZED', 'additional CA trust must preserve TLS verification');
  assertExcludes(caRender, 'BEGIN CERTIFICATE', 'chart must not render inline CA certificate material');
  assertExcludes(caRender, 'BEGIN PRIVATE KEY', 'chart must not render private key material');
}

const writeEnabled = helmTemplate([...baseArgs, '--set', 'rbac.write.enabled=true']);
assertMatch(writeEnabled, /name: ACORNOPS_AGENT_WRITE_ENABLED\s+value: "true"/, 'write env should follow rbac.write.enabled');
assertIncludes(writeEnabled, 'resources: ["deployments", "statefulsets", "daemonsets"]', 'write RBAC should cover only supported workload parents');
assertIncludes(writeEnabled, 'verbs: ["patch"]', 'write RBAC should grant only patch');
assertExcludes(writeEnabled, 'deployments/scale', 'write RBAC should not grant scale subresources');
assertExcludes(writeEnabled, 'verbs: ["patch", "update"]', 'write RBAC should not grant update');
assertExcludes(writeEnabled, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'default write RBAC should not patch CronJobs');
assertExcludes(writeEnabled, 'resources: ["services"]\n    verbs: ["patch"]', 'default write RBAC should not patch Services');
assertExcludes(writeEnabled, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'default write RBAC should not patch Ingresses');
assertExcludes(writeEnabled, 'resources: ["configmaps"]\n    verbs: ["patch"]', 'default write RBAC should not patch ConfigMaps');

const cnpgAddition = JSON.stringify([{
  key: 'cnpg', name: 'CNPG', description: 'CloudNativePG clusters',
  resources: [{
    apiGroup: 'postgresql.cnpg.io', apiVersion: 'v1', resource: 'clusters', kind: 'Cluster',
    scope: 'namespaced', verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete']
  }]
}]);
const readOnlyCnpg = helmTemplate([...baseArgs, '--set-json', `rbac.additions=${cnpgAddition}`]);
assertIncludes(readOnlyCnpg, 'resources: ["clusters"]\n    verbs: ["get","list"]', 'read-only additions should grant configured read verbs');
assertMatch(readOnlyCnpg, /name: ACORNOPS_AGENT_RBAC_ADDITIONS_JSON\s+value: "\[/, 'deployment should receive the immutable addition snapshot');
const readWriteCnpg = helmTemplate([...baseArgs, '--set-json', `rbac.additions=${cnpgAddition}`, '--set', 'rbac.write.enabled=true']);
assertIncludes(readWriteCnpg, 'resources: ["clusters"]\n    verbs: ["get","list","patch"]', 'read-write additions should grant configured custom-resource patch access');
assertExcludes(readWriteCnpg, 'verbs: ["get","list","watch","create","patch","delete"]', 'removed custom-resource tools must not retain RBAC');
expectFailure(
  [...baseArgs, '--set-json', `rbac.additions=${JSON.stringify([{
    key: 'cluster-wide', name: 'Cluster wide', resources: [{
      apiGroup: 'example.io', apiVersion: 'v1', resource: 'globals', kind: 'Global', scope: 'cluster', verbs: ['list']
    }]
  }])}`, '--set-string', 'rbac.scope=namespace'],
  'is cluster-scoped and cannot be used with rbac.scope=namespace'
);

const expandedPatchKinds = helmTemplate([
  ...baseArgs,
  '--set',
  'rbac.write.enabled=true',
  '--set-json',
  'patchPolicy.workloadKinds=["Deployment","StatefulSet","DaemonSet","CronJob"]',
  '--set-json',
  'patchPolicy.resourceKinds=["Service","Ingress"]',
  '--set',
  'patchPolicy.allowEnvChanges=true',
  '--set',
  'patchPolicy.allowConfigMapChanges=true',
  '--set',
  'patchPolicy.allowServiceSelectorChanges=true'
]);
assertIncludes(expandedPatchKinds, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'CronJob patch opt-in should add exact batch RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["services"]\n    verbs: ["patch"]', 'Service patch opt-in should add exact core RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'Ingress patch opt-in should add exact networking RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["configmaps"]\n    verbs: ["get", "list", "watch"]', 'ConfigMap patch opt-in should add prerequisite read RBAC');
assertIncludes(expandedPatchKinds, 'resources: ["configmaps"]\n    verbs: ["patch"]', 'ConfigMap patch opt-in should add exact core RBAC');
assertMatch(expandedPatchKinds, /name: ACORNOPS_AGENT_ALLOW_ENV_PATCH\s+value: "true"/, 'environment operator opt-in should reach AgentK');
assertMatch(expandedPatchKinds, /name: ACORNOPS_AGENT_ALLOW_CONFIGMAP_PATCH\s+value: "true"/, 'ConfigMap operator opt-in should reach AgentK');
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
assertExcludes(namespaceScoped, 'resources: ["configmaps"]', 'default namespace RBAC must not grant ConfigMap access');
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
  'patchPolicy.workloadKinds=["Deployment","StatefulSet","DaemonSet","CronJob"]',
  '--set-json',
  'patchPolicy.resourceKinds=["Service","Ingress"]',
  '--set',
  'patchPolicy.allowConfigMapChanges=true'
]);
assertExcludes(namespaceExpandedPatchKinds, 'kind: ClusterRole', 'expanded namespace patch RBAC should remain Role-scoped');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["cronjobs"]\n    verbs: ["patch"]', 'namespace CronJob opt-in should add exact batch RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["services"]\n    verbs: ["patch"]', 'namespace Service opt-in should add exact core RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["ingresses"]\n    verbs: ["patch"]', 'namespace Ingress opt-in should add exact networking RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["configmaps"]\n    verbs: ["get", "list", "watch"]', 'namespace ConfigMap opt-in should add prerequisite read RBAC');
assertIncludes(namespaceExpandedPatchKinds, 'resources: ["configmaps"]\n    verbs: ["patch"]', 'namespace ConfigMap opt-in should add exact core RBAC');
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

for (const [args, message] of [
  [[...configMapCaArgs, ...secretCaArgs], 'ConfigMap and Secret CA sources should be mutually exclusive'],
  [[...inlineCaArgs, ...configMapCaArgs], 'inline and ConfigMap CA sources should be mutually exclusive'],
  [[...inlineCaArgs, ...secretCaArgs], 'inline and Secret CA sources should be mutually exclusive'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.key=ca.crt`
  ], 'ConfigMap CA source should require a name'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.name=organization-trust`
  ], 'ConfigMap CA source should require a key'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.name=`,
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.key=ca.crt`
  ], 'ConfigMap CA source should reject an empty name'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.name=organization-trust`,
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.key=`
  ], 'ConfigMap CA source should reject an empty key'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.key=ca.crt`
  ], 'Secret CA source should require a name'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.name=organization-trust`
  ], 'Secret CA source should require a key'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.name=`,
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.key=ca.crt`
  ], 'Secret CA source should reject an empty name'],
  [[
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.name=organization-trust`,
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.key=`
  ], 'Secret CA source should reject an empty key'],
  [[...configMapCaArgs, '--set-string', `${additionalCaValuesPath}.configMapKeyRef.namespace=other`], 'cross-namespace CA fields should be rejected'],
  [['--set-string', `${additionalCaValuesPath}.inlinePem=not-a-certificate`], 'inline CA should require PEM certificate material'],
  [['--set-string', `${additionalCaValuesPath}.inlinePem=-----BEGIN PRIVATE KEY-----`], 'inline CA should reject private key material'],
  [['--set', 'config.tls.skipTlsVerify=true'], 'TLS verification bypass fields should be rejected']
]) {
  expectAnyFailure([...baseArgs, ...args], message);
}

expectFailure(
  ['--skip-schema-validation', ...baseArgs, ...configMapCaArgs, ...secretCaArgs],
  'config.tls.additionalCaBundle must configure only one of inlinePem, configMapKeyRef, or secretKeyRef'
);
expectFailure(
  ['--skip-schema-validation', ...baseArgs, ...inlineCaArgs, ...configMapCaArgs],
  'config.tls.additionalCaBundle must configure only one of inlinePem, configMapKeyRef, or secretKeyRef'
);
expectFailure(
  [
    '--skip-schema-validation',
    ...baseArgs,
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.key=ca.crt`
  ],
  'config.tls.additionalCaBundle.configMapKeyRef.name is required when configMapKeyRef is configured'
);
expectFailure(
  [
    '--skip-schema-validation',
    ...baseArgs,
    '--set-string',
    `${additionalCaValuesPath}.configMapKeyRef.name=organization-trust`
  ],
  'config.tls.additionalCaBundle.configMapKeyRef.key is required when configMapKeyRef is configured'
);
expectFailure(
  [
    '--skip-schema-validation',
    ...baseArgs,
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.key=ca.crt`
  ],
  'config.tls.additionalCaBundle.secretKeyRef.name is required when secretKeyRef is configured'
);
expectFailure(
  [
    '--skip-schema-validation',
    ...baseArgs,
    '--set-string',
    `${additionalCaValuesPath}.secretKeyRef.name=organization-trust`
  ],
  'config.tls.additionalCaBundle.secretKeyRef.key is required when secretKeyRef is configured'
);

console.log('Helm chart template checks passed.');
