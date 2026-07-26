import type { McpCliServerConfig, McpCliTransport } from "@getpaseo/protocol/mcp-cli/types";

export function resolveMcpCliTransport(server: McpCliServerConfig): McpCliTransport {
  if (server.transport === "stdio" || server.transport === "http") {
    return server.transport;
  }
  // Heuristic for pasted Claude/Cursor rows that omit transport.
  if (server.command?.trim() && !server.url?.trim()) {
    return "stdio";
  }
  return "http";
}

export function isMcpCliStdioServer(server: McpCliServerConfig): boolean {
  return resolveMcpCliTransport(server) === "stdio";
}

/**
 * Post-wire normalize: coerce legacy HTTP rows and validate transport invariants.
 * Does not live on the Zod wire schema (no .transform on protocol messages).
 */
export function normalizeMcpCliServerConfig(raw: McpCliServerConfig): McpCliServerConfig {
  const name = raw.name.trim();
  if (!name) {
    throw new Error("Server name is required");
  }

  const transport = resolveMcpCliTransport(raw);

  if (transport === "stdio") {
    const command = raw.command?.trim();
    if (!command) {
      throw new Error(`Server '${name}': stdio transport requires command`);
    }
    const next: McpCliServerConfig = {
      name,
      transport: "stdio",
      command,
      enabled: raw.enabled,
    };
    if (raw.args && raw.args.length > 0) {
      next.args = raw.args.map((arg) => String(arg));
    }
    if (raw.env && Object.keys(raw.env).length > 0) {
      next.env = { ...raw.env };
    }
    if (raw.cwd?.trim()) {
      next.cwd = raw.cwd.trim();
    }
    if (raw.preset) {
      next.preset = true;
    }
    return next;
  }

  const url = raw.url?.trim();
  if (!url) {
    throw new Error(`Server '${name}': http transport requires url`);
  }
  const next: McpCliServerConfig = {
    name,
    transport: "http",
    url,
    enabled: raw.enabled,
  };
  if (raw.auth?.kind === "oauth") {
    next.auth = raw.auth;
  }
  if (raw.preset) {
    next.preset = true;
  }
  return next;
}
