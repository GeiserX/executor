// ---------------------------------------------------------------------------
// The plugin-contract half of the `Redacted` credential guarantee: the
// `ToolInvocationCredential` core hands a plugin must not expose its secret
// when serialized, which is what a log line, a span attribute, or an error
// payload does to it.
//
// The wire half — the secret still reaches the upstream request byte for byte —
// is asserted against a live server in
// `packages/plugins/openapi/src/sdk/redacted-credential.test.ts`. Both halves
// are needed: either one alone passes trivially for a broken implementation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolAddress, ToolName } from "./ids";
import { definePlugin, type ToolInvocationCredential } from "./plugin";
import { makeTestExecutor, memoryCredentialsPlugin } from "./test-config";

// Synthetic: not shaped like any real provider's credential.
const TOKEN_SECRET = "synthetic-token-value";
const TEAM_SECRET = "synthetic-team-value";

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const makeCapturingPlugin = () => {
  let captured: ToolInvocationCredential | undefined;
  const plugin = definePlugin(() => ({
    id: "capture" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("ping"), description: "ping" }] }),
    invokeTool: ({ credential }) =>
      Effect.sync(() => {
        captured = credential;
        return { ok: true };
      }),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
    }),
  }))();
  return { plugin, read: () => captured };
};

describe("ToolInvocationCredential redaction", () => {
  it.effect("serializing the credential exposes neither the primary nor a named value", () =>
    Effect.gen(function* () {
      const { plugin, read } = makeCapturingPlugin();
      const executor = yield* makeTestExecutor({
        plugins: [memoryCredentialsPlugin(), plugin] as const,
      });
      yield* executor.capture.seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        values: { token: TOKEN_SECRET, team: TEAM_SECRET },
      });

      yield* executor.execute(ToolAddress.make("tools.acme.org.main.ping"), {});

      const credential = read();
      expect(credential).toBeDefined();
      if (!credential) return;

      // What a log line or a span attribute would produce.
      const serialized = JSON.stringify(credential);
      expect(serialized).not.toContain(TOKEN_SECRET);
      expect(serialized).not.toContain(TEAM_SECRET);
      expect(serialized).toContain("<redacted>");

      // `value` is a separate field from `values`, so it gets its own check —
      // it would be the easy one to widen back to a bare string.
      expect(Redacted.isRedacted(credential.value)).toBe(true);
      for (const entry of Object.values(credential.values)) {
        expect(entry === null || Redacted.isRedacted(entry)).toBe(true);
      }

      // …and the wrappers still hold the real secrets, so the assertions above
      // are redaction rather than an empty credential.
      expect(credential.value === null ? null : Redacted.value(credential.value)).toBe(
        TOKEN_SECRET,
      );
      const team = credential.values["team"];
      expect(team === null || team === undefined ? null : Redacted.value(team)).toBe(TEAM_SECRET);
    }),
  );
});
