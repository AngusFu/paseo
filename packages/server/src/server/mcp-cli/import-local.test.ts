import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLocalMcpServers } from "./import-local.js";

describe("discoverLocalMcpServers", () => {
  it("imports HTTP + stdio + bearer/headers + sciforum oauth-clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-cli-import-"));
    const mcpPath = join(dir, "mcp.json");
    const oauthPath = join(dir, "oauth-clients.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          open: { url: "https://example.com/mcp" },
          local: { command: "npx", args: ["-y", "foo"] },
          authed: { url: "https://x", headers: { Authorization: "Bearer t" } },
          dcr: { url: "https://y", auth: "oauth" },
          token: { url: "https://z", auth: "my-token" },
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
    const figma = result.servers.find((s) => s.name === "figma");
    expect(figma?.auth).toMatchObject({ kind: "oauth", clientId: "cid", clientSecret: "sec" });
    expect(result.servers.find((s) => s.name === "local")).toMatchObject({
      transport: "stdio",
      command: "npx",
    });
    expect(result.servers.find((s) => s.name === "authed")).toMatchObject({
      headers: { Authorization: "Bearer t" },
    });
    expect(result.servers.find((s) => s.name === "dcr")?.auth).toEqual({ kind: "oauth" });
    expect(result.servers.find((s) => s.name === "token")?.auth).toEqual({
      kind: "bearer",
      token: "my-token",
    });
  });
});
