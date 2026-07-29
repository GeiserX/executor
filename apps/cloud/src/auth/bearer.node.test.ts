// ---------------------------------------------------------------------------
// The single slice point for an inbound bearer credential.
//
// Both cloud bearer planes (the WorkOS api-key/session resolver and the MCP
// edge auth) route through this helper, so this is where the guarantee that a
// raw header never becomes a bare string is asserted. The header shapes are
// enumerated because each one means something different upstream — `Absent`
// falls through to the cookie session while `NotBearer` is a rejection — and
// because `Redacted.make("")` is truthy, so an empty token could not be told
// apart from a real one after wrapping.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Redacted } from "effect";

import { bearerCredential, isBearerPresent, isJwtBearer } from "./bearer";

// Synthetic, and asserted by exact match, so "<redacted>" cannot pass for it.
const TOKEN_SECRET = "synthetic-inbound-token";

// `Headers` strips trailing ASCII optional-whitespace, so a header written
// `"Bearer "` arrives as `"Bearer"` — the prefix no longer matches and the
// shape is NotBearer. A token that is only whitespace `Headers` preserves (a
// non-breaking space) is what actually reaches the Empty branch.
const NON_BREAKING_SPACE = String.fromCharCode(0xa0);

const requestWith = (headers: Record<string, string>) =>
  new Request("https://executor.test/api/tools", { headers });

describe("bearerCredential", () => {
  it("wraps the sliced token and keeps its real bytes", () => {
    const credential = bearerCredential(requestWith({ authorization: `Bearer ${TOKEN_SECRET}` }));

    expect(isBearerPresent(credential)).toBe(true);
    if (!isBearerPresent(credential)) return;
    expect(Redacted.isRedacted(credential.token)).toBe(true);
    expect(Redacted.value(credential.token)).toBe(TOKEN_SECRET);

    // What a log line, a span attribute, or an error payload would produce.
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain(TOKEN_SECRET);
    expect(serialized).toContain("<redacted>");
  });

  it("trims surrounding whitespace off the token", () => {
    const credential = bearerCredential(requestWith({ authorization: `Bearer  ${TOKEN_SECRET} ` }));

    expect(isBearerPresent(credential)).toBe(true);
    if (!isBearerPresent(credential)) return;
    expect(Redacted.value(credential.token)).toBe(TOKEN_SECRET);
  });

  it("distinguishes a missing header, a non-Bearer scheme, and an empty token", () => {
    expect(bearerCredential(requestWith({}))).toEqual({ _tag: "Absent" });
    expect(bearerCredential(requestWith({ authorization: `Basic ${TOKEN_SECRET}` }))).toEqual({
      _tag: "NotBearer",
    });
    // A bare scheme with nothing after it: the trailing space is stripped
    // before this code sees it, so it never matches the prefix.
    expect(bearerCredential(requestWith({ authorization: "Bearer " }))).toEqual({
      _tag: "NotBearer",
    });
    expect(
      bearerCredential(requestWith({ authorization: `Bearer ${NON_BREAKING_SPACE}` })),
    ).toEqual({ _tag: "Empty" });
  });
});

describe("isJwtBearer", () => {
  it("splits three-segment access tokens from api keys without unwrapping at the call site", () => {
    expect(isJwtBearer(Redacted.make("header.payload.signature"))).toBe(true);
    expect(isJwtBearer(Redacted.make(TOKEN_SECRET))).toBe(false);
    expect(isJwtBearer(Redacted.make("header.payload"))).toBe(false);
    expect(isJwtBearer(Redacted.make("a.b.c.d"))).toBe(false);
  });
});
