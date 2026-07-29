---
"executor": minor
---

Resolved credentials are `Redacted<string>` end to end, and the unwrap points
are now lint-enforced. A new `executor/no-redacted-unwrap` rule flags every
`Redacted.value`, so each one is either an allowlisted boundary carrying a
`-- boundary:` reason or a bug. The allowlisted set is small and deliberate: the
provider serialization line, `renderAuthPlacements`, the oauth4webapi call
boundary, the `oauth_session.pkce_verifier` column, the MCP SDK's
`OAuthClientProvider`, the API-key one-time display, and the wire codecs.

Breaking for plugin authors. `CredentialProvider.get` returns
`Redacted<string> | null`, and `ToolInvocationCredential`'s `value` / `values`
entries are `Redacted<string> | null`. Inputs are widened rather than narrowed —
`set`, `setDefault`, and the OAuth secret inputs all accept
`string | Redacted<string>` — so existing writes keep compiling. Tool authoring
schemas are untouched: `Redacted` never appears on a tool's input or output.

A plugin that reads a credential directly must unwrap at the point the value
goes on the wire. A missed unwrap does not throw — it serializes the literal
`"<redacted>"` — so cover write paths with a test that asserts the persisted
bytes.

Also fixes two required secrets that silently defaulted to the empty string: the
billing route now returns 503 `billing_not_configured` when `AUTUMN_SECRET_KEY`
is unset instead of calling Autumn with an empty key, and the cloud plugin
config no longer hands the WorkOS Vault plugin empty credentials — omitting them
lets the plugin fail at startup, where a missing binding belongs.
