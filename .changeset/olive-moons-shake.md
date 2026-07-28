---
"executor": patch
---

Stop exporting credential-bearing URLs in span attributes. OAuth callback
authorization codes and CSRF state are stripped from span URL attributes before
export, and user-supplied MCP endpoints are sanitized of query-string and
userinfo credentials before being stamped.
