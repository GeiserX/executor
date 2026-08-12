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

const startFlow = (executor: any, server: any, name: string) =>
  Effect.gen(function* () {
    const started = yield* executor.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: ConnectionName.make(name),
      integration: INTEG,
      template: TEMPLATE,
    });
    if (started.status !== "redirect") {
      return yield* Effect.die("expected a redirect-status OAuth start");
    }
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    return { state: started.state, code: callback.code };
  });

const sessionRow = (config: any, state: string) =>
  Effect.promise(() =>
    config.db.findFirst("oauth_session", { where: (b: any) => b("state", "=", state) }),
  );

describe("a dead authorization flow does not keep its PKCE verifier", () => {
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

        const dying = yield* startFlow(executor, server, "dying");
        const bystander = yield* startFlow(executor, server, "bystander");

        // The verifier really is sitting there in plaintext.
        const before = yield* sessionRow(config, dying.state);
        expect(before?.pkce_verifier).toEqual(expect.any(String));

        // Remove the app the flow was started against. Completion now fails with
        // restartRequired, so this state can never be redeemed again.
        yield* executor.oauth.removeClient("org", CLIENT);
        const failed = yield* Effect.flip(
          executor.oauth.complete({ state: dying.state, code: dying.code }),
        );
        expect(JSON.stringify(failed)).toContain("restartRequired");

        expect(yield* sessionRow(config, dying.state)).toBeNull();
        // The other flow is still live and untouched — a cleanup must not sweep
        // sessions it was not asked about.
        const survivor = yield* sessionRow(config, bystander.state);
        expect(survivor?.pkce_verifier).toEqual(expect.any(String));
      }),
    ),
  );
});
