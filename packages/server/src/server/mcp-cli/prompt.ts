import type { McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";

/**
 * Short daemonAppend fragment so agents prefer the shell CLI over MCP plugins.
 */
export function formatMcpCliDaemonAppendPrompt(servers: readonly McpCliServerConfig[]): string {
  const enabled = servers.filter((server) => server.enabled);
  if (enabled.length === 0) {
    return "";
  }

  const names = enabled.map((server) => server.name);
  const examples = enabled.flatMap((server) => {
    if (server.name === "atlassian") {
      return [
        "`atlassian --list`",
        "`atlassian getJiraIssue --cloudId <cid> --issueIdOrKey SCIF-1234`",
      ];
    }
    if (server.name === "figma") {
      return ["`figma --list`", "`figma whoami`"];
    }
    return [`\`${server.name} --list\``];
  });

  return [
    "# MCP CLIs (Paseo)",
    `Enabled: ${names.join(", ")}. Call these via shell — do not use same-name MCP plugins.`,
    `Examples: ${examples.slice(0, 4).join(" · ")}.`,
    "Discover: `<cli> --list` / `<cli> --search <kw>` / `<cli> <tool> --help`.",
  ].join("\n");
}

/** Remove mcpServers keys that collide with enabled CLI names (launch overlay only). */
export function stripMcpServersMatchingCliNames<T extends Record<string, unknown>>(
  mcpServers: T | undefined,
  enabledCliNames: ReadonlySet<string>,
): T | undefined {
  if (!mcpServers || enabledCliNames.size === 0) {
    return mcpServers;
  }
  const next = { ...mcpServers };
  let changed = false;
  for (const key of Object.keys(next)) {
    if (enabledCliNames.has(key)) {
      delete next[key];
      changed = true;
    }
  }
  if (!changed) {
    return mcpServers;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
