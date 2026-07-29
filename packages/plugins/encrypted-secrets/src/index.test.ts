import { Effect, Exit, Redacted } from "effect";
import { describe, expect, test } from "@effect/vitest";

import { Owner, ProviderItemId, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import { decryptSecret, deriveKey, encryptSecret, encryptedSecretsPlugin } from "./index";

// ---------------------------------------------------------------------------
// In-memory PluginStorageFacade fake (owner-partitioned), enough to exercise
// the provider exactly as the executor's plugin-storage table would.
//
// v2: the provider keys values by the opaque `ProviderItemId` (the storage
// `key`); writes carry an `owner` the host supplies. Reads via `get`/`list`
// are not owner-filtered — the connection row that references the id owns the
// partition.
// ---------------------------------------------------------------------------

const makeFakeStorage = () => {
  const rows = new Map<string, { owner: Owner; key: string; collection: string; data: unknown }>();
  const composite = (collection: string, key: string) => `${collection} ${key}`;
  const toEntry = (row: { owner: Owner; key: string; collection: string; data: unknown }) => ({
    id: composite(row.collection, row.key),
    owner: row.owner,
    pluginId: "encryptedSecrets",
    collection: row.collection,
    key: row.key,
    data: row.data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const facade = {
    get: (input: { collection: string; key: string }) =>
      Effect.sync(() => {
        const row = rows.get(composite(input.collection, input.key));
        return row ? (toEntry(row) as never) : null;
      }),
    getForOwner: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        const row = rows.get(composite(input.collection, input.key));
        return row && row.owner === input.owner ? (toEntry(row) as never) : null;
      }),
    list: (input: { collection: string }) =>
      Effect.sync(
        () =>
          [...rows.values()]
            .filter((row) => row.collection === input.collection)
            .map((row) => toEntry(row)) as never,
      ),
    put: (input: { collection: string; key: string; owner: Owner; data: unknown }) =>
      Effect.sync(() => {
        const row = {
          owner: input.owner,
          key: input.key,
          collection: input.collection,
          data: input.data,
        };
        rows.set(composite(input.collection, input.key), row);
        return toEntry(row) as never;
      }),
    remove: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        rows.delete(composite(input.collection, input.key));
      }),
  };
  return { facade, rows };
};

const makeProvider = (key: string, owner: Owner = Owner.make("org")) => {
  const { facade, rows } = makeFakeStorage();
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: minimal PluginCtx fake for the provider under test
  const ctx = {
    owner: { tenant: "tenant-a", subject: owner === Owner.make("user") ? "subject-a" : null },
    pluginStorage: facade,
  } as unknown as PluginCtx<unknown>;
  const plugin = encryptedSecretsPlugin({ key });
  const credentialProviders = plugin.credentialProviders as (
    ctx: PluginCtx<unknown>,
  ) => readonly CredentialProvider[];
  const provider = credentialProviders(ctx)[0]!;
  return { provider, rows };
};

const id = (value: string) => ProviderItemId.make(value);

/** Unwrap a `get` for comparison against the expected plaintext. Absence stays
 *  `null`, tested explicitly. */
const resolved = async <E>(effect: Effect.Effect<Redacted.Redacted<string> | null, E>) => {
  const value = await Effect.runPromise(effect);
  return value === null ? null : Redacted.value(value);
};

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
};

describe("crypto", () => {
  test("round-trips through encrypt/decrypt", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "ghp_secret_value"));
    expect(payload.startsWith("v1.")).toBe(true);
    const back = await Effect.runPromise(decryptSecret(key, payload));
    expect(back).toBe("ghp_secret_value");
  });

  test("a different key cannot decrypt", async () => {
    const payload = await Effect.runPromise(encryptSecret(deriveKey("key-a"), "value"));
    await expectFailure(decryptSecret(deriveKey("key-b"), payload));
  });

  test("tampered ciphertext fails the auth tag", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "value"));
    const parts = payload.split(".");
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from("tampered").toString("base64"),
    ].join(".");
    await expectFailure(decryptSecret(key, tampered));
  });
});

describe("provider", () => {
  test("set then get returns the plaintext", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_xyz"));
    expect(await resolved(provider.get(id("github")))).toBe("ghp_xyz");
  });

  test("stores ciphertext at rest, not plaintext", async () => {
    const { provider, rows } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_plaintext"));
    const stored = String([...rows.values()][0]!.data);
    expect(stored).not.toContain("ghp_plaintext");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  // A `set` that forgot to unwrap would encrypt the literal "<redacted>", and
  // the ciphertext-at-rest test above would still pass. Decrypting what was
  // actually stored is the only check that catches it.
  test("encrypts the real secret for both string and Redacted input", async () => {
    const key = deriveKey("master");

    for (const [itemId, input, expected] of [
      ["plain", "sk_plain_written", "sk_plain_written"],
      ["wrapped", Redacted.make("sk_wrapped_written"), "sk_wrapped_written"],
    ] as const) {
      const { provider, rows } = makeProvider("master");
      await Effect.runPromise(provider.set!(id(itemId), input));
      const persisted = String([...rows.values()][0]!.data);
      expect(await Effect.runPromise(decryptSecret(key, persisted))).toBe(expected);
    }
  });

  // removed: "a secret in one scope is invisible to another scope" — v2 drops
  // the scope arg entirely. The provider keys solely by the opaque
  // `ProviderItemId`; the referencing connection row owns the (tenant, owner,
  // subject) partition, so cross-scope isolation is no longer the provider's
  // concern to enforce or test.

  test("get returns null for a missing id", async () => {
    const { provider } = makeProvider("master");
    expect(await resolved(provider.get(id("absent")))).toBeNull();
  });

  test("has and delete reflect presence", async () => {
    const { provider } = makeProvider("master");
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    await Effect.runPromise(provider.set!(id("k"), "v"));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(true);
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    // delete is idempotent and returns void; deleting an absent id is a no-op.
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
  });

  test("list surfaces stored ids", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("alpha"), "a"));
    await Effect.runPromise(provider.set!(id("beta"), "b"));
    const entries = await Effect.runPromise(provider.list!());
    expect(entries.map((e) => e.id).sort()).toEqual(["alpha", "beta"]);
  });
});
