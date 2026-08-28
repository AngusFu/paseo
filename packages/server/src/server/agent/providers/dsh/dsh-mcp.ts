import type { McpServerConfig } from "../../agent-sdk-types.js";

export interface DshMcpCordisEntry {
  id: string;
  name: "@deepseek-ai/dsh-mcp-client";
  config: Record<string, unknown>;
}

function sanitizeServerName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new Error(
      `DSH MCP server name "${name}" must match [A-Za-z0-9_-]{1,32} (got "${trimmed}")`,
    );
  }
  return trimmed;
}

export function toDshMcpCordisEntry(
  serverName: string,
  config: McpServerConfig,
): DshMcpCordisEntry {
  const safeName = sanitizeServerName(serverName);
  const id = `mcp-${safeName.replaceAll("_", "-")}`;

  if (config.type === "stdio") {
    return {
      id,
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: safeName,
        transport: "stdio",
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      },
    };
  }

  const transport = config.type === "sse" ? "streamable-http" : "streamable-http";
  return {
    id,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: safeName,
      transport,
      url: config.url,
      ...(config.headers && Object.keys(config.headers).length > 0
        ? { headers: config.headers }
        : {}),
    },
  };
}

export function toDshMcpCordisEntries(
  servers: Record<string, McpServerConfig> | undefined,
): DshMcpCordisEntry[] {
  if (!servers) {
    return [];
  }
  return Object.entries(servers).map(([name, serverConfig]) =>
    toDshMcpCordisEntry(name, serverConfig),
  );
}
