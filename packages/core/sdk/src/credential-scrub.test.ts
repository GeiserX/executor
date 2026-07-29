import { describe, expect, it } from "@effect/vitest";
import { Data, Option, Redacted } from "effect";

import { makeCredentialScrubber } from "./credential-scrub";

// Synthetic values — never shaped like a real provider's credential.
const TOKEN = "synthetic-token-value";
const TEAM = "synthetic-team-value";

/** Stands in for the plugin failure the openapi timeout paths hand to
 *  `scrub.payload` (`OpenApiInvocationError`): a tagged error whose message is
 *  the only diagnostic and whose `message`/`stack` are non-enumerable. */
class UpstreamTimeout extends Data.TaggedError("UpstreamTimeout")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly reason: string;
}> {}

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

  it("keeps a tagged error's message and tag, with the credential scrubbed out", () => {
    // `message`, `name`, and `stack` are non-enumerable on an Error, so a plain
    // enumerable projection drops the ONLY diagnostic a timeout failure has.
    const scrub = makeCredentialScrubber({ token: Redacted.make(TOKEN) });
    const failure = new UpstreamTimeout({
      message: `Upstream returned no response headers within 100ms for https://api.test/v1?token=${TOKEN}`,
      statusCode: Option.none(),
      reason: "response_headers_timeout",
    });

    const scrubbed = scrub.payload(failure);

    expect(scrubbed).toMatchObject({
      message:
        "Upstream returned no response headers within 100ms for https://api.test/v1?token=[redacted]",
      name: "UpstreamTimeout",
      _tag: "UpstreamTimeout",
      reason: "response_headers_timeout",
      stack: expect.any(String),
    });
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it("marks a cycle instead of recursing into it", () => {
    // A decoded response body is a tree, but a thrown failure is not: an error
    // whose cause points back at it would recurse until the stack goes.
    const scrub = makeCredentialScrubber({ token: Redacted.make(TOKEN) });
    const envelope: Record<string, unknown> = { detail: `rejected ${TOKEN}` };
    envelope.self = envelope;
    envelope.nested = [envelope];

    expect(scrub.payload(envelope)).toEqual({
      detail: "rejected [redacted]",
      self: "[circular]",
      nested: ["[circular]"],
    });
  });
});
