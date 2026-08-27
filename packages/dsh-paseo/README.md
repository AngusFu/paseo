# dsh-paseo

Paseo-aligned DeepSeek Harness tooling, vendored into the Paseo monorepo for Desktop.

## Surfaces

| Surface      | Path         | Role                                                                            |
| ------------ | ------------ | ------------------------------------------------------------------------------- |
| Host plugin  | `src/host`   | `/api/paseo.worktree.*`, `/api/paseo.session.archive`                           |
| MCP server   | `src/mcp`    | Paseo-named tools over the DSH Web API (`create_agent`, `send_agent_prompt`, …) |
| CLI          | `src/cli`    | `dsh-paseo ls/run/send/permission/...`                                          |
| Client embed | `src/client` | Desktop embed: `?paseoEmbed=1&sessionId=` (+ optional `permission`, `sidebar`)  |

## Desktop embed contract

Paseo Desktop opens (after `session.create`):

```text
http://127.0.0.1:<port>/?paseoEmbed=1&sessionId=<id>&sidebar=collapsed
```

Optional query params:

```text
&permission=workspace-write|read-only|danger-full-access
&agentPreset=standard|code|minimal|cordis
&sidebar=collapsed|hidden|open
```

## Manual mount

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add /path/to/packages/dsh-paseo
# restart dsh web
```
