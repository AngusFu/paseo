# FastMCP CLI

Paseo-managed per-server shell CLIs for remote HTTP MCP servers. Host Settings → FastMCP configures runtime, servers, and optional OAuth; agents and Paseo terminals get `$PASEO_HOME/mcp-cli/bin` on PATH.

Presets ship for Atlassian + Figma. Add any other remote HTTP MCP via **Add** or **JSON** import (Claude/Cursor `mcpServers` paste).

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

| Request                                | Response    | Notes                                                                            |
| -------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `mcp_cli.runtime.status.request`       | `.response` | Detect uv / venv / runner                                                        |
| `mcp_cli.runtime.install.request`      | `.response` | May install uv under `~/.local/bin`; launchers stay in `$PASEO_HOME/mcp-cli/bin` |
| `mcp_cli.servers.list.request`         | `.response` | Presets merged with stored                                                       |
| `mcp_cli.servers.upsert.request`       | `.response` | Writes server + syncs launchers                                                  |
| `mcp_cli.servers.delete.request`       | `.response` | Deletes custom; presets reset                                                    |
| `mcp_cli.servers.test.request`         | `.response` | Runs `<cli> --list`                                                              |
| `mcp_cli.servers.import_local.request` | `.response` | Scans Claude/Cursor/`sciforum` configs on the daemon host and upserts            |

## Auth

- **OAuth optional** for open endpoints or servers that support OAuth DCR. Missing `clientId` → runner still attempts the connection.
- Atlassian / Figma still need a pasted `clientId` (and usually redirectUri). Copy from Claude/Cursor MCP settings, use **Import from host**, or paste a whole `mcpServers` blob via **JSON**.
- First Test / CLI call opens a **browser on the daemon host**. Tokens land in `$PASEO_HOME/mcp-cli/cache/`.
- Phone configures only; callback runs on the host. Headless / Docker hosts are unsupported for browser OAuth in MVP.
- Secrets are plaintext JSON (same trust model as schedule env). Do not log secrets; Test responses must not echo them; UI masks secret fields. Never commit `$PASEO_HOME` / `.dev/paseo-home` secrets into git.
- Toggle Enable **auto-saves**. Save persists URL + OAuth fields. Test shows toast + inline result (do not rely on `Alert` alone on web).

## Add / import

- **Import from host** — one click: scans `~/.cursor/mcp.json`, Claude Desktop config, `~/.claude.json` `mcpServers`, and `~/.config/sciforum/oauth-clients.json` on the **daemon host**.
- **Add** — name + HTTP URL; fill OAuth on the card afterward if needed.
- **JSON** — opens with the **current** servers serialized as `{ "mcpServers": { … } }`. Edit and Import to apply; also accepts a bare name→config map or a Paseo server array. `stdio` / `command` and `headers` (bearer) entries are skipped with warnings.
- **Agent MCP tools** (when Paseo tools are injected): `mcp_cli_list_servers`, `mcp_cli_upsert_server`, `mcp_cli_delete_server`, `mcp_cli_import_local`, `mcp_cli_test_server` — configure FastMCP via conversation. List responses omit secret values (`hasOAuth` only).

## PATH + single channel

- Shared helper `prependMcpCliBinPath` — agent launch env and Paseo terminal env.
- Inject only when `$PASEO_HOME/mcp-cli/bin` **exists** (after Detect/Install). Agents use the daemon’s configured `paseoHome` directly; terminals get the same home via bootstrap (`process.env.PASEO_HOME`) + explicit `paseoHome` on create (worker fork included).
- Paseo does **not** edit the user’s shell rc. For zsh PTY terminals, shell integration sets `PASEO_MCP_CLI_BIN` and re-prepends that dir after `.zshenv` / on `precmd` so mise/asdf/`.zshrc` PATH rewrites don’t hide the CLIs.
- `daemonAppendSystemPrompt` includes short usage lines for enabled CLIs.
- Launch overlay strips same-name keys from `mcpServers` on create **and** resume/reload. Stored user config is unchanged; strip is launch-only. Enabled CLI wins over plugin.
- Packaged desktop (`~/.paseo`) and repo `.dev/paseo-home` are separate homes — Install FastMCP on the host you’re actually connected to.

## Non-goals (MVP)

stdio/bearer CRUD UI, Claude keychain token sync, cross-machine token sync, writing launchers to `~/.local/bin`, Windows / Docker browser OAuth.
