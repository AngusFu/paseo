import type { McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";

export const MCP_CLI_PRESETS: readonly McpCliServerConfig[] = [
  {
    name: "atlassian",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    enabled: false,
    preset: true,
  },
  {
    name: "figma",
    url: "https://mcp.figma.com/mcp",
    enabled: false,
    preset: true,
  },
];

/** Suggested Atlassian redirect when pasting Claude MCP credentials. */
export const ATLASSIAN_DEFAULT_REDIRECT_URI = "http://localhost:62367/callback";

export function presetByName(name: string): McpCliServerConfig | undefined {
  return MCP_CLI_PRESETS.find((preset) => preset.name === name);
}
