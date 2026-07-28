import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { ApiKeyManagementError } from "./errors";
import { WorkOSClient } from "./workos";

/**
 * Which view a validated key resolves to.
 *   - `"user"` — the product view. The key belongs to a member; the request
 *     binds to that member as the acting subject. Every key today is this.
 *   - `"org"` — the PLATFORM view. The key belongs to the organization itself,
 *     so there is no acting member: the request gets tenant-wide READ-ONLY
 *     reach and no bound subject. Privileged; minted separately (PR 1.5).
 */
export type ApiKeyScope = "user" | "org";

/** The owner an api key resolves to — NOT a full {@link Principal} (no email /
 * name / roles), so it carries an honest, distinct name. */
export type ApiKeyOwner = {
  readonly scope: ApiKeyScope;
  /** The acting member for a `"user"` key; `null` for an `"org"` key, which
   *  has no member behind it. Nullable rather than a sentinel so nothing can
   *  accidentally bind an org key to a subject. */
  readonly accountId: string | null;
  readonly organizationId: string;
  readonly keyId: string;
};

export type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
};

export type CreatedApiKey = ApiKeySummary & {
  readonly value: string;
};

export class ApiKeyValidationError extends Data.TaggedError("ApiKeyValidationError")<{
  readonly cause: unknown;
}> {}

// WorkOS keys are owned by either a user or an organization. The user shape
// carries the member id in `id` and the org in `organization_id`; the org shape
// carries the ORG in `id` and no member at all. Both decode here — the
// distinction is a branch (`ownerFromApiKey`), not a decode failure, so an
// org-owned key is no longer indistinguishable from an invalid one.
const UserApiKeyOwner = Schema.Struct({
  type: Schema.Literal("user"),
  id: Schema.String,
  organizationId: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
});

const OrgApiKeyOwner = Schema.Struct({
  type: Schema.Literal("organization"),
  id: Schema.String,
});

const WorkOSApiKeyOwner = Schema.Union([UserApiKeyOwner, OrgApiKeyOwner]);

const ApiKey = Schema.Struct({
  id: Schema.String,
  owner: UserApiKeyOwner,
  name: Schema.optional(Schema.String),
  obfuscatedValue: Schema.optional(Schema.String),
  obfuscated_value: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  last_used_at: Schema.optional(Schema.NullOr(Schema.String)),
});

// Validation accepts BOTH owner shapes. The list/create paths below stay
// user-only on purpose: they are the console's personal-key CRUD, and minting
// org keys is a separate, privileged surface (PR 1.5).
const ValidatedApiKey = Schema.Struct({
  id: Schema.String,
  owner: WorkOSApiKeyOwner,
});

const ValidateApiKeyResponse = Schema.Struct({
  apiKey: Schema.NullOr(ValidatedApiKey),
});

const RawCreatedApiKey = Schema.Struct({
  id: Schema.String,
  owner: UserApiKeyOwner,
  name: Schema.optional(Schema.String),
  obfuscatedValue: Schema.optional(Schema.String),
  obfuscated_value: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  last_used_at: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.String,
});

const ListApiKeysResponse = Schema.Struct({
  data: Schema.Array(ApiKey),
});

const CreateApiKeyResponse = Schema.Union([
  RawCreatedApiKey,
  Schema.Struct({ apiKey: RawCreatedApiKey }),
  Schema.Struct({ api_key: RawCreatedApiKey }),
]);

const decodeValidateApiKeyResponse = Schema.decodeUnknownOption(ValidateApiKeyResponse);
const decodeListApiKeysResponse = Schema.decodeUnknownOption(ListApiKeysResponse);
const decodeCreateApiKeyResponse = Schema.decodeUnknownOption(CreateApiKeyResponse);

