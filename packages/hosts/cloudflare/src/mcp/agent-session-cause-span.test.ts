// ---------------------------------------------------------------------------
// `recordCauseOnSpan` stamps the failing cause as plain span ATTRIBUTES, not as
// an exception event, so neither the export seam's URL scrubber (which only
// looks at URL attributes) nor its event scrub reaches them. It runs the text
// through the shared scrub itself.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";

import { causeSpanAttributes } from "./agent-session-durable-object";

// Synthetic placeholders only.
const QUERY_TOKEN = "synthetic-endpoint-token";
const CODE = "synthetic-authorization-code";

describe("causeSpanAttributes", () => {
  it("scrubs a credential out of the message and the pretty cause", () => {
    const attributes = causeSpanAttributes(
      Cause.fail(
        // oxlint-disable-next-line executor/no-error-constructor -- the failure text is what is under test; a tagged error would hide it
        new Error(`POST https://mcp.test/mcp?token=${QUERY_TOKEN} failed with 401`),
      ),
    );

    expect(attributes).not.toBeNull();
    expect(attributes?.["exception.message"]).not.toContain(QUERY_TOKEN);
    expect(attributes?.["exception.stacktrace"]).not.toContain(QUERY_TOKEN);
    // The diagnosable part survives.
    expect(attributes?.["exception.message"]).toContain("https://mcp.test/mcp");
    expect(attributes?.["exception.message"]).toContain("failed with 401");
    expect(attributes?.["exception.type"]).toBe("Error");
  });

  it("scrubs a credential-named field of a serialized failure", () => {
    const attributes = causeSpanAttributes(
      // oxlint-disable-next-line executor/no-error-constructor -- the failure text is what is under test
      Cause.fail(new Error(`callback rejected {"code": "${CODE}", "_tag": "OAuthError"}`)),
    );

    expect(attributes?.["exception.message"]).not.toContain(CODE);
    expect(attributes?.["exception.message"]).toContain('"_tag": "OAuthError"');
  });

  it("caps an unbounded pretty cause", () => {
    // oxlint-disable-next-line executor/no-error-constructor -- a deep synthetic stack is the point
    const deep = new Error("deep failure");
    deep.stack = `Error: deep failure\n${"    at frame (do.js:1:1)\n".repeat(2_000)}`;

    const stacktrace = causeSpanAttributes(Cause.fail(deep))?.["exception.stacktrace"] ?? "";

    expect(stacktrace).toContain("truncated");
    expect(stacktrace.length).toBeLessThan(10_000);
  });

  it("returns null for a cause with no errors", () => {
    expect(causeSpanAttributes(Cause.empty)).toBeNull();
  });
});
