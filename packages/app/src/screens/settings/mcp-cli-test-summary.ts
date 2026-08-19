/**
 * Turn `<cli> --list` stdout into a short UI summary of tool names.
 * Lines look like: `tool_name   description...  [req: ...]`
 */
export function formatMcpCliToolListSummary(
  stdout: string,
  options: { limit?: number; emptyMessage: string },
): string {
  const limit = options.limit ?? 16;
  const tools: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    // COMPAT(mcpCliListHint): added in v0.1.106, remove after 2027-02-19. Pre-0.1.106
    // daemons print `full catalog + rules: .claude/knowledge/cli/<server>.md` after the
    // `--list` tool lines; filter it so it can't be parsed as a tool name.
    if (!trimmed || trimmed.startsWith("full catalog") || trimmed.startsWith("-")) {
      continue;
    }
    const name = trimmed.split(/\s+/)[0];
    if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      continue;
    }
    tools.push(name);
  }
  if (tools.length === 0) {
    return options.emptyMessage;
  }
  const shown = tools.slice(0, limit);
  const more = tools.length > limit ? ` (+${tools.length - limit} more)` : "";
  return `${tools.length} tools: ${shown.join(", ")}${more}`;
}
