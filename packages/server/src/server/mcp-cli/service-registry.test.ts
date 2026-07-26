import { describe, expect, it } from "vitest";
import { oauthClientsRegistry } from "./service.js";

describe("oauthClientsRegistry", () => {
  it("writes http open, http oauth, and stdio rows", () => {
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
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "foo"],
        enabled: true,
      },
      { name: "off", transport: "http", url: "https://x", enabled: false },
    ]);
    expect(registry.open).toEqual({ transport: "http", source: "https://example.com/mcp" });
    expect(registry.figma).toMatchObject({
      transport: "http",
      source: "https://mcp.figma.com/mcp",
      oauth_client_id: "cid",
    });
    expect(registry.local).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });
    expect(registry.off).toBeUndefined();
  });
});
