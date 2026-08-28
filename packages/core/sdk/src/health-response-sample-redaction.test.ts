// A health check writes its response sample into `connection.last_health`, so
// whatever the sample carries is persisted. The operation being probed is
// user-chosen from the plugin's catalog, which means it can be a key-listing
// endpoint just as easily as a `/me`.
//
// These use real response bodies of the shape those endpoints return, because
// the property under test is what survives the walk into the database.

import { describe, expect, it } from "@effect/vitest";

import { extractResponseFields, REDACTED_SAMPLE_VALUE } from "./health-check";

/** The sample as a path -> value lookup, which is how the assertions read. */
const byPath = (data: unknown): Record<string, string> =>
  Object.fromEntries(extractResponseFields(data).map((f) => [f.path, f.value]));

describe("health-check response sample redaction", () => {
  it("redacts credential-named leaves while keeping the identity fields", () => {
    const fields = byPath({
      email: "alex@example.com",
      login: "alex",
      id: 4711,
      api_key: "sk-live-must-not-be-persisted",
      refresh_token: "rt-must-not-be-persisted",
      session: "sess-must-not-be-persisted",
    });

    // The reason the sample exists still works.
    expect(fields.email).toBe("alex@example.com");
    expect(fields.login).toBe("alex");
    expect(fields.id).toBe("4711");

    expect(fields.api_key).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields.refresh_token).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields.session).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("redacts nested and array-borne credentials, not just top-level ones", () => {
    // What a key-listing endpoint actually returns. This is the case a scrub
    // of the connection's own value cannot catch: these are different secrets.
    const fields = byPath({
      keys: [
        { name: "prod", token: "sk-prod-must-not-be-persisted" },
        { name: "staging", token: "sk-staging-must-not-be-persisted" },
      ],
      account: { billing: { secret: "whsec-must-not-be-persisted" } },
    });

    expect(fields["keys.0.name"]).toBe("prod");
    expect(fields["keys.0.token"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["keys.1.token"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["account.billing.secret"]).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("redacts a bare array of secrets, where only the enclosing key names them", () => {
    // `{"tokens": ["sk-…"]}` yields the paths `tokens.0`, `tokens.1`. Their last
    // segment is an array index, so a check that reads the literal leaf finds
    // "0" and lets the secret straight through into `connection.last_health`.
    const fields = byPath({
      tokens: ["sk-live-must-not-be-persisted", "sk-test-must-not-be-persisted"],
      names: ["prod", "staging"],
    });

    expect(fields["tokens.0"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["tokens.1"]).toBe(REDACTED_SAMPLE_VALUE);

    // The index walk-back stops at the nearest NAMED segment, so an innocent
    // collection is still shown in full.
    expect(fields["names.0"]).toBe("prod");
    expect(fields["names.1"]).toBe("staging");
  });

  it("keeps the field visible so the preview still shows the shape", () => {
    // Dropping the row would change what the picker displays. Redacting the
    // value keeps the response shape legible without persisting the secret.
    const sample = extractResponseFields({ api_key: "sk-live-x" });

    expect(sample).toHaveLength(1);
    expect(sample[0]?.path).toBe("api_key");
  });

  it("does not redact identity keys that merely contain a matching substring", () => {
    // `author` contains "auth". Matching it would silently blank a normal
    // field, which is how an over-eager redactor makes the feature useless.
    const fields = byPath({ author: "alex", authorization: "Bearer x" });

    expect(fields.author).toBe("alex");
    expect(fields.authorization).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("POSITIVE CONTROL: an unredacted body does come through verbatim", () => {
    // Proves these assertions can fail. Without it, an extractor that returned
    // nothing, or redacted everything, would satisfy the checks above.
    const fields = byPath({ email: "alex@example.com", plan: "pro" });

    expect(fields.email).toBe("alex@example.com");
    expect(fields.plan).toBe("pro");
    expect(Object.values(fields)).not.toContain(REDACTED_SAMPLE_VALUE);
  });
});
