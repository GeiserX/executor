import * as React from "react";

import { setShellOrgSlugFallback } from "./server-connection";

// The active organization for org-scoped hosts (the cloud app). Local and
// desktop aren't org-scoped, so they leave it unset and consumers fall back to
// unscoped behaviour. This is purely a UI hint (e.g. which org to pin in an MCP
// install URL); access is always enforced server-side.
export interface OrganizationContextValue {
  readonly organizationId: string;
  /** URL slug (`/<slug>/mcp`, `/<slug>/policies`); null on hosts without one. */
  readonly organizationSlug: string | null;
}

const OrganizationContext = React.createContext<OrganizationContextValue | null>(null);

export function OrganizationProvider(
  props: React.PropsWithChildren<{
    readonly organizationId: string | null;
    readonly organizationSlug?: string | null;
  }>,
) {
  const value = React.useMemo<OrganizationContextValue | null>(
    () =>
      props.organizationId
        ? {
            organizationId: props.organizationId,
            organizationSlug: props.organizationSlug ?? null,
          }
        : null,
    [props.organizationId, props.organizationSlug],
  );
  // Register the shell's org as the request-time fallback for the org header,
  // so API calls made while the URL is still bare (entry at `/` before
  // OrgSlugGate canonicalizes) stay explicitly scoped — the server fails
  // closed on requests with no org rather than guessing. Registered during
  // RENDER (memo, not an effect): children's mount effects fire their first
  // queries before a parent effect would run, and those requests must already
  // carry the org. Idempotent module-state write, browser-only (see
  // server-connection).
  const slug = value?.organizationSlug ?? null;
  React.useMemo(() => setShellOrgSlugFallback(slug), [slug]);
  React.useEffect(() => () => setShellOrgSlugFallback(null), []);
  return (
    <OrganizationContext.Provider value={value}>{props.children}</OrganizationContext.Provider>
  );
}

/** Returns the active organization id, or `null` when the host isn't org-scoped. */
export function useOrganizationId(): string | null {
  return React.useContext(OrganizationContext)?.organizationId ?? null;
}

/** The active org's URL slug, or `null` (host without slugs / no org). */
export function useOrganizationSlug(): string | null {
  return React.useContext(OrganizationContext)?.organizationSlug ?? null;
}
