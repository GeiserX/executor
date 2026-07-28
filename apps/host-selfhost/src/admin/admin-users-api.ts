// ---------------------------------------------------------------------------
// Self-host admin users API — the shared, provider-neutral `AdminUsersHandlers`
// backed by a Better-Auth-authorized platform view, mounted at
// `/api/admin/users*` beside the existing invite-code admin routes.
//
// AUTH: an owner/admin member of the single org, resolved through the org
// primitive's `getActiveMember` — the SAME gate the invite-code admin API uses
// (`admin/handlers.ts`), not a new permission concept. Self-host has no
// organization-OWNED api key (Better Auth keys always belong to the user who
// created one), so there is no machine-credential path here; the operator's own
// admin session is the credential. That asymmetry with cloud is deliberate and
// is why `AdminUsersProvider` is a seam rather than one shared implementation.
//
// The READ half is identical to cloud's: a subject-less, tenant-reach executor
// from `makePlatformExecutor`, projected by the shared `admin/reads`. Self-host
// is single-tenant, so the tenant is always the boot-seeded org.
// ---------------------------------------------------------------------------

import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AdminUsersProvider,
  DbProvider,
  HostConfig,
  PluginsProvider,
  listAdminUserConnections,
  listAdminUsers,
  listAdminUsersWithConnections,
  makeAdminUsersApiLayer,
  makePlatformExecutor,
  platformViewOf,
  requestScopedMiddleware,
  type AdminUsersHeaders,
} from "@executor-js/api/server";
import { AdminUsersError, AdminUsersForbidden, AdminUsersUnauthorized } from "@executor-js/api";
import type { Executor } from "@executor-js/sdk";

import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { SelfHostDb, SelfHostDbProvider, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostHostConfig, SelfHostPluginsProvider } from "../execution";

/**
 * The same owner/admin gate the invite-code admin API applies. A plain member
 * session is refused: this plane reports every user in the instance.
 */
const requireAdmin = (headers: AdminUsersHeaders) =>
  Effect.gen(function* () {
    const { auth } = yield* BetterAuth;
    const member = yield* Effect.tryPromise({
      try: () => auth.api.getActiveMember({ headers: new Headers(headers) }),
      catch: () => new AdminUsersError({ message: "Failed to resolve session" }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (!member) return yield* new AdminUsersUnauthorized();
    if (member.role !== "owner" && member.role !== "admin") return yield* new AdminUsersForbidden();
    return member;
  });

const withPlatformView = <A>(
  headers: AdminUsersHeaders,
  organizationId: string,
  body: (executor: Executor) => Effect.Effect<A, AdminUsersError>,
): Effect.Effect<
  A,
  AdminUsersError | AdminUsersUnauthorized | AdminUsersForbidden,
  BetterAuth | DbProvider | PluginsProvider | HostConfig
> =>
  Effect.gen(function* () {
    yield* requireAdmin(headers);
    const executor = yield* makePlatformExecutor(organizationId).pipe(
      Effect.mapError(() => new AdminUsersError({ message: "Failed to open the platform view" })),
    );
    return yield* Effect.ensuring(body(executor), executor.close().pipe(Effect.ignore));
  });

export const betterAuthAdminUsersProvider: Layer.Layer<
  AdminUsersProvider,
  never,
  BetterAuth | DbProvider | PluginsProvider | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<BetterAuth | DbProvider | PluginsProvider | HostConfig>();
    const { organizationId } = yield* BetterAuth;
    return AdminUsersProvider.of({
      listUsers: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(Effect.flatMap((admin) => listAdminUsers(admin, options))),
        ).pipe(Effect.provideContext(context)),
      listUsersWithConnections: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUsersWithConnections(admin, options)),
          ),
        ).pipe(Effect.provideContext(context)),
      listUserConnections: (headers, externalId) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUserConnections(admin, externalId)),
          ),
        ).pipe(Effect.provideContext(context)),
    });
  }),
);

export interface SelfHostAdminUsersApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}

/**
 * The mountable extension route layer for `/api/admin/users*`. Self-host's DB
 * handle and Better Auth are app singletons, so the provider is self-contained
 * (no per-request socket to close over, unlike cloud) — but it still goes
 * through `requestScopedMiddleware`, because an HttpApi handler's service
 * requirement is not erased by a plain `Layer.provide` on the builder layer.
 */
export const makeSelfHostAdminUsersApiLayer = ({
  betterAuth,
  db,
  mountPrefix,
}: SelfHostAdminUsersApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  const provider = betterAuthAdminUsersProvider.pipe(
    Layer.provide(Layer.succeed(BetterAuth)(betterAuth)),
    Layer.provide(SelfHostDbProvider),
    Layer.provide(SelfHostPluginsProvider),
    Layer.provide(SelfHostHostConfig),
    Layer.provide(Layer.succeed(SelfHostDb)(db)),
  );
  return makeAdminUsersApiLayer(requestScopedMiddleware(provider).layer, {
    router: prefixedRouter,
  });
};
