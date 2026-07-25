import {
  McpCliServerConfigSchema,
  type McpCliServerConfig,
} from "@getpaseo/protocol/mcp-cli/types";

export type McpServersJsonParseResult =
  | { ok: true; servers: McpCliServerConfig[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/** Claude/Cursor-style export of the current Paseo FastMCP server list. */
export function serializeMcpServersJson(servers: readonly McpCliServerConfig[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {
      url: server.url,
      enabled: server.enabled,
    };
    if (server.auth?.kind === "oauth") {
      entry.auth = {
        kind: "oauth",
        clientId: server.auth.clientId,
        ...(server.auth.clientSecret ? { clientSecret: server.auth.clientSecret } : {}),
        ...(server.auth.redirectUri ? { redirectUri: server.auth.redirectUri } : {}),
        ...(server.auth.scope ? { scope: server.auth.scope } : {}),
      };
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
  const url = optionalString(entry.url) ?? optionalString(entry.serverUrl);
  return url ?? null;
}

function oauthFields(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scope?: string;
}): NonNullable<McpCliServerConfig["auth"]> {
  return {
    kind: "oauth",
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

function readAuth(entry: Record<string, unknown>): McpCliServerConfig["auth"] {
  if (entry.auth && typeof entry.auth === "object" && !Array.isArray(entry.auth)) {
    const a = entry.auth as Record<string, unknown>;
    const clientId = optionalString(a.clientId);
    if (a.kind === "oauth" && clientId) {
      return oauthFields({
        clientId,
        clientSecret: optionalString(a.clientSecret),
        redirectUri: optionalString(a.redirectUri),
        scope: optionalString(a.scope),
      });
    }
    return undefined;
  }

  const clientId = optionalString(entry.oauth_client_id);
  if (!clientId) {
    return undefined;
  }
  return oauthFields({
    clientId,
    clientSecret: optionalString(entry.oauth_client_secret),
    redirectUri: optionalString(entry.oauth_redirect_uri),
    scope: optionalString(entry.oauth_scope),
  });
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
  if (typeof entry.command === "string" || entry.type === "stdio") {
    warnings.push(`Skipped '${name}': stdio/command MCP is not supported yet`);
    return null;
  }
  if (entry.headers && typeof entry.headers === "object") {
    warnings.push(`Skipped '${name}': bearer/headers auth is not supported yet`);
    return null;
  }
  const url = readUrl(entry);
  if (!url) {
    warnings.push(`Skipped '${name}': missing url`);
    return null;
  }

  const auth = readAuth(entry);
  const candidate = {
    name,
    url,
    enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
    ...(auth ? { auth } : {}),
    ...(entry.preset === true ? { preset: true } : {}),
  };
  const validated = McpCliServerConfigSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push(`Skipped '${name}': ${validated.error.issues[0]?.message ?? "invalid"}`);
    return null;
  }
  return validated.data;
}

/**
 * Accept common paste shapes:
 * - `{ "mcpServers": { "name": { "url": "..." } } }` (Claude/Cursor style)
 * - `{ "name": { "url": "..." } }` map
 * - `[ { "name", "url", "enabled", "auth?" } ]` Paseo array
 *
 * stdio / command-based entries and bearer headers are rejected with warnings
 * (not supported in this MVP).
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
      error: warnings[0] ?? "No importable HTTP MCP servers found",
      warnings,
    };
  }
  return { ok: true, servers, warnings };
}
