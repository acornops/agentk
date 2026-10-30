# Structured Log Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implementation authorized by the user and completed locally on 2026-10-30, on `fix/high-priority-defects` in AgentK and control-plane. Release and fleet acceptance remain open. The implementation record below supersedes proposed file names, algorithms and unchecked tasks in the original plan.

## Implementation record — 2026-10-30

- [x] AgentK sanitizes structured log text before its existing full-result and model-excerpt construction; control-plane independently sanitizes artifact strings before existing hashing/compression/storage.
- [x] Both repositories use equivalent `structured-log-redaction.ts` helpers. Existing plain-text patterns, object-key policy, schemas, byte ceilings, hash conflicts, authorization and retention remain intact. Existing caller ordering needed no rewrite.
- [x] Regression coverage includes quoted/escaped keys and values, JSONL/prefixes, compound sensitive values, encoded strings, truncation, incomplete PEM, idempotence, useful large logs, full result/excerpt and decompressed stored bytes.
- [x] An independent final review found malformed-quote resynchronization and legacy assignment/key regressions. Four exact AgentK regressions and one control-plane corpus test failed before correction and passed afterward. The review found no critical issue; its two H1 findings are resolved.

**Critical plan adjustments:** Use a bounded quoted-token scanner instead of parse/walk/reserialize, preserving unrelated formatting and avoiding a larger parser pipeline. Keep the two embedded decode layers and 32-level sensitive-value stack. Drop the proposed 10,000-node cutoff: a regression showed it unnecessarily removed harmless JSONL within the existing byte ceiling. Ambiguous quoted segments withhold the remaining segment; malformed quote recovery must not guess a later JSONL boundary. The cost is conservative evidence removal for ambiguous text, plus maintaining a small equivalent helper in both repositories.

Final self-review also measured repeated plain assignments at about 736 ms for 1 MiB versus 62 ms for 256 KiB. Retaining the next quote boundary removed repeated suffix searches. On Node v24.2.0, 20 samples after 5 warmups measured 26.30/107.28 ms for 262,102/1,048,524-byte JSONL and 10.82/50.13 ms for 262,128/1,048,560-byte assignment input. Retained heap deltas after GC were approximately 0.54/1.77 MB and -0.72/1.71 MB respectively; GC timing makes these diagnostic, not peak-memory guarantees. All synthetic credentials were removed. No fragile timing threshold was added to CI.

**Validation:** AgentK `npm run validate` passes (34 files, 288 tests, lint/contracts/harness/Helm/build). Control-plane `npm run validate` passed all 1,501 tests after the review corrections; `npm run validate:ci` also passed all 1,501 tests with coverage after the final scanner performance correction. The original regression run produced 13 AgentK and 3 control-plane failures with existing controls passing. The two helpers are byte-identical.

**Remaining release work:** Deploy control-plane protection first, then AgentK; qualify the synthetic live full-result/model/download canary and upgraded-agent coverage. Historical artifact inventory/scrubbing and credential response were not performed. This write-path fix does not change existing stored artifacts. No protocol, dependency or schema change is included.

## Original proposed plan

The remaining sections preserve the reviewed proposal. Unchecked items describe that proposal, not missing work in the narrowed implementation above; release acceptance remains explicitly pending.

**Reviewed baselines:** AgentK `d3351d9c5124f60db7d1c9236e9a1d9adacbb589`; control-plane `93f1a05ef15a27e724ce04e8664a8999002cf577` (2026-10-30). Recheck source and working-tree changes before execution; unrelated active CP planning work already exists.

**Goal:** Prevent recognized credentials in structured Kubernetes logs from entering model context or persisted tool-result artifacts.

**Architecture:** AgentK sanitizes logs before constructing either result view. The control plane independently sanitizes artifact strings before canonicalization, hashing, compression, and storage. Keep small repository-owned implementations and matching synthetic regression cases; introduce no shared runtime package.

**Tech Stack:** TypeScript, Node.js 22+, Vitest in AgentK, node:test in control-plane, existing gzip artifact storage.

**Spec:** The proposed design/spec below is the self-contained specification for this plan. Existing boundaries: [AgentK contracts](../../contracts/README.md) and [security model](../../security-model.md).

## Global Constraints

- Preserve outbound-only transport, namespace authorization, read-only defaults, and existing tool schemas.
- Preserve the existing 1 MiB raw pod-log ceiling and 8 KiB UTF-8 model excerpt.
- Preserve Bearer, Basic, credential-bearing URI, PEM private-key, and assignment redaction.
- Never log input strings, parse exceptions containing input, or original secret values.
- Never return the original string as an exception/limit fallback; use a fixed withholding marker for the affected segment.
- Treat this as recognized-shape redaction, not a guarantee that arbitrary application secrets can be identified.
- Keep artifact metadata, authorization, raw-size rejection, integrity checks, and retention semantics intact.
- No changes to AgentV, provider adapters, dependencies, or cross-repo packages are required.

