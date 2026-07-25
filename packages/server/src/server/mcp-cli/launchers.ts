import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { mcpCliBinDir, mcpCliPythonPath, mcpCliRoot, mcpCliRunnerPath } from "./paths.js";

export async function syncMcpCliLaunchers(
  paseoHome: string,
  servers: readonly McpCliServerConfig[],
): Promise<void> {
  const binDir = mcpCliBinDir(paseoHome);
  const root = mcpCliRoot(paseoHome);
  await mkdir(binDir, { recursive: true });
  const python = mcpCliPythonPath(paseoHome);
  const runner = mcpCliRunnerPath(paseoHome);

  for (const server of servers) {
    const launcherPath = join(binDir, server.name);
    if (!server.enabled) {
      await rm(launcherPath, { force: true });
      continue;
    }

    const body = `#!/bin/sh
export PASEO_MCP_CLI_ROOT="${root}"
exec "${python}" "${runner}" "${server.name}" "$@"
`;
    await writeFile(launcherPath, body, "utf8");
    await chmod(launcherPath, 0o755);
  }
}
