// ---------------------------------------------------------------------------
// The invoke span must not carry the connection's base URL verbatim.
//
// A connection `baseUrl` is a user-supplied URL from the same class as the mcp
// and graphql endpoints already covered: `?token=…` in the query string and
// `user:pass@host` userinfo are both supported input shapes. Stamping it raw on
// `plugin.openapi.invoke` shipped the credential to the trace backend on every
// tool call. Synthetic placeholders only.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Tracer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { invokeWithLayer } from "./invoke";
import { OperationBinding } from "./types";

const QUERY_TOKEN = "synthetic-endpoint-token";
const USERINFO_PASSWORD = "synthetic-endpoint-password";

/** Records every span the program opens so the stamped attributes can be read
 *  back. Port 1 connection-refuses immediately, so the invocation resolves
 *  without any network dependency. */
const recordingTracer = (spans: Array<Tracer.NativeSpan>) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
    context: (primitive, fiber) => primitive["~effect/Effect/evaluate"](fiber),
  });

const operation = OperationBinding.make({
  method: "get",
  servers: [],
  pathTemplate: "/things",
  requestBody: Option.none(),
  responseBody: Option.none(),
  parameters: [],
});

const invokeAgainst = (baseUrl: string) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    yield* invokeWithLayer(operation, {}, baseUrl, {}, {}, FetchHttpClient.layer).pipe(
      Effect.exit,
      Effect.provideService(Tracer.Tracer, recordingTracer(spans)),
    );
    return spans;
  });

describe("openapi invoke telemetry", () => {
  it.effect("stamps a sanitized base_url on the invoke span", () =>
    Effect.gen(function* () {
      const spans = yield* invokeAgainst(
        `http://svc-user:${USERINFO_PASSWORD}@127.0.0.1:1/v1?token=${QUERY_TOKEN}`,
      );

      const invoke = spans.find((span) => span.name === "plugin.openapi.invoke");
      expect(invoke).toBeDefined();
      expect(invoke?.attributes.get("plugin.openapi.base_url")).toBe("http://127.0.0.1:1/v1");

      // Scoped to the plugin's own spans. Effect's HttpClient separately stamps
      // `url.full`/`url.query` on its outgoing client spans; those are scrubbed
      // downstream by the export pipeline's redaction, which is not installed
      // at this level.
      const serialized = JSON.stringify(
        spans
          .filter((span) => span.name.startsWith("plugin.openapi."))
          .map((span) => Object.fromEntries(span.attributes.entries())),
      );
      expect(serialized).not.toContain(QUERY_TOKEN);
      expect(serialized).not.toContain(USERINFO_PASSWORD);
    }),
  );

  it.effect("leaves a credential-free base URL intact", () =>
    Effect.gen(function* () {
      const spans = yield* invokeAgainst("http://127.0.0.1:1/v1");

      const invoke = spans.find((span) => span.name === "plugin.openapi.invoke");
      expect(invoke?.attributes.get("plugin.openapi.base_url")).toBe("http://127.0.0.1:1/v1");
      expect(invoke?.attributes.get("plugin.openapi.path_template")).toBe("/things");
    }),
  );
});
