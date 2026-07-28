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

/** Removes every occurrence of a connection's resolved credential values from
 *  text. Total: text carrying no credential comes back unchanged. */
export interface CredentialScrubber {
  readonly text: (text: string) => string;
  /** Scrub an arbitrary decoded upstream payload (an error body, a parsed JSON
   *  envelope) before it is attached to a failure. Strings, arrays, and plain
   *  objects are walked; any other leaf is returned as-is, since these paths
   *  carry decoded response bodies, whose leaves are JSON scalars. */
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
    .map(Redacted.value)
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);

  const text = (input: string): string =>
    secrets.reduce((out, secret) => out.split(secret).join(SCRUB_MARKER), input);

  const payload = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(payload);
    if (Predicate.isObject(input)) {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, payload(value)]));
    }
    return input;
  };

  return { text, payload };
};
