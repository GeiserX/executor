// ---------------------------------------------------------------------------
// The BROWSER export seam. The web client ships spans to /v1/traces, which the
// worker forwards to the same Axiom dataset the worker's own spans land in, so
// the browser must apply the same scrub — the redaction POLICY is covered by
// `packages/core/sdk/src/span-redaction.test.ts`.
//
// This drives the real `OtlpTracer` (the layer `client.tsx` installs) with the
// redacting serializer in front of a fake fetch, and asserts on the bytes that
// would have gone over the wire.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { layerRedacted } from "./otlp-redaction";

// Synthetic placeholders only — never a real authorization code or token.
const CODE = "synthetic-authorization-code";
const TOKEN = "synthetic-endpoint-token";

const EXPORT_URL = "https://app.test/v1/traces";

/** Runs `program` under a real `OtlpTracer` whose exporter posts through a fake
 *  fetch, and returns every exported body. The exporter flushes from a scope
 *  finalizer, so closing the scope drains the batch. */
const exportedBodies = (
  program: Effect.Effect<void>,
  serialization: Layer.Layer<OtlpSerialization.OtlpSerialization>,
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    const bodies: string[] = [];
    const fetchLayer = Layer.succeed(FetchHttpClient.Fetch)(((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      // `OtlpSerialization.layerJson` produces an `HttpBody.Uint8Array`, so the
      // wire bytes arrive already encoded.
      const body = init?.body;
      bodies.push(body instanceof Uint8Array ? decoder.decode(body) : String(body ?? ""));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof globalThis.fetch);

    yield* Effect.scoped(
      Effect.provide(
        program,
        OtlpTracer.layer({
          url: EXPORT_URL,
          resource: { serviceName: "executor-web-test" },
          exportInterval: "1 minute",
        }).pipe(
          Layer.provide(serialization),
          Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(fetchLayer))),
        ),
      ),
    );

    return bodies;
  });

/** One span carrying the attributes `HttpClient` stamps on every API request. */
const callbackSpan = Effect.void.pipe(
  Effect.withSpan("http.client GET", {
    attributes: {
      "url.full": `https://app.test/api/oauth/callback?code=${CODE}&domain=example.test`,
      "url.query": `code=${CODE}&domain=example.test`,
      "url.path": "/api/oauth/callback",
    },
  }),
);

describe("layerRedacted", () => {
  it.effect("scrubs url.full and url.query out of the exported payload", () =>
    Effect.gen(function* () {
      const bodies = yield* exportedBodies(
        callbackSpan,
        layerRedacted(OtlpSerialization.layerJson),
      );

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain(CODE);
      // Route-level visibility survives, and the stripped keys are recorded.
      expect(bodies[0]).toContain("/api/oauth/callback");
      expect(bodies[0]).toContain("url.query.stripped_keys");
    }),
  );

  it.effect("the unwrapped serializer exports the code — the wrapper is load-bearing", () =>
    Effect.gen(function* () {
      const bodies = yield* exportedBodies(callbackSpan, OtlpSerialization.layerJson);

      expect(bodies[0]).toContain(CODE);
    }),
  );

  it.effect("scrubs a failed span's exception event and status message", () =>
    Effect.gen(function* () {
      // A failing span: `OtlpTracer` renders the cause into an `exception`
      // event AND into `status.message`, neither of which is a URL attribute.
      const failing = Effect.fail(
        // oxlint-disable-next-line executor/no-error-constructor -- the failure text is what is under test; a tagged error would hide it
        new Error(`POST https://mcp.test/mcp?token=${TOKEN} failed with 401`),
      ).pipe(Effect.withSpan("http.client POST"), Effect.ignore);

      const bodies = yield* exportedBodies(failing, layerRedacted(OtlpSerialization.layerJson));

      expect(bodies[0]).not.toContain(TOKEN);
      expect(bodies[0]).toContain("https://mcp.test/mcp");
      expect(bodies[0]).toContain("failed with 401");
    }),
  );

  it.effect("leaves a span with nothing sensitive untouched", () =>
    Effect.gen(function* () {
      const bodies = yield* exportedBodies(
        Effect.void.pipe(
          Effect.withSpan("http.client GET", {
            attributes: { "url.full": "https://app.test/api/integrations?owner=org" },
          }),
        ),
        layerRedacted(OtlpSerialization.layerJson),
      );

      expect(bodies[0]).toContain("https://app.test/api/integrations?owner=org");
      expect(bodies[0]).not.toContain("url.query.stripped_keys");
    }),
  );
});
