import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function expectIncludes(content, needle, message) {
  expect(content.includes(needle), `${message}: missing ${needle}`);
}

const requiredFiles = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'docs/index.md',
  'docs/DEVELOPMENT.md',
  'docs/OPERATIONS.md',
  'docs/DESIGN.md',
  'docs/PLANS.md',
  'docs/AGENT_HANDOFF.md',
  'docs/QUALITY_SCORE.md',
  'docs/RELIABILITY.md',
  'docs/SECURITY.md',
  'docs/security-model.md',
  'docs/design-docs/index.md',
  'docs/design-docs/core-beliefs.md',
  'docs/product-specs/index.md',
  'docs/product-specs/component-charter.md',
  'docs/references/index.md',
  'docs/generated/README.md',
  'docs/exec-plans/active/README.md',
  'docs/exec-plans/completed/README.md',
  'docs/exec-plans/tech-debt-tracker.md',
  'docs/contracts/README.md',
  'docs/contracts/manifest.json',
  '.agents/skills/README.md',
  '.agents/skills/shared/.standards-version'
];

for (const file of requiredFiles) {
  expect(existsSync(path.join(root, file)), `Missing required harness file ${file}`);
}

const agents = read('AGENTS.md');
const docsIndex = read('docs/index.md');
const development = read('docs/DEVELOPMENT.md');
const plans = read('docs/PLANS.md');
const handoff = read('docs/AGENT_HANDOFF.md');
const quality = read('docs/QUALITY_SCORE.md');
const reliability = read('docs/RELIABILITY.md');
const security = read('docs/SECURITY.md');
const securityModel = read('docs/security-model.md');
const designIndex = read('docs/design-docs/index.md');
const productIndex = read('docs/product-specs/index.md');
const readme = read('README.md');
const packageJson = JSON.parse(read('package.json'));
const ciWorkflow = read('.github/workflows/ci.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const chartValues = read('charts/acornops-agentk/values.yaml');

expect(agents.split('\n').length <= 140, 'AGENTS.md should stay short enough to serve as a table of contents');
expect(!agents.includes('/Users/'), 'AGENTS.md should use portable relative links, not workstation-specific absolute paths');
expectIncludes(agents, '.agents/skills/shared', 'AGENTS shared skills guidance');
expectIncludes(agents, '.agents/skills/local', 'AGENTS local skills guidance');
expectIncludes(agents, 'docs/AGENT_HANDOFF.md', 'AGENTS handoff guidance');
expectIncludes(agents, 'Docs impact: none', 'AGENTS docs impact guidance');
expect(packageJson.name === 'acornops-agentk', 'package.json name should identify the Kubernetes agent package');
expect(packageJson.version === '0.0.1-experimental.7', 'package.json version should match the current experimental component version');
expect(Boolean(packageJson.scripts?.validate), 'package.json should expose a canonical validate script');
expectIncludes(packageJson.scripts.validate, 'npm run test', 'Canonical validate script');
expectIncludes(packageJson.scripts.validate, 'npm run contracts:check', 'Canonical validate script');
expectIncludes(packageJson.scripts.validate, 'npm run harness:check', 'Canonical validate script');
expectIncludes(chartValues, 'repository: ghcr.io/acornops/agentk', 'Agent chart image repository');
expectIncludes(
  ciWorkflow,
  'helm lint charts/acornops-agentk --set-string config.platformUrl=https://api.acornops.dev --set-string config.clusterId=cluster-1 --set-string config.agentKey=test-key',
  'CI Helm lint required chart values'
);
expectIncludes(
  ciWorkflow,
  '--set-string config.clusterId=cluster-smoke',
  'CI Helm smoke required chart values'
);
expectIncludes(releaseWorkflow, 'IMAGE_NAME: acornops/agentk', 'Release workflow image name');
expectIncludes(releaseWorkflow, 'provenance: true', 'Release workflow provenance');
expectIncludes(releaseWorkflow, 'sbom: true', 'Release workflow SBOM');
expect(!releaseWorkflow.includes(':latest'), 'Release workflow must not publish mutable latest tags');
expect(!releaseWorkflow.includes('type=raw'), 'Release workflow must not define raw mutable tags');

for (const needle of [
  'ARCHITECTURE.md',
  'docs/index.md',
  'docs/DEVELOPMENT.md',
  'docs/OPERATIONS.md',
  'docs/contracts/README.md',
  'docs/PLANS.md',
  'docs/AGENT_HANDOFF.md',
  'docs/QUALITY_SCORE.md',
  'docs/RELIABILITY.md',
  'docs/SECURITY.md',
  'docs/security-model.md'
]) {
  expectIncludes(agents, needle, 'AGENTS entry point link');
}

for (const needle of [
  'ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/OPERATIONS.md',
  'system-architecture.md',
  'docs/contracts/README.md',
  'docs/design-docs/index.md',
  'docs/product-specs/index.md',
  'docs/PLANS.md',
  'docs/AGENT_HANDOFF.md',
  'docs/QUALITY_SCORE.md',
  'docs/RELIABILITY.md',
  'docs/SECURITY.md',
  'docs/security-model.md'
]) {
  expectIncludes(docsIndex, needle, 'Docs index link');
}

for (const needle of [
  'docs/exec-plans/active/README.md',
  'docs/exec-plans/completed/README.md',
  'docs/exec-plans/tech-debt-tracker.md'
]) {
  expectIncludes(plans, needle, 'Plans index link');
}

expectIncludes(quality, '| Area | Score | Evidence | Main Gap |', 'Quality score table');
expectIncludes(handoff, 'exact commands run', 'Agent handoff evidence');
expectIncludes(handoff, 'Docs impact: none', 'Agent handoff docs impact evidence');
expectIncludes(handoff, 'Conventional Commits', 'Agent handoff commit policy');
expectIncludes(handoff, 'not a GitHub CI gate', 'Agent handoff commit policy enforcement boundary');
expectIncludes(handoff, 'Vendor Neutrality', 'Agent handoff vendor-neutral policy');
expectIncludes(development, '## Documentation Drift Control', 'Development guide docs drift section');
expectIncludes(development, 'Docs impact: none', 'Development guide docs impact guidance');
expectIncludes(reliability, '## Failure Modes', 'Reliability heading');
expectIncludes(reliability, '## Required Validation', 'Reliability validation heading');
expectIncludes(securityModel, '## Trust Boundaries', 'Security trust-boundary heading');
expectIncludes(securityModel, '## Secrets', 'Security secrets heading');
expectIncludes(securityModel, '## High-Risk Changes', 'Security high-risk heading');
expectIncludes(security, '## Reporting a Vulnerability', 'Security policy reporting heading');
expectIncludes(security, 'https://discord.gg/KHUUdXfsXv', 'Security policy Discord reporting channel');
expectIncludes(designIndex, 'Verified', 'Design index verification status');
expectIncludes(designIndex, 'core-beliefs.md', 'Design index core beliefs link');
expectIncludes(productIndex, 'component-charter.md', 'Product spec index component charter link');
expectIncludes(readme, 'AGENTS.md', 'README harness link');
expectIncludes(readme, 'docs/index.md', 'README docs index link');
expectIncludes(readme, 'docs/DEVELOPMENT.md', 'README development guide link');
expectIncludes(readme, 'docs/OPERATIONS.md', 'README operations guide link');
expectIncludes(readme, 'system-architecture.md', 'README system architecture link');

const defaultMaxSourceLines = 650;

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory))) {
    const relativePath = path.join(directory, entry);
    const absolutePath = path.join(root, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...walkSourceFiles(relativePath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(relativePath);
    }
  }
  return files;
}

for (const file of walkSourceFiles('src')) {
  const lineCount = read(file).split('\n').length;
  expect(
    lineCount <= defaultMaxSourceLines,
    `${file} has ${lineCount} lines; budget is ${defaultMaxSourceLines}. Extract a focused collector, lifecycle helper, mapper, or tool module instead of growing this file.`
  );
}

for (const metadataPath of [
  '.DS_Store',
  '.agents/.DS_Store',
  '.agents/skills/.DS_Store',
  '.agents/skills/shared/.DS_Store'
]) {
  expect(!existsSync(path.join(root, metadataPath)), `Remove generated macOS metadata file ${metadataPath}`);
}

for (const vendorPath of ['CLAUDE.md', 'GEMINI.md', '.cursor', '.cursorrules']) {
  expect(!existsSync(path.join(root, vendorPath)), `Do not add required vendor-specific agent instruction file ${vendorPath}`);
}

if (failures.length > 0) {
  console.error('Harness checks failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Harness checks passed.');
