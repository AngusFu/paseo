import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  CURSOR_PRINT_MCP_PLUGIN_NAME,
  materializeCursorPrintMcpPlugin,
  toCursorPrintMcpServerEntry,
} from "./cursor-print-mcp-plugin.js";

describe("cursor-print-mcp-plugin", () => {
  test("toCursorPrintMcpServerEntry maps http headers and stdio command form", () => {
    expect(
      toCursorPrintMcpServerEntry({
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=a1",
        headers: { Authorization: "Bearer tok" },
      }),
    ).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=a1",
      headers: { Authorization: "Bearer tok" },
    });

    expect(
      toCursorPrintMcpServerEntry({
        type: "stdio",
        command: "npx",
        args: ["-y", "demo"],
        env: { FOO: "bar" },
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "demo"],
      env: { FOO: "bar" },
    });
  });

  test("materializeCursorPrintMcpPlugin returns null for empty servers", () => {
    expect(materializeCursorPrintMcpPlugin(undefined)).toBeNull();
    expect(materializeCursorPrintMcpPlugin({})).toBeNull();
  });

  test("materializeCursorPrintMcpPlugin writes plugin.json + .mcp.json and cleanup removes them", () => {
    const plugin = materializeCursorPrintMcpPlugin({
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
        headers: { Authorization: "Bearer secret-token" },
      },
      local: {
        type: "stdio",
        command: "echo",
        args: ["hi"],
      },
    });
    expect(plugin).not.toBeNull();
    if (!plugin) {
      return;
    }

    const pluginJsonPath = join(plugin.pluginDir, ".cursor-plugin", "plugin.json");
    const mcpJsonPath = join(plugin.pluginDir, ".mcp.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    expect(existsSync(mcpJsonPath)).toBe(true);

    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      name: string;
      mcpServers: string;
    };
    expect(pluginJson.name).toBe(CURSOR_PRINT_MCP_PLUGIN_NAME);
    expect(pluginJson.mcpServers).toBe("./.mcp.json");

    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpJson.mcpServers.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(mcpJson.mcpServers.local).toEqual({
      command: "echo",
      args: ["hi"],
    });

    plugin.cleanup();
    expect(existsSync(plugin.pluginDir)).toBe(false);
  });
});
