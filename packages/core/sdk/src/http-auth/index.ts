export {
  ApiKeyAuthMethod,
  AuthCarrier,
  AuthPlacement,
  NoneAuthMethod,
  TOKEN_VARIABLE,
  apiKeyMethodLabel,
  describeApiKeyAuthMethod,
  describeNoneAuthMethod,
  normalizeAuthMethodSlugs,
  oauthBearerPlacement,
  renderAuthPlacements,
  requiredPlacementVariables,
  type RenderedAuthPlacements,
} from "./auth-method";

// Tracer header redaction — a placement can mint any header name, so the
// tracer's redacted-name list has to be widened past Effect's default.
export { REDACTED_HEADER_NAMES, RedactedHeaderNamesLive } from "./redacted-headers";

// Request-shaped authoring dialect — accepted on every plugin's auth inputs,
// normalized to canonical placements at the boundary.
export {
  ApiKeyAuthTemplate,
  AuthTemplateValue,
  apiKeyAuthTemplateFromMethod,
  apiKeyMethodFromAuthTemplate,
  isApiKeyAuthTemplate,
  variable,
  type AuthTemplateVariable,
} from "./authoring";

// Migration-only legacy vocabulary — runtime code must not use these.
export {
  LegacyApiKeyTemplate,
  LegacyTemplateValue,
  apiKeyMethodFromLegacyTemplate,
  decodeLegacyApiKeyTemplate,
} from "./legacy";
export {
  planAuthConfigMigration,
  runSqliteAuthConfigMigration,
  type AuthConfigMigrationRow,
  type AuthConfigMigrationUpdate,
  type AuthConfigTransform,
  type SqliteAuthConfigClient,
} from "./migrate";
