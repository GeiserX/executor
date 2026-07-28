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

/**
 * `AdminSubject` → the public `AdminUser` shape.
 *
 * `createdAt` crosses the wire as epoch ms (the SDK hands back a `Date`), which
 * matches how every other "when did this happen" field on the API is carried
 * and keeps the whole response JSON-native.
 */
const toUser = (subject: AdminSubject) => ({
  externalId: subject.externalId,
  createdAt: subject.createdAt.getTime(),
  lastSeenAt: subject.lastSeenAt,
  status: subject.status,
});

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

const toUserWithConnections = (subject: AdminSubjectWithConnections) => ({
  ...toUser(subject),
  connections: subject.connections.map(toConnection),
});

export const listUsers = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
): Effect.Effect<typeof AdminUsersResponse.Type, AdminUsersError> =>
  admin.listSubjects(options).pipe(
    Effect.map((subjects) => ({ users: subjects.map(toUser) })),
    Effect.mapError(readFailed("users")),
  );

export const listUsersWithConnections = (
  admin: ExecutorAdmin,
  options: AdminUsersListOptions,
): Effect.Effect<typeof AdminUsersWithConnectionsResponse.Type, AdminUsersError> =>
  admin.listSubjectsWithConnections(options).pipe(
    Effect.map((subjects) => ({ users: subjects.map(toUserWithConnections) })),
    Effect.mapError(readFailed("users")),
  );

export const listUserConnections = (
  admin: ExecutorAdmin,
  externalId: string,
): Effect.Effect<typeof AdminUserConnectionsResponse.Type, AdminUsersError> =>
  admin.listSubjectConnections(externalId).pipe(
    Effect.map((connections) => ({ connections: connections.map(toConnection) })),
    Effect.mapError(readFailed("connections")),
  );
