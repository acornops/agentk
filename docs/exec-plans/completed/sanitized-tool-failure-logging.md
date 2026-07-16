# Sanitized Tool Failure Logging

## Goal

Make AgentK tool failures diagnosable from pod logs without exposing tool input,
resource identities, raw exceptions, or Kubernetes response bodies.

## Decisions

- Projected `ToolExecutionError` through a fixed allowlist before logging.
- Added stable reason and phase metadata to Kubernetes API, deadline, result
  processing, projection, and post-write verification failures.
- Limited operation correlation to AgentK-generated identifier formats.
- Kept raw error details out of both logs and boundary responses.

## Validation

- Focused router, executor, and atomic write suites: 69 tests passed.
- `npm run validate`: passed, including lint, 231 unit tests, contracts, harness,
  Helm checks, and build.
- `npm run test:e2e`: passed, 1 test.
- Log-capture assertions confirmed that arguments, resource identities, raw
  exception messages, and Kubernetes response fixtures were absent.

## Outcome

AgentK tool failure logs now expose stable `code`, `retryable`, and optional
`status`, `reason`, `phase`, `outcome`, and generated `operationId` fields while
preserving the existing sensitive-data boundary and write uncertainty rules.
