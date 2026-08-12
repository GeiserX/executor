import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import { RefreshGrantRejected, type CredentialProvider, type RefreshGrantInput } from "./provider";
import { makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// A provider that OWNS the refresh grant never hands the refresh token out. These tests pin that
// property directly rather than asserting "the refresh succeeded" — success is not the claim. The
// claim is that the host never resolved the secret, and only a test watching `get` can tell a
// provider that protected the token from one that quietly served it. Both would go green.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");
const TOOL = ToolAddress.make("tools.acme.org.main.whoami");

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: (record) => {
    const config = record.config as { readonly scopes?: readonly string[] } | null;
    return [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: config?.scopes ?? [] },
      },
    ];
  },
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: (scopes: readonly string[] = []) =>
      ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: { scopes } }),
  }),
}))();

/** What the delegating provider does when the host asks it to perform the grant. */
type GrantBehaviour =
  /** The honest implementation: seal a new access token, report expiry and scope. */
  | {
      readonly kind: "seals";
      readonly scope: string | null;
      readonly expiresInSeconds: number | null;
    }
  /** Reports success but leaves nothing resolvable under `accessItemId`. */
  | { readonly kind: "sealsNothing" }
  /** The authorization server refused the grant (RFC 6749 §5.2). */
  | { readonly kind: "rejected"; readonly error?: string };

const SEALS: GrantBehaviour = { kind: "seals", scope: "read", expiresInSeconds: 3_600 };

/** Records what the host asked the provider for, so a test can assert what it did NOT ask for. */
interface Recorder {
  readonly reads: string[];
  readonly grants: RefreshGrantInput[];
}

/** A memory provider that can also perform the refresh grant itself.
 *
 * `refreshGrant` seals under `accessItemId` exactly as a sealed-store provider would, and returns
 * only expiry and scope. It never calls `get`. `behaviour: null` omits the capability entirely,
 * which is how the fallback test shows the difference is the capability and not the harness. */
const delegatingCredentialsPlugin = (recorder: Recorder, behaviour: GrantBehaviour | null) =>
  definePlugin(() => {
    const store = new Map<string, string>();

    const base = {
      key: ProviderKey.make("memory"),
      writable: true as const,
      get: (id: ProviderItemId) =>
        Effect.sync(() => {
          recorder.reads.push(String(id));
          return store.get(String(id)) ?? null;
        }),
      set: (id: ProviderItemId, value: string) =>
        Effect.sync(() => {
          store.set(String(id), value);
        }),
      delete: (id: ProviderItemId) =>
        Effect.sync(() => {
          store.delete(String(id));
        }),
    };

    const provider: CredentialProvider =
      behaviour === null
        ? base
        : {
            ...base,
            refreshGrant: (input: RefreshGrantInput) =>
              Effect.suspend(() => {
                recorder.grants.push(input);
                if (behaviour.kind === "rejected") {
                  return Effect.fail(
                    new RefreshGrantRejected({
                      message: "the authorization server refused the grant",
                      error: behaviour.error,
                    }),
                  );
                }
                if (behaviour.kind === "sealsNothing") {
                  // A provider reporting a grant it did not perform is out of contract. What the
                  // host CAN do is refuse to stamp the row healthy over a token it cannot read
                  // back, which is what this drives.
                  store.delete(String(input.accessItemId));
                  return Effect.succeed({ expiresInSeconds: 3_600, scope: "read" });
                }
                store.set(String(input.accessItemId), "delegated-access-token");
                return Effect.succeed({
                  expiresInSeconds: behaviour.expiresInSeconds,
                  scope: behaviour.scope,
                });
              }),
          };

    return {
      id: "memory-credentials" as const,
      storage: () => ({}),
      credentialProviders: [provider],
    };
  })();

