---
"executor": patch
---

**Artifacts are now on by default for MCP connections.** A plain endpoint URL serves the full artifact surface — the artifact tools, the app shell resource, and the artifact skills. Connections that don't want it opt out with `?artifacts=false` (or `--no-artifacts` on the stdio CLI); `?artifacts=true` remains accepted as the explicit default. Previously the surface required a `?artifacts=true` opt-in.
