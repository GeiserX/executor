---
"executor": patch
---

A credential pasted into the connect flow is now `Redacted<string>` from the
moment the HTTP payload decodes, so it cannot reach a log, a span attribute, or
an error payload between the request body and the credential provider. The
`connections.create` and `connections.validate` payloads decode `value` and each
entry of `values` through a bidirectional codec, so the same schema still
encodes on the browser client that sends the credential.

Inputs are widened, not narrowed: `ConnectionValueInput` and
`ConnectionInputOrigin` accept `string | Redacted<string>` for `value` /
`values`, so the documented plain-string `connections.create({ value })` calls
keep compiling. Outputs are unchanged — the guarantee already lives on
`CredentialProvider.get`.

Callers that build the HTTP payload directly (rather than going through the SDK)
must wrap pasted secrets with `Redacted.make`; the payload schema unwraps them
while encoding the request body.
