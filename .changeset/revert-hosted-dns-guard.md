---
"@executor-js/sdk": patch
---

Revert the hosted outbound DNS guard resolution cache and the accompanying outbound guard changes released in 1.5.38. The guard returns to its previous behavior: no resolution cache, the caller's `redirect` mode is not honored, and `makeHostedHttp` is no longer exported — use `makeHostedFetch` and `makeHostedHttpClientLayer` as before.
