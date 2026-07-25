# FastMCP CLI

Paseo-managed per-server shell CLIs for remote MCP servers (MVP: Atlassian + Figma). Host Settings → FastMCP configures runtime and OAuth; agents and Paseo terminals get `$PASEO_HOME/mcp-cli/bin` on PATH.

## Disk layout

```
$PASEO_HOME/mcp-cli/
  runtime.json
  fastmcp-cli.py          # vendored runner
  oauth-clients.json      # OAuth client metadata (plaintext)
  venv/                   # uv-managed Python + fastmcp
  servers/{name}.json
  bin/{name}              # sh launchers only — never ~/.local/bin
  cache/                  # schema + OAuth DiskStore
```

## Capability

`server_info.features.mcpCli` (`COMPAT(mcpCli)`, darwin/linux only). Missing → UI shows “Update the host to use this.”

## RPCs

| Request                           | Response    | Notes                                                                            |
| --------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `mcp_cli.runtime.status.request`  | `.response` | Detect uv / venv / runner                                                        |
| `mcp_cli.runtime.install.request` | `.response` | May install uv under `~/.local/bin`; launchers stay in `$PASEO_HOME/mcp-cli/bin` |
| `mcp_cli.servers.list.request`    | `.response` | Presets merged with stored                                                       |
| `mcp_cli.servers.upsert.request`  | `.response` | Writes server + syncs launchers                                                  |
| `mcp_cli.servers.delete.request`  | `.response` | Deletes custom; presets reset                                                    |
| `mcp_cli.servers.test.request`    | `.response` | Runs `<cli> --list`                                                              |

## OAuth (MVP)

1. User already connected Atlassian/Figma MCP in Claude or Cursor.
2. Paste `clientId` / `clientSecret` / `redirectUri` into Host → FastMCP (Atlassian often uses `http://localhost:62367/callback`).
3. First Test / CLI call opens a **browser on the daemon host**. Tokens land in `$PASEO_HOME/mcp-cli/cache/`.
4. Phone configures only; callback runs on the host. Headless / Docker hosts are unsupported for browser OAuth in MVP.
5. Secrets are plaintext JSON (same trust model as schedule env). Do not log secrets; Test responses must not echo them; UI masks secret fields.

## PATH + single channel

- Shared helper `prependMcpCliBinPath` — agent launch env and Paseo terminal env.
- MVP does **not** edit shell rc.
- `daemonAppendSystemPrompt` includes short usage lines for enabled CLIs.
- Launch overlay strips same-name keys from `mcpServers` on create **and** resume/reload. Stored user config is unchanged; strip is launch-only. Enabled CLI wins over plugin.

## Non-goals (MVP)

stdio/bearer CRUD, Claude keychain auto-seed, cross-machine token sync, writing launchers to `~/.local/bin`, auto-import of `mcp.json`, Windows / Docker browser OAuth.
