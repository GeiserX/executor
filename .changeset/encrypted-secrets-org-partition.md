---
"executor": patch
---

**Fix: org OAuth connections on self-host worked only for whoever ran the consent**

The encrypted-secrets credential provider (the writable provider on the self-hosted and Cloudflare hosts) filed token rows under the _acting user's_ private partition instead of the credential's own owner. An org-owned OAuth connection whose consent completed in one member's browser session therefore resolved only for that member — every other principal failed with `oauth_connection_missing`, while the UI showed the connection healthy. The provider now partitions by the owner embedded in the item id (`oauth:org:…` → org-shared), matching the WorkOS Vault provider, and a boot-time data migration re-files rows already written wrong. The encrypted value itself was never affected.
