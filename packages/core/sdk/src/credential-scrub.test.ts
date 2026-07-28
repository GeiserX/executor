import { describe, expect, it } from "@effect/vitest";
import { Redacted } from "effect";

import { makeCredentialScrubber } from "./credential-scrub";

// Synthetic values — never shaped like a real provider's credential.
const TOKEN = "synthetic-token-value";
const TEAM = "synthetic-team-value";

describe("makeCredentialScrubber", () => {
  it("removes every occurrence of every resolved value from text", () => {
    const scrub = makeCredentialScrubber({
      token: Redacted.make(TOKEN),
      team: Redacted.make(TEAM),
    });
    const echoed = `GET /v1/thing?team=${TEAM} failed: Authorization: Bearer ${TOKEN} (token ${TOKEN})`;

    const out = scrub.text(echoed);

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TEAM);
    expect(out).toBe(
      "GET /v1/thing?team=[redacted] failed: Authorization: Bearer [redacted] (token [redacted])",
    );
  });

  it("walks nested payloads, leaving non-string leaves intact", () => {
    const scrub = makeCredentialScrubber({ token: Redacted.make(TOKEN) });

    expect(
      scrub.payload({
        status: 401,
        ok: false,
        errors: [{ detail: `bad token ${TOKEN}` }],
        request: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    ).toEqual({
      status: 401,
      ok: false,
      errors: [{ detail: "bad token [redacted]" }],
      request: { headers: { authorization: "Bearer [redacted]" } },
    });
  });

  it('skips null entries and empty values — splitting on "" would shred the text', () => {
    const scrub = makeCredentialScrubber({
      token: null,
      blank: Redacted.make(""),
    });

    expect(scrub.text("nothing to remove here")).toBe("nothing to remove here");
  });

  it("replaces a longer secret whole when a shorter one is its prefix", () => {
    // Ordering matters: shortest-first would replace the prefix and strand the
    // remainder of the longer secret in the output.
    const short = "synthetic-abc";
    const long = "synthetic-abcdef";
    const scrub = makeCredentialScrubber({
      short: Redacted.make(short),
      long: Redacted.make(long),
    });

    const out = scrub.text(`value=${long}`);

    expect(out).toBe("value=[redacted]");
    expect(out).not.toContain("def");
  });
});