## Review Focus

- JSON/JSONL with quoted, escaped, Unicode-escaped, and nested sensitive keys must redact values.
- Mixed ordinary text and malformed/truncated JSON must pass a conservative fallback rather than bypass sanitization.
- Credential strings inside nested JSON strings must receive bounded decoding and sanitization.
- Large or deeply nested inputs must terminate within explicit work bounds without returning unprocessed content.
- Existing non-secret messages, newlines, UTF-8 text, URI paths, and non-sensitive JSON fields must stay useful.

## Evidence and affected files

The current `redactLogSecrets()` assignment expression expects a colon/equal sign immediately after a bare key. `{"password":"SYNTHETIC_PASSWORD","api_key":"SYNTHETIC_KEY"}` remains unchanged. The same omission exists in the control-plane text pass. AgentK sends `logs` in the full result and `logExcerpt` in model context; artifacts are eligible by default for this tool.

| Repository | Files/functions | Planned responsibility |
| --- | --- | --- |
| agentk | `src/tools/log-redaction.ts` (new), `redactLogText(value: string): string` | Bounded structured and fallback text sanitization |
| agentk | `src/tools/atomic/get-resource-logs.ts`, `redactLogSecrets()`, handler, projection | Preserve exported compatibility wrapper; sanitize before both views |
| agentk | `src/tools/log-redaction.spec.ts` (new), `src/tools/atomic/get-resource-logs.spec.ts` | Corpus, bounds, and handler/projection assertions |
| control-plane | `src/services/artifact-text-redaction.ts` (new), `redactArtifactText(value: string): string` | Independent bounded string sanitizer with equivalent synthetic cases |
| control-plane | `src/services/tool-result-artifacts.ts`, `sanitizeArtifactResult()`, persistence | Delegate string handling; preserve structured-key redaction and storage order |
| control-plane | `test/services/artifact-text-redaction.test.ts` (new), `test/services/tool-result-artifacts.test.ts` | Corpus and decompressed stored-byte assertions |
| both | `docs/security-model.md`, existing contract boundary prose | Document covered shapes, withholding behavior, and residual limits |

## Proposed design/spec

### Structured input and useful output

1. Try a bounded parse of a complete JSON object/array before JSONL processing, so pretty-printed JSON remains supported.
2. Walk parsed values with an explicit stack; normalize sensitive key names using the existing underscore/hyphen-insensitive conventions.
3. Replace an entire sensitive value, including object/array values, with `<redacted>`; never preserve secret-bearing children.
4. Sanitize every non-sensitive string value using the legacy text patterns and the embedded-JSON rule below.
5. Return the original segment only if processing completed successfully and made no changes. For changed JSON, serialize valid JSON; whitespace/key layout may change, values and JSON types outside redactions must not.
6. Otherwise process JSONL line by line, preserving separators and keeping ordinary text alongside structured lines.
7. Do not coerce numeric/boolean/null values or parse arbitrary dates, URLs, and ordinary text as JSON primitives.

### Escaped strings and malformed text

- Support JSON object/array strings encoded inside a string for at most two decode passes. Each decoded value receives the same key and string rules, then is encoded back into its parent representation.
- Decode valid escaped key tokens, including `pass\u0077ord`, before key matching.
- On malformed JSON, run the legacy scanner plus a bounded quoted-key scanner. The latter recognizes a quoted sensitive key followed by a colon and consumes its complete quoted/unquoted or balanced value without stopping at an escaped quote.
- For a recognized sensitive assignment whose value is incomplete or cannot be bounded safely, withhold the rest of that line using `<redacted-unparseable-log-segment>`.
- If an escaped nested JSON-looking value exceeds the decode allowance and cannot be safely screened, withhold that value rather than retain it verbatim.
- Run the existing multiline PEM treatment on whole text strings before line-local fallback; line splitting must not expose private-key bodies.
- An opening private-key PEM marker without a closing marker withholds the remaining string, including following lines. Test `-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_BODY` explicitly.
- Pin malformed examples: `{"password":"SYNTHETIC` withholds the unfinished value; `prefix {"api_key":"SYNTHETIC","status":"failed"}` redacts the value while retaining status; `{broken diagnostic without sensitive assignments` remains after successful fallback scanning.
- Ordinary malformed non-secret lines may remain after successful fallback scanning. Parse failure alone must never skip scanning.

### Bounds and failure behavior (proposed defaults)

