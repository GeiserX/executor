import { Predicate, Redacted } from "effect";

// ---------------------------------------------------------------------------
// Scrubbing resolved credential values out of text that leaves the process.
//
// Upstream error bodies and transport failure messages routinely echo the
// request back — a URL with its query string, a rejected `Authorization`
// header, a whole curl-shaped repro. Anything derived from such text and then
// surfaced (a health-check `detail`, a tool failure's `details` payload) can
// carry the credential the request authenticated with.
//
// This is the one place a resolved value is unwrapped for a READ whose purpose
// is to REMOVE it: the scrubber needs the plaintext to find it. The plaintext
// never leaves this module — only the scrubbed text does.
// ---------------------------------------------------------------------------

/** The marker substituted for a credential occurrence. Deliberately not
 *  `Redacted`'s own "<redacted>" rendering, so a scrubbed upstream body is never
 *  mistaken for a value that was serialized while still wrapped. */
const SCRUB_MARKER = "[redacted]";

/** Substituted for a value already being walked. A decoded response body is a
 *  tree, but a thrown failure is not: an error's `cause` chain can point back at
 *  itself, and walking it would recurse until the stack goes. */
const CIRCULAR_MARKER = "[circular]";

/** Removes every occurrence of a connection's resolved credential values from
 *  text. Total: text carrying no credential comes back unchanged. */
export interface CredentialScrubber {
  readonly text: (text: string) => string;
  /** Scrub an arbitrary decoded upstream payload (an error body, a parsed JSON
   *  envelope, a thrown failure) before it is attached to a failure. Strings,
   *  arrays, and plain objects are walked; any other leaf is returned as-is,
   *  since these paths carry decoded response bodies, whose leaves are JSON
   *  scalars. */
  readonly payload: (payload: unknown) => unknown;
}

/** Build a scrubber from a connection's resolved credential values.
 *
 *  Empty values are skipped — splitting on "" would shred the text. Secrets are
 *  applied longest-first so a value containing another (an access token
 *  embedded in a composite header value) is replaced whole instead of leaving a
 *  fragment of the longer secret behind. */
export const makeCredentialScrubber = (
  values: Record<string, Redacted.Redacted<string> | null>,
): CredentialScrubber => {
  const secrets = Object.values(values)
    .filter(Predicate.isNotNull)
    // oxlint-disable-next-line executor/no-redacted-unwrap -- boundary: the plaintext is the needle to strip out; it is only ever compared, never emitted
    .map(Redacted.value)
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);

  const text = (input: string): string =>
    secrets.reduce((out, secret) => out.split(secret).join(SCRUB_MARKER), input);

  const walk = (input: unknown, seen: ReadonlySet<object>): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) {
      if (seen.has(input)) return CIRCULAR_MARKER;
      const next = new Set([...seen, input]);
      return input.map((entry) => walk(entry, next));
    }
    if (!Predicate.isObject(input)) return input;
    if (seen.has(input)) return CIRCULAR_MARKER;
    const next = new Set([...seen, input]);
    const projected = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, walk(value, next)]),
    );
    // oxlint-disable-next-line executor/no-instanceof-error -- boundary: `payload` takes the untyped value a failure carried; narrowing it is how the diagnostics below are recovered
    if (!(input instanceof Error)) return projected;
    // `name`, `message`, and `stack` are non-enumerable on an Error, so the
    // projection above drops them — and the message is exactly where the
    // credential lands, since a transport failure quotes the request it failed
    // on. This path receives the raw error a plugin's invocation threw
    // (`OpenApiInvocationError` on either timeout), whose message is the only
    // diagnostic it carries; the same explicit projection `redactErrorCause`
    // makes in `oauth-helpers.ts`, with the value-based scrub applied instead
    // of that file's key-name policy.
    return {
      ...projected,
      name: text(input.name),
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: narrowed to Error above; the message is scrubbed, not interpreted
      message: text(input.message),
      ...(input.stack === undefined ? {} : { stack: text(input.stack) }),
    };
  };

  const payload = (input: unknown): unknown => walk(input, new Set());

  return { text, payload };
};
