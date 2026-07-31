import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "../agent-sdk-types.js";

export const CURSOR_PRINT_MCP_PLUGIN_NAME = "paseo";
export const CURSOR_PRINT_MCP_PLUGIN_DIR_PREFIX = "paseo-cursor-print-mcp-";

export interface CursorPrintMcpPlugin {
  pluginDir: string;
  hasMcpServers: boolean;
  cleanup: () => void;
}

/**
 * Cursor plugin-local MCP entry (`.mcp.json` under a `--plugin-dir`).
 * HTTP/SSE keep `type`; stdio matches Cursor's command/args form (no type).
 */
export type CursorPrintMcpServerEntry =
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export function toCursorPrintMcpServerEntry(config: McpServerConfig): CursorPrintMcpServerEntry {
  if (config.type === "stdio") {
    return {
      command: config.command,
      ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    };
  }
  return {
    type: config.type,
    url: config.url,
    ...(config.headers && Object.keys(config.headers).length > 0
      ? { headers: config.headers }
      : {}),
  };
}

/**
 * Materialize a temporary Cursor plugin for cursor-print MCP only.
 * Host guidance is injected at daemon boot into `~/AGENTS.md` (see
 * `writeCursorPrintGlobalAgentsBlock`), not via this plugin.
 *
 * Caller must `cleanup()` when done. Returns null when no servers are provided.
 */
export function materializeCursorPrintMcpPlugin(
  servers: Record<string, McpServerConfig> = {},
): CursorPrintMcpPlugin | null {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return null;
  }

  const mcpServers: Record<string, CursorPrintMcpServerEntry> = {};
  for (const [name, config] of entries) {
    mcpServers[name] = toCursorPrintMcpServerEntry(config);
  }

  const pluginDir = mkdtempSync(join(tmpdir(), CURSOR_PRINT_MCP_PLUGIN_DIR_PREFIX));
  const pluginMetaDir = join(pluginDir, ".cursor-plugin");
  mkdirSync(pluginMetaDir, { recursive: true });

  writeFileSync(
    join(pluginMetaDir, "plugin.json"),
    `${JSON.stringify(
      {
        name: CURSOR_PRINT_MCP_PLUGIN_NAME,
        displayName: "Paseo",
        version: "1.0.0",
        description: "Paseo daemon MCP for cursor-print sessions",
        mcpServers: "./.mcp.json",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  // May contain Authorization bearer tokens for /mcp/agents.
  writeFileSync(join(pluginDir, ".mcp.json"), `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    pluginDir,
    hasMcpServers: true,
    cleanup: () => {
      rmSync(pluginDir, { recursive: true, force: true });
    },
  };
}
