import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { resolveProtectedPrincipal } from "./protected";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

// Records every key the resolver hands the service, so the test can assert the
// bytes that crossed the seam rather than only the principal that came back.
const seenKeys: string[] = [];

const stubApiKeys = Layer.succeed(ApiKeyService)({
  validate: (value: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      const key = Redacted.value(value);
      seenKeys.push(key);
      return key === "valid_user_key"
        ? {
            accountId: "user_123",
            organizationId: "org_123",
            keyId: "api_key_123",
          }
        : null;
    }),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.die("protected API auth test does not create API keys"),
  revokeUserKey: () => Effect.void,
});

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      if (prop === "listUserMemberships") {
        return (userId: string) =>
          Effect.succeed({
            data:
              userId === "user_123"
                ? [{ userId, organizationId: "org_123", status: "active" }]
                : [],
          });
      }
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

const stubUsers = Layer.succeed(UserStoreService)({
  use: (fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => ({ id, createdAt }),
        getAccount: async (id: string) => ({ id, createdAt }),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: `org-slug-${org.id}`,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: `org-slug-${id}`,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: "org_by_slug",
          name: `Org ${slug}`,
          slug,
          createdAt,
        }),
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

const run = (request: Request) =>
  resolveProtectedPrincipal(request).pipe(
    Effect.provide(Layer.mergeAll(stubApiKeys, stubWorkOS, stubUsers)),
  );

describe("protected API key auth", () => {
  it.effect("resolves a valid bearer API key into protected identity", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;
      const identity = yield* run(
        new Request("https://executor.test/api/tools", {
          headers: { authorization: "Bearer valid_user_key" },
        }),
      );

      // The key the header carried reached the service intact — a `Redacted`
      // that lost its bytes would render "<redacted>" here and reject every
      // caller, and a missed wrap would not be visible in the principal alone.
      expect(seenKeys).toEqual(["valid_user_key"]);

      expect(identity).toEqual({
        accountId: "user_123",
        organizationId: "org_123",
        organizationName: "Org org_123",
        organizationSlug: "org-slug-org_123",
        email: "",
        name: null,
        avatarUrl: null,
        roles: [],
      });
    }),
  );

  it.effect("rejects invalid bearer API keys", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(
          new Request("https://executor.test/api/tools", {
            headers: { authorization: "Bearer invalid_user_key" },
          }),
        ),
      );

      // The resolver now raises the SHARED `Unauthorized` carrying the same
      // machine code; cloud's failure strategy renders it as the byte-identical
      // 401 `{ error: "Invalid API key", code: "invalid_api_key" }`.
      expect(error).toMatchObject({
        _tag: "Unauthorized",
        code: "invalid_api_key",
        message: "Invalid API key",
      });
    }),
  );

  it.effect("keeps the header-shape rejections distinct and never validates them", () =>
    Effect.gen(function* () {
      seenKeys.length = 0;

      // A non-Bearer scheme and an empty Bearer token are separate machine
      // codes; neither is a credential, so neither reaches the service.
      const notBearer = yield* Effect.flip(
        run(
          new Request("https://executor.test/api/tools", {
            headers: { authorization: "Basic valid_user_key" },
          }),
        ),
      );
      expect(notBearer).toMatchObject({
        _tag: "Unauthorized",
        code: "invalid_authorization_header",
      });

      // `Headers` strips trailing ASCII whitespace, so `"Bearer "` would arrive
      // as a bare `"Bearer"` and read as NotBearer. A non-breaking space
      // survives normalization and is what reaches the empty-token branch.
      const empty = yield* Effect.flip(
        run(
          new Request("https://executor.test/api/tools", {
            headers: { authorization: `Bearer ${String.fromCharCode(0xa0)}` },
          }),
        ),
      );
      expect(empty).toMatchObject({ _tag: "Unauthorized", code: "invalid_api_key" });

      expect(seenKeys).toEqual([]);
    }),
  );
});
