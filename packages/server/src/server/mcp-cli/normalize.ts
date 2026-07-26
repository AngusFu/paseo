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

function normalizeStringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeHttpAuth(
  name: string,
  auth: McpCliServerConfig["auth"],
): McpCliServerConfig["auth"] {
  if (!auth) {
    return undefined;
  }
  if (auth.kind === "bearer") {
    const token = auth.token.trim();
    if (!token) {
      throw new Error(`Server '${name}': bearer auth requires token`);
    }
    return { kind: "bearer", token };
  }
  const next: NonNullable<McpCliServerConfig["auth"]> = { kind: "oauth" };
  if (auth.clientId?.trim()) next.clientId = auth.clientId.trim();
  if (auth.clientSecret?.trim()) next.clientSecret = auth.clientSecret.trim();
  if (auth.redirectUri?.trim()) next.redirectUri = auth.redirectUri.trim();
  if (auth.scope?.trim()) next.scope = auth.scope.trim();
  return next;
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
    const env = normalizeStringRecord(raw.env);
    if (env) {
      next.env = env;
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
  const headers = normalizeStringRecord(raw.headers);
  if (headers) {
    next.headers = headers;
  }
  const auth = normalizeHttpAuth(name, raw.auth);
  if (auth) {
    next.auth = auth;
  }
  if (raw.preset) {
    next.preset = true;
  }
  return next;
}
