import { describe, expect, it } from "vitest";
import { parseMcpServersJson, serializeMcpServersJson } from "./mcp-servers-json";

describe("parseMcpServersJson", () => {
  it("parses Claude-style mcpServers map with url", () => {
    const result = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          figma: { type: "http", url: "https://mcp.figma.com/mcp" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toEqual([
      { name: "figma", transport: "http", url: "https://mcp.figma.com/mcp", enabled: true },
    ]);
  });

  it("parses Paseo array with oauth", () => {
    const result = parseMcpServersJson(
      JSON.stringify([
        {
          name: "atlassian",
          url: "https://mcp.atlassian.com/v1/mcp/authv2",
          enabled: true,
          auth: { kind: "oauth", clientId: "cid", redirectUri: "http://localhost:62367/callback" },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers[0]?.auth).toMatchObject({ kind: "oauth", clientId: "cid" });
  });

  it("imports stdio, bearer auth string, and headers", () => {
    const result = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          local: { command: "npx", args: ["-y", "foo"] },
          authed: { url: "https://x", headers: { Authorization: "Bearer t" } },
          token: { url: "https://y", auth: "my-token" },
          ok: { url: "https://example.com/mcp" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers.map((s) => s.name).sort()).toEqual(["authed", "local", "ok", "token"]);
    expect(result.servers.find((s) => s.name === "local")).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });
    expect(result.servers.find((s) => s.name === "authed")?.headers).toEqual({
      Authorization: "Bearer t",
    });
    expect(result.servers.find((s) => s.name === "token")?.auth).toEqual({
      kind: "bearer",
      token: "my-token",
    });
  });

  it("round-trips current servers as FastMCP mcpServers JSON", () => {
    const json = serializeMcpServersJson([
      {
        name: "figma",
        transport: "http",
        url: "https://mcp.figma.com/mcp",
        enabled: true,
        preset: true,
        auth: { kind: "oauth", clientId: "cid", scope: "mcp:connect" },
      },
      {
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "foo"],
        enabled: true,
      },
      {
        name: "token",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: true,
        auth: { kind: "bearer", token: "abc" },
      },
    ]);
    expect(json).toContain('"mcpServers"');
    expect(json).toContain('"oauth_client_id": "cid"');
    expect(json).toContain('"auth": "oauth"');
    expect(json).toContain('"auth": "abc"');
    expect(json).toContain('"command": "npx"');
    const parsed = parseMcpServersJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.servers.find((s) => s.name === "figma")).toMatchObject({
      name: "figma",
      url: "https://mcp.figma.com/mcp",
      enabled: true,
      preset: true,
      auth: { kind: "oauth", clientId: "cid", scope: "mcp:connect" },
    });
    expect(parsed.servers.find((s) => s.name === "local")).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
    });
    expect(parsed.servers.find((s) => s.name === "token")?.auth).toEqual({
      kind: "bearer",
      token: "abc",
    });
  });
});