describe("provider-owned OAuth refresh grant", () => {
  /** Connect, force the connection past expiry, and hand back the pieces a test asserts on. The
   *  tool is NOT invoked here — each test drives the refresh itself so it can assert on failure. */
  const scenario = (options: {
    readonly behaviour: GrantBehaviour | null;
    readonly grant?: "authorization_code" | "client_credentials";
  }) =>
    Effect.gen(function* () {
      const recorder: Recorder = { reads: [], grants: [] };
      const server = yield* serveOAuthTestServer({ scopes: ["read"] });
      const plugins = [
        delegatingCredentialsPlugin(recorder, options.behaviour),
        oauthPlugin,
      ] as const;
      const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
      yield* executor.acme.seed();

      const grant = options.grant ?? "authorization_code";
      yield* executor.oauth.createClient({
        owner: "org",
        slug: CLIENT,
        authorizationUrl: server.authorizationEndpoint,
        tokenUrl: server.tokenEndpoint,
        grant,
        clientId: "test-client",
        clientSecret: "test-secret",
      });

      const started = yield* executor.oauth.start({
        owner: "org",
        client: CLIENT,
        clientOwner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
      });

      // `die` rather than `expect` — this is shared setup, not the assertion under test, and an
      // expect inside a branch is what the repo's no-conditional-tests rule exists to stop.
      if (grant === "authorization_code") {
        if (started.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });
      } else if (started.status !== "connected") {
        return yield* Effect.die("expected client_credentials to connect without a redirect");
      }

      // Force the next resolve down the refresh path.
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("name", "=", "main"),
          set: { expires_at: Date.now() - 60_000 },
        }),
      );

      recorder.reads.length = 0;
      recorder.grants.length = 0;
      return { recorder, server, config, executor };
    });

  it.effect("delegates the grant and never resolves the refresh token through the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, server, executor } = yield* scenario({ behaviour: SEALS });
        const out = yield* executor.execute(TOOL, {});

        // The grant was delegated, and named by id rather than handed a value.
        expect(recorder.grants).toHaveLength(1);
        const grant = recorder.grants[0]!;
        expect(String(grant.refreshItemId)).toContain(":refresh");
        expect(grant.tokenUrl).toBe(server.tokenEndpoint);
        expect(grant.clientAuth).toBe("body");

        // THE CUSTODY CLAIM. If this ever fails, the host is asking for the secret again and the
        // guarantee is gone — while the refresh itself still appears to work.
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(false);

        // The client secret is a long-lived credential too, and the provider was given its ID
        // precisely so it need never be revealed. Resolving it anyway would leave a sealed store
        // failing the refresh before `refreshGrant` was ever reached.
        expect(recorder.reads.some((id) => id.includes("secret"))).toBe(false);
        expect(grant.clientSecretItemId).toBeDefined();

        // The token the tool ran with is the one the provider sealed.
        expect(out).toEqual({ token: "delegated-access-token" });
      }),
    ),
  );

  it.effect("falls back to the host-side exchange when the provider cannot do the grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor } = yield* scenario({ behaviour: null });
        yield* executor.execute(TOOL, {});

        // Absence of `refreshGrant` changes nothing: the host performs the exchange, so it DOES
        // resolve the refresh token. Pinning that here is what makes the test above meaningful —
        // it shows the difference is the provider capability, not the harness.
        expect(recorder.grants).toHaveLength(0);
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(true);
      }),
    ),
  );

  it.effect("records the expiry and scope the provider reported", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const before = Date.now();
        const { config, executor } = yield* scenario({ behaviour: SEALS });
        yield* executor.execute(TOOL, {});

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        // Converted against the HOST clock, so the stored instant is comparable with the one
        // `shouldRefreshToken` later reads. A provider-computed absolute instant would import that
        // machine's skew and either serve expired tokens or churn.
        expect(Number(row?.expires_at)).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(Number(row?.expires_at)).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(row?.oauth_scope).toBe("read");
      }),
    ),
  );

  it.effect("leaves the recorded scope alone when the provider reports none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* scenario({
          behaviour: { kind: "seals", scope: null, expiresInSeconds: null },
        });
        // Give the row a scope to preserve. Without a known prior value the assertion below cannot
        // tell "left alone" from "cleared" — both would read null.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { oauth_scope: "read" },
          }),
        );
        yield* executor.execute(TOOL, {});

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        // `null` scope means "the AS did not report one", which must not clear what was granted at
        // connect time — distinct from an empty scope, which would.
        expect(row?.oauth_scope).toBe("read");
        expect(row?.expires_at).toBeNull();
      }),
    ),
  );

  it.effect("surfaces a refused grant as re-auth and arms the known-dead gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: { kind: "rejected", error: "invalid_grant" },
        });

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        // Not a StorageError: that is scrubbed to "Internal tool error [id]" at the sandbox
        // boundary, so the user would never be told to reconnect.
        expect(JSON.stringify(failure)).toContain("invalid_grant");

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toEqual(expect.any(Number));
        expect(row?.last_health).toMatchObject({ status: "expired" });

        // The gate is armed, so the doomed grant is not re-sent on the next resolve. Without this
        // a dead connection re-sends its dead grant on every proactive cycle, indefinitely.
        recorder.grants.length = 0;
        yield* Effect.flip(executor.execute(TOOL, {}));
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );

  it.effect("fails rather than reporting success when the new token cannot be read back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* scenario({ behaviour: { kind: "sealsNothing" } });

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        expect(JSON.stringify(failure)).toContain("could not be resolved");

        // The row must NOT have been stamped with a fresh expiry — doing that over a token nobody
        // can resolve leaves the connection reading healthy for a full lifetime while every call
        // using it fails.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(Number(row?.expires_at)).toBeLessThan(Date.now());
      }),
    ),
  );

  it.effect("refuses to delegate a grant to an endpoint the host's policy rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor, config } = yield* scenario({ behaviour: SEALS });
        // The token URL is read from the connection row, so it is the caller's view of where the
        // grant goes. Delegating the exchange must not delegate the guard: a provider holding a
        // sealed refresh token would otherwise post it wherever this column pointed.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { oauth_token_url: "http://evil.example/token" },
          }),
        );

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        expect(JSON.stringify(failure)).toContain("https:");
        // The point of the guard: the provider is never asked, so the sealed token never moves.
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );

  it.effect("leaves client_credentials on the host-side exchange", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor } = yield* scenario({
          behaviour: SEALS,
          grant: "client_credentials",
        });
        yield* executor.execute(TOOL, {});

        // client_credentials has no refresh token to spend — the token is re-minted from the
        // client id/secret — so it is a different exchange and must not be delegated.
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );
});
