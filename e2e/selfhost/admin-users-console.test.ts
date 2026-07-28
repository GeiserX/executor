// Selfhost-only (browser): the admin Users page against the OTHER auth model.
//
// Cloud gates this plane on a WorkOS `admin` membership; self-host gates it on
// a Better Auth `owner`/`admin` member. The console is shared, so the same page
// must open for the instance owner and refuse an invited plain member — that
// second role vocabulary is exactly what the cloud scenario cannot cover.
//
// Selfhost identities are shared across scenarios (one bootstrap admin, one
// org), so this asserts "contains mine" rather than global counts, and every
// resource it creates is prefixed.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { createInvitedIdentity } from "../targets/selfhost";
import { Api, Browser, Target } from "../src/services";

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

const registerIntegration = (client: Client, label = "admin-ui-sh") =>
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

scenario(
  "Admin · a self-hosted owner sees the workspace's users; an invited member is refused",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    // The bootstrap identity owns the instance; the invited one is a plain
    // member, which is the Better Auth role the admin plane refuses.
    const owner = yield* target.newIdentity();
    const member = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, owner, {
        role: "member",
        emailPrefix: "admin-ui-member",
      }),
    );

    const ownerClient = yield* apiClient(api, owner);
    const memberClient = yield* apiClient(api, member);
    const integration = yield* registerIntegration(ownerClient);
    // A second, deliberately unconnected integration, so the member's detail is
    // guaranteed to render at least one connect link to assert the shape of.
    const availableIntegration = yield* registerIntegration(ownerClient, "admin-ui-sh-avail");
    const memberConnection = ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // The member stores their own credential, so the owner's view has
        // something to report that the owner's product view cannot see.
        yield* memberClient.connections.create({
          payload: {
            owner: "user",
            name: memberConnection,
            integration,
            template: TEMPLATE_API_KEY,
            value: "member-personal-token",
          },
        });

        yield* browser.session(owner, async ({ page, step }) => {
          await step("Open Users from the sidebar as the instance owner", async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            await page
              .locator("nav")
              .getByRole("link", { name: "Users" })
              .first()
              .click({ timeout: 30_000 });
            await page
              .locator("[data-slot='admin-users-table']")
              .waitFor({ state: "visible", timeout: 30_000 });
          });

          await step("The invited member's connection is attributed to them", async () => {
            // Selfhost shares one org across scenarios, so this asserts the
            // member's own row exists — never a count of the whole instance.
            const row = page
              .locator("[data-slot='admin-user-row']")
              .filter({
                has: page.locator(`[data-integration='${integration}'][data-connected='true']`),
              })
              .first();
            await row.waitFor({ state: "visible", timeout: 30_000 });
            await row.click();

            const detail = page.getByRole("dialog");
            await detail.waitFor({ state: "visible", timeout: 30_000 });
            await detail
              .getByText(memberConnection, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });
          });

          await step(
            "The built-in integration is never offered as something to connect",
            async () => {
              // It is a static, credential-free source: there is no connect flow
              // to send anyone to, so it is neither a slot nor a link. This is the
              // reported bug — it used to appear under "not connected" with a
              // copyable link to a route that would do nothing.
              const detail = page.getByRole("dialog");
              expect(
                await detail.locator("[data-integration='executor']").count(),
                "the built-in gets no slot in the detail sheet",
              ).toBe(0);
              expect(
                await detail.getByText("/connect/executor", { exact: false }).count(),
                "and no connect link is rendered for it",
              ).toBe(0);
            },
          );

          await step("A connect link is scoped to the org the admin is viewing", async () => {
            // The invariant is a round trip, not a fixed shape: whatever org the
            // console is currently scoped to is the org the link carries, so a
            // recipient cannot be sent into a different workspace than the one
            // the admin was looking at.
            //
            // Self-host DOES have an org segment — it canonicalizes onto a
            // `default` org — so this host exercises the prefixed form just as
            // cloud does. The org-free form is what a host that renders no
            // segment at all would produce, and it is covered by the display
            // unit tests rather than pinned to a host here.
            //
            // Asserted as a rendered string, not navigated: the `/connect/...`
            // route lands on the sibling connect-deep-links branch (#1466) and
            // is not in this build.
            //
            // TODO(connect-deep-links #1466): once that route exists, add the
            // signed-out round trip — open this link as a recipient and assert
            // it reaches the connect flow in the SENDING org. It belongs on the
            // deep-link branch or post-merge, since the route must resolve.
            const detail = page.getByRole("dialog");
            const origin = new URL(target.baseUrl).origin;
            // The console's own org prefix, read from the URL the page settled
            // on — "" when this host renders no segment.
            const consolePath = new URL(page.url()).pathname;
            const orgPrefix = consolePath.endsWith("/users")
              ? consolePath.slice(0, -"/users".length)
              : "";

            // The integration nobody connected is the one whose link must be here.
            await detail
              .getByText(`${origin}${orgPrefix}/connect/${availableIntegration}`, { exact: true })
              .waitFor({ state: "visible", timeout: 30_000 });

            // And EVERY rendered link agrees with the console's own scope — one
            // link pointing at another org would silently misroute a recipient.
            const links = await detail
              .locator("[data-slot='admin-user-connect-link']")
              .allTextContents();
            expect(links.length, "the owner sees at least one link to send").toBeGreaterThanOrEqual(
              1,
            );
            for (const link of links) {
              const parsed = new URL(link);
              expect(parsed.origin, `absolute for this deployment: ${link}`).toBe(origin);
              expect(
                parsed.pathname.startsWith(`${orgPrefix}/connect/`),
                `scoped to the console's own org (${orgPrefix || "<none>"}): ${link}`,
              ).toBe(true);
              expect(
                parsed.pathname.slice(`${orgPrefix}/connect/`.length).split("/").length,
                `exactly one slug after /connect/: ${link}`,
              ).toBe(1);
            }
          });
        });

        yield* browser.session(member, async ({ page, step }) => {
          await step("A plain member is not offered the section", async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            await page
              .locator("nav")
              .getByRole("link", { name: "Integrations" })
              .first()
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.locator("nav").getByRole("link", { name: "Users" }).count(),
              "a plain member is not shown a section that would only refuse them",
            ).toBe(0);
          });

          await step("And reaching the URL directly is refused, not silently empty", async () => {
            await page.goto("/users", { waitUntil: "networkidle" });
            await page
              .getByText("You don't have access to this workspace's users")
              .waitFor({ state: "visible", timeout: 30_000 });
            expect(
              await page.locator("[data-slot='admin-users-table']").count(),
              "the refusal replaces the table rather than rendering it empty",
            ).toBe(0);
          });
        });
      }),
      Effect.all(
        [
          memberClient.connections
            .remove({ params: { owner: "user", integration, name: memberConnection } })
            .pipe(Effect.ignore),
          ownerClient.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
          ownerClient.openapi
            .removeSpec({ params: { slug: availableIntegration } })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
