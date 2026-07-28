// ---------------------------------------------------------------------------
// The READ half of the admin users surface, shared by every host.
//
// A host's `AdminUsersProvider` owns AUTHORIZATION (who may look) and delegates
// the actual reads here, so the projection from the SDK's platform view onto
// the wire shapes exists exactly ONCE. That matters because the projection IS
// the field-discipline boundary: if each host mapped rows itself, a credential
// field could leak into one host's responses and not the other's.
//
// Every mapping below is explicit rather than a spread. A spread would silently
// forward any field a future SDK change adds to `AdminSubject`/`AdminConnection`
// — the opposite of an allowlist.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type {
  AdminConnection,
  AdminSubject,
  AdminSubjectWithConnections,
  Executor,
  ExecutorAdmin,
} from "@executor-js/sdk";

import {
  AdminUsersError,
  type AdminUserConnectionsResponse,
  type AdminUsersResponse,
  type AdminUsersWithConnectionsResponse,
} from "./api";
import type { AdminUsersListOptions } from "./service";

/**
 * Narrow an executor to its platform view. `admin` is present only when the
 * executor was built with `platformView: true`; a host that reaches these reads
 * with a product-view executor is a wiring bug, so it fails loudly as a 500
 * rather than silently returning an empty tenant (which would read as "this
 * owner has no users").
 */
export const platformViewOf = (executor: Executor): Effect.Effect<ExecutorAdmin, AdminUsersError> =>
  executor.admin
    ? Effect.succeed(executor.admin)
    : Effect.fail(
        new AdminUsersError({
          message: "Admin reads require an executor built with the platform view enabled",
        }),
      );

// Storage faults are the only failure these reads can raise. They surface as a
// 500 with a flat message — the cause carries the detail into the host's error
// capture, and is deliberately not echoed to an API consumer.
const readFailed = (what: string) => () =>
  new AdminUsersError({ message: `Failed to list ${what}` });

// ---------------------------------------------------------------------------
// Host identity join
// ---------------------------------------------------------------------------

/** What a host's member directory can say about one principal. Both halves are
 *  independently nullable: a directory can hold an email with no name. */
export interface AdminUserIdentity {
  readonly email: string | null;
  readonly displayName: string | null;
}

/**
 * A host's member directory, keyed by the SAME id space the subject table
 * records in `external_id`.
 *
 * That id is the host-auth principal id — cloud binds the WorkOS `user_...`,
 * self-host binds the Better Auth `user.id` — so the join key on both hosts is
 * the member list's `userId`, NEVER its `id` (a membership-row id: `om_...` on
 * cloud, the `member` row on self-host, both of which join to nothing).
 *
 * Called ONCE per request with the whole page of ids, so a host implements it
 * as one directory read joined in memory rather than a lookup per user. A host
 * that cannot resolve identities at all simply passes no directory, and every
 * row reports absent identity.
 */
export type AdminIdentityDirectory = (
  externalIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, AdminUserIdentity>, unknown>;

/** Identity is decoration on an operator view, not part of the answer: a
 *  directory outage must degrade to unnamed rows, never fail the read the
 *  operator actually asked for. Logged once per failed page — the cause carries
 *  the detail, and the caller learns nothing from it. */
const resolveIdentities = (
  directory: AdminIdentityDirectory | undefined,
  externalIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, AdminUserIdentity>> => {
  if (!directory || externalIds.length === 0) return Effect.succeed(new Map());
  return directory(externalIds).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("admin users: host identity lookup failed; reporting users unnamed", {
          cause,
        }),
        new Map<string, AdminUserIdentity>(),
      ),
    ),
  );
};

const ABSENT_IDENTITY: AdminUserIdentity = { email: null, displayName: null };

/**
 * `AdminSubject` → the public `AdminUser` shape.
 *
 * `createdAt` crosses the wire as epoch ms (the SDK hands back a `Date`), which
 * matches how every other "when did this happen" field on the API is carried
 * and keeps the whole response JSON-native.
 *
 * `email`/`displayName` come from the host directory rather than storage, so an
 * id the directory doesn't know — a member who left the org while their
 * connections remain, or a host sentinel like "local" that names no member —
 * reports absent identity beside otherwise complete row data.
 */
const toUser = (subject: AdminSubject, identities: ReadonlyMap<string, AdminUserIdentity>) => {
  const identity = identities.get(subject.externalId) ?? ABSENT_IDENTITY;
  return {
    externalId: subject.externalId,
    createdAt: subject.createdAt.getTime(),
    lastSeenAt: subject.lastSeenAt,
    status: subject.status,
    email: identity.email,
    displayName: identity.displayName,
  };
};

/**
 * `AdminConnection` → the public `AdminUserConnection` shape.
 *
 * `subject` is dropped: on `/admin/users/:externalId/connections` it is the
 * path parameter, and on the joined view it is the enclosing user's own id, so
 * carrying it would be redundant on both. Everything kept here is either an
 * identifier or a health/access summary — never credential material.
 */
const toConnection = (connection: AdminConnection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
  oauthScope: connection.oauthScope,
  lastHealth: connection.lastHealth,
});

const toUserWithConnections = (
  subject: AdminSubjectWithConnections,
  identities: ReadonlyMap<string, AdminUserIdentity>,
) => ({
  ...toUser(subject, identities),
  connections: subject.connections.map(toConnection),
});

export const listUsers = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
  directory?: AdminIdentityDirectory,
): Effect.Effect<typeof AdminUsersResponse.Type, AdminUsersError> =>
  admin.listSubjects(options).pipe(
    Effect.mapError(readFailed("users")),
    // One directory read for the page that was actually returned, joined in
    // memory — never a lookup per user.
    Effect.flatMap((subjects) =>
      resolveIdentities(
        directory,
        subjects.map((subject) => subject.externalId),
      ).pipe(
        Effect.map((identities) => ({
          users: subjects.map((subject) => toUser(subject, identities)),
        })),
      ),
    ),
  );

export const listUsersWithConnections = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
  directory?: AdminIdentityDirectory,
): Effect.Effect<typeof AdminUsersWithConnectionsResponse.Type, AdminUsersError> =>
  admin.listSubjectsWithConnections(options).pipe(
    Effect.mapError(readFailed("users")),
    Effect.flatMap((subjects) =>
      resolveIdentities(
        directory,
        subjects.map((subject) => subject.externalId),
      ).pipe(
        Effect.map((identities) => ({
          users: subjects.map((subject) => toUserWithConnections(subject, identities)),
        })),
      ),
    ),
  );

export const listUserConnections = (
  admin: ExecutorAdmin,
  externalId: string,
): Effect.Effect<typeof AdminUserConnectionsResponse.Type, AdminUsersError> =>
  admin.listSubjectConnections(externalId).pipe(
    Effect.map((connections) => ({ connections: connections.map(toConnection) })),
    Effect.mapError(readFailed("connections")),
  );
