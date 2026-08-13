---
"executor": patch
---

**The 1Password service-account token no longer stays parked in a process global**

`@1password/op-js` keeps the service-account token on a module-level CLI instance (`cli.serviceAccountToken`) and reads it when it spawns `op`. The CLI backend set that global before each call and nothing ever cleared it, so a token handed over to serve one secret resolution stayed readable for the rest of the process's life — long after the call that needed it, and with nothing left to read it. The account-name branch happens to blank the global, but only if a differently-authenticated call comes next, which in a service-account-only deployment never happens.

The token is now cleared as soon as the call that needed it is done, on success, failure and interruption alike. Every read and write of that global already happens inside the backend's semaphore, so the next operation re-sets the token before it spawns anything and authentication is unaffected.
