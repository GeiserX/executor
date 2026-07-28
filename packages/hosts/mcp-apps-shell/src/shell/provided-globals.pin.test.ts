import { describe, expect, it } from "@effect/vitest";
import { PROVIDED_GLOBAL_NAMES } from "@executor-js/execution";

import { PROVIDED_SCOPE_NAMES } from "./component-runtime";

// The `render-ui` tool rejects code that redeclares a name the shell already
// binds. That guard lives in the MCP host (which must not import React), so the
// name list is generated into the execution package by
// `scripts/gen-provided-globals.ts`. This test is the pin: add a component to
// `components.ts` without regenerating and it fails here rather than silently
// letting a model shadow a real binding at render time.
describe("provided globals", () => {
  it("matches the scope the iframe actually binds", () => {
    expect([...PROVIDED_GLOBAL_NAMES].sort()).toEqual([...PROVIDED_SCOPE_NAMES].sort());
  });

  it("covers the names the shell is built around", () => {
    for (const name of ["React", "useState", "useQuery", "tools", "run", "Card", "cn"]) {
      expect(PROVIDED_SCOPE_NAMES).toContain(name);
    }
  });
});
