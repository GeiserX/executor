import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { runSqliteEncryptedSecretsRepartition } from "./repartition-migration";

// A real in-memory libSQL database with the plugin_storage shape the hosts
// use (unique on tenant/owner/subject/plugin_id/collection/key), so the
// insert-or-ignore + delete choreography is exercised for real.
const PLUGIN_STORAGE_DDL = `CREATE TABLE plugin_storage (
  row_id text PRIMARY KEY NOT NULL,
  tenant text NOT NULL,
  owner text NOT NULL,
  subject text NOT NULL,
  plugin_id text NOT NULL,
  collection text NOT NULL,
  key text NOT NULL,
  data text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT plugin_storage_uidx UNIQUE (tenant, owner, subject, plugin_id, collection, key)
)`;

type Row = {
  readonly rowId: string;
  readonly owner: string;
  readonly subject: string;
  readonly key: string;
  readonly pluginId?: string;
  readonly collection?: string;
};

let client: Client | undefined;

const makeDb = async (rows: readonly Row[]): Promise<Client> => {
  client = createClient({ url: ":memory:" });
  await client.execute(PLUGIN_STORAGE_DDL);
  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO plugin_storage
              (row_id, tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at)
            VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, 'v1.iv.tag.ct', 1, 1)`,
      args: [
        row.rowId,
        row.owner,
        row.subject,
        row.pluginId ?? "encryptedSecrets",
        row.collection ?? "secrets",
        row.key,
      ],
    });
  }
  return client;
};

afterEach(() => {
  client?.close();
  client = undefined;
});

const partitions = async (db: Client) => {
  const result = await db.execute(
    "SELECT owner, subject, key, data FROM plugin_storage ORDER BY key",
  );
  return result.rows.map((row) => ({
    owner: row.owner,
    subject: row.subject,
    key: row.key,
    data: row.data,
  }));
};

describe("runSqliteEncryptedSecretsRepartition", () => {
  test("moves org-embedded rows out of a user partition, ciphertext intact", async () => {
    const db = await makeDb([
      { rowId: "r1", owner: "user", subject: "user-123", key: "oauth:org:linear:main" },
      { rowId: "r2", owner: "user", subject: "user-123", key: "oauth:org:linear:main:refresh" },
    ]);
    const moved = await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db));
    expect(moved).toBe(2);
    expect(await partitions(db)).toEqual([
      { owner: "org", subject: "", key: "oauth:org:linear:main", data: "v1.iv.tag.ct" },
      { owner: "org", subject: "", key: "oauth:org:linear:main:refresh", data: "v1.iv.tag.ct" },
    ]);
  });

  test("leaves correctly filed rows and unscoped ids alone", async () => {
    const db = await makeDb([
      { rowId: "r1", owner: "org", subject: "", key: "oauth:org:linear:main" },
      { rowId: "r2", owner: "user", subject: "user-123", key: "connection:user:notion:p:token" },
      { rowId: "r3", owner: "user", subject: "user-123", key: "legacy-random-id" },
    ]);
    const moved = await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db));
    expect(moved).toBe(0);
    expect((await partitions(db)).map((row) => row.key)).toEqual([
      "connection:user:notion:p:token",
      "legacy-random-id",
      "oauth:org:linear:main",
    ]);
  });

  test("a post-fix org row wins over the mis-filed duplicate", async () => {
    const db = await makeDb([
      { rowId: "old", owner: "user", subject: "user-123", key: "oauth:org:linear:main" },
      { rowId: "new", owner: "org", subject: "", key: "oauth:org:linear:main" },
    ]);
    await db.execute("UPDATE plugin_storage SET data = 'v1.new' WHERE row_id = 'new'");
    const moved = await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db));
    expect(moved).toBe(1);
    expect(await partitions(db)).toEqual([
      { owner: "org", subject: "", key: "oauth:org:linear:main", data: "v1.new" },
    ]);
  });

  test("does not touch other plugins' rows", async () => {
    const db = await makeDb([
      {
        rowId: "r1",
        owner: "user",
        subject: "user-123",
        key: "oauth:org:slack:main",
        pluginId: "workosVault",
        collection: "metadata",
      },
    ]);
    const moved = await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db));
    expect(moved).toBe(0);
    expect((await partitions(db))[0]).toMatchObject({ owner: "user", subject: "user-123" });
  });

  test("is a no-op on a database without the table", async () => {
    client = createClient({ url: ":memory:" });
    const moved = await Effect.runPromise(runSqliteEncryptedSecretsRepartition(client));
    expect(moved).toBe(0);
  });

  test("is idempotent", async () => {
    const db = await makeDb([
      { rowId: "r1", owner: "user", subject: "user-123", key: "oauth:org:linear:main" },
    ]);
    expect(await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db))).toBe(1);
    expect(await Effect.runPromise(runSqliteEncryptedSecretsRepartition(db))).toBe(0);
  });
});
