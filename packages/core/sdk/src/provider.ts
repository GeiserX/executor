import type { Effect } from "effect";

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
   *  WHY THIS EXISTS. A provider that hides values behind an indirection can
   *  protect an access token, because that token's only use is to be sent to a
   *  bound host and the reply is not itself a credential. The refresh grant
   *  breaks that: the exchange needs the real refresh token AND the authorization
   *  server's reply carries a brand-new real access token, so a provider that
   *  serves indirection here only moves the exposure one step later while
   *  appearing to have removed it. Providers backed by a sealed store therefore
   *  have to refuse the refresh item outright — the honest option, but it costs
   *  them refresh entirely.
   *
   *  Implementing this gives them the other option: own the exchange, seal the
   *  new tokens under the same item ids, and return only what the caller needs to
   *  update its bookkeeping. The caller then resolves the access token through
   *  `get`, exactly as it resolves every other credential.
   *
   *  OPTIONAL, and absence is not a downgrade: when it is missing the caller
   *  performs the exchange itself, unchanged. Implement it only if the exchange
   *  genuinely happens somewhere the host cannot read — returning success without
   *  performing the grant is worse than not implementing it. */
  readonly refreshGrant?: (
    input: RefreshGrantInput,
  ) => Effect.Effect<RefreshGrantResult, StorageFailure>;
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
  readonly tokenUrl: string;
  readonly clientId: string;
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
  /** Epoch millis, or null when the authorization server did not say. */
  readonly expiresAt: number | null;
  /** The granted scope as reported by the authorization server, or null when it
   *  did not report one (distinct from an empty scope). */
  readonly scope: string | null;
}
