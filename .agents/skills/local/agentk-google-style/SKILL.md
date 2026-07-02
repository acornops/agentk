---
name: acornops-agentk-google-style
description: Apply Google TypeScript/JavaScript style guidance to agentk runtime and tool code. Use when editing websocket lifecycle, Kubernetes client integration, snapshot collection, or tool execution modules.
---

# Inputs

- changed TypeScript files in `src/`
- cluster safety and write-gating constraints
- runtime and test command expectations

# Procedure

1. Keep module boundaries clear across transport, protocol, and tool logic.
2. Use descriptive names and explicit types for command and payload handling.
3. Favor small functions with clear preconditions for tool actions.
4. Keep control flow explicit around retries, reconnects, and guarded writes.
5. Run repository lint and tests.

# Outputs

- style compliance notes
- improvements to readability and maintainability
- check results (`npm run lint`, `npm test`)
