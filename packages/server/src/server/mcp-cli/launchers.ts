import { chmod, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { mcpCliBinDir, mcpCliPythonPath, mcpCliRoot, mcpCliRunnerPath } from "./paths.js";

const BUNDLED_RUNNER = join(dirname(fileURLToPath(import.meta.url)), "assets", "fastmcp-cli.py");

/**
 * Best-effort copy of the bundled runner asset to the on-disk runner path.
 * Does not touch launchers (those need the enabled-server registry, which may
 * not be populated yet at daemon boot). Callers should catch — failure must
 * never block daemon startup.
 */
export async function syncMcpCliRunner(paseoHome: string): Promise<void> {
  const root = mcpCliRoot(paseoHome);
  await mkdir(root, { recursive: true });
  await copyFile(BUNDLED_RUNNER, mcpCliRunnerPath(paseoHome));
}

export async function syncMcpCliLaunchers(
  paseoHome: string,
  servers: readonly McpCliServerConfig[],
): Promise<void> {
  const binDir = mcpCliBinDir(paseoHome);
  const root = mcpCliRoot(paseoHome);
  await mkdir(binDir, { recursive: true });
  await mkdir(root, { recursive: true });
  const python = mcpCliPythonPath(paseoHome);
  const runner = mcpCliRunnerPath(paseoHome);
  // Keep the on-disk runner in sync with the package asset (open HTTP / stdio branches).
  try {
    await copyFile(BUNDLED_RUNNER, runner);
  } catch {
    // Install may not have run yet — launcher still points at the path; Install copies too.
  }

  const keep = new Set<string>();
  for (const server of servers) {
    const launcherPath = join(binDir, server.name);
    if (!server.enabled) {
      await rm(launcherPath, { force: true });
      continue;
    }
    keep.add(server.name);
    const body = `#!/bin/sh
export PASEO_MCP_CLI_ROOT="${root}"
exec "${python}" "${runner}" "${server.name}" "$@"
`;
    await writeFile(launcherPath, body, "utf8");
    await chmod(launcherPath, 0o755);
  }

  // Drop stale launchers (deleted custom servers, renamed, etc.).
  let existing: string[] = [];
  try {
    existing = await readdir(binDir);
  } catch {
    existing = [];
  }
  for (const name of existing) {
    if (!keep.has(name)) {
      await rm(join(binDir, name), { force: true });
    }
  }
}
