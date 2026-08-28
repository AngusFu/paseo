# @getpaseo/dsh-acp

ACP adapter for DeepSeek Harness. It translates standard ACP JSON-RPC over stdio into the richer
`dsh-jsonrpc-agent` SDK protocol while preserving streaming text, reasoning, and tool activity.

This package is initially shipped as an experimental CLI alongside Paseo's existing direct `dsh`
provider. It does not replace that provider.

## Setup

Run the explicit, idempotent setup command once:

```bash
dsh-acp setup
```

It uses `uv` to install `deepseek-harness-sdk` under
`$DSH_HOME/toolchains/dsh-runtime/.venv`. Normal ACP startup never installs software or accesses the
network; it discovers that managed toolchain, a runtime on `PATH`, and known Paseo Desktop toolchain
locations. Explicit `--runtime-bin` and `--cordis` overrides remain available.

When a DSH Web profile already exists, setup also installs the live workspace-registry bridge. Run
setup again after installing DSH Web if that profile is created later.

Credentials come from `$DSH_HOME/.credentials.yaml` or the process environment.

## Paseo Custom Provider

Build the package, then add this to `$PASEO_HOME/config.json`:

```json
{
  "agents": {
    "providers": {
      "dsh-acp": {
        "extends": "acp",
        "label": "DeepSeek Harness (ACP)",
        "command": ["node", "/absolute/path/to/packages/dsh-acp/dist/cli.js"],
        "params": {
          "supportsMcpServers": false
        },
        "models": [
          {
            "id": "deepseek-v4-flash",
            "label": "DeepSeek V4 Flash",
            "isDefault": true
          }
        ]
      }
    }
  }
}
```

The first slice supports fresh and resumed DSH sessions, multiple text turns, streaming,
reasoning, tool activity, interactive one-shot permissions, and cancellation with lazy runtime
recovery. Full history replay through ACP `session/load` is intentionally deferred; resume keeps the
native DSH session context without replaying old rows.

The CLI adds a small Cordis plugin to the runtime composition. DSH `approval/request` calls are sent
over a private process channel and translated to ACP `session/request_permission`; allow, reject,
cancel, and unavailable outcomes return to the original DSH tool invocation.

Models follow Paseo's DSH discovery shape: official DeepSeek models, `llm-pi-ai.providers` from
`$DSH_HOME/settings.yaml`, and installed `dsh-llm-*` plugins. There are no provider-specific model
aliases or hardcoded Copilot models. Do not add a static `models` array to the Paseo custom provider,
because that intentionally replaces runtime discovery.

For adapters with dynamic catalogs, including GitHub Copilot, the runtime plugin calls the generic
DSH `ctx.llm.listProviders()` and `ctx.llm.listModels()` APIs and merges their current results into the
ACP model state. Copilot receives no special-case model table.

Before a new or resumed native session is opened, the adapter ensures the canonical cwd exists in
`$DSH_HOME/storages/workspace.json` and attaches the session id. DSH Web therefore groups ACP-created
sessions with their workspace instead of showing them as ungrouped.

When DSH Web is running, its workspace registry is memory-resident and direct file edits are stale.
`dsh-acp setup` installs a small Web host bridge into the Web profile. New sessions first ensure the
workspace through the live Web API, then attach through DSH's own `Workspace.attachSession()` after
the native session header is durable. File updates are used only when DSH Web is offline.

ACP `mcpServers` are materialized as per-session `@deepseek-ai/dsh-mcp-client` Cordis entries. This
includes Paseo's authenticated internal MCP endpoint, so Paseo tools are injected through the normal
generic ACP path.

The ACP mode selector exposes Ask Before Tools, Read Only, and Full Access. Ask Before Tools uses
ACP permissions for every DSH tool call; turn off Paseo's Auto Approve toggle to require a visible
human decision. Thinking options are model-specific and refresh after a model switch.

## Options

```text
dsh-acp [--provider route] [--model model] [--runtime-bin path]
        [--cordis path] [--dsh-home path] [--session-root path]
        [--max-tokens number]
```

Equivalent environment variables are `DSH_PROVIDER`, `DSH_MODEL`, `DSH_JSONRPC_AGENT`,
`DSH_CORDIS_CONFIG`, `DSH_HOME`, `DSH_SESSION_ROOT`, and `DSH_MAX_TOKENS`.
