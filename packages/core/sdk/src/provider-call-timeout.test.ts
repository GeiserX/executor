// ---------------------------------------------------------------------------
// A credential provider that stops answering must fail the resolution, not hang it.
//
// A provider is frequently REMOTE — an HTTP secret store, or under sealed custody a
// vault that may live in another enclave — so "stopped answering" is one of its
// ordinary failure modes. Unbounded, a store that goes away does not fail a tool
// invocation, it hangs it, and nothing in the resulting silence names the provider.
//
// Executor already bounds its other remote calls this way (OAuth discovery, the MCP
// plugin's probes); credential resolution was the one that did not.
//
// Time is virtual here: the bound is deliberately generous, and a test that waited
// it out in real time would be a thirty-second test. TestClock is advanced past it
// instead — which is also why this uses `it.effect` rather than `it.live`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./test-config";

const STORE = ProviderKey.make("remote-store");
const INTEG = IntegrationSlug.make("acme");
const CONN = ConnectionName.make("main");

const providerWith = (get: CredentialProvider["get"]): CredentialProvider => ({
  key: STORE,
  writable: true,
  get,
  set: () => Effect.void,
});

const plugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "acme" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
      read: () => ctx.connections.resolveValue({ owner: "org", integration: INTEG, name: CONN }),
    }),
  }))();

const executorWithConnection = (provider: CredentialProvider) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [plugin(provider)] as const }),
    );
    yield* executor.acme.seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: INTEG,
      template: AuthTemplateSlug.make("api_key"),
      from: { provider: STORE, id: ProviderItemId.make("item-1") },
    });
    return executor;
  });

describe("a credential provider that stops answering", () => {
  it.effect("fails the resolution instead of hanging it", () =>
    Effect.gen(function* () {
      const executor = yield* executorWithConnection(providerWith(() => Effect.never));

      const fiber = yield* Effect.forkChild(Effect.exit(executor.acme.read()));
      yield* TestClock.adjust(Duration.minutes(5));
      const exit = yield* Fiber.join(fiber);

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("names the provider and the operation, not just a failure", () =>
    Effect.gen(function* () {
      // A bare timeout would leave an operator looking at whatever the caller was
      // doing rather than at the store that stopped answering.
      const executor = yield* executorWithConnection(providerWith(() => Effect.never));

      const fiber = yield* Effect.forkChild(Effect.exit(executor.acme.read()));
      yield* TestClock.adjust(Duration.minutes(5));
      const exit = yield* Fiber.join(fiber);

      expect(String(exit)).toContain("remote-store");
      expect(String(exit)).toContain("did not answer");
    }),
  );

  it.effect("still resolves normally when the provider answers", () =>
    Effect.gen(function* () {
      // The control. A bound that refused everything would satisfy both assertions
      // above while breaking every working deployment.
      const executor = yield* executorWithConnection(providerWith(() => Effect.succeed("tok")));

      expect(yield* executor.acme.read()).toBe("tok");
    }),
  );
});
