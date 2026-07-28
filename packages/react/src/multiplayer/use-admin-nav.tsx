import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { orgMembersAtom } from "../api/account-atoms";
import { isTenantAdminMember, type TenantMemberRow } from "../lib/admin-access";
import type { ShellNavItem } from "./shell";

// ---------------------------------------------------------------------------
// Admin-only nav items.
//
// The console has no role on the session (`/account/me` returns a user and an
// organization, no role), so the current member's role is read off the member
// list — the same derivation cloud's org page already uses for its danger zone.
// Hosts pass their admin-only entries through this hook, which drops them for
// anyone the list doesn't show as an active admin/owner.
//
// This hides a section; it does not protect one. The page behind each item
// renders a denied state off the server's own 401/403, which is the gate that
// matters. Failing closed here is deliberate: while the member list is loading
// or unavailable, showing nothing is better than flashing a section that will
// refuse.
// ---------------------------------------------------------------------------

/** Whether the current member reads as an admin/owner of this tenant. */
export const useIsTenantAdmin = (): boolean => {
  const members = useAtomValue(orgMembersAtom);
  return AsyncResult.match(members, {
    onInitial: () => false,
    onFailure: () => false,
    onSuccess: ({ value }) => isTenantAdminMember(value.members as readonly TenantMemberRow[]),
  });
};

/**
 * Append admin-only nav items to a host's nav, for admins only.
 *
 * Takes both lists so hosts keep one nav definition and the ordering stays
 * theirs — the admin entries land wherever the host places the call.
 */
export const useAdminNavItems = (
  base: ReadonlyArray<ShellNavItem>,
  adminOnly: ReadonlyArray<ShellNavItem>,
): ReadonlyArray<ShellNavItem> => {
  const isAdmin = useIsTenantAdmin();
  return isAdmin ? [...base, ...adminOnly] : base;
};
