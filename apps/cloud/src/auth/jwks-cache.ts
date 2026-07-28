// ---------------------------------------------------------------------------
// In-memory JWKS cache for MCP JWT verification.
// ---------------------------------------------------------------------------
//
// Cloudflare Workers boot many short-lived isolates. `createRemoteJWKSet`'s
// default cooldown (30s) and cache max-age (10m) still results in many JWKS
// fetches per hour because each new isolate starts cold. Production p99 for
// `mcp.auth.jwt_verify` was 1.7s — almost entirely the JWKS fetch.
//
// This module offers a drop-in `createCachedRemoteJWKSet` that:
//
//   * Caches the JSON Web Key Set in module-scope memory for a configurable
//     TTL (default 1 hour).
//   * Backs the in-memory layer with the Workers Cache API (`caches.default`)
//     so a COLD isolate reads the JWKS from its datacenter's shared cache
//     instead of round-tripping to the upstream endpoint. The in-memory layer
//     alone left every fresh isolate paying that full fetch, which is exactly
//     when users notice: an app-open burst fans out across many new isolates
//     and each one stalled ~1-2s inside session verification.
//   * Single-flights concurrent fetches so a stampede of verifies during a
//     cache miss only fires one upstream request.
//   * Force-refreshes once when verification fails with a cached key, so
//     genuine key rotation isn't blocked by the TTL. A forced refresh also
//     bypasses the shared edge copy (it is just as stale as ours) and
//     overwrites it with the freshly fetched set.
//
// The returned function is a `JWTVerifyGetKey` and slots directly into
// `jose.jwtVerify`. It also exposes `forceRefresh()` so the verify path can
// invalidate the cache and retry on a bad signature.
// ---------------------------------------------------------------------------

