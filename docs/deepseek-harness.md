# DeepSeek Harness

Two separate surfaces — do not conflate them:

| Surface                      | Where                      | Role                                             |
| ---------------------------- | -------------------------- | ------------------------------------------------ |
| **Web UI sidecar**           | Desktop Electron only      | Install/start `dsh web`, open in system browser  |
| **Agent provider (planned)** | Daemon (`packages/server`) | Run DSH as a Paseo agent, like `pi` / `opencode` |

---

## Desktop Web UI

Desktop-managed integration for the DeepSeek Harness (`@deepseek-ai/dsh`) Web UI.

### Ownership

- Process lifecycle lives in **Electron main** (`packages/desktop/src/features/deepseek-harness/`), same shape as code-server: install / start / stop / quit cleanup.
- Daemon does not manage DSH. Mobile and plain browser clients do not expose the UI.
- Node runtime for install + `dsh web` is Electron’s own binary via `ELECTRON_RUN_AS_NODE=1`.
- Start argv must include Node’s `--expose-internals` **before** the dsh entry script. Cordis HMR requires it; putting the flag in `NODE_OPTIONS` is rejected under Electron.
- Desktop keeps the user’s normal `$DSH_HOME` (typically `~/.dsh`). It does not isolate a separate harness home.
- Spawn captures stdout/stderr. On readiness failure the status exposes `lastError` with that log tail so Settings can show **Starting… / Running / Stopped / Start failed** instead of only “Installed”.
- Stop kills whatever holds the persisted loopback port (`lsof` / `netstat`), not a saved child handle — same as code-server. Detached dsh can outlive a Paseo restart; `spawnedByUs` only gates quit cleanup, not the Settings **Stop** button.

### Settings

Desktop-only Settings section `deepseek-harness`:

- Install / Upgrade (`npm install @deepseek-ai/dsh@latest --prefix <userData>/toolchains/deepseek-harness`)
  - Button shows a loading state while npm runs
  - Live stdout/stderr streams into an install-log panel via `paseo:deepseek-harness:install-log`
- Start / Stop (status badge reflects starting / running / stopped / failed; `lastError` panel after a failed start)
- **Start with Desktop** (`desktop-settings.deepseekHarness.startWithDesktop`)
- Persisted listen port (`deepseekHarness.port`); first start allocates a free loopback port and keeps it

### Workspace UI

- Header action button next to **VS Code Web** (always shown when the Desktop bridge is available)
- Click starts DSH if needed, then opens the native Web origin in the **system default browser** via `shell.openExternal` (not an Electron tab/webview)

### IPC

`paseo:deepseek-harness:{getStatus,install,start,stop,openWorkspace}` plus `onInstallLog` on `window.paseoDesktop.deepseekHarness`.
`install` returns full runtime status after the npm install completes.
`openWorkspace` ensures the process is running and opens `{ status, url }` in the default browser.

---

## Agent provider (MVP) — SDK JSON-RPC, not ACP

Direct provider id: `dsh` (label: DeepSeek Harness), disabled by default (`enabledByDefault: false`).

Implementation: `packages/server/src/server/agent/providers/dsh/` (hand-rolled newline JSON-RPC; no `@deepseek-ai/dsh-sdk-client`).

### Why not ACP / why not Python inside the daemon

DSH exposes three programmatic surfaces:

1. **ACP** (`@deepseek-ai/dsh-acp` / `dsh-acp-demo`) — standards-compliant but automation-thin: committed assistant text only, no tool/reasoning stream on the wire, rejects non-empty `mcpServers`, fresh sessions only.
2. **SDK JSON-RPC** (Python `deepseek-harness-sdk` ≡ TS `@deepseek-ai/dsh-sdk-client`) — full `session.event` log (`assistant/chunk`, `tool/call`, `tool/result`, `turn/*`, subagent notifications). This is the right fidelity for a Paseo timeline.
3. **Headless** (`dsh --profile headless`) — one-shot; not a multi-turn session.

Paseo’s daemon is Node/TS. Prefer a **Direct** provider (same pattern as `pi`) that spawns the bundled `dsh-jsonrpc-agent` runtime and speaks the SDK wire from TypeScript. Use the Python SDK for smoke tests and protocol reference only — do not put a Python bridge in the daemon hot path.

Verified locally (2026-08-27):

