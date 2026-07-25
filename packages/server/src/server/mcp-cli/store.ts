import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  McpCliServerConfigSchema,
  type McpCliServerConfig,
} from "@getpaseo/protocol/mcp-cli/types";
import { MCP_CLI_PRESETS, presetByName } from "./presets.js";
import { mcpCliServersDir } from "./paths.js";

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export class McpCliServerStore {
  constructor(private readonly paseoHome: string) {}

  private serversDir(): string {
    return mcpCliServersDir(this.paseoHome);
  }

  async listMerged(): Promise<McpCliServerConfig[]> {
    const stored = await this.listStored();
    const byName = new Map(stored.map((server) => [server.name, server]));
    const merged: McpCliServerConfig[] = [];
    for (const preset of MCP_CLI_PRESETS) {
      merged.push(byName.get(preset.name) ?? { ...preset });
      byName.delete(preset.name);
    }
    for (const server of byName.values()) {
      merged.push(server);
    }
    return merged;
  }

  async listStored(): Promise<McpCliServerConfig[]> {
    const dir = this.serversDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const servers: McpCliServerConfig[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const raw = await readFile(join(dir, name), "utf8");
      const parsed = McpCliServerConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        servers.push(parsed.data);
      }
    }
    return servers;
  }

  async get(name: string): Promise<McpCliServerConfig | null> {
    const merged = await this.listMerged();
    return merged.find((server) => server.name === name) ?? null;
  }

  async upsert(server: McpCliServerConfig): Promise<McpCliServerConfig> {
    const parsed = McpCliServerConfigSchema.parse(server);
    const preset = presetByName(parsed.name);
    const next: McpCliServerConfig = {
      ...parsed,
      ...(preset ? { preset: true } : {}),
    };
    const dir = this.serversDir();
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(join(dir, `${next.name}.json`), next);
    return next;
  }

  async delete(name: string): Promise<{ deleted: boolean; restoredPreset: boolean }> {
    const path = join(this.serversDir(), `${name}.json`);
    try {
      await rm(path, { force: true });
    } catch {
      return { deleted: false, restoredPreset: Boolean(presetByName(name)) };
    }
    return { deleted: true, restoredPreset: Boolean(presetByName(name)) };
  }

  async enabledNames(): Promise<Set<string>> {
    const servers = await this.listMerged();
    return new Set(servers.filter((server) => server.enabled).map((server) => server.name));
  }
}
