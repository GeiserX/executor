// ---------------------------------------------------------------------------
// Endpoint sanitization for span attributes.
//
// User-supplied endpoints are a credential carrier: `?token=…` in the query
// string and `user:pass@host` userinfo are both first-class supported input
// shapes (the MCP preset list ships a query-token URL, and the add-flow passes
// the raw paste straight through). Stamping such a URL verbatim onto a span
// ships the credential to the trace backend.
//
// Span attributes may carry hostnames, paths, and booleans; they may never
// carry the secret-bearing parts of a URL. `endpointForTelemetry` keeps the
// scheme/host/path — the parts that make a trace debuggable — and drops the
// query, fragment, and userinfo. `endpointTelemetryAttributes` adds the
// non-sensitive companions (origin, and whether a query string was present) so
// "the user pasted a URL with credentials in it" stays diagnosable without the
// credential itself.
// ---------------------------------------------------------------------------

/** The endpoint with every credential-bearing component removed: query string,
 *  fragment, and `user:pass@` userinfo. Unparseable input is returned as-is —
 *  it is not a URL, so there is nothing to strip, and callers still want the
 *  literal for debugging a malformed paste. */
export const endpointForTelemetry = (endpoint: string): string => {
  if (!URL.canParse(endpoint)) return endpoint;
  const url = new URL(endpoint);
  // A clean endpoint is returned verbatim: round-tripping through URL
  // normalizes (e.g. appends a trailing slash to an origin), which would make
  // the stamped attribute diverge from the configured value.
  if (url.search === "" && url.hash === "" && url.username === "" && url.password === "") {
    return endpoint;
  }
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
};

/** Span attributes describing an endpoint without exposing its credentials.
 *  `<prefix>` is the sanitized URL, `<prefix>.origin` the scheme+host, and the
 *  two booleans record that a query string / userinfo was stripped. */
export const endpointTelemetryAttributes = (
  prefix: string,
  endpoint: string,
): Record<string, string | boolean> => {
  if (!URL.canParse(endpoint)) {
    return {
      [prefix]: endpoint,
      [`${prefix}.has_query`]: false,
      [`${prefix}.has_userinfo`]: false,
    };
  }
  const url = new URL(endpoint);
  return {
    [prefix]: endpointForTelemetry(endpoint),
    [`${prefix}.origin`]: url.origin,
    [`${prefix}.has_query`]: url.search !== "",
    [`${prefix}.has_userinfo`]: url.username !== "" || url.password !== "",
  };
};
