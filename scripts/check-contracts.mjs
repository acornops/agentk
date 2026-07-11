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
const simulatePatch = read('src/tools/atomic/simulate-patch.ts');
const applyRemediation = read('src/tools/remediation/apply_remediation.ts');
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
  [simulatePatch, 'simulate_patch'],
  [applyRemediation, 'apply_remediation']
]) {
  expectIncludes(doc, toolName, 'Builtin tool doc');
  expectIncludes(source, `name: '${toolName}'`, 'Builtin tool implementation');
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

if (failures.length > 0) {
  console.error('Contract checks failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Contract checks passed.');
