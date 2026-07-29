// ---------------------------------------------------------------------------
// A user-pasted credential is `Redacted` from the moment the HTTP payload
// decodes, and the real bytes still reach the credential provider.
//
// Both halves are needed, and each is worthless alone. A payload that decodes
// into `Redacted` but drops the secret on the way to the provider looks safe
// and stores nothing usable; `Redacted`'s toString/toJSON render the literal
// "<redacted>", so a missed unwrap on this WRITE path does not throw — it
// persists that literal and the connection fails later, far from the cause.
// So: assert the stored bytes ARE the secret, and that serializing the decoded
// payload exposes none of it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { Context, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  createExecutor,
  definePlugin,
  credentialValueToWrite,
  type CredentialProvider,
  type Executor,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { CreateConnectionPayload } from "./api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

// Synthetic, and asserted by exact match, so a "<redacted>" rendering cannot
// pass for the real thing.
const TOKEN_SECRET = "synthetic-pasted-token";
const TEAM_SECRET = "synthetic-pasted-team";

const BASE_URL = "http://localhost";
const INTEGRATION = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

// A writable provider that records exactly what bytes it was handed, so the
// assertion is on what would be persisted rather than on what reads back.
const makeRecordingCredentialsPlugin = () => {
  const store = new Map<string, string>();
  const provider: CredentialProvider = {
    key: ProviderKey.make("recording"),
    writable: true,
    get: (id) =>
      Effect.sync(() => {
        const value = store.get(String(id));
        return value === undefined ? null : Redacted.make(value);
      }),
    set: (id, value) =>
      Effect.sync(() => {
        store.set(String(id), credentialValueToWrite(value));
      }),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({ id: ProviderItemId.make(key), name: key })),
      ),
  };
  const plugin = definePlugin(() => ({
    id: "recording-credentials" as const,
    storage: () => ({}),
    credentialProviders: [provider],
  }))();
  return { plugin, storedValues: () => [...store.values()] };
};

const acmePlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("ping"), description: "ping" }] }),
  invokeTool: () => Effect.succeed({ ok: true }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({ slug: INTEGRATION, description: "Acme", config: {} }),
  }),
}))();

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

describe("pasted connection credentials over HTTP", () => {
  it.effect("stores the real bytes a create payload carried", () =>
    Effect.gen(function* () {
      const recording = makeRecordingCredentialsPlugin();
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [recording.plugin, acmePlugin] as const }),
      );
      yield* executor.acme.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/connections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: `{"owner":"org","name":"main","integration":"acme","template":"apiKey","values":{"token":"${TOKEN_SECRET}","team":"${TEAM_SECRET}"}}`,
          }),
          context,
        ),
      );
      expect(response.status).toBe(200);

      // The bytes the provider was handed are the secret, not "<redacted>" —
      // the failure a missed unwrap on this path produces.
      const stored = recording.storedValues().sort();
      expect(stored).toEqual([TEAM_SECRET, TOKEN_SECRET].sort());
    }),
  );

  it.effect("decodes a pasted secret into Redacted, so serializing it exposes nothing", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(CreateConnectionPayload)({
        owner: "org",
        name: "main",
        integration: "acme",
        template: "apiKey",
        values: { token: TOKEN_SECRET, team: TEAM_SECRET },
      });

      // What a log line, a span attribute, or an error payload would produce.
      const serialized = JSON.stringify(decoded);
      expect(serialized).not.toContain(TOKEN_SECRET);
      expect(serialized).not.toContain(TEAM_SECRET);
      expect(serialized).toContain("<redacted>");

      // …and the wrappers still hold the real secrets, so the assertions above
      // are redaction rather than an empty payload.
      const values = decoded.values ?? {};
      expect(Object.values(values).every(Redacted.isRedacted)).toBe(true);
      expect(Redacted.value(values["token"]!)).toBe(TOKEN_SECRET);
      expect(Redacted.value(values["team"]!)).toBe(TEAM_SECRET);
    }),
  );

  it.effect("sends a wrapped secret through the generated client, as packages/react does", () =>
    Effect.gen(function* () {
      // The browser client ENCODES through this same schema. `Schema.Redacted`
      // forbids encoding, so a regression to it would break the send path at
      // runtime, not at the type level — hence a real client, not a bare
      // `Schema.encode` call.
      const recording = makeRecordingCredentialsPlugin();
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [recording.plugin, acmePlugin] as const }),
      );
      yield* executor.acme.seed();
      const web = yield* webHandlerFor(executor);
      const context = handlerContextFor(executor);

      // The client hands `fetch` an (input, init) pair; the web handler wants a
      // whole `Request`, so normalize rather than assume one shape.
      const fetchIntoHandler = ((input: RequestInfo | URL, init?: RequestInit) =>
        web.handler(new Request(input as RequestInfo, init), context)) as typeof globalThis.fetch;

      const client = yield* HttpApiClient.make(ExecutorApi, { baseUrl: BASE_URL }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchIntoHandler)),
          ),
        ),
      );

      const created = yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEGRATION,
          template: TEMPLATE,
          value: Redacted.make(TOKEN_SECRET),
        },
      });
      expect(created.provider).toBe(ProviderKey.make("recording"));

      // Round-tripped through a real request: encoded to the body, decoded by
      // the server, and written to the provider as the original bytes.
      expect(recording.storedValues()).toEqual([TOKEN_SECRET]);
    }),
  );
});