- Python `deepseek-harness-sdk==0.1.1rc1` + `minimal.cordis.yml` completed a text turn and a bash tool turn (`assistant/chunk`, `tool/call`, `tool/result`, `turn/end`).
- Paseo `DshAgentClient` against the same bundled `dsh-jsonrpc-agent` + runtime `cordis.yml` streamed `PASEO_DSH_PROVIDER_OK` through the provider timeline (`turn_started` → assistant chunks → `turn_completed`). Auth from `~/.dsh/.credentials.yaml` / `DEEPSEEK_API_KEY`.

### Wire contract (SDK)

Transport: newline-delimited JSON-RPC 2.0 on stdio. Stdout is protocol-only; diagnostics on stderr.

| Direction | Method                                   | Notes                                                    |
| --------- | ---------------------------------------- | -------------------------------------------------------- |
| C→S       | `initialize`                             | `cwd`, `provider`, `model`, optional `maxTokens`         |
| C→S       | `session/prompt`                         | Queues user message; returns `{ messageId }` immediately |
| C→S       | `shutdown`                               | Quiesce then exit 0                                      |
| S→C       | `session.event`                          | Full session-log envelope (unfiltered)                   |
| S→C       | `session.status`                         | Whole-agent `running` / `idle`                           |
| S→C       | `subagent.started` / `subagent.finished` | In-process children                                      |

Known SDK limits (pre-release): no protocol-version negotiation; **no cancel / session-close** — abandon a turn by killing the runtime process; server→client requests are unused (future approvals).

### Mapping onto Paseo (Direct provider sketch)

Closest existing reference: `providers/pi/` (process-backed RPC + JSONL sessions).

| Paseo                                 | DSH SDK                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `createSession`                       | Spawn runtime once (reuse across turns); `initialize` with workspace `cwd`; allocate `sessionId`                          |
| `run` / turn ownership                | `session/prompt` → wait for inbox receipt of `messageId` → collect `session.event` until `session.status=idle`            |
| Timeline `assistant_message` / chunks | `assistant/chunk` + committed `assistant/message`                                                                         |
| Timeline `tool_call`                  | `tool/call` (`data.callId`, `name`, `arguments`) + `tool/result`                                                          |
| Subagents track                       | `subagent.started` / `subagent.finished`                                                                                  |
| `interrupt`                           | Kill / restart runtime (no cancel RPC yet) — document UX gap                                                              |
| `resumeSession` / import              | Read `DSH_SESSION_ROOT` JSONL; SDK itself is get-or-create by `sessionId`                                                 |
| Auth                                  | Inherit `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` (or load from `~/.dsh/.credentials.yaml` refs)                           |
| Models                                | `$PASEO_HOME/dsh-provider/settings.yaml` (`llm-pi-ai.providers`) + static defaults; catalog via `fetchCatalog`            |
| MCP / Paseo tools                     | Session-scoped Cordis materialization from `config.mcpServers` + profile patch; `supportsMcpServers` when servers present |
| Permissions                           | Default `minimal` / danger compositions auto-run tools; richer compositions may grow approval requests later              |

### Runtime packaging options

1. **Ship / resolve `dsh-jsonrpc-agent`** from `deepseek-harness-runtime-bin` (Python wheel) or a future npm carrier; require user install.
2. **Depend on `@deepseek-ai/dsh-sdk-client`** and pass an explicit launch `{ command, args, cordis }` (TS client does not yet bundle the runtime the way Python does).
3. Reuse Desktop toolchain’s `@deepseek-ai/dsh` install only for Web UI — it is **not** the JSON-RPC agent binary.

Recommended MVP: user installs runtime (document `pip install deepseek-harness-sdk` or a dedicated npm bin once published); Paseo provider resolves `dsh-jsonrpc-agent` on `PATH` (or `params.runtimeBin`) and a Cordis file (`params.cordis` or bundled `minimal.cordis.yml`).

### Try it (dev checkout)

Packaged Desktop (`Paseo.app` on `:6767`) does **not** include this provider until a release ships the new server code. Use the checkout daemon on `:6768`:

1. Runtime toolchain (already under `.dev/toolchains/dsh-runtime/` in this checkout): `uv venv` + `uv pip install deepseek-harness-sdk`, symlink `dsh-jsonrpc-agent`.
2. Enable in `.dev/paseo-home/config.json` (`agents.providers.dsh.enabled: true` + `params.runtimeBin` / `params.cordis`).
   **Auth / credentials:** Paseo sets `DSH_HOME` and injects refs from `~/.dsh/.credentials.yaml` into the `dsh-jsonrpc-agent` process environment (same keys the Web Models page writes). Custom `llm-pi-ai` routes such as `x-9router/...` need their `apiKeyEnv` stored there, or exported in the daemon environment. `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` still pass through from the daemon env when unset in the credentials file.
