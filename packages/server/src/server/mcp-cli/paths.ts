import { join } from "node:path";

export function mcpCliRoot(paseoHome: string): string {
  return join(paseoHome, "mcp-cli");
}

export function mcpCliBinDir(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "bin");
}

export function mcpCliVenvDir(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "venv");
}

export function mcpCliRunnerPath(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "fastmcp-cli.py");
}

export function mcpCliServersDir(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "servers");
}

export function mcpCliCacheDir(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "cache");
}

/** FastMCP-shaped enabled-server registry consumed by fastmcp-cli.py. */
export function mcpCliMcpServersPath(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "mcp-servers.json");
}

/**
 * COMPAT(mcpServersRegistryRename): added in v0.1.105, drop after 2027-01-25
 * when reading old homes that still have oauth-clients.json only.
 */
export function mcpCliLegacyOauthClientsPath(paseoHome: string): string {
  return join(mcpCliRoot(paseoHome), "oauth-clients.json");
}

export function mcpCliPythonPath(paseoHome: string): string {
  return join(mcpCliVenvDir(paseoHome), "bin", "python");
}
