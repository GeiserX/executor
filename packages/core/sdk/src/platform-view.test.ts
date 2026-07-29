import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectTables, createExecutor, type Executor } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import { Subject, Tenant } from "./ids";
import { resetSubjectTouchCache, touchSubject } from "./subject-registry";

// The platform view: `executor.admin`, an OPT-IN read-only surface that reads
// across every subject in the tenant. Written against the real SQLite bring-up
// so the tenant-reach policy, the bigint `last_seen_at` round-trip, and the
// field allowlist are all live.

const TENANT = "t1";
const OTHER_TENANT = "t2";
const SUBJECT_A = "user_a";
const SUBJECT_B = "user_b";

/** Every column on `connection` that could resolve, or help resolve, a
 *  credential. NONE of these may appear on an admin shape — enumerated so a
 *  future column addition has to be argued with this list. */
const FORBIDDEN_CONNECTION_FIELDS = [
  "item_ids",
  "itemIds",
  "refresh_item_id",
  "refreshItemId",
  "provider",
  "provider_state",
  "providerState",
  "oauth_token_url",
  "oauthTokenUrl",
  "template",
  "client_secret",
  "clientSecret",
  "secret",
  "token",
] as const;

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const insertConnection = (
  db: SqliteTestFumaDb,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly owner: string;
    readonly subject: string;
    readonly integration: string;
    readonly name: string;
    readonly oauthScope?: string | null;
  },
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await db.client.execute({
      sql: `INSERT INTO connection (
          row_id, tenant, owner, subject, integration, name, template, provider,
          item_ids, refresh_item_id, oauth_scope, last_health, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.rowId,
        row.tenant,
        row.owner,
        row.subject,
        row.integration,
        row.name,
        "oauth2",
        "memory",
        // Deliberately secret-bearing: the assertions below prove these never
        // leave the storage layer.
        JSON.stringify({ token: `SECRET-item-${row.rowId}` }),
        `SECRET-refresh-${row.rowId}`,
        row.oauthScope ?? null,
        JSON.stringify({ status: "healthy", checkedAt: 1_700_000_000_000 }),
        Date.now(),
        Date.now(),
      ],
    });
  });

/** Seed two users and an org connection under `t1`, plus an untouchable other
 *  tenant. Subjects go in through `touchSubject` (the only legitimate writer);
 *  connections go in raw, because no single bound executor could have written
 *  another subject's rows. */
const seed = (db: SqliteTestFumaDb): Effect.Effect<void> =>
  Effect.gen(function* () {
    // `touchSubject` keeps a process-local memory of principals it already
    // filed, so a second seed against a FRESH database would be skipped as a
    // repeat sighting and leave the table empty. Each seed is a new world.
    resetSubjectTouchCache();

    yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_A });
    yield* touchSubject(db.db, { tenant: TENANT, externalId: SUBJECT_B });
    yield* touchSubject(db.db, { tenant: OTHER_TENANT, externalId: "user_elsewhere" });

    yield* insertConnection(db, {
      rowId: "c-a1",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "github",
      name: "personal",
      oauthScope: "repo read:user",
    });
    yield* insertConnection(db, {
      rowId: "c-a2",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "linear",
      name: "work",
    });
    yield* insertConnection(db, {
      rowId: "c-b1",
      tenant: TENANT,
      owner: "user",
      subject: SUBJECT_B,
      integration: "github",
      name: "b-personal",
      oauthScope: "repo",
    });
    yield* insertConnection(db, {
      rowId: "c-org",
      tenant: TENANT,
      owner: "org",
      subject: "",
      integration: "stripe",
      name: "shared",
    });
    yield* insertConnection(db, {
      rowId: "c-other",
      tenant: OTHER_TENANT,
      owner: "user",
      subject: SUBJECT_A,
      integration: "github",
      name: "other-tenant",
    });
  });

const makePlatformExecutor = (
  db: SqliteTestFumaDb,
  options?: { readonly platformView?: boolean; readonly subject?: string | null },
): Effect.Effect<Executor, never> =>
  createExecutor({
    tenant: Tenant.make(TENANT),
    ...(options?.subject === null ? {} : { subject: Subject.make(options?.subject ?? SUBJECT_A) }),
    db: db.db,
    onElicitation: "accept-all",
    ...(options?.platformView === false ? {} : { platformView: true }),
  }).pipe(Effect.orDie);

const requireAdmin = (executor: Executor) => {
  const admin = executor.admin;
  if (!admin) return Effect.die("expected the platform view to be enabled");
  return Effect.succeed(admin);
};

describe("platform view — admin.listSubjects", () => {
  it.effect("lists every subject in the tenant and no other tenant's", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const subjects = yield* admin.listSubjects();

        // `user_elsewhere` lives under t2 — invisible at any reach.
        expect(subjects.map((entry) => entry.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
      }),
    ),
  );

  it.effect("returns created_at and the bigint last_seen_at through the ORM", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const before = Date.now();
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const subjects = yield* admin.listSubjects();
        const entry = subjects.find((row) => row.externalId === SUBJECT_A);

        expect(entry?.createdAt).toBeInstanceOf(Date);
        // A raw SQL read would hand back an unusable blob here.
        expect(typeof entry?.lastSeenAt).toBe("number");
        expect(entry?.lastSeenAt ?? 0).toBeGreaterThanOrEqual(before);
        expect(entry?.status).toBeNull();
      }),
    ),
  );

  it.effect("pages with a stable order", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const all = yield* admin.listSubjects();
        const first = yield* admin.listSubjects({ limit: 1 });
        const second = yield* admin.listSubjects({ limit: 1, offset: 1 });

        expect(all).toHaveLength(2);
        expect(first.map((entry) => entry.externalId)).toEqual([all[0]?.externalId]);
        expect(second.map((entry) => entry.externalId)).toEqual([all[1]?.externalId]);
      }),
    ),
  );
});

describe("platform view — admin.listSubjectConnections", () => {
  it.effect("lists another subject's connections across the tenant", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // Bound to A; reading B is exactly what the product view cannot do.
        const executor = yield* makePlatformExecutor(db, { subject: SUBJECT_A });
        const admin = yield* requireAdmin(executor);

        const connections = yield* admin.listSubjectConnections(SUBJECT_B);

        expect(connections.map((entry) => entry.name)).toEqual(["b-personal"]);
        expect(connections[0]?.integration).toBe("github");
        expect(connections[0]?.owner).toBe("user");
        expect(connections[0]?.subject).toBe(SUBJECT_B);
        expect(connections[0]?.oauthScope).toBe("repo");
        expect(connections[0]?.lastHealth?.status).toBe("healthy");
      }),
    ),
  );

  it.effect("does not attribute org-owned connections to a user", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const forA = yield* admin.listSubjectConnections(SUBJECT_A);

        // The org's `stripe/shared` belongs to the tenant, not to A.
        expect(forA.map((entry) => entry.integration).sort()).toEqual(["github", "linear"]);
        expect(forA.every((entry) => entry.owner === "user")).toBe(true);
      }),
    ),
  );

  it.effect("never returns credential-bearing fields", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const connections = yield* admin.listSubjectConnections(SUBJECT_A);
        expect(connections.length).toBeGreaterThan(0);

        for (const connection of connections) {
          const keys = Object.keys(connection);
          for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
            expect(keys).not.toContain(forbidden);
          }
          // Belt and braces: no seeded secret value appears anywhere in the
          // serialized shape, whatever it is keyed under.
          expect(JSON.stringify(connection)).not.toContain("SECRET-");
        }
      }),
    ),
  );
});

describe("platform view — admin.listSubjectsWithConnections", () => {
  it.effect("joins each subject to its own connections", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();
        const byId = new Map(rows.map((row) => [row.externalId, row]));

        expect(rows.map((row) => row.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
        expect(
          byId
            .get(SUBJECT_A)
            ?.connections.map((c) => c.name)
            .sort(),
        ).toEqual(["personal", "work"]);
        expect(byId.get(SUBJECT_B)?.connections.map((c) => c.name)).toEqual(["b-personal"]);
      }),
    ),
  );

  it.effect("never returns credential-bearing fields", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db);
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();

        for (const row of rows) {
          for (const connection of row.connections) {
            const keys = Object.keys(connection);
            for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
              expect(keys).not.toContain(forbidden);
            }
          }
        }
        expect(JSON.stringify(rows)).not.toContain("SECRET-");
      }),
    ),
  );

  it.effect("works for a pure-org executor with no bound subject", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // The shape an org-level API key produces: platform view on, no
        // subject bound at all.
        const executor = yield* makePlatformExecutor(db, { subject: null });
        const admin = yield* requireAdmin(executor);

        const rows = yield* admin.listSubjectsWithConnections();

        expect(rows.map((row) => row.externalId).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
        expect(rows.flatMap((row) => row.connections)).toHaveLength(3);
      }),
    ),
  );
});

describe("platform view — default off", () => {
  it.effect("an executor without the opt-in has no admin surface", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        const executor = yield* makePlatformExecutor(db, { platformView: false });

        expect(executor.admin).toBeUndefined();
      }),
    ),
  );

  it.effect("the product view still reads only the bound subject when the opt-in is on", () =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db);
        // Enabling the platform view must not widen ANY existing surface.
        const executor = yield* makePlatformExecutor(db, { subject: SUBJECT_A });

        const connections = yield* executor.connections.list().pipe(Effect.orDie);

        expect(connections.map((entry) => entry.name).sort()).toEqual([
          "personal",
          "shared",
          "work",
        ]);
      }),
    ),
  );
});
