# FastMCP CLI

Paseo-managed per-server shell CLIs for MCP servers. Host Settings → FastMCP configures runtime and servers; agents and Paseo terminals get `$PASEO_HOME/mcp-cli/bin` on PATH.

## Mental model

`fastmcp-cli.py` is:

1. **CLI shell** over stock FastMCP (`Client` + `StdioMCPServer` / `RemoteMCPServer.to_transport()`): open HTTP, bearer, headers, `auth: "oauth"` (DCR), stdio.
2. **OAuth polyfill** only when `oauth_client_id` is set (Atlassian / Figma): pre-registered client + AS metadata pre-seed / refresh guard / lock, because those providers block DCR and their metadata/token endpoints diverge from the stock mcp-SDK path.
3. **Local stateful proxy** for pre-registered OAuth servers: auto-start a localhost FastMCP proxy once, reuse the upstream session across one-shot CLI invocations.

Do not invent extra concepts for open HTTP — registry row is just `{ "url": "…" }`.

## Supports

- **HTTP open / no-auth** (`url` only)
- **HTTP + headers / bearer** (FastMCP `headers` or `auth: "<token>"`)
- **HTTP + OAuth DCR** (`auth: "oauth"`)
- **HTTP + pre-registered OAuth** (presets / `oauth_client_id` + polyfill)
- **Stdio** (`command` / `args` / optional `env` / `cwd` — env overlays MCP SDK allowlist)

Presets ship for Atlassian + Figma. Add others via **Add**, **JSON** import, or **Import from host**. Bearer/headers have no dedicated Host form yet — use JSON / Import / agent tools.

## Disk layout

```
$PASEO_HOME/mcp-cli/
  runtime.json
  fastmcp-cli.py          # vendored runner (CLI shell + OAuth polyfill)
  mcp-servers.json        # FastMCP-shaped registry (enabled servers only)
  venv/                   # uv-managed Python + fastmcp
  servers/{name}.json     # Paseo server rows (enabled, preset, structured auth)
  bin/{name}              # sh launchers only — never ~/.local/bin
  cache/                  # schema + OAuth DiskStore
    proxy/                # local stateful proxy pid/log per OAuth server
```

`COMPAT(mcpServersRegistryRename)`: older homes used `oauth-clients.json`. Runner still reads it if `mcp-servers.json` is missing; the next upsert/install writes the new file and removes the legacy one. External import still scans `~/.config/sciforum/oauth-clients.json` (third-party path, unchanged).

### Registry shape (`mcp-servers.json`)

Enabled servers only, FastMCP-aligned:

```json
{
  "open": { "transport": "http", "url": "https://example.com/mcp" },
  "token": {
    "transport": "http",
    "url": "https://x",
    "auth": "secret",
    "headers": { "X-Extra": "1" }
  },
  "dcr": { "transport": "http", "url": "https://y", "auth": "oauth" },
  "figma": {
    "transport": "http",
    "url": "https://mcp.figma.com/mcp",
    "auth": "oauth",
    "oauth_client_id": "…",
    "oauth_client_secret": "…",
    "oauth_scope": "mcp:connect"
  },
  "local": { "transport": "stdio", "command": "npx", "args": ["-y", "foo"] }
}
```

Legacy rows with `source` instead of `url` are still accepted by the runner (`COMPAT(source→url)`).

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

