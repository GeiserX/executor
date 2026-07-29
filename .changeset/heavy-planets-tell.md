---
"@executor-js/analytics": patch
"@executor-js/sdk": patch
"@executor-js/api": patch
"@executor-js/host-selfhost": patch
"executor": patch
---

Add anonymous product analytics to the local daemon (CLI + desktop) and self-host: execution counts split by MCP/API plane, toolkit usage, integration add/remove, and artifact usage (created/viewed/updated/deleted, attributed to agent tools vs the console UI), filed under a persisted per-install anonymous id. Opt out with DO_NOT_TRACK or EXECUTOR_DISABLE_ANALYTICS.
