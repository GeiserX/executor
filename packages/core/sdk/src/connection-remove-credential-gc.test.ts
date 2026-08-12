import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestExecutor } from "./test-config";

// Removing a connection has to remove the SECRET, not just the row that points at
// it — an item left behind in the store is still decryptable, which is the one
// thing a user deleting a credential is asking us to stop being true.
//
// The hard half is the opposite case. A connection can REFERENCE an item the user
// already had rather than minting one, and destroying that is unrecoverable. So
// these tests are written in pairs: every "it is gone" has a matching "it is still
// there", because a change that deleted everything would pass the first alone.

const INTEG = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** A provider whose store the test can inspect directly, so an assertion reads
 *  the actual item rather than a resolution that a deleted connection can no
 *  longer perform. */
const inspectableProvider = (store: Map<string, string>, writable: boolean): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  writable,
  get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
  set: (id, value) =>
    Effect.sync(() => {
      store.set(String(id), value);
    }),
  delete: (id) =>
    Effect.sync(() => {
      store.delete(String(id));
    }),
  has: (id) => Effect.sync(() => store.has(String(id))),
});

const demoPlugin = (store: Map<string, string>, writable = true) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [inspectableProvider(store, writable)],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({ slug: INTEG, description: "Vercel", config: {} }),
    }),
  }))();

const setup = (store: Map<string, string>, writable = true) =>
  makeTestExecutor({ plugins: [demoPlugin(store, writable)] as const }).pipe(
    Effect.tap((executor) => executor.demo.seed()),
  );

describe("removing a connection removes the credential it minted", () => {
  it.effect("deletes a pasted value from the provider", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: "secret-token",
      });
      // The id this connection mints is deterministic, and the value is really there.
      const mintedId = "connection:org:vercel:main:token";
      expect(store.get(mintedId)).toBe("secret-token");

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("main"),
      });

      expect(store.has(mintedId)).toBe(false);
      // Nothing else was swept up on the way past.
      expect([...store.keys()]).toEqual([]);
    }),
  );

  it.effect("LEAVES an item the connection only referenced", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      // The user already had this, in their own store, under their own id. We
      // never wrote it, and deleting it would destroy a credential that has
      // nothing to do with this connection.
      store.set("ext-item", "user-owned-secret");

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("ext-item") },
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("byo"),
      });

      expect(store.get("ext-item")).toBe("user-owned-secret");
    }),
  );

  it.effect("leaves everything alone when the provider is not writable", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store, false);
      store.set("ext-item", "user-owned-secret");

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("byo"),
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("ext-item") },
      });
      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("byo"),
      });

      // `writable: false` means we never write there, and by the same contract
      // we never delete there either.
      expect(store.get("ext-item")).toBe("user-owned-secret");
    }),
  );

  it.effect("removing one connection does not touch another's credential", () =>
    Effect.gen(function* () {
      const store = new Map<string, string>();
      const executor = yield* setup(store);
      for (const name of ["first", "second"]) {
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make(name),
          integration: INTEG,
          template: TEMPLATE,
          value: `${name}-token`,
        });
      }

      yield* executor.connections.remove({
        owner: "org",
        integration: INTEG,
        name: ConnectionName.make("first"),
      });

      expect(store.has("connection:org:vercel:first:token")).toBe(false);
      expect(store.get("connection:org:vercel:second:token")).toBe("second-token");
    }),
  );
});
