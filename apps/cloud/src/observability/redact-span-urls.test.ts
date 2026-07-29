// ---------------------------------------------------------------------------
// The OTel span-processor seam. The redaction POLICY is covered by
// `packages/core/sdk/src/span-redaction.test.ts`; what is under test here is
// that the processor reaches every surface a span ships credentials on —
// attributes, events, and `status.message` — before the exporter sees it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
} from "@opentelemetry/sdk-trace-base";

import { STRIPPED_QUERY_ATTRIBUTE, UrlRedactingSpanProcessor } from "./redact-span-urls";

// Synthetic placeholders only — never a real authorization code or state.
const CODE = "synthetic-authorization-code";
const STATE = "synthetic-csrf-state";

const callbackUrl = `https://app.test/api/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`;

/** Ends one real SDK span through the redacting processor and returns what the
 *  exporter actually received. Using the real provider (rather than a
 *  hand-built span) exercises the `onEnding` → `onEnd` hook sequence exactly as
 *  production does. */
const exportSpan = (record: (span: Span) => void): ReadableSpan | undefined => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  const span = provider.getTracer("test").startSpan("http.server GET") as Span;
  record(span);
  span.end();
  return exporter.getFinishedSpans()[0];
};

const exportSpanWith = (attributes: Record<string, string>): ReadableSpan | undefined =>
  exportSpan((span) => span.setAttributes(attributes));

describe("UrlRedactingSpanProcessor", () => {
  it("scrubs the span attributes before the exporter sees them", () => {
    const exported = exportSpanWith({
      "url.full": callbackUrl,
      "url.query": `code=${CODE}&state=${STATE}`,
      "url.path": "/api/oauth/callback",
    });

    expect(exported).toBeDefined();
    expect(JSON.stringify(exported?.attributes)).not.toContain(CODE);
    expect(JSON.stringify(exported?.attributes)).not.toContain(STATE);
    expect(exported?.attributes["url.path"]).toBe("/api/oauth/callback");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBe("code,state");
  });

  it("leaves a span with no sensitive parameters unchanged", () => {
    const exported = exportSpanWith({
      "url.full": "https://app.test/api/integrations?owner=org",
      "url.query": "owner=org",
    });

    expect(exported?.attributes["url.full"]).toBe("https://app.test/api/integrations?owner=org");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBeUndefined();
  });

  it("scrubs an exception event carrying the code in its message and stacktrace", () => {
    // The shape `@effect/opentelemetry`'s `recordException` produces on every
    // failed span — the URL scrubber never sees these, they are event
    // attributes, not span attributes.
    const exported = exportSpan((span) => {
      span.recordException({
        name: "RequestError",
        message: `POST ${callbackUrl} failed with 400`,
        stack: `RequestError: POST ${callbackUrl}\n    at fetch (executor.js:1:1)`,
      });
    });

    const serialized = JSON.stringify(exported?.events);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(STATE);
    // The diagnosable part survives.
    expect(serialized).toContain("/api/oauth/callback");
    expect(serialized).toContain("failed with 400");
  });

  it("scrubs a log event whose NAME is the already-interpolated message", () => {
    // Effect's default tracer logger writes the interpolated message as the
    // event name and the pretty cause as an attribute.
    const exported = exportSpan((span) => {
      span.addEvent(`redirecting to /oauth/callback?code=${CODE}`, {
        "effect.cause": `Error: GET ${callbackUrl}`,
        "effect.logLevel": "ERROR",
      });
    });

    const serialized = JSON.stringify(exported?.events);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(STATE);
    expect(exported?.events[0]?.name).toBe("redirecting to /oauth/callback");
    expect(exported?.events[0]?.attributes?.["effect.logLevel"]).toBe("ERROR");
  });

  it("caps an unbounded stacktrace", () => {
    const exported = exportSpan((span) => {
      span.recordException({
        name: "DeepError",
        message: "failed",
        stack: `DeepError: failed\n${"    at frame (executor.js:1:1)\n".repeat(2_000)}`,
      });
    });

    const stacktrace = String(exported?.events[0]?.attributes?.["exception.stacktrace"] ?? "");
    expect(stacktrace).toContain("truncated");
    expect(stacktrace.length).toBeLessThan(10_000);
  });

  it("scrubs status.message", () => {
    // `@effect/opentelemetry` sets this to the first error's message, which is
    // the same free text the exception event carries.
    const exported = exportSpan((span) => {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `GET ${callbackUrl} failed` });
    });

    expect(exported?.status.message).not.toContain(CODE);
    expect(exported?.status.message).toContain("/api/oauth/callback");
  });

  it("leaves a successful span's events and status alone", () => {
    const exported = exportSpan((span) => {
      span.addEvent("tool.invoked", { "tool.name": "list_things" });
      span.setStatus({ code: SpanStatusCode.OK });
    });

    expect(exported?.events[0]?.name).toBe("tool.invoked");
    expect(exported?.events[0]?.attributes?.["tool.name"]).toBe("list_things");
    expect(exported?.status.message).toBeUndefined();
  });
});
