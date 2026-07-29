// ---------------------------------------------------------------------------
// OAuth 2.0 helpers — generic, isomorphic building blocks.
//
// Thin wrappers around `oauth4webapi` (stateless; pure Web Crypto +
// `fetch`, no deps; runs unchanged in Node, CF Workers, and browsers).
// Each public helper is a single `Effect.tryPromise` call that delegates
// the RFC work to the library and normalises the failure surface into
// `OAuth2Error`.
//
// What stays hand-rolled:
//   - `OAuth2Error` — our tagged error; we want a stable shape across
//     every token-endpoint call
//   - `shouldRefreshToken` — skew check, trivial
//   - `buildAuthorizationUrl` — the library doesn't expose a raw
//     authorization-URL builder (it prefers PAR); a 30-line manual
//     construction keeps the call sync and lets callers opt out of PAR
// ---------------------------------------------------------------------------

import { Data, Effect, Option, Predicate, Redacted, Schema } from "effect";
import * as oauth from "oauth4webapi";

import { endpointForTelemetry } from "./telemetry-endpoint";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuth2Error extends Data.TaggedError("OAuth2Error")<{
  readonly message: string;
  /**
   * RFC 6749 §5.2 error code, when the token endpoint returned one
   * (`invalid_grant`, `invalid_client`, `unauthorized_client`, ...).
   * Callers use this to distinguish terminal failures (a refresh token
   * the AS no longer honours → re-auth required) from transient ones.
   */
  readonly error?: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Token response shape (RFC 6749 §5.1)
// ---------------------------------------------------------------------------

/** Token material a caller hands one of these helpers. Widened to accept a bare
 *  string as well as `Redacted` so a value that never left the process (a code
 *  straight off the callback query string, a pasted secret) does not have to be
 *  wrapped first. Outputs are always `Redacted` — the guarantee lives there. */
export type OAuth2SecretInput = string | Redacted.Redacted<string>;

/** Unwrap at an allowlisted boundary: `oauth4webapi` takes bare strings and puts
 *  them on the wire. Every call site is a form field or an HTTP header. */
const secretToSend = (value: OAuth2SecretInput): string =>
  // oxlint-disable-next-line executor/no-redacted-unwrap -- boundary: `oauth4webapi` takes bare strings; every call site is a form field or an HTTP header
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

export type OAuth2TokenResponse = {
  /** Wrapped at construction (`tokenResponseFrom`) so the minted token cannot
   *  reach a log, a span attribute, or an error payload without an explicit
   *  `Redacted.value`. Unwrap only at a persistence or wire line — a missed
   *  unwrap does not throw, it writes the literal "<redacted>". */
  readonly access_token: Redacted.Redacted<string>;
  readonly token_type?: string;
  readonly refresh_token?: Redacted.Redacted<string>;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly idTokenIdentityLabel?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh tokens this many ms before expiry to avoid mid-request expiration. */
export const OAUTH2_REFRESH_SKEW_MS = 60_000;

/** Default token-endpoint timeout. */
export const OAUTH2_DEFAULT_TIMEOUT_MS = 20_000;

export interface OAuthEndpointUrlPolicy {
  readonly allowHttp?: boolean;
}

export const isLoopbackHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
};

export const isSupportedOAuthEndpointUrl = (
  value: string,
  policy: OAuthEndpointUrlPolicy = {},
): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    isLoopbackHttpUrl(value) ||
    (url.protocol === "http:" && policy.allowHttp === true)
  );
};

export const assertSupportedOAuthEndpointUrl = (
  value: string,
  label = "OAuth endpoint URL",
  policy: OAuthEndpointUrlPolicy = {},
): string => {
  if (isSupportedOAuthEndpointUrl(value, policy)) return value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous assertion helper used by URL constructors and Effect.try wrappers
  throw new TypeError(`${label} must use https: or loopback http:`);
};

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — straight delegation to `oauth4webapi`
// ---------------------------------------------------------------------------

/** The PKCE verifier is grant material: whoever holds it plus the authorization
 *  code can redeem the token. Wrapped for its whole in-memory life; the only
 *  unwraps are the challenge computation below and the session-row write. */
export const createPkceCodeVerifier = (): Redacted.Redacted<string> =>
  Redacted.make(oauth.generateRandomCodeVerifier());

