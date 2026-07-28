/**
 * The `render-ui` tool's pure half: what the model is told, and what the server
 * refuses to render.
 *
 * The tool itself lives in `tool-server.ts` beside `execute` and `skills` —
 * this module holds only the description text and the code guard, so both can
 * be tested without standing up an MCP server.
 */

import { PROVIDED_GLOBAL_NAMES } from "@executor-js/execution";

/** The MCP-Apps resource the ui-bearing tools render into. */
export const MCP_APPS_SHELL_RESOURCE_URI = "ui://executor/shell.html";

/**
 * The web-app deep link for a saved artifact — the delivery path for clients
 * that can't render MCP Apps. One helper so every host emits the same shape;
 * hosts differ only in the origin they pass, and hosts with no known origin
 * (stdio) pass none and skip the link entirely.
 */
export const artifactUrlFor =
  (webBaseUrl: string) =>
  (artifactId: string): string =>
    new URL(`/artifacts/${encodeURIComponent(artifactId)}`, webBaseUrl).toString();

// ---------------------------------------------------------------------------
// Code guard
// ---------------------------------------------------------------------------
//
// Generated code is evaluated inside the shell with ~280 names already bound as
// function parameters (React hooks, TanStack Query, every shadcn/Recharts/Lucide
// export, `tools`, `run`). A `const Card = ...` in the model's source shadows
// the real binding and the component renders as a blank frame with a confusing
// runtime error — so we reject redeclarations before the code ever reaches the
// iframe, with a message that tells the model what to do instead.
//
// This is deliberately NOT a general "is this good code" check. The donor branch
// also rejected array literals whose variable name looked data-ish
// (`const rows = [{...},{...}]`), which false-positives on legitimate display
// constants — chart configs, tab definitions, column headers. That heuristic is
// dropped; the "fetch live data with useQuery" guidance lives in the skill.

const REACT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*React\b/s;

const OBJECT_DESTRUCTURING_DECLARATION = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/gs;

const PROVIDED_GLOBAL_DECLARATION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bclass\s+([A-Za-z_$][\w$]*)\b/g;

const firstDefined = (...values: Array<string | undefined>): string | undefined =>
  values.find((value): value is string => value !== undefined);

const localDestructuredName = (part: string): string | undefined => {
  const binding = part
    .replace(/^\s*\.\.\./, "")
    .split("=")[0]
    ?.trim();
  const alias = binding?.match(/:\s*([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return alias ?? binding?.match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
};

/** `null` when the code may be rendered, otherwise the reason to hand back. */
export const validateRenderUiCode = (code: string): string | null => {
  if (REACT_DESTRUCTURING_DECLARATION.test(code)) {
    return [
      "Do not destructure React in render-ui.",
      "Hooks such as useState are already in scope; use useState(...) directly or React.useState(...).",
    ].join(" ");
  }

  for (const match of code.matchAll(OBJECT_DESTRUCTURING_DECLARATION)) {
    const names = match[1]?.split(",").flatMap((part) => {
      const name = localDestructuredName(part);
      return name ? [name] : [];
    });
    const providedName = names?.find((name) => PROVIDED_GLOBAL_NAMES.has(name));
    if (providedName) {
      return [
        `Provided global "${providedName}" is already in scope and cannot be redeclared.`,
        "Remove the destructuring declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  for (const match of code.matchAll(PROVIDED_GLOBAL_DECLARATION)) {
    const name = firstDefined(match[1], match[2], match[3]);
    if (name && PROVIDED_GLOBAL_NAMES.has(name)) {
      return [
        `Provided global "${name}" is already in scope and cannot be redeclared.`,
        "Remove the local declaration and use the provided global directly.",
      ].join(" ");
    }
  }

  return null;
};
