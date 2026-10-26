# Runtime validation security

## Release integration — 2026-10-26

Implementation and independent review are complete. The user subsequently
authorized main integration and a demo release. The original implementation
record below is historical; publication and deployment acceptance are tracked
in the deployment repository's security-maintenance-release plan. Remaining
production gates are not cleared by this source qualification.

Status: implemented and independently reviewed on `fix/runtime-validation-security`;
uncommitted and unpublished. No findings remain in this focused migration.

## Scope

Qualify Zod 4.6.7 and replace the Zod 3-dependent tool schema converter with
supported conversion APIs. Preserve valid tool inputs, defaults, JSON-RPC
optionality, write gating, and tool names. No Helm maintenance or release work.

## Work and checks

- Reproduce bounded tool-array traversal before upgrading; verify early rejection.
- Compare advertised input constraints before and after the converter migration.
- Run full validation, protocol integration tests, platform contracts, and a
  runtime audit. Record compatibility decisions and independent review results.

## Coordination

Control Plane and AgentV qualify the same patched dependency. Deployment owns
the production audit. No protocol version or deployment change is intended.

## Evidence and compatibility

- `npm run validate`: 262 tests, types/docstrings, contracts, harness, three
  Helm configurations, and build passed. `npm run test:e2e`: 1 test passed.
- Main checks used Node 24.2.0; the full suite including e2e also passed on
  verified temporary Node 22.23.4 (263 tests).
- Oversized workload/custom-resource arrays previously read 11/21 elements;
  now they read none and emit one size error. All production Zod array schemas
  have explicit maxima, including nested RBAC resources/verbs.
- Replaced the private Zod 3 converter with native input-schema conversion.
  A narrow override preserves closed advertising of stripped object keys.
  Default annotations and literal types are now explicit; ordinary disjoint
  unions use equivalent `anyOf`, discriminated unions retain `oneOf`.
- Compared every advertised schema and replayed all 17 AgentK/AgentV schemas
  through actual execution-engine sanitization and gateway provider renderers;
  representative valid/invalid preapproval cases passed without provider calls.
- `npm audit --omit=dev --json`: zero runtime advisories. Only Zod changed in
  the lockfile. Input integers now reject unsafe values under Zod 4.
- Independent final review found no Critical, Important, or Minor issues;
  protocol optionality and every captured schema were checked separately.

No write gating, RBAC permissions, agent credentials, tool names, protocol
version, or release coordinates changed. Live-cluster acceptance and image-level
security checks remain separate release requirements.
