---
"executor": patch
---

OAuth token material is now carried as `Redacted<string>`. `OAuth2TokenResponse`
returns `access_token` and `refresh_token` wrapped, the PKCE code verifier and
the RFC 6749 `state` are wrapped for their in-memory life, and a DCR response's
`client_secret` / `registration_access_token` are wrapped as they are decoded.
The unwraps are confined to the oauth4webapi call boundary, the credential
provider write, and the `oauth_session.pkce_verifier` column.

Inputs are widened, not narrowed: `clientSecret`, `code`, `codeVerifier`,
`refreshToken`, and the DCR `initialAccessToken` all accept
`string | Redacted<string>`, so existing callers are unaffected. `OAuthClient.
clientSecret` accepts either as well; `null` remains the only spelling of
"public / PKCE client", and `oauthClientSecretFromInput` now tests emptiness on
the unwrapped value, since every `Redacted` is truthy.

Also fixes a leak this surfaced: `OAuth2Error.cause` carried the token
endpoint's parsed error body verbatim, so a rejected grant republished the
credentials the endpoint echoed back into anything that serialized the failure
(a log line, an error payload). The cause is now redacted structurally, keeping
the RFC 6749 `error` / `error_description` diagnostics.
