import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { McpCliRuntimeStatus, McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { discoverLocalMcpServers, type ImportLocalResult } from "./import-local.js";
import { syncMcpCliLaunchers } from "./launchers.js";
import { isMcpCliStdioServer } from "./normalize.js";
import {
  mcpCliBinDir,
  mcpCliLegacyOauthClientsPath,
  mcpCliMcpServersPath,
  mcpCliRoot,
} from "./paths.js";
import { prependMcpCliBinPath } from "./path.js";
import { formatMcpCliDaemonAppendPrompt } from "./prompt.js";
import { getMcpCliRuntimeStatus, installMcpCliRuntime } from "./runtime.js";
import { McpCliServerStore } from "./store.js";

/**
 * Enabled-server map for fastmcp-cli.py — FastMCP `MCPConfig` / Claude
 * `mcpServers` shape (stdio → command/args/env/cwd; remote → url/headers/auth).
 *
 * Pre-registered OAuth (Atlassian/Figma) adds `oauth_client_*` extras that stock
 * FastMCP JSON cannot express; the runner only special-cases those.
 */
export function mcpServersRegistry(
  servers: readonly McpCliServerConfig[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.enabled) {
      continue;
    }
    if (isMcpCliStdioServer(server)) {
      out[server.name] = {
        transport: "stdio",
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
      continue;
    }

    const entry: Record<string, unknown> = {
      transport: "http",
      url: server.url,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      entry.headers = server.headers;
    }
    if (server.auth?.kind === "bearer") {
      // FastMCP RemoteMCPServer.auth bearer token string
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
    out[server.name] = entry;
  }
  return out;
}

export class McpCliService {
  readonly store: McpCliServerStore;

  constructor(private readonly paseoHome: string) {
    this.store = new McpCliServerStore(paseoHome);
  }

  getBinDir(): string {
    return mcpCliBinDir(this.paseoHome);
  }

  prependBinPath(env: Record<string, string>): Record<string, string> {
    return prependMcpCliBinPath(env, this.paseoHome);
  }

  async status(): Promise<McpCliRuntimeStatus> {
    return getMcpCliRuntimeStatus(this.paseoHome);
  }

  async install(): Promise<McpCliRuntimeStatus> {
    const status = await installMcpCliRuntime(this.paseoHome);
    const servers = await this.store.listMerged();
    await this.persistMcpServersRegistry(servers);
    await syncMcpCliLaunchers(this.paseoHome, servers);
    return status;
  }

  async listServers(): Promise<McpCliServerConfig[]> {
    return this.store.listMerged();
  }

  async upsertServer(server: McpCliServerConfig): Promise<McpCliServerConfig> {
    const saved = await this.store.upsert(server);
    const servers = await this.store.listMerged();
    await this.persistMcpServersRegistry(servers);
    await syncMcpCliLaunchers(this.paseoHome, servers);
    return saved;
  }

  async deleteServer(name: string): Promise<void> {
    await this.store.delete(name);
    const servers = await this.store.listMerged();
    await this.persistMcpServersRegistry(servers);
    await syncMcpCliLaunchers(this.paseoHome, servers);
  }

  async daemonAppendPrompt(): Promise<string> {
    const servers = await this.store.listMerged();
    return formatMcpCliDaemonAppendPrompt(servers);
  }

  async enabledCliNames(): Promise<Set<string>> {
    return this.store.enabledNames();
  }

  async testServer(name: string): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
  }> {
    const server = await this.store.get(name);
    if (!server) {
      return { ok: false, stdout: "", stderr: "", error: `Unknown server '${name}'` };
    }
    if (!server.enabled) {
      return { ok: false, stdout: "", stderr: "", error: `Server '${name}' is disabled` };
    }
    const status = await this.status();
    if (!status.ready) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error: status.message ?? "Runtime not ready — run Install first",
      };
    }

    const launcher = `${mcpCliBinDir(this.paseoHome)}/${name}`;
    const env = this.prependBinPath({
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
      ),
      PASEO_MCP_CLI_ROOT: mcpCliRoot(this.paseoHome),
    });

    return await new Promise((resolve) => {
      const child = spawn(launcher, ["--list"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        resolve({
          ok: false,
          stdout,
          stderr,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          error:
            code === 0
              ? null
              : stderr.trim() ||
                stdout.trim() ||
                `Exit ${code}. If this needs browser auth, complete it on the daemon host.`,
        });
      });
    });
  }

  async importLocalServers(): Promise<ImportLocalResult & { saved: McpCliServerConfig[] }> {
    const discovered = await discoverLocalMcpServers();
    const saved: McpCliServerConfig[] = [];
    for (const server of discovered.servers) {
      saved.push(await this.upsertServer(server));
    }
    return {
      ...discovered,
      servers: saved,
      saved,
    };
  }

  private async persistMcpServersRegistry(servers: readonly McpCliServerConfig[]): Promise<void> {
    await mkdir(mcpCliRoot(this.paseoHome), { recursive: true });
    const path = mcpCliMcpServersPath(this.paseoHome);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(mcpServersRegistry(servers), null, 2)}\n`, "utf8");
    await rename(tmp, path);
    // COMPAT(mcpServersRegistryRename): remove legacy filename once new registry exists.
    try {
      await unlink(mcpCliLegacyOauthClientsPath(this.paseoHome));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
