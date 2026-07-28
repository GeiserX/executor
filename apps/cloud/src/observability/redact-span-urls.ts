// ---------------------------------------------------------------------------
// URL-attribute redaction for exported spans.
//
// Effect's `HttpMiddleware.tracer` stamps `url.full` and `url.query`
// unconditionally on every `http.server` span (see
// `effect/unstable/http/HttpMiddleware.ts` — it redacts URL userinfo and
// configured header names, and nothing else). `/api/oauth/callback` is an
// app-owned path, so its span carried the provider's `?code=…&state=…`
// verbatim to the trace backend on every OAuth connect.
//
// The scrub runs at the span-processor seam rather than at the route, because
// this is the only chokepoint every span in the isolate must pass through on
// its way to the exporter — worker spans, Effect spans, Durable Object spans,
// and any route added later. A per-route middleware or a `TracerDisabledWhen`
// override would only cover the routes someone remembered to wire it into, and
// overriding the middleware's attribute handling would mean forking Effect
// internals.
//
// `url.path` is deliberately preserved: route-level visibility is what makes
// these traces worth exporting at all. Only the sensitive query parameters are
// removed, and their presence is recorded as a stripped-key list so a trace
// still shows that the request carried a `code`, without its value.
// ---------------------------------------------------------------------------

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

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
const URL_ATTRIBUTES = ["url.full", "http.url"] as const;
const QUERY_ATTRIBUTE = "url.query";
/** Names of the parameters removed from this span's URL attributes. Non-secret
 *  by construction — it is the key list, never the values. */
export const STRIPPED_QUERY_ATTRIBUTE = "url.query.stripped_keys";

const isSensitive = (key: string): boolean => SENSITIVE_QUERY_KEYS.has(key.toLowerCase());

/** How deep to follow a query parameter whose value is itself a URL or path
 *  with a query string. Depth 2 covers the real nesting in this app —
 *  `/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fcode%3D…` (see
 *  `auth/return-to.ts` and the sign-in redirect in `start.ts`) — with headroom,
 *  and bounds the work per span. */
const MAX_NESTED_DEPTH = 2;

/** The query string with every sensitive parameter dropped, plus the names
 *  dropped. Parsed with `URLSearchParams` so encoding round-trips correctly.
 *
 *  A parameter whose own value carries a nested query string is redacted
 *  recursively rather than dropped: the login redirect round-trips the whole
 *  OAuth callback path through `returnTo`, so the credential rides inside
 *  another parameter's value and a top-level key check alone would miss it. */
const redactQuery = (
  query: string,
  depth = 0,
): { readonly query: string; readonly stripped: readonly string[] } => {
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
        : `${value.slice(0, separator)}${nested.query === "" ? "" : `?${nested.query}`}`;
    });
    if (rewritten.every((value, index) => value === values[index])) continue;
    params.delete(key);
    for (const value of rewritten) params.append(key, value);
  }
  return stripped.size === 0
    ? { query, stripped: [] }
    : { query: params.toString(), stripped: Array.from(stripped).sort() };
};

/** The URL with every sensitive query parameter dropped. Path, host, and
 *  scheme are untouched. Unparseable values are dropped entirely rather than
 *  passed through — if it cannot be parsed it cannot be proven safe. */
const redactUrl = (
  value: string,
): { readonly url: string; readonly stripped: readonly string[] } => {
  if (!URL.canParse(value)) {
    const { query, stripped } = redactQuery(value);
    return { url: stripped.length === 0 ? value : query, stripped };
  }
  const url = new URL(value);
  if (url.search === "") return { url: value, stripped: [] };
  const { query, stripped } = redactQuery(url.search.slice(1));
  if (stripped.length === 0) return { url: value, stripped: [] };
  url.search = query;
  return { url: url.toString(), stripped };
};

/** Rewrites the URL-bearing attributes of an in-flight span in place, dropping
 *  sensitive query parameters. Returns the parameter names removed. */
export const redactSpanUrlAttributes = (attributes: Record<string, unknown>): readonly string[] => {
  const stripped = new Set<string>();
  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    if (typeof value !== "string") continue;
    const result = redactUrl(value);
    for (const key of result.stripped) stripped.add(key);
    if (result.stripped.length > 0) attributes[name] = result.url;
  }
  const query = attributes[QUERY_ATTRIBUTE];
  if (typeof query === "string") {
    const result = redactQuery(query);
    for (const key of result.stripped) stripped.add(key);
    if (result.stripped.length > 0) attributes[QUERY_ATTRIBUTE] = result.query;
  }
  return Array.from(stripped).sort();
};

/** Wraps a span processor so every span is scrubbed of credential-bearing URL
 *  query parameters before the inner processor (and therefore the exporter)
 *  sees it.
 *
 *  The rewrite happens in `onEnding`, the last hook the OTel SDK calls while
 *  the span is still mutable (`Span.end()` runs `onEnding` before setting
 *  `_ended`, so `setAttribute` still applies); `onEnd` receives a frozen
 *  `ReadableSpan`. `onEnding` is optional in the SpanProcessor interface, so
 *  `onEnd` re-checks the attribute bag and mutates it directly as a backstop
 *  for any SDK path that skips the earlier hook. */
export class UrlRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.redact(span.attributes, (key, value) => span.setAttribute(key, value));
    this.inner.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    this.redact(attributes, (key, value) => {
      attributes[key] = value;
    });
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  private redact(
    attributes: Record<string, unknown>,
    write: (key: string, value: string) => void,
  ): void {
    // Work on a copy so the redaction decision is made from the current values
    // and applied through the caller's writer (span API vs direct mutation).
    const draft: Record<string, unknown> = { ...attributes };
    const stripped = redactSpanUrlAttributes(draft);
    if (stripped.length === 0) return;
    for (const name of [...URL_ATTRIBUTES, QUERY_ATTRIBUTE]) {
      const value = draft[name];
      if (typeof value === "string" && value !== attributes[name]) write(name, value);
    }
    write(STRIPPED_QUERY_ATTRIBUTE, stripped.join(","));
  }
}
