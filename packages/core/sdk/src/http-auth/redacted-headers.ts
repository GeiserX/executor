// ---------------------------------------------------------------------------
// Which header names a tracer must never stamp verbatim.
//
// Effect's tracing seams (`HttpMiddleware.tracer` inbound, `HttpClient`
// outbound) stamp EVERY header as a span attribute and wrap only the names in
// `Headers.CurrentRedactedNames` — whose default is just authorization, cookie,
// set-cookie, and x-api-key. This app mints credential headers well outside
// that list: an `AuthPlacement` names its own header (`authoring.ts` /
// `legacy.ts`), so a connection's key rides on whatever the integration
// declared — `X-Figma-Token`, `DD-API-KEY`, `Private-Token`, anything a spec's
// `secretHeaders` produced. Left at the default, every one of those was stamped
// in plaintext on the `http.client` span of every tool invocation.
//
// Placement names are user-supplied, so they cannot be enumerated. They are
// matched by SHAPE instead, and the match is deliberately loose: a redacted
// span attribute still records that the header was present (its value renders
// as `<redacted>`), so over-matching costs nothing, while under-matching ships
// a credential.
// ---------------------------------------------------------------------------

import { Headers } from "effect/unstable/http";
import { Layer } from "effect";

/** Credential vocabulary, matched against a whole header name segment so
 *  `x-request-id` and `content-type` are untouched while `api-key`,
 *  `x-figma-token`, and `private-token` are not.
 *
 *  A bare `key` and a bare `session` segment are deliberately absent. Both name
 *  trace-correlation values far more often than credentials — `idempotency-key`
 *  and `session-id` are exactly the headers that make a trace worth reading,
 *  and neither is a bearer of anything. The credential spellings that DO carry
 *  one are still covered by their qualified forms (`api-key`, `access-key`,
 *  `session-token`), so this narrows the collateral without narrowing the
 *  guarantee. */
const CREDENTIAL_HEADER_SHAPE =
  /(^|-)(api[-_]?key|access[-_]?key|auth|authentication|auth[-_]?token|access[-_]?token|credential|password|pat|secret|session[-_]?key|session[-_]?token|signature|token)(-|$)/i;

/** The names this app's tracers redact: Effect's defaults, the standard auth
 *  headers it omits, and the credential shape an `AuthPlacement` can mint. */
export const REDACTED_HEADER_NAMES: readonly (string | RegExp)[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "www-authenticate",
  CREDENTIAL_HEADER_SHAPE,
];

/** Provide the widened list wherever an HTTP layer is assembled — inbound
 *  server middleware and outbound clients alike. Both read the same reference,
 *  so one layer covers a surface's spans in both directions. */
export const RedactedHeaderNamesLive: Layer.Layer<never> = Layer.succeed(
  Headers.CurrentRedactedNames,
)(REDACTED_HEADER_NAMES);
