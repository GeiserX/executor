---
"executor": minor
---

**Irreversible cleanup now waits for the transaction to commit, and plugins can do the same**

`oauth.removeClient` deleted the client row and then deleted the client secret from the credential provider. The provider does not enlist in the caller's transaction and does not roll back with it, so an abort restored the client row while its secret stayed destroyed — a client that looks configured and can never authenticate again. The deletion now waits until the removal is durable and is discarded if the removal rolls back. With no transaction active it runs immediately, exactly as before.

The same trap was reachable by plugins and they had no way out of it. `removeConnection` and `removeIntegration` run inside core's removal transaction — deliberately, so a plugin's own rows die atomically with the connection — which makes them exactly the wrong place to revoke a token at the provider's API, delete a remote object, or notify a third party. Nothing in the hooks' documentation said so, and `PluginCtx` exposed `transaction` but nothing to defer past it.

`PluginCtx` gains `afterCommit`. It runs the effect once the outermost transaction commits, discards it if that transaction rolls back, and runs it immediately when no transaction is active. The lifecycle hooks now document that they run inside core's transaction and that outside-world work belongs in `afterCommit`.

Sequencing work after your own `transaction(...)` call is not equivalent, and the documentation says so explicitly: `transaction` nests by pass-through, so inside an active transaction the inner call simply runs its effect and "afterwards" is still before any commit.
