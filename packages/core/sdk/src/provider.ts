import { Redacted } from "effect";
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
   *  before its template is applied. The provider interprets the id.
   *
   *  Returns `Redacted` so a credential cannot reach a log, a span attribute, or
   *  an error message by accident — this is the chokepoint the guarantee hangs
   *  off, so implementations must never widen it back to a bare string.
   *
   *  Absence is `null`, and every caller in the chain tests it explicitly:
   *  `Redacted.make("")` is truthy, so a falsiness test would report a stored
   *  empty value as absent. This is the one place that fact is stated; the
   *  presence checks downstream are its consequence. */
  readonly get: (
    id: ProviderItemId,
  ) => Effect.Effect<Redacted.Redacted<string> | null, StorageFailure>;
  readonly has?: (id: ProviderItemId) => Effect.Effect<boolean, StorageFailure>;
  /** Accepts a bare string as well as `Redacted` so callers holding a value that
   *  never left the process (a freshly minted token, a pasted form field) do not
   *  have to wrap it first. Unwrap with `Redacted.value` at the serialization
   *  line: a missed unwrap serializes the literal "<redacted>" and silently
   *  persists garbage. */
  readonly set?: (
    id: ProviderItemId,
    value: string | Redacted.Redacted<string>,
  ) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (id: ProviderItemId) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
}

/** The unwrap a `set` implementation performs at its serialization line. Keep
 *  the call adjacent to the write: `Redacted`'s toString/toJSON render
 *  "<redacted>", so a value that reaches a backend still wrapped is persisted as
 *  that literal instead of failing. */
export const credentialValueToWrite = (value: string | Redacted.Redacted<string>): string =>
  // oxlint-disable-next-line executor/no-redacted-unwrap -- boundary: THE serialization line every provider backend's `set` writes through
  Redacted.isRedacted(value) ? Redacted.value(value) : value;
