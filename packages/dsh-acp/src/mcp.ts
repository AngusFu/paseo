import type { McpServer } from "@agentclientprotocol/sdk";

export interface DshMcpCordisEntry {
  id: string;
  name: "@deepseek-ai/dsh-mcp-client";
  config: Record<string, unknown>;
}

export function toDshMcpCordisEntries(servers: McpServer[]): DshMcpCordisEntry[] {
  return servers.map(toDshMcpCordisEntry);
}

export function toDshMcpCordisEntry(server: McpServer): DshMcpCordisEntry {
  const serverName = sanitizeServerName(server.name);
  const id = `mcp-${serverName.replaceAll("_", "-")}`;
  if ("command" in server) {
    return {
      id,
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName,
        transport: "stdio",
        command: server.command,
        ...(server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env.length > 0
          ? { env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])) }
          : {}),
      },
    };
  }

  return {
    id,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName,
      transport: "streamable-http",
      url: server.url,
      ...(server.headers.length > 0
        ? {
            headers: Object.fromEntries(
              server.headers.map((header) => [header.name, header.value]),
            ),
          }
        : {}),
    },
  };
}

function sanitizeServerName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new Error(`DSH MCP server name ${JSON.stringify(name)} must match [A-Za-z0-9_-]{1,32}`);
  }
  return trimmed;
}
