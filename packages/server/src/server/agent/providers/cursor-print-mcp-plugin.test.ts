import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  CURSOR_PRINT_GUIDANCE_RULE_FILENAME,
  CURSOR_PRINT_MCP_PLUGIN_NAME,
  buildCursorPrintGuidanceRuleMarkdown,
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

  test("materializeCursorPrintMcpPlugin returns null when empty", () => {
    expect(materializeCursorPrintMcpPlugin()).toBeNull();
    expect(materializeCursorPrintMcpPlugin({})).toBeNull();
    expect(materializeCursorPrintMcpPlugin({ servers: {} })).toBeNull();
    expect(materializeCursorPrintMcpPlugin({ guidanceMarkdown: "   " })).toBeNull();
  });

  test("materializeCursorPrintMcpPlugin writes MCP + alwaysApply guidance rule", () => {
    const plugin = materializeCursorPrintMcpPlugin({
      servers: {
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
      },
      guidanceMarkdown: "Host guidance body\nPrefer ask_question.",
    });
    expect(plugin).not.toBeNull();
    if (!plugin) {
      return;
    }

    expect(plugin.hasMcpServers).toBe(true);
    expect(plugin.hasGuidanceRule).toBe(true);

    const pluginJsonPath = join(plugin.pluginDir, ".cursor-plugin", "plugin.json");
    const mcpJsonPath = join(plugin.pluginDir, ".mcp.json");
    const rulePath = join(plugin.pluginDir, "rules", CURSOR_PRINT_GUIDANCE_RULE_FILENAME);
    expect(existsSync(pluginJsonPath)).toBe(true);
    expect(existsSync(mcpJsonPath)).toBe(true);
    expect(existsSync(rulePath)).toBe(true);

    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      name: string;
      mcpServers: string;
      rules: string;
    };
    expect(pluginJson.name).toBe(CURSOR_PRINT_MCP_PLUGIN_NAME);
    expect(pluginJson.mcpServers).toBe("./.mcp.json");
    expect(pluginJson.rules).toBe("./rules/");

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

    expect(readFileSync(rulePath, "utf8")).toBe(
      buildCursorPrintGuidanceRuleMarkdown("Host guidance body\nPrefer ask_question."),
    );
    expect(readFileSync(rulePath, "utf8")).toContain("alwaysApply: true");

    plugin.cleanup();
    expect(existsSync(plugin.pluginDir)).toBe(false);
  });

  test("materializeCursorPrintMcpPlugin can be guidance-only (no MCP)", () => {
    const plugin = materializeCursorPrintMcpPlugin({
      guidanceMarkdown: "rules only",
    });
    expect(plugin).not.toBeNull();
    if (!plugin) {
      return;
    }
    expect(plugin.hasMcpServers).toBe(false);
    expect(plugin.hasGuidanceRule).toBe(true);
    expect(existsSync(join(plugin.pluginDir, ".mcp.json"))).toBe(false);
    const pluginJson = JSON.parse(
      readFileSync(join(plugin.pluginDir, ".cursor-plugin", "plugin.json"), "utf8"),
    ) as { rules?: string; mcpServers?: string };
    expect(pluginJson.rules).toBe("./rules/");
    expect(pluginJson.mcpServers).toBeUndefined();
    plugin.cleanup();
  });
});
