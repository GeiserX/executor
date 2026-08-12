import { Data, type Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { ProviderItemId, ProviderKey } from "./ids";

/* Where a credential's value actually lives — the v2 successor to v1's
 * `SecretProvider`. The default store holds pasted values; external backends
 * (1Password, keychain, workos-vault) resolve an opaque `id` on demand — the
 * value never lands in our core storage. Core never knows how the id is shaped;
 * only the provider interprets it. Registered alongside the executor, a separate
 * axis from integration plugins. No `scope` arg — the connection row owns the
 * (tenant, owner, subject) partition; the provider sees only an opaque id. */

export interface ProviderEntry {
  /** The provider's own opaque handle for this entry. Surfaced for discovery so
   *  a connection can reference it without core knowing its internal shape. */
  readonly id: ProviderItemId;
  readonly name: string;
}

export interface CredentialProvider {
  readonly key: ProviderKey;
  /** If false, we never write here — `set`/`delete` are skipped and a referenced
   *  connection's `remove` only drops our routing, leaving the item intact. */
  readonly writable: boolean;
  /** Resolve a value by opaque id. The single hop a credential goes through
   *  before its template is applied. The provider interprets the id. */
  readonly get: (id: ProviderItemId) => Effect.Effect<string | null, StorageFailure>;
  readonly has?: (id: ProviderItemId) => Effect.Effect<boolean, StorageFailure>;
  readonly set?: (id: ProviderItemId, value: string) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (id: ProviderItemId) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
  /** Perform the OAuth refresh grant inside the provider, instead of handing the
   *  refresh token out to be exchanged here.
   *
   *  A provider that serves an indirection can protect an access token: it is
   *  spent against a bound host, and the reply is not itself a credential. The
   *  refresh grant breaks that — the exchange needs the real refresh token and
   *  the reply carries a brand-new one — so a store the host genuinely cannot
   *  read has to refuse the refresh item, losing refresh entirely. Implementing
   *  this gives it the other option: own the exchange, seal the new tokens under
   *  the same item ids, and report only what the caller's bookkeeping needs.
   *
   *  OPTIONAL — when absent the caller performs the exchange itself, unchanged.
   *  Implement it only if the exchange genuinely happens somewhere the host
   *  cannot read; returning success without performing the grant is worse than
   *  not implementing it. */
  readonly refreshGrant?: (
    input: RefreshGrantInput,
  ) => Effect.Effect<RefreshGrantResult, StorageFailure | RefreshGrantRejected>;
}

/** What the provider needs to perform the grant on the caller's behalf.
 *
 *  Secrets are named by ITEM ID, never passed as values — passing the refresh
 *  token or the client secret here would reintroduce exactly the exposure this
 *  interface exists to remove. */
export interface RefreshGrantInput {
  /** The stored refresh token to spend. */
  readonly refreshItemId: ProviderItemId;
  /** Where to seal the newly minted access token. The caller reads it back from
   *  here through `get`. */
  readonly accessItemId: ProviderItemId;
  /** The OAuth app's client secret, by id. Absent for a public client. */
  readonly clientSecretItemId?: ProviderItemId;
  /** The token endpoint to post to.
   *
   *  SECURITY: this is the CALLER's view of the endpoint, and a caller whose
   *  process is part of your threat model is not a trustworthy source for it —
   *  a rewritten value turns the grant into an exfiltration of the very token
   *  this interface exists to seal. A provider whose whole purpose is to
   *  withhold the refresh token from the caller MUST pin the endpoint against a
   *  value it recorded when the item was sealed, and reject a mismatch. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** How to present the client secret: `"body"` is `client_secret_post`,
   *  `"basic"` is `client_secret_basic`. Passed explicitly so a provider never
   *  has to guess — RFC 6749 §2.3.1 prefers Basic, while this caller's default
   *  is post, so a guess would be wrong as often as right. */
  readonly clientAuth: "body" | "basic";
  readonly scopes: readonly string[];
  /** RFC 8707 — keeps the re-minted token bound to the same resource. */
  readonly resource?: string;
}

/** Deliberately carries NO token material.
 *
 *  These two fields are the whole of what the caller needs to update a
 *  connection row after a refresh; anything more would put the host back in the
 *  data path. A rotated refresh token is sealed by the provider under the same
 *  `refreshItemId` and is never reported here. */
export interface RefreshGrantResult {
  /** Lifetime in seconds (RFC 6749 §5.1 `expires_in`), or null when the
   *  authorization server did not say.
   *
   *  RELATIVE, not an absolute instant, precisely because the provider may run
   *  where the caller cannot read — which usually means a different machine and
   *  therefore a different clock. The caller converts against its OWN clock, the
   *  same one that later decides whether the token is due for refresh. */
  readonly expiresInSeconds: number | null;
  /** The granted scope as reported by the authorization server, or null when it
   *  did not report one (distinct from an empty scope). */
  readonly scope: string | null;
}

/** The authorization server refused the grant.
 *
 *  Distinct from `StorageFailure` because the two demand opposite responses: a
 *  storage failure is transient and worth retrying, whereas an RFC 6749 §5.2
 *  refusal is the AS's standing verdict — `invalid_grant` in particular means
 *  the refresh token is dead and only re-authentication recovers it. Without
 *  this the caller cannot tell "the vault is down" from "this connection is
 *  finished", so it can neither prompt for re-auth nor stop re-sending a grant
 *  that will never succeed.
 *
 *  The §5.2 error response carries no token material, so reporting the code
 *  costs nothing in custody. */
export class RefreshGrantRejected extends Data.TaggedError("RefreshGrantRejected")<{
  readonly message: string;
  /** The RFC 6749 §5.2 code (`invalid_grant`, `invalid_client`, …) when the
   *  token endpoint returned one. Omit it for a failure that carried no code —
   *  the caller then treats the failure as transient. */
  readonly error?: string;
  readonly cause?: unknown;
}> {}