/** The challenge is a public S256 hash of the verifier (it travels in the
 *  authorize URL), so it comes back bare. */
export const createPkceCodeChallenge = (verifier: OAuth2SecretInput): Promise<string> =>
  oauth.calculatePKCECodeChallenge(secretToSend(verifier));

/** RFC 6749 `state` — an unguessable correlation token minted by `oauth.start`
 *  and redeemed by `oauth.complete`. Wrapped like the verifier: it is the
 *  session's bearer key, and it is persisted and echoed through the provider. */
export const createOAuthState = (): Redacted.Redacted<string> =>
  Redacted.make(oauth.generateRandomState());

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

export type BuildAuthorizationUrlInput = {
  readonly authorizationUrl: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  /** Pre-computed base64url S256 challenge (from `createPkceCodeChallenge`). */
  readonly codeChallenge: string;
  /** Separator between scopes. RFC 6749 says space; some providers use comma. */
  readonly scopeSeparator?: string;
  /** RFC 8707 Resource Indicator. MCP Authorization 2025-06-18 §"Resource
   *  Parameter Implementation" requires clients to send this on every
   *  authorization request, regardless of AS support. */
  readonly resource?: string;
  /** Provider-specific extras (e.g. Google's `access_type=offline`). */
  readonly extraParams?: Readonly<Record<string, string>>;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
};

/** Build an RFC 6749 §4.1.1 authorization URL. Sync; pre-computed
 *  challenge lets this stay out of the Promise world. */
export const buildAuthorizationUrl = (input: BuildAuthorizationUrlInput): string => {
  const url = new URL(
    assertSupportedOAuthEndpointUrl(
      input.authorizationUrl,
      "Authorization URL",
      input.endpointUrlPolicy,
    ),
  );
  // Benign default kept by design: a single space is the RFC 6749 scope
  // separator. Callers targeting a legacy comma-separated provider pass
  // `scopeSeparator` explicitly (see the field's JSDoc).
  const separator = input.scopeSeparator ?? " ";
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(separator));
  }
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", input.codeChallenge);
  if (input.resource) {
    url.searchParams.set("resource", input.resource);
  }
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

/** Provider-specific authorize-URL extras that are NOT RFC 6749 params, so the
 *  generic flow must add them per-provider (keyed off the authorization host).
 *
 *  Google: `access_type=offline` + `prompt=consent` are required to receive (and
 *  keep receiving, across reconnects / scope changes) a REFRESH TOKEN — without
 *  them Google issues an access-token-only grant that dies in ~1h and a
 *  re-consent can silently keep the old scope set. Do not add
 *  `include_granted_scopes=true` here: with historical grants on the same Google
 *  consent app, Google folds those unrelated scopes into the new consent flow and
 *  can fail inside accounts.google.com before returning to our callback. */
export const providerAuthorizeExtras = (
  authorizationUrl: string,
): Readonly<Record<string, string>> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL() throws on invalid input → no provider extras
  try {
    const host = new URL(authorizationUrl).host.toLowerCase();
    if (host === "accounts.google.com") {
      return { access_type: "offline", prompt: "consent" };
    }
  } catch {
    // Unparseable authorization URL — let buildAuthorizationUrl surface the error.
  }
  return {};
};

// ---------------------------------------------------------------------------
// Regional token-endpoint rebind
//
// Some authorization servers publish a single static metadata document that
// advertises one region's token endpoint, but issue authorization codes that
// are only redeemable at the *regional* host the user's org actually lives on.
// The region comes back on the callback as a non-standard `domain` (or `site`)
// query param: Datadog returns `domain=us5.datadoghq.com` while its metadata
// statically advertises `app.datadoghq.com`. Redeeming the code at the
// advertised host then fails with `invalid_grant`.
//
// `rebindTokenEndpointHostToCallbackDomain` swaps ONLY the hostname of the
// configured token URL to the callback-supplied host, and ONLY when that host
// is a sibling subdomain of the configured one (same parent after stripping the
// leftmost DNS label, e.g. `app.datadoghq.com` and `us5.datadoghq.com` both
// reduce to `datadoghq.com`). The token request carries the client secret, the
// code, and the PKCE verifier, so an attacker-influenced `domain` must never be
// able to point it at an arbitrary origin. Anything that fails the sibling
// check, fails to parse, or isn't https falls back to the configured URL
// unchanged.
// ---------------------------------------------------------------------------

