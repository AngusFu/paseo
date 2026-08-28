# DeepSeek Harness

Paseo integrates DeepSeek Harness through two independent surfaces:

| Surface    | Owner              | Role                                           |
| ---------- | ------------------ | ---------------------------------------------- |
| DSH Web UI | Desktop Electron   | Install/start `dsh web` and open its native UI |
| `dsh-acp`  | `packages/dsh-acp` | Run DSH sessions through standard ACP          |

There is no built-in Direct `dsh` provider. Agent integration uses the standalone `dsh-acp` CLI as
a custom `extends: "acp"` provider.

## Desktop Web UI

Process lifecycle lives in `packages/desktop/src/features/deepseek-harness/`, independently of the
Agent provider:

- Install/upgrade under the Desktop user-data toolchain.
- Start and stop the DSH Web process.
- Keep the user's normal `$DSH_HOME`, normally `~/.dsh`.
- Open the native DSH Web origin in the system browser.
- Optionally start DSH Web with Desktop.

Desktop IPC is `paseo:deepseek-harness:{getStatus,install,start,stop,openWorkspace}` plus install-log
streaming. The daemon does not own this Web process.

## ACP CLI

`packages/dsh-acp` translates ACP JSON-RPC on stdio into DSH SDK JSON-RPC while retaining DSH's rich
event stream. It is independently publishable as `@getpaseo/dsh-acp` with binary `dsh-acp`.

Development Custom Provider configuration:

```json
{
  "agents": {
    "providers": {
      "dsh-acp": {
        "extends": "acp",
        "label": "DeepSeek Harness (ACP)",
        "command": ["node", "/absolute/path/to/packages/dsh-acp/dist/cli.js"],
        "params": {
          "supportsMcpServers": true
        }
      }
    }
  }
}
```

Do not configure a static `models` array: generic provider profiles intentionally replace runtime
model discovery when that field exists.

### Setup

`dsh-acp setup` is the explicit, idempotent install path. It uses `uv` to provision
`deepseek-harness-sdk` under `$DSH_HOME/toolchains/dsh-runtime/.venv`, and installs the managed DSH Web
workspace bridge. Ordinary provider probing and session startup perform local discovery only and do
not access the network.

If the DSH Web profile is installed after the runtime, run `dsh-acp setup` again so the live
workspace-registry bridge is added to that profile.

Runtime discovery checks the managed `$DSH_HOME` toolchain, known Paseo Desktop toolchain locations,
and `dsh-jsonrpc-agent` on `PATH`. `--runtime-bin` and `--cordis` remain explicit overrides.

### Models And Thinking

The static base consists only of the official DeepSeek models and models declared in
`$DSH_HOME/settings.yaml` under `llm-pi-ai.providers`. The runtime-side `catalog/list` extension then
uses DSH's generic `ctx.llm.listProviders()`, `listModels()`, and `resolveModelInfo()` APIs to merge
dynamic adapter catalogs and model-specific reasoning levels. GitHub Copilot and other dynamic
providers receive no special-case model table or aliases.

ACP model and thinking changes restart the private DSH runtime while retaining the native session
ID. The restarted runtime receives the selected provider/model route and reasoning effort.

### Timeline

DSH events map to ACP updates:

| DSH                               | ACP                       |
| --------------------------------- | ------------------------- |
| `assistant/chunk` text delta      | `agent_message_chunk`     |
| `assistant/chunk` reasoning delta | `agent_thought_chunk`     |
| `tool/call`                       | `tool_call`               |
| `tool/result`                     | `tool_call_update`        |
| `session.status=idle`             | Complete `session/prompt` |

The prompt request remains pending until the matching inbox receipt and idle transition have both
arrived. Idle-before-receipt is retained rather than dropped.

### Permissions

The published SDK protocol does not expose Cordis `approval/request`. `dsh-acp` appends a small
Cordis plugin and uses inherited fd 3 as a private permission channel while stdout remains the SDK
JSON-RPC wire. Requests become ACP `session/request_permission`; allow-once, reject, cancel, and
unavailable outcomes return to the original DSH tool invocation.

Modes are Ask Before Tools, Read Only, and Full Access. Ask produces visible permission cards when
Paseo Auto Approve is disabled.

### MCP

ACP MCP descriptors are converted into per-session `@deepseek-ai/dsh-mcp-client` Cordis entries.
This includes Paseo's authenticated Agent MCP endpoint, so Paseo tools use the normal Generic ACP
injection path. MCP configuration is retained across model, thinking, permission, and interrupt
runtime restarts.

### Resume

The adapter advertises ACP `session/resume`, not `session/load`. A runtime-side SDK server extension
handles `session/resume` with DSH `ctx.agents.resume()`, loading the compressed JSONL session before
accepting another prompt. Conversation context survives daemon/ACP-process restarts without replaying
old timeline rows. Full historical timeline hydration remains future `session/load` work.

### DSH Workspace Grouping

DSH Web keeps `ctx.workspaceRegistry` in memory. Editing `~/.dsh/storages/workspace.json` while Web is
running does not update the UI and can be overwritten by its next registry write.

`dsh-acp setup` installs a managed Web host bridge. New sessions:

1. Ensure the canonical cwd through the live DSH Web workspace registry.
2. Start the private DSH runtime.
3. After the first turn materializes the session header, call DSH's validated
   `Workspace.attachSession()` through the bridge.

Resumed sessions attach immediately because their stored header already exists. If DSH Web is
offline, the adapter falls back to atomic workspace-file updates.

## Current Gaps

- ACP `session/load` history replay.
- Richer tool presentation beyond the current execute/read/edit/search categories.
- First-class projection of DSH-native subagent lifecycle into Paseo's subagents track.