- Set `MAX_REDACTION_DEPTH = 32`, `MAX_REDACTION_NODES = 10_000`, and `MAX_EMBEDDED_JSON_DECODE_PASSES = 2` in each local helper.
- Count traversal work across embedded decoding for one input string; do not reset budgets at each nested string.
- AgentK never receives more than 1 MiB from its bounded reader; control-plane strings remain bounded by `TOOL_RESULT_ARTIFACT_MAX_BYTES` before sanitization.
- Check output byte size through existing tool/artifact ceilings. Do not expand unbounded replacements or build repeated copies of the full log.
- Depth/node exhaustion or an unexpected sanitizer failure returns the fixed withholding marker for the affected top-level segment, not a partly processed object.
- Avoid recursive regexes and repeated substring reparsing; examine each ordinary segment at a bounded number of passes.
- Preserve redaction idempotence: applying either sanitizer twice must not restore content or continually change placeholders.

### Trust, compatibility, and tradeoffs

- AgentK protection is required for model context; fixing control-plane storage alone cannot protect model requests.
- The second pass must protect an artifact produced by an older agent that still returns unredacted JSON text.
- Different repos retain their current structured-key policies; align the log-text corpus rather than broadening every object-key heuristic in this fix.
- Compact serialization and withholding an ambiguous segment trade some formatting/evidence for safe handling. Review those proposed choices before implementation.
- A legacy artifact retried with changed sanitized bytes may hit the existing call-ID/hash conflict. Preserve that conflict; do not overwrite an existing artifact or relax integrity checks.
- Existing stored artifacts are not retroactively scrubbed by a write-path fix. Prepare a scope-limited inventory of affected versions, tools, and retention windows using metadata; do not automatically delete artifacts, reprocess historical payloads, or rotate credentials. Any such response needs a separate operator decision, without copying real secret values into review material. Do not claim no historical exposure occurred.

## Implementation tasks

### Task 1: AgentK sanitizer and regression corpus

**Interfaces:** Produces `redactLogText(value: string): string`; existing `redactLogSecrets(value: string): string` delegates to it.

- [ ] Add `src/tools/log-redaction.spec.ts` with table-driven named cases for JSON, JSONL, pretty JSON, nested arrays/objects, escaped quotes/backslashes, Unicode-escaped keys, and two embedded decode passes.
- [ ] In each sensitive case assert no synthetic secret appears in output or decoded JSON string values; assert expected `<redacted>` placeholders and preserved non-sensitive values/types.
- [ ] Add malformed/truncated key-value cases, timestamp-prefixed JSON, unterminated quoted values, and incomplete PEM blocks; assert conservative withholding where safe value termination cannot be established.
- [ ] Add unchanged ordinary text, empty string, newlines, multilingual UTF-8, harmless URL paths, and non-sensitive JSON controls; assert retained evidence rather than blanket removal.
- [ ] Run `npx --no-install vitest run src/tools/log-redaction.spec.ts` and record the expected failures before implementation.
- [ ] Implement the proposed parser/walker/fallback in `src/tools/log-redaction.ts`; preserve the exported wrapper in `get-resource-logs.ts` and existing callers.
- [ ] Add depth 32/33, 10,000/10,001 node, third decode-layer, and near-1-MiB cases; assert bounded processing and fixed fallback markers without synthetic secret leakage.
- [ ] Run the new file plus `src/tools/atomic/get-resource-logs.spec.ts`; confirm existing credential and unavailable-log tests remain green.

### Task 2: Protect full result and model projection

**Interfaces:** Consumes Task 1's `redactLogText`; retains the existing tool result and model-context envelope shapes.

- [ ] Extend `get-resource-logs.spec.ts` to mock Kubernetes text containing nested JSON/JSONL credentials and invoke `getResourceLogsTool.handler()`.
- [ ] Assert `result.logs` and `JSON.stringify(getResourceLogsTool.projectForModel(result, params))` contain no synthetic secret, including secrets near the tail excerpt boundary.
- [ ] Assert namespace/name/container identity, requested bounds, omission metadata, line counts for unchanged plain logs, and UTF-8 excerpt validity remain correct.
- [ ] Implement any handler/projection wiring needed to guarantee redaction occurs before excerpt selection and artifact eligibility.
- [ ] Run targeted tests; record a local performance sample for small logs and 1-MiB repeated JSONL. Record Node version, input bytes, median of 20 warmed runs, and heap delta; reject superlinear growth from 256 KiB to 1 MiB rather than using a fragile CI millisecond threshold.

### Task 3: Independent control-plane artifact pass

**Interfaces:** Produces `redactArtifactText(value: string): string`; `sanitizeArtifactResult()` invokes it for string leaves before artifact serialization.

