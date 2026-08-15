// What environment does a stdio MCP server actually receive?
//
// This spawns a real subprocess through the real transport and reads back the
// environment that process was handed. Asserting on the arguments we pass to
// the SDK would not answer the question — the SDK merges its own safe-list
// underneath ours, so the only honest answer comes from the child itself.
//
// The child is a plain node script rather than an MCP server: it is spawned by
// the same code path either way, and speaking the protocol would add nothing
// to what is being measured. It never completes a handshake, so the transport
// is closed once the file has been written.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createStdioTransport } from "./stdio-connector";

/** A variable only this test sets, standing in for a real one like
 *  `EXECUTOR_SECRET_KEY`. Using a fake keeps the test honest on a machine
 *  where the real one happens not to be set. */
const HOST_ONLY_SECRET = "EXECUTOR_TEST_HOST_ONLY_SECRET";
const HOST_ONLY_VALUE = "host-secret-that-must-not-reach-a-child";

const dirs: string[] = [];

afterEach(() => {
  delete process.env[HOST_ONLY_SECRET];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawn a child through the transport and return the environment it saw. */
const envSeenByChild = async (
  declared: Record<string, string> | undefined,
): Promise<Record<string, string>> => {
  const dir = mkdtempSync(join(tmpdir(), "executor-stdio-env-"));
  dirs.push(dir);
  const out = join(dir, "env.json");

  const transport = createStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
      out,
    ],
    env: declared,
  });

  await transport.start();
  // The child writes and exits; poll briefly rather than assuming timing.
  for (let i = 0; i < 100 && !existsSync(out); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await transport.close();

  // oxlint-disable-next-line executor/no-json-parse -- boundary: reading back the raw env dump this test's own child process just wrote; the value is only key-checked, never decoded into domain types
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
};

describe("environment handed to a stdio MCP subprocess", () => {
  it("does not leak a host secret to a server that declares its own env", async () => {
    // The declared-env branch is the one that matters: it is the branch a
    // credential-bearing integration takes, and it was the leaking one.
    process.env[HOST_ONLY_SECRET] = HOST_ONLY_VALUE;

    const childEnv = await envSeenByChild({ DECLARED_TOKEN: "declared-value" });

    expect(childEnv[HOST_ONLY_SECRET]).toBeUndefined();
    // ...and the thing the integration actually asked for still arrives.
    expect(childEnv.DECLARED_TOKEN).toBe("declared-value");
  });

  it("does not leak a host secret to a server that declares no env", async () => {
    process.env[HOST_ONLY_SECRET] = HOST_ONLY_VALUE;

    const childEnv = await envSeenByChild(undefined);

    expect(childEnv[HOST_ONLY_SECRET]).toBeUndefined();
  });

  it("still provides the SDK's safe-list, so servers keep working", async () => {
    // The fix must not strand servers that legitimately need PATH to find
    // their own interpreter. The SDK's list is what supplies it.
    const childEnv = await envSeenByChild({ DECLARED_TOKEN: "declared-value" });

    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.HOME).toBeDefined();
  });

  it("POSITIVE CONTROL: the child does report a variable when it is passed one", async () => {
    // Proves the measurement works. Without this, a child that failed to
    // write, or wrote an empty object, would satisfy every assertion above.
    process.env[HOST_ONLY_SECRET] = HOST_ONLY_VALUE;

    const childEnv = await envSeenByChild({ [HOST_ONLY_SECRET]: HOST_ONLY_VALUE });

    expect(childEnv[HOST_ONLY_SECRET]).toBe(HOST_ONLY_VALUE);
  });
});
