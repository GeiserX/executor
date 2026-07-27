// ---------------------------------------------------------------------------
// Data migration: re-file mis-partitioned encrypted-secrets rows.
//
// Before the `ownerForItemId` fix (issue #1453), the provider filed every
// credential under the ACTING caller's partition — so an org connection whose
// OAuth consent completed in a user's browser session stored its token rows
// at owner='user', subject=<that user>, while the connection row said org.
// The consenting user still resolved the tokens (user rows shadow org rows),
// so the connection looked healthy; every other principal failed with
// `oauth_connection_missing`. Mirrors the WorkOS Vault repair from #950
// (apps/cloud/scripts/repartition-vault-metadata.ts), but as a boot-time
// ledger entry — the affected hosts (selfhost, Cloudflare) have no operator
// to run a script by hand. Encryption is global-key, not principal-bound, so
// moving a row is a pure partition change; ciphertext decrypts unchanged.
//
// Idempotent: already-correct rows never match, and the copy step is
// insert-or-ignore against the (tenant, owner, subject, plugin_id,
// collection, key) unique index — a post-fix write that already created the
// correct row wins and the mis-filed duplicate is simply dropped.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  DataMigrationError,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk";

const MIGRATION_NAME = "2026-07-27-encrypted-secrets-owner-repartition";

const PLUGIN_ID = "encryptedSecrets";
const COLLECTION = "secrets";
// Item-id prefixes whose second colon-segment is the owning partition — keep
// in sync with OWNER_SCOPED_PREFIXES in index.ts.
const OWNER_SCOPED_PREFIXES = ["connection", "oauth", "oauth-client"] as const;

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  Effect.map(
    execute(client, {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    }),
    (result) => result.rows.length > 0,
  );

const embeddedOwner = (key: string): "org" | "user" | null => {
  const [prefix, owner] = key.split(":");
  if (!OWNER_SCOPED_PREFIXES.includes(prefix as (typeof OWNER_SCOPED_PREFIXES)[number])) {
    return null;
  }
  return owner === "org" || owner === "user" ? owner : null;
};

/** Move every encrypted-secrets row whose stored partition disagrees with the
 *  owner embedded in its item id into that owner's partition. Returns the
 *  number of rows re-filed. Fresh databases lack the table; nothing to do. */
export const runSqliteEncryptedSecretsRepartition = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    if (!(yield* tableExists(client, "plugin_storage"))) return 0;

    const rows = yield* execute(client, {
      sql: `SELECT row_id, owner, subject, key
            FROM plugin_storage
            WHERE plugin_id = ? AND collection = ?`,
      args: [PLUGIN_ID, COLLECTION],
    });

    // A row is mis-filed when its stored partition disagrees with the owner
    // embedded in its item id. In practice only org credentials stuck in a
    // user partition, but compute it generally and symmetrically.
    const misfiled = rows.rows.flatMap((row) => {
      if (typeof row.row_id !== "string" || typeof row.key !== "string") return [];
      const subject = typeof row.subject === "string" ? row.subject : "";
      const want = embeddedOwner(row.key);
      if (want === null) return [];
      const wantSubject = want === "org" ? "" : subject;
      if (row.owner === want && subject === wantSubject) return [];
      return [{ rowId: row.row_id, want, wantSubject }];
    });

    let moved = 0;
    for (const { rowId, want, wantSubject } of misfiled) {
      // Re-file in place: copy into the correct partition (no-op when a
      // post-fix write already created it), then drop the mis-filed row.
      yield* execute(client, {
        sql: `INSERT OR IGNORE INTO plugin_storage
                (row_id, tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at)
              SELECT row_id || '-repart', tenant, ?, ?, plugin_id, collection, key, data, created_at, updated_at
              FROM plugin_storage WHERE row_id = ?`,
        args: [want, wantSubject, rowId],
      });
      yield* execute(client, {
        sql: "DELETE FROM plugin_storage WHERE row_id = ?",
        args: [rowId],
      });
      moved += 1;
    }
    return moved;
  });

/** Registry entry for the boot-time data-migration ledger. */
export const encryptedSecretsRepartitionDataMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteEncryptedSecretsRepartition(client).pipe(Effect.asVoid),
};
