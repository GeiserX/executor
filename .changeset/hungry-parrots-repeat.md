---
"executor": patch
---

Model a missing OAuth client secret as `null` instead of the empty string. A
public/PKCE client and a confidential one are now told apart by an explicit
presence check, and registering a client with an empty-string secret is
rejected rather than silently treated as public.