- **HTTP open**: no `auth` → FastMCP `RemoteMCPServer.to_transport()` (Streamable HTTP).
- **HTTP bearer/headers**: FastMCP `auth` string and/or `headers`.
- **HTTP OAuth DCR**: `auth: "oauth"` without `oauth_client_id` → stock FastMCP OAuth.
- **HTTP pre-registered OAuth (polyfill)**: `oauth_client_id` present → launcher auto-starts a localhost stateful FastMCP proxy (`cache/proxy`) and CLIs call that proxy; the proxy owns the upstream OAuth session (handshake cost paid once) and still uses FastMCP `OAuth(client_id=…)` plus AS metadata pre-seed / refresh guard / lock. Set `FASTMCP_DISABLE_LOCAL_PROXY=1` to force direct one-shot behavior. First call may open a **browser on the daemon host**. Tokens land in `$PASEO_HOME/mcp-cli/cache/`.
- **Stdio**: FastMCP `StdioMCPServer.to_transport()` with `keep_alive=false`. Env is MCP SDK default allowlist plus optional config `env` overlay (not a full `os.environ` copy).
- Phone configures only; OAuth callback runs on the host. Headless / Docker hosts are unsupported for browser OAuth.
- Secrets are plaintext JSON (same trust model as schedule env). Do not log secrets; Test responses must not echo them; UI masks secret fields. Never commit `$PASEO_HOME` / `.dev/paseo-home` secrets into git.
- Toggle Enable **auto-saves**. Save persists URL/command + OAuth fields. Test shows toast + inline result (do not rely on `Alert` alone on web).
- After Install or upsert, the vendored runner file is refreshed under `$PASEO_HOME/mcp-cli/`. Already-open terminals keep their old `PASEO_MCP_CLI_BIN` until a new terminal is created.

## Add / import

- **Import from host** — one click: scans `~/.cursor/mcp.json`, Claude Desktop config, `~/.claude.json` `mcpServers`, and `~/.config/sciforum/oauth-clients.json` on the **daemon host**. Imports FastMCP-shaped HTTP (incl. bearer/headers/oauth) + stdio.
- **Add** — choose HTTP (name + URL) or Stdio (name + command + args); fill OAuth on the HTTP card afterward if needed. Bearer/headers via JSON for now.
- **JSON** — opens with the **current** servers serialized as `{ "mcpServers": { … } }` (FastMCP `url`/`auth`/`headers`/`command`). Edit and Import to apply; also accepts a bare name→config map or a Paseo server array.
- **Agent MCP tools** (when Paseo tools are injected): `mcp_cli_list_servers`, `mcp_cli_upsert_server`, `mcp_cli_delete_server`, `mcp_cli_import_local`, `mcp_cli_test_server` — configure FastMCP via conversation. List responses omit secret values (`hasOAuth` / `hasBearer` only).

## PATH + single channel

- Shared helper `prependMcpCliBinPath` — agent launch env and Paseo terminal env.
- Inject only when `$PASEO_HOME/mcp-cli/bin` **exists** (after Detect/Install). Agents use the daemon’s configured `paseoHome` directly; terminals get the same home via bootstrap (`process.env.PASEO_HOME`) + explicit `paseoHome` on create (worker fork included).
- **Gotcha:** agent launch overlays are sparse (`PASEO_AGENT_ID` / workspace id only). `prependMcpCliBinPath` must inherit `process.env.PATH` when the overlay has no PATH — otherwise `createExternalProcessEnv` replaces the child’s PATH with only `mcp-cli/bin` and provider CLIs (Cursor ACP, etc.) hang on create. Terminals already pass a full base env, so they were fine.
- Paseo does **not** edit the user’s shell rc. For zsh PTY terminals, shell integration sets `PASEO_MCP_CLI_BIN` and re-prepends that dir after `.zshenv` / on `precmd` so mise/asdf/`.zshrc` PATH rewrites don’t hide the CLIs.
- `daemonAppendSystemPrompt` includes short usage lines for enabled CLIs.
- Launch overlay strips same-name keys from `mcpServers` on create **and** resume/reload. Stored user config is unchanged; strip is launch-only. Enabled CLI wins over plugin.
- Packaged desktop (`~/.paseo`) and repo `.dev/paseo-home` are separate homes — Install FastMCP on the host you’re actually connected to.

## Non-goals (MVP)

Dedicated Host UI for bearer/headers fields, Claude keychain token sync, cross-machine token sync, writing launchers to `~/.local/bin`, Windows / Docker browser OAuth.
