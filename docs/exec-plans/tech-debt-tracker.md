# AgentK Tech Debt Tracker

| Item | Impact | Next Action | Status |
| --- | --- | --- | --- |
| Missing reconnect stress harness | Medium | Add repeated disconnect/reconnect lifecycle validation | Open |
| Limited RBAC regression checks | Medium | Add manifest-oriented validation for permission drift | Open |
| Zod 3 collection validation amplification | High | Add fatal raw-collection bounds before parsing, or migrate to Zod 4.6.7 and update the JSON-schema converter and contract tests; see [runtime dependency plan](active/2026-10-26-runtime-dependency-security.md) | Release gate |
