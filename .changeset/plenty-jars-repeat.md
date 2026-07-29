---
"executor": patch
---

Close the remaining credential leaks at the telemetry export seam. Span events
and status messages are now scrubbed alongside URL attributes, so the
exception messages, stack traces, and pretty-printed causes every failed span
carries no longer ship query-string credentials, and unbounded stack text is
capped. The browser tracer applies the same scrub as the server (previously it
exported unredacted), the tracer's redacted-header list is widened past
Effect's four defaults to cover the header names an integration's auth
placement can mint, and the OpenAPI invoke span's `base_url` is sanitized like
the mcp and graphql endpoints already were.
