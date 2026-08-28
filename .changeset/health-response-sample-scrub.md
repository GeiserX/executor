---
"executor": patch
---

**Credentials are kept out of the health-check response sample that gets persisted**

A health check stores a sample of the probed operation's response body in `connection.last_health`, so whatever the sample carries is written to the database. The operation is user-chosen from the plugin's catalog, which means it can just as easily be a key-listing endpoint as a `/me` — and those return secrets that no scrub of the connection's own credential value can recognise, because they are different secrets entirely.

Leaves whose key names a credential (`token`, `api_key`, `secret`, `authorization`, `session`, …) now have their value replaced with `[redacted]`. The row itself is kept, so the live preview still shows the response shape and the identity picker still works. Keys that merely contain a matching substring, such as `author`, are left alone.

The key check reads the nearest named segment of the path rather than its literal last segment, and recognises a plural key. Array elements are named by index, so a bare array of secrets — `{"tokens": ["sk-live-…"]}` — produces the path `tokens.0`: testing the literal `"0"` matched nothing, and a collection of secrets is named in the plural anyway. Both were needed for the value to be redacted; `author` is still not treated as `auth`.

The OpenAPI health check additionally scrubs the connection's own credential value out of each sampled value, covering the other direction: a body that echoes back the key it was authenticated with under an innocent-looking name.
