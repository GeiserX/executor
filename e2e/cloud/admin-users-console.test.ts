// Cloud-only: the admin Users PAGE — the console surface over `/api/admin/users*`.
//
// The sibling `admin-users.test.ts` pins the API's guarantees. This one pins
// what an operator actually sees, which the API scenario cannot: that the page
// renders every member of the workspace, that each row's connection summary
// distinguishes connected from merely available, that opening a user shows that
// user's own connections with their health, and — the failure path that matters
// most here — that a plain member who reaches the URL is told they don't have
// access rather than shown an empty workspace.
//
// Two members are built through the REAL flows (login → create-organization →
// invite → accept-invitation) and each connects their own credential, so the
// two rows differ in what they've connected and the summary has something to
// be right about.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Registers a fresh apiKey-authenticated integration for connections to bind to. */
const registerIntegration = (client: Client, label: string) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`${label}-${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });
    return slug;
  });

const freshConnectionName = () => ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

const cookieOf = (identity: Identity): string => identity.headers?.["cookie"] ?? "";

/** The identity re-bound so the BROWSER carries the same session the API calls
 *  do. `joinOrg` refreshes `headers.cookie` (the org is baked into the sealed
 *  session) but leaves `cookies` on the pre-join value, and the browser context
 *  is seeded from `cookies`. */
const forBrowser = (identity: Identity): Identity => {
  const cookie = cookieOf(identity);
  const separator = cookie.indexOf("=");
  if (separator < 0) throw new Error("identity carries no session cookie");
  return {
    ...identity,
    cookies: [{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }],
  };
};

const postJson = (target: TargetShape, path: string, identity: Identity, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, target.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
        cookie: cookieOf(identity),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    }
    return response;
  });

/** The identity re-bound to the refreshed session cookie a response set. */
const withRefreshedSession = (identity: Identity, response: Response): Identity => {
  const refreshed = (response.headers.getSetCookie?.() ?? [])
    .find((header) => header.startsWith("wos-session="))
    ?.split(";")[0];
  if (!refreshed) throw new Error("response did not refresh the session cookie");
  return { ...identity, headers: { cookie: refreshed } };
};

/** Invite `member` into `admin`'s org and accept — the real invite flow. The
 *  invite carries no roleSlug, so the joiner lands as a plain member: exactly
 *  the actor the denial half of this scenario needs. */
const joinOrg = (target: TargetShape, admin: Identity, member: Identity) =>
  Effect.gen(function* () {
    const inviteResponse = yield* postJson(target, "/api/account/members/invite", admin, {
      email: member.credentials?.email,
    });
    const invitation = (yield* Effect.promise(() => inviteResponse.json())) as { id: string };
    const acceptResponse = yield* postJson(target, "/api/auth/accept-invitation", member, {
      invitationId: invitation.id,
    });
    return withRefreshedSession(member, acceptResponse);
  });

/** The caller's own account id — the `externalId` the admin plane reports and
 *  the page renders in mono. */
const accountIdOf = (target: TargetShape, identity: Identity) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/account/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/account/me failed (${response.status})`);
    const body = (await response.json()) as { user: { id: string } };
    return body.user.id;
  });

