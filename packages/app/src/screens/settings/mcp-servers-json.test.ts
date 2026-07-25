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
      { name: "figma", url: "https://mcp.figma.com/mcp", enabled: true },
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

  it("warns and skips stdio / headers", () => {
    const result = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          local: { command: "npx", args: ["-y", "foo"] },
          authed: { url: "https://x", headers: { Authorization: "Bearer t" } },
          ok: { url: "https://example.com/mcp" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(result.warnings.some((w) => w.includes("stdio"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("headers"))).toBe(true);
  });

  it("round-trips current servers as mcpServers JSON", () => {
    const json = serializeMcpServersJson([
      {
        name: "figma",
        url: "https://mcp.figma.com/mcp",
        enabled: true,
        preset: true,
        auth: { kind: "oauth", clientId: "cid", scope: "mcp:connect" },
      },
    ]);
    expect(json).toContain('"mcpServers"');
    expect(json).toContain('"clientId": "cid"');
    const parsed = parseMcpServersJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.servers[0]).toMatchObject({
      name: "figma",
      url: "https://mcp.figma.com/mcp",
      enabled: true,
      preset: true,
      auth: { kind: "oauth", clientId: "cid", scope: "mcp:connect" },
    });
  });
});
