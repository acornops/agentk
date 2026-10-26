# AgentK Tech Debt Tracker

| Item | Impact | Next Action | Status |
| --- | --- | --- | --- |
| Missing reconnect stress harness | Medium | Add repeated disconnect/reconnect lifecycle validation | Open |
| Limited RBAC regression checks | Medium | Add manifest-oriented validation for permission drift | Open |
| Zod 3 collection validation amplification | High dependency finding | Zod 4.6.7 and native input-schema conversion pass bounded-array, contract, and protocol checks; see [qualification](active/runtime-validation-security.md). Publish patched artifacts before promotion. | Implemented and reviewed locally; publication pending |
