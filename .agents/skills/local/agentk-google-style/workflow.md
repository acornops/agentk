# AgentK Google Style Workflow

1. Review changed files in runtime, transport, and tool layers.
2. Ensure command-handling paths remain explicit and easy to audit.
3. Reduce deeply nested branching in tool execution logic.
4. Keep type definitions and runtime validation aligned.
5. Run `npm run lint` and `npm test`.
6. Include `npm run test:e2e` when behavior affects cluster interactions.
