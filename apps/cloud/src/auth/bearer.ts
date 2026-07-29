// ---------------------------------------------------------------------------
// Bearer credential parsing — single-sourced HTTP `Authorization: Bearer …`
// prefix, and the ONE place the token is sliced off the header.
//
// Shared by every cloud credential path that splits a bearer token off the
// `Authorization` header (the WorkOS api-key/session resolver and the MCP edge
// auth). Defined once so the literal cannot drift.
//
// The slice hands back a `Redacted`, so no call site ever holds the inbound
// credential as a bare string. The header shapes the callers tell apart are
// enumerated as outcomes rather than folded into a nullable string: `Absent`
// falls through to the cookie session, `NotBearer` and `Empty` are distinct
// rejections, and `Redacted.make("")` is truthy — a caller could not test an
// empty token for itself once it is wrapped.
// ---------------------------------------------------------------------------

import { Predicate, Redacted } from "effect";

export const BEARER_PREFIX = "Bearer ";

export type BearerCredential =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "NotBearer" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Present"; readonly token: Redacted.Redacted<string> };

/** Narrows to the one outcome that carries a token, so a call site reaches
 *  `token` only after proving it exists. */
export const isBearerPresent = Predicate.isTagged("Present") as (
  value: BearerCredential,
) => value is Extract<BearerCredential, { readonly _tag: "Present" }>;

/** The bearer credential an inbound request carries, wrapped as it is sliced. */
export const bearerCredential = (request: Request): BearerCredential => {
  const header = request.headers.get("authorization");
  if (!header) return { _tag: "Absent" };
  if (!header.startsWith(BEARER_PREFIX)) return { _tag: "NotBearer" };
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) return { _tag: "Empty" };
  return { _tag: "Present", token: Redacted.make(token) };
};

/** Whether a bearer credential is a WorkOS access-token JWT (three dot-separated
 *  segments) rather than an API key — the discriminator BOTH bearer planes
 *  dispatch on. Reads the plaintext to count segments and retains none of it,
 *  so the call sites stay `Redacted`-only. */
export const isJwtBearer = (token: Redacted.Redacted<string>): boolean =>
  Redacted.value(token).split(".").length === 3;
