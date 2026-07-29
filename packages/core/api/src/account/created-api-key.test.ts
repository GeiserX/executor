// ---------------------------------------------------------------------------
// The one-time API key crosses the account API as `Redacted` on both sides.
//
// This is a WRITE path in the sense that matters: the server ENCODES the
// secret into the response body. `Redacted`'s toString/toJSON render the
// literal "<redacted>", so a regression to `Schema.String` on the provider side
// would not throw — it would ship that literal to the console, and the user
// would only find out when the key they copied failed to authenticate. So the
// assertion is on the encoded bytes, not just on the wrapper type.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";

import { CreatedApiKeyResponse } from "./api";

// Synthetic, and asserted by exact match, so "<redacted>" cannot pass for it.
const KEY_SECRET = "synthetic-one-time-key";

const summary = {
  id: "api_key_123",
  name: "Local CLI",
  obfuscatedValue: "exk_...1234",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
};

describe("CreatedApiKeyResponse", () => {
  it.effect("encodes the real secret into the response body", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeUnknownEffect(CreatedApiKeyResponse)({
        ...summary,
        value: Redacted.make(KEY_SECRET),
      });

      // The bytes on the wire are the key itself — the failure a missed unwrap
      // on this path produces is the literal "<redacted>" reaching the console.
      expect(encoded.value).toBe(KEY_SECRET);
      expect(encoded.obfuscatedValue).toBe(summary.obfuscatedValue);
    }),
  );

  it.effect("decodes the body back into Redacted, so serializing it exposes nothing", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(CreatedApiKeyResponse)({
        ...summary,
        value: KEY_SECRET,
      });

      expect(Redacted.isRedacted(decoded.value)).toBe(true);

      // What a log line, a span attribute, or an error payload would produce.
      const serialized = JSON.stringify(decoded);
      expect(serialized).not.toContain(KEY_SECRET);
      expect(serialized).toContain("<redacted>");

      // …and the wrapper still holds the real key, so the check above is
      // redaction rather than a dropped value.
      expect(Redacted.value(decoded.value)).toBe(KEY_SECRET);
    }),
  );
});
