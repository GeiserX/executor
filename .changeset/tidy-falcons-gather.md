---
"executor": patch
---

Resolved connection credentials are now carried as `Redacted<string>` from the
provider all the way to the plugin contract, so a credential cannot reach a log,
a span attribute, a pool key, or an error payload without an explicit unwrap.

Breaking for out-of-tree plugins. On `ToolInvocationCredential`, `value` and
every entry of `values` are now `Redacted<string> | null`; `ctx.connections.
resolveValue`, `resolveTools`'s `getValue` / `getValues`, and `ctx.providers.get`
return `Redacted<string> | null`. `ctx.providers.setDefault` accepts
`string | Redacted<string>`, so existing writes are unaffected.

Plugins that render credentials onto an HTTP request need no change: unwrapping
happens inside `renderAuthPlacements` in `@executor-js/sdk/http-auth`, which is
the intended boundary. A plugin that reads a value directly must call
`Redacted.value` at the point the value goes on the wire — a missed unwrap does
not throw, it serializes the literal `"<redacted>"`.

New in `@executor-js/sdk`: `makeCredentialScrubber`, which strips a connection's
resolved values out of upstream error text and payloads. The OpenAPI invoke and
health-check paths and the MCP health check now scrub through it.
