// ---------------------------------------------------------------------------
// Span-value redaction — the pure core every export seam shares.
//
// Two classes of value reach a trace backend carrying credentials, and neither
// is fixable by wrapping the secret in `Redacted`: the framework stamps them
// itself, from values that are already plain strings by the time it sees them.
//
//   1. URL attributes. Effect's `HttpMiddleware.tracer` and `HttpClient` stamp
//      `url.full` / `url.query` unconditionally (they redact URL userinfo and
//      configured header names, and nothing else), so an OAuth callback's
//      `?code=…&state=…` and a user-supplied `?token=…` endpoint ride out with
//      the span.
//   2. Free text. Effect's tracer logger puts the already-interpolated message
//      in the event name and the whole `effect.cause` in an event attribute;
//      the OTel bridge's `recordException` does the same for `exception.message`
//      and `exception.stacktrace`. Any URL those quote comes with its query
//      string attached.
//
// This module owns the decisions — which parameters are sensitive, how deep to
// follow nesting, how much stack text is worth keeping — so the isolate-specific
// wrappers (an OTel `SpanProcessor` in the Workers isolates, an OTLP
// serialization wrapper in the browser) stay thin and cannot drift apart.
// ---------------------------------------------------------------------------

/** Query parameters that are credentials, single-use grants, or CSRF secrets.
 *  Matched case-insensitively against the parameter name. */
const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "client_secret",
  "code",
  "code_verifier",
  "error_description",
  "id_token",
  "refresh_token",
  "session_state",
  "state",
  "token",
]);

/** Span attributes whose value is a whole URL. */
export const SPAN_URL_ATTRIBUTES = ["url.full", "http.url"] as const;
/** The span attribute holding a bare query string. */
export const SPAN_QUERY_ATTRIBUTE = "url.query";
/** Names of the parameters removed from this span's URL attributes. Non-secret
 *  by construction — it is the key list, never the values. */
export const STRIPPED_QUERY_ATTRIBUTE = "url.query.stripped_keys";

const isSensitive = (key: string): boolean => SENSITIVE_QUERY_KEYS.has(key.toLowerCase());

/** How deep to follow a query parameter whose value is itself a URL or path
 *  with a query string. Depth 2 covers the real nesting in this app —
 *  `/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fcode%3D…` — with headroom, and
 *  bounds the work per span. */
const MAX_NESTED_DEPTH = 2;

/** A scrubbed value plus the names of the parameters that were removed. */
export interface SpanRedaction {
  readonly value: string;
  readonly stripped: readonly string[];
}

/** The query string with every sensitive parameter dropped, plus the names
 *  dropped. Parsed with `URLSearchParams` so encoding round-trips correctly.
 *
 *  A parameter whose own value carries a nested query string is redacted
 *  recursively rather than dropped: the login redirect round-trips the whole
 *  OAuth callback path through `returnTo`, so the credential rides inside
 *  another parameter's value and a top-level key check alone would miss it. */
export const redactQuery = (query: string, depth = 0): SpanRedaction => {
  const params = new URLSearchParams(query);
  const stripped = new Set<string>();
  for (const key of Array.from(new Set(params.keys()))) {
    if (isSensitive(key)) {
      stripped.add(key);
      params.delete(key);
      continue;
    }
    if (depth >= MAX_NESTED_DEPTH) continue;
    const values = params.getAll(key);
    const rewritten = values.map((value) => {
      const separator = value.indexOf("?");
      if (separator === -1) return value;
      const nested = redactQuery(value.slice(separator + 1), depth + 1);
      for (const name of nested.stripped) stripped.add(`${key}.${name}`);
      return nested.stripped.length === 0
        ? value
        : `${value.slice(0, separator)}${nested.value === "" ? "" : `?${nested.value}`}`;
    });
    if (rewritten.every((value, index) => value === values[index])) continue;
    params.delete(key);
    for (const value of rewritten) params.append(key, value);
  }
  return stripped.size === 0
    ? { value: query, stripped: [] }
    : { value: params.toString(), stripped: Array.from(stripped).sort() };
};

/** The URL with every sensitive query parameter dropped. Path, host, and
 *  scheme are untouched. Unparseable values are treated as a bare query string
 *  and dropped entirely rather than passed through — if it cannot be parsed it
 *  cannot be proven safe. */
export const redactUrl = (url: string): SpanRedaction => {
  if (!URL.canParse(url)) return redactQuery(url);
  const parsed = new URL(url);
  if (parsed.search === "") return { value: url, stripped: [] };
  const query = redactQuery(parsed.search.slice(1));
  if (query.stripped.length === 0) return { value: url, stripped: [] };
  parsed.search = query.value;
  return { value: parsed.toString(), stripped: query.stripped };
};

/** Scrub one span attribute by name. Returns `null` when the attribute is not
 *  URL-bearing, is not a string, or carried nothing sensitive — so a non-null
 *  result always means "rewrite this value". */
export const redactSpanUrlAttribute = (name: string, value: unknown): SpanRedaction | null => {
  if (typeof value !== "string") return null;
  const isUrl = (SPAN_URL_ATTRIBUTES as readonly string[]).includes(name);
  if (!isUrl && name !== SPAN_QUERY_ATTRIBUTE) return null;
  const result = isUrl ? redactUrl(value) : redactQuery(value);
  return result.stripped.length === 0 ? null : result;
};

