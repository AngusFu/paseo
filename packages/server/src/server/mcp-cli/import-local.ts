import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  McpCliServerConfigSchema,
  type McpCliServerConfig,
} from "@getpaseo/protocol/mcp-cli/types";
import { presetByName } from "./presets.js";

export interface ImportLocalResult {
  servers: McpCliServerConfig[];
  sources: string[];
  warnings: string[];
}

interface OauthClientRow {
  source?: unknown;
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
    if (typeof row.source === "string" || typeof row.oauth_client_id === "string") {
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

function buildServer(
  name: string,
  url: string,
  auth: McpCliServerConfig["auth"],
): McpCliServerConfig | null {
  const candidate: McpCliServerConfig = {
    name,
    url,
    enabled: true,
  };
  if (auth) {
    candidate.auth = auth;
  }
  if (presetByName(name)) {
    candidate.preset = true;
  }
  const parsed = McpCliServerConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function serverFromOauthRow(name: string, row: OauthClientRow): McpCliServerConfig | null {
  const url = optionalString(row.source);
  if (!url) {
    return null;
  }
  return buildServer(name, url, authFromOauthRow(row));
}

function authFromEntry(entry: Record<string, unknown>): McpCliServerConfig["auth"] {
  if (entry.auth && typeof entry.auth === "object" && !Array.isArray(entry.auth)) {
    const a = entry.auth as Record<string, unknown>;
    const clientId = optionalString(a.clientId);
    if (a.kind !== "oauth" || !clientId) {
      return undefined;
    }
    return authFromOauthRow({
      oauth_client_id: clientId,
      oauth_client_secret: a.clientSecret,
      oauth_redirect_uri: a.redirectUri,
      oauth_scope: a.scope,
    });
  }
  return authFromOauthRow(entry as OauthClientRow);
}

function skipReasonForEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.command === "string" || entry.type === "stdio") {
    return "stdio/command not supported";
  }
  if (entry.headers && typeof entry.headers === "object") {
    return "bearer/headers not supported";
  }
  return null;
}

function serverFromMcpEntry(name: string, value: unknown): McpCliServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (skipReasonForEntry(entry)) {
    return null;
  }
  const url = optionalString(entry.url) ?? optionalString(entry.serverUrl);
  if (!url) {
    return null;
  }
  return buildServer(name, url, authFromEntry(entry));
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
      warnings.push(`Skipped '${name}' in ${path}: missing source URL`);
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
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const reason = skipReasonForEntry(value as Record<string, unknown>);
      if (reason) {
        warnings.push(`Skipped '${name}' in ${path}: ${reason}`);
        continue;
      }
    }
    const server = serverFromMcpEntry(name, value);
    if (!server) {
      warnings.push(`Skipped '${name}' in ${path}: no HTTP url`);
      continue;
    }
    mergeServers(byName, server);
    found += 1;
  }
  return found;
}

/**
 * Scan well-known Claude / Cursor / sciforum config paths on the daemon host
 * and return importable HTTP MCP server configs (stdio/headers skipped).
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
