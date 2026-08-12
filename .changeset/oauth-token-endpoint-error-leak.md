---
"executor": patch
---

**Token material no longer reaches OAuth error messages or logs**

When a token endpoint replied in a way the OAuth library could not parse, the resulting `OAuth2Error` carried the parsed response body as its `cause`. On a malformed `200` that body is a *successful* token response — so an access token, and sometimes a refresh token, travelled inside an error object into whatever logged it.

The body preview is now built from an allowlist of fields that are safe to show (`error`, `errors`, `error_description`, `error_uri`, and `code`/`message`/`detail` nested inside them) rather than from a denylist of fields to hide, so a field nobody anticipated is omitted by default instead of printed by default. The same allowlist applies to form-encoded bodies, previews are depth-bounded, and the failure summary records the token endpoint's hostname rather than its full URL, which can carry identifiers in its path.
