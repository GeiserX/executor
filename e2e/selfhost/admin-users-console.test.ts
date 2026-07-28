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

const registerIntegration = (client: Client) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`admin-ui-sh-${randomBytes(4).toString("hex")}`);
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
        ],
        { discard: true },
      ),
    );
  }),
);
