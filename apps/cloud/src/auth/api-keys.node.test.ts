import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { ApiKeyService } from "./api-keys";
import { WorkOSClient, type WorkOSClientService } from "./workos";

// Synthetic, and asserted by exact match, so `Redacted`'s "<redacted>"
// rendering cannot pass for the real key.
const CREATED_SECRET = "synthetic-created-key";

const stubWorkOS = (overrides: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop in overrides) return overrides[prop as keyof WorkOSClientService];
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const validate = (response: unknown) =>
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeyService;
    return yield* apiKeys.validate(Redacted.make("synthetic-inbound-key"));
  }).pipe(
    Effect.provide(
      ApiKeyService.WorkOS.pipe(
        Layer.provide(stubWorkOS({ validateApiKey: () => Effect.succeed(response) })),
      ),
    ),
  );

describe("ApiKeyService.WorkOS", () => {
  it.effect("accepts user-owned keys with camel-case organization id", () =>
    Effect.gen(function* () {
      const principal = yield* validate({
        apiKey: {
          id: "api_key_123",
          owner: {
            type: "user",
            id: "user_123",
            organizationId: "org_123",
          },
        },
      });

      expect(principal).toEqual({
        accountId: "user_123",
        organizationId: "org_123",
        keyId: "api_key_123",
      });
    }),
  );

  it.effect("accepts user-owned keys with snake-case organization id", () =>
    Effect.gen(function* () {
      const principal = yield* validate({
        apiKey: {
          id: "api_key_456",
          owner: {
            type: "user",
            id: "user_456",
            organization_id: "org_456",
          },
        },
      });

      expect(principal?.organizationId).toBe("org_456");
    }),
  );

  it.effect("rejects missing, organization-owned, and org-less keys", () =>
    Effect.gen(function* () {
      const missing = yield* validate({ apiKey: null });
      const orgOwned = yield* validate({
        apiKey: {
          id: "api_key_org",
          owner: { type: "organization", id: "org_123" },
        },
      });
      const orgLess = yield* validate({
        apiKey: {
          id: "api_key_no_org",
          owner: { type: "user", id: "user_123" },
        },
      });

      expect(missing).toBeNull();
      expect(orgOwned).toBeNull();
      expect(orgLess).toBeNull();
    }),
  );

  it.effect("lists and creates user-owned keys", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const apiKeys = yield* ApiKeyService;
        const listed = yield* apiKeys.listUserKeys({
          accountId: "user_123",
          organizationId: "org_123",
        });
        const created = yield* apiKeys.createUserKey({
          accountId: "user_123",
          organizationId: "org_123",
          name: "Local CLI",
        });
        return { listed, created };
      }).pipe(
        Effect.provide(
          ApiKeyService.WorkOS.pipe(
            Layer.provide(
              stubWorkOS({
                listUserApiKeys: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        id: "api_key_listed",
                        name: "Listed",
                        obfuscated_value: "sk_...1234",
                        created_at: "2026-01-01T00:00:00.000Z",
                        updated_at: "2026-01-01T00:00:00.000Z",
                        last_used_at: null,
                        owner: {
                          type: "user",
                          id: "user_123",
                          organization_id: "org_123",
                        },
                      },
                    ],
                    listMetadata: {
                      before: null,
                      after: null,
                    },
                  }),
                createUserApiKey: () =>
                  Effect.succeed({
                    id: "api_key_created",
                    name: "Local CLI",
                    value: CREATED_SECRET,
                    obfuscated_value: "sk_...ated",
                    created_at: "2026-01-01T00:00:00.000Z",
                    updated_at: "2026-01-01T00:00:00.000Z",
                    last_used_at: null,
                    owner: {
                      type: "user",
                      id: "user_123",
                      organization_id: "org_123",
                    },
                  }),
              }),
            ),
          ),
        ),
      );

      const result = yield* program;
      expect(result.listed).toEqual([
        {
          id: "api_key_listed",
          name: "Listed",
          obfuscatedValue: "sk_...1234",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: null,
        },
      ]);
      // The created secret is `Redacted` from the decode onward, and still
      // holds the real bytes — WorkOS returns it exactly once, so a wrapper
      // that lost the value would be indistinguishable from a working one until
      // a customer tried the key.
      expect(Redacted.isRedacted(result.created.value)).toBe(true);
      expect(Redacted.value(result.created.value)).toBe(CREATED_SECRET);

      // What a log line or a span attribute would produce for the whole record.
      const serialized = JSON.stringify(result.created);
      expect(serialized).not.toContain(CREATED_SECRET);
      expect(serialized).toContain("<redacted>");
    }),
  );

  it.effect("hands WorkOS the caller's real key when validating", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const owner = yield* Effect.gen(function* () {
        const apiKeys = yield* ApiKeyService;
        return yield* apiKeys.validate(Redacted.make("synthetic-inbound-key"));
      }).pipe(
        Effect.provide(
          ApiKeyService.WorkOS.pipe(
            Layer.provide(
              stubWorkOS({
                validateApiKey: (value) => {
                  seen.push(Redacted.value(value));
                  return Effect.succeed({
                    apiKey: {
                      id: "api_key_123",
                      owner: { type: "user", id: "user_123", organizationId: "org_123" },
                    },
                  });
                },
              }),
            ),
          ),
        ),
      );

      // The unwrap at the WorkOS boundary is deliberate: the control plane can
      // only answer for the caller's actual key, not for "<redacted>".
      expect(seen).toEqual(["synthetic-inbound-key"]);
      expect(owner?.accountId).toBe("user_123");
    }),
  );
});
