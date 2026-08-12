import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// An in-flight authorization flow parks its PKCE verifier in `oauth_session` in
// plaintext, which is fine while the flow can still spend it. What is not fine is
// leaving it there after the flow has died: the happy path and `cancel` delete the
// row, but a completion that FAILED did not, and nothing sweeps the table, so the
// verifier outlived the flow indefinitely.
//
// Paired, like every deletion test: an unredeemable session must go, and a
// perfectly good one sitting beside it must not.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

const memoryCredentialsPlugin = definePlugin(() => {
  const store = new Map<string, string>();
  return {
    id: "memory-credentials" as const,
    storage: () => ({}),
    credentialProviders: [
      {
        key: ProviderKey.make("memory"),
        writable: true as const,
        get: (id: ProviderItemId) => Effect.sync(() => store.get(String(id)) ?? null),
        set: (id: ProviderItemId, value: string) =>
          Effect.sync(() => {
            store.set(String(id), value);
          }),
        delete: (id: ProviderItemId) =>
          Effect.sync(() => {
            store.delete(String(id));
          }),
      },
    ],
  };
})();

const acmePlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(TEMPLATE),
      oauth: { scopes: [] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
  }),
}))();

interface SessionRow {
  readonly pkce_verifier?: string | null;
}

describe("a dead authorization flow does not keep its PKCE verifier", () => {
  it.effect("sweeps an expired verifier the next time authorization starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const { executor, config } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin, acmePlugin] as const,
        });
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

        const readSession = (state: string) =>
          Effect.promise(
            () =>
              config.db.findFirst("oauth_session", {
                where: (b) => b("state", "=", state),
              }) as Promise<SessionRow | null>,
          );

        // An abandoned flow: started, never returned to. Nothing completes it, so
        // the lazy expiry check in `complete` never runs for it.
        const abandoned = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("abandoned"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (abandoned.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        // A live flow started beside it, which must survive the sweep.
        const live = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("live"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (live.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        // Age only the abandoned one past its expiry.
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_session", {
            where: (b) => b("state", "=", String(abandoned.state)),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        expect((yield* readSession(String(abandoned.state)))?.pkce_verifier).toEqual(
          expect.any(String),
        );

        // Starting any authorization is what tidies up.
        const third = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("third"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (third.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        expect(yield* readSession(String(abandoned.state))).toBeNull();
        // The unexpired flow is untouched — a sweep must not cancel someone
        // else's authorization mid-flight.
        expect((yield* readSession(String(live.state)))?.pkce_verifier).toEqual(expect.any(String));
      }),
    ),
  );

  it.effect("drops the session when the completion cannot be retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({});
        const { executor, config } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin, acmePlugin] as const,
        });
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

        const readSession = (state: string) =>
          Effect.promise(
            () =>
              config.db.findFirst("oauth_session", {
                where: (b) => b("state", "=", state),
              }) as Promise<SessionRow | null>,
          );

        const dying = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("dying"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (dying.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        const dyingCallback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: dying.authorizationUrl,
        });

        const bystander = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("bystander"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (bystander.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }

        // The verifier really is sitting there in plaintext.
        const before = yield* readSession(String(dying.state));
        expect(before?.pkce_verifier).toEqual(expect.any(String));

        // Remove the app this flow was started against, so completion fails with
        // restartRequired — this state can never be redeemed again.
        yield* executor.oauth.removeClient("org", CLIENT);
        const failed = yield* Effect.flip(
          executor.oauth.complete({ state: dying.state, code: dyingCallback.code }),
        );
        expect(JSON.stringify(failed)).toContain("restartRequired");

        expect(yield* readSession(String(dying.state))).toBeNull();
        // The other flow is still live and untouched — a cleanup must not sweep
        // sessions it was not asked about.
        const survivor = yield* readSession(String(bystander.state));
        expect(survivor?.pkce_verifier).toEqual(expect.any(String));
      }),
    ),
  );
});
