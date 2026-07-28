// ---------------------------------------------------------------------------
// Admin Users HTTP API — the public, tenant-wide operator surface.
//
// The product plane (`/api/*`) answers "what can I, this member, reach". This
// one answers the OWNER's question: "who are my users, and what have they
// connected". It reads the SDK's platform view (`executor.admin`, opt-in via
// `platformView: true`), which is read-only by construction — the owner policy
// rejects writes at `reach: "tenant"` — so every endpoint here is a GET.
//
// VOCABULARY: this is the translation seam. Internal code says subject / tenant
// / reach; everything public-facing says users / owners. `AdminSubject
// .externalId` becomes `externalId` on a `users` collection, and nothing below
// leaks the word "subject".
//
// FIELD DISCIPLINE: the response shapes are 1:1 with the SDK's hand-picked
// admin allowlist (`AdminSubject` / `AdminConnection`), NOT a projection of the
// underlying rows. No credential material of any kind may appear — no item ids,
// no refresh ids, no oauth client secrets, no tokens. `oauthScope` is a summary
// of ACCESS (which scopes were granted), never a token. Adding a field here is
// a deliberate act that has to be argued against `platform-view.test.ts`'s
// forbidden-field list.
//
// Auth is applied by each host's own admin middleware (cloud: an org-scoped API
// key or an admin session member; self-host: a Better Auth owner/admin member),
// so this contract carries no provider-specific auth scheme — the same shape
// the Account API uses.
// ---------------------------------------------------------------------------

import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { ConnectionName, HealthCheckResult, IntegrationSlug, Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdminUsersError extends Schema.TaggedErrorClass<AdminUsersError>()(
  "AdminUsersError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AdminUsersUnauthorized extends Schema.TaggedErrorClass<AdminUsersUnauthorized>()(
  "AdminUsersUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AdminUsersForbidden extends Schema.TaggedErrorClass<AdminUsersForbidden>()(
  "AdminUsersForbidden",
  {},
  { httpApiStatus: 403 },
) {}

// ---------------------------------------------------------------------------
// Response schemas — the public projection of the SDK's admin shapes.
// ---------------------------------------------------------------------------

/**
 * One user of the tenant. Mirrors `AdminSubject` with the public vocabulary.
 *
 * `lastSeenAt` is epoch ms of the last sighting on the request path, and is
 * deliberately COARSE: the writer (`touchSubject`) only rewrites it past a
 * throttle interval (1 hour by default), so treat it as "active around then",
 * never as a precise last-activity timestamp. `null` means never seen on a
 * request — a user can earn a row at connection-create before any sighting.
 */
export const AdminUser = Schema.Struct({
  /** The host-auth principal id (cloud: the WorkOS user id). Opaque — it also
   *  carries host sentinels like "local", so nothing may parse it. */
  externalId: Schema.String,
  /** Epoch ms the user was first recorded under this tenant. */
  createdAt: Schema.Number,
  lastSeenAt: Schema.NullOr(Schema.Number),
  /** User lifecycle. Unconstrained until the lifecycle values are defined;
   *  `null` means no state recorded (which is every row today). */
  status: Schema.NullOr(Schema.String),
  /**
   * The host's email for this principal, joined server-side from the host's own
   * member directory (cloud: WorkOS; self-host: Better Auth). `null` whenever
   * the host cannot resolve the id — the member left the org while their
   * connections remain, the directory read failed, or the id is a host sentinel
   * like "local" that names no member at all.
   *
   * NOT credential material and not part of the storage projection: it is a
   * directory lookup keyed by `externalId`, which is why it can be absent on a
   * row whose other fields are complete. Nothing may treat its presence as an
   * authorization signal.
   */
  email: Schema.NullOr(Schema.String),
  /** The host's human name for this principal (cloud: given + family name;
   *  self-host: the Better Auth `name`). `null` on the same terms as `email`,
   *  and independently — a directory can hold one without the other. */
  displayName: Schema.NullOr(Schema.String),
});

/**
 * A connection as the platform view sees it: enough to answer "what has this
 * user connected, and is it healthy", and nothing that could resolve a
 * credential. Mirrors `AdminConnection`.
 */
export const AdminUserConnection = Schema.Struct({
  owner: Owner,
  integration: IntegrationSlug,
  name: ConnectionName,
  /** The scope set the provider actually granted, space-delimited as recorded
   *  at connect/refresh. Null for static credentials. A summary of ACCESS —
   *  never a token. */
  oauthScope: Schema.NullOr(Schema.String),
  lastHealth: Schema.NullOr(HealthCheckResult),
});

/** A user joined with every connection they own in the tenant. */
export const AdminUserWithConnections = Schema.Struct({
  ...AdminUser.fields,
  connections: Schema.Array(AdminUserConnection),
});

export const AdminUsersResponse = Schema.Struct({
  users: Schema.Array(AdminUser),
});

export const AdminUserConnectionsResponse = Schema.Struct({
  connections: Schema.Array(AdminUserConnection),
});

export const AdminUsersWithConnectionsResponse = Schema.Struct({
  users: Schema.Array(AdminUserWithConnections),
});

// ---------------------------------------------------------------------------
// Params / query
// ---------------------------------------------------------------------------

const AdminUserParams = { externalId: Schema.String };

// Paging, mirroring `AdminListSubjectsOptions`. Query params arrive as strings,
// so decode them here rather than making every handler interpret raw strings —
// an out-of-range or non-numeric value is a 400 from the contract, not a
// silently-ignored filter. The joined endpoint reads per-user connections, so
// its page size is bounded harder than the flat list's.
const AdminListQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  ),
  offset: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

/**
 * The admin users group, mounted at `/admin/*` by each host.
 *
 * The joined view is its OWN path (`/admin/users/with-connections`) rather than
 * an `?include=connections` flag on `/admin/users`, because the two return
 * different row shapes. A query flag that changes the response schema can't be
 * expressed as one typed endpoint — the repo's list endpoints use query params
 * only to FILTER a fixed shape (`/tools`, `/connections`), never to switch it.
 * It sorts before `/admin/users/:externalId/...` in the router either way, and
 * "with-connections" is not a valid opaque principal id.
 */
export const AdminUsersApi = HttpApiGroup.make("adminUsers")
  .add(
    HttpApiEndpoint.get("listUsers", "/admin/users", {
      query: AdminListQuery,
      success: AdminUsersResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUsersWithConnections", "/admin/users/with-connections", {
      query: AdminListQuery,
      success: AdminUsersWithConnectionsResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUserConnections", "/admin/users/:externalId/connections", {
      params: AdminUserParams,
      success: AdminUserConnectionsResponse,
      error: [AdminUsersError, AdminUsersUnauthorized, AdminUsersForbidden],
    }),
  );

/**
 * Standalone HttpApi wrapping just the admin users group. Hosts mount THIS as
 * an extension route (like the account API) rather than adding the group to
 * `CoreExecutorApi`: the core API is served behind the execution-stack
 * middleware, which binds a product-view executor to one acting subject. The
 * admin plane needs the opposite (no subject, tenant reach), so it gets its own
 * mount and its own per-host auth.
 */
export const AdminUsersHttpApi = HttpApi.make("executor-admin-users").add(AdminUsersApi);
