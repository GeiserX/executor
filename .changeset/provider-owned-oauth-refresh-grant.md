---
"executor": minor
---

**Credential providers can now own the OAuth refresh grant**

`CredentialProvider` gains an optional `refreshGrant`. When a provider implements it, the host asks it to _perform_ the refresh exchange rather than to hand over the refresh token: the provider spends the token, seals the newly minted access token (and a rotated refresh token, if the authorization server sent one) under the same item ids, and returns only the granted lifetime and scope. The host then resolves the access token through `get`, the same hop every other credential takes.

This closes the one gap where a backend that keeps secrets sealed had no honest option but to refuse to refresh at all — the refresh grant is the only exchange where a long-lived stored secret must be spent and the reply is itself a fresh credential. Providers that do not implement `refreshGrant` are unaffected: the existing host-side exchange runs unchanged.

A refused grant is reported with the new `RefreshGrantRejected` error carrying the RFC 6749 §5.2 code, so a delegated refresh classifies re-authentication, surfaces `invalid_grant` to the caller, and arms the known-dead gate exactly as the host-side path does.
