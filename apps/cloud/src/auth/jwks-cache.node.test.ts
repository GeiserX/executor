import { describe, expect, it } from "@effect/vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from "jose";

import { createCachedRemoteJWKSet, type JwksEdgeCache } from "./jwks-cache";

const issuer = "https://test-authkit.example.com";
const audience = "client_test_fixture";
const jwksUrl = new URL("https://test-authkit.example.com/oauth2/jwks");

interface Keypair {
  readonly kid: string;
  readonly publicJwk: JWK;
  readonly privateKey: KeyLike;
}

const generateRotatableKeypair = async (kid: string): Promise<Keypair> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  return { kid, publicJwk: { ...jwk, kid, alg: "RS256" }, privateKey };
};

const sign = (keypair: Keypair) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keypair.kid })
    .setIssuer(issuer)
    .setSubject("user_test")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keypair.privateKey);

interface FetchHarness {
  readonly fetch: typeof globalThis.fetch;
  readonly callCount: () => number;
  readonly setKeys: (keys: ReadonlyArray<JWK>) => void;
}

const makeFetchHarness = (initialKeys: ReadonlyArray<JWK>): FetchHarness => {
  let keys: ReadonlyArray<JWK> = initialKeys;
  let calls = 0;

  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    const body: JSONWebKeySet = { keys: keys.map((k) => ({ ...k })) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    fetch,
    callCount: () => calls,
    setKeys: (next) => {
      keys = next;
    },
  };
};

describe("createCachedRemoteJWKSet", () => {
  it("FAILING-WITHOUT-CACHE: N verifications hit JWKS endpoint only once within TTL", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    for (let i = 0; i < 5; i++) {
      const token = await sign(kp);
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      expect(payload.sub).toBe("user_test");
    }

    expect(harness.callCount()).toBe(1);
  });

  it("single-flights concurrent cache misses into one fetch", async () => {
    const kp = await generateRotatableKeypair("k1");

    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFetch = r;
    });

    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      await gate;
      const body: JSONWebKeySet = { keys: [{ ...kp.publicJwk }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch });
    const token = await sign(kp);

    const verifies = Array.from({ length: 10 }, () => jwtVerify(token, jwks, { issuer, audience }));
    // Let microtasks settle so all 10 calls hit the cache miss path.
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch();
    const results = await Promise.all(verifies);
    expect(results).toHaveLength(10);
    expect(calls).toBe(1);
  });

  it("forces a refresh when verification fails with a no-matching-key error (key rotation)", async () => {
    const oldKey = await generateRotatableKeypair("k_old");
    const newKey = await generateRotatableKeypair("k_new");

    const harness = makeFetchHarness([oldKey.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    // Warm the cache with the old key.
    const t1 = await sign(oldKey);
    const ok = await jwtVerify(t1, jwks, { issuer, audience });
    expect(ok.payload.sub).toBe("user_test");
    expect(harness.callCount()).toBe(1);

    // Upstream rotates: only the new key remains in the JWKS endpoint.
    harness.setKeys([newKey.publicJwk]);

    // A token signed with the new key must verify even though our cache
    // still has the old one — the resolver must refetch on miss.
    const t2 = await sign(newKey);
    const ok2 = await jwtVerify(t2, jwks, { issuer, audience });
    expect(ok2.payload.sub).toBe("user_test");
    expect(harness.callCount()).toBe(2);
  });

  it("re-fetches after the TTL window elapses", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: harness.fetch,
      ttlMs: 10,
    });

    const t1 = await sign(kp);
    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 20));

    const t2 = await sign(kp);
    await jwtVerify(t2, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(2);
  });

  it("forceRefresh() invalidates the cache so the next call refetches", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    const t1 = await sign(kp);
    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(1);

    jwks.forceRefresh();

    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(2);
  });
});

interface EdgeCacheHarness {
  readonly cache: JwksEdgeCache;
  readonly matchCount: () => number;
  readonly putCount: () => number;
  readonly stored: () => Response | null;
  readonly seed: (keys: ReadonlyArray<JWK>) => void;
}

