---
"executor": patch
---

**Fix: MCP clients of the cloud host got a "Shell not built" placeholder as the `ui://executor/shell.html` resource, so every artifact rendered as a widget that never finished loading**

The deployed Worker has no filesystem, and the shell loader silently fell back to an inert placeholder document when its `fs.readFile` failed. Workers hosts now fetch the built shell through the static-assets binding (the app build emits a stable-named copy alongside the hashed one), the self-host image reads the same emitted asset from its SPA dist, and a host that cannot produce the shell now fails the resource read with an actionable error instead of serving a document that hangs the client. App builds fail if the shell asset was not emitted.