import {
  createLocalJWKSet,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWTHeaderParameters,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import { Schema } from "effect";
import { JWKSNoMatchingKey } from "jose/errors";

/** The slice of the Workers Cache API this module uses, expressed
 *  structurally: `Cache` from workers-types satisfies it, and node tests can
 *  supply a conforming fake without the full `Cache` surface. */
export interface JwksEdgeCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

// The `caches` global exists in the Workers runtime but not under node (the
// test environment). Typed structurally (the ASSETS precedent in
// env-augment.d.ts) rather than via workers-types: its `Cache` type drags in
// a second `Response` that intersects with the ambient one and rejects
// responses this module constructs.
declare const caches: { readonly default: JwksEdgeCache } | undefined;

export interface CachedRemoteJWKSetOptions {
  /**
   * How long a successful fetch is considered fresh. Defaults to 1 hour —
   * AuthKit rotates JWKS roughly daily, and a forced refresh on verify
   * failure handles unscheduled rotations.
   */
  readonly ttlMs?: number;
  /** Override the fetch implementation for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** HTTP request timeout. Defaults to 5s, matching jose. */
  readonly timeoutMs?: number;
  /**
   * Datacenter-shared cache behind the in-memory layer. Defaults to
   * `caches.default` when the runtime provides it (Workers) and to disabled
   * when it does not (node tests). Pass explicitly to fake it in tests.
   */
  readonly edgeCache?: JwksEdgeCache | null;
}

export interface CachedRemoteJWKSet extends JWTVerifyGetKey {
  /** Drop the cached JWKS so the next call refetches. */
  readonly forceRefresh: () => void;
  /** Inspect the current cache state (testing/diagnostics). */
  readonly inspect: () => { fetchedAt: number | null; hasJwks: boolean };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const JsonWebKey = Schema.Record(Schema.String, Schema.Unknown);
const JsonWebKeySetPayload = Schema.Struct({
  keys: Schema.Array(JsonWebKey),
});
const decodeJsonWebKeySetPayload = Schema.decodeUnknownPromise(JsonWebKeySetPayload);

const ErrorWithCode = Schema.Struct({ code: Schema.String });
const isErrorWithCode = Schema.is(ErrorWithCode);

const isJwksNoMatchingKey = (cause: unknown): boolean =>
  isErrorWithCode(cause) && cause.code === JWKSNoMatchingKey.code;

interface CacheEntry {
  jwks: JSONWebKeySet;
  fetchedAt: number;
  resolver: (protectedHeader: JWTHeaderParameters, token?: FlattenedJWSInput) => Promise<KeyLike>;
}

const fetchJwksOnce = async (
  url: URL,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<JSONWebKeySet> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch adapter must clear abort timer while preserving promise rejection behavior
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: fetch-backed JWT key resolver must reject with the existing Error cause shape
      throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch JSON validation maps Schema failures to the existing malformed JWKS rejection
    try {
      await decodeJsonWebKeySetPayload(body);
      return body as JSONWebKeySet;
    } catch {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: fetch JSON validation preserves the existing malformed JWKS rejection
      throw new Error("JWKS fetch returned malformed payload");
    }
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Creates a cached, single-flight, force-refreshable JWKS resolver compatible
 * with `jose.jwtVerify`. Drop-in replacement for `createRemoteJWKSet` for the
 * MCP auth path — see module header for why we don't just use jose's built-in.
 */
export const createCachedRemoteJWKSet = (
  url: URL,
  options: CachedRemoteJWKSetOptions = {},
): CachedRemoteJWKSet => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Capture the fetch impl lazily so consumers can swap globalThis.fetch
  // (tests do this) without us snapshotting a stale reference.
  const fetchImpl = (): typeof globalThis.fetch =>
    options.fetch ?? globalThis.fetch.bind(globalThis);
  // `undefined` = not specified, use the runtime default; `null` = disabled.
  // Node (tests) has no `caches` global, so the default degrades to disabled
  // there without configuration.
  const edgeCache =
    options.edgeCache !== undefined
      ? options.edgeCache
      : typeof caches !== "undefined"
        ? caches.default
        : null;

  // The edge cache is best-effort: a failed read is a miss, a failed write is
  // dropped. Verification correctness never depends on it — the upstream
  // fetch remains the source of truth.
  const readEdgeCache = async (): Promise<JSONWebKeySet | null> => {
    if (!edgeCache) return null;
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: Cache API failure degrades to a cache miss inside a jose Promise resolver
    const cached = await edgeCache.match(url.toString()).catch(() => undefined);
    if (!cached) return null;
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: a non-JSON cached body degrades to a cache miss inside a jose Promise resolver
    const body: unknown = await cached.json().catch(() => null);
    if (body === null) return null;
    return decodeJsonWebKeySetPayload(body).then(
      () => body as JSONWebKeySet,
      () => null,
    );
  };

  const writeEdgeCache = async (jwks: JSONWebKeySet): Promise<void> => {
    if (!edgeCache) return;
    // The Cache API owns expiry: `match` stops returning the entry once
    // `max-age` elapses, so the shared copy has the same freshness window as
    // the in-memory layer.
    const response = new Response(JSON.stringify(jwks), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${Math.floor(ttlMs / 1000)}`,
      },
    });
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: a failed shared-cache write is dropped; the fetched JWKS is already in hand
    await edgeCache.put(url.toString(), response).catch(() => undefined);
  };

  const fetchUpstream = async (): Promise<JSONWebKeySet> => {
    const jwks = await fetchJwksOnce(url, fetchImpl(), timeoutMs);
    await writeEdgeCache(jwks);
    return jwks;
  };

  let entry: CacheEntry | null = null;
  let inflight: { promise: Promise<CacheEntry>; bypassedEdge: boolean } | null = null;
  // Set by `forceRefresh()`: the shared edge copy is as suspect as our
  // in-memory one (same staleness), so the next refresh must go upstream and
  // overwrite it rather than read it back.
  let bypassEdgeOnNextRefresh = false;

  const refresh = (bypassEdge: boolean): Promise<CacheEntry> => {
    const effectiveBypass = bypassEdge || bypassEdgeOnNextRefresh;
    // Join an inflight refresh only when it satisfies this request: a
    // bypassing caller must not receive the result of an edge-cache read.
    if (inflight && (inflight.bypassedEdge || !effectiveBypass)) return inflight.promise;
    bypassEdgeOnNextRefresh = false;
    const record: { promise: Promise<CacheEntry>; bypassedEdge: boolean } = {
      bypassedEdge: effectiveBypass,
      promise: (async () => {
        const jwks = effectiveBypass
          ? await fetchUpstream()
          : ((await readEdgeCache()) ?? (await fetchUpstream()));
        const next: CacheEntry = {
          jwks,
          fetchedAt: Date.now(),
          resolver: createLocalJWKSet(jwks),
        };
        entry = next;
        return next;
      })().finally(() => {
        if (inflight === record) inflight = null;
      }),
    };
    inflight = record;
    return record.promise;
  };

  const ensureFresh = async (forceRefresh: boolean): Promise<CacheEntry> => {
    if (forceRefresh) return refresh(true);
    if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry;
    return refresh(false);
  };

  const get: JWTVerifyGetKey = async (protectedHeader, token) => {
    const current = await ensureFresh(false);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: jose JWTVerifyGetKey retry path is defined by thrown resolver failures
    try {
      return await current.resolver(protectedHeader, token);
    } catch (error) {
      // Likely cause: keys rotated upstream after our TTL window started.
      // Refetch once and try again. Anything still failing bubbles up so
      // jose can classify it (we do not silently swallow real failures).
      if (!isJwksNoMatchingKey(error)) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: jose JWTVerifyGetKey requires preserving upstream resolver rejection
        throw error;
      }
      const refreshed = await ensureFresh(true);
      return refreshed.resolver(protectedHeader, token);
    }
  };

  const result = get as CachedRemoteJWKSet;
  Object.defineProperty(result, "forceRefresh", {
    value: () => {
      entry = null;
      bypassEdgeOnNextRefresh = true;
    },
  });
  Object.defineProperty(result, "inspect", {
    value: () => ({
      fetchedAt: entry?.fetchedAt ?? null,
      hasJwks: entry !== null,
    }),
  });
  return result;
};