const hostnameFromCallbackDomain = (callbackDomain: string): string | undefined => {
  const trimmed = callbackDomain.trim();
  if (trimmed.length === 0) return undefined;
  // Datadog sends `domain` as a bare host and `site` as a full origin; accept
  // either by tolerating an optional scheme, then taking only the hostname.
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  // A legitimate regional host carries no port, credentials, or path.
  if (url.port !== "" || url.username !== "" || url.password !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.hostname.toLowerCase();
};

/** Parent domain after stripping the leftmost DNS label, or `undefined` when
 *  the host has no sibling space (a single label, or a parent that is a bare
 *  TLD). `app.datadoghq.com` -> `datadoghq.com`; `foo.com` -> undefined. */
const siblingParentDomainOf = (hostname: string): string | undefined => {
  const labels = hostname.split(".");
  if (labels.length < 3) return undefined;
  const parent = labels.slice(1).join(".");
  // Require the parent to itself be multi-label so a 2-label configured host
  // can never rebind across an entire TLD (e.g. foo.com -> bar.com).
  return parent.includes(".") ? parent : undefined;
};

export const rebindTokenEndpointHostToCallbackDomain = (
  configuredTokenUrl: string,
  callbackDomain: string | null | undefined,
): string => {
  if (!callbackDomain) return configuredTokenUrl;
  if (!URL.canParse(configuredTokenUrl)) return configuredTokenUrl;
  const configured = new URL(configuredTokenUrl);
  if (configured.protocol !== "https:") return configuredTokenUrl;
  const targetHost = hostnameFromCallbackDomain(callbackDomain);
  if (!targetHost) return configuredTokenUrl;
  const configuredHost = configured.hostname.toLowerCase();
  if (targetHost === configuredHost) return configuredTokenUrl;
  const configuredParent = siblingParentDomainOf(configuredHost);
  const targetParent = siblingParentDomainOf(targetHost);
  if (!configuredParent || !targetParent || configuredParent !== targetParent) {
    return configuredTokenUrl;
  }
  const rebound = new URL(configuredTokenUrl);
  rebound.hostname = targetHost;
  return rebound.toString();
};

// ---------------------------------------------------------------------------
// Error mapping — `oauth4webapi`'s `process*Response` failure shapes are
// either a WWW-Authenticate challenge or an RFC 6749 §5.2 error body,
// both exposed via `.error` / `.error_description`. Probing the envelope
// preserves RFC 6749 error-code semantics (e.g., mapping `invalid_grant`
// to reauth-required) across wrappers.
// ---------------------------------------------------------------------------

const isOAuth2Error = Predicate.isTagged("OAuth2Error") as (cause: unknown) => cause is OAuth2Error;

const responseFromOAuthErrorCause = (cause: unknown): Response | undefined => {
  if (cause instanceof Response) return cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const envelope = cause as {
    readonly cause?: unknown;
    readonly response?: unknown;
  };
  if (envelope.response instanceof Response) return envelope.response;
  if (envelope.cause instanceof Response) return envelope.cause;
  return undefined;
};

// Every credential a token endpoint can echo back, in both wire encodings it
// can echo them in: JSON and form-urlencoded. `code`, `code_verifier`,
// `device_code`, and the `*assertion` family are grant material — a leaked one
// is redeemable, exactly like a token. `client_assertion_type` and
// `code_challenge` are deliberately absent: the first is a public URN, the
// second is a hash of a verifier that is itself redacted.
const CREDENTIAL_BODY_KEYS =
  "access_token|refresh_token|id_token|client_secret|code_verifier|assertion|client_assertion|device_code";

const redactTokenEndpointBody = (body: string): string =>
  body
    .replaceAll(
      new RegExp(`("(?:${CREDENTIAL_BODY_KEYS})"\\s*:\\s*")[^"]*(")`, "gi"),
      "$1[redacted]$2",
    )
    // A JSON `code` is an authorization code EXCEPT inside an RFC 6749 §5.2
    // error object, where providers spell their error label
    // `{"error":{"code":"invalid_client_id"}}`. That label is the diagnostic
    // point of the summary, so it is the one exemption — matching the `"error":{`
    // prefix keeps the match whole and unreplaced; a `code` anywhere else is
    // redacted.
    .replaceAll(
      /("error"\s*:\s*\{\s*)?("code"\s*:\s*")[^"]*(")/gi,
      (match, errorPrefix, key, close) =>
        errorPrefix === undefined ? `${key}[redacted]${close}` : match,
    )
    .replaceAll(new RegExp(`((?:${CREDENTIAL_BODY_KEYS}|code)=)[^&\\s]*`, "gi"), "$1[redacted]");

const CREDENTIAL_KEY_PATTERN = new RegExp(`^(?:${CREDENTIAL_BODY_KEYS})$`, "i");

/** The cause an `OAuth2Error` carries is the raw failure oauth4webapi threw, and
 *  for an RFC 6749 §5.2 rejection that object holds the endpoint's PARSED error
 *  body — which echoes the grant it rejected. The `message` is summarized
 *  through `redactTokenEndpointBody`, but the cause is not, and anything that
 *  serializes the failure (a log line, an error payload, `JSON.stringify` of the
 *  Effect cause) republishes those credentials verbatim.
 *
 *  So the cause is projected into a plain object with every credential-named
 *  leaf replaced, keeping the diagnostics (`error`, `error_description`,
 *  `status`, `name`) that make it worth attaching. `Response` instances pass
 *  through untouched: their body is not enumerable, and the summary already
 *  quoted a redacted preview of it. */
const redactErrorCause = (
  cause: unknown,
  /** True when `cause` is the value of an `error` key, where a `code` entry is
   *  the provider's error LABEL (`{"error":{"code":"invalid_client_id"}}`) and
   *  not an authorization code. Same exemption `redactTokenEndpointBody` makes
   *  for the text form, spelled structurally. */
  insideErrorObject = false,
  seen: ReadonlySet<object> = new Set(),
): unknown => {
  if (cause instanceof Response) return cause;
  if (seen.has(cause as object)) return "[circular]";
  if (Array.isArray(cause)) {
    const next = new Set([...seen, cause]);
    return cause.map((entry) => redactErrorCause(entry, false, next));
  }
  if (!Predicate.isObject(cause)) return cause;
  const next = new Set([...seen, cause]);
  const redacted = Object.fromEntries(
    Object.entries(cause).map(([key, value]) => [
      key,
      CREDENTIAL_KEY_PATTERN.test(key) || (key === "code" && !insideErrorObject)
        ? "[redacted]"
        : redactErrorCause(value, key === "error", next),
    ]),
  );
  // oxlint-disable-next-line executor/no-instanceof-error -- boundary: `cause` is the untyped value oauth4webapi threw; narrowing it is how the diagnostics below are recovered
  if (!(cause instanceof Error)) return redacted;
  // `name`, `message`, and `stack` are non-enumerable on an Error, so the
  // projection above drops them — and for a transport failure they are the ONLY
  // diagnostic (a native fetch TypeError has no enumerable own property at
  // all). Carry them explicitly, with the message scrubbed the same way the
  // HTTP summary scrubs a body: a library that quotes a rejected field in its
  // message must not smuggle the value back in through the cause.
  return {
    ...redacted,
    name: cause.name,
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: narrowed to Error above; the message is scrubbed, not interpreted
    message: redactTokenEndpointBody(cause.message),
    ...(cause.stack === undefined ? {} : { stack: cause.stack }),
  };
};

const tokenEndpointHttpSummary = async (response: Response): Promise<string> => {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const contentType = response.headers.get("content-type");
  // The token endpoint is configured per OAuth client and can carry credentials
  // in its query string; this summary lands in a user-visible error message.
  const url = response.url ? ` from ${endpointForTelemetry(response.url)}` : "";
  const parts = [`${status}${url}`];
  if (contentType) parts.push(`content-type ${contentType}`);
  const preview = await bodyPreviewFromResponse(response);
  if (preview) parts.push(`body: ${preview}`);
  return parts.join("; ");
};

const bodyPreviewFromResponse = async (response: Response): Promise<string | undefined> => {
  const text = await Promise.resolve()
    .then(() => response.clone().text())
    .then(
      (value) => value.trim(),
      () => "",
    );
  if (!text) return undefined;
  const redacted = redactTokenEndpointBody(text.replaceAll(/\s+/g, " "));
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
};

const toOAuth2Error = (cause: unknown): OAuth2Error => {
  if (isOAuth2Error(cause)) return cause;
  if (typeof cause === "object" && cause !== null) {
    const c = cause as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const code = typeof c.error === "string" ? c.error : undefined;
    const description =
      typeof c.error_description === "string"
        ? c.error_description
        : typeof c.message === "string"
          ? c.message
          : undefined;
    return new OAuth2Error({
      message: `OAuth token exchange failed: ${description ?? code ?? "unknown error"}`,
      error: code,
      cause: redactErrorCause(cause),
    });
  }
  return new OAuth2Error({
    message: "OAuth token exchange failed",
    cause,
  });
};

const toOAuth2ErrorWithHttpSummary = (cause: unknown): Effect.Effect<OAuth2Error> => {
  if (isOAuth2Error(cause)) return Effect.succeed(cause);
  const base = toOAuth2Error(cause);
  const response = responseFromOAuthErrorCause(cause);
  if (!response) return Effect.succeed(base);
  return Effect.promise(() => tokenEndpointHttpSummary(response)).pipe(
    Effect.map(
      (summary) =>
        new OAuth2Error({
          message: `${base.message} (${summary})`,
          error: base.error,
          cause: base.cause,
        }),
    ),
  );
};

const failOAuth2WithHttpSummary = (cause: unknown): Effect.Effect<never, OAuth2Error> =>
  toOAuth2ErrorWithHttpSummary(cause).pipe(Effect.flatMap((error) => Effect.fail(error)));

// ---------------------------------------------------------------------------
// oauth4webapi adapter helpers
// ---------------------------------------------------------------------------

export type ClientAuthMethod = "body" | "basic";

/**
 * The token-endpoint client-auth transport used when a caller doesn't specify
 * one. `"body"` is `client_secret_post` (the secret in the form body) — the
 * method our DCR registers (`token_endpoint_auth_method: client_secret_post`)
 * and the one every confidential client in the v2 model uses. EXPLICIT and
 * documented rather than a hidden inline `?? "body"`: callers that need
 * `client_secret_basic` pass `clientAuth: "basic"`. For PUBLIC clients (no
 * secret) the method is irrelevant — `pickClientAuth` returns `None()`.
 */
export const DEFAULT_CLIENT_AUTH_METHOD: ClientAuthMethod = "body";

const asFromTokenUrl = (
  tokenUrl: string,
  endpointUrlPolicy: OAuthEndpointUrlPolicy = {},
): oauth.AuthorizationServer => {
  assertSupportedOAuthEndpointUrl(tokenUrl, "Token URL", endpointUrlPolicy);
  const url = new URL(tokenUrl);
  return {
    issuer: `${url.protocol}//${url.host}`,
    token_endpoint: tokenUrl,
  };
};

const asFromTokenUrlAndIssuer = (
  tokenUrl: string,
  issuerUrl: string | null | undefined,
  options: {
    readonly idTokenSigningAlgValuesSupported?: readonly string[];
    readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  } = {},
): oauth.AuthorizationServer => {
  const as = asFromTokenUrl(tokenUrl, options.endpointUrlPolicy);
  const withIssuer = issuerUrl ? { ...as, issuer: issuerUrl } : as;
  return options.idTokenSigningAlgValuesSupported
    ? {
        ...withIssuer,
        id_token_signing_alg_values_supported: [...options.idTokenSigningAlgValuesSupported],
      }
    : withIssuer;
};

const oauth4webapiRequestOptions = (
  targetUrl: string,
  timeoutMs: number | undefined,
  endpointUrlPolicy: OAuthEndpointUrlPolicy = {},
  customFetch?: typeof globalThis.fetch,
): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    signal: AbortSignal.timeout(timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
  };
  if (customFetch) {
    (options as { [oauth.customFetch]?: typeof globalThis.fetch })[oauth.customFetch] = customFetch;
  }
  if (
    isLoopbackHttpUrl(targetUrl) ||
    (URL.canParse(targetUrl) &&
      new URL(targetUrl).protocol === "http:" &&
      endpointUrlPolicy.allowHttp === true)
  ) {
    (options as { [oauth.allowInsecureRequests]?: boolean })[oauth.allowInsecureRequests] = true;
  }
  return options;
};

// Select the token-endpoint client authentication. The secret's presence is the
// EXPLICIT public-vs-confidential discriminator in the v2 model: a registered
// client either has a secret (confidential — authenticate it) or has none
// (public PKCE — `None()`, RFC 7636). Presence is spelled `null`, tested
// explicitly: an empty-string secret can never reach here (the boundary
// normalizes it to null), and testing falsiness would misclassify one as
// public rather than failing on the malformed row. The `method` only chooses
// HOW a present secret is sent (post vs basic).
const pickClientAuth = (
  clientSecret: OAuth2SecretInput | null | undefined,
  method: ClientAuthMethod,
): oauth.ClientAuth => {
  if (clientSecret == null) return oauth.None();
  // Boundary: oauth4webapi puts the secret in the form body / Basic header.
  const secret = secretToSend(clientSecret);
  return method === "basic" ? oauth.ClientSecretBasic(secret) : oauth.ClientSecretPost(secret);
};

const tokenResponseFrom = (r: oauth.TokenEndpointResponse): OAuth2TokenResponse => ({
  access_token: Redacted.make(r.access_token),
  token_type: r.token_type,
  // Presence is `undefined`, never falsiness: `Redacted.make("")` is truthy, so
  // every downstream test asks whether the field is present. oauth4webapi has
  // already rejected an empty `refresh_token` by this point.
  refresh_token: r.refresh_token === undefined ? undefined : Redacted.make(r.refresh_token),
  expires_in: typeof r.expires_in === "number" ? r.expires_in : undefined,
  scope: r.scope,
});

const JwtClaims = Schema.Record(Schema.String, Schema.Unknown);
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims));

