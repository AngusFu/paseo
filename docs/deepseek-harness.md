# DeepSeek Harness (Desktop)

Desktop-managed integration for the DeepSeek Harness (`@deepseek-ai/dsh`) Web UI.

## Ownership

- Process lifecycle lives in **Electron main** (`packages/desktop/src/features/deepseek-harness/`), same shape as code-server: install / start / stop / quit cleanup.
- Daemon does not manage DSH. Mobile and plain browser clients do not expose the UI.
- Node runtime for install + `dsh web` is Electron’s own binary via `ELECTRON_RUN_AS_NODE=1`.
- Start argv must include Node’s `--expose-internals` **before** the dsh entry script. Cordis HMR requires it; putting the flag in `NODE_OPTIONS` is rejected under Electron.
- Desktop keeps the user’s normal `$DSH_HOME` (typically `~/.dsh`). It does not isolate a separate harness home.
- Spawn captures stdout/stderr. On readiness failure the status exposes `lastError` with that log tail so Settings can show **Starting… / Running / Stopped / Start failed** instead of only “Installed”.

## Settings

Desktop-only Settings section `deepseek-harness`:

- Install / Upgrade (`npm install @deepseek-ai/dsh@latest --prefix <userData>/toolchains/deepseek-harness`)
  - Button shows a loading state while npm runs
  - Live stdout/stderr streams into an install-log panel via `paseo:deepseek-harness:install-log`
- Start / Stop (status badge reflects starting / running / stopped / failed; `lastError` panel after a failed start)
- **Start with Desktop** (`desktop-settings.deepseekHarness.startWithDesktop`)
- Persisted listen port (`deepseekHarness.port`); first start allocates a free loopback port and keeps it

## Workspace UI

- Header action button next to **VS Code Web** (always shown when the Desktop bridge is available)
- Click starts DSH if needed, then opens the native Web origin in the **system default browser** via `shell.openExternal` (not an Electron tab/webview)

## IPC

`paseo:deepseek-harness:{getStatus,install,start,stop,openWorkspace}` plus `onInstallLog` on `window.paseoDesktop.deepseekHarness`.
`install` returns full runtime status after the npm install completes.
`openWorkspace` ensures the process is running and opens `{ status, url }` in the default browser.
