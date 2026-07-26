import {
  McpCliServerConfigSchema,
  type McpCliServerConfig,
} from "@getpaseo/protocol/mcp-cli/types";

export type McpServersJsonParseResult =
  | { ok: true; servers: McpCliServerConfig[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

function isStdio(server: McpCliServerConfig): boolean {
  return server.transport === "stdio" || Boolean(server.command && !server.url);
}

/** Claude/Cursor/FastMCP-style export of the current Paseo FastMCP server list. */
export function serializeMcpServersJson(servers: readonly McpCliServerConfig[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (isStdio(server)) {
      const entry: Record<string, unknown> = {
        transport: "stdio",
        command: server.command,
        enabled: server.enabled,
      };
      if (server.args?.length) entry.args = server.args;
      if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
      if (server.cwd) entry.cwd = server.cwd;
      if (server.preset) entry.preset = true;
      mcpServers[server.name] = entry;
      continue;
    }
    const entry: Record<string, unknown> = {
      url: server.url,
      transport: "http",
      enabled: server.enabled,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      entry.headers = server.headers;
    }
    if (server.auth?.kind === "bearer") {
      entry.auth = server.auth.token;
    } else if (server.auth?.kind === "oauth") {
      entry.auth = "oauth";
      if (server.auth.clientId) {
        entry.oauth_client_id = server.auth.clientId;
        if (server.auth.clientSecret) entry.oauth_client_secret = server.auth.clientSecret;
        if (server.auth.redirectUri) entry.oauth_redirect_uri = server.auth.redirectUri;
        if (server.auth.scope) entry.oauth_scope = server.auth.scope;
      }
    }
    if (server.preset) {
      entry.preset = true;
    }
    mcpServers[server.name] = entry;
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

interface NamedEntry {
  name: string;
  value: unknown;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const args = value.filter((item): item is string => typeof item === "string");
  return args.length > 0 ? args : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function collectEntries(parsed: unknown, warnings: string[]): NamedEntry[] | null {
  if (Array.isArray(parsed)) {
    const entries: NamedEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        warnings.push("Skipped non-object array item");
        continue;
      }
      const name = optionalString((item as { name?: unknown }).name);
      if (!name) {
        warnings.push("Skipped array item without name");
        continue;
      }
      entries.push({ name, value: item });
    }
    return entries;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const root = parsed as Record<string, unknown>;
  const map =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : root;

  const entries: NamedEntry[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (name === "mcpServers") {
      continue;
    }
    entries.push({ name, value });
  }
  return entries;
}

function readUrl(entry: Record<string, unknown>): string | null {
  const url =
    optionalString(entry.url) ?? optionalString(entry.serverUrl) ?? optionalString(entry.source);
  return url ?? null;
}

function oauthFromFields(input: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scope?: string;
}): NonNullable<McpCliServerConfig["auth"]> {
  const auth: NonNullable<McpCliServerConfig["auth"]> = { kind: "oauth" };
  if (input.clientId) auth.clientId = input.clientId;
  if (input.clientSecret) auth.clientSecret = input.clientSecret;
  if (input.redirectUri) auth.redirectUri = input.redirectUri;
  if (input.scope) auth.scope = input.scope;
  return auth;
}

function readAuth(entry: Record<string, unknown>): McpCliServerConfig["auth"] {
  if (typeof entry.auth === "string") {
    const trimmed = entry.auth.trim();
    if (!trimmed) return undefined;
    if (trimmed === "oauth") {
      return oauthFromFields({
        clientId: optionalString(entry.oauth_client_id),
        clientSecret: optionalString(entry.oauth_client_secret),
        redirectUri: optionalString(entry.oauth_redirect_uri),
        scope: optionalString(entry.oauth_scope),
      });
    }
    return { kind: "bearer", token: trimmed };
  }

  if (entry.auth && typeof entry.auth === "object" && !Array.isArray(entry.auth)) {
    const a = entry.auth as Record<string, unknown>;
    if (a.kind === "bearer") {
      const token = optionalString(a.token);
      return token ? { kind: "bearer", token } : undefined;
    }
    if (a.kind === "oauth") {
      return oauthFromFields({
        clientId: optionalString(a.clientId),
        clientSecret: optionalString(a.clientSecret),
        redirectUri: optionalString(a.redirectUri),
        scope: optionalString(a.scope),
      });
    }
  }

  const clientId = optionalString(entry.oauth_client_id);
  if (!clientId) {
    return undefined;
  }
  return oauthFromFields({
    clientId,
    clientSecret: optionalString(entry.oauth_client_secret),
    redirectUri: optionalString(entry.oauth_redirect_uri),
    scope: optionalString(entry.oauth_scope),
  });
}

function enabledFromEntry(entry: Record<string, unknown>): boolean {
  return entry.enabled === undefined ? true : Boolean(entry.enabled);
}

function validateCandidate(
  name: string,
  candidate: unknown,
  warnings: string[],
): McpCliServerConfig | null {
  const validated = McpCliServerConfigSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push(`Skipped '${name}': ${validated.error.issues[0]?.message ?? "invalid"}`);
    return null;
  }
  return validated.data;
}

function parseStdioServer(
  name: string,
  entry: Record<string, unknown>,
  warnings: string[],
): McpCliServerConfig | null {
  const command = optionalString(entry.command);
  if (!command) {
    warnings.push(`Skipped '${name}': stdio requires command`);
    return null;
  }
  return validateCandidate(
    name,
    {
      name,
      transport: "stdio" as const,
      command,
      enabled: enabledFromEntry(entry),
      ...(stringArray(entry.args) ? { args: stringArray(entry.args) } : {}),
      ...(stringRecord(entry.env) ? { env: stringRecord(entry.env) } : {}),
      ...(optionalString(entry.cwd) ? { cwd: optionalString(entry.cwd) } : {}),
      ...(entry.preset === true ? { preset: true } : {}),
    },
    warnings,
  );
}

function parseHttpServer(
  name: string,
  entry: Record<string, unknown>,
  warnings: string[],
): McpCliServerConfig | null {
  const url = readUrl(entry);
  if (!url) {
    warnings.push(`Skipped '${name}': missing url or command`);
    return null;
  }
  const auth = readAuth(entry);
  const headers = stringRecord(entry.headers);
  return validateCandidate(
    name,
    {
      name,
      transport: "http" as const,
      url,
      enabled: enabledFromEntry(entry),
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
      ...(entry.preset === true ? { preset: true } : {}),
    },
    warnings,
  );
}

function parseOneServer(
  name: string,
  value: unknown,
  warnings: string[],
): McpCliServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Skipped '${name}': expected object`);
    return null;
  }
  const entry = value as Record<string, unknown>;

  const command = optionalString(entry.command);
  const wantsStdio =
    entry.type === "stdio" || entry.transport === "stdio" || Boolean(command && !readUrl(entry));
  if (wantsStdio) {
    return parseStdioServer(name, entry, warnings);
  }
  return parseHttpServer(name, entry, warnings);
}

/**
 * Accept common paste shapes aligned with FastMCP MCPConfig:
 * - `{ "mcpServers": { "name": { "url": "..." } } }`
 * - `{ "name": { "command": "...", "args": [] } }` stdio
 * - `{ "url", "auth": "oauth"|"<bearer>", "headers"? }`
 * - `[ { "name", "url"|"command", "enabled", "auth?" } ]` Paseo array
 */
export function parseMcpServersJson(raw: string): McpServersJsonParseResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON",
      warnings,
    };
  }

  const entries = collectEntries(parsed, warnings);
  if (!entries) {
    return { ok: false, error: "JSON must be an object or array", warnings };
  }

  const servers: McpCliServerConfig[] = [];
  for (const { name, value } of entries) {
    const server = parseOneServer(name, value, warnings);
    if (server) {
      servers.push(server);
    }
  }

  if (servers.length === 0) {
    return {
      ok: false,
      error: warnings[0] ?? "No importable MCP servers found",
      warnings,
    };
  }
  return { ok: true, servers, warnings };
}