const stringClaim = (
  claims: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = claims[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const decodeJwtPayload = (token: string): Readonly<Record<string, unknown>> | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return null;
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  // atob yields latin1 code units; JWT payloads are UTF-8 bytes, so re-decode
  // them properly or non-ASCII claim values (accented emails, names) garble.
  const utf8 = new TextDecoder().decode(
    Uint8Array.from(globalThis.atob(padded), (char) => char.charCodeAt(0)),
  );
  const decoded = decodeJwtClaims(utf8);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const idTokenIdentityLabel = (idToken: string | undefined): string | undefined => {
  if (!idToken) return undefined;
  const claims = decodeJwtPayload(idToken);
  if (!claims) return undefined;
  return (
    stringClaim(claims, "email") ??
    stringClaim(claims, "preferred_username") ??
    stringClaim(claims, "sub")
  );
};

type StrippedTokenResponse = {
  readonly response: Response;
  readonly idTokenIdentityLabel?: string;
};

// MCP source connections are pure OAuth 2.0. Some providers (PostHog, etc.)
// front an OIDC backend and emit an `id_token` anyway; oauth4webapi then
// strict-validates its claims against the AS metadata and rejects mismatches we
// don't care about. Strip the field before delegation, after extracting the
// optional display label when the token endpoint returned OIDC account claims.
const stripIdToken = async (response: Response): Promise<StrippedTokenResponse> => {
  const body = await response
    .clone()
    .json()
    .then(
      (value: unknown) => value,
      () => null,
    );
  if (!body || typeof body !== "object" || !("id_token" in (body as Record<string, unknown>))) {
    return { response };
  }
  const { id_token: idToken, ...rest } = body as Record<string, unknown>;
  const label = typeof idToken === "string" ? idTokenIdentityLabel(idToken) : undefined;
  return {
    response: new Response(JSON.stringify(rest), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    ...(label ? { idTokenIdentityLabel: label } : {}),
  };
};

const processTokenEndpointResponse = async (
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
): Promise<OAuth2TokenResponse> => {
  const stripped = await stripIdToken(response);
  const token = tokenResponseFrom(
    await oauth.processGenericTokenEndpointResponse(as, client, stripped.response),
  );
  return stripped.idTokenIdentityLabel
    ? { ...token, idTokenIdentityLabel: stripped.idTokenIdentityLabel }
    : token;
};

// ---------------------------------------------------------------------------
// Exchange authorization code → tokens
// ---------------------------------------------------------------------------

export type ExchangeAuthorizationCodeInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: OAuth2SecretInput | null;
  readonly redirectUrl: string;
  readonly codeVerifier: OAuth2SecretInput;
  readonly code: OAuth2SecretInput;
  readonly clientAuth?: ClientAuthMethod;
  readonly idTokenSigningAlgValuesSupported?: readonly string[];
  /** RFC 8707 Resource Indicator. MCP Auth spec MUST-requires this on
   *  the token request when the client knows the resource it intends
   *  to call. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

export const exchangeAuthorizationCode = (
  input: ExchangeAuthorizationCodeInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
        idTokenSigningAlgValuesSupported: input.idTokenSigningAlgValuesSupported,
        endpointUrlPolicy: input.endpointUrlPolicy,
      });
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
      // `authorizationCodeGrantRequest` requires its `callbackParameters`
      // to have been returned from `validateAuthResponse`. Our public API
      // takes the `code` directly (the UI already validated `state` by
      // looking up the session), so skip the library's state-validation
      // rail and go through the generic grant request instead.
      // Boundary: both go out as RFC 6749 form fields.
      const params = new URLSearchParams({
        code: secretToSend(input.code),
        redirect_uri: input.redirectUrl,
        code_verifier: secretToSend(input.codeVerifier),
      });
      if (input.resource) {
        params.set("resource", input.resource);
      }
      const response = await oauth.genericTokenEndpointRequest(
        as,
        client,
        clientAuth,
        "authorization_code",
        params,
        oauth4webapiRequestOptions(
          input.tokenUrl,
          input.timeoutMs,
          input.endpointUrlPolicy,
          input.fetch,
        ),
      );
      return await processTokenEndpointResponse(as, client, response);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Exchange client credentials → tokens (RFC 6749 §4.4)
// ---------------------------------------------------------------------------

export type ExchangeClientCredentialsInput = {
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Null for a client the AS registered without a secret; the grant then goes
   *  out unauthenticated and the AS decides. Never `""` — see `OAuthClient`. */
  readonly clientSecret: OAuth2SecretInput | null;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  /** RFC 8707 Resource Indicator. MCP Authorization 2025-06-18 requires this
   *  on token requests when the client knows the protected resource. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

export const exchangeClientCredentials = (
  input: ExchangeClientCredentialsInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrl(input.tokenUrl, input.endpointUrlPolicy);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
      const params = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        params.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      if (input.resource) {
        params.set("resource", input.resource);
      }
      const response = await oauth.clientCredentialsGrantRequest(
        as,
        client,
        clientAuth,
        params,
        oauth4webapiRequestOptions(
          input.tokenUrl,
          input.timeoutMs,
          input.endpointUrlPolicy,
          input.fetch,
        ),
      );
      const result = await oauth.processClientCredentialsResponse(as, client, response);
      return tokenResponseFrom(result);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Refresh access token
// ---------------------------------------------------------------------------

export type RefreshAccessTokenInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: OAuth2SecretInput | null;
  readonly refreshToken: OAuth2SecretInput;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly idTokenSigningAlgValuesSupported?: readonly string[];
  /** RFC 8707 Resource Indicator — MCP spec MUST-requires this on
   *  refresh requests so the new access token's audience is bound to
   *  the same resource. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

export const refreshAccessToken = (
  input: RefreshAccessTokenInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
        idTokenSigningAlgValuesSupported: input.idTokenSigningAlgValuesSupported,
        endpointUrlPolicy: input.endpointUrlPolicy,
      });
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
      const extraParams = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        extraParams.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      if (input.resource) {
        extraParams.set("resource", input.resource);
      }
      const additionalParameters =
        Array.from(extraParams.keys()).length > 0 ? extraParams : undefined;
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        clientAuth,
        // Boundary: goes out as the `refresh_token` form field.
        secretToSend(input.refreshToken),
        {
          ...oauth4webapiRequestOptions(
            input.tokenUrl,
            input.timeoutMs,
            input.endpointUrlPolicy,
            input.fetch,
          ),
          additionalParameters,
        },
      );
      const result = await oauth.processRefreshTokenResponse(
        as,
        client,
        (await stripIdToken(response)).response,
      );
      return tokenResponseFrom(result);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Refresh-needed predicate
// ---------------------------------------------------------------------------

export const shouldRefreshToken = (input: {
  readonly expiresAt: number | null;
  readonly now?: number;
  readonly skewMs?: number;
}): boolean => {
  if (input.expiresAt === null) return false;
  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? OAUTH2_REFRESH_SKEW_MS;
  return input.expiresAt <= now + skew;
};
