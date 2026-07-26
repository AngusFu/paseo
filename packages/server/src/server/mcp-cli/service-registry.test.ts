import { describe, expect, it } from "vitest";
import { oauthClientsRegistry } from "./service.js";

describe("oauthClientsRegistry", () => {
  it("writes FastMCP-shaped http open, oauth, bearer, headers, and stdio rows", () => {
    const registry = oauthClientsRegistry([
      { name: "open", transport: "http", url: "https://example.com/mcp", enabled: true },
      {
        name: "figma",
        transport: "http",
        url: "https://mcp.figma.com/mcp",
        enabled: true,
        auth: { kind: "oauth", clientId: "cid" },
      },
      {
        name: "dcr",
        transport: "http",
        url: "https://example.com/dcr",
        enabled: true,
        auth: { kind: "oauth" },
      },
      {
        name: "token",
        transport: "http",
        url: "https://example.com/bearer",
        enabled: true,
        auth: { kind: "bearer", token: "secret" },
        headers: { "X-Extra": "1" },
      },
      {
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "foo"],
        enabled: true,
      },
      { name: "off", transport: "http", url: "https://x", enabled: false },
    ]);
    expect(registry.open).toEqual({ transport: "http", url: "https://example.com/mcp" });
    expect(registry.figma).toEqual({
      transport: "http",
      url: "https://mcp.figma.com/mcp",
      auth: "oauth",
      oauth_client_id: "cid",
    });
    expect(registry.dcr).toEqual({
      transport: "http",
      url: "https://example.com/dcr",
      auth: "oauth",
    });
    expect(registry.token).toEqual({
      transport: "http",
      url: "https://example.com/bearer",
      auth: "secret",
      headers: { "X-Extra": "1" },
    });
    expect(registry.local).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });
    expect(registry.off).toBeUndefined();
  });
});
