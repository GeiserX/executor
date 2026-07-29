import { describe, expect, it } from "@effect/vitest";

import { endpointForTelemetry, endpointTelemetryAttributes } from "./telemetry-endpoint";

// Synthetic placeholders only.
const QUERY_TOKEN = "synthetic-query-token";
const USERINFO_PASSWORD = "synthetic-userinfo-password";

describe("endpointForTelemetry", () => {
  it("strips a credential carried in the query string", () => {
    // The shape the MCP preset list ships and the add-flow passes through raw.
    expect(endpointForTelemetry(`https://mcp.example.test/mcp?token=${QUERY_TOKEN}`)).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("strips a credential carried in URL userinfo", () => {
    expect(endpointForTelemetry(`https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp`)).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("strips query, fragment, and userinfo together", () => {
    const scrubbed = endpointForTelemetry(
      `https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp?token=${QUERY_TOKEN}#frag`,
    );
    expect(scrubbed).toBe("https://mcp.example.test/mcp");
    expect(scrubbed).not.toContain(QUERY_TOKEN);
    expect(scrubbed).not.toContain(USERINFO_PASSWORD);
  });

  it("leaves a credential-free endpoint intact", () => {
    expect(endpointForTelemetry("https://mcp.example.test/mcp")).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("does not URL-normalize a credential-free endpoint", () => {
    // A bare origin round-tripped through URL gains a trailing slash; the
    // stamped attribute must stay byte-identical to the configured endpoint.
    expect(endpointForTelemetry("http://127.0.0.1:55003")).toBe("http://127.0.0.1:55003");
  });

  it("returns unparseable input as-is", () => {
    expect(endpointForTelemetry("not a url")).toBe("not a url");
  });
});

describe("endpointTelemetryAttributes", () => {
  it("keeps the endpoint debuggable without exposing the credential", () => {
    const attributes = endpointTelemetryAttributes(
      "mcp.endpoint",
      `https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp?token=${QUERY_TOKEN}`,
    );

    expect(attributes).toEqual({
      "mcp.endpoint": "https://mcp.example.test/mcp",
      "mcp.endpoint.origin": "https://mcp.example.test",
      "mcp.endpoint.has_query": true,
      "mcp.endpoint.has_userinfo": true,
    });
    expect(JSON.stringify(attributes)).not.toContain(QUERY_TOKEN);
    expect(JSON.stringify(attributes)).not.toContain(USERINFO_PASSWORD);
  });

  it("reports absence of both credential shapes for a plain endpoint", () => {
    expect(endpointTelemetryAttributes("mcp.endpoint", "https://mcp.example.test/mcp")).toEqual({
      "mcp.endpoint": "https://mcp.example.test/mcp",
      "mcp.endpoint.origin": "https://mcp.example.test",
      "mcp.endpoint.has_query": false,
      "mcp.endpoint.has_userinfo": false,
    });
  });
});
