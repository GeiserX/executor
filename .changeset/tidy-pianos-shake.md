---
"executor": patch
---

**Fix: MCP responses larger than Durable Object storage's 128 KiB per-value cap hung the client instead of being delivered**

The DO transport persisted every outbound message for reconnect replay before writing the live SSE frame, and `storage.put` of an oversize value throws — so a large response (the `ui://executor/shell.html` resource is ~5 MB) was neither stored nor sent, and the client waited on keepalives forever. The transport now delivers the live frame first and treats persistence as best-effort: an oversize message skips the event store with a logged warning and arrives without a replay id, which only costs replayability if the connection drops mid-delivery.
