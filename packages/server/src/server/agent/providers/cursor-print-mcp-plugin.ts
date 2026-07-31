import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "../agent-sdk-types.js";

export const CURSOR_PRINT_MCP_PLUGIN_NAME = "paseo";
export const CURSOR_PRINT_MCP_PLUGIN_DIR_PREFIX = "paseo-cursor-print-mcp-";
export const CURSOR_PRINT_GUIDANCE_RULE_FILENAME = "paseo-guidance.mdc";

export interface CursorPrintMcpPlugin {
  pluginDir: string;
  hasMcpServers: boolean;
  hasGuidanceRule: boolean;
  cleanup: () => void;
}

export interface MaterializeCursorPrintMcpPluginOptions {
  servers?: Record<string, McpServerConfig>;
  /** Host guidance body (runtime + prose-stop + FastMCP CLI + host append). */
  guidanceMarkdown?: string;
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

export function buildCursorPrintGuidanceRuleMarkdown(guidanceMarkdown: string): string {
  const body = guidanceMarkdown.trim();
  return [
    "---",
    "description: Paseo cursor-print host guidance",
    "alwaysApply: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Materialize a temporary Cursor plugin for cursor-print:
 * - optional `config.mcpServers` → `.mcp.json`
 * - optional host guidance → `rules/paseo-guidance.mdc` (`alwaysApply: true`)
 *
 * Caller must `cleanup()` when done. Returns null when neither MCP nor guidance
 * is provided.
 */
export function materializeCursorPrintMcpPlugin(
  options: MaterializeCursorPrintMcpPluginOptions = {},
): CursorPrintMcpPlugin | null {
  const entries = Object.entries(options.servers ?? {});
  const guidance = options.guidanceMarkdown?.trim() ?? "";
  const hasMcpServers = entries.length > 0;
  const hasGuidanceRule = guidance.length > 0;
  if (!hasMcpServers && !hasGuidanceRule) {
    return null;
  }

  const mcpServers: Record<string, CursorPrintMcpServerEntry> = {};
  for (const [name, config] of entries) {
    mcpServers[name] = toCursorPrintMcpServerEntry(config);
  }

  const pluginDir = mkdtempSync(join(tmpdir(), CURSOR_PRINT_MCP_PLUGIN_DIR_PREFIX));
  const pluginMetaDir = join(pluginDir, ".cursor-plugin");
  mkdirSync(pluginMetaDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    name: CURSOR_PRINT_MCP_PLUGIN_NAME,
    displayName: "Paseo",
    version: "1.0.0",
    description: "Paseo MCP + host guidance for cursor-print sessions",
  };
  if (hasMcpServers) {
    manifest.mcpServers = "./.mcp.json";
  }
  if (hasGuidanceRule) {
    manifest.rules = "./rules/";
  }

  writeFileSync(join(pluginMetaDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  if (hasMcpServers) {
    // May contain Authorization bearer tokens for /mcp/agents.
    writeFileSync(join(pluginDir, ".mcp.json"), `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  if (hasGuidanceRule) {
    const rulesDir = join(pluginDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, CURSOR_PRINT_GUIDANCE_RULE_FILENAME),
      buildCursorPrintGuidanceRuleMarkdown(guidance),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  return {
    pluginDir,
    hasMcpServers,
    hasGuidanceRule,
    cleanup: () => {
      rmSync(pluginDir, { recursive: true, force: true });
    },
  };
}
