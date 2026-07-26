import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLocalMcpServers } from "./import-local.js";

describe("discoverLocalMcpServers", () => {
  it("imports HTTP + stdio mcpServers and sciforum oauth-clients; skips headers", async () => {
    const dir = join(tmpdir(), `paseo-mcp-import-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const mcpPath = join(dir, "mcp.json");
    const oauthPath = join(dir, "oauth-clients.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          open: { url: "https://example.com/mcp" },
          local: { command: "npx", args: ["-y", "x"] },
          authed: { url: "https://x", headers: { Authorization: "Bearer t" } },
        },
      }),
      "utf8",
    );
    await writeFile(
      oauthPath,
      JSON.stringify({
        figma: {
          source: "https://mcp.figma.com/mcp",
          oauth_client_id: "cid",
          oauth_client_secret: "sec",
          oauth_scope: "mcp:connect",
        },
      }),
      "utf8",
    );

    const result = await discoverLocalMcpServers([mcpPath, oauthPath]);
    expect(result.sources).toEqual([mcpPath, oauthPath]);
    expect(result.servers.map((s) => s.name).sort()).toEqual(["figma", "local", "open"]);
    const figma = result.servers.find((s) => s.name === "figma");
    expect(figma?.auth).toMatchObject({ kind: "oauth", clientId: "cid", clientSecret: "sec" });
    const local = result.servers.find((s) => s.name === "local");
    expect(local).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "x"],
    });
    expect(result.warnings.some((w) => w.includes("headers"))).toBe(true);
  });
});
