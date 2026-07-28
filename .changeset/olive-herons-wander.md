---
"executor": patch
---

`CredentialProvider.get` now returns `Redacted<string> | null`, so a resolved
credential cannot reach a log, span attribute, or error message without an
explicit unwrap. `set` accepts `string | Redacted<string>`, so existing callers
that pass a plain string are unaffected. Custom providers must wrap reads with
`Redacted.make` and unwrap writes with the new `credentialValueToWrite` helper
at their serialization line.
