import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// The self-host admin users plane (`/api/admin/users*`), over the REAL booted
// app: Better Auth, the libSQL store, and the mounted route layer.
//
// Self-host has no organization-owned api key (Better Auth keys always belong
// to the user who made one), so the credential here is the operator's own
// owner/admin session — the same gate the invite-code admin API uses. What this
// pins is that the mount is live, that the owner/admin gate actually refuses a
// plain member, and that a member who has used the instance shows up in the
// owner's view without their credential coming with them.

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-admin-users-"));
process.env.BETTER_AUTH_SECRET = "admin-users-test-secret-0123456789-abcdefghij";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@admin-users.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signIn = async (email: string, password: string): Promise<string> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.headers.get("set-auth-token") ?? "";
};

const adminUsers = (token?: string, path = "/api/admin/users") =>
  handler(
    new Request(`${BASE}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

test("the owner sees who uses the instance; a plain member cannot look", async () => {
  const adminToken = await signIn(
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL!,
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD!,
  );
  expect(adminToken).not.toBe("");

  // A second person joins through the real invite flow and uses the instance.
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@admin-users.test",
        password: "password-12345678",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const memberToken = signUp.headers.get("set-auth-token") ?? "";
  expect(memberToken).not.toBe("");

  // A user earns their row the first time they touch the EXECUTOR plane, so
  // have both make one product read before looking at the admin view.
  for (const token of [adminToken, memberToken]) {
    const integrations = await handler(
      new Request(`${BASE}/api/integrations`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(integrations.status).toBe(200);
  }

  // The owner's view reports both people.
  const response = await adminUsers(adminToken);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    users: ReadonlyArray<{ externalId: string; lastSeenAt: number | null }>;
  };
  expect(body.users.length, "both the owner and the invited member are reported").toBe(2);
  expect(typeof body.users[0]?.lastSeenAt, "last-seen crosses the wire as a number").toBe("number");

  // The joined view is mounted too.
  const joined = await adminUsers(adminToken, "/api/admin/users/with-connections");
  expect(joined.status).toBe(200);
  const joinedBody = (await joined.json()) as {
    users: ReadonlyArray<{ externalId: string; connections: readonly unknown[] }>;
  };
  expect(joinedBody.users.length).toBe(2);
  expect(
    joinedBody.users.every((user) => Array.isArray(user.connections)),
    "every user carries a connections array",
  ).toBe(true);

  // The gate: a plain member may not read the instance-wide view.
  const asMember = await adminUsers(memberToken);
  expect(asMember.status, "a member is refused").toBe(403);

  // And an anonymous caller has no session at all.
  const anonymous = await adminUsers();
  expect(anonymous.status, "no session → unauthorized").toBe(401);
});
