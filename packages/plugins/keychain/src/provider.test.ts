import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock/vi.hoisted must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";

import { ProviderItemId } from "@executor-js/sdk";

const keyring = vi.hoisted(() => {
  // The bytes the OS keychain would have received. Asserting on these instead
  // of on a `get` round-trip is what catches a `set` that stored the wrong
  // thing but reads back consistently.
  const stored = new Map<string, string>();
  const key = (serviceName: string, account: string) => `${serviceName} ${account}`;
  return {
    stored,
    key,
    getPassword: vi.fn((serviceName: string, account: string) =>
      Effect.succeed(stored.get(key(serviceName, account)) ?? null),
    ),
    setPassword: vi.fn((serviceName: string, account: string, value: string) =>
      Effect.sync(() => {
        stored.set(key(serviceName, account), value);
      }),
    ),
    deletePassword: vi.fn((serviceName: string, account: string) =>
      Effect.sync(() => stored.delete(key(serviceName, account))),
    ),
  };
});

vi.mock("./keyring", () => ({
  getPassword: keyring.getPassword,
  setPassword: keyring.setPassword,
  deletePassword: keyring.deletePassword,
}));

const { makeKeychainProvider } = await import("./provider");

const SERVICE = "executor-test-provider";

describe("keychain credential provider", () => {
  // A `set` that forgot to unwrap would hand the keychain the literal
  // "<redacted>" — `Redacted`'s toString renders that rather than throwing — and
  // a `get` round-trip would still look self-consistent.
  it.effect("writes the real secret to the keychain for both string and Redacted input", () =>
    Effect.gen(function* () {
      keyring.stored.clear();
      const provider = makeKeychainProvider(SERVICE);

      yield* provider.set!(ProviderItemId.make("plain"), "sk_plain_written");
      yield* provider.set!(ProviderItemId.make("wrapped"), Redacted.make("sk_wrapped_written"));

      expect(keyring.stored.get(keyring.key(SERVICE, "plain"))).toBe("sk_plain_written");
      expect(keyring.stored.get(keyring.key(SERVICE, "wrapped"))).toBe("sk_wrapped_written");
      expect([...keyring.stored.values()]).not.toContain("<redacted>");
    }),
  );

  it.effect("returns stored values as Redacted and absence as null", () =>
    Effect.gen(function* () {
      keyring.stored.clear();
      const provider = makeKeychainProvider(SERVICE);

      yield* provider.set!(ProviderItemId.make("token"), "sk_round_trip");

      const found = yield* provider.get(ProviderItemId.make("token"));
      expect(found).not.toBeNull();
      expect(Redacted.isRedacted(found)).toBe(true);
      expect(found === null ? null : Redacted.value(found)).toBe("sk_round_trip");

      expect(yield* provider.get(ProviderItemId.make("absent"))).toBeNull();
      expect(yield* provider.has!(ProviderItemId.make("token"))).toBe(true);
      expect(yield* provider.has!(ProviderItemId.make("absent"))).toBe(false);
    }),
  );

  // An empty secret is a value, and `Redacted.make("")` is truthy — a provider
  // that tested falsiness anywhere would report this as absent.
  it.effect("round-trips an empty value as present", () =>
    Effect.gen(function* () {
      keyring.stored.clear();
      const provider = makeKeychainProvider(SERVICE);

      yield* provider.set!(ProviderItemId.make("empty"), Redacted.make(""));

      expect(keyring.stored.get(keyring.key(SERVICE, "empty"))).toBe("");
      const found = yield* provider.get(ProviderItemId.make("empty"));
      expect(found).not.toBeNull();
      expect(found === null ? null : Redacted.value(found)).toBe("");
    }),
  );
});