scenario(
  "Admin · the Users page shows every member and what each has connected, and refuses a plain member",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    const adminClient = yield* apiClient(api, admin);
    const memberClient = yield* apiClient(api, member);
    const adminId = yield* accountIdOf(target, admin);
    const memberId = yield* accountIdOf(target, member);

    // Two integrations so the summary has a real available-vs-connected split:
    // each member connects one, so each row shows one connected and one not.
    const connectedIntegration = yield* registerIntegration(adminClient, "admin-ui-conn");
    const availableIntegration = yield* registerIntegration(adminClient, "admin-ui-avail");
    const adminConnection = freshConnectionName();
    const memberConnection = freshConnectionName();

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Each member stores their OWN credential. Neither can see the other's
        // through the product plane — the admin page is the only surface that
        // reports both.
        yield* adminClient.connections.create({
          payload: {
            owner: "user",
            name: adminConnection,
            integration: connectedIntegration,
            template: TEMPLATE_API_KEY,
            value: "admin-personal-token",
          },
        });
        yield* memberClient.connections.create({
          payload: {
            owner: "user",
            name: memberConnection,
            integration: connectedIntegration,
            template: TEMPLATE_API_KEY,
            value: "member-personal-token",
          },
        });

        // ── The admin's view ────────────────────────────────────────────────
        yield* browser.session(forBrowser(admin), async ({ page, step }) => {
          let slug = "";

          await step("Land in the workspace and canonicalize onto the org slug", async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
              timeout: 30_000,
            });
            slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
            expect(slug, "the URL settled on an org slug").not.toBe("");
          });

          await step("Open Users from the sidebar", async () => {
            // The section is admin-only, so an admin must actually see the link
            // — reaching the page by URL would not prove the nav gate opened.
            await page.getByRole("link", { name: "Users" }).click();
            await page.waitForURL((url) => url.pathname === `/${slug}/users`, { timeout: 30_000 });
            await page.locator("[data-slot='admin-users-table']").waitFor({ timeout: 30_000 });
          });

          await step("Both members of the workspace are listed", async () => {
            const rows = page.locator("[data-slot='admin-user-row']");
            await rows.first().waitFor({ timeout: 30_000 });
            // The id is opaque and rendered shortened, so the row's full value
            // lives in the title the operator hovers for.
            const ids = await rows
              .locator("[data-slot='admin-user-id']")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("title") ?? ""),
              );
            expect(ids, "the admin's own row is listed").toContain(adminId);
            expect(
              ids,
              "the invited member is listed too, though the admin's product view cannot see them",
            ).toContain(memberId);
          });

          await step("Each row summarizes connected vs available integrations", async () => {
            const memberRow = page
              .locator("[data-slot='admin-user-row']")
              .filter({ has: page.locator(`[data-slot='admin-user-id'][title='${memberId}']`) });
            await memberRow.waitFor({ state: "visible", timeout: 30_000 });
            // A fresh cloud org's catalog is exactly the two integrations this
            // scenario registered: the built-in Executor integration is not
            // connectable, so it is neither a slot nor a denominator. The
            // denominator is therefore pinned, not read — a third slot here
            // would mean the built-in leaked back into the view.
            const summary = memberRow.locator("[data-slot='admin-user-connection-count']");
            await summary.waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await summary.textContent(),
              "one of the two connectable integrations, with the built-in out of both numbers",
            ).toBe("1/2");
            expect(
              await memberRow.locator("[data-integration='executor']").count(),
              "the built-in integration has no connect flow, so it gets no slot",
            ).toBe(0);
            expect(
              await memberRow
                .locator(`[data-integration='${connectedIntegration}'][data-connected='true']`)
                .count(),
              "the integration this member connected is lit in their summary",
            ).toBe(1);
            expect(
              await memberRow
                .locator(`[data-integration='${availableIntegration}'][data-connected='false']`)
                .count(),
              "the one they haven't connected still has a slot — that absence is the view",
            ).toBe(1);
          });

          await step("Open the member's detail and read their connections", async () => {
            await page
              .locator("[data-slot='admin-user-row']")
              .filter({ has: page.locator(`[data-slot='admin-user-id'][title='${memberId}']`) })
              .click();
            const detail = page.getByRole("dialog");
            await detail.waitFor({ state: "visible", timeout: 30_000 });

            // Their own connection, by name, with the shared health vocabulary.
            await detail
              .getByText(memberConnection, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
            // Never probed, so the honest verdict is Unchecked — not Healthy.
            expect(
              await detail.getByLabel("Status: Unchecked").count(),
              "a never-probed connection reads as unchecked, not healthy",
            ).toBe(1);
            // The other member's credential is not this member's business.
            expect(
              await detail.getByText(adminConnection, { exact: true }).count(),
              "one user's detail never shows another user's connection",
            ).toBe(0);
          });

          await step("The not-connected integration offers a copyable connect link", async () => {
            const detail = page.getByRole("dialog");
            const origin = new URL(target.baseUrl).origin;
            // The link carries THIS admin's org slug. A recipient who belongs
            // to several orgs would otherwise resolve the bare form against
            // their default org and connect in the wrong workspace.
            //
            // The URL is asserted as a rendered string rather than navigated:
            // the `/connect/...` route lands on the sibling connect-deep-links
            // branch (#1466) and does not exist in this build.
            //
            // TODO(connect-deep-links #1466): once that route is merged, add the
            // signed-out multi-org round trip — open this URL as a recipient who
            // belongs to two orgs and assert the connection lands in the SENDING
            // org, not their default. That test belongs on the deep-link branch
            // or post-merge, since it needs the route to resolve.
            await detail
              .getByText(`${origin}/${slug}/connect/${availableIntegration}`, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await detail
                .getByText(`${origin}/connect/${availableIntegration}`, { exact: true })
                .count(),
              "the org-free form is never rendered on a host that has orgs",
            ).toBe(0);
            // Exactly one: the member connected one of the two connectable
            // integrations, and the built-in offers no link at all.
            expect(
              await detail.getByRole("button", { name: "Copy link" }).count(),
              "one link per not-connected connectable integration, and none for the built-in",
            ).toBe(1);
            expect(
              await detail.getByText("/connect/executor", { exact: false }).count(),
              "the built-in integration is never offered as a connect link",
            ).toBe(0);
          });
        });

        // ── The plain member's view ─────────────────────────────────────────
        yield* browser.session(forBrowser(member), async ({ page, step }) => {
          let slug = "";

          await step("Sign in as a plain member of the same workspace", async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
              timeout: 30_000,
            });
            slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
            expect(slug, "the member landed in the workspace").not.toBe("");
          });

          await step("The Users section is not offered to them", async () => {
            await page
              .getByRole("link", { name: "Integrations" })
              .first()
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.getByRole("link", { name: "Users" }).count(),
              "a plain member is not shown a section that would only refuse them",
            ).toBe(0);
          });

          await step(
            "Reaching the URL directly says no access, not an empty workspace",
            async () => {
              await page.goto(`/${slug}/users`, { waitUntil: "networkidle" });
              // The denial is the assertion: an empty table here would misreport
              // a populated workspace as having no users.
              await page
                .getByText("You don't have access to this workspace's users")
                .waitFor({ state: "visible", timeout: 30_000 });
              expect(
                await page.locator("[data-slot='admin-users-table']").count(),
                "the refusal replaces the table rather than rendering it empty",
              ).toBe(0);
              expect(
                await page.getByText(adminId, { exact: true }).count(),
                "no other member's identity leaks to a refused viewer",
              ).toBe(0);
            },
          );
        });
      }),
      Effect.all(
        [
          adminClient.connections
            .remove({
              params: { owner: "user", integration: connectedIntegration, name: adminConnection },
            })
            .pipe(Effect.ignore),
          memberClient.connections
            .remove({
              params: { owner: "user", integration: connectedIntegration, name: memberConnection },
            })
            .pipe(Effect.ignore),
          adminClient.openapi
            .removeSpec({ params: { slug: connectedIntegration } })
            .pipe(Effect.ignore),
          adminClient.openapi
            .removeSpec({ params: { slug: availableIntegration } })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
