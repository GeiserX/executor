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
import type { CredentialProvider, RefreshGrantInput } from "./provider";
import { makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// A provider that OWNS the refresh grant never hands the refresh token out. These tests pin that
// property directly rather than asserting "the refresh succeeded" — success is not the claim. The
// claim is that the host never resolved the secret, and only a test watching `get` can tell a
// provider that protected the token from one that quietly served it. Both would go green.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

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

/** Records what the host asked the provider for, so a test can assert what it did NOT ask for. */
interface Recorder {
  readonly reads: string[];
  readonly grants: RefreshGrantInput[];
}

/** A memory provider that can also perform the refresh grant itself.
 *
 * `refreshGrant` seals a new access token under `accessItemId`, exactly as a sealed-store provider
 * would, and returns only expiry and scope. It never calls `get`. */
const delegatingCredentialsPlugin = (recorder: Recorder, withGrant: boolean) =>
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

    const provider: CredentialProvider = withGrant
      ? {
          ...base,
          refreshGrant: (input: RefreshGrantInput) =>
            Effect.sync(() => {
              recorder.grants.push(input);
              store.set(String(input.accessItemId), "delegated-access-token");
              return { expiresAt: Date.now() + 3_600_000, scope: "read" };
            }),
        }
      : base;

    return {
      id: "memory-credentials" as const,
      storage: () => ({}),
      credentialProviders: [provider],
    };
  })();

describe("provider-owned OAuth refresh grant", () => {
  const scenario = (withGrant: boolean) =>
    Effect.gen(function* () {
      const recorder: Recorder = { reads: [], grants: [] };
      const server = yield* serveOAuthTestServer({ scopes: ["read"] });
      const plugins = [delegatingCredentialsPlugin(recorder, withGrant), oauthPlugin] as const;
      const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
      yield* executor.acme.seed();

      yield* executor.oauth.createClient({
        owner: "org",
        slug: CLIENT,
        authorizationUrl: server.authorizationEndpoint,
        tokenUrl: server.tokenEndpoint,
        grant: "authorization_code",
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
      // Assert-then-return rather than throwing: this is Effect domain code, and the repo's lint
      // forbids constructing or throwing built-in Errors here. A failed expectation already fails
      // the test, so the early return only satisfies the type.
      expect(started.status).toBe("redirect");
      if (started.status !== "redirect") return { recorder, server };
      const callback = yield* server.completeAuthorizationCodeFlow({
        authorizationUrl: started.authorizationUrl,
      });
      yield* executor.oauth.complete({ state: started.state, code: callback.code });

      // Force the next resolve down the refresh path.
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("name", "=", "main"),
          set: { expires_at: Date.now() - 60_000 },
        }),
      );

      recorder.reads.length = 0;
      recorder.grants.length = 0;
      yield* executor.execute(ToolAddress.make("tools.acme.org.main.whoami"), {});
      return { recorder, server };
    });

  it.effect("delegates the grant and never resolves the refresh token through the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, server } = yield* scenario(true);

        // The grant was delegated, and named by id rather than handed a value.
        expect(recorder.grants).toHaveLength(1);
        const grant = recorder.grants[0]!;
        expect(String(grant.refreshItemId)).toContain(":refresh");
        expect(grant.tokenUrl).toBe(server.tokenEndpoint);

        // THE CUSTODY CLAIM. If this ever fails, the host is asking for the secret again and the
        // guarantee is gone — while the refresh itself still appears to work.
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(false);
      }),
    ),
  );

  it.effect("falls back to the host-side exchange when the provider cannot do the grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder } = yield* scenario(false);

        // Absence of `refreshGrant` changes nothing: the host performs the exchange, so it DOES
        // resolve the refresh token. Pinning that here is what makes the test above meaningful —
        // it shows the difference is the provider capability, not the harness.
        expect(recorder.grants).toHaveLength(0);
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(true);
      }),
    ),
  );
});
