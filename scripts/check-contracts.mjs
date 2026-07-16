import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const failures = [];

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function expectIncludes(content, needle, message) {
  expect(content.includes(needle), `${message}: missing ${needle}`);
}

const readme = read('README.md');
const doc = read('docs/contracts/README.md');
const manifest = JSON.parse(read('docs/contracts/manifest.json'));
const lifecycle = read('src/core/lifecycle.ts');
const snapshotManager = read('src/core/snapshot-manager.ts');
const websocketClient = read('src/transport/websocket-client.ts');
const router = read('src/mcp/router.ts');
const listResources = read('src/tools/atomic/list-resources.ts');
const getResource = read('src/tools/atomic/get-resource.ts');
const getResourceLogs = read('src/tools/atomic/get-resource-logs.ts');
const restartWorkload = read('src/tools/atomic/restart-workload.ts');
const scaleWorkload = read('src/tools/atomic/scale.ts');
const patchResource = read('src/tools/atomic/patch-resource.ts');
const manualDeployment = read('deploy/deployment.yaml');
const manualRbac = read('deploy/rbac.yaml');
const localDevelopment = read('deploy/local-development.yaml');
const controlPlaneContract = manifest.counterparts?.['control-plane'];

expectIncludes(readme, '[`docs/contracts/README.md`](docs/contracts/README.md)', 'README contract link');
expectIncludes(readme, '[`docs/contracts/manifest.json`](docs/contracts/manifest.json)', 'README manifest link');
expect(manifest.repo === 'agentk', 'Manifest repo');
expect(
  JSON.stringify(controlPlaneContract?.agentTypeValues) === JSON.stringify(['agentk']),
  'Control-plane contract should expose only the canonical agentType value'
);
expectIncludes(lifecycle, "agentType: 'agentk'", 'Canonical agentType implementation');

for (const heading of [
  '# AgentK Contracts',
  '## Full Platform Matrix',
  '## Platform Dependency Summary',
  '## Control-Plane WebSocket Contract'
]) {
  expectIncludes(doc, heading, 'Contract doc heading');
}

for (const token of controlPlaneContract.handshakeRequestFields) {
  const sourceNeedle = token.includes('.') ? token.split('.').at(-1) : token;
  expectIncludes(doc, token, 'Handshake doc');
  expectIncludes(lifecycle, sourceNeedle, 'Lifecycle implementation');
}

for (const token of ['lifecycle/handshake', 'lifecycle/heartbeat', 'snapshotInterval', 'config/update_namespace_scope']) {
  expectIncludes(doc, token, 'Handshake doc');
  expectIncludes(lifecycle, token, 'Lifecycle implementation');
}

for (const token of controlPlaneContract.handshakeResponseFields) {
  expectIncludes(doc, token, 'Handshake response doc');
}
expectIncludes(lifecycle, 'remoteConfig?.maxSnapshotBytes', 'Handshake maxSnapshotBytes implementation');
expectIncludes(lifecycle, 'remoteConfig?.namespaceScope', 'Handshake namespace scope implementation');
expectIncludes(snapshotManager, 'compressed.length > this.maxSnapshotBytes', 'Snapshot size budget enforcement');

for (const header of controlPlaneContract.agentHeaders) {
  expectIncludes(doc, header, 'WebSocket header doc');
  expectIncludes(websocketClient, header, 'WebSocket header implementation');
}

expectIncludes(doc, 'notify/snapshot', 'Snapshot notification doc');
expectIncludes(doc, 'gzipped JSON-RPC notifications', 'Snapshot compression doc');
expectIncludes(snapshotManager, "createNotification('notify/snapshot'", 'Snapshot notification implementation');
expectIncludes(snapshotManager, 'gzipPayload', 'Snapshot compression implementation');

for (const method of controlPlaneContract.rpcMethods) {
  expectIncludes(doc, method, 'JSON-RPC method doc');
  expectIncludes(method.startsWith('config/') ? lifecycle : router, method, 'JSON-RPC router implementation');
}

for (const [source, toolName] of [
  [listResources, 'list_resources'],
  [getResource, 'get_resource'],
  [getResourceLogs, 'get_resource_logs'],
  [restartWorkload, 'restart_workload'],
  [scaleWorkload, 'scale_workload'],
  [patchResource, 'patch_resource']
]) {
  expectIncludes(doc, toolName, 'Builtin tool doc');
  expectIncludes(source, `name: '${toolName}'`, 'Builtin tool implementation');
}

expectIncludes(getResource, 'remediationTarget', 'get_resource owning workload resolution guidance');
expectIncludes(listResources, 'omit namespace entirely', 'list_resources all-namespace guidance');
expectIncludes(listResources, "value.namespace === 'all'", 'list_resources literal all rejection');
expectIncludes(getResource, 'UID-verified ownership path', 'get_resource guarded patch guidance');
expectIncludes(patchResource, 'after get_resource', 'patch_resource prerequisite read guidance');
expectIncludes(patchResource, 'expected_image is the current image', 'patch_resource image precondition guidance');
for (const code of ['RESOURCE_NOT_FOUND', 'KUBERNETES_FORBIDDEN', 'KUBERNETES_TIMEOUT', 'KUBERNETES_UNAVAILABLE']) {
  expectIncludes(doc, code, 'Sanitized Kubernetes tool error contract');
}

for (const field of controlPlaneContract.snapshotFields) {
  expectIncludes(doc, field, 'Snapshot field doc');
}

for (const field of controlPlaneContract.toolDescriptorFields) {
  expectIncludes(doc, field, 'Tool descriptor doc');
  expectIncludes(router, field, 'Tool descriptor implementation');
}

for (const field of controlPlaneContract.toolCallRequestFields) {
  expectIncludes(doc, field, 'Tool call request doc');
  expectIncludes(router, field, 'Tool call request implementation');
}

expect(
  /name: ACORNOPS_AGENT_WRITE_ENABLED\s+value: "false"/.test(manualDeployment),
  'Manual deployment must remain explicitly read-only'
);
expect(
  !/resources: \["deployments", "statefulsets", "daemonsets"\]\s+verbs: \["patch"\]/.test(manualRbac),
  'Manual RBAC must not grant workload patch access'
);
expect(
  /name: ACORNOPS_AGENT_WRITE_ENABLED\s+value: "true"/.test(localDevelopment),
  'Local development deployment must explicitly enable write tools'
);
expect(
  /resources: \["deployments", "statefulsets", "daemonsets"\]\s+verbs: \["patch"\]/.test(localDevelopment),
  'Write-enabled local development RBAC must grant supported workload patch access'
);

if (failures.length > 0) {
  console.error('Contract checks failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Contract checks passed.');
