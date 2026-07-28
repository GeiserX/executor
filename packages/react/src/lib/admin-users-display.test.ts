import { describe, expect, it } from "@effect/vitest";
import type { IntegrationSlug } from "@executor-js/sdk/shared";

import {
  connectionHealthStatus,
  connectLinkUrl,
  formatLastSeen,
  integrationConnectionStates,
  isLocalSubject,
  lastSeenTitle,
  pageNumber,
  shortenExternalId,
  splitPage,
  type AdminConnectionRow,
} from "./admin-users-display";

const slug = (value: string): IntegrationSlug => value as IntegrationSlug;

const connection = (overrides: Partial<AdminConnectionRow> = {}): AdminConnectionRow => ({
  owner: "user",
  integration: slug("acme"),
  name: "default",
  oauthScope: null,
  lastHealth: null,
  ...overrides,
});

describe("formatLastSeen", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);

  it("never seen reads as Never, not as a stale timestamp", () => {
    expect(formatLastSeen(null, now)).toBe("Never");
  });

  // The writer throttles lastSeenAt to ~1h, so anything inside that window is
  // one bucket. Reporting minutes would claim precision the field doesn't have.
  it("collapses everything inside the throttle window to one honest bucket", () => {
    expect(formatLastSeen(now - 60_000, now)).toBe("Within the hour");
    expect(formatLastSeen(now - 45 * 60_000, now)).toBe("Within the hour");
    expect(formatLastSeen(now, now)).toBe("Within the hour");
  });

  it("counts hours and days above the window, hedged with About", () => {
    expect(formatLastSeen(now - 60 * 60_000, now)).toBe("About 1 hour ago");
    expect(formatLastSeen(now - 5 * 60 * 60_000, now)).toBe("About 5 hours ago");
    expect(formatLastSeen(now - 24 * 60 * 60_000, now)).toBe("About 1 day ago");
    expect(formatLastSeen(now - 9 * 24 * 60 * 60_000, now)).toBe("About 9 days ago");
  });

  it("falls back to an absolute date once relative wording stops being useful", () => {
    expect(formatLastSeen(now - 200 * 24 * 60 * 60_000, now)).not.toContain("ago");
  });

  it("the tooltip carries the exact instant and the coarseness caveat", () => {
    expect(lastSeenTitle(null)).toBe("Never seen on a request");
    expect(lastSeenTitle(now)).toContain("at most once an hour");
  });
});

describe("externalId display", () => {
  it("recognizes the single-player host sentinel", () => {
    expect(isLocalSubject("local")).toBe(true);
    expect(isLocalSubject("user_01JABCDEF")).toBe(false);
  });

  it("leaves short ids exactly as the server sent them", () => {
    expect(shortenExternalId("user_01JAB")).toBe("user_01JAB");
  });

  // Truncation is visual only — the id is opaque, so both ends are kept and two
  // ids differing in the middle stay distinguishable.
  it("shortens long ids from the middle, keeping both ends", () => {
    const long = "user_01JABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const short = shortenExternalId(long, 21);
    expect(short.length).toBe(21);
    expect(short.startsWith("user_01JAB")).toBe(true);
    expect(short.endsWith("0123456789")).toBe(true);
    expect(short).toContain("…");
  });
});

describe("connectionHealthStatus", () => {
  it("reads the stored verdict", () => {
    expect(connectionHealthStatus(connection({ lastHealth: { status: "expired" } }))).toBe(
      "expired",
    );
  });

  it("a never-probed connection is unchecked, not healthy", () => {
    expect(connectionHealthStatus(connection({ lastHealth: null }))).toBe("unknown");
  });
});

describe("integrationConnectionStates", () => {
  it("shows the whole catalog, marking what this user has connected", () => {
    const states = integrationConnectionStates(
      [slug("acme"), slug("beta"), slug("gamma")],
      [connection({ integration: slug("beta") })],
    );
    expect(states.map((state) => state.integration)).toEqual(["beta", "acme", "gamma"]);
    expect(states.map((state) => state.connected)).toEqual([true, false, false]);
  });

  it("keeps an available integration listed even when nobody connected it", () => {
    const states = integrationConnectionStates([slug("acme")], []);
    expect(states).toEqual([{ integration: "acme", connected: false, connections: [] }]);
  });

  // Dropping the user's own credential because the catalog read missed it would
  // under-report what they actually hold.
  it("still reports a connection whose integration is missing from the catalog", () => {
    const states = integrationConnectionStates([], [connection({ integration: slug("ghost") })]);
    expect(states.map((state) => state.integration)).toEqual(["ghost"]);
    expect(states[0]?.connected).toBe(true);
  });

  it("groups every connection a user holds on one integration", () => {
    const states = integrationConnectionStates(
      [slug("acme")],
      [
        connection({ integration: slug("acme"), name: "work" }),
        connection({ integration: slug("acme"), name: "personal" }),
      ],
    );
    expect(states[0]?.connections.map((row) => row.name)).toEqual(["work", "personal"]);
  });

  it("orders connected first, then alphabetically, so the order is stable per user", () => {
    const states = integrationConnectionStates(
      [slug("zulu"), slug("alpha"), slug("mike")],
      [connection({ integration: slug("zulu") })],
    );
    expect(states.map((state) => state.integration)).toEqual(["zulu", "alpha", "mike"]);
  });
});

describe("connectLinkUrl", () => {
  // Bare /connect/<slug>: the link is for the recipient's own session, which
  // resolves their org at the auth gate — an admin's org segment would be wrong.
  it("builds an absolute, org-free connect URL for this deployment", () => {
    expect(connectLinkUrl(slug("acme"), "https://console.example.com")).toBe(
      "https://console.example.com/connect/acme",
    );
  });

  it("does not double the separator when the origin carries a trailing slash", () => {
    expect(connectLinkUrl(slug("acme"), "https://console.example.com/")).toBe(
      "https://console.example.com/connect/acme",
    );
  });
});

describe("paging", () => {
  // The contract returns no total, so the page over-fetches by one row and the
  // extra row IS the answer to "is there a next page".
  it("an over-fetched page yields the page's rows plus a next-page signal", () => {
    expect(splitPage([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], hasNext: true });
  });

  it("a page that came back short is the last page", () => {
    expect(splitPage([1, 2], 3)).toEqual({ rows: [1, 2], hasNext: false });
  });

  it("an exactly-full page without the extra row is also the last page", () => {
    expect(splitPage([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], hasNext: false });
  });

  it("numbers pages from one", () => {
    expect(pageNumber(0, 25)).toBe(1);
    expect(pageNumber(25, 25)).toBe(2);
    expect(pageNumber(75, 25)).toBe(4);
  });
});
