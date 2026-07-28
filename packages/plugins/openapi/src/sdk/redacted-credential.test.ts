// ---------------------------------------------------------------------------
// The wire half of the `Redacted` credential contract, asserted against a real
// server rather than against types.
//
// A `Redacted` that never unwraps is not "safe", it is broken: the wrapper's
// toString/toJSON render the literal "<redacted>", so a missed unwrap does not
// throw — it sends that literal upstream and comes back as a 401 with nothing
// pointing at the cause. This asserts the SECRET reached the wire, byte for
// byte, through the rendering path every HTTP plugin shares.
//
// The other half (the credential a plugin receives still serializes redacted)
// lives in `packages/core/sdk/src/redacted-credential.test.ts`, where the
// plugin contract itself is defined.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import {
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { type AuthenticationInput } from "./types";

// Synthetic throughout: not shaped like any real provider's keys, and the
// assertions are exact-match, so a redacted rendering cannot pass.
const API_SECRET = "synthetic-apikey-value";
const TEAM_SECRET = "synthetic-team-value";

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-team": Schema.optional(Schema.String),
});

const EchoGroup = HttpApiGroup.make("echo").add(
  HttpApiEndpoint.get("headers", "/echo", { success: EchoHeaders }),
);
const EchoApi = HttpApi.make("echoApi").add(EchoGroup);

const EchoGroupLive = HttpApiBuilder.group(EchoApi, "echo", (handlers) =>
  handlers.handle("headers", () =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return EchoHeaders.make({
        authorization: request.headers["authorization"],
        "x-team": request.headers["x-team"],
      });
    }),
  ),
);

const serveEcho = () =>
  serveOpenApiHttpApiTestServer({ api: EchoApi, handlersLayer: EchoGroupLive });

// Two placements over two DISTINCT inputs: proves each variable is unwrapped
// against its own entry, not that one lucky value leaked through everywhere.
const twoInputTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("api_key"),
  type: "apiKey",
  headers: {
    authorization: ["Bearer ", { type: "variable" as const, name: "token" }],
    "x-team": [{ type: "variable" as const, name: "team" }],
  },
};

const INTEG = IntegrationSlug.make("echo_api");
const TEMPLATE = AuthTemplateSlug.make("api_key");
const ECHO = "echo.headers";

describe("Redacted credentials on the wire", () => {
  it.effect("every rendered placement carries the real secret, not the wrapper", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveEcho();
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "echo_api",
          baseUrl: server.baseUrl,
          authenticationTemplate: [twoInputTemplate],
        });

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          values: { token: API_SECRET, team: TEAM_SECRET },
        });

        const echoed = unwrapInvocation(
          yield* executor.execute(ToolAddress.make(`tools.echo_api.org.main.${ECHO}`), {}),
        ).data as { authorization?: string; "x-team"?: string };

        expect(echoed.authorization).toBe(`Bearer ${API_SECRET}`);
        expect(echoed["x-team"]).toBe(TEAM_SECRET);
        // The failure mode this test exists for: a missed unwrap sends the
        // wrapper's rendering, and the request still leaves the process.
        expect(echoed.authorization).not.toContain("<redacted>");
      }),
    ),
  );
});
