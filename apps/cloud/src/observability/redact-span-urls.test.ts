import { describe, expect, it } from "@effect/vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import {
  redactSpanUrlAttributes,
  STRIPPED_QUERY_ATTRIBUTE,
  UrlRedactingSpanProcessor,
} from "./redact-span-urls";

// Synthetic placeholders only — never a real authorization code or state.
const CODE = "synthetic-authorization-code";
const STATE = "synthetic-csrf-state";

const callbackUrl = `https://app.test/api/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`;

/** Ends one real SDK span carrying `attributes` through the redacting
 *  processor, and returns what the exporter actually received. Using the real
 *  provider (rather than a hand-built span) exercises the `onEnding` → `onEnd`
 *  hook sequence exactly as production does. */
const exportSpanWith = (attributes: Record<string, string>): ReadableSpan | undefined => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  const span = provider.getTracer("test").startSpan("http.server GET");
  span.setAttributes(attributes);
  span.end();
  return exporter.getFinishedSpans()[0];
};

describe("redactSpanUrlAttributes", () => {
  it("strips the authorization code and state from url.full and url.query", () => {
    const attributes: Record<string, unknown> = {
      "url.full": callbackUrl,
      "url.query": `code=${CODE}&state=${STATE}&domain=example.test`,
      "url.path": "/api/oauth/callback",
      "http.request.method": "GET",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["code", "state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    // Route-level visibility is preserved.
    expect(attributes["url.path"]).toBe("/api/oauth/callback");
    expect(attributes["url.full"]).toBe("https://app.test/api/oauth/callback?domain=example.test");
    expect(attributes["url.query"]).toBe("domain=example.test");
  });

  it("strips a code nested inside the login redirect's returnTo parameter", () => {
    // `/login` is not an app-owned path, so its span comes from the worker
    // boundary — the callback query rides along inside `returnTo`
    // (auth/return-to.ts + the sign-in redirect in start.ts).
    const returnTo = encodeURIComponent(`/api/oauth/callback?code=${CODE}&state=${STATE}`);
    const attributes: Record<string, unknown> = {
      "url.full": `https://app.test/login?returnTo=${returnTo}`,
      "url.query": `returnTo=${returnTo}`,
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["returnTo.code", "returnTo.state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    expect(String(attributes["url.full"])).toContain("%2Fapi%2Foauth%2Fcallback");
  });

  it("leaves a span with no sensitive parameters untouched", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://app.test/api/integrations?owner=org",
      "url.query": "owner=org",
      "url.path": "/api/integrations",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual([]);
    expect(attributes["url.full"]).toBe("https://app.test/api/integrations?owner=org");
    expect(attributes["url.query"]).toBe("owner=org");
  });

  it("strips the other sensitive OAuth parameters", () => {
    const attributes: Record<string, unknown> = {
      "url.query":
        "id_token=synthetic-id-token&session_state=synthetic-session&error_description=synthetic-detail&error=access_denied",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual([
      "error_description",
      "id_token",
      "session_state",
    ]);
    // `error` is an enumerable code, not a secret — it stays.
    expect(attributes["url.query"]).toBe("error=access_denied");
  });
});

describe("UrlRedactingSpanProcessor", () => {
  it("scrubs the span before the exporter sees it", () => {
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
});
