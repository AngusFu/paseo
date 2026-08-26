# dsh-paseo

Paseo-aligned DeepSeek Harness tooling, vendored into the Paseo monorepo for Desktop.

## Surfaces

| Surface      | Path         | Role                                                                                |
| ------------ | ------------ | ----------------------------------------------------------------------------------- |
| Host plugin  | `src/host`   | `/api/paseo.worktree.*`, `/api/paseo.session.archive`                               |
| MCP server   | `src/mcp`    | Paseo-named tools over the DSH Web API                                              |
| CLI          | `src/cli`    | `dsh-paseo ls/run/send/...`                                                         |
| Client embed | `src/client` | Desktop embed: `?paseoEmbed=1&workspaceId=` creates a session and hides the sidebar |

## Desktop embed contract

Paseo Desktop opens:

```text
http://127.0.0.1:<port>/?paseoEmbed=1&workspaceId=<dsh-workspace-id>
```

Optional agent deep link:

```text
http://127.0.0.1:<port>/?paseoEmbed=1&sessionId=<dsh-session-id>
```

The managed `dsh web` process installs this package into `$DSH_HOME/profiles/web` and applies `cordis.patch.yml` via `--patch`.

## Manual mount

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add /path/to/packages/dsh-paseo
# restart dsh web
```
