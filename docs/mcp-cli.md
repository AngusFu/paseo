# FastMCP CLI

Paseo-managed per-server shell CLIs for MCP servers. Host Settings → FastMCP configures runtime and servers; agents and Paseo terminals get `$PASEO_HOME/mcp-cli/bin` on PATH.

Supports:

- **HTTP + OAuth** (Atlassian / Figma presets; pasted clientId)
- **HTTP open / no-auth** (URL only — runner does not wrap OAuth)
- **Stdio** (`command` / `args` / optional `env` / `cwd`)

Bearer/`headers` auth is still unsupported.

Presets ship for Atlassian + Figma. Add others via **Add**, **JSON** import (Claude/Cursor `mcpServers` paste), or **Import from host**.

## Disk layout

```
$PASEO_HOME/mcp-cli/
  runtime.json
  fastmcp-cli.py          # vendored runner
  oauth-clients.json      # per-server registry (HTTP + stdio; filename kept for back-compat)
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

## Auth + transports

- **HTTP open**: no `auth` / empty Client ID → runner uses `StreamableHttpTransport` with no OAuth wrapper.
- **HTTP OAuth**: paste `clientId` (and usually redirectUri). First Test / CLI call may open a **browser on the daemon host**. Tokens land in `$PASEO_HOME/mcp-cli/cache/`.
- **Stdio**: `transport: "stdio"` + `command` (+ `args` / `env` / `cwd`). Each CLI invocation spawns the process (`keep_alive=false`); env is process env plus config overlay.
- Phone configures only; OAuth callback runs on the host. Headless / Docker hosts are unsupported for browser OAuth.
- Secrets are plaintext JSON (same trust model as schedule env). Do not log secrets; Test responses must not echo them; UI masks secret fields. Never commit `$PASEO_HOME` / `.dev/paseo-home` secrets into git.
- Toggle Enable **auto-saves**. Save persists URL/command + OAuth fields. Test shows toast + inline result (do not rely on `Alert` alone on web).
- After Install or upsert, the vendored runner file is refreshed under `$PASEO_HOME/mcp-cli/`. Already-open terminals keep their old `PASEO_MCP_CLI_BIN` until a new terminal is created.

## Add / import

- **Import from host** — one click: scans `~/.cursor/mcp.json`, Claude Desktop config, `~/.claude.json` `mcpServers`, and `~/.config/sciforum/oauth-clients.json` on the **daemon host**. Imports HTTP + stdio; skips bearer/headers.
- **Add** — choose HTTP (name + URL) or Stdio (name + command + args); fill OAuth on the HTTP card afterward if needed.
- **JSON** — opens with the **current** servers serialized as `{ "mcpServers": { … } }`. Edit and Import to apply; also accepts a bare name→config map or a Paseo server array. `headers` (bearer) entries are skipped with warnings.
- **Agent MCP tools** (when Paseo tools are injected): `mcp_cli_list_servers`, `mcp_cli_upsert_server`, `mcp_cli_delete_server`, `mcp_cli_import_local`, `mcp_cli_test_server` — configure FastMCP via conversation. List responses omit secret values (`hasOAuth` only).

## PATH + single channel

- Shared helper `prependMcpCliBinPath` — agent launch env and Paseo terminal env.
- Inject only when `$PASEO_HOME/mcp-cli/bin` **exists** (after Detect/Install). Agents use the daemon’s configured `paseoHome` directly; terminals get the same home via bootstrap (`process.env.PASEO_HOME`) + explicit `paseoHome` on create (worker fork included).
- Paseo does **not** edit the user’s shell rc. For zsh PTY terminals, shell integration sets `PASEO_MCP_CLI_BIN` and re-prepends that dir after `.zshenv` / on `precmd` so mise/asdf/`.zshrc` PATH rewrites don’t hide the CLIs.
- `daemonAppendSystemPrompt` includes short usage lines for enabled CLIs.
- Launch overlay strips same-name keys from `mcpServers` on create **and** resume/reload. Stored user config is unchanged; strip is launch-only. Enabled CLI wins over plugin.
- Packaged desktop (`~/.paseo`) and repo `.dev/paseo-home` are separate homes — Install FastMCP on the host you’re actually connected to.

## Non-goals (MVP)

Bearer/`headers` CRUD UI, Claude keychain token sync, cross-machine token sync, writing launchers to `~/.local/bin`, Windows / Docker browser OAuth.
