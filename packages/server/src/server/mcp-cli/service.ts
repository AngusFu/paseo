import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { McpCliRuntimeStatus, McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { syncMcpCliLaunchers } from "./launchers.js";
import { mcpCliBinDir, mcpCliOauthClientsPath, mcpCliRoot } from "./paths.js";
import { prependMcpCliBinPath } from "./path.js";
import { formatMcpCliDaemonAppendPrompt } from "./prompt.js";
import { getMcpCliRuntimeStatus, installMcpCliRuntime } from "./runtime.js";
import { McpCliServerStore } from "./store.js";

function oauthClientsRegistry(servers: readonly McpCliServerConfig[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.auth?.kind !== "oauth" || !server.auth.clientId) {
      continue;
    }
    out[server.name] = {
      source: server.url,
      oauth_client_id: server.auth.clientId,
      ...(server.auth.clientSecret ? { oauth_client_secret: server.auth.clientSecret } : {}),
      ...(server.auth.redirectUri ? { oauth_redirect_uri: server.auth.redirectUri } : {}),
      ...(server.auth.scope ? { oauth_scope: server.auth.scope } : {}),
    };
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
    await this.persistOauthClients(servers);
    await syncMcpCliLaunchers(this.paseoHome, servers);
    return status;
  }

  async listServers(): Promise<McpCliServerConfig[]> {
    return this.store.listMerged();
  }

  async upsertServer(server: McpCliServerConfig): Promise<McpCliServerConfig> {
    const saved = await this.store.upsert(server);
    const servers = await this.store.listMerged();
    await this.persistOauthClients(servers);
    await syncMcpCliLaunchers(this.paseoHome, servers);
    return saved;
  }

  async deleteServer(name: string): Promise<void> {
    await this.store.delete(name);
    const servers = await this.store.listMerged();
    await this.persistOauthClients(servers);
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
    if (server.auth?.kind !== "oauth" || !server.auth.clientId) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error:
          "OAuth clientId required. Paste clientId/secret/redirectUri from Claude or Cursor MCP settings, then save.",
      };
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

  private async persistOauthClients(servers: readonly McpCliServerConfig[]): Promise<void> {
    await mkdir(mcpCliRoot(this.paseoHome), { recursive: true });
    const path = mcpCliOauthClientsPath(this.paseoHome);
    await writeFile(path, `${JSON.stringify(oauthClientsRegistry(servers), null, 2)}\n`, "utf8");
  }
}
