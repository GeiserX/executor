---
"executor": patch
---

Sanitize URLs in OAuth error messages. The token-endpoint HTTP summary and the
"no authorization-server metadata found" probe error now strip query-string and
userinfo credentials from the URL they quote, and token-endpoint body redaction
covers authorization codes, PKCE verifiers, device codes, and assertions in both
JSON and form-encoded responses.