- [ ] Add equivalent synthetic cases to `test/services/artifact-text-redaction.test.ts`, including malformed and bounded-work cases. Keep test data local; no new cross-repo runtime import.
- [ ] Extend `tool-result-artifacts.test.ts` to persist `{ logs: structuredLog }` and `text/plain` structured logs with a mocked repository; gunzip captured payloads and assert synthetic secrets are absent.
- [ ] Add an old-agent case that bypasses AgentK sanitization; assert the CP pass independently removes its secrets.
- [ ] Assert canonical hashing uses sanitized bytes, stored byte counts match decompression, empty text still works, raw oversize still rejects, and conflicting call IDs still reject.
- [ ] Run the two targeted CP service files and observe new regression failures before implementation.
- [ ] Implement `artifact-text-redaction.ts`, replace only the string path in `sanitizeArtifactResult()`, and retain recursive structured-key handling and storage sequencing.
- [ ] Run the CP service tests plus artifact-controller authorization tests; ensure no raw values enter error messages or logs on sanitizer failure.

### Task 4: Review, documentation, and coordinated release preparation

- [ ] Update security-model and contract prose in AgentK/CP with supported shapes, limits, formatting effects, and the fact that arbitrary unknown secret forms remain a residual risk.
- [ ] Inspect AgentV's existing quoted-assignment cases as a reference. Do not change AgentV unless review finds a regression caused by a deliberately shared contract; any such expansion requires its own scope decision.
- [ ] Run the validation matrix below and attach outcomes to this plan. Obtain independent review of scanner escape handling, fail-closed paths, storage integrity, and model projection.
- [ ] Prepare separate AgentK and CP changes on a common descriptive branch slug; propose `fix/structured-log-redaction`. Commits/PRs/releases remain future authorized implementation work.
- [ ] Move this plan to completed only after code lands; track deployed-version acceptance separately from local tests.

## Validation matrix for implementation

Run from each indicated repository; all tests use synthetic data and mocked Kubernetes/storage.

```sh
# agentk
npx --no-install vitest run src/tools/log-redaction.spec.ts src/tools/atomic/get-resource-logs.spec.ts
npm run validate
# control-plane
NODE_ENV=test node --import tsx --test --test-concurrency=1 test/services/artifact-text-redaction.test.ts test/services/tool-result-artifacts.test.ts test/tool-result-artifact-controller.test.ts
npm run validate
# workspace: after any mirrored contract prose/manifest updates
node scripts/harness/check-platform-contracts.mjs
```

No cluster, database, provider credentials, or live logs are needed for unit acceptance. Run a separately authorized staging canary with synthetic logs before promotion; do not create a real secret as a fixture.

## Rollout and rollback

Deploy the CP second pass first, then AgentK; source protection is complete only after connected agents upgrade. Validate a synthetic canary through full result, model excerpt, persisted gzip payload, and authorized artifact download. Observe failures/latency without logging content. No database migration or protocol-version change is expected.

Rollback may restore the disclosure defect. Prefer reverting only an isolated performance/formatting regression while retaining source and CP credential handling. If a safe rollback is unavailable, an operator may temporarily disable affected log-tool availability through existing supported controls. Do not weaken hash conflicts, raw-size checks, or authorization to make a rollout pass.

## Independent acceptance checklist

- [ ] A reviewer reproduces the original quoted-JSON leak on the base revision using synthetic data and sees it absent after the fix.
- [ ] JSON, JSONL, escaped/nested strings, malformed text, and legacy credential forms pass both local corpora independently.
- [ ] Full result, model excerpt, error paths, compressed storage, and artifact download expose no fixture secret.
- [ ] Ordinary evidence remains useful; bounds, UTF-8, storage integrity, and access-control regressions are absent.
- [ ] Work limits and performance measurements are recorded; no recursive/unbounded parse fallback remains.
- [ ] CP-first release order, agent-upgrade coverage, existing-artifact residual exposure, and rollback decision are recorded.

## Effort and planning validation

Estimated engineering effort: **2–4 working days**: 0.5 day corpus/design qualification, 1–1.5 days two local helpers/wiring, 0.5–1 day integration/performance/security review, and 0.5 day release preparation/canary support. Complexity is moderate because escaping, malformed input, formatting, and two independently deployed boundaries interact. Existing-artifact remediation is excluded.

Planning validation (2026-10-30): current AgentK/CP code and existing tests re-read; `npm run harness:check` passed. No implementation, test corpus, deployment, or historical artifact changes have been made by this plan. Runtime suites were not rerun because this change adds documentation only; implementation commands above remain unchecked future work.
