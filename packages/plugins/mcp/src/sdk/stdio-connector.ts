// ---------------------------------------------------------------------------
// Stdio transport factory — loaded only on demand
// ---------------------------------------------------------------------------
//
// Kept in its own module so `connection.ts` never imports it eagerly at
// module load. The v2 `@modelcontextprotocol/client/stdio` entry still eagerly
// evaluates Node-only process/stream imports and `cross-spawn` (which loads
// `node:child_process`); under `@cloudflare/vitest-pool-workers`
// that crashes workerd at module instantiation with SIGSEGV (prod bundles
// tree-shake it away when `dangerouslyAllowStdioMCP: false`, tests do not).
//
// Callers that actually need stdio transport reach it via a dynamic import
// in `connection.ts`. Remote-only consumers (cloud/marketing) never execute
// the import and therefore never touch `node:child_process`.
// ---------------------------------------------------------------------------

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type StdioTransportConfig = {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
};

/**
 * Host variables a stdio server inherits, on top of the SDK's own safe-list.
 *
 * Same reasoning and same list as the TLS pass-through `service install` bakes
 * into a supervised unit's minimal environment (`apps/cli/src/service.ts`): a
 * stdio server sits behind the same corporate proxy and the same intercepting
 * CA as the process that spawned it, and those paths commonly live outside the
 * OS trust store. Dropping them makes every HTTPS call from every stdio server
 * fail on such a network. None of them carries a credential.
 *
 * Deliberately short and closed. Anything else a server needs — an API key
 * above all — is declared on the source config's `env`, which is the mechanism
 * that already exists for exactly that, and which wins on a key collision.
 */
const inheritedEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // Lowercase spellings are not aliases: libcurl and most Unix tooling read
  // these, while Node reads the uppercase ones. Both are in real use.
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Read at spawn time, not module load: the host's proxy configuration can be
 *  set after this module is first imported. */
const inheritedEnv = (): Record<string, string> =>
  Object.fromEntries(
    inheritedEnvKeys.flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value] as const] : [];
    }),
  );

export const createStdioTransport = (config: StdioTransportConfig) =>
  new StdioClientTransport({
    command: config.command,
    args: config.args ? [...config.args] : undefined,
    // Pass the declared env plus the infrastructure allowlist above, and
    // nothing else. The SDK merges this over `getDefaultEnvironment()`, a
    // sudo-style safe-list (HOME, LOGNAME, PATH, SHELL, TERM, USER) that
    // deliberately excludes everything else and skips function-shaped values
    // as a security risk.
    //
    // Spreading `process.env` here did not add to that safe-list, it defeated
    // it: the child received every variable this process holds, which for a
    // server that spawns one includes `EXECUTOR_SECRET_KEY` (the key that
    // decrypts the secret store), `EXECUTOR_AUTH_TOKEN`, `DATABASE_URL` and
    // whatever else the operator exported.
    env: { ...inheritedEnv(), ...config.env },
    cwd: config.cwd,
  });
