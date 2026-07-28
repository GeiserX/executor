---
"executor": patch
---

Store minted OAuth tokens in the durable file secret store (`auth.json` under `EXECUTOR_DATA_DIR`) instead of the system keychain. On sandbox/headless hosts the keychain can be an in-memory keyring that a stop/recreate wipes, leaving OAuth connections expired with "Stored refresh token could not be resolved." Existing keychain-backed connections migrate with one clean reconnect.
