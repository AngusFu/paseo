# DeepSeek Harness (Desktop)

Desktop-managed integration for the DeepSeek Harness (`@deepseek-ai/dsh`) Web UI.

## Ownership

- Process lifecycle lives in **Electron main** (`packages/desktop/src/features/deepseek-harness/`), same shape as code-server: install / start / stop / quit cleanup.
- Not a daemon/host feature — no `server_info.features` gate. Mobile and plain browser clients do not expose the UI.
- Node runtime for install + `dsh web` is Electron’s own binary via `ELECTRON_RUN_AS_NODE=1`.
- Start argv must include Node’s `--expose-internals` **before** the dsh entry script. Cordis HMR requires it; putting the flag in `NODE_OPTIONS` is rejected under Electron.
- Desktop keeps the user’s normal `$DSH_HOME` (typically `~/.dsh`). It does not isolate a separate harness home.
- Spawn captures stdout/stderr. On readiness failure the status exposes `lastError` with that log tail so Settings can show **Starting… / Running / Stopped / Start failed** instead of only “Installed”.

## Built-in `dsh-paseo` plugin

Monorepo package [`packages/dsh-paseo`](../packages/dsh-paseo) ships with Desktop (`extraResources/dsh-paseo`).

On managed start, Desktop:

1. Syncs packaged/monorepo sources to `$DSH_HOME/packages/dsh-paseo` (never links the profile at the app-bundle `extraResources` path — that tree has no `node_modules`, and Node resolves imports from the package realpath)
2. `dsh plugin --profile web add $DSH_HOME/packages/dsh-paseo` (pnpm under the hood — do **not** use `npm install --prefix` on the web profile; that corrupts the tree and breaks `GET /`)
3. Starts with `dsh --profile web --port <n> --no-open`

`dsh plugin add` puts the package in profile **bundles**, which applies [`packages/dsh-paseo/cordis.patch.yml`](../packages/dsh-paseo/cordis.patch.yml) (`paseo-host`). Do **not** also pass a Desktop `--patch` overlay with the same insert — Cordis rejects duplicate loader ids.

The Cordis **host** entry is dependency-free (no `@deepseek-ai/dsh-home-paths` / `mnemonic-id`) so a missing install-tree `node_modules` cannot break `dsh web` boot. CLI/MCP still declare those deps in `package.json` for standalone use.

`writeDshPaseoOverlayPatch` remains available for future optional overlays (e.g. MCP), but the default start path does not use it.

The embed **client** (`dsh.client`) reads the open URL:

| Query                           | Behavior                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `paseoEmbed=1&sessionId=<id>`   | **Open** that session (preferred — reload stays on the same session)                                |
| `paseoEmbed=1&workspaceId=<id>` | **Create** a new session; rewrite the URL to `sessionId` via `history.replaceState`                 |
| `&permission=<preset>`          | After open, run `/permission <preset>` (`read-only` \| `workspace-write` \| `danger-full-access`)   |
| `&agentPreset=<id>`             | On create path, pass through to `session.create` (`standard` \| `code` \| `minimal` \| `cordis`, …) |
| `&sidebar=collapsed` (default)  | Collapse sidebar via layout toggle (rail remains; user can expand)                                  |
| `&sidebar=hidden`               | Hard-hide sidebar/details columns (legacy)                                                          |
| `&sidebar=open`                 | Leave sidebar open                                                                                  |

Desktop `openWorkspace` calls `session.create` (optional `agentPreset` / `permission`), then loads a `?sessionId=` URL with `sidebar=collapsed`. Each workspace **DeepSeek Harness** action opens a **new** Paseo tab (unique `paneId`) with its own session.

### CLI / MCP (concurrent messaging)

`dsh-paseo` talks to the live DSH Web API. Discovery order: `--host` (after the subcommand) → `DSH_WEB_URL` → Paseo Desktop’s persisted port in `desktop-settings.json` → short parallel loopback probe.

```bash
node packages/dsh-paseo/src/cli/index.js ls
node packages/dsh-paseo/src/cli/index.js ls --host http://127.0.0.1:64167
dsh-paseo run "fix the blank page" --workspace <id> --permission workspace-write -d
dsh-paseo send <sessionId> "follow-up"
dsh-paseo permission <sessionId> danger-full-access
```

MCP tools: `create_agent` (`permission`, `agentPreset`, `initialPrompt`), `send_agent_prompt`, `set_agent_permission`, …

An already-running DSH from before this plugin was installed needs one Stop/Start (or Desktop restart) to load the client.

## Settings

Desktop-only Settings section `deepseek-harness`:

- Install / Upgrade (`npm install @deepseek-ai/dsh@latest --prefix <userData>/toolchains/deepseek-harness`)
  - Button shows a loading state while npm runs
  - Live stdout/stderr streams into an install-log panel via `paseo:deepseek-harness:install-log`
- Start / Stop (status badge reflects starting / running / stopped / failed; `lastError` panel after a failed start)
- **Start with Desktop** (`desktop-settings.deepseekHarness.startWithDesktop`)
- Persisted listen port (`deepseekHarness.port`); first start allocates a free loopback port and keeps it

## Workspace UI

- New tab kind `deepseek_harness` (Electron `<webview>` via `BrowserPane`)
- Header menu + tab `+` menu: **DeepSeek Harness**
- Opening ensures the process is running, registers the cwd via `workspace.create` / `workspace.list`, then loads the embed URL above

## IPC

`paseo:deepseek-harness:{getStatus,install,start,stop,openWorkspace}` plus `onInstallLog` on `window.paseoDesktop.deepseekHarness`.
`install` returns full runtime status after the npm install completes.
