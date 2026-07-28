import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import { ProviderItemId, ProviderKey } from "./ids";
import { credentialValueToWrite, type CredentialProvider } from "./provider";
import { memoryCredentialsPlugin } from "./test-config";

// ---------------------------------------------------------------------------
// The chokepoint's own invariants. `Redacted` renders as the string
// "<redacted>" through toString/toJSON instead of throwing, so a backend that
// forgets to unwrap on a WRITE persists that literal and every later read is
// self-consistently wrong. These cases pin the unwrap helper and the shipped
// in-memory provider that most of the suite writes credentials through.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const plugin = memoryCredentialsPlugin();
  const providers = plugin.credentialProviders as readonly CredentialProvider[];
  return providers[0]!;
};

describe("credentialValueToWrite", () => {
  it("unwraps a Redacted to the real secret", () => {
    expect(credentialValueToWrite(Redacted.make("sk_wrapped_written"))).toBe("sk_wrapped_written");
  });

  it("passes a bare string through unchanged", () => {
    expect(credentialValueToWrite("sk_plain_written")).toBe("sk_plain_written");
  });

  it("never yields the '<redacted>' placeholder", () => {
    expect(credentialValueToWrite(Redacted.make("sk_placeholder_check"))).not.toBe("<redacted>");
    // How the placeholder would arrive: the unguarded stringification a naive
    // implementation performs.
    expect(String(Redacted.make("sk_placeholder_check"))).toContain("redacted");
  });

  it("preserves an empty secret, which is a value and not an absence", () => {
    expect(credentialValueToWrite(Redacted.make(""))).toBe("");
  });
});

describe("memory credential provider", () => {
  it.effect("stores the real secret for both string and Redacted input", () =>
    Effect.gen(function* () {
      const provider = memoryProvider();

      yield* provider.set!(ProviderItemId.make("plain"), "sk_plain_written");
      yield* provider.set!(ProviderItemId.make("wrapped"), Redacted.make("sk_wrapped_written"));

      const plain = yield* provider.get(ProviderItemId.make("plain"));
      const wrapped = yield* provider.get(ProviderItemId.make("wrapped"));

      expect(plain === null ? null : Redacted.value(plain)).toBe("sk_plain_written");
      expect(wrapped === null ? null : Redacted.value(wrapped)).toBe("sk_wrapped_written");
    }),
  );

  it.effect("returns Redacted from get, and null for a missing id", () =>
    Effect.gen(function* () {
      const provider = memoryProvider();
      yield* provider.set!(ProviderItemId.make("token"), "sk_round_trip");

      expect(Redacted.isRedacted(yield* provider.get(ProviderItemId.make("token")))).toBe(true);
      expect(yield* provider.get(ProviderItemId.make("absent"))).toBeNull();
      expect(provider.key).toBe(ProviderKey.make("memory"));
    }),
  );

  // `Redacted.make("")` is truthy, so a falsiness test anywhere in the chain
  // would misreport a stored empty value as absent.
  it.effect("treats a stored empty value as present", () =>
    Effect.gen(function* () {
      const provider = memoryProvider();
      yield* provider.set!(ProviderItemId.make("empty"), Redacted.make(""));

      const found = yield* provider.get(ProviderItemId.make("empty"));
      expect(found).not.toBeNull();
      expect(found === null ? null : Redacted.value(found)).toBe("");
    }),
  );
});