3. Restart **only** the checkout `npm run dev:server` (port **6768**). Do not restart production `:6767`.
4. Point the web/desktop client at the dev daemon, create an agent with provider `dsh` / model `deepseek-v4-flash`.

### MCP injection

**Current state:** On session open, the provider merges base Cordis (`params.cordis`), profile `llm-pi-ai` providers, persistent `cordis.patch.yml`, and per-agent `config.mcpServers` into a temp `cordis.yml` (`DSH_CORDIS_CONFIG`). Session capabilities set `supportsMcpServers: true` when MCP servers are present. Plugin deps live under `$PASEO_HOME/dsh-provider/node_modules` and are exposed via `NODE_PATH`.

**DSH side:** MCP is a Cordis plugin (`@deepseek-ai/dsh-mcp-client`), one instance per external server. Tools surface as `mcp__<serverName>__<rawName>` on `ctx.tools`. Transports: `stdio` or `streamable-http` (Paseo's Agent MCP endpoint fits the latter).

Example overlay (materialized per session when Paseo injects MCP):

```yaml
- id: mcp-paseo
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: paseo
    transport: streamable-http
    url: http://127.0.0.1:6768/mcp/agents?callerAgentId=<agentId>
    headers:
      Authorization: Bearer <mcpAuthToken>
```

**Provider profile:** defaults to `DSH_HOME` (`~/.dsh`) — same `settings.yaml` as the Desktop Web UI. Paseo-specific Cordis patch + plugin `package.json` live under `~/.dsh/paseo/`. Override with `agents.providers.dsh.params.profileHome` / `sessionRoot` if needed.

**Sessions:** default `~/.dsh/sessions` with Web-compatible `session-<uuid>` IDs. Paseo can import/resume Web sessions when the Web runtime is idle (`listImportableSessions` / `importSession`). Hot dual-writer sharing is not supported.

**Cordis overlay:** custom `llm-pi-ai` routes are materialized into the temp `cordis.yml` alongside the Python runtime base. Do **not** mount `dsh-credentials-local` / `dsh-settings-file` there — the SDK `dsh-jsonrpc-agent` SEA binary cannot load those plugins from `NODE_PATH`. Credentials for pi-ai routes are injected via `applyDshRuntimeEnv()` (`DSH_HOME` + `~/.dsh/.credentials.yaml` refs → process env).

**Dependency note:** `dsh-llm-pi-ai` and `dsh-mcp-client` resolve from `NODE_PATH` (Desktop toolchain `node_modules` or `~/.dsh/paseo/node_modules`). The auto `pnpm install` in `~/.dsh/paseo/` may fail on private packages; Desktop fallback covers local dev.

**Settings UI:** model routes, MCP plugins, and Cordis composition are managed in the Desktop **DSH Web** UI (`~/.dsh`). Paseo's provider settings sheet stays the standard model/diagnostic panel only.

### Follow-ups (TODO)

- [x] MCP: materialize `dsh-mcp-client` Cordis entries from `config.mcpServers`
- [x] Share Web profile (`~/.dsh/settings.yaml`) and cold session import (`~/.dsh/sessions`)
- [ ] Session `streamHistory` / import from `$PASEO_HOME/dsh-sessions` JSONL
- [ ] Bridge `subagent.started` / `subagent.finished` into the Paseo subagents track
- [ ] Tool-call polish (`callId` → name map, bash/edit detail)
- [ ] Stronger interrupt UX (rebuild runtime after kill; clearer diagnostics)
- [ ] Settings / catalog install path for the runtime binary (not only manual `params.runtimeBin`)
- [ ] Optional: auto-load richer Cordis compositions (not only bundled default)

### Explicit non-goals for v1

- Bridging the Desktop Web UI process into the daemon agent list.
- ACP `extends: "acp"` catalog entry (usable as a thin experiment, wrong UX for first-class).
- Windows (persistent PTY / minimal composition is POSIX-only).
- Full Web-UI feature parity (skills market, Cordis HMR, interactive questions) — those stay in the Desktop sidecar.