const ownerFromApiKey = (apiKey: typeof ValidatedApiKey.Type): ApiKeyOwner | null => {
  if (apiKey.owner.type === "organization") {
    // An org-owned key IS the org: `owner.id` is the organization, and there
    // is no member to act as. This resolves to the platform view.
    return {
      scope: "org",
      accountId: null,
      organizationId: apiKey.owner.id,
      keyId: apiKey.id,
    };
  }
  const organizationId = apiKey.owner.organizationId ?? apiKey.owner.organization_id;
  if (!organizationId) return null;
  return {
    scope: "user",
    accountId: apiKey.owner.id,
    organizationId,
    keyId: apiKey.id,
  };
};

const ownerFromResponse = (value: unknown): ApiKeyOwner | null =>
  Option.match(decodeValidateApiKeyResponse(value), {
    onNone: () => null,
    onSome: ({ apiKey }) => (apiKey ? ownerFromApiKey(apiKey) : null),
  });

const summaryFromApiKey = (apiKey: typeof ApiKey.Type): ApiKeySummary | null => {
  const organizationId = apiKey.owner.organizationId ?? apiKey.owner.organization_id;
  if (!organizationId) return null;
  return {
    id: apiKey.id,
    name: apiKey.name ?? "API key",
    obfuscatedValue: apiKey.obfuscatedValue ?? apiKey.obfuscated_value ?? "",
    createdAt: apiKey.createdAt ?? apiKey.created_at ?? "",
    updatedAt: apiKey.updatedAt ?? apiKey.updated_at ?? "",
    lastUsedAt: apiKey.lastUsedAt ?? apiKey.last_used_at ?? null,
  };
};

const listFromResponse = (value: unknown): readonly ApiKeySummary[] =>
  Option.match(decodeListApiKeysResponse(value), {
    onNone: () => [],
    onSome: ({ data }) =>
      data.flatMap((apiKey) => {
        const summary = summaryFromApiKey(apiKey);
        return summary ? [summary] : [];
      }),
  });

const createdFromResponse = (value: unknown): CreatedApiKey | null =>
  Option.match(decodeCreateApiKeyResponse(value), {
    onNone: () => null,
    onSome: (response) => {
      const apiKey =
        "value" in response ? response : "apiKey" in response ? response.apiKey : response.api_key;
      const summary = summaryFromApiKey(apiKey);
      return summary ? { ...summary, value: apiKey.value } : null;
    },
  });

export class ApiKeyService extends Context.Service<
  ApiKeyService,
  {
    readonly validate: (value: string) => Effect.Effect<ApiKeyOwner | null, ApiKeyValidationError>;
    readonly listUserKeys: (input: {
      readonly accountId: string;
      readonly organizationId: string;
    }) => Effect.Effect<readonly ApiKeySummary[], ApiKeyManagementError>;
    readonly createUserKey: (input: {
      readonly accountId: string;
      readonly organizationId: string;
      readonly name: string;
    }) => Effect.Effect<CreatedApiKey, ApiKeyManagementError>;
    readonly revokeUserKey: (input: {
      readonly keyId: string;
    }) => Effect.Effect<void, ApiKeyManagementError>;
  }
>()("@executor-js/cloud/ApiKeyService") {
  static WorkOS = Layer.effect(this)(
    Effect.gen(function* () {
      const workos = yield* WorkOSClient;
      return {
        validate: (value: string) =>
          workos.validateApiKey(value).pipe(
            Effect.map(ownerFromResponse),
            Effect.mapError((cause) => new ApiKeyValidationError({ cause })),
          ),
        listUserKeys: ({ accountId, organizationId }) =>
          workos.listUserApiKeys(accountId, organizationId).pipe(
            Effect.map(listFromResponse),
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
          ),
        createUserKey: ({ accountId, organizationId, name }) =>
          workos.createUserApiKey({ userId: accountId, organizationId, name }).pipe(
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
            Effect.flatMap((response) => {
              const created = createdFromResponse(response);
              return created
                ? Effect.succeed(created)
                : Effect.fail(new ApiKeyManagementError({ cause: "invalid_create_response" }));
            }),
          ),
        revokeUserKey: ({ keyId }) =>
          workos
            .deleteApiKey(keyId)
            .pipe(Effect.mapError((cause) => new ApiKeyManagementError({ cause }))),
      };
    }),
  );
}