/** Rewrites the URL-bearing attributes of a span's attribute bag in place,
 *  dropping sensitive query parameters. Returns the parameter names removed. */
export const redactSpanUrlAttributes = (attributes: Record<string, unknown>): readonly string[] => {
  const stripped = new Set<string>();
  for (const name of [...SPAN_URL_ATTRIBUTES, SPAN_QUERY_ATTRIBUTE]) {
    const result = redactSpanUrlAttribute(name, attributes[name]);
    if (result === null) continue;
    for (const key of result.stripped) stripped.add(key);
    attributes[name] = result.value;
  }
  return Array.from(stripped).sort();
};

// ---------------------------------------------------------------------------
// Free text — event names, exception messages, pretty-printed causes
// ---------------------------------------------------------------------------

/** A URL-shaped substring that HAS a query string: an absolute URL or an
 *  absolute path, up to the first `?`, then the query up to the next
 *  whitespace or closing delimiter. Requiring the `?` is the point — a URL with
 *  no query string has nothing to strip, so it is left alone. */
const URL_WITH_QUERY = /(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>)\]}\\?]*\?[^\s"'<>)\]}\\]*/gi;

/** Drop sensitive query parameters from every URL-shaped substring of free
 *  text (a log message, an exception message, a pretty-printed cause). */
export const redactUrlQueryInText = (text: string): string =>
  text.replace(URL_WITH_QUERY, (match) => {
    const separator = match.indexOf("?");
    const { value, stripped } = redactQuery(match.slice(separator + 1));
    if (stripped.length === 0) return match;
    return value === "" ? match.slice(0, separator) : `${match.slice(0, separator)}?${value}`;
  });

/** The marker left where a credential-named value was removed from free text.
 *  Deliberately not `Redacted`'s own "<redacted>" rendering, so a scrubbed span
 *  value is never mistaken for a value serialized while still wrapped. */
const TEXT_SCRUB_MARKER = "[redacted]";

/** A `<name><separator><value>` pair, where the separator is `=` or `:` with
 *  optional quoting and whitespace around either side. Covers the three shapes
 *  free text actually arrives in: the JSON a serialized error renders to
 *  (`"state": "…"`), form-encoded prose (`code=…`), and hand-written messages
 *  (`token: …`). The value runs to the closing quote, or to the next
 *  whitespace/delimiter when unquoted. */
const KEY_VALUE_PAIR =
  /(["']?)([a-z_][a-z0-9_]*)\1(\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;)\]}]+))/gi;

/** A value that is purely numeric. Kept verbatim: `code: 404` and
 *  `status_code=200` are the readable part of a failure message, and a bare
 *  integer is not a credential. */
const NUMERIC_VALUE = /^\d+$/;

/** Replace the value of any credential-named key in free text.
 *
 *  This is the second half of the free-text backstop, and it exists because the
 *  first half is not enough: Effect's tracer logger serializes a logged CAUSE
 *  into the event name, so a tagged error's `state` / `code` / `token` field
 *  reaches the exporter as JSON inside a string — no URL involved, nothing for
 *  `Redacted` to have wrapped, and no chance for the URL scrub to see it.
 *
 *  Matching is by KEY NAME, using the same sensitive set as the query scrub, so
 *  it cannot depend on recognizing a secret by shape. A non-credential value
 *  that happens to sit under one of those names is lost from the trace; that is
 *  the accepted cost of the backstop, bounded by keeping numeric values. */
export const redactSensitiveKeyValuesInText = (text: string): string =>
  text.replace(KEY_VALUE_PAIR, (match, quote, key, separator, doubleQuoted, singleQuoted, bare) => {
    if (!isSensitive(key)) return match;
    const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
    if (value === "" || NUMERIC_VALUE.test(value)) return match;
    const rendered =
      doubleQuoted !== undefined
        ? `"${TEXT_SCRUB_MARKER}"`
        : singleQuoted !== undefined
          ? `'${TEXT_SCRUB_MARKER}'`
          : TEXT_SCRUB_MARKER;
    return `${quote}${key}${quote}${separator}${rendered}`;
  });

/** The cap applied to free-text span values. Stack traces and pretty-printed
 *  causes are unbounded — a deep Effect cause runs to tens of kilobytes — and
 *  the tail is where framework frames, echoed request bodies, and quoted
 *  upstream responses live. Truncating is the policy rather than parsing: the
 *  head carries the failure, the tail carries the risk. */
export const MAX_SPAN_TEXT_CHARS = 8_000;

/** Cap free text, recording how much was dropped. */
export const truncateSpanText = (text: string, maxChars = MAX_SPAN_TEXT_CHARS): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;

/** The whole policy for a free-text value leaving the process on a span: URL
 *  query parameters stripped, credential-named values replaced, then capped. */
export const scrubSpanText = (text: string, maxChars = MAX_SPAN_TEXT_CHARS): string =>
  truncateSpanText(redactSensitiveKeyValuesInText(redactUrlQueryInText(text)), maxChars);
