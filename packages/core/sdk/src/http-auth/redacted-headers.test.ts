// ---------------------------------------------------------------------------
// The tracer's redacted-header list must cover the headers THIS app mints.
//
// Effect's tracing seams stamp every header as a span attribute and wrap only
// the names in `Headers.CurrentRedactedNames`. An `AuthPlacement` names its own
// header, so the list has to cover names a spec's `secretHeaders` produced —
// not just Effect's four defaults. Values here are synthetic.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Redacted } from "effect";
import { Headers } from "effect/unstable/http";

import { REDACTED_HEADER_NAMES } from "./redacted-headers";

const SECRET = "synthetic-credential-value";

const redactedNames = (headers: Record<string, string>): readonly string[] => {
  const redacted = Headers.redact(Headers.fromRecordUnsafe(headers), REDACTED_HEADER_NAMES);
  return Object.entries(redacted)
    .filter(([, value]) => Redacted.isRedacted(value))
    .map(([name]) => name)
    .sort();
};

describe("REDACTED_HEADER_NAMES", () => {
  it("covers the header names an auth placement mints", () => {
    // Every name here is reachable from a real placement: `authoring.ts`
    // accepts an arbitrary header name, and `derive-auth.ts` builds placements
    // straight from a spec's `secretHeaders`.
    const minted = {
      authorization: `Bearer ${SECRET}`,
      "x-api-key": SECRET,
      "api-key": SECRET,
      "x-figma-token": SECRET,
      "dd-api-key": SECRET,
      "private-token": SECRET,
      "x-auth-token": SECRET,
      "x-access-token": SECRET,
      "x-session-token": SECRET,
      "x-hub-signature": SECRET,
      "client-secret": SECRET,
    };

    expect(redactedNames(minted)).toEqual(Object.keys(minted).sort());
  });

  it("covers Effect's own defaults plus the standard auth headers it omits", () => {
    expect(
      redactedNames({
        authorization: `Bearer ${SECRET}`,
        cookie: `wos-session=${SECRET}`,
        "set-cookie": `wos-session=${SECRET}`,
        "proxy-authorization": `Basic ${SECRET}`,
        "www-authenticate": `Bearer realm="executor", error="invalid_token"`,
      }),
    ).toEqual(["authorization", "cookie", "proxy-authorization", "set-cookie", "www-authenticate"]);
  });

  it("leaves ordinary headers stamped in plaintext", () => {
    // Over-matching is cheap (a redacted attribute still shows the header was
    // present) but it must not swallow the headers that make a trace useful.
    expect(
      redactedNames({
        "content-type": "application/json",
        "user-agent": "executor/1.0",
        "x-request-id": "synthetic-request-id",
        accept: "application/json",
        "cache-control": "no-cache",
        "x-executor-organization": "acme",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      }),
    ).toEqual([]);
  });

  it("keeps the trace-correlation headers a bare `key` / `session` segment would swallow", () => {
    // These name a correlation value, not a credential, and they are precisely
    // the headers a retry or a session-scoped bug is read through. Pinned so a
    // future widening of the shape has to argue with this case rather than
    // silently blanking them.
    expect(
      redactedNames({
        "idempotency-key": "synthetic-idempotency-key",
        "x-idempotency-key": "synthetic-idempotency-key",
        "session-id": "synthetic-session-id",
        "x-session-id": "synthetic-session-id",
        "mcp-session-id": "synthetic-session-id",
        "partition-key": "synthetic-partition-key",
      }),
    ).toEqual([]);
  });
});
