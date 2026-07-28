/**
 * The MCP-Apps shell: the trusted iframe host that renders model-written JSX.
 *
 * The shell reaches MCP clients as a single self-contained HTML document (the
 * `ui://executor/shell.html` resource). Hosts read it with
 * `loadMcpAppsShellHtml` and hand it to the MCP host through the
 * `loadAppShellHtml` config seam — the MCP host never imports this package
 * directly, so React/Recharts/Tailwind stay out of the Workers graph.
 */

export { loadMcpAppsShellHtml, MCP_APPS_SHELL_NOT_BUILT_HTML } from "./shell-html";
