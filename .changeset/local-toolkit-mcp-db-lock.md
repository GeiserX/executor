---
"executor": patch
---

**Fix: toolkit-scoped MCP endpoints on the local server no longer fail with an internal error**

`POST /mcp/toolkits/<slug>` returned `-32603 Internal server error` for every request. Building a toolkit-scoped session called `createExecutorHandle`, which opened the local data directory a second time — but the running server already holds that directory's exclusive ownership lock, so the open failed against the server's own lock ("Failed to open local SQLite data"). Toolkit sessions now borrow the running server's database handle, which is what they always needed: they differ from the default session only in their plugin set. The unscoped `/mcp` endpoint was never affected.
