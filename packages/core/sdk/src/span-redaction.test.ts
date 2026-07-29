import { describe, expect, it } from "@effect/vitest";

import {
  MAX_SPAN_TEXT_CHARS,
  STRIPPED_QUERY_ATTRIBUTE,
  redactSensitiveKeyValuesInText,
  redactSpanUrlAttribute,
  redactSpanUrlAttributes,
  redactUrlQueryInText,
  scrubSpanText,
  truncateSpanText,
} from "./span-redaction";

// Synthetic placeholders only — never a real authorization code or state.
const CODE = "synthetic-authorization-code";
const STATE = "synthetic-csrf-state";
const TOKEN = "synthetic-endpoint-token";

describe("redactSpanUrlAttributes", () => {
  it("strips the authorization code and state from url.full and url.query", () => {
    const attributes: Record<string, unknown> = {
      "url.full": `https://app.test/api/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`,
      "url.query": `code=${CODE}&state=${STATE}&domain=example.test`,
      "url.path": "/api/oauth/callback",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["code", "state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    // Route-level visibility is preserved.
    expect(attributes["url.path"]).toBe("/api/oauth/callback");
    expect(attributes["url.full"]).toBe("https://app.test/api/oauth/callback?domain=example.test");
  });

  it("strips a code nested inside the login redirect's returnTo parameter", () => {
    const returnTo = encodeURIComponent(`/api/oauth/callback?code=${CODE}&state=${STATE}`);
    const attributes: Record<string, unknown> = {
      "url.full": `https://app.test/login?returnTo=${returnTo}`,
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["returnTo.code", "returnTo.state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(String(attributes["url.full"])).toContain("%2Fapi%2Foauth%2Fcallback");
  });

  it("leaves a span with no sensitive parameters untouched", () => {
    const attributes: Record<string, unknown> = { "url.query": "owner=org" };
    expect(redactSpanUrlAttributes(attributes)).toEqual([]);
    expect(attributes["url.query"]).toBe("owner=org");
  });
});

describe("redactSpanUrlAttribute", () => {
  it("returns null for an attribute that is not URL-bearing", () => {
    expect(redactSpanUrlAttribute("db.statement", `select ${CODE}`)).toBeNull();
    expect(redactSpanUrlAttribute(STRIPPED_QUERY_ATTRIBUTE, "code")).toBeNull();
  });

  it("returns null for a URL attribute carrying nothing sensitive", () => {
    expect(redactSpanUrlAttribute("url.full", "https://app.test/api?owner=org")).toBeNull();
  });

  it("returns the scrubbed value and the stripped keys", () => {
    expect(redactSpanUrlAttribute("url.full", `https://mcp.test/mcp?token=${TOKEN}`)).toEqual({
      value: "https://mcp.test/mcp",
      stripped: ["token"],
    });
  });

  it("ignores a non-string value", () => {
    expect(redactSpanUrlAttribute("url.full", 42)).toBeNull();
  });
});

describe("redactUrlQueryInText", () => {
  it("strips a credential from a URL quoted inside a message", () => {
    const message = `GET https://mcp.test/mcp?token=${TOKEN}&team=acme failed with 401`;
    const scrubbed = redactUrlQueryInText(message);

    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toBe("GET https://mcp.test/mcp?team=acme failed with 401");
  });

  it("strips a credential from a bare path with a query string", () => {
    expect(redactUrlQueryInText(`redirected to /oauth/callback?code=${CODE} and stopped`)).toBe(
      "redirected to /oauth/callback and stopped",
    );
  });

  it("leaves text with no URL untouched", () => {
    expect(redactUrlQueryInText("the upstream rejected the request")).toBe(
      "the upstream rejected the request",
    );
  });

  it("leaves a URL with no query string untouched", () => {
    expect(redactUrlQueryInText("GET https://api.test/v1/things failed")).toBe(
      "GET https://api.test/v1/things failed",
    );
  });

  it("scrubs every URL in a multi-line pretty cause", () => {
    const pretty = [
      `RequestError: POST https://api.test/token?code=${CODE}`,
      `    at fetch (https://app.test/assets/index.js?state=${STATE})`,
    ].join("\n");

    const scrubbed = redactUrlQueryInText(pretty);

    expect(scrubbed).not.toContain(CODE);
    expect(scrubbed).not.toContain(STATE);
    expect(scrubbed).toContain("https://api.test/token");
  });
});

describe("redactSensitiveKeyValuesInText", () => {
  it("replaces a credential-named value in serialized JSON", () => {
    // The exact shape Effect's tracer logger produces for a logged cause: the
    // tagged error is serialized INTO the event name, so no URL is involved.
    const logged = `[\n  "OAuth callback completion failed",\n  {\n    "state": "${STATE}",\n    "_tag": "OAuthSessionNotFoundError"\n  }\n]`;
    const scrubbed = redactSensitiveKeyValuesInText(logged);

    expect(scrubbed).not.toContain(STATE);
    expect(scrubbed).toContain('"state": "[redacted]"');
    // The part that makes the failure diagnosable survives.
    expect(scrubbed).toContain('"_tag": "OAuthSessionNotFoundError"');
    expect(scrubbed).toContain("OAuth callback completion failed");
  });

  it("replaces unquoted and single-quoted values", () => {
    expect(redactSensitiveKeyValuesInText(`code=${CODE} status=400`)).toBe(
      "code=[redacted] status=400",
    );
    expect(redactSensitiveKeyValuesInText(`token: '${TOKEN}'`)).toBe("token: '[redacted]'");
  });

  it("keeps a numeric value under a credential name", () => {
    // `code: 404` is the readable part of a failure message, not a grant.
    expect(redactSensitiveKeyValuesInText("failed with code: 404")).toBe("failed with code: 404");
  });

  it("leaves non-credential keys alone", () => {
    expect(
      redactSensitiveKeyValuesInText('{"slug": "acme", "status": "failed", "encoding": "utf-8"}'),
    ).toBe('{"slug": "acme", "status": "failed", "encoding": "utf-8"}');
  });
});

describe("truncateSpanText", () => {
  it("caps text past the limit and records how much went", () => {
    const capped = truncateSpanText("x".repeat(MAX_SPAN_TEXT_CHARS + 100));
    expect(capped.length).toBeLessThan(MAX_SPAN_TEXT_CHARS + 100);
    expect(capped).toContain("truncated 100 chars");
  });

  it("leaves text within the limit exactly as-is", () => {
    expect(truncateSpanText("short")).toBe("short");
  });
});

describe("scrubSpanText", () => {
  it("applies both policies: the credential goes and the tail is capped", () => {
    const stack = `Error: POST https://api.test/token?code=${CODE}\n${"frame\n".repeat(3_000)}`;
    const scrubbed = scrubSpanText(stack);

    expect(scrubbed).not.toContain(CODE);
    expect(scrubbed).toContain("truncated");
    expect(scrubbed.length).toBeLessThan(stack.length);
  });
});
