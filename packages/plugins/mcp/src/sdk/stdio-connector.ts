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

export const createStdioTransport = (config: StdioTransportConfig) =>
  new StdioClientTransport({
    command: config.command,
    args: config.args ? [...config.args] : undefined,
    // Pass only what the integration declared. The SDK already merges this
    // over `getDefaultEnvironment()`, a sudo-style safe-list (HOME, LOGNAME,
    // PATH, SHELL, TERM, USER) that deliberately excludes everything else and
    // skips function-shaped values as a security risk.
    //
    // Spreading `process.env` here did not add to that safe-list, it defeated
    // it: the child received every variable this process holds, which for a
    // server that spawns one includes `EXECUTOR_SECRET_KEY` (the key that
    // decrypts the secret store), `EXECUTOR_AUTH_TOKEN`, `DATABASE_URL` and
    // whatever else the operator exported. A stdio server needing one of
    // those declares it in the integration's `env` like any other value.
    env: config.env,
    cwd: config.cwd,
  });
