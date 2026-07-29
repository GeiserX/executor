// ---------------------------------------------------------------------------
// The MCP edge's bearer dispatch, over the shared slice helper.
//
// The api-key branch is what this covers: it is the one that hands a caller's
// credential to the WorkOS control plane, so the bytes crossing that seam are
// the assertion. The JWT branch verifies against the module-scope remote JWKS
// and is covered by `mcp-auth.node.test.ts` at the verifier itself.
//
// The outcome stamping is asserted only by its absence of change — this plane
// stamps enumerated outcomes and nothing derived from the credential.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { ApiKeyService } from "../auth/api-keys";
import { McpAuth, McpAuthLive } from "./auth";

// Synthetic, and asserted by exact match, so "<redacted>" cannot pass for it.
const API_KEY_SECRET = "synthetic-mcp-api-key";

const seenKeys: string[] = [];

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: (value: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      const key = Redacted.value(value);
      seenKeys.push(key);
      return key === API_KEY_SECRET
        ? { accountId: "user_123", organizationId: "org_123", keyId: "api_key_123" }
        : null;
    }),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("MCP bearer test does not create API keys"),
  revokeUserKey: () => Effect.void,
});

const verify = (headers: Record<string, string>) =>
  Effect.gen(function* () {
    const auth = yield* McpAuth;
    return yield* auth.verifyBearer(new Request("https://executor.sh/mcp", { headers }));
  }).pipe(Effect.provide(McpAuthLive.pipe(Layer.provide(stubApiKeys))));

describe("MCP bearer dispatch", () => {
  it.effect("hands the api-key branch the caller's real key", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;
      const result = yield* verify({ authorization: `Bearer ${API_KEY_SECRET}` });

      // A wrapper that lost its bytes would render "<redacted>" here and reject
      // every MCP client, which the authorized result alone would not reveal.
      expect(seenKeys).toEqual([API_KEY_SECRET]);
      expect(result).toEqual({
        _tag: "Authorized",
        token: { accountId: "user_123", organizationId: "org_123" },
      });
    }),
  );

  it.effect("rejects an unknown api key without leaking it into the result", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;
      const result = yield* verify({ authorization: "Bearer synthetic-unknown-key" });

      expect(seenKeys).toEqual(["synthetic-unknown-key"]);
      expect(result).toEqual({
        _tag: "Unauthorized",
        reason: "invalid_token",
        description: "The API key is invalid",
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-unknown-key");
    }),
  );

  it.effect("treats a missing and a non-Bearer header alike, and validates neither", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;
      const missing = yield* verify({});
      const notBearer = yield* verify({ authorization: `Basic ${API_KEY_SECRET}` });

      // The MCP plane accepts no other scheme, so both are the same
      // "no credential" challenge.
      expect(missing).toEqual({ _tag: "Unauthorized", reason: "missing_bearer" });
      expect(notBearer).toEqual({ _tag: "Unauthorized", reason: "missing_bearer" });
      expect(seenKeys).toEqual([]);
    }),
  );

  it.effect("rejects an empty bearer token as invalid rather than missing", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;
      // `Headers` strips trailing ASCII whitespace, so `"Bearer "` would arrive
      // as a bare `"Bearer"`. A non-breaking space survives normalization.
      const result = yield* verify({ authorization: `Bearer ${String.fromCharCode(0xa0)}` });

      expect(result).toEqual({
        _tag: "Unauthorized",
        reason: "invalid_token",
        description: "The bearer token is invalid",
      });
      expect(seenKeys).toEqual([]);
    }),
  );
});
