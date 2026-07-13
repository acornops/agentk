# Platform Additional CA Trust

## Objective

Let AgentK trust a control-plane WebSocket certificate issued by an
organization-private CA without disabling TLS verification or replacing
Node.js's public CA trust.

## Scope

- Add nullable, mutually exclusive ConfigMap and Secret key references under
  `config.tls.additionalCaBundle`.
- Validate the values contract in JSON Schema and again in Helm templates.
- Mount the selected key read-only at
  `/etc/acornops/trust/platform-ca.pem` and set chart-owned
  `NODE_EXTRA_CA_CERTS` for the AgentK container.
- Add schema, strict-lint, failure, rendering, and security regression coverage.
- Document namespace locality, trust-manager consumption, rotation, restart,
  and troubleshooting behavior.

## Boundaries

- Do not add TLS-verification bypasses, inline PEM values, client certificates,
  private keys, cross-namespace copying, custom paths, dynamic reload, or Helm
  `lookup` checksums.
- Do not change AgentK runtime code, Kubernetes API TLS configuration,
  WebSocket protocol contracts, authentication, RBAC, or leader election.
- Do not edit the generated `charts` repository mirror. It updates through the
  AgentK chart release workflow.

## Verification

- `npm run helm:check`
- `npm run validate`
- `npm run test:e2e`
- Inspect default, ConfigMap, Secret, ambiguous, incomplete, unsupported, RBAC,
  existing-agent-key, and leader-election rendering cases.
- Report live private-CA, public-CA, wrong-CA, hostname-mismatch, expired-
  certificate, missing-resource, and rotation scenarios as environment-
  dependent when no suitable workload cluster and endpoints are available.

## Status

Source implementation validated; chart release and workload-cluster adoption
remain post-merge operations.

Local evidence:

- `npm run helm:check` passed strict default, ConfigMap, and Secret lint plus
  schema, template-validation, rendering, and security assertions.
- Default rendering matched the pre-change chart output exactly.
- `npm run validate` passed 200 tests, lint, contracts, harness, Helm, and build
  after rebasing onto the latest `main`.
- `npm run test:e2e` passed the WebSocket lifecycle test when allowed to bind a
  localhost socket.
- A temporary private-CA WSS endpoint rejected the default and wrong-CA clients,
  accepted the correct `NODE_EXTRA_CA_CERTS` bundle, and rejected a hostname
  mismatch. A publicly trusted HTTPS endpoint remained trusted with the bundle
  enabled.

Remaining external evidence requires the target namespace's ConfigMap or
Secret, a published chart, and canary verification of missing-resource pod
startup, expired-certificate rejection, CA overlap rotation, AgentK heartbeats,
snapshots, and tool calls.