const makeEdgeCacheHarness = (): EdgeCacheHarness => {
  let stored: Response | null = null;
  let matches = 0;
  let puts = 0;

  return {
    cache: {
      match: async () => {
        matches++;
        return stored ? stored.clone() : undefined;
      },
      put: async (_url, response) => {
        puts++;
        stored = response;
      },
    },
    matchCount: () => matches,
    putCount: () => puts,
    stored: () => stored,
    seed: (keys) => {
      const body: JSONWebKeySet = { keys: keys.map((k) => ({ ...k })) };
      stored = new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    },
  };
};

describe("createCachedRemoteJWKSet edge cache", () => {
  it("FAILING-WITHOUT-EDGE-CACHE: a cold isolate with a warm edge cache never fetches upstream", async () => {
    const kp = await generateRotatableKeypair("k1");
    const upstream = makeFetchHarness([kp.publicJwk]);
    const edge = makeEdgeCacheHarness();
    edge.seed([kp.publicJwk]);

    // Fresh resolver = fresh isolate: empty in-memory cache.
    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: edge.cache,
    });

    const token = await sign(kp);
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    expect(payload.sub).toBe("user_test");
    expect(edge.matchCount()).toBe(1);
    expect(upstream.callCount()).toBe(0);
  });

  it("an edge-cache miss falls through to upstream and populates the edge copy", async () => {
    const kp = await generateRotatableKeypair("k1");
    const upstream = makeFetchHarness([kp.publicJwk]);
    const edge = makeEdgeCacheHarness();

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: edge.cache,
    });

    const token = await sign(kp);
    await jwtVerify(token, jwks, { issuer, audience });
    expect(upstream.callCount()).toBe(1);
    expect(edge.putCount()).toBe(1);

    // A second cold isolate now reads the populated edge copy.
    const jwks2 = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: edge.cache,
    });
    await jwtVerify(token, jwks2, { issuer, audience });
    expect(upstream.callCount()).toBe(1);
  });

  it("a malformed edge-cache entry is a miss, not a failure", async () => {
    const kp = await generateRotatableKeypair("k1");
    const upstream = makeFetchHarness([kp.publicJwk]);
    const edge = makeEdgeCacheHarness();
    await edge.cache.put(jwksUrl.toString(), new Response("not json"));

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: edge.cache,
    });

    const token = await sign(kp);
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    expect(payload.sub).toBe("user_test");
    expect(upstream.callCount()).toBe(1);
  });

  it("key rotation bypasses the stale edge copy and overwrites it", async () => {
    const oldKey = await generateRotatableKeypair("k_old");
    const newKey = await generateRotatableKeypair("k_new");
    const upstream = makeFetchHarness([newKey.publicJwk]);
    const edge = makeEdgeCacheHarness();
    // The edge copy predates the rotation: it only has the old key.
    edge.seed([oldKey.publicJwk]);

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: edge.cache,
    });

    // First verify warms in-memory from the (stale) edge copy; the new-key
    // token then misses, which must force an UPSTREAM refetch — re-reading
    // the same stale edge copy would loop the miss forever.
    const token = await sign(newKey);
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    expect(payload.sub).toBe("user_test");
    expect(upstream.callCount()).toBe(1);
    // And the rotated set replaced the stale edge copy for other isolates.
    expect(edge.putCount()).toBe(1);
  });

  it("degrades to upstream-only when the edge cache itself fails", async () => {
    const kp = await generateRotatableKeypair("k1");
    const upstream = makeFetchHarness([kp.publicJwk]);
    // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fakes the Cache API's own failure mode, a rejected promise
    const rejectingCacheCall = () => Promise.reject(new TypeError("cache backend unavailable"));
    const broken: JwksEdgeCache = {
      match: rejectingCacheCall,
      put: rejectingCacheCall,
    };

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: upstream.fetch,
      edgeCache: broken,
    });

    const token = await sign(kp);
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    expect(payload.sub).toBe("user_test");
    expect(upstream.callCount()).toBe(1);
  });
});
