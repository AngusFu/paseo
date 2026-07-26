import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  McpCliServerConfigSchema,
  type McpCliServerConfig,
} from "@getpaseo/protocol/mcp-cli/types";
import { normalizeMcpCliServerConfig } from "./normalize.js";
import { presetByName } from "./presets.js";

export interface ImportLocalResult {
  servers: McpCliServerConfig[];
  sources: string[];
  warnings: string[];
}

interface OauthClientRow {
  url?: unknown;
  source?: unknown;
  auth?: unknown;
  headers?: unknown;
  oauth_client_id?: unknown;
  oauth_client_secret?: unknown;
  oauth_redirect_uri?: unknown;
  oauth_scope?: unknown;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function candidatePaths(): string[] {
  const home = homedir();
  return [
    join(home, ".cursor", "mcp.json"),
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join(home, ".claude.json"),
    join(home, ".config", "sciforum", "oauth-clients.json"),
  ];
}

function extractMcpServersMap(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
    return root.mcpServers as Record<string, unknown>;
  }
  return null;
}

function isOauthClientsFile(parsed: unknown, path: string): boolean {
  if (!path.endsWith("oauth-clients.json")) {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const row = value as OauthClientRow;
    if (
      typeof row.source === "string" ||
      typeof row.url === "string" ||
      typeof row.oauth_client_id === "string"
    ) {
      return true;
    }
  }
  return false;
}

function authFromOauthRow(row: OauthClientRow): McpCliServerConfig["auth"] {
  const clientId = optionalString(row.oauth_client_id);
  if (!clientId) {
    return undefined;
  }
  const auth: NonNullable<McpCliServerConfig["auth"]> = {
    kind: "oauth",
    clientId,
  };
  const clientSecret = optionalString(row.oauth_client_secret);
  const redirectUri = optionalString(row.oauth_redirect_uri);
  const scope = optionalString(row.oauth_scope);
  if (clientSecret) auth.clientSecret = clientSecret;
  if (redirectUri) auth.redirectUri = redirectUri;
  if (scope) auth.scope = scope;
  return auth;
}

function finalize(candidate: McpCliServerConfig): McpCliServerConfig | null {
  if (presetByName(candidate.name)) {
    candidate.preset = true;
  }
  const parsed = McpCliServerConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  try {
    return normalizeMcpCliServerConfig(parsed.data);
  } catch {
    return null;
  }
}

function serverFromOauthRow(name: string, row: OauthClientRow): McpCliServerConfig | null {
  const url = optionalString(row.url) ?? optionalString(row.source);
  if (!url) {
    return null;
  }
  const oauth = authFromOauthRow(row);
  const headers = stringRecord(row.headers);
  let auth = oauth;
  if (!auth && typeof row.auth === "string") {
    auth = authFromFastmcpAuthString(row.auth);
  }
  return finalize({
    name,
    transport: "http",
    url,
    enabled: true,
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  });
}

function authFromFastmcpAuthString(value: string): McpCliServerConfig["auth"] {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "oauth") {
    return { kind: "oauth" };
  }
  return { kind: "bearer", token: trimmed };
}

function authFromEntry(entry: Record<string, unknown>): McpCliServerConfig["auth"] {
  if (typeof entry.auth === "string") {
    return authFromFastmcpAuthString(entry.auth);
  }
  if (entry.auth && typeof entry.auth === "object" && !Array.isArray(entry.auth)) {
    const a = entry.auth as Record<string, unknown>;
    if (a.kind === "bearer") {
      const token = optionalString(a.token);
      return token ? { kind: "bearer", token } : undefined;
    }
    if (a.kind === "oauth") {
      const clientId = optionalString(a.clientId);
      return {
        kind: "oauth",
        ...(clientId ? { clientId } : {}),
        ...(optionalString(a.clientSecret) ? { clientSecret: optionalString(a.clientSecret) } : {}),
        ...(optionalString(a.redirectUri) ? { redirectUri: optionalString(a.redirectUri) } : {}),
        ...(optionalString(a.scope) ? { scope: optionalString(a.scope) } : {}),
      };
    }
  }
  return authFromOauthRow(entry as OauthClientRow);
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

function serverFromMcpEntry(name: string, value: unknown): McpCliServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;

  const command = optionalString(entry.command);
  const isStdio = entry.type === "stdio" || entry.transport === "stdio" || Boolean(command);
  if (isStdio && command) {
    return finalize({
      name,
      transport: "stdio",
      command,
      enabled: true,
      ...(stringArray(entry.args) ? { args: stringArray(entry.args) } : {}),
      ...(stringRecord(entry.env) ? { env: stringRecord(entry.env) } : {}),
      ...(optionalString(entry.cwd) ? { cwd: optionalString(entry.cwd) } : {}),
    });
  }

  const url = optionalString(entry.url) ?? optionalString(entry.serverUrl);
  if (!url) {
    return null;
  }
  const auth = authFromEntry(entry);
  const headers = stringRecord(entry.headers);
  return finalize({
    name,
    transport: "http",
    url,
    enabled: true,
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  });
}

function mergeServers(into: Map<string, McpCliServerConfig>, next: McpCliServerConfig): void {
  const prev = into.get(next.name);
  if (!prev) {
    into.set(next.name, next);
    return;
  }
  into.set(next.name, {
    ...prev,
    ...next,
    auth: next.auth ?? prev.auth,
    headers: next.headers ?? prev.headers,
    args: next.args ?? prev.args,
    env: next.env ?? prev.env,
    cwd: next.cwd ?? prev.cwd,
    command: next.command ?? prev.command,
    url: next.url ?? prev.url,
    enabled: prev.enabled || next.enabled,
    preset: Boolean(prev.preset || next.preset) || undefined,
  });
}

function ingestOauthClientsFile(
  path: string,
  parsed: Record<string, unknown>,
  byName: Map<string, McpCliServerConfig>,
  warnings: string[],
): number {
  let found = 0;
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const server = serverFromOauthRow(name, value as OauthClientRow);
    if (!server) {
      warnings.push(`Skipped '${name}' in ${path}: missing url/source`);
      continue;
    }
    mergeServers(byName, server);
    found += 1;
  }
  return found;
}

function ingestMcpServersFile(
  path: string,
  map: Record<string, unknown>,
  byName: Map<string, McpCliServerConfig>,
  warnings: string[],
): number {
  let found = 0;
  for (const [name, value] of Object.entries(map)) {
    const server = serverFromMcpEntry(name, value);
    if (!server) {
      warnings.push(`Skipped '${name}' in ${path}: no HTTP url or stdio command`);
      continue;
    }
    mergeServers(byName, server);
    found += 1;
  }
  return found;
}

/**
 * Scan well-known Claude / Cursor / sciforum config paths on the daemon host
 * and return importable MCP server configs (FastMCP MCPConfig-aligned).
 */
export async function discoverLocalMcpServers(
  paths: readonly string[] = candidatePaths(),
): Promise<ImportLocalResult> {
  const byName = new Map<string, McpCliServerConfig>();
  const sources: string[] = [];
  const warnings: string[] = [];

  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      warnings.push(
        `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warnings.push(
        `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let found = 0;
    if (isOauthClientsFile(parsed, path)) {
      found = ingestOauthClientsFile(path, parsed as Record<string, unknown>, byName, warnings);
    } else {
      const map = extractMcpServersMap(parsed);
      if (!map) {
        continue;
      }
      found = ingestMcpServersFile(path, map, byName, warnings);
    }

    if (found > 0) {
      sources.push(path);
    }
  }

  return {
    servers: [...byName.values()],
    sources,
    warnings,
  };
}
