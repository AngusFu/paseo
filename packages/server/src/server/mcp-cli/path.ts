import { delimiter } from "node:path";
import { mcpCliBinDir } from "./paths.js";

function getPathEnvKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function prependPathEntry(currentPath: string, entry: string): string {
  const entries = currentPath.split(delimiter).filter((value) => value && value !== entry);
  return [entry, ...entries].join(delimiter);
}

/**
 * Prepend `$PASEO_HOME/mcp-cli/bin` for agent + terminal processes.
 * Never writes into ~/.local/bin — only mutates the env PATH for this process tree.
 *
 * When `env` has no PATH yet (agent launch overlays are sparse), inherit from
 * `process.env`. Otherwise createExternalProcessEnv would replace the child's
 * full PATH with only mcp-cli/bin and break provider CLIs (e.g. cursor-agent).
 */
export function prependMcpCliBinPath(
  env: Record<string, string>,
  paseoHome: string,
): Record<string, string> {
  const binDir = mcpCliBinDir(paseoHome);
  const pathKey = getPathEnvKey(env);
  const processPathKey = getPathEnvKey(process.env);
  const currentPath = env[pathKey] ?? process.env[processPathKey] ?? process.env.PATH ?? "";
  return {
    ...env,
    [pathKey]: prependPathEntry(currentPath, binDir),
  };
}
